"""Shared core of the hook-style framework integrations (Agent Framework, Semantic Kernel, LangChain).

A framework hands the integration one tool call at a time, with a ``next``
step that runs the tool. :func:`decide_and_run` asks Guardian and takes
that step after ALLOW, never before, through an async :class:`Guard` that hands
every decision back as data. It fails closed: anything that goes wrong
before the tool starts means the tool does not run.
"""

from __future__ import annotations

import copy
import inspect
import json
import logging
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, Mapping, Optional, Union

from ._canonical import canonical_json
from .client import AsyncGuardianClient, GuardianClient
from .guard import EXECUTION_OUTCOME_UNKNOWN, Guard, GuardianExecutionFailed, Mode

_logger = logging.getLogger("odingard_guardian")

#: Returned by the tool step so a Guard result can be told from a tool output.
_RAN = object()

ToolNames = Union[None, Mapping[str, str], Callable[[str], str]]


@dataclass(frozen=True)
class Outcome:
    """What happened to one governed call.

    ``ran`` is True once the tool step started. ``message`` is what the
    model should be told instead of the tool's own result (``None`` when
    the tool ran and Guardian recorded it). For a ``remote`` tool that
    Guardian performed, the tool step never starts and ``message`` is
    Guardian's result as JSON text:
    ``{"guardian": {"decision": "ALLOW", "request_id": …, "tool_name": …,
    "receipt": …}}``.

    ``result`` is Guardian's result record (``{"guardian": {...}}``) whenever
    the tool step did not answer the call: a refusal, a held call, a call
    that ran but could not be recorded, a call Guardian allowed that did not
    complete, or a ``remote`` tool Guardian performed. It is ``None`` when
    the tool ran and Guardian recorded it, and when Guardian could not be
    asked.

    ``decision == "ALLOW"`` with ``ran`` False is not always a performed
    call. Use :func:`performed_remotely` to tell: a ``remote`` call Guardian
    performed has no ``"outcome"`` and no ``"message"`` key in
    ``result["guardian"]``. An allowed call that could not be confirmed (a
    receipt that is not ``sent-verified``, a lost answer) or that was refused
    before it started (a content pin) has both, with ``"outcome"`` set to
    ``"unknown"`` or ``"not_run"``, and must never be reported as done.
    """

    ran: bool
    decision: str
    message: Optional[str] = None
    request_id: Optional[str] = None
    reason_code: Optional[str] = None
    result: Optional[Dict[str, Any]] = None


def build_guard(
    client: Union[AsyncGuardianClient, GuardianClient],
    *,
    connection_id: str,
    agent_name: str,
    adapter_id: Optional[str],
    purpose: Any,
    amount_args: Optional[Mapping[str, Mapping[str, Any]]],
    on_receipt: Optional[Callable[..., Any]],
    on_execution_error: Optional[Callable[[GuardianExecutionFailed], Any]],
    mode: Mode = "in_process",
    modes: Optional[Mapping[str, Mode]] = None,
    require_async: bool = True,
) -> Guard:
    # A mistyped mode must not quietly run the local tool.
    for value in (mode, *(modes or {}).values()):
        if value not in ("in_process", "remote"):
            raise ValueError('mode takes "in_process" or "remote"')
    guard = Guard(
        client,
        connection_id=connection_id,
        mode=mode,
        modes=modes,
        agent_name=agent_name,
        adapter_id=adapter_id,
        purpose=purpose,
        on_ask="result",
        on_deny="result",
        on_execution_failed="result",
        on_receipt=on_receipt,
        on_execution_error=on_execution_error,
        amount_args=amount_args,
    )
    if require_async and not guard._async:
        raise TypeError("use an AsyncGuardianClient: tool calls in this framework are async")
    return guard


def performed_remotely(outcome: Outcome) -> bool:
    """Whether ``outcome`` is a ``remote`` call Guardian performed (a verified receipt)."""
    info = outcome.result.get("guardian") if isinstance(outcome.result, dict) else None
    return (
        isinstance(info, dict)
        and outcome.decision == "ALLOW"
        and not outcome.ran
        and "outcome" not in info
        and "message" not in info
    )


def is_stream_function(fn: Any) -> bool:
    """Whether ``fn`` is a generator or async generator function.

    Calling one runs none of its body. :func:`decide_and_run` redeems the
    capability when the tool step returns, so an integration must only take
    that step for such a tool if the framework consumes the stream inside
    it; otherwise Guardian would record a call that never ran.
    """
    return inspect.isgeneratorfunction(fn) or inspect.isasyncgenfunction(fn)


def resolve_tool_name(tool_names: ToolNames, name: str) -> str:
    if tool_names is None:
        return name
    if callable(tool_names):
        return tool_names(name)
    return tool_names.get(name, name)


def json_record(arguments: Any) -> Dict[str, Any]:
    """The call's arguments as plain JSON values, the form Guardian decides on.

    Raises for arguments that cannot be written as JSON, so the call is
    refused rather than proposed in another form.
    """
    if hasattr(arguments, "model_dump"):
        data = arguments.model_dump(mode="json")
    elif isinstance(arguments, Mapping):
        try:
            from pydantic_core import to_jsonable_python
        except ImportError:  # pragma: no cover - both frameworks ship pydantic
            data = json.loads(json.dumps(dict(arguments)))
        else:
            data = to_jsonable_python(dict(arguments))
    else:
        raise TypeError(f"tool arguments of type {type(arguments).__name__} cannot be proposed")
    if not isinstance(data, dict):
        raise TypeError("tool arguments must be a mapping")
    canonical_json(data)  # what Guardian cannot canonicalize is never proposed
    return data


def unchecked(tool_name: str) -> Outcome:
    return Outcome(
        ran=False,
        decision="DENY",
        message=f"Guardian could not check {tool_name}, so it did not run. Try again later.",
        reason_code="SERVICE_UNAVAILABLE",
    )


def outcome_unknown(tool_name: str) -> Outcome:
    """A remote call that failed where Guardian may already have performed it."""
    return Outcome(
        ran=False,
        decision="DENY",
        message=(
            f"Guardian could not confirm what happened to {tool_name}: Guardian may have performed it. "
            "Do not call it again; check the request in Guardian."
        ),
        reason_code=EXECUTION_OUTCOME_UNKNOWN,
    )


async def decide_and_run(
    guard: Guard,
    tool_name: str,
    proposed: Dict[str, Any],
    run_tool: Callable[[], Awaitable[None]],
) -> Outcome:
    """Ask Guardian about ``tool_name(proposed)``; await ``run_tool`` after ALLOW, never before.

    The capability is redeemed when ``run_tool`` returns, so the tool must
    have run by then: a stream the tool produces has to be consumed inside
    ``run_tool`` (see :func:`is_stream_function`).
    """
    started = False

    async def body() -> Any:
        nonlocal started
        started = True
        await run_tool()
        return _RAN

    try:
        out = await guard.run(tool_name, copy.deepcopy(proposed), body)
    except Exception:
        if started:
            raise  # the tool's own error, or a hook after this one: not ours to hide
        if guard._opts.mode_for(tool_name) == "remote":
            # The tool step never starts for a remote tool, so ``started`` says
            # nothing here: the error may have come after Guardian performed
            # the call (a raising ``on_receipt``, for example). Never tell the
            # model it did not run.
            _logger.warning(
                "Guardian call for remote tool %s raised; it may have been performed", tool_name, exc_info=True
            )
            return outcome_unknown(tool_name)
        _logger.warning("Guardian check of %s failed; the call did not run", tool_name, exc_info=True)
        return unchecked(tool_name)
    if out is _RAN:
        return Outcome(ran=True, decision="ALLOW")
    info = out.get("guardian") if isinstance(out, dict) else None
    if not isinstance(info, dict):  # pragma: no cover - Guard results always carry it
        return unchecked(tool_name) if not started else Outcome(ran=True, decision="ALLOW")
    message = info.get("message")
    if message is None and not started and info.get("decision") == "ALLOW":
        # A remote tool: Guardian performed the call and the tool step never
        # started. The model gets Guardian's result in place of the tool's.
        message = json.dumps(out, sort_keys=True, default=str)
    return Outcome(
        ran=started,
        decision=str(info.get("decision")),
        message=message,
        request_id=info.get("request_id"),
        reason_code=info.get("reason_code"),
        result=out,
    )


def decide_and_run_sync(
    guard: Guard,
    tool_name: str,
    proposed: Dict[str, Any],
    run_tool: Callable[[], None],
) -> Outcome:
    """:func:`decide_and_run` for a sync :class:`Guard` (``build_guard(require_async=False)``)
    and a sync tool step. Same outcomes, case for case."""
    started = False

    def body() -> Any:
        nonlocal started
        started = True
        run_tool()
        return _RAN

    try:
        out = guard.run(tool_name, copy.deepcopy(proposed), body)
    except Exception:
        if started:
            raise
        if guard._opts.mode_for(tool_name) == "remote":
            # As in decide_and_run: Guardian may already have performed the call.
            _logger.warning(
                "Guardian call for remote tool %s raised; it may have been performed", tool_name, exc_info=True
            )
            return outcome_unknown(tool_name)
        _logger.warning("Guardian check of %s failed; the call did not run", tool_name, exc_info=True)
        return unchecked(tool_name)
    if out is _RAN:
        return Outcome(ran=True, decision="ALLOW")
    info = out.get("guardian") if isinstance(out, dict) else None
    if not isinstance(info, dict):  # pragma: no cover - Guard results always carry it
        return unchecked(tool_name) if not started else Outcome(ran=True, decision="ALLOW")
    message = info.get("message")
    if message is None and not started and info.get("decision") == "ALLOW":
        message = json.dumps(out, sort_keys=True, default=str)
    return Outcome(
        ran=started,
        decision=str(info.get("decision")),
        message=message,
        request_id=info.get("request_id"),
        reason_code=info.get("reason_code"),
        result=out,
    )
