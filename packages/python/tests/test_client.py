import json

import httpx
import pytest

from odingard_guardian import (
    AsyncGuardianClient,
    GuardianClient,
    classify_request_result,
)

CONNECTION = "pcn_0123456789abcdef0123456789abcdef"


def make(handler, **kw):
    return GuardianClient(
        base_url="https://g.test/", credential="gac1.test", transport=httpx.MockTransport(handler), **kw
    )


def test_request_sends_the_canonical_proposal_with_bearer_credential():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers["authorization"]
        seen["path"] = request.url.path
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={"ok": True, "requestId": seen["body"]["requestId"], "decision": "ALLOW", "capabilityToken": "cap"},
        )

    result = make(handler).request(
        {
            "action": "tool.invoke",
            "connection_id": CONNECTION,
            "tool_name": "refund_order",
            "arguments": {"orderId": "ord_1"},
            "purpose": "refund",
        }
    )
    body = seen["body"]
    assert seen["auth"] == "Bearer gac1.test"
    assert seen["path"] == "/v1/agent/requests"
    assert body["schemaVersion"] == 1 and body["uses"] == 1
    assert body["requestId"].startswith("req_") and len(body["requestId"]) == 36
    assert body["correlationId"].startswith("cor_")
    assert body["action"] == "tool.invoke"
    assert body["resource"] == f"tool:server:{CONNECTION}"
    assert body["requestedAdapterId"] == "adp_00000006"
    assert body["initiatingContext"] == "agent"
    assert body["requestedTtlMs"] == 120_000
    assert body["materialParameters"] == {
        "schema": "odingard.guardian.tool.invoke.v1",
        "connectionId": CONNECTION,
        "toolName": "refund_order",
        "arguments": {"orderId": "ord_1"},
    }
    assert result.ok and result.decision == "ALLOW" and result.capability_token == "cap"


def test_held_ask_keeps_request_id_and_classifies_as_ask():
    def handler(request):
        return httpx.Response(403, json={"ok": False, "reasonCode": "APPROVAL_REQUIRED"})

    result = make(handler).request(
        {"action": "tool.invoke", "connection_id": CONNECTION, "tool_name": "x", "arguments": {}}
    )
    assert not result.ok and result.request_id.startswith("req_")
    decision = classify_request_result(result)
    assert decision.decision == "ASK" and decision.request_id == result.request_id


def test_unreachable_guardian_fails_closed():
    def handler(request):
        raise httpx.ConnectError("down", request=request)

    result = make(handler).request(
        {"action": "tool.invoke", "connection_id": CONNECTION, "tool_name": "x", "arguments": {}}
    )
    assert not result.ok and result.reason_code == "SERVICE_UNAVAILABLE"
    assert classify_request_result(result).decision == "DENY"


def test_allow_without_token_is_deny():
    def handler(request):
        return httpx.Response(200, json={"ok": True, "decision": "ALLOW", "requestId": "req_x"})

    result = make(handler).request(
        {"action": "tool.invoke", "connection_id": CONNECTION, "tool_name": "x", "arguments": {}}
    )
    assert classify_request_result(result).decision == "DENY"


def test_plan_limit_denial_surfaces_api_code():
    body = {
        "ok": False,
        "code": "PLAN_LIMIT_EXCEEDED",
        "plan": "free",
        "resource": "protected_actions",
        "limit": 50,
        "used": 53,
    }

    def handler(request):
        return httpx.Response(403, json=body)

    client = make(handler)
    request = client.request(
        {"action": "tool.invoke", "connection_id": CONNECTION, "tool_name": "x", "arguments": {}}
    )
    assert not request.ok and request.reason_code == "PLAN_LIMIT_EXCEEDED"
    executed = client.execute(request_id="req_x", capability_token="c")
    assert not executed.ok and executed.reason_code == "PLAN_LIMIT_EXCEEDED"


def test_execute_requires_a_receipt():
    def handler(request):
        return httpx.Response(200, json={"ok": True})

    assert make(handler).execute(request_id="req_x", capability_token="c").reason_code == "HTTP_200"


def test_credential_never_appears_in_repr():
    assert "gac1" not in repr(make(lambda r: httpx.Response(200)))


def test_missing_connection_id_is_rejected_locally():
    with pytest.raises(ValueError):
        make(lambda r: httpx.Response(200)).request({"action": "tool.invoke", "tool_name": "x", "arguments": {}})


async def test_async_client_round_trip():
    async def handler(request):
        if request.url.path == "/v1/agent/claims":
            return httpx.Response(200, json={"ok": True, "requestId": "req_a", "decision": "ALLOW", "token": "cap"})
        return httpx.Response(
            200,
            json={"ok": True, "receipt": {"schemaVersion": 1, "requestId": "req_a", "status": "sent-verified"}},
        )

    async with AsyncGuardianClient(
        base_url="https://g.test", credential="gac1.t", transport=httpx.MockTransport(handler)
    ) as client:
        claimed = await client.claim("req_a")
        assert claimed.capability_token == "cap"
        executed = await client.execute(request_id="req_a", capability_token="cap")
        assert executed.ok and executed.receipt["requestId"] == "req_a"


MONEY = {
    "action": "api.request",
    "connection_id": CONNECTION,
    "material_parameters": {
        "schema": "odingard.guardian.api.request.v1",
        "connectionId": CONNECTION,
        "method": "POST",
        "url": "https://api.stripe.com/v1/refunds",
        "headers": [{"name": "content-type", "value": "application/x-www-form-urlencoded"}],
        "body": "charge=ch_1&amount=100",
    },
}


def _sent(extra):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        return httpx.Response(403, json={"ok": False, "reasonCode": "APPROVAL_REQUIRED"})

    make(handler).request({**MONEY, **extra})
    return seen.get("body")


def test_money_fields_are_sent_with_the_proposal():
    body = _sent({"value_cents": 100, "merchant_id": " acme ", "merchant_category": "software", "recurring": False})
    assert body["valueCents"] == 100
    assert body["merchantId"] == "acme"
    assert body["merchantCategory"] == "software"
    assert body["recurring"] is False


def test_money_fields_are_omitted_when_not_given():
    body = _sent({})
    for key in ("valueCents", "merchantId", "merchantCategory", "recurring"):
        assert key not in body


@pytest.mark.parametrize(
    "extra",
    [
        {"value_cents": -1},
        {"value_cents": 1.5},
        {"value_cents": True},
        {"value_cents": "100"},
        {"merchant_id": ""},
        {"merchant_id": "x" * 257},
        {"recurring": "yes"},
    ],
)
def test_invalid_money_fields_fail_before_any_request(extra):
    with pytest.raises(ValueError):
        _sent(extra)
