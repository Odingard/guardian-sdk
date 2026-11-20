"""Guardian for Strands Agents: a hook provider.

Strands Agents (``strands-agents`` on PyPI, Python 3.10+) fires a
``BeforeToolCallEvent`` hook before every tool call, and lets a hook select
the tool that runs. :class:`GuardianHookProvider` selects a governed stand-in
for the tool, which asks Guardian about the call and only then runs the
tool::

    from strands import Agent
    from odingard_guardian import GuardianClient
    from odingard_guardian.strands import GuardianHookProvider

    guardian = GuardianHookProvider(
        GuardianClient(credential=os.environ["GUARDIAN_AGENT_CREDENTIAL"]),
        connection_id=os.environ["GUARDIAN_CONNECTION_ID"],
        agent_name="billing-agent",
    )
    agent = Agent(model=..., tools=[refund_order], hooks=[guardian])

* ALLOW: the tool runs once with the arguments Guardian decided on, then
  the capability is redeemed and the decision recorded.
* ASK: the tool does not run. The model is told the call is held for a
  person; after the person approves, the same call (same tool, same
  arguments) in the same session claims the approved request and runs. The
  session is the agent's session manager's, or what ``scope=`` returns;
  without one, each call asks for its own approval. With
  ``on_ask="interrupt"`` the agent run pauses instead (a Strands interrupt)
  and the call is made again when the run is resumed.
* DENY, or Guardian unreachable: the tool does not run and the model is
  told so.

The decision is made inside the stand-in tool, which is the last step
Strands takes for a tool call: after every ``BeforeToolCallEvent`` hook and
after the tool middleware. The stand-in takes a private copy of the
arguments it is handed, proposes that copy and runs the tool with it, so
nothing can change the arguments between the decision and the tool. What a
hook or a middleware changed before that point is what Guardian decides on.
"""

from __future__ import annotations

import asyncio
import copy
import dataclasses
import inspect
import logging
import weakref
from typing import Any, AsyncGenerator, Callable, Dict, Literal, Mapping, Optional, Tuple, Union

from strands.hooks import AfterToolCallEvent, BeforeToolCallEvent, HookOrder, HookProvider, HookRegistry
from strands.types.events import ToolResultEvent
from strands.types.tools import AgentTool, ToolSpec, ToolUse

from ._framework import (
    ToolNames,
    build_guard,
    decide_and_run,
    json_record,
    resolve_scope,
    resolve_tool_name,
    unchecked,
)
from .client import AsyncGuardianClient, GuardianClient
from .guard import SCOPE_UNKNOWN, GuardianExecutionFailed

__all__ = ["GuardianHookProvider"]

_logger = logging.getLogger("odingard_guardian")

OnAsk = Literal["result", "interrupt"]
Mode = Literal["in_process", "remote"]

_DONE = object()
_NOTHING = object()


class _Paused(Exception):
    """The tool paused itself (a Strands interrupt): it has no result yet."""


class _ToolFailed(Exception):
    """The tool raised or returned an error result: nothing is redeemed."""


class _InThreads:
    """A sync :class:`GuardianClient` for async callers: each call runs in a worker thread."""

    def __init__(self, client: Any) -> None:
        self._client = client

    async def request(self, invocation: Mapping[str, Any]) -> Any:
        return await asyncio.to_thread(self._client.request, invocation)

    async def claim(self, request_id: str) -> Any:
        return await asyncio.to_thread(self._client.claim, request_id)

    async def execute(self, *, request_id: str, capability_token: str) -> Any:
        return await asyncio.to_thread(
            lambda: self._client.execute(request_id=request_id, capability_token=capability_token)
        )

    async def receipts(self, request_id: str) -> Any:
        return await asyncio.to_thread(self._client.receipts, request_id)


def _is_interrupt(event: Any) -> bool:
    return isinstance(event, dict) and "tool_interrupt_event" in event


def _failed(event: ToolResultEvent) -> bool:
    """Whether the tool reported a failure: it raised, or its result has the error status."""
    if event.exception is not None:
        return True
    result = event.get("tool_result")
    return isinstance(result, Mapping) and result.get("status") == "error"


def _takes_keywords(stream: Any) -> bool:
    try:
        parameters = inspect.signature(stream).parameters.values()
    except (TypeError, ValueError):
        return False
    return any(parameter.kind is inspect.Parameter.VAR_KEYWORD for parameter in parameters)


def _registered(agent: Any, name: Any) -> Optional[AgentTool]:
    """The tool Strands runs for ``name``: a dynamic tool first, then the registry."""
    registry = getattr(agent, "tool_registry", None)
    tool = getattr(registry, "dynamic_tools", {}).get(name)
    return tool if tool is not None else getattr(registry, "registry", {}).get(name)


class _GuardianTool(AgentTool):
    """Stands in for one tool: asks Guardian, then runs the tool with the decided arguments."""

    def __init__(self, provider: "GuardianHookProvider", tool: AgentTool) -> None:
        super().__init__()
        self._provider = provider
        self._tool = tool

    @property
    def tool_name(self) -> str:
        return self._tool.tool_name

    @property
    def tool_spec(self) -> ToolSpec:
        return self._tool.tool_spec

    @property
    def tool_type(self) -> str:
        return self._tool.tool_type

    @property
    def is_dynamic(self) -> bool:
        return self._tool.is_dynamic

    def get_display_properties(self) -> Dict[str, str]:
        return self._tool.get_display_properties()

    async def stream(
        self, tool_use: ToolUse, invocation_state: Dict[str, Any], **kwargs: Any
    ) -> AsyncGenerator[Any, None]:
        provider = self._provider
        tool_use_id = str(tool_use.get("toolUseId"))
        tool_name = resolve_tool_name(provider._tool_names, self._tool.tool_name)

        def told(message: str, status: str = "error") -> ToolResultEvent:
            return ToolResultEvent({"toolUseId": tool_use_id, "status": status, "content": [{"text": message}]})  # type: ignore[typeddict-item]

        # A private copy, taken once: it is what Guardian decides on and what
        # the tool runs with, whatever happens to the caller's record later.
        try:
            given = tool_use.get("input")
            decided = copy.deepcopy({} if given is None else given)
            proposed = json_record(decided)
        except Exception:  # noqa: BLE001 - arguments Guardian cannot read never run
            yield told(
                f"Guardian could not read the arguments of {tool_name} as JSON, so it was not "
                "proposed and did not run."
            )
            return

        # The tool's stream runs inside Guardian's run step, in a task of its
        # own; its events are handed over one at a time, at the consumer's pace.
        events: "asyncio.Queue[Any]" = asyncio.Queue()
        taken = asyncio.Event()
        final: list = []  # the tool's own result, held back until Guardian recorded the run

        async def run_tool() -> None:
            call = dict(tool_use)
            call["input"] = copy.deepcopy(decided)
            passed = dict(kwargs)
            if not _takes_keywords(self._tool.stream):
                # Strands hands its context only to a stream that takes **kwargs.
                passed.pop("_tool_context", None)
            context = passed.get("_tool_context")
            if dataclasses.is_dataclass(context) and not isinstance(context, type) and hasattr(context, "tool_use"):
                # The tool's context names the decided call, not the caller's record.
                passed["_tool_context"] = dataclasses.replace(context, tool_use=call)
            last: Any = _NOTHING
            stream = self._tool.stream(call, invocation_state, **passed)  # type: ignore[arg-type]
            try:
                async for event in stream:
                    if isinstance(event, ToolResultEvent):
                        final.append(event)
                        break
                    events.put_nowait(event)
                    await taken.wait()
                    taken.clear()
                    if _is_interrupt(event):
                        raise _Paused()
                    last = event
                else:
                    if last is not _NOTHING:
                        # A tool that yields plain values: the last one is its result.
                        final.append(ToolResultEvent(last))
            finally:
                close = getattr(stream, "aclose", None)
                if callable(close):
                    await close()
            if final and _failed(final[0]):
                raise _ToolFailed()

        # The session the call belongs to: a held request is claimed only by
        # the same call in the same scope. Never read from the arguments.
        context = kwargs.get("_tool_context")
        agent = getattr(context, "agent", None) or invocation_state.get("agent")
        pauses = provider._on_ask == "interrupt" and "event_loop_cycle_id" in invocation_state
        scope = provider._scope_of(agent, invocation_state)
        paused_call = scope is SCOPE_UNKNOWN and pauses
        if paused_call:
            # A paused call is made again by resuming its own agent run: its
            # held request belongs to this call of this agent, to no session.
            scope = provider._call_scope(agent, tool_use_id)

        async def governed() -> Any:
            try:
                return await decide_and_run(provider._guard, tool_name, proposed, run_tool, scope=scope)
            finally:
                events.put_nowait(_DONE)

        task = asyncio.ensure_future(governed())
        try:
            while True:
                event = await events.get()
                if event is _DONE:
                    break
                yield event
                taken.set()
            try:
                outcome = await task
            except _Paused:
                return  # the interrupt event went out; Strands resumes the call later
            except _ToolFailed:
                yield final[0]  # the tool's own error, as the tool reported it
                return
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

        held = outcome.decision == "ASK" and bool(outcome.request_id)
        if paused_call and not (held and callable(getattr(context, "interrupt", None))):
            provider._forget_call(agent, tool_use_id)  # settled: nothing left to resume
        if outcome.message is None:
            if final:
                yield final[0]  # ALLOW: the tool ran and Guardian recorded it
            return
        info = (outcome.result or {}).get("guardian") or {}
        if outcome.decision == "ALLOW" and not outcome.ran and "outcome" not in info:
            # Remote mode: Guardian performed the call; its answer is the result.
            # (A remote call that could not be confirmed carries an "outcome"
            # and is reported as an error below.)
            yield told(outcome.message, "success")
            return
        if held:
            await provider._held(tool_name, outcome.request_id)
            # Only an agent run can pause: a direct call (agent.tool.x(...)) has
            # no event loop cycle, and its caller gets the held result.
            if pauses:
                _pause(context, tool_name, outcome.request_id, outcome.message)
        yield told(outcome.message)


def _pause(context: Any, tool_name: str, request_id: str, message: str) -> None:
    """Pause the agent run for a held call (raises Strands' ``InterruptException``).

    The response given when the run is resumed approves nothing: the resumed
    call claims the request from Guardian, and pauses again while it is
    still held. Each pause has a name of its own, so an answered one never
    stands in for the next.
    """
    interrupt = getattr(context, "interrupt", None)
    if not callable(interrupt):
        return  # no way to pause here: the model is told the call is held
    reason = {
        "guardian": {"decision": "ASK", "request_id": request_id, "tool_name": tool_name, "message": message}
    }
    for attempt in range(1, 10_000):
        interrupt(f"guardian-approval:{request_id}:{attempt}", reason=reason)


class GuardianHookProvider(HookProvider):
    """A Strands hook provider that sends each tool call to Guardian before the tool runs.

    Pass it to the agent: ``Agent(..., hooks=[guardian])``.

    :param client: a :class:`GuardianClient` or an :class:`AsyncGuardianClient`
        (the agent's credential). A :class:`GuardianClient` is called in worker
        threads; use it when you call the agent synchronously (``agent(...)``),
        because Strands then runs every call on an event loop of its own.
    :param connection_id: the Guardian connection the tools are registered on
        (Guardian console → Connections). Register each tool once as
        "My own code (record-only)" and allow it for the agent.
    :param agent_name / purpose / adapter_id: as for :class:`Guard`.
    :param amount_args: dollar amounts on tools, by Guardian tool name, exactly
        as set in the Guardian console (see :class:`Guard`).
    :param tool_names: the Guardian tool name for a Strands tool name, as a
        mapping or a function. Default: the same name.
    :param mode: ``"in_process"`` (default): the Strands tool is the action; it
        runs after ALLOW and the capability is redeemed after it. ``"remote"``:
        Guardian performs the call with the tool registered on the
        connection; the Strands tool body never runs and the model gets
        Guardian's answer.
    :param modes: the mode per Guardian tool name, for tools that differ from
        ``mode``.
    :param on_ask: ``"result"`` (default) tells the model the call is held;
        ``"interrupt"`` pauses the agent run with a Strands interrupt whose
        ``reason`` carries the ``request_id``. Resume the run after the person
        approved in the Guardian console. The response you resume with
        approves nothing: the call claims the request from Guardian and
        pauses again while it is still held.
    :param scope: ``callback(agent, invocation_state)`` returning the scope of
        a call: the session, user or conversation it belongs to, as a hashable
        value. A held call is claimed only by the same call in the same scope.
        Default: the session id of the agent's session manager (with the
        agent's ``agent_id``); an agent without a session manager has no
        scope, and then a held call is never claimed by a later call. Read
        the scope from something your app sets, such as a value it passes in
        ``agent(..., invocation_state={"user_id": ...})``; never from the tool
        call's arguments, which the model writes. ``None``, an empty string or
        an error means unknown.
    :param on_approval_pending: ``callback(tool_name, request_id)`` when a
        call is held, so the app can show the request to a person.
    :param on_receipt / on_execution_error: as for :class:`Guard`.
    """

    def __init__(
        self,
        client: Union[GuardianClient, AsyncGuardianClient],
        *,
        connection_id: str,
        agent_name: str = "agent",
        purpose: Union[None, str, Callable[[str, Dict[str, Any]], str]] = None,
        adapter_id: Optional[str] = None,
        amount_args: Optional[Mapping[str, Mapping[str, Any]]] = None,
        tool_names: ToolNames = None,
        mode: Mode = "in_process",
        modes: Optional[Mapping[str, Mode]] = None,
        on_ask: OnAsk = "result",
        scope: Optional[Callable[[Any, Dict[str, Any]], Any]] = None,
        on_approval_pending: Optional[Callable[[str, str], Any]] = None,
        on_receipt: Optional[Callable[[str, str, Optional[Dict[str, Any]]], Any]] = None,
        on_execution_error: Optional[Callable[[GuardianExecutionFailed], Any]] = None,
    ) -> None:
        if on_ask not in ("result", "interrupt"):
            raise ValueError('on_ask takes "result" or "interrupt"')
        if not inspect.iscoroutinefunction(getattr(client, "request", None)):
            client = _InThreads(client)  # type: ignore[assignment]
        self._guard = build_guard(
            client,  # type: ignore[arg-type]
            connection_id=connection_id,
            agent_name=agent_name,
            adapter_id=adapter_id,
            purpose=purpose,
            amount_args=amount_args,
            on_receipt=on_receipt,
            on_execution_error=on_execution_error,
            mode=mode,
            modes=modes,
        )
        self._tool_names = tool_names
        self._on_ask = on_ask
        self._scope = scope
        #: Paused calls of agents without a scope: a private scope per agent and tool use.
        self._paused: "weakref.WeakKeyDictionary[Any, Dict[str, object]]" = weakref.WeakKeyDictionary()
        self._on_approval_pending = on_approval_pending
        #: The tool and name each call started with, by event, until the last hook ran.
        self._first: Dict[int, Tuple[Optional[AgentTool], Any]] = {}

    def register_hooks(self, registry: HookRegistry, **kwargs: Any) -> None:
        # Before any other hook, whatever its order: Strands compares a call
        # with the tool and name it had before the first hook ran.
        registry.add_callback(BeforeToolCallEvent, self._remember, order=float("-inf"))
        # Last, so the tool another hook selects is governed too.
        registry.add_callback(BeforeToolCallEvent, self._govern, order=HookOrder.SDK_LAST)
        registry.add_callback(AfterToolCallEvent, self._check, order=HookOrder.SDK_LAST)

    def _remember(self, event: BeforeToolCallEvent) -> None:
        key = id(event)
        self._first[key] = (event.selected_tool, event.tool_use.get("name"))
        weakref.finalize(event, self._first.pop, key, None)

    def _govern(self, event: BeforeToolCallEvent) -> None:
        try:
            first = self._first.pop(id(event), None)
            tool = event.selected_tool
            name = event.tool_use.get("name")
            if tool is None or (first is not None and tool is first[0] and name != first[1]):
                # A hook renamed the call without selecting a tool: Strands
                # runs the tool registered under the new name.
                tool = _registered(event.agent, name)
            if tool is None:
                return  # no such tool: nothing runs, and Strands reports it
            if self._governs(tool):
                return
            event.selected_tool = _GuardianTool(self, tool)
        except Exception:  # noqa: BLE001 - a call that cannot be governed never runs
            _logger.warning("Guardian could not govern a tool call; it did not run", exc_info=True)
            event.cancel_tool = unchecked(str(event.tool_use.get("name"))).message or True

    def _check(self, event: AfterToolCallEvent) -> None:
        tool = event.selected_tool
        if tool is None or event.cancel_message is not None:
            return  # nothing ran
        if self._governs(tool):
            return
        # A hook that runs after Guardian's selected another tool.
        name = str(event.tool_use.get("name"))
        _logger.error(
            "%s ran without a Guardian decision: a hook that runs after Guardian's selected another tool", name
        )
        event.result = {
            "toolUseId": str(event.tool_use.get("toolUseId")),
            "status": "error",
            "content": [
                {
                    "text": f"{name} ran without a Guardian decision: a hook that runs after Guardian's "
                    "selected another tool. Do not call it again; tell the user."
                }
            ],
        }

    def _scope_of(self, agent: Any, invocation_state: Dict[str, Any]) -> Any:
        """The scope of a call: the app's ``scope`` option, else the agent's session."""
        default: Any = SCOPE_UNKNOWN
        # The id the application gave the agent's session manager. An agent
        # without one only has a random id of its own, which names no session.
        session_id = getattr(getattr(agent, "_session_manager", None), "session_id", None)
        if isinstance(session_id, str) and session_id:
            default = ("strands-session", session_id, getattr(agent, "agent_id", None))
        option = self._scope
        return resolve_scope(
            None if option is None else (lambda _context: option(agent, invocation_state)), None, default
        )

    def _call_scope(self, agent: Any, tool_use_id: str) -> Any:
        try:
            return self._paused.setdefault(agent, {}).setdefault(tool_use_id, object())
        except TypeError:  # an agent that cannot be referenced: nothing is remembered
            return SCOPE_UNKNOWN

    def _forget_call(self, agent: Any, tool_use_id: str) -> None:
        try:
            calls = self._paused.get(agent)
        except TypeError:
            return
        if calls is not None:
            calls.pop(tool_use_id, None)
            if not calls:
                self._paused.pop(agent, None)

    def _governs(self, tool: Any) -> bool:
        """Whether ``tool`` is, or wraps, this provider's stand-in."""
        while isinstance(tool, _GuardianTool):
            if tool._provider is self:
                return True
            tool = tool._tool
        return False

    async def _held(self, tool_name: str, request_id: str) -> None:
        if self._on_approval_pending is None:
            return
        pending = self._on_approval_pending(tool_name, request_id)
        if inspect.isawaitable(pending):
            await pending
