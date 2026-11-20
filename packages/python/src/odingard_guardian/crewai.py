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
  tells the model the call is held for a person. With a ``scope`` (the
  session the call belongs to, from your application), the same call (same
  tool, same arguments) in the same session claims the approved request and
  runs. Without one, no later call claims it: crewAI gives a tool nothing
  that names the user or conversation.
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

from crewai.execution import get_execution_uuid
from crewai.tools import BaseTool
from crewai.tools.tool_failure import ToolFailure, ToolFailureReason
from crewai.utilities.string_utils import sanitize_tool_name
from pydantic import PrivateAttr

from ._framework import (
    ToolNames,
    is_stream_function,
    json_record,
    outcome_unknown,
    resolve_scope,
    resolve_tool_name,
    unchecked,
)
from .client import AsyncGuardianClient
from .guard import (
    EXECUTION_OUTCOME_UNKNOWN,
    SCOPE_UNKNOWN,
    Guard,
    GuardianExecutionFailed,
    Mode,
    execution_failed_message,
)

__all__ = ["GuardianTool", "guardian_tool", "guardian_tools", "kickoff_scope"]

#: Sessions whose usage count is kept per wrapped tool at one time. Only
#: counts above zero are kept, and none is ever dropped to make room: when the
#: table is full, a call from a further session is refused.
_MAX_COUNTED_SCOPES = 4096


def kickoff_scope(_tool: Any = None) -> Optional[str]:
    """A ``scope`` option: one crewAI kickoff is one session.

    The scope is crewAI's execution id, which crewAI (or the host, with
    ``crewai.execution.set_execution_uuid``) sets for the outermost crew or
    flow run; the model cannot write it. A held call is then claimed by the
    same call later in the same kickoff only. Use it only where one kickoff
    serves one user: a flow that runs crews for several users is one
    execution. ``None`` outside a kickoff (no session is known).
    """
    return get_execution_uuid()

_logger = logging.getLogger("odingard_guardian")


class _Ran:
    """The wrapped tool's output, so it can be told from a Guard result."""

    def __init__(self, value: Any) -> None:
        self.value = value


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
    _scope: Optional[Callable[[Any], Any]] = PrivateAttr(default=None)
    #: Calls counted against the wrapped tool's ``max_usage_count`` since
    #: crewAI last reset this tool, by scope (session): calls in flight, and
    #: calls that ran. One session cannot spend or reset another's budget.
    _used: Any = PrivateAttr(default_factory=dict)
    _usage_lock: Any = PrivateAttr(default_factory=threading.Lock)

    @property
    def guardian_tool_name(self) -> str:
        """The tool name Guardian decides on."""
        return self._guardian_name

    def __deepcopy__(self, memo: Optional[Dict[int, Any]] = None) -> "GuardianTool":
        # A copy keeps the same Guardian client, held requests and wrapped tool.
        return self.model_copy()

    def __setattr__(self, name: str, value: Any) -> None:
        super().__setattr__(name, value)
        if name == "current_usage_count" and value == 0:
            # crewAI resets a tool's count when it prepares the tool for a task
            # (and in reset_usage_count()): the budget starts again.
            # Only for the session crewAI is preparing it in.
            scope = self._scope_now()
            with self._usage_lock:
                self._used.pop(scope, None)

    def _scope_now(self) -> Any:
        """The session of the call being made: the app's ``scope`` option, else unknown.

        Never read from the call's arguments, which the model writes.
        """
        return resolve_scope(self._scope, self, SCOPE_UNKNOWN)

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

    def _reserve_use(self, scope: Any) -> Optional[ToolFailure]:
        """Take one use of the wrapped tool's ``max_usage_count``, or say it is spent.

        Taken before Guardian is asked, in one step with the check, so calls
        that run at the same time cannot pass the limit together. A call that
        ends without the action having happened gives its use back.
        """
        limit = getattr(self._inner, "max_usage_count", None)
        if limit is None:
            return None
        with self._usage_lock:
            used = self._used.get(scope, 0)
            if used >= limit:
                return ToolFailure(
                    message=(
                        f"Tool '{self.name}' has reached its usage limit of {limit} times "
                        "and cannot be used anymore."
                    ),
                    reason=ToolFailureReason.USAGE_LIMIT,
                )
            if used == 0 and len(self._used) >= _MAX_COUNTED_SCOPES:
                # Every entry is a spent or in-flight budget of another
                # session. Forgetting one would let that session pass its
                # limit, so this call is refused instead.
                return ToolFailure(
                    message=(
                        f"Tool '{self.name}' did not run: its usage limit is counted for too many "
                        "sessions at once. Do not call it again; tell the user."
                    ),
                    reason=ToolFailureReason.USAGE_LIMIT,
                    code="USAGE_TABLE_FULL",
                )
            self._used[scope] = used + 1
            return None

    def reset_usage(self, scope: Any) -> None:
        """Start the usage budget of one session again, by its scope.

        ``reset_usage_count()`` does this for the session it is called in.
        Use this for a session that will not come back (a finished kickoff
        under :func:`kickoff_scope`, a user who signed out), so that its
        count no longer takes a place.
        """
        try:
            with self._usage_lock:
                self._used.pop(scope, None)
        except TypeError:  # a value that cannot be hashed names no session
            pass

    def _release_use(self, scope: Any) -> None:
        with self._usage_lock:
            used = self._used.get(scope, 0)
            if used <= 1:
                self._used.pop(scope, None)
            else:
                self._used[scope] = used - 1

    def _report_unconfirmed(self, tool_name: str) -> ToolFailure:
        """The tool ran, and what Guardian did afterwards is not known."""
        err = GuardianExecutionFailed(
            tool_name, "", EXECUTION_OUTCOME_UNKNOWN, local_effect_ran=True, outcome_unknown=True
        )
        hook = self._guard._on_execution_error if self._guard is not None else None
        if hook is not None:
            try:
                hook(err)
            except Exception:  # noqa: BLE001 - the hook only observes
                pass
        return _failure(execution_failed_message(err), EXECUTION_OUTCOME_UNKNOWN)

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
        scope = self._scope_now()
        spent = self._reserve_use(scope)
        if spent is not None:
            return spent  # nothing is proposed for a tool that may not run
        used = False  # whether this call keeps its use: the action happened, or may have
        try:
            result, used = self._governed(guard, inner, tool_name, proposed, decided, scope)
            return result
        except BaseException:
            used = True  # only the wrapped tool's own error leaves _governed
            raise
        finally:
            if not used and getattr(inner, "max_usage_count", None) is not None:
                self._release_use(scope)

    def _governed(
        self,
        guard: Guard,
        inner: BaseTool,
        tool_name: str,
        proposed: Dict[str, Any],
        decided: Dict[str, Any],
        scope: Any,
    ) -> Any:
        """One governed call: ``(tool result, whether the action happened or may have)``."""
        remote = guard._opts.mode_for(tool_name) == "remote"
        started = finished = False

        def body() -> Any:
            nonlocal started, finished
            started = True
            # The wrapped tool's own _run, with the arguments Guardian decided
            # on: nothing validates or changes them again on the way.
            value = _Ran(_finish(inner._run(**decided)))
            finished = True
            return value

        try:
            out = guard.run(tool_name, proposed, body, scope=scope)
        except Exception:
            if finished:
                # The tool ran to its end and the error came afterwards, while
                # Guardian was recording it. Raising would make crewAI report a
                # tool error, and on the text path call the tool again.
                _logger.warning("Guardian could not confirm the record of %s; it ran", tool_name, exc_info=True)
                return self._report_unconfirmed(tool_name), True
            if started:
                raise  # the tool's own error: crewAI reports it to the model
            if remote:
                # The wrapped tool never starts for a remote tool, so the error
                # may have come after Guardian performed the call. Never tell
                # the model it did not run.
                _logger.warning(
                    "Guardian call for remote tool %s raised; it may have been performed", tool_name, exc_info=True
                )
                unknown = outcome_unknown(tool_name)
                return _failure(unknown.message or "", unknown.reason_code or EXECUTION_OUTCOME_UNKNOWN), True
            _logger.warning("Guardian check of %s failed; the call did not run", tool_name, exc_info=True)
            return _failure(unchecked(tool_name).message or "", "SERVICE_UNAVAILABLE", retryable=True), False
        if isinstance(out, _Ran):
            return out.value, True
        info = out.get("guardian") if isinstance(out, dict) else None
        if not isinstance(info, dict):  # pragma: no cover - Guard results always carry it
            if started or remote:
                return _failure(outcome_unknown(tool_name).message or "", EXECUTION_OUTCOME_UNKNOWN), True
            return _failure(unchecked(tool_name).message or "", "SERVICE_UNAVAILABLE", retryable=True), False
        message = info.get("message")
        decision = info.get("decision")
        if message is None:
            # Remote mode: Guardian performed the call. Its answer, with the
            # receipt, is the tool result.
            return json.dumps(out, sort_keys=True, default=str), True
        if decision == "ASK":
            request_id = info.get("request_id")
            if self._on_approval_pending is not None and request_id:
                try:
                    self._on_approval_pending(tool_name, request_id)
                except Exception:  # noqa: BLE001 - the callback only observes
                    _logger.warning("on_approval_pending raised for %s", tool_name, exc_info=True)
            return _failure(message, "APPROVAL_REQUIRED", retryable=True, guardian=info), False
        code = str(info.get("reason_code") or decision or "DENY")
        if decision != "DENY":
            # Allowed, then it ran or may have run but could not be confirmed:
            # never retryable, whatever the reason code. Only a file check that
            # refused before the tool started ("not_run") gives the use back.
            return _failure(message, code, guardian=info), info.get("outcome") != "not_run"
        return _failure(message, code, retryable=code == "SERVICE_UNAVAILABLE", guardian=info), False

    async def _arun(self, *args: Any, **kwargs: Any) -> Any:
        """``await tool.arun(...)``: the same governed call, in a worker thread."""
        return await asyncio.to_thread(self._run, *args, **kwargs)


def _wrap(
    tool: Any,
    guard: Guard,
    tool_names: ToolNames,
    on_approval_pending: Optional[Callable[[str, str], Any]],
    scope: Optional[Callable[[Any], Any]],
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
    if not remote and (is_stream_function(tool._run) or is_stream_function(getattr(tool, "func", None))):
        # Calling a generator function runs none of its body, and crewAI does
        # not consume the stream: Guardian would record a call that never ran.
        raise TypeError(
            f'"{tool.name}" is a generator function. crewAI does not consume a tool\'s stream, so its '
            "body would never run; return the result instead."
        )
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
    wrapped._scope = scope
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
    scope: Any = None,
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
    :param modes: the mode per Guardian tool name, over ``mode``. A mode
        other than these two raises ``ValueError``.

    A tool whose function is a generator function is refused (``TypeError``)
    in in-process mode: crewAI does not consume a tool's stream, so the body
    would never run.
    :param amount_args: dollar amounts on tools, by Guardian tool name, exactly
        as set in the Guardian console (see :class:`Guard`).
    :param tool_names: the Guardian tool name for a crewAI tool, as a mapping
        (keyed by the tool's ``name`` or by the sanitized name the model
        calls) or a function of the sanitized name. Default: the sanitized
        name (``"Refund order"`` is ``refund_order``).
    :param scope: the session a call belongs to, so that a held call is
        claimed only by the same call in the same session. Either a value for
        everything these wrapped tools do (wrap the tools once per user or
        conversation), or ``callback(tool)`` called for each call, for example
        ``lambda tool: current_user.get()`` with a ``ContextVar`` your app
        sets, or :func:`kickoff_scope`. It must come from data your
        application sets, never from the tool call's arguments or anything
        else the model writes. Default: no session is known
        (``SCOPE_UNKNOWN``), because crewAI gives a tool nothing that names
        the user or conversation: a held call is then never claimed by a later
        call, and every call proposes its own request. ``None``, an empty
        string, a value that cannot be hashed and a callback that raises mean
        the same. The wrapped tool's ``max_usage_count`` is counted per scope.
    :param on_approval_pending: ``callback(tool_name, request_id)`` when a
        call is held, so the app can show the request to a person. Errors it
        raises are ignored.
    :param on_receipt / on_execution_error: as for :class:`Guard`. Errors
        ``on_receipt`` raises are logged and ignored: the call is recorded by
        then.
    """
    if isinstance(client, AsyncGuardianClient) or inspect.iscoroutinefunction(getattr(client, "request", None)):
        raise TypeError("use a GuardianClient (sync): crewAI calls tools synchronously")
    # A mistyped mode must not quietly run the local tool.
    for value in (mode, *(modes or {}).values()):
        if value not in ("in_process", "remote"):
            raise ValueError('mode takes "in_process" or "remote"')

    def receipt_recorded(tool_name: str, request_id: str, receipt: Optional[Dict[str, Any]]) -> None:
        # The call ran (or Guardian performed it) and is recorded by now. An
        # error in the app's callback must not turn that into a tool error:
        # crewAI would tell the model the call failed, and may call it again.
        try:
            on_receipt(tool_name, request_id, receipt)  # type: ignore[misc]
        except Exception:  # noqa: BLE001 - the callback only observes
            _logger.warning("on_receipt raised for %s (request %s)", tool_name, request_id, exc_info=True)

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
        on_receipt=receipt_recorded if on_receipt is not None else None,
        on_execution_error=on_execution_error,
        amount_args=amount_args,
    )
    if scope is None or callable(scope):
        scope_option = scope
    else:
        fixed = scope

        def scope_option(_tool: Any) -> Any:
            return fixed

    return [_wrap(tool, guard, tool_names, on_approval_pending, scope_option) for tool in tools]


def guardian_tool(tool: BaseTool, client: Any, **options: Any) -> GuardianTool:
    """Wrap one crewAI tool. Options as for :func:`guardian_tools`.

    Tools wrapped together by :func:`guardian_tools` share one ``Guard``.
    """
    return guardian_tools([tool], client, **options)[0]
