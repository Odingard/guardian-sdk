"""Guardian's answer to the final redemption is lost.

The request is looked up (``client.receipts``): a verified execution is a
success with its receipt; an aborted one is a plain execution failure; a
lookup that does not settle it raises ``GuardianExecutionFailed`` with
``outcome_unknown=True`` and ``EXECUTION_OUTCOME_UNKNOWN``, whose text says
the call ran (or may have run) and not to retry. A definitive refusal is
never looked up. An unreachable Guardian is worded as an outage, never as a
denial.
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
    GuardianUnavailable,
)
from odingard_guardian.guard import EXECUTION_OUTCOME_UNKNOWN, execution_failed_message
from odingard_guardian.openai_agents import guardian_error_message

CONNECTION = "pcn_0123456789abcdef0123456789abcdef"
CREDENTIAL = "gac1.test-credential"
ARGS = {"invoice_id": "INV-1", "amount_cents": 48000, "payee_id": "acme"}


class Server:
    """Scripted Guardian: ``plan`` maps a path prefix to one responder."""

    def __init__(self, plan):
        self.plan = plan
        self.calls = []
        self.lock = threading.Lock()

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content or b"null")
        with self.lock:
            self.calls.append(request.url.path)
        for prefix, respond in self.plan.items():
            if request.url.path.startswith(prefix):
                return respond(request, body)
        return httpx.Response(404, json={"ok": False, "code": "NOT_FOUND"})


def allow(request, body):
    return httpx.Response(
        200,
        json={"ok": True, "decision": "ALLOW", "requestId": body["requestId"], "capabilityToken": "gcap1.TOKEN"},
    )


def network_down(request, body):
    raise httpx.ConnectError("connection reset", request=request)


def bad_gateway(request, body):
    return httpx.Response(502, text="bad gateway")


def records(*states):
    def respond(request, body):
        request_id = request.url.path.rsplit("/", 1)[-1]
        return httpx.Response(
            200,
            json={
                "ok": True,
                "requestId": request_id,
                "receipts": [{"state": state, "attemptId": f"att_{i}"} for i, state in enumerate(states)],
            },
        )

    return respond


def lookup_down(request, body):
    return httpx.Response(503, json={"ok": False, "code": "SERVICE_UNAVAILABLE"})


def make_client(server):
    return GuardianClient(credential=CREDENTIAL, base_url="https://guardian.test", transport=httpx.MockTransport(server))


def make_async_client(server):
    return AsyncGuardianClient(
        credential=CREDENTIAL, base_url="https://guardian.test", transport=httpx.MockTransport(server)
    )


def payments(guard, effects):
    @guard("pay_invoice")
    def pay_invoice(invoice_id: str, amount_cents: int, payee_id: str) -> str:
        """Pay an invoice."""
        effects.append(invoice_id)
        return f"paid {invoice_id}"

    return pay_invoice


@pytest.mark.parametrize("lost", [network_down, bad_gateway])
def test_in_process_lost_answer_verified_by_lookup_is_a_success(lost):
    server = Server({"/v1/agent/requests": allow, "/v1/agent/execute": lost, "/v1/agent/receipts/": records("verified")})
    seen = []
    guard = Guard(make_client(server), connection_id=CONNECTION, on_receipt=lambda t, r, rc: seen.append((r, rc)))
    effects = []
    assert payments(guard, effects)(**ARGS) == "paid INV-1"
    assert effects == ["INV-1"]
    assert server.calls[:2] == ["/v1/agent/requests", "/v1/agent/execute"]
    assert server.calls[2].startswith("/v1/agent/receipts/req_")
    request_id, receipt = seen[0]
    assert receipt == {
        "schemaVersion": 1,
        "requestId": request_id,
        "receiptReference": "att_0",
        "status": "sent-verified",
    }


def test_in_process_lost_answer_the_lookup_cannot_settle_says_it_ran_and_not_to_retry():
    server = Server({"/v1/agent/requests": allow, "/v1/agent/execute": network_down, "/v1/agent/receipts/": lookup_down})
    guard = Guard(make_client(server), connection_id=CONNECTION)
    effects = []
    with pytest.raises(GuardianExecutionFailed) as caught:
        payments(guard, effects)(**ARGS)
    err = caught.value
    assert effects == ["INV-1"]
    assert err.reason_code == EXECUTION_OUTCOME_UNKNOWN and err.outcome_unknown and err.local_effect_ran
    assert err.detail == "SERVICE_UNAVAILABLE" and err.request_id.startswith("req_")
    text = str(err)
    assert text.startswith('"pay_invoice" ran, but Guardian could not confirm that it recorded it; do not retry;')
    assert f"check request_id {err.request_id}" in text
    message = execution_failed_message(err)
    assert "ran, but Guardian could not confirm that it recorded it" in message
    assert "Do not call it again" in message and "without a receipt" not in message


@pytest.mark.parametrize("states", [(), ("committing",), ("verified-pending",)])
def test_in_process_lost_answer_with_nothing_settled_stays_unknown(states):
    server = Server(
        {"/v1/agent/requests": allow, "/v1/agent/execute": network_down, "/v1/agent/receipts/": records(*states)}
    )
    with pytest.raises(GuardianExecutionFailed) as caught:
        payments(Guard(make_client(server), connection_id=CONNECTION), [])(**ARGS)
    assert caught.value.reason_code == EXECUTION_OUTCOME_UNKNOWN


def test_in_process_lost_answer_for_an_aborted_redemption_is_a_recording_failure():
    server = Server(
        {"/v1/agent/requests": allow, "/v1/agent/execute": network_down, "/v1/agent/receipts/": records("aborted")}
    )
    with pytest.raises(GuardianExecutionFailed) as caught:
        payments(Guard(make_client(server), connection_id=CONNECTION), [])(**ARGS)
    err = caught.value
    assert err.reason_code == "SERVICE_UNAVAILABLE" and err.local_effect_ran and not err.outcome_unknown
    assert str(err).startswith('"pay_invoice" ran, but Guardian could not record it; do not retry')


def test_a_definitive_refusal_is_not_looked_up():
    def revoked(request, body):
        return httpx.Response(409, json={"ok": False, "reasonCode": "CAPABILITY_REVOKED"})

    server = Server({"/v1/agent/requests": allow, "/v1/agent/execute": revoked, "/v1/agent/receipts/": records("verified")})
    with pytest.raises(GuardianExecutionFailed) as caught:
        payments(Guard(make_client(server), connection_id=CONNECTION), [])(**ARGS)
    assert caught.value.reason_code == "CAPABILITY_REVOKED"
    assert not any(p.startswith("/v1/agent/receipts/") for p in server.calls)


def test_a_client_without_receipts_settles_nothing():
    server = Server({"/v1/agent/requests": allow, "/v1/agent/execute": network_down})
    real = make_client(server)

    class NoLookup:
        def request(self, invocation):
            return real.request(invocation)

        def claim(self, request_id):
            return real.claim(request_id)

        def execute(self, **kw):
            return real.execute(**kw)

    with pytest.raises(GuardianExecutionFailed) as caught:
        payments(Guard(NoLookup(), connection_id=CONNECTION), [])(**ARGS)
    assert caught.value.reason_code == EXECUTION_OUTCOME_UNKNOWN


def test_remote_lost_answer_verified_by_lookup_returns_the_receipt():
    server = Server({"/v1/agent/requests": allow, "/v1/agent/execute": network_down, "/v1/agent/receipts/": records("verified")})
    guard = Guard(make_client(server), connection_id=CONNECTION, mode="remote")
    ran = []

    @guard("send_email")
    def send_email(to: str) -> None:
        ran.append(to)

    out = send_email(to="a@example.com")
    assert ran == []
    assert out["guardian"]["decision"] == "ALLOW" and out["guardian"]["receipt"]["status"] == "sent-verified"


def test_remote_lost_answer_unsettled_may_have_happened():
    server = Server({"/v1/agent/requests": allow, "/v1/agent/execute": bad_gateway, "/v1/agent/receipts/": lookup_down})
    guard = Guard(make_client(server), connection_id=CONNECTION, mode="remote")

    @guard("send_email")
    def send_email(to: str) -> None: ...

    with pytest.raises(GuardianExecutionFailed) as caught:
        send_email(to="a@example.com")
    err = caught.value
    assert err.outcome_unknown and not err.local_effect_ran and err.detail == "HTTP_502"
    assert str(err).startswith('Guardian execution of "send_email" may have happened; do not retry;')


def test_remote_lost_answer_for_an_aborted_redemption_was_not_sent():
    server = Server({"/v1/agent/requests": allow, "/v1/agent/execute": network_down, "/v1/agent/receipts/": records("aborted")})
    guard = Guard(make_client(server), connection_id=CONNECTION, mode="remote")

    @guard("send_email")
    def send_email(to: str) -> None: ...

    with pytest.raises(GuardianExecutionFailed) as caught:
        send_email(to="a@example.com")
    assert caught.value.reason_code == "EXECUTION_NOT_SENT" and not caught.value.outcome_unknown


def test_async_lost_answer_is_looked_up_too():
    server = Server({"/v1/agent/requests": allow, "/v1/agent/execute": network_down, "/v1/agent/receipts/": records("verified")})
    guard = Guard(make_async_client(server), connection_id=CONNECTION)
    effects = []

    @guard("pay_invoice")
    async def pay_invoice(invoice_id: str) -> str:
        effects.append(invoice_id)
        return "paid"

    assert asyncio.run(pay_invoice(invoice_id="INV-1")) == "paid"
    assert effects == ["INV-1"]

    unsettled = Server({"/v1/agent/requests": allow, "/v1/agent/execute": network_down, "/v1/agent/receipts/": lookup_down})
    guard = Guard(make_async_client(unsettled), connection_id=CONNECTION)

    @guard("pay_invoice")
    async def pay_again(invoice_id: str) -> str:
        return "paid"

    with pytest.raises(GuardianExecutionFailed) as caught:
        asyncio.run(pay_again(invoice_id="INV-1"))
    assert caught.value.reason_code == EXECUTION_OUTCOME_UNKNOWN


def test_result_mode_reports_a_ran_but_unconfirmed_call():
    server = Server({"/v1/agent/requests": allow, "/v1/agent/execute": network_down, "/v1/agent/receipts/": lookup_down})
    guard = Guard(make_client(server), connection_id=CONNECTION, on_deny="result")
    g = payments(guard, [])(**ARGS)["guardian"]
    assert g["outcome"] == "ran_unconfirmed" and g["outcome_unknown"] is True
    assert g["reason_code"] == EXECUTION_OUTCOME_UNKNOWN and g["local_effect_ran"] is True
    assert "Do not call it again" in g["message"]


# --- an unreachable Guardian is an outage, never a denial --------------------


def test_unreachable_guardian_raises_guardian_unavailable_worded_as_an_outage():
    server = Server({"/v1/agent/requests": network_down})
    effects = []
    with pytest.raises(GuardianUnavailable) as caught:
        payments(Guard(make_client(server), connection_id=CONNECTION), effects)(**ARGS)
    err = caught.value
    assert effects == []
    assert isinstance(err, GuardianDenied)  # code that catches denials keeps refusing
    assert err.reason_code == "SERVICE_UNAVAILABLE" and err.hint is None
    text = str(err)
    assert text == (
        'Guardian could not be reached to check "pay_invoice" (reason_code=SERVICE_UNAVAILABLE), '
        "so it did not run. Try again later."
    )
    assert "denied" not in text.lower()
    assert guardian_error_message(err) == "Guardian could not check pay_invoice, so it did not run. Try again later."


def test_a_5xx_on_the_request_is_an_outage_too():
    server = Server({"/v1/agent/requests": bad_gateway})
    with pytest.raises(GuardianUnavailable):
        payments(Guard(make_client(server), connection_id=CONNECTION), [])(**ARGS)


def test_a_denial_is_still_a_denial():
    def deny(request, body):
        return httpx.Response(
            200, json={"ok": True, "decision": "DENY", "requestId": body["requestId"], "reasonCode": "NOT_AUTHORIZED"}
        )

    server = Server({"/v1/agent/requests": deny})
    with pytest.raises(GuardianDenied) as caught:
        payments(Guard(make_client(server), connection_id=CONNECTION), [])(**ARGS)
    assert not isinstance(caught.value, GuardianUnavailable)
    assert str(caught.value).startswith('Guardian denied "pay_invoice" (reason_code=NOT_AUTHORIZED) request_id=req_')
    assert "request_id req_" in guardian_error_message(caught.value)
