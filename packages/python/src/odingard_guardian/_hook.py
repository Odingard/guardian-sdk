"""Shared core of the coding-agent hooks (Hermes Agent, Claude Agent SDK).

A coding agent runs its tools itself, after a hook answers. So these hooks
do not go through :class:`~odingard_guardian.Guard`: they call ``request`` /
``claim`` / ``execute`` themselves, redeem the capability *before* the call
runs and wait for the person within the request's window (CONTRIBUTING,
"Coding-agent hooks"). After a lost redemption answer the request is looked
up with the guard's own rules (``_outcome_unknown`` and ``_lookup_answer``
in ``guard.py``).

This module holds what the hooks share: the shell-command tiers, the bounded
form a call is proposed in, the in-memory store of held requests and
:func:`decide`, the Python port of ``packages/hook/src/decide.ts``. Each
hook keeps its own table of the agent's tools.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, Mapping, MutableMapping, Optional, Tuple

from .client import ExecuteResult, RequestResult
from .content_pins import CONTENT_CHANGED_SINCE_APPROVAL, CONTENT_PIN_UNREADABLE, ContentPinError, verify_pin
from .guard import EXECUTION_OUTCOME_UNKNOWN, _lookup_answer, _outcome_unknown

MAX_TEXT = 2_000

# Same patterns as packages/hook/src/classify.ts. They err toward the Ask
# tools: a false match costs one approval; a miss runs under "shell".
_DEPLOY = [
    re.compile(p, f)
    for p, f in [
        (r"\b(terraform|tofu)\b.*\s(apply|destroy|import|state\s+(rm|mv|push))\b", 0),
        (r"\bpulumi\s+(up|destroy|update)\b", 0),
        (r"\bkubectl\b.*\s(apply|delete|create|replace|patch|scale|rollout|drain|cordon)\b", 0),
        (r"\bhelm\s+(install|upgrade|uninstall|rollback|delete)\b", 0),
        (r"\b(cdk|serverless|sls|sam)\s+(deploy|destroy|remove)\b", 0),
        (r"\bfly(ctl)?\s+(deploy|destroy|apps\s+destroy|scale)\b", 0),
        (r"\bvercel\b.*(--prod\b|\bdeploy\b|\bpromote\b|\bremove\b)", 0),
        (r"\bnetlify\s+deploy\b.*--prod\b", 0),
        (r"\bgcloud\s+.*\b(deploy|delete)\b", 0),
        (r"\baws\s+.*\b(deploy|delete-stack|create-stack|update-stack|terminate-instances|delete-db-instance)\b", 0),
        (r"\baz\s+.*\b(deploy|delete|create)\b", 0),
        (r"\bwrangler\s+(deploy|publish|delete)\b", 0),
        (r"\bdocker\s+(push|compose\s+.*\bup\b.*--remote)\b", 0),
        (r"\b(npm|pnpm|yarn)\s+publish\b", 0),
        (r"\btwine\s+upload\b", 0),
        (r"\bgh\s+(release\s+create|workflow\s+run|pr\s+merge)\b", 0),
    ]
]
_DESTRUCTIVE = [
    re.compile(p, f)
    for p, f in [
        (r"\brm\s+(?:-\S*[rR]\S*\s+(?:-\S+\s+)*|-\S*f\S*\s+-\S*[rR])", 0),
        (r"\bgit\s+reset\s+.*--hard\b", 0),
        (r"\bgit\s+clean\s+-\S*f", 0),
        (r"\bgit\s+push\b.*(\s--force\b|\s-f\b|--force-with-lease|\s\+\S)", 0),
        (r"\bgit\s+(branch\s+-D|checkout\s+--\s|restore\s+--source)\b", 0),
        (r"\b(drop|truncate)\s+(table|database|schema)\b", re.IGNORECASE),
        (r"\bdelete\s+from\s+\w+\s*(;|$)", re.IGNORECASE),
        (r"\b(mkfs|dd\s+if=|shred|wipefs)\b", 0),
        (r"\bchmod\s+-R\s+777\b", 0),
        (r"\bfind\b.*\s-delete\b", 0),
    ]
]
_GIT_PUSH = re.compile(r"\bgit\s+push\b")


def classify_command(command: str) -> str:
    """``shell`` / ``shell_deploy`` / ``shell_destructive`` / ``git_push`` for one command line."""
    if any(p.search(command) for p in _DESTRUCTIVE):
        return "shell_destructive"
    if any(p.search(command) for p in _DEPLOY):
        return "shell_deploy"
    if _GIT_PUSH.search(command):
        return "git_push"
    return "shell"


def _part(text: str) -> str:
    out = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    out = re.sub(r"^(\d)", r"x\1", out)
    return out or "x"


def _mcp_name(*parts: str) -> str:
    """Guardian tool names: ``^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$``, at most 64 chars."""
    return re.sub(r"[._-]+$", "", ("mcp." + ".".join(_part(p) for p in parts))[:64])


@dataclass(frozen=True)
class GovernedCall:
    tool_name: str
    #: What the approver sees. Bounded; file contents and code beyond the limit are digested.
    arguments: Dict[str, Any]
    summary: str
    #: Edit-type tools only: ``(path, pin)``, the target's contents as pinned
    #: into ``arguments["guardianContentPins"]`` (:func:`.content_pins.pin_file`).
    #: :func:`decide` checks the file against it again just before the
    #: capability is redeemed.
    content_pin: Optional[Tuple[str, Mapping[str, Any]]] = None


def _str(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _digest(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()


def _json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def _bounded(text: str, limit: int = MAX_TEXT) -> str:
    return text if len(text) <= limit else f"{text[:limit]}… [{len(text) - limit} more chars]"


def _text_fields(key: str, text: str) -> Dict[str, Any]:
    """The text itself when it fits; else its start plus a digest of all of it, so two
    different long inputs can never look like the same proposal."""
    if len(text) <= MAX_TEXT:
        return {key: text}
    return {key: _bounded(text), f"{key}Bytes": len(text.encode("utf-8", "surrogatepass")), f"{key}Digest": _digest(text)}


def _input_fields(value: Any) -> Dict[str, Any]:
    text = _json(value)
    if len(text) <= MAX_TEXT:
        return {"input": value}
    return {"inputBytes": len(text.encode("utf-8", "surrogatepass")), "inputDigest": _digest(text)}


_CREDENTIAL = "GUARDIAN_AGENT_CREDENTIAL"


class CredentialHolder:
    """The agent credential, moved out of the environment it was read from.

    A coding agent passes its environment to the commands it runs. Each
    :meth:`take` moves ``GUARDIAN_AGENT_CREDENTIAL`` out of a mutable
    ``source`` (``os.environ``) and keeps it here, so a process started
    afterwards cannot read it (``echo $GUARDIAN_AGENT_CREDENTIAL``). A
    read-only mapping is only read.
    """

    def __init__(self, source: Mapping[str, str]) -> None:
        self._source = source
        self._lock = threading.Lock()
        self._value = ""

    def take(self) -> str:
        source = self._source
        with self._lock:
            if isinstance(source, MutableMapping) and _CREDENTIAL in source:
                value = (source.pop(_CREDENTIAL, None) or "").strip()
                if value:
                    self._value = value
            elif not isinstance(source, MutableMapping):
                value = (source.get(_CREDENTIAL) or "").strip()
                if value:
                    self._value = value
            return self._value


# --- the decision -------------------------------------------------------------


@dataclass(frozen=True)
class HookVerdict:
    allow: bool
    #: Shown to the model (it becomes the tool result on a block). Plain words.
    reason: str
    request_id: Optional[str] = None
    guardian_decision: Optional[str] = None
    approved_by_human: bool = False
    #: Watch mode (only with ``watch_aware``): ``"ASK"`` or ``"DENY"``, what
    #: Guardian would have decided. ``allow`` is False: Guardian approved
    #: nothing and performs nothing, and the caller leaves the call to the
    #: agent's own permissions.
    would_decision: Optional[str] = None


_PLAIN = {
    "NOT_AUTHORIZED": "this agent is not authorized for it",
    "APPROVAL_DENIED": "the approver declined it",
    "APPROVAL_NOT_SATISFIED": "the approver declined it",
    "APPROVAL_EXPIRED": "the approval expired",
    "UNAUTHENTICATED": "the Guardian agent credential was rejected",
    "INVALID_REQUEST": "this tool is not allowed for the agent yet. In the Guardian console: Agents → this agent → "
    "the connection's card → \"Allow a tool by name\"",
    "SERVICE_UNAVAILABLE": "Guardian could not be reached",
    "REQUEST_CONFLICT": "Guardian saw a conflicting request",
    "EXECUTION_NOT_SENT": "Guardian did not complete the redemption",
}

_HELD = ("APPROVAL_REQUIRED", "APPROVAL_PENDING")


def _denied(call: GovernedCall, code: str, **extra: Any) -> HookVerdict:
    return HookVerdict(
        allow=False,
        reason=f"Guardian blocked {call.tool_name} ({code}): {_PLAIN.get(code, code)}. Nothing ran. "
        "Do not retry or work around this; ask the developer to review it in the Guardian console.",
        **extra,
    )


def _pending(r: RequestResult) -> bool:
    return (not r.ok and r.reason_code in _HELD) or (r.ok and r.decision == "ASK")


def _watched(r: RequestResult) -> Optional[str]:
    """The watched answer (``"ASK"`` or ``"DENY"``), and only an exact one."""
    if not r.ok or r.decision != "DENY" or r.reason_code != "WATCHED":
        return None
    return r.watched if r.watched in ("ASK", "DENY") else None


def _pin_refusal(call: GovernedCall) -> Optional[str]:
    """Edit-type tools: the target must still match its pin. The refusal code, or ``None``."""
    if call.content_pin is None:
        return None
    path, pin = call.content_pin
    try:
        verify_pin(path, pin)
    except ContentPinError as err:
        return err.reason_code
    except Exception:  # noqa: BLE001 - a check that cannot be made refuses
        return CONTENT_PIN_UNREADABLE
    return None


#: How long before the window closes the final approval check runs.
FINAL_CHECK_LEAD_S = 1.5


class PendingStore:
    """Requests still waiting for a person, keyed by the exact proposal, in this
    process's memory only.

    A retry of the same call in the same agent process claims the open request
    instead of filing a new one. It is deliberately never written to disk: any
    file the agent can read, its tools can rewrite, and a rewritten entry could
    point an approval of one call at a different call. One process per message
    (``hermes chat -q``, as some hosts run it) therefore starts with an empty
    store.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._mem: Dict[str, Dict[str, Any]] = {}

    def get(self, key: str, now: float) -> Optional[Dict[str, Any]]:
        with self._lock:
            self._mem = {k: v for k, v in self._mem.items() if v["expires_at"] > now}
            entry = self._mem.get(key)
            return dict(entry) if entry is not None else None

    def put(self, key: str, request_id: str, expires_at: float) -> None:
        with self._lock:
            self._mem[key] = {"request_id": request_id, "expires_at": float(expires_at)}

    def delete(self, key: str) -> None:
        with self._lock:
            self._mem.pop(key, None)


def _proposal_key(connection_id: str, call: GovernedCall, scope: Optional[str] = None) -> str:
    """The key a held request is remembered under: the exact proposal, and the session it was held for."""
    parts: list = [connection_id, call.tool_name, call.arguments]
    if scope is not None:
        parts.append({"scope": scope})
    return hashlib.sha256(_json(parts).encode("utf-8", "surrogatepass")).hexdigest()


def session_scope(value: Any) -> Optional[str]:
    """The session a hook call belongs to, as the agent names it: a non-empty
    string, else ``None`` (not known). It must come from the agent's runtime,
    never from the tool call's arguments, which the model writes."""
    return value if isinstance(value, str) and value else None


def _look_up(client: Any, request_id: str) -> str:
    """After a lost redemption answer: ``verified``, ``not-sent`` or ``unknown``.

    Guardian's recorded attempts for the request (``client.receipts``), read
    with the same rules as the SDK's guard (:func:`.guard._lookup_answer`).
    No lookup available, or a lookup that fails, settles nothing.
    """
    receipts = getattr(client, "receipts", None)
    if not callable(receipts):
        return "unknown"
    try:
        return _lookup_answer(request_id, receipts(request_id))[0]
    except Exception:  # noqa: BLE001 — a failed lookup settles nothing
        return "unknown"


#: The Python SDK asks Guardian for a 120 s request window (``requestedTtlMs``).
REQUEST_TTL_S = 120.0


def decide(
    call: GovernedCall,
    *,
    client: Any,
    connection_id: str,
    agent_name: str,
    approval_timeout_s: float,
    request_ttl_s: float = REQUEST_TTL_S,
    poll_interval_s: float = 2.0,
    max_poll_interval_s: float = 10.0,
    deadline: Optional[float] = None,
    call_timeout_s: float = 8.0,
    store: Optional[PendingStore] = None,
    wait: Callable[[float], None] = time.sleep,
    now: Callable[[], float] = time.monotonic,
    wall: Callable[[], float] = time.time,
    log: Callable[[str], None] = lambda _line: None,
    host: str = "Hermes",
    watch_aware: bool = False,
    scope: Optional[str] = None,
) -> HookVerdict:
    """One governed call: the Python port of ``packages/hook/src/decide.ts``.

    ``deadline`` (on the ``now`` clock) is when every Guardian call must have
    *finished*: past it the agent has already given up on the hook, so a redeem
    landing then would record a receipt for a call that never ran. Each call
    may take up to ``call_timeout_s``, so a call starts only if it, and the
    redeem that may follow it, fit before the deadline.

    ``host`` names the agent in the message about a call still waiting for a
    person. ``watch_aware`` asks Guardian for the watched answer (watch mode,
    opt-in): for a call it would have asked about or denied while the agent
    is watched, the verdict carries ``would_decision`` and nothing is
    redeemed. Set it only when the caller then leaves the call to the agent's
    own permissions.

    ``scope`` is the session the call belongs to (:func:`session_scope`): a
    request held in ``store`` is claimed only by the same call in the same
    session. A caller that does not know the session passes no ``store``, so
    nothing is remembered and every call proposes its own request.
    """

    def room(calls: int) -> bool:
        return deadline is None or now() + calls * call_timeout_s <= deadline

    key = _proposal_key(connection_id, call, scope)
    if not room(2):  # the request (or claim) plus the redeem
        return _denied(call, "HOOK_DEADLINE_PASSED")
    held = store.get(key, wall()) if store is not None else None
    if held is not None:
        request_id: Optional[str] = held["request_id"]
        remaining_ttl = max(0.0, float(held["expires_at"]) - wall())
        try:
            result = client.claim(request_id)
        except Exception:
            result = RequestResult(ok=False, request_id=request_id, reason_code="APPROVAL_PENDING")
    else:
        remaining_ttl = request_ttl_s
        try:
            result = client.request({
                "action": "tool.invoke",
                "connection_id": connection_id,
                "tool_name": call.tool_name,
                "arguments": call.arguments,
                "purpose": f"{agent_name}: {call.summary}",
                **({"watch_aware": True} if watch_aware else {}),
            })
        except Exception:
            return _denied(call, "SERVICE_UNAVAILABLE")
        request_id = result.request_id
        would = _watched(result) if watch_aware else None
        if would is not None:
            # The edit's target must still be the file the hook pinned.
            refusal = _pin_refusal(call)
            if refusal is not None:
                return HookVerdict(
                    allow=False,
                    reason=f"Guardian hook: {call.content_pin[0]} could not be checked against its pin "  # type: ignore[index]
                    f"({refusal}). Nothing ran.",
                    request_id=request_id,
                )
            did = "held it for a person's approval" if would == "ASK" else "denied it"
            return HookVerdict(
                allow=False,
                reason=f"Guardian is watching this agent: under the current rules it would have {did} "
                f"({call.tool_name}, request {request_id}). Guardian approved nothing; the agent's own "
                "permissions apply.",
                request_id=request_id,
                would_decision=would,
            )
    # Guardian's window started inside that call; timing from the reply errs late,
    # and a check after the window is refused by Guardian, so nothing runs.
    answered_at = now()
    approved_by_human = False

    if _pending(result):
        if not request_id:
            return _denied(call, "MISSING_REQUEST_ID")
        if store is not None and held is None:
            store.put(key, request_id, wall() + request_ttl_s)
        log(f'Guardian: "{call.summary}" is held for approval (request {request_id}). '
            "Approve it in the Guardian console.")
        window = max(0.0, min(approval_timeout_s, remaining_ttl))
        lead = min(FINAL_CHECK_LEAD_S, window / 4)
        last_check_at = answered_at + window - lead
        if deadline is not None:
            # The last claim, and the redeem after it, must both finish in time.
            last_check_at = min(last_check_at, deadline - 2 * call_timeout_s)
        interval = poll_interval_s
        max_interval = max(max_poll_interval_s, poll_interval_s)
        while True:
            wait(max(0.0, min(interval, last_check_at - now())))
            interval = min(interval * 1.5, max_interval)
            claimed = None
            if room(2):
                try:
                    claimed = client.claim(request_id)
                except Exception:
                    claimed = None
            if claimed is not None and not _pending(claimed):
                result = claimed
                approved_by_human = claimed.ok and claimed.decision == "ALLOW"
                break
            if claimed is None and not room(2) or now() >= last_check_at:
                return HookVerdict(
                    allow=False,
                    reason=f"Guardian is still waiting for a person to approve {call.tool_name} "
                    f"(request {request_id}). Nothing ran. Tell the user it needs approval in the Guardian app. "
                    + (f"If it is approved while this {host} session is still running, run exactly the same "
                       "action again and it will go ahead; otherwise asking again files a new request."
                       if store is not None
                       else "The session of this call is not known, so running the same action again asks for a "
                       "new approval instead of using this one."),
                    request_id=request_id,
                    guardian_decision="ASK",
                )
    if store is not None:
        store.delete(key)  # decided one way or the other: never reuse it

    if not result.ok or result.decision != "ALLOW" or not result.capability_token:
        code = (result.reason_code or ("DENIED" if result.decision == "DENY" else "MISSING_CAPABILITY")) \
            if result.ok else (result.reason_code or "DENIED")
        return _denied(call, code, request_id=request_id, guardian_decision="DENY")

    if not room(1):
        return _denied(call, "HOOK_DEADLINE_PASSED", request_id=result.request_id,
                       guardian_decision="ASK" if approved_by_human else "ALLOW")
    decided = {
        "request_id": result.request_id,
        "guardian_decision": "ASK" if approved_by_human else "ALLOW",
        "approved_by_human": approved_by_human,
    }
    # The file an Edit-type tool changes must still be the one that was
    # approved. Checked just before the capability is redeemed: on a
    # difference nothing is redeemed and the agent is told no.
    refusal = _pin_refusal(call)
    if refusal is not None:
        path = call.content_pin[0]  # type: ignore[index]
        return HookVerdict(
            allow=False,
            reason=(f"Guardian hook: {path} changed since this edit was proposed ({refusal}). Nothing ran. "
                    "Read the file again and propose the edit again; it needs a new approval."
                    if refusal == CONTENT_CHANGED_SINCE_APPROVAL
                    else f"Guardian hook: {path} could not be checked against its approval ({refusal}). "
                    "Nothing ran."),
            **decided,
        )
    try:
        executed = client.execute(request_id=result.request_id, capability_token=result.capability_token)
    except Exception:
        # The redemption may have reached Guardian: settle it like a lost answer.
        executed = ExecuteResult(ok=False, reason_code="SERVICE_UNAVAILABLE", outcome_unknown=True)
    settled_by_lookup = False
    if not executed.ok:
        if not _outcome_unknown(executed):
            return _denied(call, executed.reason_code or "EXECUTE_FAILED", **decided)
        # The redemption was sent but its answer was lost: Guardian's record of
        # the request settles it. Only a verified redemption lets the tool run.
        # The lookup is one more call, so it is made only if it finishes before
        # the agent gives up on the hook; otherwise the outcome stays unknown.
        found = _look_up(client, result.request_id) if result.request_id and room(1) else "unknown"
        if found == "not-sent":
            return _denied(call, "EXECUTION_NOT_SENT", **decided)
        if found != "verified":
            rid = result.request_id
            return HookVerdict(
                allow=False,
                reason=f"Guardian blocked {call.tool_name} ({EXECUTION_OUTCOME_UNKNOWN}): Guardian's answer was lost "
                f"({executed.reason_code or 'EXECUTE_FAILED'}) and it could not be confirmed whether Guardian "
                f"recorded the call as allowed. Request {rid}. Nothing ran. Do not retry; ask the developer to "
                f"check request {rid} in the Guardian console.",
                **decided,
            )
        settled_by_lookup = True
    note = " Guardian's answer was lost; its record shows the call redeemed." if settled_by_lookup else ""
    return HookVerdict(
        allow=True,
        reason=(f"Approved by a person in Guardian (request {result.request_id}).{note}" if approved_by_human
                else f"Allowed by Guardian policy (request {result.request_id}).{note}"),
        request_id=result.request_id,
        guardian_decision="ASK" if approved_by_human else "ALLOW",
        approved_by_human=approved_by_human,
    )
