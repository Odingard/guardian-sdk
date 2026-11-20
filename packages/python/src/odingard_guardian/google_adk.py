"""Guardian for Google ADK: a plugin that decides every tool call.

Google's Agent Development Kit (``google-adk`` on PyPI, Python 3.11+) runs
the ``before_tool_callback`` of every plugin registered on the ``App`` before
each tool call of every agent, ahead of the agents' own callbacks.
:class:`GuardianPlugin` asks Guardian about the call there::

    from google.adk.apps import App
    from google.adk.runners import Runner
    from odingard_guardian import AsyncGuardianClient
    from odingard_guardian.google_adk import GuardianPlugin

    guardian = GuardianPlugin(
        AsyncGuardianClient(credential=os.environ["GUARDIAN_AGENT_CREDENTIAL"]),
        connection_id=os.environ["GUARDIAN_CONNECTION_ID"],
        agent_name="billing-agent",
    )
    app = App(name="billing", root_agent=agent, plugins=[guardian])
    runner = Runner(app=app, session_service=session_service)

* ALLOW: the tool runs once with the arguments Guardian decided on, then
  the capability is redeemed and the decision recorded.
* ASK: the tool does not run. The model is told the call is held for a
  person; after the person approves, the same call (same tool, same
  arguments) claims the approved request and runs. With
  ``on_ask="confirmation"`` the run pauses on ADK's own tool confirmation
  request instead; answering it makes ADK repeat the call, which claims the
  approved request. The local answer never stands in for Guardian's
  approval: a call Guardian still holds stays held.
* DENY, or Guardian unreachable: the tool does not run and the model is
  told so.

A before-tool callback only decides before the tool; ADK would then run the
later callbacks and the tool itself. So after ALLOW this plugin runs the
tool itself (``tool.run_async``) with the arguments Guardian decided on and
returns its result as the callback's answer, which makes ADK skip its own
tool step: nothing can change the arguments between the decision and the
tool, and the capability is redeemed right after the tool returns. The
callback answers every call, so ``before_tool_callback`` of plugins listed
after Guardian's, and of the agents, does not run for a governed call. Put
plugins that should see or repair the call before Guardian's in the list.
``after_tool_callback`` and ``on_tool_error_callback`` of every plugin and
agent still run.

A generator function tool runs to its end inside ``tool.run_async`` in a run
that is not live, so it is recorded after it ended. In a live run
(``Runner.run_live``), or with an ``input_stream`` parameter, ADK starts the
stream in the background; such a call is refused before anything is proposed.

A held request belongs to the ADK session that made the call (app, user,
session id): the same tool and arguments from another user or session never
claims it. ``scope=`` sets another scope from the tool context; it is never
read from the tool call's arguments, which the model writes.

To govern one agent only, pass :meth:`GuardianPlugin.agent_before_tool_callback`
as that agent's ``before_tool_callback`` instead of registering the plugin.
"""

from __future__ import annotations

import asyncio
import contextvars
import copy
import inspect
import logging
from typing import Any, Callable, Dict, Literal, Mapping, Optional, Union

from google.adk.plugins.base_plugin import BasePlugin
from google.adk.tools.base_tool import BaseTool
from google.adk.tools.tool_context import ToolContext

from ._framework import (
    ToolNames,
    build_guard,
    decide_and_run,
    ScopeOption,
    is_stream_function,
    json_record,
    resolve_scope,
    resolve_tool_name,
)
from .client import AsyncGuardianClient
from .guard import GuardianExecutionFailed, Mode

__all__ = ["GuardianPlugin"]

_logger = logging.getLogger("odingard_guardian")

OnAsk = Literal["result", "confirmation"]

#: Nothing inherited: the call's own session decides its scope.
_NO_SCOPE: Any = object()

#: The scope of the call this plugin is running a tool for, so that calls made
#: inside it (an ``AgentTool`` runs its agent in a new session for every call)
#: keep the scope of the session that started them.
_SCOPE: "contextvars.ContextVar[Any]" = contextvars.ContextVar("odingard_guardian_adk_scope", default=_NO_SCOPE)

#: ADK's own answers for a tool that requires confirmation (``require_confirmation``).
_CONFIRMATION_REQUIRED = "This tool call requires confirmation, please approve or reject."
_CONFIRMATION_REJECTED = "This tool call is rejected."


def _refusal(tool_name: str, message: str, reason_code: str) -> Dict[str, Any]:
    return {
        "error": message,
        "guardian": {"decision": "DENY", "tool_name": tool_name, "reason_code": reason_code, "message": message},
    }


class GuardianPlugin(BasePlugin):
    """A Google ADK plugin that sends each tool call to Guardian before it runs.

    Register it on the ``App`` (``App(..., plugins=[guardian])``) to cover
    every agent and tool the runner drives.

    :param client: an :class:`AsyncGuardianClient` (the agent's credential).
    :param connection_id: the Guardian connection the tools are registered on
        (Guardian console → Connections).
    :param mode: ``"in_process"`` (default): the ADK tool is the action. It
        runs after ALLOW and the capability is redeemed after it returned.
        Register each tool once as "My own code (record-only)" and allow it
        for the agent. ``"remote"``: Guardian performs a registered catalog
        tool itself with the credential it holds; the ADK tool does not run
        and the model gets Guardian's result.
    :param modes: the mode for single tools, by Guardian tool name.
    :param agent_name / purpose / adapter_id: as for :class:`Guard`.
    :param amount_args: dollar amounts on tools, by Guardian tool name, exactly
        as set in the Guardian console (see :class:`Guard`).
    :param tool_names: the Guardian tool name for an ADK tool name, as a
        mapping or a function. Default: the same name.
    :param scope: ``callback(tool_context)`` returning the scope of a call:
        the session it belongs to, any hashable value. Read it from something
        your app sets (the session, its state set by your app, a
        ``contextvars.ContextVar``), never from the tool call's arguments,
        which the model writes. A held call is claimed only by the same call
        in the same scope. Default: the ADK session the call runs in, as
        ``(app_name, user_id, session id)``. An option that returns ``None``
        or an empty string, or raises, means the session is unknown: a held
        call is then never claimed by a later call.
    :param on_ask: ``"result"`` (default) tells the model the call is held;
        ``"confirmation"`` also asks for ADK's tool confirmation, which
        pauses the run until the app answers it.
    :param on_approval_pending: ``callback(tool_name, request_id)`` when a
        call is held, so the app can show the request to a person.
    :param on_receipt / on_execution_error: as for :class:`Guard`.
    :param name: the plugin's name in ADK (unique per app).
    """

    def __init__(
        self,
        client: AsyncGuardianClient,
        *,
        connection_id: str,
        mode: Mode = "in_process",
        modes: Optional[Mapping[str, Mode]] = None,
        agent_name: str = "agent",
        purpose: Union[None, str, Callable[[str, Dict[str, Any]], str]] = None,
        adapter_id: Optional[str] = None,
        amount_args: Optional[Mapping[str, Mapping[str, Any]]] = None,
        tool_names: ToolNames = None,
        scope: ScopeOption = None,
        on_ask: OnAsk = "result",
        on_approval_pending: Optional[Callable[[str, str], Any]] = None,
        on_receipt: Optional[Callable[[str, str, Optional[Dict[str, Any]]], Any]] = None,
        on_execution_error: Optional[Callable[[GuardianExecutionFailed], Any]] = None,
        name: str = "guardian",
    ) -> None:
        if on_ask not in ("result", "confirmation"):
            raise ValueError('on_ask takes "result" or "confirmation"')
        super().__init__(name=name)

        if scope is not None and not callable(scope):
            raise TypeError("scope takes a function of the ADK tool context")
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
        self._scope = scope
        self._tool_names = tool_names
        self._on_ask = on_ask
        self._on_approval_pending = on_approval_pending

    async def before_tool_callback(
        self,
        *,
        tool: BaseTool,
        tool_args: Dict[str, Any],
        tool_context: ToolContext,
    ) -> Optional[Dict[str, Any]]:
        """The plugin hook: decide the call and, after ALLOW, run the tool here."""
        return await self._govern(tool, tool_args, tool_context)

    async def agent_before_tool_callback(
        self, tool: BaseTool, args: Dict[str, Any], tool_context: ToolContext
    ) -> Optional[Dict[str, Any]]:
        """The same decision as an agent's ``before_tool_callback``.

        ``LlmAgent(..., before_tool_callback=guardian.agent_before_tool_callback)``
        governs that agent's tools only. Put it last in the agent's list of
        before-tool callbacks: the ones after it do not run.
        """
        return await self._govern(tool, args, tool_context)

    async def _govern(
        self, tool: BaseTool, tool_args: Dict[str, Any], tool_context: ToolContext
    ) -> Optional[Dict[str, Any]]:
        if type(tool).run_async is BaseTool.run_async:
            # Nothing to run: a tool name the model made up (ADK answers it
            # with the list of tools), or a tool that only changes the model
            # request and runs on the model's side.
            return None
        tool_name = resolve_tool_name(self._tool_names, tool.name)
        scope = _SCOPE.get()
        if scope is _NO_SCOPE:
            if self._scope is None:
                try:
                    default = _session_scope(tool_context)
                except Exception:  # noqa: BLE001 - a call that belongs to no known session never runs
                    _logger.warning("ADK gave no session for %s; the call did not run", tool_name, exc_info=True)
                    return _refusal(
                        tool_name,
                        f"{tool_name} did not run: its ADK session could not be read. Nothing was proposed.",
                        "SESSION_UNKNOWN",
                    )
                scope = resolve_scope(None, tool_context, default)
            else:
                scope = resolve_scope(self._scope, tool_context)
        try:
            held_locally = await self._confirmation_gate(tool, tool_args, tool_context)
        except Exception:  # noqa: BLE001 - a call that cannot be checked never runs
            _logger.warning("ADK's confirmation check of %s failed; the call did not run", tool_name, exc_info=True)
            return _refusal(
                tool_name,
                f"{tool_name} did not run: ADK could not check whether it needs confirmation. "
                "Nothing was proposed.",
                "CONFIRMATION_CHECK_FAILED",
            )
        if held_locally is not None:
            return held_locally
        in_process = self._guard._opts.mode_for(tool_name) != "remote"
        if in_process and _unconsumed_stream_tool(tool, tool_context):
            return _refusal(
                tool_name,
                f"{tool_name} did not run: it is a streaming tool that ADK starts and consumes outside "
                "the tool step in a live run, so Guardian cannot record it after it ran. Nothing was proposed.",
                "STREAMING_NOT_GOVERNED",
            )
        try:
            proposed = json_record(tool_args)
            decided = copy.deepcopy(tool_args)
        except Exception:  # noqa: BLE001 - a call Guardian cannot read never runs
            _logger.warning("Guardian could not propose %s; the call did not run", tool_name, exc_info=True)
            return _refusal(
                tool_name,
                f"Guardian could not read the arguments of {tool_name} as JSON, so it was not "
                "proposed and did not run.",
                "INVALID_ARGUMENTS",
            )

        ran: Dict[str, Any] = {}

        async def run_tool() -> None:
            # Run the tool here, not by returning None: callbacks after this
            # one could otherwise change the arguments after the decision.
            token = _SCOPE.set(scope)
            try:
                result = await tool.run_async(args=copy.deepcopy(decided), tool_context=tool_context)
            except asyncio.CancelledError as cancelled:
                # As ADK does for a tool it runs itself: every error callback
                # is told, for cleanup only, and the call stays cancelled.
                await _on_tool_cancelled(tool, tool_args, tool_context, cancelled)
                raise
            except Exception as error:
                ran["error"] = error
                raise
            finally:
                _SCOPE.reset(token)
            if inspect.isgenerator(result) or inspect.isasyncgen(result):
                if is_stream_function(getattr(tool, "func", None)):
                    # A generator tool handed back its stream unconsumed: none
                    # of its body ran. Raising here keeps the capability unredeemed.
                    closing = result.aclose() if inspect.isasyncgen(result) else result.close()
                    if inspect.isawaitable(closing):
                        await closing
                    ran["error"] = _StreamNotConsumed(tool_name)
                    raise ran["error"]
            ran["result"] = result

        try:
            outcome = await decide_and_run(self._guard, tool_name, proposed, run_tool, scope=scope)
        except Exception as error:
            if ran.get("error") is not error:
                raise
            if isinstance(error, _StreamNotConsumed):
                return _refusal(
                    tool_name,
                    f"{tool_name} did not run: it returned a stream that ADK did not consume in the tool "
                    "step. Guardian allowed the call, but nothing ran and nothing was recorded.",
                    "STREAMING_NOT_GOVERNED",
                )
            # The tool raised: nothing is redeemed. ADK's error callbacks see
            # the error as they would for a tool ADK ran itself.
            answer = await _on_tool_error(tool, tool_args, tool_context, error)
            if answer is None:
                raise
            return answer

        if outcome.message is None:
            return _tool_answer(tool, ran.get("result"))  # ALLOW: the tool ran and Guardian recorded it
        info = dict((outcome.result or {}).get("guardian") or {})
        if outcome.decision == "ALLOW" and not outcome.ran and outcome.result is not None and "message" not in info:
            # Remote mode: Guardian performed the call. The model gets its record.
            return outcome.result
        info.setdefault("decision", outcome.decision)
        info.setdefault("tool_name", tool_name)
        if outcome.reason_code:
            info.setdefault("reason_code", outcome.reason_code)
        info["message"] = outcome.message
        if outcome.decision == "ASK" and outcome.request_id:
            await self._held(tool_name, outcome.request_id, outcome.message, tool_context)
        return {"error": outcome.message, "guardian": info}

    async def _held(self, tool_name: str, request_id: str, message: str, tool_context: ToolContext) -> None:
        if self._on_approval_pending is not None:
            try:
                pending = self._on_approval_pending(tool_name, request_id)
                if inspect.isawaitable(pending):
                    await pending
            except Exception:  # noqa: BLE001 - hooks only observe; the call stays held
                _logger.warning("on_approval_pending raised for %s", tool_name, exc_info=True)
        if self._on_ask != "confirmation" or tool_context.tool_confirmation is not None:
            # ADK asks for one confirmation per call. Once it is answered, a
            # call Guardian still holds goes back to the model as held.
            return
        try:
            tool_context.request_confirmation(
                hint=(
                    f"{tool_name} is held for approval in Guardian (request_id {request_id}). "
                    "Approve it there, then confirm here to run it."
                ),
                payload={"guardian": {"request_id": request_id, "tool_name": tool_name}},
            )
            # As ADK does for its own confirmation: the pause is not a result
            # for the model to act on.
            tool_context.actions.skip_summarization = True
        except Exception:  # noqa: BLE001 - no pause; the model still gets the held message
            _logger.warning("ADK could not request confirmation for %s", tool_name, exc_info=True)

    async def _confirmation_gate(
        self, tool: BaseTool, tool_args: Dict[str, Any], tool_context: ToolContext
    ) -> Optional[Dict[str, Any]]:
        """ADK's confirmation gate, which it skips when a before-tool callback answers.

        A tool that requires confirmation (``require_confirmation``) is held
        here, before anything is proposed to Guardian, until the app
        confirmed the call. A call the app rejected does not run and is not
        proposed, whoever asked for the confirmation.
        """
        confirmation = tool_context.tool_confirmation
        if confirmation is not None and not confirmation.confirmed:
            return {"error": _CONFIRMATION_REJECTED}
        if confirmation is None and (
            await tool.check_require_confirmation(copy.deepcopy(tool_args), tool_context) is True
        ):
            tool_context.request_confirmation(
                hint=(
                    f"Please approve or reject the tool call {tool.name}() by responding with a "
                    "FunctionResponse with an expected ToolConfirmation payload."
                ),
            )
            tool_context.actions.skip_summarization = True
            return {"error": _CONFIRMATION_REQUIRED}
        return None


class _StreamNotConsumed(Exception):
    """A generator tool's ``run_async`` returned its stream instead of running it."""


def _unconsumed_stream_tool(tool: BaseTool, tool_context: ToolContext) -> bool:
    """Whether ``tool`` is a generator function tool that ADK would not consume inside ``run_async``.

    In a run that is not live, ADK runs a generator function tool to its
    end inside ``run_async``. In a live run (``Runner.run_live``), and for a
    tool with an ``input_stream`` parameter, ADK starts the stream as a
    background task instead.
    """
    func = getattr(tool, "func", None)
    if not (is_stream_function(func) or is_stream_function(getattr(func, "__call__", None))):
        return False
    try:
        if "input_stream" in inspect.signature(func).parameters:
            return True
    except (TypeError, ValueError):
        return True  # a signature that cannot be read: refuse rather than guess
    try:
        return tool_context.get_invocation_context().live_request_queue is not None
    except Exception:  # noqa: BLE001 - a run that cannot be told from a live one: refuse
        return True


def _tool_answer(tool: BaseTool, result: Any) -> Any:
    """The tool's result as a before-tool callback's answer, which must not be ``None``.

    ``None`` would tell ADK that no callback answered, and ADK would run
    the tool again.
    """
    if result is not None:
        return result
    if tool.is_long_running or getattr(tool, "_defers_response", False):
        return {}  # ADK waits for the real response of such a tool, as it does for None
    return {"result": None}  # what ADK itself tells the model for None


def _session_scope(tool_context: ToolContext) -> Any:
    """The ADK session a call belongs to: app, user and session id."""
    session = tool_context.session
    scope = (session.app_name, session.user_id, session.id)
    if not all(isinstance(part, str) and part for part in scope):
        raise ValueError("the ADK session has no app name, user id or session id")
    return scope


async def _on_tool_cancelled(
    tool: BaseTool, tool_args: Dict[str, Any], tool_context: ToolContext, cancelled: BaseException
) -> None:
    """Tell every ``on_tool_error_callback`` (plugins, then the agent) that the tool was cancelled.

    For cleanup only, as in ADK: what a callback returns is ignored, and one
    that raises or is cancelled does not stop the others.
    """
    try:
        context = tool_context.get_invocation_context()
        callbacks = [
            (getattr(plugin, "on_tool_error_callback", None), "tool_args")
            for plugin in context.plugin_manager.plugins
        ]
        callbacks += [
            (callback, "args") for callback in getattr(context.agent, "canonical_on_tool_error_callbacks", None) or ()
        ]
    except Exception:  # noqa: BLE001 - the cancellation propagates regardless
        _logger.warning("could not reach ADK's error callbacks for cancelled %s", tool.name, exc_info=True)
        return
    for callback, args_name in callbacks:
        if callback is None:
            continue
        try:
            pending = callback(**{"tool": tool, args_name: tool_args, "tool_context": tool_context, "error": cancelled})
            if inspect.isawaitable(pending):
                await pending
        except (Exception, asyncio.CancelledError):  # noqa: BLE001 - cleanup only
            _logger.warning("an on_tool_error_callback failed while %s was being cancelled", tool.name, exc_info=True)


async def _on_tool_error(
    tool: BaseTool, tool_args: Dict[str, Any], tool_context: ToolContext, error: Exception
) -> Optional[Dict[str, Any]]:
    """Run ADK's ``on_tool_error_callback`` chain (plugins, then the agent) for a tool this plugin ran."""
    context = tool_context.get_invocation_context()
    answer = await context.plugin_manager.run_on_tool_error_callback(
        tool=tool, tool_args=tool_args, tool_context=tool_context, error=error
    )
    if answer is not None:
        return answer
    for callback in getattr(context.agent, "canonical_on_tool_error_callbacks", None) or ():
        answer = callback(tool=tool, args=tool_args, tool_context=tool_context, error=error)
        if inspect.isawaitable(answer):
            answer = await answer
        if answer is not None:
            return answer
    return None
