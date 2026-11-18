"""Guardian agent client: request, claim, execute and receipts.

A port of ``createGuardianClient`` (``packages/sdk/src/client.ts``). The
client builds the same canonical action proposal the TypeScript SDK sends,
so the gateway, kernel and capability path govern Python agents exactly
like TypeScript ones. An unreachable Guardian is always a refusal
(``SERVICE_UNAVAILABLE``), never an allow.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass, field
from typing import Any, Dict, Literal, Mapping, Optional, Union

import httpx

__all__ = [
    "DEFAULT_BASE_URL",
    "RequestResult",
    "ExecuteResult",
    "ReceiptsResult",
    "PortableReceiptResult",
    "HeldRequest",
    "PendingResult",
    "WithdrawResult",
    "GuardianClient",
    "AsyncGuardianClient",
    "build_proposal",
]

DEFAULT_BASE_URL = "https://guardian-api.odingard.com"

Decision = Literal["ALLOW", "ASK", "DENY"]

_RESOURCE_TYPE = {
    "tool.invoke": "tool:server",
    "mcp.install": "mcp:server",
    "mcp.enable": "mcp:server",
    "api.request": "api:endpoint",
    "protected_data.derive": "protected:data",
    "protected_data.transform": "protected:data",
    "protected_data.export": "protected:data",
    "agent.message": "guardian-agent",
    "agent.share_context": "guardian-agent",
    "agent.share_memory": "guardian-agent",
    "agent.transfer_task": "guardian-agent",
    "agent.transfer_capability": "guardian-agent",
}

_DEFAULT_ADAPTER = {
    "api.request": "adp_00000002",
    "tool.invoke": "adp_00000006",
    "mcp.install": "adp_00000006",
    "mcp.enable": "adp_00000006",
    "protected_data.derive": "adp_00000005",
    "protected_data.transform": "adp_00000005",
    "protected_data.export": "adp_00000005",
    "agent.message": "adp_00000007",
    "agent.share_context": "adp_00000007",
    "agent.share_memory": "adp_00000007",
    "agent.transfer_task": "adp_00000007",
    "agent.transfer_capability": "adp_00000007",
}


@dataclass(frozen=True)
class RequestResult:
    """Outcome of ``request`` or ``claim``.

    ``ok=True`` carries a ``decision``; ALLOW carries a ``capability_token``.
    ``ok=False`` carries a ``reason_code``. A held ASK is reported by the
    gateway as ``ok=False, reason_code="APPROVAL_REQUIRED"`` with its
    ``request_id``; :func:`classify_request_result` reads both forms.
    """

    ok: bool
    request_id: Optional[str] = None
    decision: Optional[Decision] = None
    capability_token: Optional[str] = None
    reason_code: Optional[str] = None
    #: Watch mode, for a request sent with ``watch_aware=True``: the agent
    #: is in watch mode and Guardian would have asked (``"ASK"``) or denied
    #: (``"DENY"``) the call under the current rules. It comes with
    #: ``decision="DENY"`` and ``reason_code="WATCHED"``: Guardian issued no
    #: capability and performs nothing for the call. The guard runs an
    #: in-process tool anyway when ``Guard(watch_mode=True)``, because watch
    #: mode lets the agent's own tools run while Guardian watches. Set only
    #: on an answer to a request sent with ``watch_aware=True``.
    watched: Optional[Literal["ASK", "DENY"]] = None


@dataclass(frozen=True)
class ExecuteResult:
    """Outcome of ``execute``.

    ``outcome_unknown=True`` on a failure means the execute was sent but no
    usable answer came back (no answer, a 5xx, an unreadable answer or an
    ``ok`` answer whose receipt cannot be read): Guardian may have redeemed
    the capability. Look the request up (``receipts``) before treating it as
    a failure, and never retry it as a new request.
    """

    ok: bool
    receipt: Optional[Dict[str, Any]] = None
    reason_code: Optional[str] = None
    outcome_unknown: bool = False


@dataclass(frozen=True)
class ReceiptsResult:
    ok: bool
    request_id: Optional[str] = None
    receipts: list = field(default_factory=list)
    reason_code: Optional[str] = None


@dataclass(frozen=True)
class PortableReceiptResult:
    ok: bool
    receipt: Optional[Dict[str, Any]] = None
    reason_code: Optional[str] = None


@dataclass(frozen=True)
class HeldRequest:
    """One of the agent's own requests waiting for a person (ASK)."""

    request_id: str
    action: str
    #: The tool named in the request (tool.invoke, mcp.enable); else None.
    tool_name: Optional[str]
    #: The purpose the agent gave with the request.
    purpose: str
    created_at_epoch_ms: int
    expires_at_epoch_ms: int


@dataclass(frozen=True)
class PendingResult:
    """Outcome of ``pending``: the agent's held requests, newest to oldest.

    ``next`` is passed as ``before`` for the next page; None on the last
    page. An answer with an entry this client cannot read is ``ok=False``
    with ``reason_code="MALFORMED_RESPONSE"``.
    """

    ok: bool
    requests: list = field(default_factory=list)
    next: Optional[str] = None
    reason_code: Optional[str] = None


@dataclass(frozen=True)
class WithdrawResult:
    """Outcome of ``withdraw``.

    ``ok=True`` means the request is withdrawn (``state="withdrawn"``); a
    repeat answers the same. Otherwise ``reason_code`` says why it was not
    withdrawn: ``NOT_FOUND`` (no held request of this agent with that id),
    ``ALREADY_DECIDED`` (with ``state``: approved, denied, expired …), and
    nothing changed. ``outcome_unknown=True`` means no clear answer came back
    (no answer, a 5xx or an unreadable answer; ``reason_code`` is then, for
    example, ``SERVICE_UNAVAILABLE``): the request may or may not have been
    withdrawn, and withdrawing it again with the same request id is safe.
    """

    ok: bool
    request_id: Optional[str] = None
    state: Optional[str] = None
    withdrawn_at_epoch_ms: Optional[int] = None
    reason_code: Optional[str] = None
    outcome_unknown: bool = False


def _random_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(16)}"


def _material_parameters(invocation: Mapping[str, Any]) -> Dict[str, Any]:
    action = invocation["action"]
    if "material_parameters" in invocation:
        return dict(invocation["material_parameters"])
    connection_id = invocation["connection_id"]
    if action == "tool.invoke":
        arguments = invocation.get("arguments") or {}
        if not isinstance(arguments, Mapping):
            raise TypeError("tool.invoke arguments must be a mapping")
        params: Dict[str, Any] = {
            "schema": "odingard.guardian.tool.invoke.v1",
            "connectionId": connection_id,
            "toolName": invocation["tool_name"],
            "arguments": dict(arguments),
        }
        # The owner's amount declaration for this tool, echoed exactly as set
        # in the Guardian console (``Guard(amount_args=...)``).
        if invocation.get("amount_argument") is not None:
            params["amountArgument"] = dict(invocation["amount_argument"])
        return params
    if action == "mcp.install":
        return {
            "schema": "odingard.guardian.mcp.install.v1",
            "connectionId": connection_id,
            "tool": dict(invocation["tool"]),
        }
    if action == "mcp.enable":
        return {
            "schema": "odingard.guardian.mcp.enable.v1",
            "connectionId": connection_id,
            "toolName": invocation["tool_name"],
        }
    raise ValueError(f"{action} needs material_parameters")


def build_proposal(invocation: Mapping[str, Any]) -> Dict[str, Any]:
    """Build the canonical agent action proposal for an invocation.

    ``invocation`` keys: ``action``, ``connection_id``, and per action
    ``tool_name`` + ``arguments`` (tool.invoke), ``tool`` (mcp.install),
    ``tool_name`` (mcp.enable) or ``material_parameters`` (governed actions);
    optional ``adapter_id``, ``purpose``, ``intent_id``, ``plan_id``,
    ``parent_action_id``, ``source_effect_id``, and for money-moving actions
    ``value_cents`` (minor units; the executor refuses a request that moves
    more), ``merchant_id``, ``merchant_category``, ``recurring``; for
    tool.invoke on a tool with a dollar amount, ``amount_argument`` (the
    owner's declaration, sent as ``amountArgument``).
    """
    action = invocation["action"]
    if action not in _RESOURCE_TYPE:
        raise ValueError(f"unsupported action: {action}")
    connection_id = invocation.get("connection_id")
    if not isinstance(connection_id, str) or not connection_id:
        raise ValueError("connection_id is required")
    proposal: Dict[str, Any] = {
        "schemaVersion": 1,
        "requestId": _random_id("req"),
        "correlationId": _random_id("cor"),
        "action": action,
        "resource": f"{_RESOURCE_TYPE[action]}:{connection_id}",
        "uses": 1,
        "materialParameters": _material_parameters(invocation),
        "purpose": invocation.get("purpose") or f"Guardian {action}",
        "initiatingContext": "agent",
        "requestedAdapterId": invocation.get("adapter_id")
        or _DEFAULT_ADAPTER.get(action, "adp_00000006"),
        "requestedTtlMs": 120_000,
    }
    for source, target in (
        ("intent_id", "intentId"),
        ("plan_id", "planId"),
        ("parent_action_id", "parentActionId"),
        ("source_effect_id", "sourceEffectId"),
    ):
        if invocation.get(source) is not None:
            proposal[target] = invocation[source]
    value = invocation.get("value_cents")
    if value is not None:
        if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > 9007199254740991:
            raise ValueError("value_cents must be a non-negative whole number of minor units")
        proposal["valueCents"] = value
    for source, target in (("merchant_id", "merchantId"), ("merchant_category", "merchantCategory")):
        text = invocation.get(source)
        if text is not None:
            if not isinstance(text, str) or not text.strip() or len(text.strip()) > 256:
                raise ValueError(f"{source} must be a non-empty string of at most 256 characters")
            proposal[target] = text.strip()
    recurring = invocation.get("recurring")
    if recurring is not None:
        if not isinstance(recurring, bool):
            raise ValueError("recurring must be a boolean")
        proposal["recurring"] = recurring
    return proposal


def _request_result(
    status: int, data: Any, request_id: Optional[str], asked_for_watch: bool = False
) -> RequestResult:
    if status >= 500:
        # A server error is Guardian failing to answer, not a decision: the
        # call is still refused (fail closed) but reported as an outage.
        return RequestResult(ok=False, reason_code="SERVICE_UNAVAILABLE", request_id=request_id)
    if not isinstance(data, dict) or data.get("ok") is not True:
        reason = (data.get("reasonCode") or data.get("code")) if isinstance(data, dict) else None
        return RequestResult(
            ok=False,
            reason_code=reason if isinstance(reason, str) else f"HTTP_{status}",
            request_id=request_id,
        )
    decision = data.get("decision")
    if decision is not None and decision not in ("ALLOW", "ASK", "DENY"):
        # Only ALLOW (or the hosted gateway's ALLOW body, which carries a
        # token and no decision) can run anything. Any other decision value
        # is refused.
        return RequestResult(ok=False, reason_code="MALFORMED_RESPONSE", request_id=request_id)
    token = data.get("capabilityToken")
    if not isinstance(token, str):
        token = data.get("token") if isinstance(data.get("token"), str) else None
    rid = data.get("requestId")
    reason = data.get("reasonCode") if isinstance(data.get("reasonCode"), str) else None
    return RequestResult(
        ok=True,
        request_id=rid if isinstance(rid, str) else (request_id or ""),
        decision="ALLOW" if decision is None else decision,
        capability_token=token,
        reason_code=reason,
        # A watched answer counts only when this call asked for it.
        watched=_watched(data) if asked_for_watch and decision == "DENY" and reason == "WATCHED" else None,
    )


def _watched(data: Mapping[str, Any]) -> Optional[Literal["ASK", "DENY"]]:
    """Watch mode: only an exact ``"ASK"`` or ``"DENY"`` is kept."""
    watch = data.get("watch")
    if not isinstance(watch, dict):
        return None
    would = watch.get("wouldDecision")
    if would == "ASK":
        return "ASK"
    if would == "DENY":
        return "DENY"
    return None


def _execute_result(status: int, data: Any) -> ExecuteResult:
    receipt = data.get("receipt") if isinstance(data, dict) else None
    if (
        not isinstance(data, dict)
        or data.get("ok") is not True
        or not isinstance(receipt, dict)
        or receipt.get("schemaVersion") != 1
        or not isinstance(receipt.get("requestId"), str)
    ):
        reason = (data.get("reasonCode") or data.get("code")) if isinstance(data, dict) else None
        if not isinstance(reason, str):
            reason = f"HTTP_{status}"
        # Only a readable refusal (a 4xx, or a 2xx ``ok: false``) is
        # definitive; otherwise Guardian may have redeemed the capability.
        definitive = 200 <= status < 500 and isinstance(data, dict) and data.get("ok") is False
        return ExecuteResult(ok=False, reason_code=reason, outcome_unknown=not definitive)
    return ExecuteResult(ok=True, receipt=receipt)


def _receipts_result(status: int, data: Any) -> ReceiptsResult:
    if not isinstance(data, dict) or data.get("ok") is not True or not isinstance(data.get("receipts"), list):
        code = data.get("code") if isinstance(data, dict) else None
        return ReceiptsResult(ok=False, reason_code=code if isinstance(code, str) else f"HTTP_{status}")
    return ReceiptsResult(ok=True, request_id=data.get("requestId"), receipts=data["receipts"])


def _refusal_code(status: int, data: Any) -> str:
    if isinstance(data, dict):
        for key in ("reasonCode", "code"):
            if isinstance(data.get(key), str):
                return data[key]
    return f"HTTP_{status}"


def _is_epoch(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value < 2**53


def _held_request(entry: Any) -> Optional[HeldRequest]:
    if not isinstance(entry, dict):
        return None
    tool_name = entry.get("toolName")
    if (
        not isinstance(entry.get("requestId"), str)
        or not isinstance(entry.get("action"), str)
        or not (tool_name is None or isinstance(tool_name, str))
        or not isinstance(entry.get("purpose"), str)
        or not _is_epoch(entry.get("createdAtEpochMs"))
        or not _is_epoch(entry.get("expiresAtEpochMs"))
    ):
        return None
    return HeldRequest(
        request_id=entry["requestId"],
        action=entry["action"],
        tool_name=tool_name,
        purpose=entry["purpose"],
        created_at_epoch_ms=entry["createdAtEpochMs"],
        expires_at_epoch_ms=entry["expiresAtEpochMs"],
    )


def _pending_path(limit: Optional[int], before: Optional[str]) -> str:
    from urllib.parse import urlencode

    query: Dict[str, str] = {"status": "pending"}
    if limit is not None:
        query["limit"] = str(limit)
    if before is not None:
        query["before"] = before
    return f"/v1/agent/requests?{urlencode(query)}"


def _pending_result(status: int, data: Any) -> PendingResult:
    if not isinstance(data, dict) or data.get("ok") is not True or not isinstance(data.get("requests"), list):
        return PendingResult(ok=False, reason_code=_refusal_code(status, data))
    requests = []
    for entry in data["requests"]:
        held = _held_request(entry)
        if held is None:
            # An entry this client cannot read fails the whole answer closed.
            return PendingResult(ok=False, reason_code="MALFORMED_RESPONSE")
        requests.append(held)
    next_page = data.get("next")
    return PendingResult(ok=True, requests=requests, next=next_page if isinstance(next_page, str) else None)


def _withdraw_result(status: int, data: Any) -> WithdrawResult:
    if (
        isinstance(data, dict)
        and data.get("ok") is True
        and data.get("state") == "withdrawn"
        and isinstance(data.get("requestId"), str)
        and _is_epoch(data.get("withdrawnAtEpochMs"))
    ):
        return WithdrawResult(
            ok=True,
            request_id=data["requestId"],
            state="withdrawn",
            withdrawn_at_epoch_ms=data["withdrawnAtEpochMs"],
        )
    # Anything else is not a confirmed withdrawal, whatever ``ok`` says.
    ok_answer = isinstance(data, dict) and data.get("ok") is True
    request_id = data.get("requestId") if isinstance(data, dict) else None
    state = data.get("state") if isinstance(data, dict) else None
    # A readable refusal (a 2xx to 4xx ``ok: false``) means nothing changed;
    # otherwise Guardian may have withdrawn the request.
    definitive = 200 <= status < 500 and isinstance(data, dict) and data.get("ok") is False
    return WithdrawResult(
        ok=False,
        reason_code="MALFORMED_RESPONSE" if ok_answer else _refusal_code(status, data),
        request_id=request_id if isinstance(request_id, str) else None,
        state=state if isinstance(state, str) else None,
        outcome_unknown=not definitive,
    )


def _portable_result(status: int, data: Any) -> PortableReceiptResult:
    if not isinstance(data, dict) or data.get("ok") is not True or not isinstance(data.get("receipt"), dict):
        reason = None
        if isinstance(data, dict):
            reason = data.get("reasonCode") or data.get("code")
        return PortableReceiptResult(
            ok=False, reason_code=reason if isinstance(reason, str) else f"HTTP_{status}"
        )
    return PortableReceiptResult(ok=True, receipt=data["receipt"])


_UNAVAILABLE = (0, {"ok": False, "reasonCode": "SERVICE_UNAVAILABLE"})
_WATCH_AWARE_HEADER = "x-guardian-watch-aware"


class _Base:
    def __init__(
        self,
        *,
        credential: str,
        base_url: str = DEFAULT_BASE_URL,
        adapter_id: Optional[str] = None,
        timeout: float = 30.0,
    ) -> None:
        if not credential:
            raise ValueError("credential (the agent credential, gak_…) is required")
        self.base_url = base_url.rstrip("/")
        self.adapter_id = adapter_id
        self._headers = {"authorization": f"Bearer {credential}"}
        self._timeout = timeout

    def _proposal(self, invocation: Mapping[str, Any]) -> Dict[str, Any]:
        merged = dict(invocation)
        if self.adapter_id and not merged.get("adapter_id") and merged["action"] in (
            "tool.invoke",
            "mcp.install",
            "mcp.enable",
        ):
            merged["adapter_id"] = self.adapter_id
        return build_proposal(merged)

    @staticmethod
    def _watch_headers(invocation: Mapping[str, Any]) -> Dict[str, str]:
        """Watch mode: ``watch_aware=True`` says this caller handles the
        watched answer. ``Guard(watch_mode=True)`` sets it for in-process
        tools; a claim never asks for it."""
        return {_WATCH_AWARE_HEADER: "1"} if invocation.get("watch_aware") is True else {}

    @staticmethod
    def _parse(response: httpx.Response) -> tuple:
        try:
            return response.status_code, response.json()
        except ValueError:
            return response.status_code, None

    def __repr__(self) -> str:  # never print the credential
        return f"{type(self).__name__}(base_url={self.base_url!r})"


class GuardianClient(_Base):
    """Synchronous Guardian agent client.

    >>> client = GuardianClient(credential=os.environ["GUARDIAN_AGENT_CREDENTIAL"])
    >>> result = client.request({"action": "tool.invoke", "connection_id": "con_…",
    ...                          "tool_name": "refund_order", "arguments": {"orderId": "ord_1"}})
    """

    def __init__(
        self,
        *,
        credential: str,
        base_url: str = DEFAULT_BASE_URL,
        adapter_id: Optional[str] = None,
        timeout: float = 30.0,
        transport: Optional[httpx.BaseTransport] = None,
    ) -> None:
        super().__init__(credential=credential, base_url=base_url, adapter_id=adapter_id, timeout=timeout)
        self._http = httpx.Client(transport=transport, timeout=timeout, headers=self._headers)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "GuardianClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _call(
        self, path: str, body: Any = None, method: str = "POST", headers: Optional[Mapping[str, str]] = None
    ) -> tuple:
        try:
            if method == "GET":
                response = self._http.get(f"{self.base_url}{path}")
            else:
                response = self._http.post(f"{self.base_url}{path}", json=body, headers=dict(headers or {}))
        except httpx.HTTPError:
            return _UNAVAILABLE  # fail closed
        return self._parse(response)

    def request(self, invocation: Mapping[str, Any]) -> RequestResult:
        """Request a capability. ALLOW → token; ASK → held for a human; DENY → refused."""
        proposal = self._proposal(invocation)
        headers = self._watch_headers(invocation)
        status, data = self._call("/v1/agent/requests", proposal, headers=headers)
        return _request_result(status, data, proposal["requestId"], asked_for_watch=bool(headers))

    def claim(self, request_id: str) -> RequestResult:
        """Collect the capability after a human approved a prior ASK."""
        status, data = self._call("/v1/agent/claims", {"schemaVersion": 1, "requestId": request_id})
        return _request_result(status, data, request_id)

    def execute(self, *, request_id: str, capability_token: str) -> ExecuteResult:
        """Redeem a capability; resolves to the execution receipt."""
        status, data = self._call(
            "/v1/agent/execute",
            {"schemaVersion": 1, "requestId": request_id, "capabilityToken": capability_token},
        )
        return _execute_result(status, data)

    def receipts(self, request_id: str) -> ReceiptsResult:
        status, data = self._call(f"/v1/agent/receipts/{_quote(request_id)}", method="GET")
        return _receipts_result(status, data)

    def portable_receipt(self, request_id: str) -> PortableReceiptResult:
        """The signed ``greceipt.v1`` for a completed request (verify it offline)."""
        status, data = self._call(f"/v1/agent/receipts/{_quote(request_id)}/portable", method="GET")
        return _portable_result(status, data)

    def pending(self, *, limit: Optional[int] = None, before: Optional[str] = None) -> PendingResult:
        """This agent's own requests waiting for a person (ASK), newest to oldest.

        It reads and changes nothing, and never returns another agent's
        requests. ``limit`` is 1 to 100 (default 20); pass the previous
        page's ``next`` as ``before``.
        """
        status, data = self._call(_pending_path(limit, before), method="GET")
        return _pending_result(status, data)

    def withdraw(self, request_id: str) -> WithdrawResult:
        """Withdraw one of this agent's own held requests.

        The person no longer sees it and it can never be claimed. It takes
        authority away and runs nothing; a repeat answers "withdrawn" again.
        """
        status, data = self._call(f"/v1/agent/requests/{_quote(request_id)}/withdraw", {})
        return _withdraw_result(status, data)


class AsyncGuardianClient(_Base):
    """``asyncio`` Guardian agent client — same surface as :class:`GuardianClient`."""

    def __init__(
        self,
        *,
        credential: str,
        base_url: str = DEFAULT_BASE_URL,
        adapter_id: Optional[str] = None,
        timeout: float = 30.0,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        super().__init__(credential=credential, base_url=base_url, adapter_id=adapter_id, timeout=timeout)
        self._http = httpx.AsyncClient(transport=transport, timeout=timeout, headers=self._headers)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> "AsyncGuardianClient":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def _call(
        self, path: str, body: Any = None, method: str = "POST", headers: Optional[Mapping[str, str]] = None
    ) -> tuple:
        try:
            if method == "GET":
                response = await self._http.get(f"{self.base_url}{path}")
            else:
                response = await self._http.post(f"{self.base_url}{path}", json=body, headers=dict(headers or {}))
        except httpx.HTTPError:
            return _UNAVAILABLE  # fail closed
        return self._parse(response)

    async def request(self, invocation: Mapping[str, Any]) -> RequestResult:
        proposal = self._proposal(invocation)
        headers = self._watch_headers(invocation)
        status, data = await self._call("/v1/agent/requests", proposal, headers=headers)
        return _request_result(status, data, proposal["requestId"], asked_for_watch=bool(headers))

    async def claim(self, request_id: str) -> RequestResult:
        status, data = await self._call("/v1/agent/claims", {"schemaVersion": 1, "requestId": request_id})
        return _request_result(status, data, request_id)

    async def execute(self, *, request_id: str, capability_token: str) -> ExecuteResult:
        status, data = await self._call(
            "/v1/agent/execute",
            {"schemaVersion": 1, "requestId": request_id, "capabilityToken": capability_token},
        )
        return _execute_result(status, data)

    async def receipts(self, request_id: str) -> ReceiptsResult:
        status, data = await self._call(f"/v1/agent/receipts/{_quote(request_id)}", method="GET")
        return _receipts_result(status, data)

    async def portable_receipt(self, request_id: str) -> PortableReceiptResult:
        status, data = await self._call(
            f"/v1/agent/receipts/{_quote(request_id)}/portable", method="GET"
        )
        return _portable_result(status, data)

    async def pending(self, *, limit: Optional[int] = None, before: Optional[str] = None) -> PendingResult:
        status, data = await self._call(_pending_path(limit, before), method="GET")
        return _pending_result(status, data)

    async def withdraw(self, request_id: str) -> WithdrawResult:
        status, data = await self._call(f"/v1/agent/requests/{_quote(request_id)}/withdraw", {})
        return _withdraw_result(status, data)


def _quote(value: str) -> str:
    from urllib.parse import quote

    return quote(value, safe="")


AnyGuardianClient = Union[GuardianClient, AsyncGuardianClient]
