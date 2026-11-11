"""Governed execution: put Guardian in front of your own action code.

A port of the core SDK's ``createGuard`` / adapter triad
(``packages/sdk/src/guard.ts``). Works with any Python agent framework
(LangChain, LangGraph, CrewAI, the OpenAI Agents SDK, the Claude Agent SDK,
plain code), sync or ``async``::

    from odingard_guardian import GuardianClient, Guard

    client = GuardianClient(credential=os.environ["GUARDIAN_AGENT_CREDENTIAL"])
    guard = Guard(client, connection_id=os.environ["GUARDIAN_CONNECTION_ID"])

    @guard("pay_invoice")
    def pay_invoice(invoice_id: str, amount_cents: int, payee_id: str):
        return stripe.PaymentIntent.create(...)   # your code

    pay_invoice(invoice_id="INV-1", amount_cents=48_000, payee_id="acme")

* ALLOW → your function runs, then the capability is redeemed and the
  receipt recorded.
* ASK   → :class:`GuardianApprovalPending` is raised. Nothing runs. Call
  ``.resume()`` after a human approves.
* DENY  → :class:`GuardianDenied` is raised. Your function never runs.

**In-process mode is decision-gated.** Your function runs after ALLOW and
*before* the capability is redeemed, so a revocation that lands in between
is detected after the effect. It is reported as
:class:`GuardianExecutionFailed` with ``local_effect_ran=True``, an incident
and never a success. Use ``mode="remote"`` with a registered catalog tool
when Guardian itself must perform the call.

One sans-IO state machine drives both the sync and async forms, so their
semantics cannot drift.
"""

from __future__ import annotations

import asyncio
import copy
import functools
import inspect
from dataclasses import dataclass, field
from typing import (
    Any,
    Awaitable,
    Callable,
    Dict,
    Generator,
    Literal,
    Mapping,
    Optional,
    Set,
    Union,
)

from ._canonical import CanonicalJsonError, canonical_json
from .client import AsyncGuardianClient, GuardianClient, RequestResult
from .content_pins import (
    CONTENT_CHANGED_SINCE_APPROVAL,
    CONTENT_PIN_INVALID_ARGUMENT,
    CONTENT_PIN_KEY_RESERVED,
    CONTENT_PIN_REMOTE_MODE,
    CONTENT_PIN_UNREADABLE,
    DEFAULT_MAX_PIN_BYTES,
    DEFAULT_MAX_PIN_TOTAL_BYTES,
    ContentPinError,
    VerifiedArguments,
    assert_file_args_spec,
    carries_reserved_key,
    deep_copy_arguments,
    pin_arguments,
    verify_arguments,
    without_pins,
)

__all__ = [
    "Guard",
    "GuardianDenied",
    "GuardianApprovalPending",
    "GuardianExecutionFailed",
    "ResumeResult",
    "denial_hint",
    "execution_failed_message",
    "to_arguments_record",
]

Mode = Literal["remote", "in_process"]
OnDecision = Literal["raise", "result"]

_HELD = ("APPROVAL_REQUIRED", "APPROVAL_PENDING")

#: Answers to ``mcp.install`` that may mean "a tool with that name is already
#: registered" (hosted Guardian answers ``INVALID_REQUEST`` for a tool
#: registered in the console). Guardian does not say whether that entry is
#: record-only, so the call is refused before anything runs.
_INSTALL_MAYBE_DONE = ("TOOL_ALREADY_INSTALLED", "INVALID_REQUEST")


class GuardianDenied(Exception):
    """Guardian refused the action before it ran (DENY, or fail-closed)."""

    decision = "DENY"

    def __init__(
        self,
        tool_name: str,
        reason_code: str,
        request_id: Optional[str] = None,
        hint: Optional[str] = None,
    ) -> None:
        self.tool_name = tool_name
        self.reason_code = reason_code
        self.request_id = request_id
        #: What the developer can do next. Never changes the decision.
        self.hint = hint
        suffix = f" request_id={request_id}" if request_id else ""
        tail = f". {hint}" if hint else ""
        super().__init__(f'Guardian denied "{tool_name}" (reason_code={reason_code}){suffix}{tail}')


def denial_hint(tool_name: str, reason_code: str, stage: str = "invoke") -> Optional[str]:
    """Actionable next step for the denials developers hit first (display only)."""
    if reason_code == "PLAN_LIMIT_EXCEEDED":
        return (
            "Your Guardian plan's monthly protected-action limit is reached; "
            "upgrade in Settings → Billing or wait for the next period."
        )
    if stage == "register":
        return (
            f'Guardian did not allow registering "{tool_name}" automatically. '
            "Register it once in the Guardian console (Connections → tool server → "
            '"My own code (record-only)"), allow it for this agent, and pass '
            "install_record_transport=False."
        )
    if reason_code == "INVALID_REQUEST":
        return (
            f'Check that "{tool_name}" is registered on this connection and allowed '
            "for this agent (Guardian console → Agents → the agent → Tools)."
        )
    return None


def _record_transport_unverified_hint(tool_name: str, answer: str) -> str:
    """Why an in-process call is refused when ``mcp.install`` says the tool may exist."""
    return (
        f'Guardian answered {answer} when asked to register "{tool_name}" as a '
        "record-only tool, so a tool with that name may already be registered "
        "on this connection. Guardian does not tell the SDK whether that entry "
        "is record-only. If it makes an HTTP call, your code and Guardian would "
        "both perform the action, so nothing ran. Automatic registration only "
        "works while no entry with that name exists: a restarted process, "
        "another worker or a new Guard cannot tell an entry the SDK registered "
        f'earlier from any other. If "{tool_name}" is registered in the '
        'Guardian console as a record-only tool ("My own code (record-only)") '
        "and allowed for this agent, pass install_record_transport=False (the "
        'default). If Guardian should perform the call, use mode="remote".'
    )


class GuardianExecutionFailed(Exception):
    """ALLOW was decided but redeeming the capability failed.

    ``local_effect_ran=True`` means your function already ran before
    Guardian's final redemption refused it. The effect happened without a
    recorded receipt; treat it as an incident.

    In ``remote`` mode, Guardian performing the call with a receipt status
    other than ``sent-verified`` is also an execution failure: ``reason_code``
    is ``EXECUTION_<STATUS>`` (for example ``EXECUTION_OUTCOME_PENDING``) and
    ``receipt`` holds Guardian's receipt.
    """

    def __init__(
        self,
        tool_name: str,
        request_id: str,
        reason_code: str,
        local_effect_ran: bool = False,
        receipt: Optional[Dict[str, Any]] = None,
    ) -> None:
        self.tool_name = tool_name
        self.request_id = request_id
        self.reason_code = reason_code
        self.local_effect_ran = local_effect_ran
        self.receipt = receipt
        super().__init__(
            f'Guardian execution of "{tool_name}" failed (request_id={request_id}, '
            f"reason_code={reason_code}{', local_effect_ran=True' if local_effect_ran else ''})"
        )


def _content_pin_refusal(err: GuardianExecutionFailed) -> bool:
    """A content-pin refusal after ALLOW: the tool did not run."""
    return not err.local_effect_ran and (
        err.reason_code == CONTENT_CHANGED_SINCE_APPROVAL or err.reason_code.startswith("CONTENT_PIN_")
    )


def execution_failed_message(err: GuardianExecutionFailed) -> str:
    """What to tell a model after Guardian was asked to run or record a call.

    The action ran (in-process) or may have run (remote), so the message
    never invites a retry: calling the tool again would be a new request and
    could repeat the effect. A content-pin refusal is the exception: the
    file was checked before the tool started, so the model is told the call
    did not run.
    """
    rid = f", request_id {err.request_id}" if err.request_id else ""
    if _content_pin_refusal(err):
        what = (
            "a file it was approved with changed since the approval"
            if err.reason_code == CONTENT_CHANGED_SINCE_APPROVAL
            else "a file it was approved with could not be checked"
        )
        return (
            f"{err.tool_name} did not run: {what} ({err.reason_code}{rid}). "
            "Tell the user; a changed file needs a new approval."
        )
    if err.local_effect_ran:
        return (
            f"{err.tool_name} ran, but Guardian could not record it "
            f"({err.reason_code}{rid}). Do not call it again; tell the user it ran "
            "without a receipt."
        )
    return (
        f"Guardian could not confirm that {err.tool_name} completed "
        f"({err.reason_code}{rid}). It may have run. Do not call it again; "
        "tell the user so they can check."
    )


@dataclass(frozen=True)
class ResumeResult:
    request_id: str
    receipt: Optional[Dict[str, Any]]
    output: Any


class GuardianApprovalPending(Exception):
    """Guardian is holding the action for a human (ASK). Nothing has run.

    Surface ``request_id`` to your approval UI, then call ``resume()``
    (or ``await resume()`` for an async guard) after the human approves.
    Resuming before approval raises ``GuardianApprovalPending`` again.
    """

    decision = "ASK"

    def __init__(
        self,
        tool_name: str,
        request_id: str,
        arguments: Dict[str, Any],
        resume: Callable[[], Union[ResumeResult, Awaitable[ResumeResult]]],
        proposed_arguments: Optional[Dict[str, Any]] = None,
    ) -> None:
        self.tool_name = tool_name
        self.request_id = request_id
        #: The caller's arguments, without content pins: calling again with
        #: them pins the files again.
        self.arguments = arguments
        #: What was proposed to Guardian: ``arguments`` plus, for a tool with
        #: ``file_args``, its content pins under ``guardianContentPins``.
        self.proposed_arguments = arguments if proposed_arguments is None else proposed_arguments
        self._resume = resume
        super().__init__(f'Guardian held "{tool_name}" for human approval (request_id={request_id})')

    @property
    def proposed_args(self) -> Dict[str, Any]:
        """Alias of :attr:`proposed_arguments`."""
        return self.proposed_arguments

    def resume(self) -> Any:
        """Claim the approved capability, run the action and record the receipt."""
        return self._resume()


def to_arguments_record(value: Any) -> Dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    return {} if value is None else {"input": value}


# --- sans-IO state machine ---------------------------------------------------
# Generators yield operations; a sync or async driver performs them and sends
# results back. Operations: ("request", invocation) → RequestResult,
# ("claim", request_id) → RequestResult, ("execute", request_id, token) →
# ExecuteResult, ("run",) → the wrapped function's output,
# ("receipt", request_id, receipt) → None.


class _Ask(Exception):
    def __init__(self, request_id: str, kind: Literal["tool", "install"]) -> None:
        self.request_id = request_id
        self.kind = kind


@dataclass
class _Options:
    connection_id: str
    mode: Mode
    adapter_id: Optional[str]
    agent_name: str
    purpose: Union[None, str, Callable[[str, Dict[str, Any]], str]]
    on_ask: OnDecision
    on_deny: OnDecision
    install_record_transport: bool
    #: "result" hands an execution failure back as data (see
    #: ``execution_failed_message``) instead of raising it.
    on_execution_failed: OnDecision
    modes: Mapping[str, Mode]
    #: Per pinned file cap and per call cap for content pins, in bytes.
    max_pin_bytes: int = DEFAULT_MAX_PIN_BYTES
    max_pin_total_bytes: int = DEFAULT_MAX_PIN_TOTAL_BYTES
    #: on_ask="result" only: held request ids by (kind, connection, tool, args),
    #: so calling the tool again after approval claims the approved request
    #: instead of proposing a fresh one that needs a fresh approval.
    held: Dict[str, str] = field(default_factory=dict)

    def mode_for(self, tool_name: str) -> Mode:
        return self.modes.get(tool_name, self.mode)

    def purpose_for(self, tool_name: str, args: Dict[str, Any]) -> str:
        if callable(self.purpose):
            return self.purpose(tool_name, args)
        if isinstance(self.purpose, str):
            return self.purpose
        return f"{self.agent_name} invoked {tool_name}"


def _deny(
    opts: _Options,
    tool_name: str,
    reason_code: str,
    request_id: Optional[str],
    stage: str = "invoke",
    hint_override: Optional[str] = None,
) -> Any:
    hint = hint_override if hint_override is not None else denial_hint(tool_name, reason_code, stage)
    if opts.on_deny == "result":
        if stage == "pin":
            # Refused on this machine before anything was proposed.
            message = f"{tool_name} was not proposed and did not run ({reason_code})."
        elif reason_code == "SERVICE_UNAVAILABLE":
            # Guardian did not answer: not a decision, and nothing ran.
            message = (
                f"Guardian could not be reached to check {tool_name} "
                f"({reason_code}), so it did not run. Try again later."
            )
            hint = None
        else:
            message = f"Guardian denied {tool_name} ({reason_code}). Do not retry the same call."
        return {
            "guardian": {
                "decision": "DENY",
                "tool_name": tool_name,
                "reason_code": reason_code,
                **({"request_id": request_id} if request_id else {}),
                "message": f"{message} {hint}" if hint else message,
            }
        }
    raise GuardianDenied(tool_name, reason_code, request_id, hint)


def _execution_failed(opts: _Options, err: GuardianExecutionFailed) -> Generator:
    """Report a call that ran (or may have run) but could not be confirmed.

    The app's ``on_execution_error`` hook always sees it. With
    ``on_execution_failed="result"`` the model gets a result that says the
    call ran or may have run and must not be repeated; otherwise it raises.
    """
    yield ("failed", err)
    if opts.on_execution_failed != "result":
        raise err
    return {
        "guardian": {
            "decision": "ALLOW",
            "outcome": "ran_unrecorded"
            if err.local_effect_ran
            else ("not_run" if _content_pin_refusal(err) else "unknown"),
            "tool_name": err.tool_name,
            **({"request_id": err.request_id} if err.request_id else {}),
            "reason_code": err.reason_code,
            "local_effect_ran": err.local_effect_ran,
            **({"receipt": err.receipt} if err.receipt is not None else {}),
            "message": execution_failed_message(err),
        }
    }


def _held_key(opts: _Options, kind: str, tool_name: str, args: Optional[Dict[str, Any]]) -> Optional[str]:
    if opts.on_ask != "result":
        return None
    try:
        body = "" if args is None else canonical_json(args)
    except (CanonicalJsonError, TypeError, ValueError):
        return None  # arguments Guardian cannot canonicalize are never matched
    return f"{kind}\x00{opts.connection_id}\x00{tool_name}\x00{body}"


def _ask_result(tool_name: str, request_id: str, install: bool = False) -> Dict[str, Any]:
    what = f"Registering {tool_name} with Guardian" if install else f"{tool_name}"
    return {
        "guardian": {
            "decision": "ASK",
            "request_id": request_id,
            "tool_name": tool_name,
            "message": f"{what} is held for human approval (request_id {request_id}). "
            "After a person approves, call the tool again with the same arguments: "
            "the approved request runs then. Calling it before then does not "
            "create another approval.",
        }
    }


def _as_held(result: RequestResult) -> RequestResult:
    if not result.ok and result.reason_code in _HELD and result.request_id:
        return RequestResult(ok=True, request_id=result.request_id, decision="ASK", reason_code=result.reason_code)
    return result


def _settle(
    opts: _Options, tool_name: str, result: RequestResult, held_key: Optional[str] = None
) -> Generator:
    result = _as_held(result)
    if not result.ok:
        # Keep Guardian's request id on a refusal so it can be traced.
        return _deny(opts, tool_name, result.reason_code or "DENIED", result.request_id or None)
    if result.decision == "ALLOW" and result.capability_token:
        request_id = result.request_id or ""
        if opts.mode_for(tool_name) == "remote":
            # Never redeem a remote call whose declared file arguments
            # Guardian cannot check (a configuration error caught again).
            refusal = yield ("pin_check", "remote")
            if refusal is not None:
                return (
                    yield from _execution_failed(
                        opts, GuardianExecutionFailed(tool_name, request_id, refusal, local_effect_ran=False)
                    )
                )
            executed = yield ("execute", request_id, result.capability_token)
            if not executed.ok:
                # Guardian was asked to perform the call; a lost or refused
                # answer does not prove it did not happen.
                return (
                    yield from _execution_failed(
                        opts,
                        GuardianExecutionFailed(tool_name, request_id, executed.reason_code or "EXECUTE_FAILED"),
                    )
                )
            # Guardian performed the call; only `sent-verified` means the
            # upstream accepted it. Anything else (not-sent, outcome-pending,
            # outcome-unconfirmed) is an execution failure, never an ALLOW.
            status = executed.receipt.get("status") if isinstance(executed.receipt, dict) else None
            if status != "sent-verified":
                return (
                    yield from _execution_failed(
                        opts,
                        GuardianExecutionFailed(
                            tool_name,
                            request_id,
                            "EXECUTION_" + str(status or "unknown").upper().replace("-", "_"),
                            receipt=executed.receipt,
                        ),
                    )
                )
            yield ("receipt", request_id, executed.receipt)
            return {
                "guardian": {
                    "decision": "ALLOW",
                    "request_id": request_id,
                    "tool_name": tool_name,
                    "receipt": executed.receipt,
                }
            }
        # Content pins: re-read and re-hash every declared file argument just
        # before the tool runs, driven by the tool's file_args (not by what
        # the arguments carry). A missing or wrong pin, or a changed file,
        # refuses: the tool does not run and the capability is not redeemed.
        refusal = yield ("pin_check", "in_process")
        if refusal is not None:
            return (
                yield from _execution_failed(
                    opts, GuardianExecutionFailed(tool_name, request_id, refusal, local_effect_ran=False)
                )
            )
        output = yield ("run",)
        executed = yield ("execute", request_id, result.capability_token)
        if not executed.ok:
            # The function already ran: never report this as "did not run".
            return (
                yield from _execution_failed(
                    opts,
                    GuardianExecutionFailed(
                        tool_name, request_id, executed.reason_code or "EXECUTE_FAILED", local_effect_ran=True
                    ),
                )
            )
        yield ("receipt", request_id, executed.receipt)
        return output
    if result.decision == "ASK" and result.request_id:
        if opts.on_ask == "result":
            if held_key is not None:
                opts.held[held_key] = result.request_id
            return _ask_result(tool_name, result.request_id)
        raise _Ask(result.request_id, "tool")
    return _deny(opts, tool_name, result.reason_code or "MISSING_CAPABILITY", result.request_id)


def _ensure_record_transport(
    opts: _Options, ensured: Set[str], tool_name: str
) -> Generator:
    """Register the record-only entry for an in-process tool (opt-in).

    ``ensured`` holds the entries this Guard registered itself, in memory
    only. An "already registered" answer is refused as
    ``RECORD_TRANSPORT_UNVERIFIED`` before anything runs, because the
    existing entry may be an HTTP tool. That includes an entry registered by
    an earlier process, so automatic registration only works for a tool with
    no entry yet.
    """
    if not opts.install_record_transport:
        return None
    key = f"{opts.connection_id}:{tool_name}"
    if key in ensured:
        return None
    held_key = _held_key(opts, "install", tool_name, None)
    prior = opts.held.pop(held_key, None) if held_key else None
    if prior is not None:
        claimed = _as_held((yield ("claim", prior)))
        if not claimed.ok and claimed.reason_code == "SERVICE_UNAVAILABLE":
            # Guardian did not answer: keep the registration held for the next try.
            opts.held[held_key] = prior
            return _deny(opts, tool_name, "SERVICE_UNAVAILABLE", prior, "register")
        if claimed.ok and claimed.decision == "ASK":
            opts.held[held_key] = prior  # still waiting for the person
            return _ask_result(tool_name, prior, install=True)
        if claimed.ok and claimed.decision == "ALLOW" and claimed.capability_token:
            executed = yield ("execute", claimed.request_id or prior, claimed.capability_token)
            if not executed.ok:
                raise GuardianExecutionFailed(tool_name, prior, executed.reason_code or "")
            ensured.add(key)
            return None
        return _deny(opts, tool_name, claimed.reason_code or "MISSING_CAPABILITY", prior, "register")
    result = yield (
        "request",
        {
            "action": "mcp.install",
            "connection_id": opts.connection_id,
            "tool": {
                "name": tool_name,
                "description": f'In-process tool "{tool_name}" — evidence record only '
                "(registered by the Guardian Python SDK)",
                "transport": "record",
            },
            **({"adapter_id": opts.adapter_id} if opts.adapter_id else {}),
            "purpose": f"Register in-process tool {tool_name} for evidence recording",
        },
    )
    if not result.ok and result.reason_code in _INSTALL_MAYBE_DONE:
        # Fail closed: never run local code for an entry Guardian might
        # perform as an HTTP call. Not remembered, so a retry asks again.
        return _deny(
            opts,
            tool_name,
            "RECORD_TRANSPORT_UNVERIFIED",
            result.request_id or None,
            "register",
            _record_transport_unverified_hint(tool_name, result.reason_code),
        )
    result = _as_held(result)
    if not result.ok:
        return _deny(opts, tool_name, result.reason_code or "DENIED", None, "register")
    if result.decision == "ALLOW" and result.capability_token:
        executed = yield ("execute", result.request_id, result.capability_token)
        if not executed.ok:
            raise GuardianExecutionFailed(tool_name, result.request_id or "", executed.reason_code or "")
        ensured.add(key)
        return None
    if result.decision == "ASK" and result.request_id:
        if opts.on_ask == "result":
            if held_key is not None:
                opts.held[held_key] = result.request_id
            return _ask_result(tool_name, result.request_id, install=True)
        raise _Ask(result.request_id, "install")
    return _deny(
        opts, tool_name, result.reason_code or "MISSING_CAPABILITY", result.request_id, "register"
    )


def _run_through(opts: _Options, ensured: Set[str], tool_name: str, args: Dict[str, Any]) -> Generator:
    if opts.mode_for(tool_name) == "in_process":
        gate = yield from _ensure_record_transport(opts, ensured, tool_name)
        if gate is not None:
            return gate
    held_key = _held_key(opts, "tool", tool_name, args)
    prior = opts.held.pop(held_key, None) if held_key else None
    if prior is not None:
        # The same call was held earlier: claim that request (approved →
        # it runs; still pending → the same ASK, no second approval).
        claimed = yield ("claim", prior)
        if not claimed.ok and claimed.reason_code == "SERVICE_UNAVAILABLE":
            # Guardian did not answer: keep the request held for the next try.
            opts.held[held_key] = prior
        return (yield from _settle(opts, tool_name, claimed, held_key))
    result = yield (
        "request",
        {
            "action": "tool.invoke",
            "connection_id": opts.connection_id,
            "tool_name": tool_name,
            "arguments": args,
            **({"adapter_id": opts.adapter_id} if opts.adapter_id else {}),
            "purpose": opts.purpose_for(tool_name, args),
        },
    )
    return (yield from _settle(opts, tool_name, result, held_key))


def _resume_tool(opts: _Options, tool_name: str, request_id: str) -> Generator:
    claimed = yield ("claim", request_id)
    return (yield from _settle(opts, tool_name, claimed))


def _resume_install(
    opts: _Options, ensured: Set[str], tool_name: str, args: Dict[str, Any], request_id: str
) -> Generator:
    claimed = yield ("claim", request_id)
    if claimed.ok and claimed.decision == "ALLOW" and claimed.capability_token:
        executed = yield ("execute", claimed.request_id, claimed.capability_token)
        if not executed.ok:
            raise GuardianExecutionFailed(tool_name, claimed.request_id or "", executed.reason_code or "")
        ensured.add(f"{opts.connection_id}:{tool_name}")
        return (yield from _run_through(opts, ensured, tool_name, args))
    if (claimed.ok and claimed.decision == "ASK") or (
        not claimed.ok and claimed.reason_code in _HELD
    ):
        raise _Ask(request_id, "install")
    raise GuardianDenied(
        tool_name,
        (claimed.reason_code or "MISSING_CAPABILITY"),
        claimed.request_id if claimed.ok else None,
    )


# --- drivers -----------------------------------------------------------------


class _Run:
    """One governed call: its machine, its tool body, and the last receipt.

    ``args`` is what was proposed (with any content pins); ``caller_args``
    is the caller's record without them. ``body`` receives the verified
    content pins (or ``None``) and runs the tool.
    """

    def __init__(
        self,
        guard: "Guard",
        tool_name: str,
        args: Dict[str, Any],
        body: Callable[[Optional[VerifiedArguments]], Any],
        caller_args: Optional[Dict[str, Any]] = None,
        file_args: Optional[Mapping[str, str]] = None,
    ):
        self.guard = guard
        self.tool_name = tool_name
        self.args = args
        self.caller_args = args if caller_args is None else caller_args
        self.body = body
        self.file_args = dict(file_args) if file_args else None
        self.receipt: Optional[Dict[str, Any]] = None
        self._prepared: Optional[VerifiedArguments] = None

    def _pin_check(self, mode: str) -> Optional[str]:
        """The ``("pin_check", mode)`` op: ``None`` when the call may run,
        else the refusal code. Driven by the declaration (``file_args``)."""
        self._prepared = None
        if mode == "remote":
            return CONTENT_PIN_REMOTE_MODE if self.file_args else None
        if not self.file_args and not carries_reserved_key(self.args):
            return None
        opts = self.guard._opts
        try:
            self._prepared = verify_arguments(
                self.file_args,
                self.args,
                max_pin_bytes=opts.max_pin_bytes,
                max_pin_total_bytes=opts.max_pin_total_bytes,
            )
        except ContentPinError as err:
            return err.reason_code
        except Exception:  # noqa: BLE001 — never turn an exception into a run
            return CONTENT_PIN_UNREADABLE
        return None

    def _cleanup(self) -> None:
        prepared, self._prepared = self._prepared, None
        if prepared is not None:
            prepared.cleanup()

    def _pending(self, ask: _Ask) -> GuardianApprovalPending:
        g = self.guard
        if ask.kind == "tool":
            machine = lambda: _resume_tool(g._opts, self.tool_name, ask.request_id)  # noqa: E731
        else:
            machine = lambda: _resume_install(  # noqa: E731
                g._opts, g._ensured, self.tool_name, self.args, ask.request_id
            )
        if g._async:

            async def resume() -> ResumeResult:
                output = await self.adrive(machine())
                return ResumeResult(ask.request_id, self.receipt, output)

        else:

            def resume() -> ResumeResult:  # type: ignore[misc]
                output = self.drive(machine())
                return ResumeResult(ask.request_id, self.receipt, output)

        caller_args, proposed = self.caller_args, self.args
        if self.file_args:
            # The run keeps its own records: the pins and paths the re-check
            # reads must not change through the pending object's fields.
            caller_args, proposed = copy.deepcopy(caller_args), copy.deepcopy(proposed)
        return GuardianApprovalPending(
            self.tool_name, ask.request_id, caller_args, resume, proposed_arguments=proposed
        )

    def _report_failure(self, err: GuardianExecutionFailed) -> Any:
        """Call the app's ``on_execution_error`` hook. It only observes: an
        error it raises never changes what the caller or the model is told."""
        hook = self.guard._on_execution_error
        if hook is None:
            return None
        try:
            result = hook(err)
        except Exception:  # noqa: BLE001
            return None
        return result if inspect.isawaitable(result) else None

    def drive(self, machine: Generator) -> Any:
        client = self.guard.client
        value: Any = None
        try:
            while True:
                op = machine.send(value)
                kind = op[0]
                if kind == "request":
                    value = client.request(op[1])
                elif kind == "claim":
                    value = client.claim(op[1])
                elif kind == "execute":
                    value = client.execute(request_id=op[1], capability_token=op[2])
                elif kind == "pin_check":
                    value = self._pin_check(op[1])
                elif kind == "run":
                    try:
                        value = self.body(self._prepared)
                    finally:
                        # A private copy is deleted when the tool returns, also on raise.
                        self._cleanup()
                elif kind == "failed":
                    pending = self._report_failure(op[1])
                    close = getattr(pending, "close", None)
                    if callable(close):
                        close()  # a sync guard does not await an async hook
                    value = None
                else:  # receipt
                    self.receipt = op[2]
                    if self.guard._on_receipt:
                        self.guard._on_receipt(self.tool_name, op[1], op[2])
                    value = None
        except StopIteration as done:
            return done.value
        except _Ask as ask:
            raise self._pending(ask) from None

    async def adrive(self, machine: Generator) -> Any:
        client = self.guard.client
        value: Any = None
        try:
            while True:
                op = machine.send(value)
                kind = op[0]
                if kind == "request":
                    value = await client.request(op[1])
                elif kind == "claim":
                    value = await client.claim(op[1])
                elif kind == "execute":
                    value = await client.execute(request_id=op[1], capability_token=op[2])
                elif kind == "pin_check":
                    if self.file_args or carries_reserved_key(self.args):
                        value = await asyncio.to_thread(self._pin_check, op[1])
                    else:
                        value = self._pin_check(op[1])
                elif kind == "run":
                    try:
                        value = self.body(self._prepared)
                        if inspect.isawaitable(value):
                            value = await value
                    finally:
                        self._cleanup()
                elif kind == "failed":
                    pending = self._report_failure(op[1])
                    if pending is not None:
                        try:
                            await pending
                        except Exception:  # noqa: BLE001 — hooks only observe
                            pass
                    value = None
                else:  # receipt
                    self.receipt = op[2]
                    if self.guard._on_receipt:
                        result = self.guard._on_receipt(self.tool_name, op[1], op[2])
                        if inspect.isawaitable(result):
                            await result
                    value = None
        except StopIteration as done:
            return done.value
        except _Ask as ask:
            raise self._pending(ask) from None


class Guard:
    """Governed execution for your own action code.

    :param client: a :class:`GuardianClient` (sync guards) or
        :class:`AsyncGuardianClient` (async guards).
    :param connection_id: the tool connection the actions are authorized
        against (Guardian console → Connections).
    :param mode: ``"in_process"`` (default; your function is the action) or
        ``"remote"`` (a registered catalog tool Guardian performs itself).
    :param on_ask / on_deny: ``"raise"`` (default) or ``"result"`` to hand
        the decision back as data, which is useful as a tool result for an LLM.
    :param on_receipt: ``callback(tool_name, request_id, receipt)`` after every
        recorded execution.
    :param on_execution_failed: what to do when the call ran (in-process) or
        Guardian was asked to perform it (remote) but it could not be
        confirmed: redemption failed after your function ran, or a remote
        receipt status is not ``sent-verified``. ``"raise"`` raises
        :class:`GuardianExecutionFailed`; ``"result"`` returns
        ``{"guardian": {"decision": "ALLOW", "outcome": …, "message": …}}``
        whose message says the call ran or may have run and must not be
        called again. Defaults to the ``on_deny`` setting.
    :param on_execution_error: ``callback(error)`` with the
        :class:`GuardianExecutionFailed` whenever that happens, in either
        mode, so the app can raise an incident. Errors it raises are ignored.
    :param install_record_transport: propose registering the tool on first use
        (``mcp.install``). Default ``False``: production denies it unless
        the agent's grant pins ``mcp.install``, so register the tool once in the
        console as "My own code (record-only)". ``True`` only works for a tool
        with no entry yet: which entries this Guard registered is kept in
        memory, so after a restart, in another worker or in a new Guard an
        "already registered" answer is refused as ``RECORD_TRANSPORT_UNVERIFIED``
        and nothing runs, even for an entry the SDK created itself.
    :param max_pin_bytes / max_pin_total_bytes: caps for content pins
        (``file_args``): per pinned file (default 25 MiB) and for all pinned
        files of one call (default 64 MiB). Over a cap the call is refused
        (``CONTENT_PIN_TOO_LARGE``); a prefix is never hashed.

    **Content pins** (``file_args`` on the decorator or on :meth:`run`):
    approval binds the exact arguments. A file path is an argument; the
    file's contents are not, unless you declare the argument in
    ``file_args``. With ``file_args``, the SDK on your machine reads the
    file, puts its SHA-256 in the approved arguments, and checks it again
    just before the tool runs; a changed file is refused with
    ``CONTENT_CHANGED_SINCE_APPROVAL`` and nothing runs. Guardian's servers
    never see the file. Paths must be absolute (the SDK does not resolve
    relative paths or ``~``). In-process mode only; Linux and macOS only.
    """

    def __init__(
        self,
        client: Union[GuardianClient, AsyncGuardianClient],
        *,
        connection_id: str,
        mode: Mode = "in_process",
        modes: Optional[Mapping[str, Mode]] = None,
        adapter_id: Optional[str] = None,
        agent_name: str = "agent",
        purpose: Union[None, str, Callable[[str, Dict[str, Any]], str]] = None,
        on_ask: OnDecision = "raise",
        on_deny: OnDecision = "raise",
        on_receipt: Optional[Callable[[str, str, Optional[Dict[str, Any]]], Any]] = None,
        install_record_transport: bool = False,
        on_execution_failed: Optional[OnDecision] = None,
        on_execution_error: Optional[Callable[[GuardianExecutionFailed], Any]] = None,
        max_pin_bytes: int = DEFAULT_MAX_PIN_BYTES,
        max_pin_total_bytes: int = DEFAULT_MAX_PIN_TOTAL_BYTES,
    ) -> None:
        if not connection_id:
            raise ValueError("connection_id is required")
        self.client = client
        self._async = isinstance(client, AsyncGuardianClient) or inspect.iscoroutinefunction(
            getattr(client, "request", None)
        )
        self._opts = _Options(
            connection_id=connection_id,
            mode=mode,
            adapter_id=adapter_id,
            agent_name=agent_name,
            purpose=purpose,
            on_ask=on_ask,
            on_deny=on_deny,
            install_record_transport=install_record_transport,
            on_execution_failed=on_execution_failed or on_deny,
            modes=dict(modes or {}),
            max_pin_bytes=max_pin_bytes,
            max_pin_total_bytes=max_pin_total_bytes,
        )
        #: Record-only entries this Guard registered itself (in memory only).
        self._ensured: Set[str] = set()
        self._on_receipt = on_receipt
        self._on_execution_error = on_execution_error

    def _check_file_args(
        self, tool_name: str, file_args: Optional[Mapping[str, str]], allowed: Any = ("bytes", "copy", "recheck")
    ) -> Optional[Dict[str, str]]:
        """Configuration check (decoration time / Guard.run): a known mode per
        top-level argument, and in-process only. In remote mode Guardian
        performs the call and cannot read the agent's files."""
        if file_args is None:
            return None
        assert_file_args_spec(tool_name, file_args, allowed_modes=tuple(allowed))
        if not file_args:
            return None
        if self._opts.mode_for(tool_name) == "remote":
            raise ContentPinError(
                CONTENT_PIN_REMOTE_MODE,
                f'"{tool_name}" declares file_args but runs in remote mode, where Guardian '
                'performs the call and cannot read your files. Use mode="in_process".',
            )
        return dict(file_args)

    def _refuse_before_proposal(self, tool_name: str, reason_code: str, detail: str) -> Any:
        """A local refusal before anything is proposed: no request is sent."""
        try:
            result = _deny(self._opts, tool_name, reason_code, None, "pin", f"{detail} Nothing was proposed or run.")
        except GuardianDenied as denied:
            err = denied
            if self._async:

                async def raise_it() -> Any:
                    raise err

                return raise_it()
            raise
        if self._async:

            async def give() -> Any:
                return result

            return give()
        return result

    def _governed(
        self,
        tool_name: str,
        args: Dict[str, Any],
        body: Callable[[Optional[VerifiedArguments]], Any],
        file_args: Optional[Dict[str, str]],
    ) -> Any:
        # The reserved key is refused for every tool, so an agent cannot
        # supply a pin of its own.
        if carries_reserved_key(args):
            return self._refuse_before_proposal(
                tool_name,
                CONTENT_PIN_KEY_RESERVED,
                'The argument name "guardianContentPins" is reserved for content pins.',
            )
        if not file_args:
            run = _Run(self, tool_name, args, body)
            machine = _run_through(self._opts, self._ensured, tool_name, args)
            if self._async:
                return run.adrive(machine)
            return run.drive(machine)

        opts = self._opts
        # A private copy of the record: what is proposed and re-checked
        # cannot change through the caller's objects or the pending object.
        try:
            args = deep_copy_arguments(tool_name, args, "an argument")
        except ContentPinError as err:
            return self._refuse_before_proposal(tool_name, err.reason_code, str(err))

        def pin() -> Dict[str, Any]:
            return pin_arguments(
                file_args, args, max_pin_bytes=opts.max_pin_bytes, max_pin_total_bytes=opts.max_pin_total_bytes
            )

        def refusal(err: Exception) -> Any:
            code = err.reason_code if isinstance(err, ContentPinError) else CONTENT_PIN_UNREADABLE
            return _deny(opts, tool_name, code, None, "pin", f"{err}. Nothing was proposed or run.")

        # Pin step: before any request (record transport included), so a
        # refusal sends nothing. The pinned record is proposed and keys the
        # held retry, so a changed file is a new request needing a new approval.
        if self._async:

            async def arun() -> Any:
                try:
                    proposed = await asyncio.to_thread(pin)
                except Exception as err:  # noqa: BLE001 — never run unpinned
                    return refusal(err)
                run = _Run(self, tool_name, proposed, body, caller_args=args, file_args=file_args)
                return await run.adrive(_run_through(opts, self._ensured, tool_name, proposed))

            return arun()
        try:
            proposed = pin()
        except Exception as err:  # noqa: BLE001 — never run unpinned
            return refusal(err)
        run = _Run(self, tool_name, proposed, body, caller_args=args, file_args=file_args)
        return run.drive(_run_through(opts, self._ensured, tool_name, proposed))

    def run(
        self,
        tool_name: str,
        arguments: Any,
        fn: Callable[[], Any],
        *,
        file_args: Optional[Mapping[str, str]] = None,
    ) -> Any:
        """Govern one call of ``fn`` (no arguments) proposed as ``tool_name(arguments)``.

        Returns ``fn``'s output for a sync guard, or an awaitable for an async guard.

        ``file_args`` supports ``"recheck"`` only: ``fn`` takes no arguments,
        so the SDK cannot hand it the verified bytes or a private copy. Use
        the ``@guard`` decorator for ``"bytes"`` and ``"copy"``.
        """
        spec = self._check_file_args(tool_name, file_args, allowed=("recheck",))
        args = to_arguments_record(arguments)
        return self._governed(tool_name, args, lambda _prepared: fn(), spec)

    def __call__(
        self, tool_name: Optional[str] = None, *, file_args: Optional[Mapping[str, str]] = None
    ) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        """Decorator: ``@guard("pay_invoice")``. The call's bound arguments become the proposal.

        ``file_args={"attachment_path": "bytes"}`` pins the file each named
        parameter points at (``"bytes"``: the function receives a
        :class:`PinnedFile`; ``"copy"``: the path of a private copy;
        ``"recheck"``: the original path, checked again just before the run).
        """

        def decorate(fn: Callable[..., Any]) -> Callable[..., Any]:
            name = tool_name or fn.__name__
            signature = inspect.signature(fn)
            spec = self._check_file_args(name, file_args)
            if spec:
                named = (
                    inspect.Parameter.POSITIONAL_ONLY,
                    inspect.Parameter.POSITIONAL_OR_KEYWORD,
                    inspect.Parameter.KEYWORD_ONLY,
                )
                for arg in spec:
                    param = signature.parameters.get(arg)
                    if param is None or param.kind not in named:
                        raise ContentPinError(
                            CONTENT_PIN_INVALID_ARGUMENT,
                            f'file_args for "{name}" names "{arg}", which is not a named parameter of '
                            f"{fn.__name__} (an argument from *args or **kwargs cannot be pinned)",
                        )

            def record_of(arguments: Mapping[str, Any]) -> Dict[str, Any]:
                record: Dict[str, Any] = {}
                for key, value in arguments.items():
                    param = signature.parameters[key]
                    if param.kind is inspect.Parameter.VAR_KEYWORD:
                        record.update(value)
                    elif param.kind is inspect.Parameter.VAR_POSITIONAL:
                        record[key] = list(value)
                    else:
                        record[key] = value
                return record

            def arguments_of(args: tuple, kwargs: dict) -> Dict[str, Any]:
                bound = signature.bind(*args, **kwargs)
                bound.apply_defaults()
                return record_of(bound.arguments)

            def pinned_call(args: tuple, kwargs: dict) -> Any:
                """A ``file_args`` tool: the bound arguments are deep-copied when
                proposed, and the call is rebuilt from that copy with each
                declared parameter replaced by its verified value."""
                bound = signature.bind(*args, **kwargs)
                passed = set(bound.arguments)
                bound.apply_defaults()
                arguments = dict(bound.arguments)
                # A declared parameter the caller did not pass and whose
                # default is None is absent (not pinned, left out of the
                # proposal, and the function gets its default), as an
                # undefined argument is in TypeScript. Any other default is
                # pinned like a passed value. A declared parameter passed as
                # None is present and refused.
                for arg in spec:
                    if arg not in passed and signature.parameters[arg].default is None:
                        arguments.pop(arg, None)
                try:
                    snapshot = deep_copy_arguments(name, arguments, "an argument")
                except ContentPinError as err:
                    return self._refuse_before_proposal(name, err.reason_code, str(err))

                def body(prepared: Optional[VerifiedArguments]) -> Any:
                    arguments = copy.deepcopy(snapshot)
                    if prepared is not None:
                        prepared.substitute(arguments)
                    rebuilt = inspect.BoundArguments(signature, arguments)  # type: ignore[arg-type]
                    return fn(*rebuilt.args, **rebuilt.kwargs)

                # ``snapshot`` stays private to ``body``: _governed deep-copies
                # this record again, so what is proposed, checked and exposed
                # shares no object with what the body is rebuilt from.
                return self._governed(name, record_of(snapshot), body, spec)

            if self._async:

                @functools.wraps(fn)
                async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                    if spec:
                        return await pinned_call(args, kwargs)
                    return await self.run(name, arguments_of(args, kwargs), lambda: fn(*args, **kwargs))

                return async_wrapper

            if inspect.iscoroutinefunction(fn):
                raise TypeError("async functions need an AsyncGuardianClient-backed Guard")

            @functools.wraps(fn)
            def wrapper(*args: Any, **kwargs: Any) -> Any:
                if spec:
                    return pinned_call(args, kwargs)
                return self.run(name, arguments_of(args, kwargs), lambda: fn(*args, **kwargs))

            return wrapper

        return decorate
