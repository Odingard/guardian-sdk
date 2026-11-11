"""A call that ran (or may have run) is never reported as "try again".

Covers ``on_execution_failed``, the ``on_execution_error`` hook, the
Guardian-aware ``failure_error_function`` for the OpenAI Agents SDK, and the
client's handling of server errors and unknown decisions. Guardian's HTTP
answers are scripted with ``httpx.MockTransport``.
"""

import asyncio
import json
import threading

import httpx
import pytest

from odingard_guardian import (
    AsyncGuardianClient,
    Guard,
    GuardianClient,
    GuardianDenied,
    GuardianExecutionFailed,
)
from odingard_guardian.guard import GuardianApprovalPending
from odingard_guardian.openai_agents import (
    DEFAULT_TOOL_ERROR_MESSAGE,
    guardian_failure_error_function,
    make_guardian_failure_error_function,
)

CONNECTION = "pcn_0123456789abcdef0123456789abcdef"
CREDENTIAL = "gac1.test-credential"
ARGS = {"invoice_id": "INV-1", "amount_cents": 48000, "payee_id": "acme"}


class Server:
    """Scripted Guardian. ``plan`` maps a path to a list of responses (or callables)."""

    def __init__(self, plan):
        self.plan = {k: list(v) for k, v in plan.items()}
        self.calls = []
        self.lock = threading.Lock()

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content or b"null")
        with self.lock:
            self.calls.append((request.url.path, body))
            queue = self.plan[request.url.path]
            item = queue.pop(0) if len(queue) > 1 else queue[0]
        if callable(item):
            return item(request, body)
        return httpx.Response(200, json=item)


def allow(request, body):
    return httpx.Response(
        200,
        json={"ok": True, "decision": "ALLOW", "requestId": body["requestId"], "capabilityToken": "gcap1.TOKEN"},
    )


def receipt(status="sent-verified"):
    def respond(request, body):
        return httpx.Response(
            200, json={"ok": True, "receipt": {"schemaVersion": 1, "requestId": body["requestId"], "status": status}}
        )

    return respond


def network_down(request, body):
    raise httpx.ConnectError("connection reset", request=request)


def make_client(server):
    return GuardianClient(credential=CREDENTIAL, base_url="https://guardian.test", transport=httpx.MockTransport(server))


def payments(guard, effects):
    @guard("pay_invoice")
    def pay_invoice(invoice_id: str, amount_cents: int, payee_id: str) -> str:
        """Pay an invoice."""
        effects.append((invoice_id, amount_cents, payee_id))
        return f"paid {invoice_id}"

    return pay_invoice


def no_retry(message: str) -> None:
    assert "try again" not in message.lower()
    assert "Do not call it again" in message


# --- in-process: the function ran, recording failed -------------------------


def test_recording_failure_after_the_effect_says_it_ran_and_calls_the_hook():
    server = Server({"/v1/agent/requests": [allow], "/v1/agent/execute": [network_down]})
    seen = []
    guard = Guard(
        make_client(server),
        connection_id=CONNECTION,
        on_ask="result",
        on_deny="result",
        on_execution_error=seen.append,
    )
    effects = []
    out = payments(guard, effects)(**ARGS)
    assert effects == [("INV-1", 48000, "acme")]
    g = out["guardian"]
    assert g["decision"] == "ALLOW" and g["outcome"] == "ran_unrecorded" and g["local_effect_ran"] is True
    assert g["reason_code"] == "SERVICE_UNAVAILABLE" and g["request_id"].startswith("req_")
    assert g["message"].startswith("pay_invoice ran, but Guardian could not record it")
    no_retry(g["message"])
    assert len(seen) == 1 and isinstance(seen[0], GuardianExecutionFailed) and seen[0].local_effect_ran


def test_on_execution_failed_result_works_with_raising_deny():
    server = Server({"/v1/agent/requests": [allow], "/v1/agent/execute": [network_down]})
    guard = Guard(make_client(server), connection_id=CONNECTION, on_execution_failed="result")
    out = payments(guard, [])(**ARGS)
    no_retry(out["guardian"]["message"])


def test_on_execution_failed_raise_overrides_result_deny_and_still_calls_the_hook():
    server = Server({"/v1/agent/requests": [allow], "/v1/agent/execute": [network_down]})
    seen = []
    guard = Guard(
        make_client(server),
        connection_id=CONNECTION,
        on_deny="result",
        on_execution_failed="raise",
        on_execution_error=seen.append,
    )
    with pytest.raises(GuardianExecutionFailed) as err:
        payments(guard, [])(**ARGS)
    assert err.value.local_effect_ran is True and seen == [err.value]


def test_a_failing_hook_does_not_change_the_outcome():
    server = Server({"/v1/agent/requests": [allow], "/v1/agent/execute": [network_down]})

    def broken(_err):
        raise RuntimeError("hook failed")

    guard = Guard(make_client(server), connection_id=CONNECTION, on_deny="result", on_execution_error=broken)
    no_retry(payments(guard, [])(**ARGS)["guardian"]["message"])


# --- remote: Guardian performed the call, outcome not confirmed --------------


@pytest.mark.parametrize("status", ["outcome-pending", "outcome-unconfirmed", "not-sent"])
def test_remote_unconfirmed_status_says_it_may_have_run(status):
    server = Server({"/v1/agent/requests": [allow], "/v1/agent/execute": [receipt(status)]})
    seen = []
    guard = Guard(
        make_client(server), connection_id=CONNECTION, mode="remote", on_deny="result", on_execution_error=seen.append
    )
    out = payments(guard, [])(**ARGS)["guardian"]
    assert out["outcome"] == "unknown" and out["local_effect_ran"] is False
    assert out["reason_code"] == "EXECUTION_" + status.upper().replace("-", "_")
    assert out["receipt"]["status"] == status
    assert "It may have run" in out["message"]
    no_retry(out["message"])
    assert len(seen) == 1


def test_remote_lost_execute_reply_says_it_may_have_run():
    server = Server({"/v1/agent/requests": [allow], "/v1/agent/execute": [network_down]})
    guard = Guard(make_client(server), connection_id=CONNECTION, mode="remote", on_deny="result")
    out = payments(guard, [])(**ARGS)["guardian"]
    assert "It may have run" in out["message"]
    no_retry(out["message"])


async def test_async_guard_reports_the_same_and_awaits_the_hook():
    seen = []

    async def hook(err):
        seen.append(err)

    server = Server({"/v1/agent/requests": [allow], "/v1/agent/execute": [network_down]})
    client = AsyncGuardianClient(
        credential=CREDENTIAL, base_url="https://guardian.test", transport=httpx.MockTransport(server)
    )
    guard = Guard(client, connection_id=CONNECTION, on_deny="result", on_execution_error=hook)
    effects = []

    @guard("pay_invoice")
    async def pay_invoice(invoice_id: str, amount_cents: int, payee_id: str) -> str:
        effects.append(invoice_id)
        return "paid"

    out = await pay_invoice(**ARGS)
    assert effects == ["INV-1"] and out["guardian"]["local_effect_ran"] is True
    no_retry(out["guardian"]["message"])
    assert len(seen) == 1


# --- the failure_error_function ----------------------------------------------


def run(coro):
    return asyncio.run(coro)


def test_failure_error_function_messages():
    ran = GuardianExecutionFailed("pay_invoice", "req_1", "CAPABILITY_REVOKED", local_effect_ran=True)
    no_retry(run(guardian_failure_error_function(None, ran)))
    maybe = GuardianExecutionFailed("pay_invoice", "req_1", "EXECUTION_OUTCOME_PENDING")
    message = run(guardian_failure_error_function(None, maybe))
    assert "may have run" in message
    no_retry(message)
    denied = run(guardian_failure_error_function(None, GuardianDenied("pay_invoice", "POLICY_DENY")))
    assert "did not run" in denied and "Do not retry" in denied
    down = run(guardian_failure_error_function(None, GuardianDenied("pay_invoice", "SERVICE_UNAVAILABLE")))
    assert "did not run" in down and "Try again later" in down
    assert run(guardian_failure_error_function(None, ValueError("x"))) == DEFAULT_TOOL_ERROR_MESSAGE


def test_failure_error_function_unwraps_and_reraises_pending():
    try:
        try:
            raise GuardianExecutionFailed("pay_invoice", "req_1", "X", local_effect_ran=True)
        except GuardianExecutionFailed as inner:
            raise RuntimeError("wrapped by the framework") from inner
    except RuntimeError as wrapped:
        no_retry(run(guardian_failure_error_function(None, wrapped)))
    pending = GuardianApprovalPending("pay_invoice", "req_held", {}, lambda: None)
    with pytest.raises(GuardianApprovalPending):
        run(guardian_failure_error_function(None, pending))


def test_failure_error_function_hook_and_fallback():
    seen = []
    fn = make_guardian_failure_error_function(on_execution_failed=seen.append, fallback=lambda ctx, e: f"custom {e}")
    err = GuardianExecutionFailed("pay_invoice", "req_1", "X", local_effect_ran=True)
    run(fn(None, err))
    assert seen == [err]
    assert run(fn(None, ValueError("boom"))) == "custom boom"


# --- client hardening ---------------------------------------------------------


@pytest.mark.parametrize("decision", ["MAYBE", "ask", "HOLD", "allow"])
def test_unknown_decision_is_refused_and_nothing_runs(decision):
    server = Server({"/v1/agent/requests": [{"ok": True, "decision": decision, "capabilityToken": "gcap1.T"}]})
    effects = []
    with pytest.raises(GuardianDenied) as err:
        payments(Guard(make_client(server), connection_id=CONNECTION), effects)(**ARGS)
    assert err.value.reason_code == "MALFORMED_RESPONSE" and effects == []


def test_hosted_allow_shape_without_decision_still_runs():
    # The hosted gateway's ALLOW body carries a token and no decision.
    def hosted_allow(request, body):
        return httpx.Response(200, json={"ok": True, "token": "gcap1.T", "requestId": body["requestId"]})

    server = Server({"/v1/agent/requests": [hosted_allow], "/v1/agent/execute": [receipt()]})
    effects = []
    assert payments(Guard(make_client(server), connection_id=CONNECTION), effects)(**ARGS) == "paid INV-1"
    assert len(effects) == 1


@pytest.mark.parametrize("status", [500, 502, 503])
def test_server_error_is_reported_as_unavailable_not_denied(status):
    server = Server(
        {"/v1/agent/requests": [lambda r, b: httpx.Response(status, json={"ok": False, "reasonCode": "INTERNAL"})]}
    )
    effects = []
    out = payments(Guard(make_client(server), connection_id=CONNECTION, on_deny="result"), effects)(**ARGS)
    assert effects == [] and out["guardian"]["reason_code"] == "SERVICE_UNAVAILABLE"
    assert "could not be reached" in out["guardian"]["message"] and "denied" not in out["guardian"]["message"]


# --- the documented OpenAI Agents SDK recipe (runs when the SDK is installed) --


def _invoke(tool, args):
    from agents.tool_context import ToolContext

    ctx = ToolContext(context=None, tool_name=tool.name, tool_call_id="call_1", tool_arguments=json.dumps(args))
    out = asyncio.run(tool.on_invoke_tool(ctx, json.dumps(args)))
    return out if isinstance(out, str) else json.dumps(out)


def test_agents_recipe_recording_failure_is_not_retried():
    agents = pytest.importorskip("agents")
    server = Server({"/v1/agent/requests": [allow], "/v1/agent/execute": [network_down, receipt()]})
    guard = Guard(make_client(server), connection_id=CONNECTION, on_ask="result", on_deny="result")
    effects = []
    tool = agents.function_tool(payments(guard, effects))
    first = _invoke(tool, ARGS)
    assert effects == [("INV-1", 48000, "acme")]
    assert "Please try again" not in first
    assert "ran, but Guardian could not record it" in first and "Do not call it again" in first


def test_agents_recipe_remote_outcome_pending_is_not_retried():
    agents = pytest.importorskip("agents")
    server = Server({"/v1/agent/requests": [allow], "/v1/agent/execute": [receipt("outcome-pending")]})
    guard = Guard(make_client(server), connection_id=CONNECTION, mode="remote", on_ask="result", on_deny="result")

    @guard("pay_invoice")
    def pay_invoice(invoice_id: str, amount_cents: int, payee_id: str) -> str:
        """Pay an invoice."""
        raise AssertionError("remote mode never runs local code")

    out = _invoke(agents.function_tool(pay_invoice), ARGS)
    assert "Please try again" not in out and "may have run" in out and "Do not call it again" in out


def test_agents_recipe_raise_mode_with_guardian_failure_error_function():
    agents = pytest.importorskip("agents")
    server = Server({"/v1/agent/requests": [allow], "/v1/agent/execute": [network_down]})
    guard = Guard(make_client(server), connection_id=CONNECTION)
    effects = []
    tool = agents.function_tool(
        payments(guard, effects), failure_error_function=guardian_failure_error_function
    )
    out = _invoke(tool, ARGS)
    assert len(effects) == 1 and "Please try again" not in out and "Do not call it again" in out
