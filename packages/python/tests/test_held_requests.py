import json

import httpx

from odingard_guardian import (
    AsyncGuardianClient,
    GuardianClient,
    HeldRequest,
    PendingResult,
    WithdrawResult,
)

HELD = {
    "requestId": "req_0123456789abcdef",
    "action": "tool.invoke",
    "toolName": "send_email",
    "purpose": "Reply to the customer",
    "createdAtEpochMs": 1_700_000_000_000,
    "expiresAtEpochMs": 1_700_000_120_000,
}
WITHDRAWN = {
    "ok": True,
    "requestId": "req_0123456789abcdef",
    "state": "withdrawn",
    "withdrawnAtEpochMs": 1_700_000_001_000,
}


def make(handler):
    return GuardianClient(base_url="https://g.test/", credential="gak_test", transport=httpx.MockTransport(handler))


def test_pending_lists_the_agents_held_requests_and_passes_the_page():
    seen = []

    def handler(request):
        seen.append((request.method, str(request.url)))
        return httpx.Response(200, json={"ok": True, "requests": [HELD], "next": "1700000000000:req_x"})

    result = make(handler).pending(limit=5, before="1:req_0123456789abcdef")
    assert result == PendingResult(
        ok=True,
        requests=[
            HeldRequest(
                request_id="req_0123456789abcdef",
                action="tool.invoke",
                tool_name="send_email",
                purpose="Reply to the customer",
                created_at_epoch_ms=1_700_000_000_000,
                expires_at_epoch_ms=1_700_000_120_000,
            )
        ],
        next="1700000000000:req_x",
    )
    assert seen == [
        (
            "GET",
            "https://g.test/v1/agent/requests?status=pending&limit=5&before=1%3Areq_0123456789abcdef",
        )
    ]


def test_pending_fails_closed_on_an_unreadable_entry_a_refusal_or_an_outage():
    for body, status, code in [
        ({"ok": True, "requests": [{**HELD, "createdAtEpochMs": "x"}]}, 200, "MALFORMED_RESPONSE"),
        ({"ok": True, "requests": [{**HELD, "toolName": 3}]}, 200, "MALFORMED_RESPONSE"),
        ({"ok": False, "reasonCode": "UNAUTHENTICATED"}, 401, "UNAUTHENTICATED"),
        ({"ok": True}, 200, "HTTP_200"),
    ]:
        result = make(lambda r, body=body, status=status: httpx.Response(status, json=body)).pending()
        assert result == PendingResult(ok=False, reason_code=code)

    def down(request):
        raise httpx.ConnectError("down")

    assert make(down).pending() == PendingResult(ok=False, reason_code="SERVICE_UNAVAILABLE")


def test_withdraw_posts_to_the_request_and_reads_the_answer():
    seen = []

    def handler(request):
        seen.append((request.method, request.url.raw_path.decode(), json.loads(request.content)))
        return httpx.Response(200, json=WITHDRAWN)

    assert make(handler).withdraw("req_a/../b") == WithdrawResult(
        ok=True,
        request_id="req_0123456789abcdef",
        state="withdrawn",
        withdrawn_at_epoch_ms=1_700_000_001_000,
    )
    assert seen == [("POST", "/v1/agent/requests/req_a%2F..%2Fb/withdraw", {})]


def test_withdraw_never_reports_a_withdrawal_it_did_not_get():
    decided = {"ok": False, "reasonCode": "ALREADY_DECIDED", "requestId": "req_0123456789abcdef", "state": "approved"}
    assert make(lambda r: httpx.Response(409, json=decided)).withdraw("req_0123456789abcdef") == WithdrawResult(
        ok=False, reason_code="ALREADY_DECIDED", request_id="req_0123456789abcdef", state="approved"
    )
    for body, status, code, unknown in [
        ({**WITHDRAWN, "state": "pending"}, 200, "MALFORMED_RESPONSE", True),
        ({"ok": True, "state": "withdrawn"}, 200, "MALFORMED_RESPONSE", True),
        ({"ok": False, "reasonCode": "NOT_FOUND"}, 404, "NOT_FOUND", False),
        ({"ok": False, "reasonCode": "RATE_LIMITED"}, 429, "RATE_LIMITED", False),
        ({"ok": False, "reasonCode": "SERVICE_UNAVAILABLE"}, 503, "SERVICE_UNAVAILABLE", True),
    ]:
        result = make(lambda r, body=body, status=status: httpx.Response(status, json=body)).withdraw("req_x")
        assert not result.ok and result.reason_code == code and result.outcome_unknown is unknown


def test_withdraw_reports_a_lost_answer_as_unconfirmed():
    def down(request):
        raise httpx.ConnectError("connection reset")

    assert make(down).withdraw("req_0123456789abcdef") == WithdrawResult(
        ok=False, reason_code="SERVICE_UNAVAILABLE", outcome_unknown=True
    )


async def test_async_client_lists_and_withdraws():
    async def handler(request):
        if request.method == "GET":
            return httpx.Response(200, json={"ok": True, "requests": [HELD], "next": None})
        return httpx.Response(200, json=WITHDRAWN)

    async with AsyncGuardianClient(
        base_url="https://g.test", credential="gak_test", transport=httpx.MockTransport(handler)
    ) as client:
        listed = await client.pending()
        assert listed.ok and listed.requests[0].tool_name == "send_email" and listed.next is None
        withdrawn = await client.withdraw("req_0123456789abcdef")
        assert withdrawn.ok and withdrawn.state == "withdrawn"
