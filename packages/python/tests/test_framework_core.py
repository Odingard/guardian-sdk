"""The shared core of the framework integrations, without a framework.

``Outcome.result`` is the one place an integration reads Guardian's result
record from: set whenever the tool step did not answer the call.
"""

import asyncio
import json

import pytest

from odingard_guardian import RequestResult
from odingard_guardian._framework import build_guard, decide_and_run, decide_and_run_sync, performed_remotely

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
        on_execution_error=None,
        **{"on_receipt": None, **options},
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


def test_a_remote_call_that_raises_after_guardian_performed_it_is_never_reported_as_not_run():
    fake = FakeClient(ALLOW)

    def on_receipt(tool_name, request_id, receipt):
        raise RuntimeError("the app's hook failed")

    outcome, ran = decide(fake, mode="remote", on_receipt=on_receipt)
    assert "execute:req_allow" in fake.calls  # Guardian performed the call
    assert ran == []
    assert outcome.reason_code == "EXECUTION_OUTCOME_UNKNOWN"
    assert "may have performed it" in outcome.message and "Do not call it again" in outcome.message
    assert "did not run" not in outcome.message and "Try again" not in outcome.message


def test_an_in_process_check_that_raises_before_the_tool_still_says_it_did_not_run():
    class Raising(FakeClient):
        def request(self, invocation):
            raise RuntimeError("network down")

    outcome, ran = decide(Raising(ALLOW))
    assert ran == [] and outcome.reason_code == "SERVICE_UNAVAILABLE"
    assert "did not run" in outcome.message


def test_a_remote_call_that_could_not_be_confirmed_is_allow_and_not_ran_but_not_performed():
    performed, _ = decide(FakeClient(ALLOW), mode="remote")
    assert performed_remotely(performed)
    assert "outcome" not in performed.result["guardian"] and "message" not in performed.result["guardian"]

    for run in (decide, lambda fake, **options: decide_sync(fake, **options)):
        outcome, ran = run(FakeClient(ALLOW, receipt_status="outcome-pending"), mode="remote")
        assert ran == []
        # The same decision and ran as a performed call...
        assert (outcome.decision, outcome.ran) == ("ALLOW", False)
        # ...told apart by the record: an outcome and a message that says it may have run.
        info = outcome.result["guardian"]
        assert info["outcome"] == "unknown" and info["reason_code"] == "EXECUTION_OUTCOME_PENDING"
        assert outcome.message == info["message"] and "It may have run. Do not call it again" in outcome.message
        assert not performed_remotely(outcome)


def test_only_a_performed_remote_call_counts_as_performed():
    for fake, options in (
        (FakeClient(ALLOW), {}),  # ran in process
        (FakeClient(HELD), {"mode": "remote"}),
        (FakeClient(DENIED), {"mode": "remote"}),
        (FakeClient(UNREACHABLE), {"mode": "remote"}),
        (FakeClient(ALLOW, execute_ok=False), {"mode": "remote"}),
    ):
        outcome, _ = decide(fake, **options)
        assert not performed_remotely(outcome)


# --- the sync variant: the same outcomes for a sync Guard ---------------------


def decide_sync(fake, run_tool=None, **options):
    guard = build_guard(
        fake,
        connection_id=CONNECTION,
        agent_name="agent",
        adapter_id=None,
        purpose=None,
        amount_args=None,
        on_execution_error=None,
        require_async=False,
        **{"on_receipt": None, **options},
    )
    ran = []
    outcome = decide_and_run_sync(guard, "refund_order", {"order_id": "A1"}, run_tool or (lambda: ran.append(True)))
    return outcome, ran


def test_a_sync_client_is_refused_unless_the_integration_asks_for_it():
    with pytest.raises(TypeError, match="AsyncGuardianClient"):
        build_guard(
            FakeClient(ALLOW),
            connection_id=CONNECTION,
            agent_name="agent",
            adapter_id=None,
            purpose=None,
            amount_args=None,
            on_receipt=None,
            on_execution_error=None,
        )


def test_sync_outcomes_match_the_async_ones():
    for fake, options in (
        (lambda: FakeClient(ALLOW), {}),
        (lambda: FakeClient(ALLOW), {"mode": "remote"}),
        (lambda: FakeClient(HELD), {}),
        (lambda: FakeClient(DENIED), {}),
        (lambda: FakeClient(UNREACHABLE), {}),
        (lambda: FakeClient(ALLOW, execute_ok=False), {}),
    ):
        expected, ran_async = decide(fake(), **options)
        got, ran_sync = decide_sync(fake(), **options)
        assert got == expected and ran_sync == ran_async


def test_sync_remote_exception_after_guardian_was_asked_is_outcome_unknown():
    def broken_receipt(tool_name, request_id, receipt):
        raise RuntimeError("receipt store down")

    fake = FakeClient(ALLOW)
    outcome, ran = decide_sync(fake, mode="remote", on_receipt=broken_receipt)
    assert ran == [] and fake.calls == ["request:tool.invoke", "execute:req_allow"]
    assert (outcome.decision, outcome.reason_code) == ("DENY", "EXECUTION_OUTCOME_UNKNOWN")
    assert "may have performed it" in outcome.message and "did not run" not in outcome.message


def test_sync_in_process_exception_before_the_tool_starts_did_not_run():
    class Broken(FakeClient):
        def request(self, invocation):
            raise ConnectionError("network down")

    outcome, ran = decide_sync(Broken(ALLOW))
    assert ran == [] and outcome.reason_code == "SERVICE_UNAVAILABLE" and "did not run" in outcome.message


def test_sync_tool_errors_are_the_tools_own():
    def fail():
        raise ValueError("no such order")

    with pytest.raises(ValueError, match="no such order"):
        decide_sync(FakeClient(ALLOW), run_tool=fail)
