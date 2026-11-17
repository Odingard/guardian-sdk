"""Guardian for Semantic Kernel: a function invocation filter.

Semantic Kernel (``semantic-kernel`` on PyPI, Python 3.11+) runs every
function invocation filter around each kernel function call, including the
calls the model asks for through automatic function calling.
:class:`GuardianFunctionInvocationFilter` asks Guardian about the call
before the function runs::

    from semantic_kernel.filters import FilterTypes
    from odingard_guardian import AsyncGuardianClient
    from odingard_guardian.semantic_kernel import GuardianFunctionInvocationFilter

    guardian = GuardianFunctionInvocationFilter(
        AsyncGuardianClient(credential=os.environ["GUARDIAN_AGENT_CREDENTIAL"]),
        connection_id=os.environ["GUARDIAN_CONNECTION_ID"],
    )
    kernel.add_filter(FilterTypes.FUNCTION_INVOCATION, guardian)

* ALLOW: the function runs once with the arguments Guardian decided on,
  then the capability is redeemed and the decision recorded.
* ASK: the function does not run; its result tells the model the call is
  held for a person. After the person approves, the same call (same
  function, same arguments) claims the approved request and runs.
* DENY, or Guardian unreachable: the function does not run and its result
  says so.

Prompt functions (``is_prompt``) pass through without a decision: they call
the model, and the native functions the model then asks for are decided
one by one. A streaming invocation (``invoke_stream``) of a native function
is refused, because the function would run after the filter returns.

Add this filter after the others: filters added later run closer to the
function, between Guardian's decision and the call. If one of them changes
the arguments, the call raises once the function returns, and Guardian
records no execution for it.
"""

from __future__ import annotations

import copy
from typing import Any, Awaitable, Callable, Dict, Mapping, Optional, Union

from semantic_kernel.filters import FunctionInvocationContext
from semantic_kernel.functions import FunctionResult

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
from .guard import GuardianDenied, GuardianExecutionFailed

__all__ = ["GuardianFunctionInvocationFilter", "default_tool_name"]


def default_tool_name(plugin_name: Optional[str], function_name: str) -> str:
    """``plugin-function`` (Semantic Kernel's fully qualified name), or the function name alone."""
    return f"{plugin_name}-{function_name}" if plugin_name else function_name


class GuardianFunctionInvocationFilter:
    """A Semantic Kernel function invocation filter that sends each native function call to Guardian before it runs.

    Register it with ``kernel.add_filter(FilterTypes.FUNCTION_INVOCATION, guardian)``.

    :param client: an :class:`AsyncGuardianClient` (the agent's credential).
    :param connection_id: the Guardian connection the functions are
        registered on. Register each one once as "My own code
        (record-only)" and allow it for the agent.
    :param agent_name / purpose / adapter_id: as for :class:`Guard`.
    :param amount_args: dollar amounts on tools, by Guardian tool name,
        exactly as set in the Guardian console (see :class:`Guard`).
    :param tool_names: the Guardian tool name for Semantic Kernel's fully
        qualified function name (``plugin-function``), as a mapping or a
        function. Default: that name.
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
        on_receipt: Optional[Callable[[str, str, Optional[Dict[str, Any]]], Any]] = None,
        on_execution_error: Optional[Callable[[GuardianExecutionFailed], Any]] = None,
    ) -> None:
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

    @staticmethod
    def _parameters(context: FunctionInvocationContext) -> Dict[str, Any]:
        """The arguments the function receives: its own parameters, not other kernel arguments."""
        names = [p.name for p in context.function.metadata.parameters if p.name]
        return {name: context.arguments[name] for name in names if name in context.arguments}

    async def __call__(
        self,
        context: FunctionInvocationContext,
        next: Callable[[FunctionInvocationContext], Awaitable[None]],  # noqa: A002 - Semantic Kernel's name
    ) -> None:
        metadata = context.function.metadata
        if metadata.is_prompt:
            await next(context)
            return
        tool_name = resolve_tool_name(
            self._tool_names, default_tool_name(metadata.plugin_name, metadata.name)
        )
        if context.is_streaming:
            raise GuardianDenied(
                tool_name,
                "STREAMING_NOT_GOVERNED",
                hint="Guardian governs invoke(), not invoke_stream(), for native functions. Nothing ran.",
            )

        def refuse(message: str) -> None:
            context.result = FunctionResult(function=metadata, value=message)

        try:
            proposed = json_record(self._parameters(context))
            decided = {name: copy.deepcopy(value) for name, value in self._parameters(context).items()}
        except Exception:  # noqa: BLE001 - arguments Guardian cannot read never run
            refuse(
                f"Guardian could not read the arguments of {tool_name} as JSON, so it was not "
                "proposed and did not run."
            )
            return

        async def run_function() -> None:
            # The function runs with the arguments Guardian decided on.
            for name, value in decided.items():
                context.arguments[name] = copy.deepcopy(value)
            await next(context)
            if not same_record(json_record(self._parameters(context)), proposed):
                raise ArgumentsChangedAfterDecision(tool_name)

        try:
            outcome = await decide_and_run(self._guard, tool_name, proposed, run_function)
        except ArgumentsChangedAfterDecision:
            raise RuntimeError(
                f"The arguments of {tool_name} changed after Guardian decided on them. Add "
                "Guardian's filter after any filter that changes arguments. Guardian recorded "
                "no execution for this call."
            ) from None
        if outcome.message is not None:
            refuse(outcome.message)
