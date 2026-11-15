"""A Guardian-aware ``failure_error_function`` for the OpenAI Agents SDK.

The Agents SDK's default ``failure_error_function`` tells the model "An
error occurred while running the tool. Please try again." for every
exception. After Guardian allowed a call that then ran (or may have run),
that message makes the model call the tool again, which is a new request
and can repeat the action. Pass this function instead::

    from agents import function_tool
    from odingard_guardian.openai_agents import guardian_failure_error_function

    tool = function_tool(pay_invoice, failure_error_function=guardian_failure_error_function)

It does not import the Agents SDK, so this module works with any version.

* :class:`GuardianApprovalPending` is re-raised, so the pending approval
  (and its ``resume()``) reaches your code.
* :class:`GuardianExecutionFailed`: the model is told the call ran (or may
  have run) and must not be called again.
* :class:`GuardianDenied`: the model is told the call did not run and not to
  retry it, or, when Guardian could not be reached, to try again later.
* Anything else gets the Agents SDK's usual message, or your ``fallback``.
"""

from __future__ import annotations

import inspect
from typing import Any, Callable, Optional

from .guard import (
    GuardianApprovalPending,
    GuardianDenied,
    GuardianExecutionFailed,
    execution_failed_message,
)

__all__ = [
    "DEFAULT_TOOL_ERROR_MESSAGE",
    "guardian_error_message",
    "guardian_failure_error_function",
    "make_guardian_failure_error_function",
]

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
