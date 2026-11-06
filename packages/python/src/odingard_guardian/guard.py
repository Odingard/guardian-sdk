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

import functools
import inspect
from dataclasses import dataclass
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

from .client import AsyncGuardianClient, GuardianClient, RequestResult

__all__ = [
    "Guard",
    "GuardianDenied",
    "GuardianApprovalPending",
    "GuardianExecutionFailed",
    "ResumeResult",
    "denial_hint",
    "to_arguments_record",
]

Mode = Literal["remote", "in_process"]
OnDecision = Literal["raise", "result"]

_HELD = ("APPROVAL_REQUIRED", "APPROVAL_PENDING")


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


class GuardianExecutionFailed(Exception):
    """ALLOW was decided but redeeming the capability failed.

    ``local_effect_ran=True`` means your function already ran before
    Guardian's final redemption refused it. The effect happened without a
    recorded receipt; treat it as an incident.
    """

    def __init__(
        self, tool_name: str, request_id: str, reason_code: str, local_effect_ran: bool = False
    ) -> None:
        self.tool_name = tool_name
        self.request_id = request_id
        self.reason_code = reason_code
        self.local_effect_ran = local_effect_ran
        super().__init__(
            f'Guardian execution of "{tool_name}" failed (request_id={request_id}, '
            f"reason_code={reason_code}{', local_effect_ran=True' if local_effect_ran else ''})"
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
    ) -> None:
        self.tool_name = tool_name
        self.request_id = request_id
        self.arguments = arguments
        self._resume = resume
        super().__init__(f'Guardian held "{tool_name}" for human approval (request_id={request_id})')

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
    modes: Mapping[str, Mode]

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
) -> Any:
    hint = denial_hint(tool_name, reason_code, stage)
    if opts.on_deny == "result":
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


def _as_held(result: RequestResult) -> RequestResult:
    if not result.ok and result.reason_code in _HELD and result.request_id:
        return RequestResult(ok=True, request_id=result.request_id, decision="ASK", reason_code=result.reason_code)
    return result


def _settle(opts: _Options, tool_name: str, result: RequestResult) -> Generator:
    result = _as_held(result)
    if not result.ok:
        return _deny(opts, tool_name, result.reason_code or "DENIED", None)
    if result.decision == "ALLOW" and result.capability_token:
        request_id = result.request_id or ""
        if opts.mode_for(tool_name) == "remote":
            executed = yield ("execute", request_id, result.capability_token)
            if not executed.ok:
                raise GuardianExecutionFailed(tool_name, request_id, executed.reason_code or "EXECUTE_FAILED")
            yield ("receipt", request_id, executed.receipt)
            return {
                "guardian": {
                    "decision": "ALLOW",
                    "request_id": request_id,
                    "tool_name": tool_name,
                    "receipt": executed.receipt,
                }
            }
        output = yield ("run",)
        executed = yield ("execute", request_id, result.capability_token)
        if not executed.ok:
            raise GuardianExecutionFailed(
                tool_name, request_id, executed.reason_code or "EXECUTE_FAILED", local_effect_ran=True
            )
        yield ("receipt", request_id, executed.receipt)
        return output
    if result.decision == "ASK" and result.request_id:
        if opts.on_ask == "result":
            return {
                "guardian": {
                    "decision": "ASK",
                    "request_id": result.request_id,
                    "tool_name": tool_name,
                    "message": f"Held for human approval. After approval, claim request_id "
                    f"{result.request_id} and re-run the tool.",
                }
            }
        raise _Ask(result.request_id, "tool")
    return _deny(opts, tool_name, result.reason_code or "MISSING_CAPABILITY", result.request_id)


def _ensure_record_transport(
    opts: _Options, ensured: Set[str], tool_name: str
) -> Generator:
    if not opts.install_record_transport:
        return None
    key = f"{opts.connection_id}:{tool_name}"
    if key in ensured:
        return None
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
    if not result.ok and result.reason_code == "TOOL_ALREADY_INSTALLED":
        ensured.add(key)
        return None
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
            return {
                "guardian": {
                    "decision": "ASK",
                    "request_id": result.request_id,
                    "tool_name": tool_name,
                    "message": f"Registering {tool_name} with Guardian needs human approval "
                    f"(request_id {result.request_id}). Retry the tool call after approval.",
                }
            }
        raise _Ask(result.request_id, "install")
    return _deny(
        opts, tool_name, result.reason_code or "MISSING_CAPABILITY", result.request_id, "register"
    )


def _run_through(opts: _Options, ensured: Set[str], tool_name: str, args: Dict[str, Any]) -> Generator:
    if opts.mode_for(tool_name) == "in_process":
        gate = yield from _ensure_record_transport(opts, ensured, tool_name)
        if gate is not None:
            return gate
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
    return (yield from _settle(opts, tool_name, result))


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
    """One governed call: its machine, its tool body, and the last receipt."""

    def __init__(self, guard: "Guard", tool_name: str, args: Dict[str, Any], body: Callable[[], Any]):
        self.guard = guard
        self.tool_name = tool_name
        self.args = args
        self.body = body
        self.receipt: Optional[Dict[str, Any]] = None

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

        return GuardianApprovalPending(self.tool_name, ask.request_id, self.args, resume)

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
                elif kind == "run":
                    value = self.body()
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
                elif kind == "run":
                    value = self.body()
                    if inspect.isawaitable(value):
                        value = await value
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
    :param install_record_transport: propose registering the tool on first use
        (``mcp.install``). Default ``False``: production denies it unless
        the agent's grant pins ``mcp.install``, so register the tool once in the
        console as "My own code (record-only)".
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
            modes=dict(modes or {}),
        )
        self._ensured: Set[str] = set()
        self._on_receipt = on_receipt

    def run(self, tool_name: str, arguments: Any, fn: Callable[[], Any]) -> Any:
        """Govern one call of ``fn`` (no arguments) proposed as ``tool_name(arguments)``.

        Returns ``fn``'s output for a sync guard, or an awaitable for an async guard.
        """
        args = to_arguments_record(arguments)
        run = _Run(self, tool_name, args, fn)
        machine = _run_through(self._opts, self._ensured, tool_name, args)
        if self._async:
            return run.adrive(machine)
        return run.drive(machine)

    def __call__(self, tool_name: Optional[str] = None) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        """Decorator: ``@guard("pay_invoice")``. The call's bound arguments become the proposal."""

        def decorate(fn: Callable[..., Any]) -> Callable[..., Any]:
            name = tool_name or fn.__name__
            signature = inspect.signature(fn)

            def arguments_of(args: tuple, kwargs: dict) -> Dict[str, Any]:
                bound = signature.bind(*args, **kwargs)
                bound.apply_defaults()
                record: Dict[str, Any] = {}
                for key, value in bound.arguments.items():
                    param = signature.parameters[key]
                    if param.kind is inspect.Parameter.VAR_KEYWORD:
                        record.update(value)
                    elif param.kind is inspect.Parameter.VAR_POSITIONAL:
                        record[key] = list(value)
                    else:
                        record[key] = value
                return record

            if self._async:

                @functools.wraps(fn)
                async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                    return await self.run(name, arguments_of(args, kwargs), lambda: fn(*args, **kwargs))

                return async_wrapper

            if inspect.iscoroutinefunction(fn):
                raise TypeError("async functions need an AsyncGuardianClient-backed Guard")

            @functools.wraps(fn)
            def wrapper(*args: Any, **kwargs: Any) -> Any:
                return self.run(name, arguments_of(args, kwargs), lambda: fn(*args, **kwargs))

            return wrapper

        return decorate
