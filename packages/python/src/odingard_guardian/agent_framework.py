"""Guardian for Microsoft Agent Framework: function middleware.

Agent Framework (``agent-framework`` on PyPI, Python 3.11+) runs every
function middleware around each tool call in its function-calling loop.
:class:`GuardianFunctionMiddleware` asks Guardian about the call before the
tool runs::

    from agent_framework import Agent
    from odingard_guardian import AsyncGuardianClient
    from odingard_guardian.agent_framework import GuardianFunctionMiddleware

    guardian = GuardianFunctionMiddleware(
        AsyncGuardianClient(credential=os.environ["GUARDIAN_AGENT_CREDENTIAL"]),
        connection_id=os.environ["GUARDIAN_CONNECTION_ID"],
        agent_name="billing-agent",
    )
    agent = Agent(client=..., tools=[refund_order], middleware=[guardian])

* ALLOW: the tool runs once with the arguments Guardian decided on, then
  the capability is redeemed and the decision recorded.
* ASK: the tool does not run. The model is told the call is held for a
  person; after the person approves, the same call (same tool, same
  arguments) claims the approved request and runs. With ``on_ask="stop"``
  the agent run stops instead, with that message as the tool result.
* DENY, or Guardian unreachable: the tool does not run and the model is
  told so (``on_deny="stop"`` stops the run).

After ALLOW this middleware runs the tool itself (``FunctionTool.invoke``)
with the arguments Guardian decided on, and does not call ``call_next``:
nothing can change the arguments between the decision and the tool. Function
middleware listed after it, and middleware passed to ``agent.run``, does not
run for the call. Put middleware that should see the call (argument repair,
logging) before Guardian's in the agent's list.

A tool that is a generator function (``def`` or ``async def`` with
``yield``) is refused before anything is proposed: Agent Framework does not
iterate a tool's generator, so its body would never run.
"""

from __future__ import annotations

import copy
import inspect
from typing import Any, Awaitable, Callable, Dict, Literal, Mapping, Optional, Union

from agent_framework import FunctionInvocationContext, FunctionMiddleware, MiddlewareTermination

from ._framework import (
    ToolNames,
    build_guard,
    decide_and_run,
    is_stream_function,
    json_record,
    resolve_tool_name,
)
from .client import AsyncGuardianClient
from .guard import GuardianExecutionFailed

__all__ = ["GuardianFunctionMiddleware"]

Stop = Literal["result", "stop"]


class GuardianFunctionMiddleware(FunctionMiddleware):
    """Agent Framework function middleware that sends each tool call to Guardian before it runs.

    :param client: an :class:`AsyncGuardianClient` (the agent's credential).
    :param connection_id: the Guardian connection the tools are registered on
        (Guardian console → Connections). Register each tool once as
        "My own code (record-only)" and allow it for the agent.
    :param agent_name / purpose / adapter_id: as for :class:`Guard`.
    :param amount_args: dollar amounts on tools, by Guardian tool name, exactly
        as set in the Guardian console (see :class:`Guard`).
    :param tool_names: the Guardian tool name for an Agent Framework function
        name, as a mapping or a function. Default: the same name.
    :param on_ask: ``"result"`` (default) tells the model the call is held;
        ``"stop"`` also stops the agent run.
    :param on_deny: ``"result"`` (default) tells the model the call was
        refused; ``"stop"`` also stops the agent run.
    :param on_approval_pending: ``callback(tool_name, request_id)`` when a
        call is held, so the app can show the request to a person.
    :param on_receipt / on_execution_error: as for :class:`Guard`.
    """

    def __init__(
        self,
        client: AsyncGuardianClient,
        *,
        connection_id: str,
        agent_name: str = "agent",
        purpose: Union[None, str, Callable[[str, Dict[str, Any]], str]] = None,
        adapter_id: Optional[str] = None,
        amount_args: Optional[Mapping[str, Mapping[str, Any]]] = None,
        tool_names: ToolNames = None,
        on_ask: Stop = "result",
        on_deny: Stop = "result",
        on_approval_pending: Optional[Callable[[str, str], Any]] = None,
        on_receipt: Optional[Callable[[str, str, Optional[Dict[str, Any]]], Any]] = None,
        on_execution_error: Optional[Callable[[GuardianExecutionFailed], Any]] = None,
    ) -> None:
        if on_ask not in ("result", "stop") or on_deny not in ("result", "stop"):
            raise ValueError('on_ask and on_deny take "result" or "stop"')
        self._guard = build_guard(
            client,
            connection_id=connection_id,
            agent_name=agent_name,
            adapter_id=adapter_id,
            purpose=purpose,
            amount_args=amount_args,
            on_receipt=on_receipt,
            on_execution_error=on_execution_error,
        )
        self._tool_names = tool_names
        self._on_ask = on_ask
        self._on_deny = on_deny
        self._on_approval_pending = on_approval_pending

    async def process(
        self,
        context: FunctionInvocationContext,
        call_next: Callable[[], Awaitable[None]],
    ) -> None:
        tool_name = resolve_tool_name(self._tool_names, context.function.name)
        if is_stream_function(getattr(context.function, "func", None)):
            # Agent Framework hands a generator tool's generator to the model
            # as text and never iterates it: the body would not run, and
            # Guardian would record a call that did not happen.
            context.result = (
                f"{tool_name} is a generator function. Agent Framework does not iterate a tool's "
                "generator, so it would not run. Nothing was proposed or run."
            )
            return
        try:
            proposed = json_record(context.arguments)
            decided = copy.deepcopy(context.arguments)
        except Exception:  # noqa: BLE001 - arguments Guardian cannot read never run
            context.result = (
                f"Guardian could not read the arguments of {tool_name} as JSON, so it was not "
                "proposed and did not run."
            )
            return

        async def run_tool() -> None:
            # Run the tool here, not through call_next: middleware after this
            # one could otherwise change the arguments after the decision.
            context.arguments = copy.deepcopy(decided)
            context.result = await context.function.invoke(
                arguments=copy.deepcopy(decided),
                context=context,
                tool_call_id=context.metadata.get("call_id"),
            )

        outcome = await decide_and_run(self._guard, tool_name, proposed, run_tool)
        if outcome.message is None:
            return  # ALLOW: the tool ran and Guardian recorded it
        context.result = outcome.message
        if outcome.decision == "ASK":
            if self._on_approval_pending is not None and outcome.request_id:
                pending = self._on_approval_pending(tool_name, outcome.request_id)
                if inspect.isawaitable(pending):
                    await pending
            if self._on_ask == "stop":
                raise MiddlewareTermination(outcome.message, result=outcome.message)
        elif outcome.decision == "DENY" and self._on_deny == "stop":
            raise MiddlewareTermination(outcome.message, result=outcome.message)
