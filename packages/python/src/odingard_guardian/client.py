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


@dataclass(frozen=True)
class ExecuteResult:
    ok: bool
    receipt: Optional[Dict[str, Any]] = None
    reason_code: Optional[str] = None


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
        return {
            "schema": "odingard.guardian.tool.invoke.v1",
            "connectionId": connection_id,
            "toolName": invocation["tool_name"],
            "arguments": dict(arguments),
        }
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
    more), ``merchant_id``, ``merchant_category``, ``recurring``.
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


def _request_result(status: int, data: Any, request_id: Optional[str]) -> RequestResult:
    if not isinstance(data, dict) or data.get("ok") is not True:
        reason = (data.get("reasonCode") or data.get("code")) if isinstance(data, dict) else None
        return RequestResult(
            ok=False,
            reason_code=reason if isinstance(reason, str) else f"HTTP_{status}",
            request_id=request_id,
        )
    decision = data.get("decision")
    token = data.get("capabilityToken")
    if not isinstance(token, str):
        token = data.get("token") if isinstance(data.get("token"), str) else None
    rid = data.get("requestId")
    return RequestResult(
        ok=True,
        request_id=rid if isinstance(rid, str) else (request_id or ""),
        decision=decision if decision in ("ASK", "DENY") else "ALLOW",
        capability_token=token,
        reason_code=data.get("reasonCode") if isinstance(data.get("reasonCode"), str) else None,
    )


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
        return ExecuteResult(ok=False, reason_code=reason if isinstance(reason, str) else f"HTTP_{status}")
    return ExecuteResult(ok=True, receipt=receipt)


def _receipts_result(status: int, data: Any) -> ReceiptsResult:
    if not isinstance(data, dict) or data.get("ok") is not True or not isinstance(data.get("receipts"), list):
        code = data.get("code") if isinstance(data, dict) else None
        return ReceiptsResult(ok=False, reason_code=code if isinstance(code, str) else f"HTTP_{status}")
    return ReceiptsResult(ok=True, request_id=data.get("requestId"), receipts=data["receipts"])


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
            raise ValueError("credential (the agent credential, gac1.…) is required")
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

    def _call(self, path: str, body: Any = None, method: str = "POST") -> tuple:
        try:
            if method == "GET":
                response = self._http.get(f"{self.base_url}{path}")
            else:
                response = self._http.post(f"{self.base_url}{path}", json=body)
        except httpx.HTTPError:
            return _UNAVAILABLE  # fail closed
        return self._parse(response)

    def request(self, invocation: Mapping[str, Any]) -> RequestResult:
        """Request a capability. ALLOW → token; ASK → held for a human; DENY → refused."""
        proposal = self._proposal(invocation)
        status, data = self._call("/v1/agent/requests", proposal)
        return _request_result(status, data, proposal["requestId"])

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

    async def _call(self, path: str, body: Any = None, method: str = "POST") -> tuple:
        try:
            if method == "GET":
                response = await self._http.get(f"{self.base_url}{path}")
            else:
                response = await self._http.post(f"{self.base_url}{path}", json=body)
        except httpx.HTTPError:
            return _UNAVAILABLE  # fail closed
        return self._parse(response)

    async def request(self, invocation: Mapping[str, Any]) -> RequestResult:
        proposal = self._proposal(invocation)
        status, data = await self._call("/v1/agent/requests", proposal)
        return _request_result(status, data, proposal["requestId"])

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


def _quote(value: str) -> str:
    from urllib.parse import quote

    return quote(value, safe="")


AnyGuardianClient = Union[GuardianClient, AsyncGuardianClient]
