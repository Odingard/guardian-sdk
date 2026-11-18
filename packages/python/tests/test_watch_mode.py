"""Watch mode (opt-in): the same cases as the TypeScript core's watch-mode.test.ts.

While the agent is in watch mode, Guardian records what it would have
decided. For a would-ask or a would-deny it issues no capability; a caller
that sent ``x-guardian-watch-aware: 1`` gets a watched answer
(``decision: "DENY"``, reasonCode ``WATCHED``, ``watch: {wouldDecision}``).
The guard asks for it only for an in-process tool, and then runs the
function with nothing to record. A remote tool is never run by the SDK.
"""

import asyncio
import json

import httpx
import pytest

from odingard_guardian import (
    AsyncGuardianClient,
    ExecuteResult,
    Guard,
    GuardianClient,
    GuardianDenied,
    RequestResult,
)

CONNECTION = "pcn_0123456789abcdef0123456789abcdef"


def watched_body(would):
    return {
        "ok": True,
        "requestId": "req_watched01",
        "decision": "DENY",
        "reasonCode": "WATCHED",
        "watch": {"wouldDecision": would},
    }


def make(handler, seen):
    def record(request: httpx.Request) -> httpx.Response:
        seen.append({"headers": dict(request.headers), "body": json.loads(request.content)})
        return handler(request)

    return GuardianClient(base_url="https://g.test/", credential="gac1.test", transport=httpx.MockTransport(record))


def invocation(**extra):
    return {"action": "tool.invoke", "connection_id": CONNECTION, "tool_name": "delete_ticket", "arguments": {}, **extra}


def test_client_sends_the_header_only_when_asked_and_never_in_the_proposal():
    seen = []
    client = make(lambda r: httpx.Response(200, json={"ok": True, "decision": "DENY"}), seen)
    client.request(invocation(watch_aware=True))
    client.request(invocation(watch_aware=False))
    client.request(invocation())
    assert [s["headers"].get("x-guardian-watch-aware") for s in seen] == ["1", None, None]
    for s in seen:
        assert "watch" not in json.dumps(s["body"])


@pytest.mark.parametrize("would", ["ASK", "DENY"])
def test_client_keeps_an_exact_ask_or_deny_on_a_watched_deny(would):
    result = make(lambda r: httpx.Response(200, json=watched_body(would)), []).request(invocation(watch_aware=True))
    assert result == RequestResult(
        ok=True, request_id="req_watched01", decision="DENY", reason_code="WATCHED", watched=would
    )


@pytest.mark.parametrize(
    "body",
    [
        watched_body(None),
        watched_body("ALLOW"),
        watched_body("deny"),
        watched_body(["DENY"]),
        {**watched_body("DENY"), "watch": "DENY"},
        {**watched_body("DENY"), "reasonCode": "POLICY_DENY"},
        {**watched_body("DENY"), "decision": "ASK"},
        {**watched_body("DENY"), "decision": "ALLOW", "token": "cap"},
    ],
)
def test_client_ignores_a_watch_field_anywhere_else(body):
    result = make(lambda r: httpx.Response(200, json=body), []).request(invocation(watch_aware=True))
    assert result.watched is None


def test_client_keeps_no_watched_answer_on_a_claim_or_a_request_that_did_not_ask():
    client = make(lambda r: httpx.Response(200, json=watched_body("DENY")), [])
    assert client.claim("req_watched01").watched is None
    assert client.request(invocation()).watched is None


def test_async_client_sends_the_header_too():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers.get("x-guardian-watch-aware"))
        return httpx.Response(200, json=watched_body("ASK"))

    async def go():
        client = AsyncGuardianClient(
            base_url="https://g.test/", credential="gac1.test", transport=httpx.MockTransport(handler)
        )
        return await client.request(invocation(watch_aware=True))

    result = asyncio.run(go())
    assert seen == ["1"]
    assert result.watched == "ASK"


class FakeClient:
    def __init__(self, invoke):
        self.invoke = invoke
        self.calls = []
        self.invocations = []

    def request(self, inv):
        self.calls.append(f"request:{inv['action']}")
        self.invocations.append(inv)
        return self.invoke

    def claim(self, request_id):
        self.calls.append(f"claim:{request_id}")
        return RequestResult(ok=False, request_id=request_id, reason_code="APPROVAL_PENDING")

    def execute(self, *, request_id, capability_token):
        self.calls.append(f"execute:{request_id}")
        return ExecuteResult(ok=False, reason_code="AUTHORITY_NOT_ALLOWED")


def watched(would):
    return RequestResult(ok=True, request_id="req_watched01", decision="DENY", reason_code="WATCHED", watched=would)


def test_guard_asks_for_the_watched_answer_for_in_process_tools_only():
    local = FakeClient(watched("DENY"))
    Guard(local, connection_id=CONNECTION, watch_mode=True)("delete_ticket")(lambda: "deleted")()
    assert local.invocations[0]["watch_aware"] is True

    remote = FakeClient(RequestResult(ok=True, request_id="req_r", decision="DENY"))
    with pytest.raises(GuardianDenied):
        Guard(remote, connection_id=CONNECTION, watch_mode=True, mode="remote")("delete_ticket")(lambda: "deleted")()
    assert "watch_aware" not in remote.invocations[0]


@pytest.mark.parametrize("would", ["ASK", "DENY"])
def test_guard_runs_the_function_once_records_nothing_and_reports_it(would):
    client = FakeClient(watched(would))
    seen, receipts, ran = [], [], []
    guard = Guard(
        client,
        connection_id=CONNECTION, watch_mode=True,
        on_watched=lambda tool, request_id, decision: seen.append((tool, request_id, decision)),
        on_receipt=lambda tool, request_id, receipt: receipts.append(request_id),
    )

    @guard("delete_ticket")
    def delete(ticket_id: int):
        ran.append(ticket_id)
        return f"deleted {ticket_id}"

    assert delete(1) == "deleted 1"
    assert ran == [1]
    assert client.calls == ["request:tool.invoke"]
    assert seen == [("delete_ticket", "req_watched01", would)]
    assert receipts == []


def test_guard_returns_the_output_even_when_on_watched_raises():
    def boom(*_):
        raise RuntimeError("observer failed")

    guard = Guard(FakeClient(watched("DENY")), connection_id=CONNECTION, watch_mode=True, on_watched=boom)
    assert guard("delete_ticket")(lambda: "deleted")() == "deleted"


@pytest.mark.parametrize(
    "answer",
    [
        RequestResult(ok=True, request_id="r1", decision="DENY"),
        RequestResult(ok=True, request_id="r1", decision="DENY", reason_code="WATCHED"),
        RequestResult(ok=True, request_id="r1", decision="DENY", reason_code="POLICY_DENY", watched="DENY"),
    ],
)
def test_guard_keeps_every_other_deny_a_denial(answer):
    client = FakeClient(answer)
    ran = []
    with pytest.raises(GuardianDenied):
        Guard(client, connection_id=CONNECTION, watch_mode=True)("delete_ticket")(lambda: ran.append(1))()
    assert ran == []
    assert client.calls == ["request:tool.invoke"]


def test_guard_never_runs_a_remote_tool_on_a_watched_answer():
    client = FakeClient(watched("DENY"))
    ran = []
    with pytest.raises(GuardianDenied):
        Guard(client, connection_id=CONNECTION, watch_mode=True, mode="remote")("delete_ticket")(lambda: ran.append(1))()
    assert ran == []
    assert client.calls == ["request:tool.invoke"]


def test_async_guard_runs_the_function_and_awaits_on_watched():
    seen = []

    class AsyncFake(AsyncGuardianClient):
        def __init__(self):  # noqa: D401 — no transport needed
            pass

        async def request(self, inv):
            return watched("ASK")

        async def claim(self, request_id):
            raise AssertionError("no claim")

        async def execute(self, *, request_id, capability_token):
            raise AssertionError("no execute")

    async def on_watched(tool, request_id, decision):
        seen.append(decision)

    guard = Guard(AsyncFake(), connection_id=CONNECTION, watch_mode=True, on_watched=on_watched)

    @guard("delete_ticket")
    async def delete():
        return "deleted"

    assert asyncio.run(delete()) == "deleted"
    assert seen == ["ASK"]


def test_guard_still_checks_the_content_pins_before_the_function_runs(tmp_path):
    from odingard_guardian import GuardianExecutionFailed

    report = tmp_path / "report.pdf"
    report.write_bytes(b"approved bytes")

    class RewritingClient(FakeClient):
        def request(self, inv):
            # The file changes after it was pinned and proposed.
            report.write_bytes(b"other bytes!!")
            return super().request(inv)

    ran = []
    guard = Guard(RewritingClient(watched("DENY")), connection_id=CONNECTION, watch_mode=True)
    with pytest.raises(GuardianExecutionFailed) as failed:
        guard.run(
            "send_report",
            {"attachment_path": str(report)},
            lambda: ran.append(1),
            file_args={"attachment_path": "recheck"},
        )
    assert failed.value.reason_code == "CONTENT_CHANGED_SINCE_APPROVAL"
    assert failed.value.local_effect_ran is False
    assert ran == []


def test_watch_mode_is_off_by_default_no_header_and_a_watched_answer_is_a_denial():
    client = FakeClient(watched("DENY"))
    ran = []
    with pytest.raises(GuardianDenied):
        Guard(client, connection_id=CONNECTION)("delete_ticket")(lambda: ran.append(1))()
    assert ran == []
    assert "watch_aware" not in client.invocations[0]
    assert client.calls == ["request:tool.invoke"]
