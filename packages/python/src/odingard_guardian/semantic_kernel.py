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

Add this filter last. Filters added later run closer to the function, so
they would run between Guardian's decision and the call: while another
function invocation filter was added after Guardian's, every native function
call is refused before anything is proposed or run.

``mode="remote"`` (or ``modes={"billing-refund_order": "remote"}``) is for a
function registered on the Guardian connection as a call Guardian performs
itself. After ALLOW Guardian performs it; the kernel function never runs,
and its result is ``{"guardian": {"decision": "ALLOW", "request_id": …,
"tool_name": …, "receipt": …}}`` as JSON text.
"""

from __future__ import annotations

import copy
from typing import Any, Awaitable, Callable, Dict, Mapping, Optional, Union

from semantic_kernel.filters import FunctionInvocationContext
from semantic_kernel.functions import FunctionResult

from ._framework import (
    ScopeOption,
    ToolNames,
    build_guard,
    decide_and_run,
    json_record,
    resolve_scope,
    resolve_tool_name,
)
from .client import AsyncGuardianClient
from .guard import GuardianDenied, GuardianExecutionFailed, Mode

__all__ = ["GuardianFunctionInvocationFilter", "default_tool_name"]

#: Parameters Semantic Kernel fills in itself, never from the call's arguments.
_INJECTED = frozenset({"kernel", "service", "execution_settings"})


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
    :param scope: ``callback(context)`` returning the scope of a call: the
        conversation or user it belongs to, any hashable value, for
        example ``lambda context: context.arguments.get("user_id")``. A
        held call is claimed only by the same call in the same scope.
        Semantic Kernel's filter context does not identify a
        conversation, so without this option a held call is never
        claimed by a later call: each call asks for its own approval.
    :param mode / modes: ``"in_process"`` (default): the function runs in
        your process after ALLOW. ``"remote"``: Guardian performs the call
        itself and the kernel function never runs; its result is Guardian's
        result. ``modes`` sets it per Guardian tool name.
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
        mode: Mode = "in_process",
        modes: Optional[Mapping[str, Mode]] = None,
        scope: ScopeOption = None,
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
            mode=mode,
            modes=modes,
        )
        self._tool_names = tool_names
        self._scope = scope

    @staticmethod
    def _parameters(context: FunctionInvocationContext) -> Dict[str, Any]:
        """The arguments the function receives.

        Its own parameters, without the ones Semantic Kernel injects
        (``kernel``, ``service``, ``execution_settings``). A function with an
        ``arguments`` parameter receives every kernel argument, so then every
        kernel argument is proposed.
        """
        names = [p.name for p in context.function.metadata.parameters if p.name]
        if "arguments" in names:
            return dict(context.arguments.items())
        return {
            name: context.arguments[name]
            for name in names
            if name not in _INJECTED and name in context.arguments
        }

    def _innermost(self, context: FunctionInvocationContext) -> bool:
        """Whether this filter runs last, right before the function.

        The kernel keeps the most recently added filter at the start of its list, and that
        one wraps the function directly.
        """
        filters = getattr(context.kernel, "function_invocation_filters", None)
        return bool(filters) and filters[0][1] is self

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

        if not self._innermost(context):
            refuse(
                f"{tool_name} did not run: another function invocation filter was added after "
                "Guardian's, so it would run between Guardian's decision and the function. Add "
                "Guardian's filter last. Nothing was proposed or run."
            )
            return

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
            await next(context)  # this filter is the last one: next is the function

        # Semantic Kernel's filter context names no conversation, so the
        # scope comes from the app's ``scope`` option or is unknown.
        scope = resolve_scope(self._scope, context)
        outcome = await decide_and_run(self._guard, tool_name, proposed, run_function, scope=scope)
        if outcome.message is not None:
            # A refusal, a call that could not be confirmed, or (remote mode)
            # Guardian's result for the call it performed.
            refuse(outcome.message)
