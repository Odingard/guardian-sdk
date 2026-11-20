"""Guardian for the OpenAI Agents SDK (``openai-agents`` on PyPI, imported as ``agents``).

**Governed tools.** :func:`guardian_tool` and :func:`create_guardian_tool`
turn a function or a ``FunctionTool`` into a ``FunctionTool`` with the same
name, description and parameter schema whose every call is decided by
Guardian before it runs::

    from agents import Agent, Runner
    from odingard_guardian import AsyncGuardianClient
    from odingard_guardian.openai_agents import create_guardian_tool, find_approval_pending

    governed = create_guardian_tool(
        AsyncGuardianClient(credential=os.environ["GUARDIAN_AGENT_CREDENTIAL"]),
        connection_id=os.environ["GUARDIAN_CONNECTION_ID"],
        agent_name="billing-agent",
    )

    @governed
    def refund_order(order_id: str, amount_cents: int) -> str:
        '''Refund an order.'''
        ...

    agent = Agent(name="Billing", tools=[refund_order])

* ALLOW: the tool runs once with the arguments Guardian decided on, then the
  capability is redeemed and the decision recorded.
* ASK: the tool does not run. ``on_ask="raise"`` (default) raises
  :class:`GuardianApprovalPending` out of the run
  (:func:`find_approval_pending` finds it; ``resume()`` claims the approval
  and runs the tool). ``on_ask="result"`` tells the model the call is held;
  the same call after approval claims the approved request.
  ``on_ask="interrupt"`` pauses the run as an Agents SDK interruption; after
  ``state.approve(...)`` the tool still claims Guardian's request and runs
  only if a person approved it in Guardian.
* DENY, or Guardian unreachable: the tool does not run and the model is told
  so.

The Agents SDK is imported when a tool is wrapped, not when this module is
imported, so the helpers below work without it and with any version.

**A Guardian-aware** ``failure_error_function``, for tools wrapped with
``@guard`` instead. The Agents SDK's default ``failure_error_function``
gives the model one fixed message for every exception. After Guardian
allowed a call that then ran (or may have run), that message can make the
model call the tool again, which is a new request and can repeat the action.
Pass this function instead::

    from agents import function_tool
    from odingard_guardian.openai_agents import guardian_failure_error_function

    tool = function_tool(pay_invoice, failure_error_function=guardian_failure_error_function)

* :class:`GuardianApprovalPending` is re-raised, so the pending approval
  (and its ``resume()``) reaches your code.
* :class:`GuardianExecutionFailed`: the model is told the call ran (or may
  have run) and must not be called again.
* :class:`GuardianDenied`: the model is told the call did not run and not to
  retry it, or, when Guardian could not be reached, to try again later.
* Anything else gets the Agents SDK's usual message, or your ``fallback``.
"""

from __future__ import annotations

import asyncio
import contextvars
import copy
import inspect
import json
import logging
from collections import OrderedDict
from types import SimpleNamespace
from typing import Any, Callable, Dict, Literal, Mapping, Optional, Set, Tuple, Union

from ._canonical import canonical_json
from ._framework import (
    _RAN,
    Outcome,
    ToolNames,
    build_guard,
    decide_and_run,
    is_stream_function,
    json_record,
    resolve_tool_name,
)
from .client import AsyncGuardianClient
from .guard import (
    EXECUTION_OUTCOME_UNKNOWN,
    GuardianApprovalPending,
    GuardianDenied,
    GuardianExecutionFailed,
    GuardianUnavailable,
    ResumeResult,
    execution_failed_message,
)

__all__ = [
    "DEFAULT_TOOL_ERROR_MESSAGE",
    "create_guardian_tool",
    "find_approval_pending",
    "guardian_error_message",
    "guardian_failure_error_function",
    "guardian_request_id",
    "guardian_tool",
    "make_guardian_failure_error_function",
]

_logger = logging.getLogger("odingard_guardian")

#: The Agents SDK's own default message, used for errors that are not Guardian's.
DEFAULT_TOOL_ERROR_MESSAGE = "An error occurred while running the tool. Please try again."


def _find(error: BaseException, kind: type) -> Optional[Any]:
    """``error`` or the first exception it was raised from that is a ``kind``."""
    seen = set()
    current: Optional[BaseException] = error
    while current is not None and id(current) not in seen:
        if isinstance(current, kind):
            return current
        seen.add(id(current))
        current = current.__cause__ or current.__context__
    return None


def guardian_error_message(error: BaseException) -> Optional[str]:
    """The model-visible message for a Guardian error, or ``None`` for any other error.

    Raises :class:`GuardianApprovalPending` if ``error`` is (or wraps) one.
    """
    pending = _find(error, GuardianApprovalPending)
    if pending is not None:
        raise pending
    failed = _find(error, GuardianExecutionFailed)
    if failed is not None:
        return execution_failed_message(failed)
    denied = _find(error, GuardianDenied)
    if denied is not None:
        if denied.reason_code == "SERVICE_UNAVAILABLE":
            return f"Guardian could not check {denied.tool_name}, so it did not run. Try again later."
        rid = f" (request_id {denied.request_id})" if denied.request_id else ""
        return (
            f"Guardian denied {denied.tool_name} ({denied.reason_code}). It did not run{rid}. "
            "Do not retry the same call."
        )
    return None


def make_guardian_failure_error_function(
    *,
    on_execution_failed: Optional[Callable[[GuardianExecutionFailed], Any]] = None,
    fallback: Optional[Callable[[Any, Exception], Any]] = None,
) -> Callable[[Any, Exception], Any]:
    """Build a ``failure_error_function`` for ``function_tool``.

    :param on_execution_failed: called with the :class:`GuardianExecutionFailed`
        before the model is told, so the app can raise an incident. Errors it
        raises are ignored.
    :param fallback: ``(ctx, error) -> str`` for errors that are not
        Guardian's. Default: the Agents SDK's own message.
    """

    async def failure_error_function(ctx: Any, error: Exception) -> Any:
        message = guardian_error_message(error)
        if message is not None:
            failed = _find(error, GuardianExecutionFailed)
            if failed is not None and on_execution_failed is not None:
                try:
                    result = on_execution_failed(failed)
                    if inspect.isawaitable(result):
                        await result
                except Exception:  # noqa: BLE001 — hooks only observe
                    pass
            return message
        if fallback is not None:
            result = fallback(ctx, error)
            if inspect.isawaitable(result):
                result = await result
            return result
        return DEFAULT_TOOL_ERROR_MESSAGE

    return failure_error_function


#: Ready-made ``failure_error_function`` with no hook and the default fallback.
guardian_failure_error_function = make_guardian_failure_error_function()


# --- governed tools ----------------------------------------------------------

OnAsk = Literal["raise", "result", "interrupt"]
OnDeny = Literal["result", "raise"]

#: ``on_ask="interrupt"``: how long an allowed call waits for the Agents SDK
#: to invoke it. After that the decision is dropped unused and the call is
#: decided again when the SDK invokes it.
PARKED_SECONDS = 30.0

_HELD_LIMIT = 1024

#: Held Guardian request ids by (Agents SDK tool name, tool call id), for
#: :func:`guardian_request_id`. In memory, the most recent ``_HELD_LIMIT``.
_held_requests: "OrderedDict[Tuple[str, str], str]" = OrderedDict()

#: The call a task is deciding, so the client can stop at the call's gate
#: before Guardian is asked to execute.
_current_call: "contextvars.ContextVar[Optional[_Call]]" = contextvars.ContextVar(
    "odingard_guardian_openai_agents_call", default=None
)


def find_approval_pending(error: BaseException) -> Optional[GuardianApprovalPending]:
    """The pending approval behind an error raised by ``Runner.run``, or ``None``.

    The Agents SDK wraps a tool's exception in its own ``UserError``; this
    looks through the chain.
    """
    return _find(error, GuardianApprovalPending)


def guardian_request_id(interruption: Any) -> Optional[str]:
    """The Guardian request a paused tool call waits on.

    ``interruption`` is an item of ``result.interruptions`` from a run with
    ``on_ask="interrupt"`` tools. ``None`` when the interruption is not a
    Guardian hold (for example the tool's own ``needs_approval``), or was
    made in another process.
    """
    raw = getattr(interruption, "raw_item", None)
    call_id = raw.get("call_id") if isinstance(raw, Mapping) else getattr(raw, "call_id", None)
    name = getattr(interruption, "tool_name", None) or getattr(interruption, "name", None)
    if not isinstance(call_id, str) or not isinstance(name, str):
        return None
    return _held_requests.get((name, call_id))


def _sdk() -> Any:
    """The parts of the Agents SDK a governed tool is built from."""
    try:
        from agents import FunctionTool, default_tool_error_function, function_tool
        from agents.tool import (
            maybe_invoke_function_tool_failure_error_function,
            resolve_function_tool_failure_error_function,
            set_function_tool_failure_error_function,
        )
    except ImportError as error:
        raise ImportError(
            "guardian_tool needs the OpenAI Agents SDK in a version it supports "
            '(tested with openai-agents 0.25.0): pip install "odingard-guardian[openai-agents]"'
        ) from error
    try:
        from agents.util._approvals import evaluate_function_tool_approval
    except ImportError:  # a callable needs_approval then always requires approval
        evaluate_function_tool_approval = None  # type: ignore[assignment]
    return SimpleNamespace(
        FunctionTool=FunctionTool,
        evaluate_approval=evaluate_function_tool_approval,
        function_tool=function_tool,
        default_failure=default_tool_error_function,
        apply_failure=maybe_invoke_function_tool_failure_error_function,
        resolve_failure=resolve_function_tool_failure_error_function,
        set_failure=set_function_tool_failure_error_function,
    )


class _Abandoned(Exception):
    """The Agents SDK gave the call up before the action started."""


class _GatedClient:
    """The Guardian client as a governed call uses it.

    Asking Guardian to execute is the start of the action (in remote mode
    Guardian performs it), so it first passes the call's gate: a call the
    SDK gave up never reaches it.
    """

    def __init__(self, client: Any) -> None:
        self._client = client

    async def request(self, invocation: Mapping[str, Any]) -> Any:
        return await self._client.request(invocation)

    async def claim(self, request_id: str) -> Any:
        return await self._client.claim(request_id)

    async def execute(self, *, request_id: str, capability_token: str) -> Any:
        call = _current_call.get()
        if call is not None:
            await call.gate()
        return await self._client.execute(request_id=request_id, capability_token=capability_token)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._client, name)


class _Call:
    """One tool call. Guardian's decision runs in its own task.

    The task stops at the gate, just before the action starts (the tool
    step in-process, Guardian's execution in remote mode), until the Agents
    SDK has invoked the call. Before the gate the call can be abandoned and
    then never starts. Past it the call is committed: the task is left to
    finish, so a tool that ran is redeemed and recorded also when the SDK's
    own timeout or a cancelled run stops waiting for it.
    """

    def __init__(self, tool: "_GovernedTool", proposed: Dict[str, Any]) -> None:
        loop = asyncio.get_running_loop()
        self.tool = tool
        self.at_gate: "asyncio.Future[None]" = loop.create_future()
        self.invoked: "asyncio.Future[None]" = loop.create_future()
        self.finished: "asyncio.Future[Any]" = loop.create_future()
        self.invocation: Optional[Tuple[Any, str]] = None
        self.wants_tool = False
        self.committed = False
        self.abandoned = False
        self.detached = False
        self.output: Any = None
        self.task: "asyncio.Task[Outcome]" = loop.create_task(self._decide(proposed))
        self.task.add_done_callback(self._done)

    async def _decide(self, proposed: Dict[str, Any]) -> Outcome:
        _current_call.set(self)
        return await decide_and_run(self.tool.guard, self.tool.guardian_name, proposed, self._tool_step)

    def _done(self, task: "asyncio.Task[Outcome]") -> None:
        self.detached = True
        if not task.cancelled():
            task.exception()  # read here, so a call nobody waits for is not reported as unretrieved

    def invoke(self, context: Any, text: str) -> None:
        """The Agents SDK is invoking the call."""
        self.invocation = (context, text)
        if not self.invoked.done():
            self.invoked.set_result(None)

    async def gate(self) -> None:
        if self.committed or self.detached:
            return
        if not self.at_gate.done():
            self.at_gate.set_result(None)
        await self.invoked
        if self.abandoned:
            raise _Abandoned()
        self.committed = True

    def abandon(self) -> None:
        if self.committed or self.task.done():
            return
        self.abandoned = True
        self.task.cancel()

    def tool_finished(self, running: "asyncio.Future[Any]") -> None:
        """The original tool ended: hand its output or its error to the decision task."""
        error = None if running.cancelled() else running.exception()
        if self.finished.done():
            return
        if running.cancelled():
            self.finished.cancel()
        elif error is not None:
            self.finished.set_exception(error)  # the tool's own error: nothing is redeemed
        else:
            self.finished.set_result(running.result())

    async def _tool_step(self) -> None:
        if self.detached:
            # resume() after the SDK's call ended: run the tool here, with
            # the arguments of that call.
            assert self.invocation is not None
            context, text = self.invocation
            self.output = await self.tool.raw.on_invoke_tool(context, text)
            return
        self.wants_tool = True
        await self.gate()
        self.output = await self.finished  # the tool runs in the SDK's own invocation


def _parse_arguments(text: str) -> Dict[str, Any]:
    """The tool call's arguments as the JSON record Guardian decides on.

    The original tool is handed the same text afterwards. A repeated key is
    refused: parsers disagree on which value wins.
    """

    def record(pairs: Any) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for key, value in pairs:
            if key in out:
                raise ValueError("repeated key")
            out[key] = value
        return out

    data = json.loads(text, object_pairs_hook=record) if text else {}
    if not isinstance(data, dict):
        raise TypeError("tool arguments must be a JSON object")
    return json_record(data)


async def _observe(hook: Optional[Callable[..., Any]], *args: Any) -> None:
    """Call an app hook. It only observes: an error it raises changes nothing."""
    if hook is None:
        return
    try:
        result = hook(*args)
        if inspect.isawaitable(result):
            await result
    except Exception:  # noqa: BLE001
        _logger.warning("a Guardian hook raised; ignored", exc_info=True)


class _Options:
    def __init__(self, on_ask: str, on_deny: str, on_approval_pending: Optional[Callable[..., Any]]) -> None:
        if on_ask not in ("raise", "result", "interrupt"):
            raise ValueError('on_ask takes "raise", "result" or "interrupt"')
        if on_deny not in ("result", "raise"):
            raise ValueError('on_deny takes "result" or "raise"')
        self.on_ask = on_ask
        self.on_deny = on_deny
        self.on_approval_pending = on_approval_pending


class _GovernedTool:
    """The state behind one governed ``FunctionTool`` (``self.tool``)."""

    def __init__(self, sdk: Any, inner: Any, guard: Any, guardian_name: str, options: _Options) -> None:
        self.sdk = sdk
        self.inner = inner
        self.guard = guard
        self.guardian_name = guardian_name
        self.options = options
        #: A tool with an output schema cannot return a plain message.
        self.strict_output = getattr(inner, "output_json_schema", None) is not None
        if self.strict_output and options.on_ask != "raise":
            raise ValueError(
                f'"{inner.name}" has an output schema, so a held call cannot be reported as a message: '
                'use on_ask="raise"'
            )
        if self.strict_output and guard._opts.mode_for(guardian_name) == "remote":
            raise ValueError(
                f'"{inner.name}" has an output schema and runs in remote mode. In remote mode the tool output '
                "is Guardian's record of the call, which the Agents SDK would check against that schema and "
                "refuse after Guardian performed the call. Remove the output type, or use in-process mode"
            )
        # The tool as Guardian runs it: its errors are raised, so a failed
        # call is never redeemed as if it had run. The governed tool applies
        # the original tool's failure policy afterwards.
        self.raw = copy.copy(inner)
        sdk.set_failure(self.raw, None)
        #: on_ask="interrupt": decisions taken when the SDK asked whether the
        #: call needs approval, waiting for the SDK to invoke the call.
        self.parked: Dict[Tuple[str, str], Tuple[_Call, Any]] = {}
        #: Tool invocations in flight, kept so a started tool is not collected
        #: when the SDK stops waiting for it.
        self.running: Set["asyncio.Future[Any]"] = set()
        self.tool = copy.copy(inner)
        self.tool.on_invoke_tool = self.on_invoke_tool
        if options.on_ask == "interrupt":
            self.tool.needs_approval = self.needs_approval
        elif callable(inner.needs_approval):
            self.tool.needs_approval = self._own_needs_approval

    # -- on_ask="interrupt": the decision is taken before the SDK invokes the call --

    @staticmethod
    def _key(call_id: Any, proposed: Dict[str, Any]) -> Tuple[str, str]:
        return (call_id if isinstance(call_id, str) else "", canonical_json(proposed))

    def _park(self, key: Tuple[str, str], call: _Call) -> None:
        handle = asyncio.get_running_loop().call_later(PARKED_SECONDS, self._expire, key, call)
        self.parked[key] = (call, handle)

    def _take(self, key: Tuple[str, str]) -> Optional[_Call]:
        entry = self.parked.pop(key, None)
        if entry is None:
            return None
        entry[1].cancel()
        return entry[0]

    def _expire(self, key: Tuple[str, str], call: _Call) -> None:
        entry = self.parked.get(key)
        if entry is not None and entry[0] is call:
            del self.parked[key]
            call.abandon()

    async def _own_needs_approval(self, context: Any, params: Dict[str, Any], call_id: str) -> bool:
        """The original tool's own ``needs_approval``, as the Agents SDK evaluates it.

        For a callable policy the SDK first checks what the tool's own
        validation would do to the arguments, and requires manual approval
        when it would default or convert one the policy did not see. That
        check is tied to the original tool's invoker, so the policy is
        evaluated against the original tool here. If this SDK version has no
        such evaluation, approval is required.
        """
        setting = self.inner.needs_approval
        if not callable(setting):
            return bool(setting)
        evaluate = self.sdk.evaluate_approval
        if evaluate is None:
            return True
        evaluation = await evaluate(self.inner, context, json.dumps(params), call_id)
        return evaluation.outcome != "invoke"

    async def needs_approval(self, context: Any, params: Dict[str, Any], call_id: str) -> bool:
        """Guardian's decision as the SDK's "does this call need approval".

        ``True`` (the SDK pauses the run) only when Guardian holds the call
        for a person. An allowed call waits at its gate and starts when the
        SDK invokes it; any other answer is reported at invocation.
        """
        if await self._own_needs_approval(context, params, call_id):
            return True  # the tool's own approval step comes first; Guardian is asked at invocation
        try:
            proposed = json_record(copy.deepcopy(params))
            key = self._key(call_id, proposed)
        except Exception:  # noqa: BLE001 - refused, and reported, at invocation
            return False
        entry = self.parked.get(key)
        if entry is not None:
            call = entry[0]
        else:
            call = _Call(self, proposed)
            self._park(key, call)
        try:
            await asyncio.wait({call.task, call.at_gate}, return_when=asyncio.FIRST_COMPLETED)
        except asyncio.CancelledError:
            self._take(key)
            call.abandon()
            raise
        task = call.task
        if not task.done() or task.cancelled() or task.exception() is not None:
            return False
        outcome = task.result()
        if outcome.decision != "ASK" or outcome.message is None:
            return False
        self._take(key)
        await self._held(outcome, call_id)
        return True

    async def _held(self, outcome: Outcome, call_id: Any) -> None:
        if outcome.request_id and isinstance(call_id, str):
            key = (self.tool.name, call_id)
            _held_requests[key] = outcome.request_id
            _held_requests.move_to_end(key)
            while len(_held_requests) > _HELD_LIMIT:
                _held_requests.popitem(last=False)
        await _observe(self.options.on_approval_pending, self.guardian_name, outcome.request_id)

    # -- invocation --

    async def on_invoke_tool(self, context: Any, text: str) -> Any:
        try:
            return await self._invoke(context, text)
        except Exception as error:
            return await self._failed(context, error)

    async def _invoke(self, context: Any, text: str) -> Any:
        name = self.guardian_name
        try:
            proposed = _parse_arguments(text)
        except Exception:  # noqa: BLE001 - arguments Guardian cannot read never run
            if self.strict_output:
                raise GuardianDenied(name, "ARGUMENTS_NOT_JSON") from None
            return f"Guardian could not read the arguments of {name} as JSON, so it was not proposed and did not run."
        call_id = getattr(context, "tool_call_id", None)
        call = self._take(self._key(call_id, proposed)) if self.parked else None
        if call is None:
            call = _Call(self, proposed)
        call.invoke(context, text)
        try:
            await asyncio.wait({call.task, call.at_gate}, return_when=asyncio.FIRST_COMPLETED)
        except asyncio.CancelledError:
            call.abandon()  # still deciding: a late ALLOW must not start the action
            if call.wants_tool and not call.finished.done():
                # Guardian's ALLOW reached the gate in the same loop iteration,
                # so the call is committed, but the tool was not started and
                # now never will be (it only starts below). End the tool step
                # that waits for it: nothing ran, nothing is redeemed.
                call.finished.cancel()
            raise
        if call.wants_tool and not call.task.done():
            # ALLOW, in-process: the original tool, with the text Guardian decided on.
            # In its own task: when the SDK stops waiting (its tool timeout,
            # a cancelled run) the tool is not cancelled. A sync tool runs in
            # a worker thread that cannot be stopped, so the action would
            # complete with nothing recorded. The tool's result reaches the
            # decision task either way, which then redeems the capability.
            running = asyncio.ensure_future(self.raw.on_invoke_tool(context, text))
            running.add_done_callback(call.tool_finished)
            self.running.add(running)
            running.add_done_callback(self.running.discard)
            await asyncio.wait({running})  # a cancellation here leaves the tool running
        try:
            # Shielded: past the gate the capability is redeemed (or Guardian
            # finishes the call) even when the SDK stops waiting.
            outcome = await asyncio.shield(call.task)
        except GuardianApprovalPending as pending:
            await _observe(self.options.on_approval_pending, name, pending.request_id)
            raise self._pending(pending, call) from None
        return await self._settle(call, outcome, call_id)

    def _pending(self, pending: GuardianApprovalPending, call: _Call) -> GuardianApprovalPending:
        """The pending approval handed to the app: ``resume()`` gives the tool's own output."""

        async def resume() -> ResumeResult:
            try:
                resumed = await pending.resume()
            except GuardianApprovalPending as again:
                raise self._pending(again, call) from None
            info = resumed.output.get("guardian") if isinstance(resumed.output, dict) else None
            if isinstance(info, dict) and info.get("decision") == "DENY":
                # The Guard hands a refusal back as data; resume() raises it.
                code = info.get("reason_code") or "DENIED"
                if code == "SERVICE_UNAVAILABLE":
                    raise GuardianUnavailable(pending.tool_name, request_id=pending.request_id)
                raise GuardianDenied(pending.tool_name, code, pending.request_id)
            # In-process the tool step kept the tool's output; in remote mode
            # the output is Guardian's record of the call it performed.
            output = call.output if resumed.output is _RAN else resumed.output
            return ResumeResult(resumed.request_id, resumed.receipt, output)

        return GuardianApprovalPending(
            pending.tool_name,
            pending.request_id,
            pending.arguments,
            resume,
            proposed_arguments=pending.proposed_arguments,
        )

    async def _settle(self, call: _Call, outcome: Outcome, call_id: Any) -> Any:
        name = self.guardian_name
        if outcome.message is None:
            return call.output  # the tool ran and Guardian recorded it
        if outcome.decision == "ALLOW":
            # Remote mode: Guardian performed the call; its record is the result.
            return outcome.message
        if outcome.reason_code == EXECUTION_OUTCOME_UNKNOWN:
            # Remote mode: the call failed where Guardian may already have
            # performed it. Never a denial, and never "did not run".
            if self.strict_output:
                raise GuardianExecutionFailed(
                    name, outcome.request_id or "", EXECUTION_OUTCOME_UNKNOWN, outcome_unknown=True
                )
            return outcome.message
        if outcome.decision == "ASK":
            await self._held(outcome, call_id)
            return outcome.message
        if outcome.reason_code == "SERVICE_UNAVAILABLE":
            if self.strict_output:
                raise GuardianUnavailable(name, request_id=outcome.request_id)
            return outcome.message
        if self.options.on_deny == "raise" or self.strict_output:
            raise GuardianDenied(name, outcome.reason_code or "DENIED", outcome.request_id)
        return outcome.message

    async def _failed(self, context: Any, error: Exception) -> Any:
        """An error out of the governed call, under the original tool's failure policy."""
        if _find(error, GuardianApprovalPending) is not None:
            raise error  # a pending approval always reaches the app
        sdk = self.sdk
        guardians = _find(error, GuardianDenied) is not None or _find(error, GuardianExecutionFailed) is not None
        if guardians:
            if self.strict_output:
                raise error
            if sdk.resolve_failure(self.inner, context) is sdk.default_failure:
                # Never the SDK's fixed message for a Guardian error: it does
                # not say whether the call ran.
                return guardian_error_message(error)
        result = await sdk.apply_failure(function_tool=self.inner, context=context, error=error)
        if result is None:
            raise error
        if not guardians:
            _logger.warning(
                "tool %s raised %s; the model was given the tool's failure message",
                self.tool.name,
                type(error).__name__,
            )
        return result


def create_guardian_tool(
    client: AsyncGuardianClient,
    *,
    connection_id: str,
    agent_name: str = "agent",
    purpose: Union[None, str, Callable[[str, Dict[str, Any]], str]] = None,
    adapter_id: Optional[str] = None,
    amount_args: Optional[Mapping[str, Mapping[str, Any]]] = None,
    mode: str = "in_process",
    modes: Optional[Mapping[str, str]] = None,
    tool_names: ToolNames = None,
    on_ask: OnAsk = "raise",
    on_deny: OnDeny = "result",
    on_approval_pending: Optional[Callable[[str, str], Any]] = None,
    on_receipt: Optional[Callable[[str, str, Optional[Dict[str, Any]]], Any]] = None,
    on_execution_error: Optional[Callable[[GuardianExecutionFailed], Any]] = None,
) -> Callable[..., Any]:
    """Bind the Guardian options once; the result wraps tools like ``function_tool``.

    ``governed(fn)``, ``@governed``, ``@governed(name_override=...)`` (any
    ``function_tool`` option) and ``governed(existing_function_tool)`` each
    return a governed ``FunctionTool``. Tools made by one factory share the
    held requests.

    :param client: an :class:`AsyncGuardianClient` (the agent's credential).
    :param connection_id: the Guardian connection the tools are registered on.
        For the default in-process mode register each tool once as
        "My own code (record-only)" and allow it for the agent.
    :param agent_name / purpose / adapter_id / amount_args: as for :class:`Guard`.
    :param mode: ``"in_process"`` (default): the tool runs here after ALLOW,
        then the capability is redeemed. ``"remote"``: the tool is a
        registered catalog entry Guardian calls itself; the local function
        never runs and the model gets Guardian's record of the call.
    :param modes: the mode per Guardian tool name, over ``mode``.
    :param tool_names: the Guardian tool name for an Agents SDK tool name,
        as a mapping or a function. Default: the same name.
    :param on_ask: ``"raise"`` (default) raises :class:`GuardianApprovalPending`
        out of the run; ``"result"`` tells the model the call is held;
        ``"interrupt"`` pauses the run as an Agents SDK interruption.
    :param on_deny: ``"result"`` (default) tells the model the call was
        refused; ``"raise"`` raises :class:`GuardianDenied` to the tool's
        ``failure_error_function`` (the default one still tells the model;
        ``failure_error_function=None`` fails the run).
    :param on_approval_pending: ``callback(tool_name, request_id)`` when a
        call is held, so the app can show the request to a person.
    :param on_receipt / on_execution_error: as for :class:`Guard`.
    """
    if not (
        isinstance(client, AsyncGuardianClient)
        or inspect.iscoroutinefunction(getattr(client, "request", None))
    ):
        raise TypeError("use an AsyncGuardianClient: tool calls in the Agents SDK are async")
    options = _Options(on_ask, on_deny, on_approval_pending)
    guard = build_guard(
        _GatedClient(client),  # type: ignore[arg-type]
        connection_id=connection_id,
        agent_name=agent_name,
        adapter_id=adapter_id,
        purpose=purpose,
        amount_args=amount_args,
        on_receipt=on_receipt,
        on_execution_error=on_execution_error,
        mode=mode,
        modes=modes,
        on_ask="raise" if on_ask == "raise" else "result",
        on_execution_failed="raise",
    )

    def wrap(tool: Any, tool_options: Dict[str, Any]) -> Any:
        sdk = _sdk()
        if isinstance(tool, sdk.FunctionTool):
            if tool_options:
                raise TypeError("function_tool options apply to a function, not to a FunctionTool")
            inner = tool
        elif callable(tool):
            inner = sdk.function_tool(tool, **tool_options)
        else:
            raise TypeError("guardian_tool takes a function or a FunctionTool")
        if isinstance(getattr(inner.on_invoke_tool, "__self__", None), _GovernedTool):
            raise TypeError(f'"{inner.name}" is already a Guardian tool')
        # The Agents SDK calls a generator function and hands the model the
        # generator object: the body never runs. Guardian would record a
        # call that did not happen, so such a tool is refused here.
        wrapped = getattr(inner, "__wrapped__", None)  # the function behind a function_tool
        if is_stream_function(wrapped) or is_stream_function(getattr(wrapped, "__call__", None)):
            raise TypeError(
                f'"{inner.name}" is a generator function. The Agents SDK does not consume a tool stream, '
                "so its body would never run: return the result instead"
            )
        name = resolve_tool_name(tool_names, inner.name)
        return _GovernedTool(sdk, inner, guard, name, options).tool

    def governed(tool: Any = None, **tool_options: Any) -> Any:
        if tool is None:
            return lambda fn: wrap(fn, tool_options)
        return wrap(tool, tool_options)

    return governed


def guardian_tool(tool: Any, client: AsyncGuardianClient, **options: Any) -> Any:
    """A governed ``FunctionTool`` from a function or a ``FunctionTool``.

    ``options`` are the Guardian options of :func:`create_guardian_tool`
    (``connection_id`` is required) and, for a function, any option of the
    Agents SDK's ``function_tool``.
    """
    names = inspect.signature(create_guardian_tool).parameters
    guardian_options = {key: options.pop(key) for key in list(options) if key in names}
    return create_guardian_tool(client, **guardian_options)(tool, **options)
