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

Put this middleware last, after any middleware that repairs or changes
arguments: middleware listed after it runs between Guardian's decision and
the tool. If one of them changes the arguments, the run is aborted with
``MiddlewareFailure`` once the tool returns, and Guardian records no
execution for that call.
"""

from __future__ import annotations

import copy
import inspect
from typing import Any, Awaitable, Callable, Dict, Literal, Mapping, Optional, Union

from agent_framework import FunctionInvocationContext, FunctionMiddleware, MiddlewareTermination

from ._framework import (
    ArgumentsChangedAfterDecision,
    ToolNames,
    build_guard,
    decide_and_run,
    json_record,
    resolve_tool_name,
    same_record,
)
from .client import AsyncGuardianClient
from .guard import GuardianExecutionFailed

try:  # agent-framework-core 1.x: the fail-closed abort signal
    from agent_framework import MiddlewareFailure as _Abort
except ImportError:  # pragma: no cover - older releases
    _Abort = RuntimeError  # type: ignore[misc,assignment]

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
            # The tool runs with the arguments Guardian decided on.
            context.arguments = copy.deepcopy(decided)
            await call_next()
            if not same_record(json_record(context.arguments), proposed):
                raise ArgumentsChangedAfterDecision(tool_name)

        try:
            outcome = await decide_and_run(self._guard, tool_name, proposed, run_tool)
        except ArgumentsChangedAfterDecision:
            raise _Abort(
                f"The arguments of {tool_name} changed after Guardian decided on them. Put "
                "Guardian's middleware after any middleware that changes arguments. Guardian "
                "recorded no execution for this call."
            ) from None
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
