"""Guardian for LangChain and LangGraph: governed tools, tool-call middleware, interrupts.

LangChain (``langchain`` 1.x, ``langchain-core``) and LangGraph run the tools
a model asks for. This module asks Guardian about each of those calls before
the tool runs. There are three ways to put it in place; all share one
:class:`GuardianGate`::

    from langchain.agents import create_agent
    from odingard_guardian import GuardianClient
    from odingard_guardian.langchain import GuardianMiddleware, guardian_tools

    client = GuardianClient(credential=os.environ["GUARDIAN_AGENT_CREDENTIAL"])
    connection = os.environ["GUARDIAN_CONNECTION_ID"]

    # 1. Governed tools: works with bind_tools, ToolNode, create_agent, any graph.
    tools = guardian_tools([refund_order], client, connection_id=connection)
    agent = create_agent(model, tools)

    # 2. Agent middleware (langchain.agents.create_agent): every tool call of the agent.
    agent = create_agent(
        model, [refund_order], middleware=[GuardianMiddleware(client, connection_id=connection)]
    )

    # 3. LangGraph's ToolNode hook.
    gate = GuardianGate(client, connection_id=connection)
    node = ToolNode([refund_order], wrap_tool_call=gate.wrap_tool_call, awrap_tool_call=gate.awrap_tool_call)

* ALLOW: the tool runs once with the arguments Guardian decided on, then
  the capability is redeemed and the decision recorded.
* ASK: the tool does not run. With ``on_ask="result"`` (default) the model
  is told the call is held; after a person approves, the same call (same
  tool, same arguments) claims the approved request and runs. With
  ``on_ask="interrupt"`` the graph pauses (LangGraph ``interrupt``) with the
  Guardian ``request_id`` in the interrupt payload; resuming the graph
  claims the request, and the tool runs only if Guardian says a person
  approved it. The resume value is never read as an approval.
* DENY, or Guardian unreachable: the tool does not run and the model is
  told so.

The decision is taken inside the tool invocation, on the arguments as the
tool's schema validated them, and the wrapped tool then runs with exactly
those: its own ``_run`` / ``_arun`` is called directly, so they are not
parsed a second time. Arguments the framework fills in (graph state, the
store, the tool runtime, the tool call id) are not proposed and reach the
tool unchanged; an argument the app injects (``InjectedToolArg``) is decided
on like any other.

``mode="remote"`` (or ``modes={"tool": "remote"}``) is for a tool registered
in the Guardian connection that Guardian performs itself: the local tool
body never runs and the model gets Guardian's result, with its receipt.
"""

from __future__ import annotations

import asyncio
import copy
import functools
import inspect
import threading
import weakref
from typing import (
    Annotated,
    Any,
    Awaitable,
    Callable,
    Dict,
    FrozenSet,
    List,
    Literal,
    Mapping,
    Optional,
    Sequence,
    Tuple,
    Union,
    get_args,
    get_origin,
    get_type_hints,
)

from langchain_core.messages import ToolMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import BaseTool, InjectedToolCallId
from langchain_core.tools.base import get_all_basemodel_annotations
from langchain_core.tools.simple import Tool as _SimpleTool
from pydantic import PrivateAttr

from ._framework import (
    Outcome,
    ToolNames,
    build_guard,
    decide_and_run,
    decide_and_run_sync,
    is_stream_function,
    json_record,
    performed_remotely,
    resolve_tool_name,
)
from .client import AsyncGuardianClient, GuardianClient
from .guard import GuardianExecutionFailed, Mode

try:  # LangGraph is needed for on_ask="interrupt" only.
    from langgraph.errors import GraphBubbleUp as _GraphBubbleUp
    from langgraph.types import interrupt as _interrupt
except ImportError:  # pragma: no cover - exercised without langgraph installed
    _interrupt = None

    class _GraphBubbleUp(Exception):  # type: ignore[no-redef]
        pass


try:
    from langgraph._internal._constants import CONFIG_KEY_SCRATCHPAD as _SCRATCHPAD
except ImportError:  # pragma: no cover - another langgraph layout
    _SCRATCHPAD = "__pregel_scratchpad"

try:  # Arguments LangGraph fills in itself.
    from langgraph.prebuilt import InjectedState, InjectedStore, ToolRuntime

    _FILLED_MARKERS: Tuple[type, ...] = (InjectedToolCallId, InjectedState, InjectedStore)
    _FILLED_TYPES: Tuple[type, ...] = (ToolRuntime,)
except ImportError:  # pragma: no cover - exercised without langgraph installed
    _FILLED_MARKERS = (InjectedToolCallId,)
    _FILLED_TYPES = ()

try:  # The agent middleware needs the `langchain` package (1.x).
    from langchain.agents.middleware import AgentMiddleware as _AgentMiddleware
except ImportError:  # pragma: no cover - exercised without langchain installed
    _AgentMiddleware = None

try:
    from langchain_core.tools.base import _get_runnable_config_param
except ImportError:  # pragma: no cover - older langchain-core

    def _get_runnable_config_param(func: Callable[..., Any]) -> Optional[str]:
        return "config" if "config" in inspect.signature(func).parameters else None


__all__ = [
    "GuardianGate",
    "GuardianMiddleware",
    "GuardianTool",
    "INTERRUPT_TYPE",
    "guardian_tool",
    "guardian_tools",
]

OnAsk = Literal["result", "interrupt"]

#: ``type`` of the interrupt payload of a held call.
INTERRUPT_TYPE = "guardian_approval"

#: Carries the tool call id from input parsing to the tool step.
_CALL_ID = "__guardian_tool_call_id__"

#: A paused call claims its request once per resume value LangGraph replays.
_MAX_RESUMES = 256


class _NotRun(Exception):
    """A call that was stopped before its effect: the graph is pausing."""


class _Step:
    """One execution of one LangGraph task, shared by the governed calls in it.

    LangGraph runs an interrupted task again from its start. So a governed
    call may pause the task only while no governed call in it has started
    its effect, and once one pauses, no other starts. The lock makes the two
    checks one step.
    """

    __slots__ = ("scratchpad", "lock", "effects", "paused", "__weakref__")

    def __init__(self, scratchpad: Any = None) -> None:
        self.scratchpad = scratchpad
        self.lock = threading.Lock()
        self.effects: set = set()
        self.paused = False


#: The record of a task execution lives as long as LangGraph's own record of
#: it (its scratchpad). The scratchpad takes no weak reference, so the record
#: hangs off a function object the scratchpad owns.
_STEPS: "weakref.WeakKeyDictionary[Any, _Step]" = weakref.WeakKeyDictionary()
#: Used only if a LangGraph version has no such object: by scratchpad id,
#: holding the scratchpad so the id stays its own, oldest dropped first.
_STEPS_BY_ID: Dict[int, _Step] = {}
_STEPS_LOCK = threading.Lock()
#: Interrupt positions a paused call owns, by (thread, task, tool call id).
_PAUSES: Dict[Tuple[Any, Any, Any], Tuple[Dict[str, Any], int]] = {}


def _step_of(config: Any) -> Optional[_Step]:
    """The running task execution, or ``None`` outside a LangGraph run."""
    conf = config.get("configurable") if isinstance(config, Mapping) else None
    scratchpad = conf.get(_SCRATCHPAD) if isinstance(conf, Mapping) else None
    if scratchpad is None:
        return None
    anchor = getattr(scratchpad, "get_null_resume", None)
    with _STEPS_LOCK:
        if inspect.isfunction(anchor):
            step = _STEPS.get(anchor)
            if step is None:
                step = _STEPS[anchor] = _Step()
            return step
        step = _STEPS_BY_ID.get(id(scratchpad))
        if step is None or step.scratchpad is not scratchpad:
            while len(_STEPS_BY_ID) >= 4096:
                del _STEPS_BY_ID[next(iter(_STEPS_BY_ID))]
            step = _STEPS_BY_ID[id(scratchpad)] = _Step(scratchpad)
        return step


class _Call:
    """One governed call inside a LangGraph task: when it may pause and when it may act."""

    def __init__(self, gate: "GuardianGate", config: Any, call_id: Any) -> None:
        self.gate = gate
        self.step = _step_of(config)
        conf = config.get("configurable") if isinstance(config, Mapping) else None
        self.key = (
            (conf.get("thread_id"), conf.get("checkpoint_ns"), call_id)
            if self.step is not None and isinstance(conf, Mapping) and call_id is not None
            else None
        )
        self.positions = 0

    def pause(self, payload: Dict[str, Any]) -> bool:
        """Pause the graph (raises LangGraph's interrupt). Returns True when the
        pause was already answered by a resume, False when the graph cannot be
        paused: not asked for, no graph, or a call of this task already acted."""
        step = self.step
        if self.gate._on_ask != "interrupt" or _interrupt is None or step is None:
            return False
        with step.lock:
            if step.effects:
                return False  # pausing now would run those calls a second time
            self.positions += 1
            try:
                _interrupt(payload)  # the resume value is not an approval and is not read
            except _GraphBubbleUp:
                step.paused = True
                if self.key is not None:
                    if len(_PAUSES) >= 4096:
                        _PAUSES.clear()
                    _PAUSES[self.key] = (payload, self.positions)
                raise
            except (RuntimeError, KeyError, AssertionError):
                return False  # not inside a LangGraph run
        return True

    def replay(self) -> None:
        """Take back the interrupt positions this call paused at in earlier runs
        of the task, so a tool's own ``interrupt()`` is not answered with them."""
        owned = _PAUSES.get(self.key) if self.key is not None else None
        if owned is not None:
            payload, positions = owned
            while self.positions < positions and self.pause(payload):
                pass

    def acting(self) -> None:
        """The call's effect is about to start. Raises when the task is pausing."""
        step = self.step
        if step is None:
            return
        with step.lock:
            if step.paused:
                raise _NotRun()
            step.effects.add(self)  # the call itself: an id could be reused

    def did_not_act(self) -> None:
        if self.step is not None:
            with self.step.lock:
                self.step.effects.discard(self)

    def interrupted(self) -> None:
        """An interrupt left the call (the tool's own): the task will run again."""
        if self.step is not None:
            with self.step.lock:
                self.step.paused = True

    def finished(self) -> None:
        if self.key is not None:
            _PAUSES.pop(self.key, None)


class _ThreadedClient:
    """An async view of a sync client: each Guardian call runs in a worker thread."""

    def __init__(self, client: Any) -> None:
        self._client = client

    async def request(self, invocation: Mapping[str, Any]) -> Any:
        return await asyncio.to_thread(self._client.request, invocation)

    async def claim(self, request_id: str) -> Any:
        return await asyncio.to_thread(self._client.claim, request_id)

    async def execute(self, *, request_id: str, capability_token: str) -> Any:
        return await asyncio.to_thread(
            functools.partial(self._client.execute, request_id=request_id, capability_token=capability_token)
        )

    async def receipts(self, request_id: str) -> Any:
        return await asyncio.to_thread(self._client.receipts, request_id)

    def __repr__(self) -> str:
        return f"_ThreadedClient({self._client!r})"


def _signature_stub(fn: Callable[..., Any]) -> Callable[..., Any]:
    """A function with ``fn``'s signature and annotations that cannot be called.

    LangGraph reads a tool's ``func`` / ``coroutine`` annotations to find the
    arguments it injects. The governed tool shows it this stub, never the
    wrapped function itself.
    """

    @functools.wraps(fn)
    def stub(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("call a Guardian-governed tool through invoke() or ainvoke()")

    return stub


def _filled_by_framework(hint: Any) -> bool:
    """True for an annotation of an argument LangChain or LangGraph fills in:
    the tool call id, graph state, the store, the tool runtime."""
    origin = get_origin(hint)
    if origin is Annotated:
        base, *metadata = get_args(hint)
        for marker in metadata:
            if isinstance(marker, _FILLED_MARKERS) or (isinstance(marker, type) and issubclass(marker, _FILLED_MARKERS)):
                return True
        return _filled_by_framework(base)
    if origin is Union or (origin is not None and getattr(origin, "__name__", "") == "UnionType"):
        return any(_filled_by_framework(arg) for arg in get_args(hint))
    base = origin or hint
    return isinstance(base, type) and bool(_FILLED_TYPES) and issubclass(base, _FILLED_TYPES)


def _framework_filled(tool: BaseTool) -> FrozenSet[str]:
    """Names of the arguments of ``tool`` that the framework fills in.

    Anything that cannot be read leaves the argument out of this set, so it
    is proposed to Guardian like any other argument.
    """
    hints: Dict[str, Any] = {}
    for fn in (getattr(tool, "func", None), getattr(tool, "coroutine", None), tool._run):
        if callable(fn):
            try:
                hints.update(get_type_hints(fn, include_extras=True))
            except Exception:  # noqa: BLE001
                pass
    try:
        hints.update(get_all_basemodel_annotations(tool.get_input_schema()))
    except Exception:  # noqa: BLE001
        pass
    filled = set()
    for name, hint in hints.items():
        try:
            if _filled_by_framework(hint):
                filled.add(name)
        except Exception:  # noqa: BLE001
            pass
    return frozenset(filled)


class GuardianGate:
    """Asks Guardian about LangChain tool calls before they run.

    :param client: a :class:`GuardianClient` or an :class:`AsyncGuardianClient`
        (the agent's credential). With a :class:`GuardianClient`, sync calls
        (``invoke``) use it directly and async calls (``ainvoke``) make each
        Guardian call in a worker thread. An :class:`AsyncGuardianClient`
        serves async calls only: a sync call is refused before anything runs.
    :param connection_id: the Guardian connection the tools are registered on
        (Guardian console → Connections).
    :param mode: ``"in_process"`` (default): the wrapped tool is the action;
        register it once in the console as "My own code (record-only)".
        ``"remote"``: a tool registered in the connection that Guardian
        performs itself; the wrapped tool's body never runs.
    :param modes: the mode per Guardian tool name, over ``mode``.
    :param agent_name / purpose / adapter_id: as for :class:`Guard`.
    :param amount_args: dollar amounts on tools, by Guardian tool name, exactly
        as set in the Guardian console (see :class:`Guard`).
    :param tool_names: the Guardian tool name for a LangChain tool name, as a
        mapping or a function. Default: the same name.
    :param on_ask: ``"result"`` (default) tells the model the call is held;
        ``"interrupt"`` pauses the graph with LangGraph's ``interrupt`` (the
        graph needs a checkpointer). Outside a LangGraph run there is nothing
        to pause, so a held call answers as with ``"result"``.
    :param on_approval_pending: ``callback(tool_name, request_id)`` when a
        call is held, once per request, so the app can show it to a person.
    :param on_receipt / on_execution_error: as for :class:`Guard`.
    """

    def __init__(
        self,
        client: Union[GuardianClient, AsyncGuardianClient],
        *,
        connection_id: str,
        mode: Mode = "in_process",
        modes: Optional[Mapping[str, Mode]] = None,
        agent_name: str = "agent",
        purpose: Union[None, str, Callable[[str, Dict[str, Any]], str]] = None,
        adapter_id: Optional[str] = None,
        amount_args: Optional[Mapping[str, Mapping[str, Any]]] = None,
        tool_names: ToolNames = None,
        on_ask: OnAsk = "result",
        on_approval_pending: Optional[Callable[[str, str], Any]] = None,
        on_receipt: Optional[Callable[[str, str, Optional[Dict[str, Any]]], Any]] = None,
        on_execution_error: Optional[Callable[[GuardianExecutionFailed], Any]] = None,
    ) -> None:
        if on_ask not in ("result", "interrupt"):
            raise ValueError('on_ask takes "result" or "interrupt"')
        if on_ask == "interrupt" and _interrupt is None:
            raise ImportError('on_ask="interrupt" needs langgraph: pip install "odingard-guardian[langchain]"')

        def build(guardian_client: Any) -> Any:
            return build_guard(
                guardian_client,
                connection_id=connection_id,
                agent_name=agent_name,
                adapter_id=adapter_id,
                purpose=purpose,
                amount_args=amount_args,
                on_receipt=on_receipt,
                on_execution_error=on_execution_error,
                mode=mode,
                modes=modes,
                require_async=False,
            )

        first = build(client)
        if first._async:
            self._guard = None
            self._aguard = first
        else:
            self._guard = first
            self._aguard = build(_ThreadedClient(client))
            # One memory of held requests for both: a call held on the sync
            # path is claimed, not proposed again, when it comes back async.
            self._aguard._opts = first._opts
            self._aguard._ensured = first._ensured
        self._tool_names = tool_names
        self._on_ask = on_ask
        self._on_approval_pending = on_approval_pending
        self._sync_only_plain = {
            "on_approval_pending": (on_approval_pending, "nobody would be told about a held call"),
            "on_receipt": (on_receipt, "the receipt would never reach it"),
            "on_execution_error": (
                on_execution_error,
                "nobody would be told about a call that ran but could not be recorded",
            ),
        }
        self._notified: Dict[str, None] = {}
        self._governed: Dict[int, Tuple[BaseTool, "GuardianTool"]] = {}

    # --- governed tools ------------------------------------------------------

    def tool(self, tool: BaseTool) -> "GuardianTool":
        """``tool`` behind Guardian: same name, description and schema for the model."""
        if isinstance(tool, GuardianTool):
            if tool._gate is not self:
                # Passing it through would skip this gate's decision; unwrapping
                # it would skip the other gate's. Neither is skipped.
                raise TypeError(
                    f'"{tool.name}" is already behind another GuardianGate. Give this gate the original tool, '
                    "or use one GuardianGate for both."
                )
            return tool
        if not isinstance(tool, BaseTool):
            raise TypeError(f"expected a LangChain BaseTool, got {type(tool).__name__}")
        cached = self._governed.get(id(tool))
        if cached is not None and cached[0] is tool:
            return cached[1]
        governed = _govern(tool, self)
        if len(self._governed) >= 1024:
            self._governed.clear()
        self._governed[id(tool)] = (tool, governed)
        return governed

    def tools(self, tools: Sequence[BaseTool]) -> List["GuardianTool"]:
        """:meth:`tool` over a list, in order."""
        return [self.tool(tool) for tool in tools]

    # --- tool-call hooks (AgentMiddleware.wrap_tool_call, ToolNode(wrap_tool_call=...)) ---

    def _swap(self, request: Any) -> Any:
        """The request with its tool behind Guardian, or the refusal to answer with."""
        call = request.tool_call
        name = str(call.get("name"))
        if request.tool is None:
            return _refused(
                name,
                call.get("id"),
                f"{name} is not a tool Guardian's hook was given, so Guardian did not check it and it did not run.",
                "TOOL_NOT_REGISTERED",
            )
        try:
            governed = self.tool(request.tool)
        except Exception as err:  # noqa: BLE001 - a tool that cannot be governed never runs
            return _refused(name, call.get("id"), f"{name} did not run: {err}", "TOOL_NOT_SUPPORTED")
        return request.override(tool=governed)

    def wrap_tool_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        """Sync tool-call hook: puts the request's tool behind Guardian, then runs the handler."""
        swapped = self._swap(request)
        return swapped if isinstance(swapped, ToolMessage) else handler(swapped)

    async def awrap_tool_call(self, request: Any, handler: Callable[[Any], Awaitable[Any]]) -> Any:
        """Async tool-call hook."""
        swapped = self._swap(request)
        return swapped if isinstance(swapped, ToolMessage) else await handler(swapped)

    # --- one governed call ---------------------------------------------------

    def _prepare(self, tool: "GuardianTool", args: tuple, kwargs: Dict[str, Any]) -> Tuple[str, Any, Any, Any]:
        """``(guardian name, proposal, decided arguments, injected arguments)``.

        The proposal is the validated arguments as JSON values. Raises for
        arguments that cannot be written as JSON or copied.
        """
        name = resolve_tool_name(self._tool_names, tool.name)
        if args:
            if len(args) != 1 or kwargs:
                raise TypeError("a tool with several positional arguments cannot be proposed")
            # A single-input tool: proposed under the argument name its schema
            # gives the model ("input" only when there is no such name). The
            # tool still gets the value the way it gets it unwrapped.
            try:
                fields = list(tool._inner.args)
            except Exception:  # noqa: BLE001
                fields = []
            key = fields[0] if len(fields) == 1 else "input"
            return name, json_record({key: args[0]}), copy.deepcopy(args), None
        visible = dict(tool._inner._filter_injected_args(kwargs))
        injected = {}
        for key, value in kwargs.items():
            if key in visible:
                continue
            if key in tool._filled or key in ("run_manager", "callbacks"):
                injected[key] = value  # filled in by the framework, not by the model
            else:
                # An argument the app injects (InjectedToolArg) is part of the
                # action: it is decided on like any other.
                visible[key] = value
        return name, json_record(visible), copy.deepcopy(visible), injected

    def _payload(self, tool: "GuardianTool", name: str, proposed: Dict[str, Any], outcome: Outcome, call_id: Any) -> Dict[str, Any]:
        return {
            "type": INTERRUPT_TYPE,
            "decision": "ASK",
            "request_id": outcome.request_id,
            "tool_name": name,
            "tool": tool.name,
            "tool_call_id": call_id,
            "arguments": proposed,
            "message": f"{name} is held for human approval (request_id {outcome.request_id}). "
            "After a person approves it in Guardian, resume the graph: the approved request runs then. "
            "Resuming before then pauses again.",
        }

    def _first_notice(self, outcome: Outcome) -> bool:
        request_id = outcome.request_id
        if self._on_approval_pending is None or not request_id or request_id in self._notified:
            return False
        if len(self._notified) >= 4096:
            self._notified.clear()
        self._notified[request_id] = None
        return True

    def _sync_callback_check(self, tool_name: str) -> None:
        # A sync Guard calls these and awaits nothing, so a coroutine function
        # would never run. Refused before anything is proposed.
        for option, (callback, lost) in self._sync_only_plain.items():
            if callback is not None and inspect.iscoroutinefunction(callback):
                raise TypeError(
                    f"{option} is a coroutine function, and {tool_name} was called synchronously: "
                    f"it could not be awaited, so {lost}. Pass a plain function, "
                    "or call the tool with ainvoke(). Nothing was proposed and the tool did not run."
                )

    def _not_run(self, tool: "GuardianTool", name: str, call_id: Any) -> Any:
        outcome = Outcome(
            ran=False,
            decision="DENY",
            message=f"{name} did not run: another tool call of the same step is waiting for a person's "
            "approval, and the graph is pausing for it. Call it again.",
            reason_code="PAUSED_FOR_APPROVAL",
        )
        return self._result(tool, name, outcome, [], call_id)

    def _result(self, tool: "GuardianTool", name: str, outcome: Outcome, output: List[Any], call_id: Any) -> Any:
        pair = tool.response_format == "content_and_artifact"
        if outcome.ran and outcome.message is None:
            return output[0]  # the tool's own result
        info = (outcome.result or {}).get("guardian")
        if performed_remotely(outcome):
            # remote: Guardian made the call; the model gets its result, with the receipt.
            return (outcome.message, outcome.result) if pair else outcome.message
        if not isinstance(info, dict):
            info = {
                "decision": outcome.decision,
                "tool_name": name,
                **({"reason_code": outcome.reason_code} if outcome.reason_code else {}),
            }
        message = outcome.message or f"{name} did not run."
        content: Any = message
        if call_id is not None:
            content = ToolMessage(
                content=message,
                name=tool.name,
                tool_call_id=call_id,
                status="success" if outcome.decision == "ASK" else "error",
                artifact={"guardian": info},
            )
        return (content, {"guardian": info}) if pair else content

    def _unreadable(self, tool: "GuardianTool", call_id: Any) -> Any:
        name = resolve_tool_name(self._tool_names, tool.name)
        outcome = Outcome(
            ran=False,
            decision="DENY",
            message=f"Guardian could not read the arguments of {name} as JSON, so it was not proposed and did not run.",
            reason_code="INVALID_ARGUMENTS",
        )
        return self._result(tool, name, outcome, [], call_id)

    def _run_sync(
        self, tool: "GuardianTool", args: tuple, kwargs: Dict[str, Any], run_inner: Callable[..., Any], config: Any
    ) -> Any:
        call_id = kwargs.pop(_CALL_ID, None)
        if self._guard is None:
            raise TypeError(
                f"{tool.name} was called synchronously, but Guardian was given an AsyncGuardianClient. "
                "Use ainvoke(), or pass a GuardianClient. The tool did not run."
            )
        self._sync_callback_check(tool.name)
        try:
            name, proposed, decided, injected = self._prepare(tool, args, kwargs)
        except Exception:  # noqa: BLE001 - arguments Guardian cannot read never run
            return self._unreadable(tool, call_id)
        output: List[Any] = []
        call = _Call(self, config, call_id)
        remote = self._guard._opts.mode_for(name) == "remote"

        def run_tool() -> None:
            call.acting()
            if injected is None:
                output.append(run_inner(*decided))
            else:
                output.append(run_inner(**decided, **injected))

        try:
            call.replay()
            for _ in range(_MAX_RESUMES):
                if remote:
                    call.acting()  # Guardian performs a remote call as soon as it allows it
                outcome = decide_and_run_sync(self._guard, name, proposed, run_tool)
                if outcome.decision != "ASK" or not outcome.request_id:
                    break
                call.did_not_act()
                if self._first_notice(outcome):
                    told = self._on_approval_pending(name, outcome.request_id)  # type: ignore[misc]
                    if inspect.isawaitable(told):
                        close = getattr(told, "close", None)
                        if callable(close):
                            close()
                        self._notified.pop(outcome.request_id, None)
                        raise TypeError(
                            f"on_approval_pending returned an awaitable, and {name} was called synchronously: "
                            "it could not be awaited. Pass a plain function, or call the tool with ainvoke(). "
                            f"The call is held (request_id {outcome.request_id}) and did not run."
                        )
                # Resumed: only Guardian's answer to the claim lets the tool run.
                if not call.pause(self._payload(tool, name, proposed, outcome, call_id)):
                    break
        except _NotRun:
            return self._not_run(tool, name, call_id)
        except _GraphBubbleUp:
            call.interrupted()
            raise
        call.finished()
        return self._result(tool, name, outcome, output, call_id)

    async def _run_async(
        self,
        tool: "GuardianTool",
        args: tuple,
        kwargs: Dict[str, Any],
        run_inner: Callable[..., Awaitable[Any]],
        config: Any,
    ) -> Any:
        call_id = kwargs.pop(_CALL_ID, None)
        try:
            name, proposed, decided, injected = self._prepare(tool, args, kwargs)
        except Exception:  # noqa: BLE001 - arguments Guardian cannot read never run
            return self._unreadable(tool, call_id)
        output: List[Any] = []
        call = _Call(self, config, call_id)
        remote = self._aguard._opts.mode_for(name) == "remote"

        async def run_tool() -> None:
            call.acting()
            if injected is None:
                output.append(await run_inner(*decided))
            else:
                output.append(await run_inner(**decided, **injected))

        try:
            call.replay()
            for _ in range(_MAX_RESUMES):
                if remote:
                    call.acting()
                outcome = await decide_and_run(self._aguard, name, proposed, run_tool)
                if outcome.decision != "ASK" or not outcome.request_id:
                    break
                call.did_not_act()
                if self._first_notice(outcome):
                    told = self._on_approval_pending(name, outcome.request_id)  # type: ignore[misc]
                    if inspect.isawaitable(told):
                        await told
                if not call.pause(self._payload(tool, name, proposed, outcome, call_id)):
                    break
        except _NotRun:
            return self._not_run(tool, name, call_id)
        except _GraphBubbleUp:
            call.interrupted()
            raise
        call.finished()
        return self._result(tool, name, outcome, output, call_id)


def _refused(name: str, call_id: Any, message: str, reason_code: str) -> ToolMessage:
    return ToolMessage(
        content=message,
        name=name,
        tool_call_id=call_id,
        status="error",
        artifact={"guardian": {"decision": "DENY", "tool_name": name, "reason_code": reason_code}},
    )


class GuardianTool(BaseTool):
    """A LangChain tool behind Guardian. Build it with :func:`guardian_tool`.

    The model sees the wrapped tool's name, description and argument schema.
    ``invoke`` / ``ainvoke`` validate the input with the wrapped tool's
    schema, ask Guardian about the validated arguments, and after ALLOW call
    the wrapped tool's ``_run`` / ``_arun`` with exactly those.
    """

    _inner: BaseTool = PrivateAttr()
    _gate: GuardianGate = PrivateAttr()
    _filled: FrozenSet[str] = PrivateAttr(default=frozenset())
    _stubs: Dict[str, Any] = PrivateAttr(default_factory=dict)

    # --- what the model and the framework see: the wrapped tool's ------------

    def get_input_schema(self, config: Optional[RunnableConfig] = None) -> Any:
        return self._inner.get_input_schema(config)

    @property
    def tool_call_schema(self) -> Any:
        return self._inner.tool_call_schema

    @property
    def args(self) -> Dict[str, Any]:
        return self._inner.args

    @property
    def _injected_args_keys(self) -> Any:  # type: ignore[override]
        return self._inner._injected_args_keys

    def _stub(self, attribute: str) -> Any:
        fn = getattr(self._inner, attribute, None)
        if not callable(fn):
            return None
        if attribute not in self._stubs:
            self._stubs[attribute] = _signature_stub(fn)
        return self._stubs[attribute]

    @property
    def func(self) -> Any:
        """The wrapped function's signature, for argument injection. Not callable."""
        return self._stub("func")

    @property
    def coroutine(self) -> Any:
        """The wrapped coroutine's signature, for argument injection. Not callable."""
        return self._stub("coroutine")

    # --- the call -------------------------------------------------------------

    def _to_args_and_kwargs(self, tool_input: Any, tool_call_id: Optional[str]) -> Any:
        # The wrapped tool validates its own input, once.
        args, kwargs = self._inner._to_args_and_kwargs(tool_input, tool_call_id)
        return args, {**kwargs, _CALL_ID: tool_call_id}

    def _run(self, *args: Any, config: RunnableConfig, run_manager: Any = None, **kwargs: Any) -> Any:
        inner = self._inner
        if getattr(inner, "coroutine", None) is not None and getattr(inner, "func", None) is None:
            # Refused before anything is proposed: an ALLOW could not be used.
            raise NotImplementedError(
                f"{inner.name} is an async-only tool: use ainvoke(). Nothing was proposed and it did not run."
            )

        def run_inner(*decided_args: Any, **decided: Any) -> Any:
            if run_manager is not None and "run_manager" in inspect.signature(inner._run).parameters:
                decided["run_manager"] = run_manager
            config_param = _get_runnable_config_param(inner._run)
            if config_param:
                decided[config_param] = config
            return inner._run(*decided_args, **decided)

        return self._gate._run_sync(self, args, kwargs, run_inner, config)

    async def _arun(self, *args: Any, config: RunnableConfig, run_manager: Any = None, **kwargs: Any) -> Any:
        inner = self._inner

        async def run_inner(*decided_args: Any, **decided: Any) -> Any:
            # A tool that inherits BaseTool._arun runs its _run in a thread and
            # hands it these keyword arguments, so _run's signature decides.
            target = inner._run if type(inner)._arun is BaseTool._arun else inner._arun
            if run_manager is not None and "run_manager" in inspect.signature(target).parameters:
                decided["run_manager"] = run_manager
            config_param = _get_runnable_config_param(target)
            if config_param:
                decided[config_param] = config
            return await inner._arun(*decided_args, **decided)

        return await self._gate._run_async(self, args, kwargs, run_inner, config)


def _govern(inner: BaseTool, gate: GuardianGate) -> GuardianTool:
    if isinstance(inner, _SimpleTool) and inner.args_schema is None:
        raise TypeError(
            f'"{inner.name}" is a single-string Tool without an args_schema. '
            "Give it an args_schema, or build it with @tool / StructuredTool."
        )
    if any(is_stream_function(getattr(inner, name, None)) for name in ("func", "coroutine")) or any(
        is_stream_function(getattr(type(inner), name, None)) for name in ("_run", "_arun")
    ):
        # Calling a generator function runs none of its body, so the call
        # would be recorded before (or without) the tool running.
        raise TypeError(
            f'"{inner.name}" is a generator function. A LangChain tool returns its result; '
            "collect the items and return them."
        )
    governed = GuardianTool(
        name=inner.name,
        description=inner.description,
        args_schema=inner.args_schema,
        return_direct=inner.return_direct,
        verbose=inner.verbose,
        callbacks=inner.callbacks,
        tags=inner.tags,
        metadata=inner.metadata,
        handle_tool_error=inner.handle_tool_error,
        handle_validation_error=inner.handle_validation_error,
        response_format=inner.response_format,
        **({"extras": inner.extras} if getattr(inner, "extras", None) is not None else {}),
    )
    governed._inner = inner
    governed._gate = gate
    governed._filled = _framework_filled(inner)
    return governed


def guardian_tool(
    tool: BaseTool, client: Union[GuardianClient, AsyncGuardianClient, GuardianGate], **options: Any
) -> GuardianTool:
    """``tool`` behind Guardian.

    ``client`` and ``options`` are :class:`GuardianGate`'s; pass a
    :class:`GuardianGate` in place of the client to share one between tools.
    """
    return _gate_of(client, options).tool(tool)


def guardian_tools(
    tools: Sequence[BaseTool], client: Union[GuardianClient, AsyncGuardianClient, GuardianGate], **options: Any
) -> List[GuardianTool]:
    """:func:`guardian_tool` over a list, in order, with one shared :class:`GuardianGate`."""
    return _gate_of(client, options).tools(tools)


def _gate_of(client: Any, options: Dict[str, Any]) -> GuardianGate:
    if isinstance(client, GuardianGate):
        if options:
            raise TypeError("options belong to the GuardianGate that was passed")
        return client
    return GuardianGate(client, **options)


if _AgentMiddleware is not None:

    class GuardianMiddleware(_AgentMiddleware):  # type: ignore[misc, valid-type]
        """Agent middleware for ``langchain.agents.create_agent``: every tool call goes to Guardian.

        ``GuardianMiddleware(client, connection_id=..., ...)`` takes
        :class:`GuardianGate`'s options, or ``GuardianMiddleware(gate)``.
        List it last in ``middleware=[...]``: it puts each call's tool behind
        Guardian and hands the call on, and a middleware listed after it
        (closer to the tool) could answer the call itself or replace the tool.
        """

        def __init__(self, client: Any, **options: Any) -> None:
            super().__init__()
            self.gate = _gate_of(client, options)

        def wrap_tool_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
            return self.gate.wrap_tool_call(request, handler)

        async def awrap_tool_call(self, request: Any, handler: Callable[[Any], Awaitable[Any]]) -> Any:
            return await self.gate.awrap_tool_call(request, handler)

else:  # pragma: no cover - exercised without langchain installed

    class GuardianMiddleware:  # type: ignore[no-redef]
        """Needs the ``langchain`` package (``pip install "odingard-guardian[langchain]"``)."""

        def __init__(self, *args: Any, **kwargs: Any) -> None:
            raise ImportError('GuardianMiddleware needs langchain: pip install "odingard-guardian[langchain]"')
