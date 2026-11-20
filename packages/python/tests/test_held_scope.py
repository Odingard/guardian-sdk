"""Held requests are scoped per session.

With ``on_ask="result"`` a Guard remembers a held request so the same call
made again after approval claims it. A scope names the session a call
belongs to: a request held under one scope is claimed only by the same
call under the same scope. The scope stays in this process.
"""

import contextvars

import pytest

from odingard_guardian import SCOPE_UNKNOWN, ExecuteResult, Guard, GuardianApprovalPending, RequestResult
from odingard_guardian._framework import decide_and_run, resolve_scope

from test_guard import AsyncFake

CONNECTION = "pcn_0123456789abcdef0123456789abcdef"
ARGS = {"order_id": "o42", "amount_cents": 500}


class Holding:
    """Holds every request under its own id; a claim is approved."""

    def __init__(self):
        self.calls = []
        self.invocations = []

    def request(self, invocation):
        self.invocations.append(invocation)
        request_id = f"req_{len(self.invocations)}"
        self.calls.append(f"request:{request_id}")
        return RequestResult(ok=False, request_id=request_id, reason_code="APPROVAL_REQUIRED")

    def claim(self, request_id):
        self.calls.append(f"claim:{request_id}")
        return RequestResult(ok=True, request_id=request_id, decision="ALLOW", capability_token="cap")

    def execute(self, *, request_id, capability_token):
        self.calls.append(f"execute:{request_id}")
        return ExecuteResult(ok=True, receipt={"schemaVersion": 1, "requestId": request_id, "status": "sent-verified"})


def make(**options):
    client = Holding()
    ran = []
    guard = Guard(client, connection_id=CONNECTION, on_ask="result", on_deny="result", **options)

    def refund(scope=None, **kwargs):
        return guard.run("refund_order", dict(ARGS), lambda: ran.append(scope) or "refunded", scope=scope, **kwargs)

    return client, guard, ran, refund


def request_id_of(result):
    return result["guardian"]["request_id"]


def test_a_held_request_is_claimed_only_under_the_same_scope():
    client, _, ran, refund = make()
    assert request_id_of(refund("alice")) == "req_1"
    # The identical call in another session is a request of its own.
    assert request_id_of(refund("bob")) == "req_2"
    assert ran == []
    # Each session's repeat call claims its own request and runs once.
    assert refund("alice") == "refunded"
    assert refund("bob") == "refunded"
    assert ran == ["alice", "bob"]
    assert client.calls == [
        "request:req_1",
        "request:req_2",
        "claim:req_1",
        "execute:req_1",
        "claim:req_2",
        "execute:req_2",
    ]


def test_the_scope_is_not_sent_to_guardian():
    client, _, _, refund = make()
    refund("alice")
    refund()
    scoped, unscoped = client.invocations
    assert scoped == unscoped
    assert "alice" not in repr(scoped)


def test_without_a_scope_the_key_is_the_call_alone_as_before():
    client, guard, ran, refund = make()
    assert request_id_of(refund()) == "req_1"
    assert list(guard._opts.held) == [
        'tool\x00pcn_0123456789abcdef0123456789abcdef\x00refund_order\x00{"amount_cents":500,"order_id":"o42"}'
    ]
    assert refund() == "refunded"
    assert client.calls == ["request:req_1", "claim:req_1", "execute:req_1"]


def test_a_scoped_call_does_not_claim_an_unscoped_request_or_the_other_way_round():
    client, _, ran, refund = make()
    assert request_id_of(refund()) == "req_1"
    assert request_id_of(refund("alice")) == "req_2"
    assert refund() == "refunded"
    assert client.calls == ["request:req_1", "request:req_2", "claim:req_1", "execute:req_1"]


def test_scope_unknown_never_remembers_a_held_request():
    client, guard, ran, refund = make()
    first = refund(SCOPE_UNKNOWN)
    second = refund(SCOPE_UNKNOWN)
    assert (request_id_of(first), request_id_of(second)) == ("req_1", "req_2")
    assert guard._opts.held == {}
    assert ran == []
    assert client.calls == ["request:req_1", "request:req_2"]
    # The model is not told to call again: that would not use this approval.
    assert "asks for a new approval" in first["guardian"]["message"]
    assert "call the tool again with the same arguments" not in first["guardian"]["message"]
    assert repr(SCOPE_UNKNOWN) == "SCOPE_UNKNOWN"


def test_any_hashable_value_is_a_scope():
    client, _, _, refund = make()
    refund(("tenant-1", 7))
    assert refund(("tenant-1", 7)) == "refunded"
    assert client.calls == ["request:req_1", "claim:req_1", "execute:req_1"]


def test_a_scope_that_cannot_be_hashed_is_refused_before_anything_is_proposed():
    client, _, ran, refund = make()
    with pytest.raises(TypeError):
        refund(["alice"])
    assert client.calls == [] and ran == []


def test_the_guards_scope_function_scopes_decorated_calls():
    session = contextvars.ContextVar("session")
    client, guard, _, _ = make(scope=session.get)
    ran = []

    @guard("refund_order")
    def refund_order(order_id: str, amount_cents: int):
        ran.append(session.get())
        return "refunded"

    session.set("alice")
    assert request_id_of(refund_order("o42", 500)) == "req_1"
    session.set("bob")
    assert request_id_of(refund_order("o42", 500)) == "req_2"
    session.set("alice")
    assert refund_order("o42", 500) == "refunded"
    assert ran == ["alice"]
    assert client.calls == ["request:req_1", "request:req_2", "claim:req_1", "execute:req_1"]


def test_a_scope_given_with_the_call_overrides_the_guards():
    client, _, _, refund = make(scope=lambda: "from-guard")
    refund("alice")
    refund()  # the guard's scope
    assert refund("alice") == "refunded"
    assert client.calls == ["request:req_1", "request:req_2", "claim:req_1", "execute:req_1"]


def test_a_failing_scope_function_is_raised_before_anything_is_proposed():
    def no_session():
        raise LookupError("no session")

    client, _, ran, refund = make(scope=no_session)
    with pytest.raises(LookupError):
        refund()
    assert client.calls == [] and ran == []
    with pytest.raises(TypeError):
        Guard(client, connection_id=CONNECTION, scope="alice")


def test_raise_mode_remembers_nothing_and_resume_claims_its_own_request():
    client = Holding()
    guard = Guard(client, connection_id=CONNECTION)
    ran = []
    pending = []
    for scope in ("alice", "bob"):
        with pytest.raises(GuardianApprovalPending) as held:
            guard.run("refund_order", dict(ARGS), lambda scope=scope: ran.append(scope), scope=scope)
        pending.append(held.value)
    assert guard._opts.held == {}
    assert [p.request_id for p in pending] == ["req_1", "req_2"]
    pending[1].resume()
    assert ran == ["bob"]
    assert client.calls[-2:] == ["claim:req_2", "execute:req_2"]


async def test_async_a_held_request_is_claimed_only_under_the_same_scope():
    client = Holding()
    guard = Guard(AsyncFake(client), connection_id=CONNECTION, on_ask="result", on_deny="result")
    ran = []

    async def body():
        ran.append(1)
        return "refunded"

    assert request_id_of(await guard.run("refund_order", dict(ARGS), body, scope="alice")) == "req_1"
    assert request_id_of(await guard.run("refund_order", dict(ARGS), body, scope="bob")) == "req_2"
    assert await guard.run("refund_order", dict(ARGS), body, scope="alice") == "refunded"
    assert client.calls == ["request:req_1", "request:req_2", "claim:req_1", "execute:req_1"]


# --- the framework core ---------------------------------------------------------


def framework_guard(client):
    return Guard(
        AsyncFake(client), connection_id=CONNECTION, on_ask="result", on_deny="result", on_execution_failed="result"
    )


async def test_decide_and_run_scopes_held_requests():
    client = Holding()
    guard = framework_guard(client)
    ran = []

    async def run_tool():
        ran.append(1)

    first = await decide_and_run(guard, "refund_order", ARGS, run_tool, scope="alice")
    other = await decide_and_run(guard, "refund_order", ARGS, run_tool, scope="bob")
    assert (first.request_id, other.request_id) == ("req_1", "req_2")
    again = await decide_and_run(guard, "refund_order", ARGS, run_tool, scope="alice")
    assert again.ran and again.decision == "ALLOW"
    assert client.calls == ["request:req_1", "request:req_2", "claim:req_1", "execute:req_1"]


async def test_decide_and_run_with_scope_unknown_never_claims():
    client = Holding()
    guard = framework_guard(client)

    async def run_tool():
        raise AssertionError("never runs")

    for _ in range(2):
        outcome = await decide_and_run(guard, "refund_order", ARGS, run_tool, scope=SCOPE_UNKNOWN)
        assert outcome.decision == "ASK" and not outcome.ran
    assert client.calls == ["request:req_1", "request:req_2"]


async def test_decide_and_run_without_a_scope_is_unchanged():
    client = Holding()
    guard = framework_guard(client)
    ran = []

    async def run_tool():
        ran.append(1)

    await decide_and_run(guard, "refund_order", ARGS, run_tool)
    assert (await decide_and_run(guard, "refund_order", ARGS, run_tool)).ran
    assert client.calls == ["request:req_1", "claim:req_1", "execute:req_1"]


def test_resolve_scope_fails_to_the_strict_side():
    def broken(context):
        raise RuntimeError("no session")

    assert resolve_scope(None, object()) is SCOPE_UNKNOWN
    assert resolve_scope(None, object(), "session-1") == "session-1"
    assert resolve_scope(None, object(), None) is SCOPE_UNKNOWN
    assert resolve_scope(lambda context: "user-7", object(), "session-1") == "user-7"
    assert resolve_scope(lambda context: None, object(), "session-1") is SCOPE_UNKNOWN
    assert resolve_scope(lambda context: ["unhashable"], object(), "session-1") is SCOPE_UNKNOWN
    assert resolve_scope(broken, object(), "session-1") is SCOPE_UNKNOWN
    assert resolve_scope(lambda context: SCOPE_UNKNOWN, object(), "session-1") is SCOPE_UNKNOWN
