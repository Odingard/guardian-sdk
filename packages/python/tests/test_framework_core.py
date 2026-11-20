"""The shared core of the framework integrations, without a framework.

``Outcome.result`` is the one place an integration reads Guardian's result
record from: set whenever the tool step did not answer the call.
"""

import asyncio
import json

import pytest

from odingard_guardian import RequestResult
from odingard_guardian._framework import build_guard, decide_and_run

from test_guard import ALLOW, CONNECTION, HELD, AsyncFake, FakeClient

DENIED = RequestResult(ok=True, request_id="req_d", decision="DENY", reason_code="POLICY_DENY")
UNREACHABLE = RequestResult(ok=False, reason_code="SERVICE_UNAVAILABLE")


def decide(fake, **options):
    guard = build_guard(
        AsyncFake(fake),
        connection_id=CONNECTION,
        agent_name="agent",
        adapter_id=None,
        purpose=None,
        amount_args=None,
        on_receipt=None,
        on_execution_error=None,
        **options,
    )
    ran = []

    async def run_tool():
        ran.append(True)

    outcome = asyncio.run(decide_and_run(guard, "refund_order", {"order_id": "A1"}, run_tool))
    return outcome, ran


def test_a_tool_that_ran_and_was_recorded_has_no_result():
    outcome, ran = decide(FakeClient(ALLOW))
    assert ran == [True]
    assert (outcome.ran, outcome.decision, outcome.message, outcome.result) == (True, "ALLOW", None, None)


def test_a_remote_allow_carries_guardians_result_and_never_runs_the_tool():
    outcome, ran = decide(FakeClient(ALLOW), mode="remote")
    assert ran == []
    assert (outcome.ran, outcome.decision) == (False, "ALLOW")
    info = outcome.result["guardian"]
    assert info["decision"] == "ALLOW" and info["request_id"] == "req_allow" and info["receipt"]
    assert json.loads(outcome.message)["guardian"]["request_id"] == "req_allow"


def test_held_and_denied_calls_carry_the_result_record():
    held, ran = decide(FakeClient(HELD))
    assert ran == [] and held.decision == "ASK"
    assert held.result["guardian"]["request_id"] == held.request_id == "req_ask"

    denied, ran = decide(FakeClient(DENIED))
    assert ran == [] and denied.decision == "DENY"
    assert denied.result["guardian"]["reason_code"] == denied.reason_code == "POLICY_DENY"
    assert denied.result["guardian"]["message"] == denied.message


def test_an_unreachable_guardian_is_a_denial_with_its_record():
    outcome, ran = decide(FakeClient(UNREACHABLE))
    assert ran == [] and outcome.decision == "DENY" and outcome.reason_code == "SERVICE_UNAVAILABLE"
    assert outcome.result["guardian"]["reason_code"] == "SERVICE_UNAVAILABLE"


def test_per_tool_modes_and_a_mistyped_mode():
    outcome, ran = decide(FakeClient(ALLOW), modes={"refund_order": "remote"})
    assert ran == [] and outcome.result["guardian"]["decision"] == "ALLOW"
    outcome, ran = decide(FakeClient(ALLOW), modes={"other": "remote"})
    assert ran == [True] and outcome.result is None
    with pytest.raises(ValueError):
        decide(FakeClient(ALLOW), mode="enforced")
