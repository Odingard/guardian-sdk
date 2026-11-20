"""Shared core of the hook-style framework integrations (Agent Framework, Semantic Kernel).

A framework hands the integration one tool call at a time, with a ``next``
step that runs the tool. :func:`decide_and_run` asks Guardian and takes
that step after ALLOW, never before, through an async :class:`Guard` that hands
every decision back as data. It fails closed: anything that goes wrong
before the tool starts means the tool does not run.
"""

from __future__ import annotations

import copy
import json
import logging
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, Mapping, Optional, Union

from ._canonical import canonical_json
from .client import AsyncGuardianClient
from .guard import Guard, GuardianExecutionFailed

_logger = logging.getLogger("odingard_guardian")

#: Returned by the tool step so a Guard result can be told from a tool output.
_RAN = object()

ToolNames = Union[None, Mapping[str, str], Callable[[str], str]]


@dataclass(frozen=True)
class Outcome:
    """What happened to one governed call.

    ``ran`` is True once the tool step started. ``message`` is what the
    model should be told instead of the tool's own result (``None`` when
    the tool ran and Guardian recorded it). ``result`` is Guardian's own
    answer for a remote tool it performed (``None`` otherwise).
    """

    ran: bool
    decision: str
    message: Optional[str] = None
    request_id: Optional[str] = None
    reason_code: Optional[str] = None
    result: Optional[Dict[str, Any]] = None


def build_guard(
    client: AsyncGuardianClient,
    *,
    connection_id: str,
    agent_name: str,
    adapter_id: Optional[str],
    purpose: Any,
    amount_args: Optional[Mapping[str, Mapping[str, Any]]],
    on_receipt: Optional[Callable[..., Any]],
    on_execution_error: Optional[Callable[[GuardianExecutionFailed], Any]],
    mode: str = "in_process",
    modes: Optional[Mapping[str, str]] = None,
) -> Guard:
    if mode not in ("in_process", "remote") or any(m not in ("in_process", "remote") for m in (modes or {}).values()):
        raise ValueError('mode takes "in_process" or "remote"')
    guard = Guard(
        client,
        connection_id=connection_id,
        mode=mode,  # type: ignore[arg-type]
        modes=modes,  # type: ignore[arg-type]
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
    if not guard._async:
        raise TypeError("use an AsyncGuardianClient: tool calls in this framework are async")
    return guard


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


async def decide_and_run(
    guard: Guard,
    tool_name: str,
    proposed: Dict[str, Any],
    run_tool: Callable[[], Awaitable[None]],
) -> Outcome:
    """Ask Guardian about ``tool_name(proposed)``; await ``run_tool`` after ALLOW, never before."""
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
        _logger.warning("Guardian check of %s failed; the call did not run", tool_name, exc_info=True)
        return unchecked(tool_name)
    if out is _RAN:
        return Outcome(ran=True, decision="ALLOW")
    info = out.get("guardian") if isinstance(out, dict) else None
    if not isinstance(info, dict):  # pragma: no cover - Guard results always carry it
        return unchecked(tool_name) if not started else Outcome(ran=True, decision="ALLOW")
    return Outcome(
        ran=started,
        decision=str(info.get("decision")),
        message=info.get("message"),
        request_id=info.get("request_id"),
        reason_code=info.get("reason_code"),
        # A remote tool Guardian performed: its answer stands in for the tool's.
        result=out if not started and info.get("decision") == "ALLOW" and info.get("message") is None else None,
    )
