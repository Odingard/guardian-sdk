"""Dollar amounts on tools (``amount_args``): the same reading as TypeScript."""

import json
from pathlib import Path

import pytest

from odingard_guardian import Guard, GuardianDenied, RequestResult, build_proposal
from odingard_guardian._amounts import normalize_amount_args, read_tool_amount

from test_guard import ALLOW, CONNECTION, FakeClient

FIXTURES = json.loads((Path(__file__).parent / "fixtures" / "tool-amounts.json").read_text("utf-8"))
MINOR = {"argument": "amount_cents", "unit": "minor", "currency": "usd"}


def _python_reading(declaration, args):
    kind, value = read_tool_amount(normalize_amount_args({"t": declaration})["t"], args)
    if kind == "money":
        return {"kind": "money", "amountMinor": value, "currency": "usd"}
    return {"kind": kind, "code": value}


@pytest.mark.parametrize("case", FIXTURES["reads"], ids=lambda c: c["name"])
def test_reads_the_amount_as_typescript_does(case):
    assert _python_reading(case["declaration"], case["args"]) == case["expected"]


@pytest.mark.parametrize("case", FIXTURES["declarations"], ids=lambda c: c["name"])
def test_accepts_the_declarations_typescript_accepts(case):
    try:
        normalize_amount_args({"t": case["declaration"]})
        valid = True
    except TypeError:
        valid = False
    assert valid is case["valid"]


def test_python_numbers_read_like_json_numbers():
    assert read_tool_amount(MINOR, {"amount_cents": 2000.0}) == ("money", 2000)
    assert read_tool_amount(MINOR, {"amount_cents": float("nan")}) == ("refused", "AMOUNT_INVALID")
    assert read_tool_amount(MINOR, {"amount_cents": float("inf")}) == ("refused", "AMOUNT_INVALID")
    assert read_tool_amount(MINOR, {"amount_cents": False}) == ("refused", "AMOUNT_INVALID")


def test_a_bad_declaration_is_refused_when_the_guard_is_built():
    with pytest.raises(TypeError, match="amount_args"):
        Guard(FakeClient(ALLOW), connection_id=CONNECTION, amount_args={"pay": {"argument": "x", "unit": "cents"}})


def test_each_call_carries_the_declaration_and_the_amount():
    client = FakeClient(ALLOW)
    guard = Guard(client, connection_id=CONNECTION, amount_args={"pay": MINOR})

    @guard("pay")
    def pay(invoice_id: str, amount_cents: int):
        return "paid"

    assert pay("INV-1", 4800) == "paid"
    invocation = client.last_invocation
    assert invocation["amount_argument"] == MINOR
    assert invocation["value_cents"] == 4800
    proposal = build_proposal(invocation)
    assert proposal["materialParameters"]["amountArgument"] == MINOR
    assert proposal["valueCents"] == 4800


def test_an_unreadable_amount_is_sent_without_a_value_and_refused():
    client = FakeClient(RequestResult(ok=False, reason_code="INVALID_REQUEST"))
    guard = Guard(client, connection_id=CONNECTION, amount_args={"pay": MINOR})
    ran = []

    @guard("pay")
    def pay(invoice_id: str, amount_cents):
        ran.append(1)

    with pytest.raises(GuardianDenied) as err:
        pay("INV-1", "48.00")
    assert ran == []
    assert "value_cents" not in client.last_invocation
    assert client.last_invocation["amount_argument"] == MINOR
    assert "could not be read (AMOUNT_INVALID)" in err.value.hint


def test_a_declaration_the_console_does_not_hold_is_explained():
    client = FakeClient(RequestResult(ok=False, reason_code="ACTION_PARAMETERS_INVALID"))
    guard = Guard(client, connection_id=CONNECTION, amount_args={"pay": MINOR}, on_deny="result")
    out = guard.run("pay", {"amount_cents": 100}, lambda: "ran")
    assert out["guardian"]["decision"] == "DENY"
    assert "equals the declaration the owner set" in out["guardian"]["message"]


def test_tools_without_a_declaration_send_no_amount():
    client = FakeClient(ALLOW)
    guard = Guard(client, connection_id=CONNECTION, amount_args={"pay": MINOR})
    guard.run("lookup", {"amount_cents": 100}, lambda: "ok")
    assert "amount_argument" not in client.last_invocation
    assert "value_cents" not in client.last_invocation
    assert "amountArgument" not in build_proposal(client.last_invocation)["materialParameters"]
