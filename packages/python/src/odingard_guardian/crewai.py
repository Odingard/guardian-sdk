"""Guardian for crewAI: governed tools.

crewAI (``crewai`` on PyPI, Python 3.10+) runs a tool in one of two ways:
native function calling calls ``BaseTool.run``, and the text (ReAct) path
calls the tool's ``_run`` through a ``CrewStructuredTool``. Both end in
``_run``. :func:`guardian_tools` wraps each tool in a :class:`GuardianTool`
whose ``_run`` asks Guardian before it calls the tool it wraps::

    from crewai import Agent
    from crewai.tools import tool
    from odingard_guardian import GuardianClient
    from odingard_guardian.crewai import guardian_tools

    @tool("refund_order")
    def refund_order(order_id: str, amount_cents: int) -> str:
        \"\"\"Refund an order.\"\"\"
        return billing.refund(order_id, amount_cents)  # your code

    tools = guardian_tools(
        [refund_order],
        GuardianClient(credential=os.environ["GUARDIAN_AGENT_CREDENTIAL"]),
        connection_id=os.environ["GUARDIAN_CONNECTION_ID"],
        agent_name="billing-agent",
    )
    agent = Agent(role=..., goal=..., backstory=..., tools=tools)

Give the agent the wrapped tools only: a tool passed to an agent unwrapped
is not governed.

* ALLOW: the tool runs once with the arguments Guardian decided on, then
  the capability is redeemed and the decision recorded.
* ASK: the tool does not run. The result is a crewAI ``ToolFailure`` that
  tells the model the call is held for a person; after the person approves,
  the same call (same tool, same arguments) claims the approved request and
  runs.
* DENY, or Guardian unreachable: the tool does not run and the
  ``ToolFailure`` says so.

With ``mode="remote"`` (for all tools, or per tool with ``modes``) Guardian
performs the call itself: the wrapped tool's code never runs, and the model
gets Guardian's answer with the receipt.

Why a wrapper and not crewAI's tool-call hooks (``before_tool_call`` /
``after_tool_call``): a hook that raises is ignored and the tool runs, the
hook sees the arguments before the tool's schema validated them, hooks that
run later can change them, and on the text path crewAI retries a tool that
raised without running the before hook again. Hooks still run around a
governed tool; Guardian decides inside the tool, after every before hook.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextvars
import copy
import inspect
import json
import logging
import threading
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Union

from crewai.tools import BaseTool
from crewai.tools.tool_failure import ToolFailure, ToolFailureReason
from crewai.utilities.string_utils import sanitize_tool_name
from pydantic import PrivateAttr

from ._framework import ToolNames, json_record, resolve_tool_name, unchecked
from .client import AsyncGuardianClient
from .guard import Guard, GuardianExecutionFailed, Mode

__all__ = ["GuardianTool", "guardian_tool", "guardian_tools"]

_logger = logging.getLogger("odingard_guardian")


class _Ran:
    """The wrapped tool's output, so it can be told from a Guard result."""

    def __init__(self, value: Any) -> None:
        self.value = value


class _UsageLimitReached(Exception):
    """The wrapped tool's ``max_usage_count`` is spent. Nothing ran."""


class _CacheGate:
    """``cache_function`` of a governed tool.

    Only the output of a call that ran is offered to the wrapped tool's own
    ``cache_function``. A held, refused or unconfirmed call is never cached,
    so the same call reaches Guardian again.
    """

    def __init__(self, inner: Optional[Callable[..., Any]]) -> None:
        self._inner = inner

    def __call__(self, arguments: Any = None, result: Any = None) -> bool:
        if isinstance(result, ToolFailure):
            return False
        if self._inner is None:
            return True
        return bool(self._inner(arguments, result))


def _finish(value: Any) -> Any:
    """Run an async tool's coroutine to its end, as ``BaseTool.run`` does.

    crewAI calls tools synchronously. When an event loop is already running
    in this thread, the coroutine runs in a thread of its own.
    """
    if not inspect.isawaitable(value):
        return value

    async def wait() -> Any:
        return await value

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(wait())
    context = contextvars.copy_context()
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(context.run, asyncio.run, wait()).result()


def _failure(message: str, code: str, *, retryable: bool = False, **details: Any) -> ToolFailure:
    return ToolFailure(message=message, code=code, retryable=retryable, details=details)


class GuardianTool(BaseTool):
    """A crewAI tool that asks Guardian before it runs the tool it wraps.

    Build it with :func:`guardian_tool` or :func:`guardian_tools`. It has the
    wrapped tool's name, description and argument schema, so the model sees
    the same tool.

    A ``GuardianTool`` that crewAI restored from a checkpoint has no Guardian
    client and no wrapped tool: every call is refused. Wrap the tools again
    after a restore.
    """

    _inner: Optional[BaseTool] = PrivateAttr(default=None)
    _guard: Optional[Guard] = PrivateAttr(default=None)
    _guardian_name: str = PrivateAttr(default="")
    _on_approval_pending: Optional[Callable[[str, str], Any]] = PrivateAttr(default=None)
    _inner_usage_lock: Any = PrivateAttr(default_factory=threading.Lock)

    @property
    def guardian_tool_name(self) -> str:
        """The tool name Guardian decides on."""
        return self._guardian_name

    def __deepcopy__(self, memo: Optional[Dict[int, Any]] = None) -> "GuardianTool":
        # A copy keeps the same Guardian client, held requests and wrapped tool.
        return self.model_copy()

    def _bind(self, args: tuple, kwargs: Dict[str, Any]) -> Dict[str, Any]:
        """Positional arguments (a direct ``tool.run("x")``) by schema field order, validated."""
        fields = list(self.args_schema.model_fields.keys())
        if len(args) > len(fields):
            raise TypeError("too many positional arguments")
        record = dict(zip(fields, args))
        for key in kwargs:
            if key in record:
                raise TypeError(f"argument {key!r} was given twice")
        record.update(kwargs)
        return self._validate_kwargs(record)

    def _usage_limit(self) -> Optional[ToolFailure]:
        inner = self._inner
        limit = getattr(inner, "max_usage_count", None)
        if limit is None or getattr(inner, "current_usage_count", 0) < limit:
            return None
        return ToolFailure(
            message=f"Tool '{self.name}' has reached its usage limit of {limit} times and cannot be used anymore.",
            reason=ToolFailureReason.USAGE_LIMIT,
        )

    def _claim_inner_usage(self) -> None:
        """Count a run of the wrapped tool against its ``max_usage_count``."""
        with self._inner_usage_lock:
            if self._usage_limit() is not None:
                raise _UsageLimitReached()
            self._inner.current_usage_count += 1  # type: ignore[union-attr]

    def _run(self, *args: Any, **kwargs: Any) -> Any:
        guard, inner, tool_name = self._guard, self._inner, self._guardian_name
        if guard is None or inner is None:
            return _failure(
                f"{self.name} is not connected to Guardian, so it did not run. "
                "Wrap the tool again with guardian_tools().",
                "GUARDIAN_NOT_CONFIGURED",
            )
        try:
            if args:
                kwargs = self._bind(args, kwargs)
            proposed = json_record(kwargs)
            decided = copy.deepcopy(kwargs)
        except Exception:  # noqa: BLE001 - arguments Guardian cannot read never run
            return _failure(
                f"Guardian could not read the arguments of {tool_name} as JSON, so it was not "
                "proposed and did not run.",
                "ARGUMENTS_NOT_READABLE",
            )
        spent = self._usage_limit()
        if spent is not None:
            return spent  # nothing is proposed for a tool that may not run

        started = False

        def body() -> Any:
            nonlocal started
            self._claim_inner_usage()
            started = True
            # The wrapped tool's own _run, with the arguments Guardian decided
            # on: nothing validates or changes them again on the way.
            return _Ran(_finish(inner._run(**decided)))

        try:
            out = guard.run(tool_name, proposed, body)
        except _UsageLimitReached:
            return self._usage_limit() or _failure(unchecked(tool_name).message or "", "SERVICE_UNAVAILABLE")
        except Exception:
            if started:
                raise  # the tool's own error: crewAI reports it to the model
            _logger.warning("Guardian check of %s failed; the call did not run", tool_name, exc_info=True)
            return _failure(unchecked(tool_name).message or "", "SERVICE_UNAVAILABLE", retryable=True)
        if isinstance(out, _Ran):
            return out.value
        info = out.get("guardian") if isinstance(out, dict) else None
        if not isinstance(info, dict):  # pragma: no cover - Guard results always carry it
            return _failure(unchecked(tool_name).message or "", "SERVICE_UNAVAILABLE", retryable=True)
        message = info.get("message")
        if message is None:
            # Remote mode: Guardian performed the call. Its answer, with the
            # receipt, is the tool result.
            with self._inner_usage_lock:
                inner.current_usage_count += 1
            return json.dumps(out, sort_keys=True, default=str)
        decision = info.get("decision")
        if decision == "ASK":
            request_id = info.get("request_id")
            if self._on_approval_pending is not None and request_id:
                try:
                    self._on_approval_pending(tool_name, request_id)
                except Exception:  # noqa: BLE001 - the callback only observes
                    _logger.warning("on_approval_pending raised for %s", tool_name, exc_info=True)
            return _failure(message, "APPROVAL_REQUIRED", retryable=True, guardian=info)
        code = str(info.get("reason_code") or decision or "DENY")
        return _failure(message, code, retryable=code == "SERVICE_UNAVAILABLE", guardian=info)

    async def _arun(self, *args: Any, **kwargs: Any) -> Any:
        """``await tool.arun(...)``: the same governed call, in a worker thread."""
        return await asyncio.to_thread(self._run, *args, **kwargs)


def _wrap(
    tool: Any,
    guard: Guard,
    tool_names: ToolNames,
    on_approval_pending: Optional[Callable[[str, str], Any]],
) -> GuardianTool:
    if isinstance(tool, GuardianTool):
        raise TypeError(f'"{tool.name}" is already a Guardian tool')
    if not isinstance(tool, BaseTool):
        raise TypeError("guardian_tools() wraps crewAI BaseTool instances (for example a @tool function)")
    sanitized = sanitize_tool_name(tool.name)
    if isinstance(tool_names, Mapping) and tool.name in tool_names:
        guardian_name = tool_names[tool.name]
    else:
        guardian_name = resolve_tool_name(tool_names, sanitized)
    remote = guard._opts.mode_for(guardian_name) == "remote"
    wrapped = GuardianTool(
        name=tool.name,
        description=tool.description,
        env_vars=list(tool.env_vars),
        args_schema=tool.args_schema,
        # In remote mode the result is Guardian's answer, not the tool's.
        result_schema=None if remote else tool.result_schema,
        result_as_answer=tool.result_as_answer,
        tool_failure_policy=tool.tool_failure_policy,
    )
    # Set after construction: crewAI warns about every callable it cannot save
    # in a checkpoint. A restored tool gets crewAI's never-cache function.
    wrapped.cache_function = _CacheGate(getattr(tool, "cache_function", None))
    wrapped._inner = tool
    wrapped._guard = guard
    wrapped._guardian_name = guardian_name
    wrapped._on_approval_pending = on_approval_pending
    return wrapped


def guardian_tools(
    tools: Iterable[BaseTool],
    client: Any,
    *,
    connection_id: str,
    agent_name: str = "agent",
    purpose: Union[None, str, Callable[[str, Dict[str, Any]], str]] = None,
    adapter_id: Optional[str] = None,
    mode: Mode = "in_process",
    modes: Optional[Mapping[str, Mode]] = None,
    amount_args: Optional[Mapping[str, Mapping[str, Any]]] = None,
    tool_names: ToolNames = None,
    on_approval_pending: Optional[Callable[[str, str], Any]] = None,
    on_receipt: Optional[Callable[[str, str, Optional[Dict[str, Any]]], Any]] = None,
    on_execution_error: Optional[Callable[[GuardianExecutionFailed], Any]] = None,
) -> List[GuardianTool]:
    """Wrap crewAI tools so each call is sent to Guardian before the tool runs.

    :param tools: crewAI ``BaseTool`` instances (``@tool`` functions, tool
        classes). Pass the returned tools to the agent, not these.
    :param client: a :class:`GuardianClient` (the agent's credential). crewAI
        calls tools synchronously, also under ``akickoff``, so an
        :class:`AsyncGuardianClient` is refused.
    :param connection_id: the Guardian connection the tools are registered on
        (Guardian console → Connections).
    :param agent_name / purpose / adapter_id: as for :class:`Guard`.
    :param mode: ``"in_process"`` (default): the wrapped tool is the action.
        Register each tool once as "My own code (record-only)" and allow it
        for the agent. ``"remote"``: the tool name is a tool registered on the
        connection that Guardian calls itself; the wrapped tool's code never
        runs.
    :param modes: the mode per Guardian tool name, over ``mode``.
    :param amount_args: dollar amounts on tools, by Guardian tool name, exactly
        as set in the Guardian console (see :class:`Guard`).
    :param tool_names: the Guardian tool name for a crewAI tool, as a mapping
        (keyed by the tool's ``name`` or by the sanitized name the model
        calls) or a function of the sanitized name. Default: the sanitized
        name (``"Refund order"`` is ``refund_order``).
    :param on_approval_pending: ``callback(tool_name, request_id)`` when a
        call is held, so the app can show the request to a person. Errors it
        raises are ignored.
    :param on_receipt / on_execution_error: as for :class:`Guard`.
    """
    if isinstance(client, AsyncGuardianClient) or inspect.iscoroutinefunction(getattr(client, "request", None)):
        raise TypeError("use a GuardianClient (sync): crewAI calls tools synchronously")
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
    return [_wrap(tool, guard, tool_names, on_approval_pending) for tool in tools]


def guardian_tool(tool: BaseTool, client: Any, **options: Any) -> GuardianTool:
    """Wrap one crewAI tool. Options as for :func:`guardian_tools`.

    Tools wrapped together by :func:`guardian_tools` share one ``Guard``.
    """
    return guardian_tools([tool], client, **options)[0]
