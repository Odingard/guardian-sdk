"""verify_before_acting must reach the TypeScript SDK's verdict."""

import json
from pathlib import Path

import httpx
import pytest

from odingard_guardian import fetch_receipt_status, verify_before_acting

CASES = json.loads(
    (Path(__file__).parent / "fixtures" / "verify-before-acting.json").read_text("utf-8")
)


def _expected(case):
    e = case["expected"]
    out = {"material_parameters": e["materialParameters"]}
    for ts, py in (
        ("action", "action"),
        ("valueCents", "value_cents"),
        ("amountField", "amount_field"),
        ("merchantId", "merchant_id"),
        ("currency", "currency"),
        ("currencyField", "currency_field"),
    ):
        if ts in e:
            out[py] = e[ts]
    return out


def _status(option):
    if option is None:
        return None
    if option == "throw":
        def boom(_receipt):
            raise RuntimeError("down")
        return boom
    return lambda _receipt: option


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["name"])
def test_parity_with_typescript(case):
    options = case["options"]
    got = verify_before_acting(
        case["receipt"],
        case["keys"],
        _expected(case),
        now_epoch_ms=options["nowEpochMs"],
        **({"max_age_ms": options["maxAgeMs"]} if "maxAgeMs" in options else {}),
        **({"seen_request_ids": set(options["seenRequestIds"])} if "seenRequestIds" in options else {}),
        status=_status(options.get("status")),
    )
    want = case["result"]
    assert got["ok"] == want["ok"]
    if want["ok"]:
        assert got == want
    else:
        assert got["reasonCode"] == want["reasonCode"]
        if want["reasonCode"] == "RECEIPT_INVALID":
            # The inner verifier code can differ: TypeScript's schema check
            # catches some edits (MALFORMED_RECEIPT) that Python's catches
            # at the signature (SIGNATURE_INVALID). Both refuse.
            prefix = "The receipt is not a valid Guardian receipt ("
            assert got["detail"].startswith(prefix)
        else:
            assert got["detail"] == want["detail"]


def test_fixtures_cover_every_refusal_and_success():
    codes = {c["result"].get("reasonCode") for c in CASES if not c["result"]["ok"]}
    assert {
        "RECEIPT_INVALID", "REQUEST_MISMATCH", "ACTION_MISMATCH", "NOT_AUTHORIZED",
        "NOT_APPROVED", "NOT_ISSUED", "REVOKED", "EXPIRED", "ALREADY_USED", "REPLAYED",
        "STALE", "NOT_YET_VALID", "AMOUNT_NOT_AUTHORIZED", "AMOUNT_MISMATCH",
        "DESTINATION_MISMATCH", "CURRENCY_MISSING", "CURRENCY_MISMATCH",
        "STATUS_UNAVAILABLE", "STATUS_NOT_ACTIVE",
    } <= codes
    assert sum(1 for c in CASES if c["result"]["ok"]) >= 3


def test_fixtures_cover_amount_field():
    by_name = {c["name"]: c["result"] for c in CASES if "amountField" in c["expected"]}
    assert by_name["amountField: body amount matches, ASK approved"]["ok"] is True
    for name, code in (
        ("amountField: body amount differs from the receiver's", "AMOUNT_MISMATCH"),
        ("amountField: amount missing from the body", "AMOUNT_NOT_AUTHORIZED"),
        ("amountField: no declared value and ALLOW (no person approved)", "AMOUNT_NOT_AUTHORIZED"),
        ("amountField: declared value disagrees with the body", "AMOUNT_MISMATCH"),
        ("amountField: no capability issued", "NOT_ISSUED"),
    ):
        assert by_name[name]["reasonCode"] == code, name


def test_fetch_receipt_status_posts_the_receipt_and_accepts_only_known_statuses():
    seen = []

    def reply(body, status=200):
        def handler(request):
            seen.append((str(request.url), json.loads(request.content)))
            return httpx.Response(status, json=body)
        return httpx.MockTransport(handler)

    assert fetch_receipt_status(
        "https://guardian.test/", {"receiptId": "rcp_x"}, transport=reply({"ok": True, "status": "revoked"})
    ) == {"ok": True, "status": "revoked"}
    assert seen[0] == ("https://guardian.test/v1/receipts/status", {"receipt": {"receiptId": "rcp_x"}})
    assert fetch_receipt_status(
        "https://guardian.test", {}, transport=reply({"ok": True, "status": "fine"})
    )["ok"] is False
    assert fetch_receipt_status(
        "https://guardian.test", {}, transport=reply({"ok": False, "reasonCode": "RECEIPT_INVALID"}, 400)
    ) == {"ok": False, "reasonCode": "RECEIPT_INVALID"}


def test_a_bool_is_not_an_amount():
    # Golden case: the receipt authorizes exactly 1 cent and the receiver
    # passes True (which Python equates with 1). TypeScript refuses it.
    case = next(c for c in CASES if c["name"] == "receiver passes true as the amount")
    assert case["result"]["reasonCode"] == "AMOUNT_MISMATCH"
    got = verify_before_acting(
        case["receipt"], case["keys"], _expected(case), now_epoch_ms=case["options"]["nowEpochMs"]
    )
    assert got["ok"] is False and got["reasonCode"] == "AMOUNT_MISMATCH"


def test_unserializable_receipt_is_a_failed_status_lookup_not_a_crash():
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"ok": True, "status": "active"}))
    assert fetch_receipt_status("https://guardian.test", {"bad": object()}, transport=transport) == {
        "ok": False,
        "reasonCode": "SERVICE_UNAVAILABLE",
    }


def test_fixtures_cover_content_types():
    # Generated by the TypeScript SDK; the parity test above runs each one.
    by_name = {c["name"][len("content type: "):]: c["result"] for c in CASES if c["name"].startswith("content type: ")}
    for name, code in (
        ("smuggled body, leading space", "AMOUNT_MISMATCH"),
        ("smuggled body, leading tab", "AMOUNT_MISMATCH"),
        ("smuggled body, merge-patch+json", "AMOUNT_MISMATCH"),
        ("smuggled body, text/json", "AMOUNT_MISMATCH"),
        ("smuggled body, no content type", "AMOUNT_NOT_AUTHORIZED"),
        ("form body, text/plain", "AMOUNT_NOT_AUTHORIZED"),
        ("two content-type headers", "AMOUNT_NOT_AUTHORIZED"),
        ("header value not a string", "AMOUNT_NOT_AUTHORIZED"),
        ("JSON NaN elsewhere in the body", "AMOUNT_NOT_AUTHORIZED"),
        ("JSON Infinity elsewhere in the body", "AMOUNT_NOT_AUTHORIZED"),
        ("JSON -Infinity elsewhere in the body", "AMOUNT_NOT_AUTHORIZED"),
        ("JSON NaN amount", "AMOUNT_NOT_AUTHORIZED"),
        ("JSON nested 3000 deep and malformed", "AMOUNT_NOT_AUTHORIZED"),
        ("form body with two leading ?", "AMOUNT_NOT_AUTHORIZED"),
        ("form body split by ;", "AMOUNT_NOT_AUTHORIZED"),
    ):
        assert by_name[name]["reasonCode"] == code, name
    for name in (
        "JSON with a charset parameter",
        "form with a charset parameter",
        "JSON huge integer elsewhere in the body",
        "JSON nested 3000 deep elsewhere in the body",
        "form body with a leading ?",
    ):
        assert by_name[name]["ok"] is True and by_name[name]["valueCents"] == 100, name


def test_deeply_nested_json_reads_as_javascript_does():
    # JSON.parse reads any depth; Python's json gives up near 1000-10000.
    from odingard_guardian.verify import _AMBIGUOUS, _read_field

    deep = '{"amount":100,"currency":"usd","x":' + "[" * 50_000 + "]" * 50_000 + "}"
    params = {"headers": [{"name": "content-type", "value": "application/json"}], "body": deep}
    assert _read_field("api.request", params, "amount", True) == "100"
    params["body"] = deep[:-2] + "}"
    assert _read_field("api.request", params, "amount", True) is _AMBIGUOUS
