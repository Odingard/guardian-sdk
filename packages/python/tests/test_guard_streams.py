"""Generator tools under ``Guard``: a stream is a tool body that has not run yet.

Calling a generator function runs none of its body. So Guardian is asked
when the first item is requested, nothing of the body runs before ALLOW,
and the capability is redeemed when the stream ends (or its consumer
closes it early), never when the generator object is created. One log
records the Guardian calls and the body's steps, so their order is checked.
"""

import asyncio
import gc
import inspect
import os

import pytest

from odingard_guardian import (
    AsyncGuardianClient,
    ExecuteResult,
    Guard,
    GuardianApprovalPending,
    GuardianDenied,
    GuardianExecutionFailed,
    GuardianUnavailable,
    RequestResult,
)

from odingard_guardian.client import ReceiptsResult

CONNECTION = "pcn_0123456789abcdef0123456789abcdef"
ALLOW = RequestResult(ok=True, request_id="req_allow", decision="ALLOW", capability_token="cap")
HELD = RequestResult(ok=False, request_id="req_ask", reason_code="APPROVAL_REQUIRED")
APPROVED = RequestResult(ok=True, request_id="req_ask", decision="ALLOW", capability_token="cap")
DENIED = RequestResult(ok=True, request_id="req_d", decision="DENY", reason_code="POLICY_DENY")
UNREACHABLE = RequestResult(ok=False, reason_code="SERVICE_UNAVAILABLE")
REVOKED = ExecuteResult(ok=False, reason_code="CAPABILITY_REVOKED")


class Fake:
    """A Guardian stand-in that writes its calls into the shared log."""

    def __init__(self, log, invoke=ALLOW, claims=(), executed=None, receipts=None):
        self.log = log
        self.invoke = invoke
        self.claims = list(claims)
        self.executed = executed
        self._receipts = receipts
        self.last_invocation = None

    def request(self, invocation):
        self.log.append("request")
        self.last_invocation = invocation
        return self.invoke

    def claim(self, request_id):
        self.log.append(f"claim:{request_id}")
        if self.claims:
            return self.claims.pop(0)
        return RequestResult(ok=False, request_id=request_id, reason_code="APPROVAL_PENDING")

    def execute(self, *, request_id, capability_token):
        self.log.append(f"execute:{request_id}")
        if self.executed is not None:
            return self.executed
        return ExecuteResult(ok=True, receipt={"schemaVersion": 1, "requestId": request_id, "status": "sent-verified"})

    def receipts(self, request_id):
        self.log.append(f"receipts:{request_id}")
        return self._receipts


class AsyncFake(AsyncGuardianClient):
    def __init__(self, sync):  # noqa: D401 — wraps the sync fake
        self.sync = sync

    async def request(self, invocation):
        return self.sync.request(invocation)

    async def claim(self, request_id):
        return self.sync.claim(request_id)

    async def execute(self, *, request_id, capability_token):
        return self.sync.execute(request_id=request_id, capability_token=capability_token)

    async def receipts(self, request_id):
        return self.sync.receipts(request_id)


def sync_tool(log, guard, name="export_rows"):
    @guard(name)
    def export_rows(n: int):
        log.append("body:start")
        try:
            for i in range(n):
                log.append(f"body:item{i}")
                yield f"row {i}"
        finally:
            log.append("body:end")
        return "all rows"

    return export_rows


def async_tool(log, guard, name="export_rows"):
    @guard(name)
    async def export_rows(n: int):
        log.append("body:start")
        try:
            for i in range(n):
                log.append(f"body:item{i}")
                yield f"row {i}"
        finally:
            log.append("body:end")

    return export_rows


def setup(**options):
    log = []
    fake_options = {k: options.pop(k) for k in ("invoke", "claims", "executed", "receipts") if k in options}
    client = Fake(log, **fake_options)
    guard = Guard(client, connection_id=CONNECTION, **options)
    return log, client, guard


def asetup(**options):
    log = []
    fake_options = {k: options.pop(k) for k in ("invoke", "claims", "executed", "receipts") if k in options}
    client = Fake(log, **fake_options)
    guard = Guard(AsyncFake(client), connection_id=CONNECTION, **options)
    return log, client, guard


# --- sync: a generator function ------------------------------------------------


def test_a_guarded_generator_function_is_still_a_generator_function():
    log, _, guard = setup()
    tool = sync_tool(log, guard)
    assert inspect.isgeneratorfunction(tool)
    assert tool.__name__ == "export_rows"


def test_nothing_is_asked_or_run_until_the_first_item_is_requested():
    log, client, guard = setup()
    stream = sync_tool(log, guard)(2)
    assert inspect.isgenerator(stream)
    assert log == []
    assert next(stream) == "row 0"
    # Guardian was asked first; the body started after the ALLOW; nothing is redeemed yet.
    assert log == ["request", "body:start", "body:item0"]
    assert client.last_invocation["tool_name"] == "export_rows"
    assert client.last_invocation["arguments"] == {"n": 2}


def test_the_capability_is_redeemed_once_the_stream_ends():
    receipts = []
    log, _, guard = setup(on_receipt=lambda tool, request_id, receipt: receipts.append((tool, request_id)))
    items = list(sync_tool(log, guard)(2))
    assert items == ["row 0", "row 1"]
    assert log == ["request", "body:start", "body:item0", "body:item1", "body:end", "execute:req_allow"]
    assert receipts == [("export_rows", "req_allow")]


def test_the_generators_return_value_is_kept():
    log, _, guard = setup()
    stream = sync_tool(log, guard)(1)
    assert next(stream) == "row 0"
    with pytest.raises(StopIteration) as done:
        next(stream)
    assert done.value.value == "all rows"
    assert log[-1] == "execute:req_allow"


def test_an_empty_stream_is_redeemed_when_it_ends():
    log, _, guard = setup()
    assert list(sync_tool(log, guard)(0)) == []
    assert log == ["request", "body:start", "body:end", "execute:req_allow"]


def test_deny_raises_on_the_first_item_and_the_body_never_runs():
    log, _, guard = setup(invoke=DENIED)
    stream = sync_tool(log, guard)(2)
    assert log == []
    with pytest.raises(GuardianDenied) as err:
        next(stream)
    assert err.value.reason_code == "POLICY_DENY"
    assert log == ["request"]
    assert list(stream) == []  # the stream is over


def test_guardian_unreachable_fails_closed():
    log, _, guard = setup(invoke=UNREACHABLE)
    with pytest.raises(GuardianUnavailable):
        list(sync_tool(log, guard)(2))
    assert log == ["request"]


def test_ask_raises_on_the_first_item_and_resume_hands_back_the_stream():
    receipts = []
    log, _, guard = setup(
        invoke=HELD, claims=[APPROVED], on_receipt=lambda tool, request_id, receipt: receipts.append(request_id)
    )
    with pytest.raises(GuardianApprovalPending) as pending:
        next(sync_tool(log, guard)(2))
    assert pending.value.request_id == "req_ask"
    assert pending.value.arguments == {"n": 2}
    assert log == ["request"]

    resumed = pending.value.resume()
    # Approved and claimed, but a stream has not run until it is consumed.
    assert log == ["request", "claim:req_ask"]
    assert resumed.request_id == "req_ask"
    assert resumed.receipt is None
    assert list(resumed.output) == ["row 0", "row 1"]
    assert log[-1] == "execute:req_ask"
    assert receipts == ["req_ask"]


def test_resume_before_approval_is_still_pending():
    log, _, guard = setup(invoke=HELD)
    with pytest.raises(GuardianApprovalPending) as pending:
        next(sync_tool(log, guard)(2))
    with pytest.raises(GuardianApprovalPending):
        pending.value.resume()
    assert "body:start" not in log


def test_result_mode_hands_the_decision_back_as_the_only_item():
    log, _, guard = setup(invoke=DENIED, on_ask="result", on_deny="result")
    items = list(sync_tool(log, guard)(2))
    assert len(items) == 1
    assert items[0]["guardian"]["decision"] == "DENY"
    assert items[0]["guardian"]["reason_code"] == "POLICY_DENY"
    assert log == ["request"]


def test_result_mode_ask_then_the_same_call_after_approval_streams():
    log, _, guard = setup(invoke=HELD, claims=[APPROVED], on_ask="result", on_deny="result")
    tool = sync_tool(log, guard)
    held = list(tool(2))
    assert [item["guardian"]["decision"] for item in held] == ["ASK"]
    assert held[0]["guardian"]["request_id"] == "req_ask"
    assert log == ["request"]
    # The same call again claims the approved request; no second request.
    assert list(tool(2)) == ["row 0", "row 1"]
    assert log == [
        "request",
        "claim:req_ask",
        "body:start",
        "body:item0",
        "body:item1",
        "body:end",
        "execute:req_ask",
    ]


def test_a_body_that_raises_is_not_redeemed():
    log, _, guard = setup()

    @guard("export_rows")
    def export_rows():
        log.append("body:start")
        yield "row 0"
        raise RuntimeError("the export failed")

    stream = export_rows()
    assert next(stream) == "row 0"
    with pytest.raises(RuntimeError, match="the export failed"):
        next(stream)
    assert log == ["request", "body:start"]  # as for a function that raises


def test_a_stream_closed_early_is_redeemed_and_recorded():
    receipts = []
    log, _, guard = setup(on_receipt=lambda tool, request_id, receipt: receipts.append(request_id))
    stream = sync_tool(log, guard)(5)
    assert next(stream) == "row 0"
    stream.close()
    # The body was closed first (its finally ran), then the capability redeemed.
    assert log == ["request", "body:start", "body:item0", "body:end", "execute:req_allow"]
    assert receipts == ["req_allow"]
    assert list(stream) == []


def test_breaking_out_of_a_loop_and_dropping_the_stream_redeems_it():
    log, _, guard = setup()
    for row in sync_tool(log, guard)(5):
        assert row == "row 0"
        break
    gc.collect()
    assert log == ["request", "body:start", "body:item0", "body:end", "execute:req_allow"]


def test_a_stream_that_is_never_started_asks_and_redeems_nothing():
    log, _, guard = setup()
    stream = sync_tool(log, guard)(2)
    stream.close()
    del stream
    gc.collect()
    assert log == []


def test_a_failed_redemption_after_the_stream_raises_after_the_last_item():
    errors = []
    log, _, guard = setup(executed=REVOKED, on_execution_error=errors.append)
    stream = sync_tool(log, guard)(1)
    assert next(stream) == "row 0"
    with pytest.raises(GuardianExecutionFailed) as err:
        next(stream)
    assert err.value.reason_code == "CAPABILITY_REVOKED"
    assert err.value.local_effect_ran is True
    assert errors == [err.value]


def test_a_failed_redemption_in_result_mode_is_the_last_item():
    log, _, guard = setup(executed=REVOKED, on_deny="result")
    items = list(sync_tool(log, guard)(1))
    assert items[0] == "row 0"
    assert items[1]["guardian"]["outcome"] == "ran_unrecorded"
    assert items[1]["guardian"]["local_effect_ran"] is True
    assert len(items) == 2


def test_a_failed_redemption_of_a_closed_stream_raises_from_close():
    errors = []
    log, _, guard = setup(executed=REVOKED, on_execution_error=errors.append)
    stream = sync_tool(log, guard)(5)
    next(stream)
    with pytest.raises(GuardianExecutionFailed) as err:
        stream.close()
    assert err.value.local_effect_ran is True
    assert errors == [err.value]


def test_a_failed_redemption_of_a_closed_stream_in_result_mode_reaches_the_hook():
    errors = []
    log, _, guard = setup(executed=REVOKED, on_deny="result", on_execution_error=errors.append)
    stream = sync_tool(log, guard)(5)
    next(stream)
    stream.close()  # a closed stream takes no more items
    assert [e.reason_code for e in errors] == ["CAPABILITY_REVOKED"]


def test_a_lost_redemption_answer_is_looked_up_after_the_stream():
    receipts = []
    log, _, guard = setup(
        executed=ExecuteResult(ok=False, reason_code="SERVICE_UNAVAILABLE"),
        receipts=ReceiptsResult(ok=True, receipts=[{"state": "verified", "attemptId": "att_1"}]),
        on_receipt=lambda tool, request_id, receipt: receipts.append(receipt["status"]),
    )
    assert list(sync_tool(log, guard)(1)) == ["row 0"]
    assert log[-2:] == ["execute:req_allow", "receipts:req_allow"]
    assert receipts == ["sent-verified"]


def test_send_and_throw_reach_the_body():
    log, _, guard = setup()

    @guard("chat")
    def chat():
        try:
            got = yield "ready"
            yield f"got {got}"
        except KeyError:
            yield "recovered"

    stream = chat()
    assert next(stream) == "ready"
    assert stream.send("hello") == "got hello"
    assert stream.throw(KeyError("x")) == "recovered"
    assert list(stream) == []
    assert log == ["request", "execute:req_allow"]


def test_remote_mode_yields_guardians_result_and_never_runs_the_body():
    log, _, guard = setup(mode="remote")
    items = list(sync_tool(log, guard)(2))
    assert len(items) == 1
    assert items[0]["guardian"]["decision"] == "ALLOW"
    assert items[0]["guardian"]["receipt"]["status"] == "sent-verified"
    assert log == ["request", "execute:req_allow"]


def test_watch_mode_runs_the_stream_and_records_nothing():
    watched = []
    log, _, guard = setup(
        invoke=RequestResult(ok=True, request_id="req_w", decision="DENY", reason_code="WATCHED", watched="ASK"),
        watch_mode=True,
        on_watched=lambda tool, request_id, would: watched.append((log[-1], would)),
    )
    assert list(sync_tool(log, guard)(1)) == ["row 0"]
    assert log == ["request", "body:start", "body:item0", "body:end"]
    assert watched == [("body:end", "ASK")]  # told after the stream ended


def test_a_wrong_call_is_reported_when_the_stream_starts():
    log, _, guard = setup()
    stream = sync_tool(log, guard)()  # n is missing
    with pytest.raises(TypeError):
        next(stream)
    assert log == []


# --- sync: a function that returns a generator ---------------------------------
# Its own body has run when it returns, so it is an ordinary call: redeemed
# at the return, and the generator is handed back as it is.


def returning_tool(log, guard, made):
    def rows(n):
        log.append("rows:start")
        for i in range(n):
            yield f"row {i}"

    @guard("refund")
    def refund(n: int):
        log.append("body:charged back")  # the action itself
        made.append(rows(n))
        return made[-1]

    return refund


def test_a_function_returning_a_generator_is_redeemed_when_it_returns():
    log, _, guard = setup()
    made = []
    tool = returning_tool(log, guard, made)
    assert not inspect.isgeneratorfunction(tool)
    stream = tool(2)
    assert log == ["request", "body:charged back", "execute:req_allow"]
    assert stream is made[0]  # handed back unchanged
    assert list(stream) == ["row 0", "row 1"]
    assert log == ["request", "body:charged back", "execute:req_allow", "rows:start"]


def test_a_returned_generator_that_is_never_consumed_is_still_recorded():
    log, _, guard = setup()
    stream = returning_tool(log, guard, [])(2)
    del stream
    gc.collect()
    assert log == ["request", "body:charged back", "execute:req_allow"]


def test_a_function_returning_a_generator_is_denied_at_the_call():
    log, _, guard = setup(invoke=DENIED)
    with pytest.raises(GuardianDenied):
        returning_tool(log, guard, [])(2)
    assert log == ["request"]


def test_guard_run_with_a_generator_function_defers_until_the_stream_ends():
    log, _, guard = setup()

    def rows():
        log.append("body:start")
        yield 1

    stream = guard.run("export_rows", {"n": 1}, rows)
    assert log == ["request"]  # calling a generator function ran nothing
    assert list(stream) == [1]
    assert log == ["request", "body:start", "execute:req_allow"]


def test_guard_run_with_a_function_returning_a_generator_is_redeemed_at_the_return():
    log, _, guard = setup()
    made = (i for i in range(2))

    def fn():
        log.append("body")
        return made

    assert guard.run("export_rows", {}, fn) is made
    assert log == ["request", "body", "execute:req_allow"]


def test_other_iterators_are_data_and_returned_as_they_are():
    log, _, guard = setup()
    made = iter(["a", "b"])

    @guard("list_rows")
    def list_rows():
        return made

    assert list_rows() is made
    assert log == ["request", "execute:req_allow"]  # redeemed when the function returned


def test_file_args_copy_lives_until_the_stream_ends(tmp_path):
    if os.name == "nt":
        pytest.skip("content pins are not supported on Windows")
    report = tmp_path / "report.txt"
    report.write_bytes(b"approved bytes")
    log, client, guard = setup()
    seen = {}

    @guard("send_report", file_args={"path": "copy"})
    def send_report(path: str):
        seen["path"] = path
        with open(path, "rb") as handle:
            yield handle.read()
        assert os.path.exists(path)  # still there while the stream runs
        yield "sent"

    stream = send_report(str(report))
    assert next(stream) == b"approved bytes"
    assert seen["path"] != str(report)
    assert os.path.exists(seen["path"])
    assert list(stream) == ["sent"]
    assert not os.path.exists(seen["path"])  # deleted when the stream ended
    assert "guardianContentPins" in client.last_invocation["arguments"]
    assert log == ["request", "execute:req_allow"]


def test_file_args_changed_file_refuses_the_stream(tmp_path):
    if os.name == "nt":
        pytest.skip("content pins are not supported on Windows")
    report = tmp_path / "report.txt"
    report.write_bytes(b"approved bytes")
    log, client, guard = setup(invoke=HELD, claims=[APPROVED])
    ran = []

    @guard("send_report", file_args=["path"])
    def send_report(path):
        ran.append(1)
        yield path.read()

    with pytest.raises(GuardianApprovalPending) as pending:
        next(send_report(str(report)))
    report.write_bytes(b"changed after approval")
    with pytest.raises(GuardianExecutionFailed) as err:
        pending.value.resume()
    assert err.value.reason_code == "CONTENT_CHANGED_SINCE_APPROVAL"
    assert ran == []
    assert "execute:req_ask" not in log


# --- sync guard, async stream --------------------------------------------------


def test_an_async_generator_function_needs_an_async_guard():
    _, _, guard = setup()
    with pytest.raises(TypeError, match="AsyncGuardianClient"):

        @guard("export_rows")
        async def export_rows():
            yield 1


def test_a_returned_async_generator_is_handed_back_by_a_sync_guard():
    log, _, guard = setup()

    async def rows():
        yield 1

    made = rows()

    @guard("export_rows")
    def export_rows():
        log.append("body")
        return made

    assert export_rows() is made
    assert log == ["request", "body", "execute:req_allow"]


def test_guard_run_with_an_async_generator_function_needs_an_async_guard():
    log, _, guard = setup()

    async def rows():
        log.append("body:start")
        yield 1

    with pytest.raises(TypeError, match="AsyncGuardianClient"):
        guard.run("export_rows", {}, rows)
    assert log == ["request"]  # nothing ran, nothing was redeemed


# --- file_args: a private copy outlives the body of a dropped stream ------------


def copy_tool(log, guard, seen):
    @guard("send_report", file_args={"path": "copy"})
    def send_report(path: str):
        seen["path"] = path
        try:
            yield "started"
            yield "more"
        finally:
            with open(path, "rb") as handle:  # the body's cleanup reads the copy
                log.append(("finally read", handle.read()))

    return send_report


def test_a_dropped_stream_keeps_its_private_copy_until_the_body_has_closed(tmp_path):
    if os.name == "nt":
        pytest.skip("content pins are not supported on Windows")
    report = tmp_path / "report.txt"
    report.write_bytes(b"approved bytes")
    log, _, guard = setup()
    seen = {}
    stream = copy_tool(log, guard, seen)(str(report))
    assert next(stream) == "started"
    del stream
    gc.collect()
    assert log == ["request", ("finally read", b"approved bytes"), "execute:req_allow"]
    assert not os.path.exists(seen["path"])  # deleted after the body closed


def test_a_resumed_stream_dropped_midway_keeps_its_copy_until_the_body_has_closed(tmp_path):
    """The resumed stream is the object the caller drops: Python runs its
    weak-reference callbacks before it closes the body."""
    if os.name == "nt":
        pytest.skip("content pins are not supported on Windows")
    report = tmp_path / "report.txt"
    report.write_bytes(b"approved bytes")
    log, _, guard = setup(invoke=HELD, claims=[APPROVED])
    seen = {}
    with pytest.raises(GuardianApprovalPending) as pending:
        next(copy_tool(log, guard, seen)(str(report)))
    stream = pending.value.resume().output
    assert next(stream) == "started"
    del stream
    gc.collect()
    assert log == ["request", "claim:req_ask", ("finally read", b"approved bytes"), "execute:req_ask"]
    assert not os.path.exists(seen["path"])


async def test_async_a_resumed_stream_dropped_midway_keeps_its_copy_until_the_body_has_closed(tmp_path):
    if os.name == "nt":
        pytest.skip("content pins are not supported on Windows")
    report = tmp_path / "report.txt"
    report.write_bytes(b"approved bytes")
    log, _, guard = asetup(invoke=HELD, claims=[APPROVED])
    seen = {}

    @guard("send_report", file_args={"path": "copy"})
    async def send_report(path: str):
        seen["path"] = path
        try:
            yield "started"
            yield "more"
        finally:
            with open(path, "rb") as handle:
                log.append(("finally read", handle.read()))

    with pytest.raises(GuardianApprovalPending) as pending:
        await send_report(str(report)).__anext__()
    stream = (await pending.value.resume()).output
    assert await stream.__anext__() == "started"
    del stream
    gc.collect()
    for _ in range(5):
        await asyncio.sleep(0)
    assert log == ["request", "claim:req_ask", ("finally read", b"approved bytes"), "execute:req_ask"]
    assert not os.path.exists(seen["path"])


def test_a_resumed_stream_that_is_never_started_deletes_its_private_copy(tmp_path):
    if os.name == "nt":
        pytest.skip("content pins are not supported on Windows")
    import glob
    import tempfile

    report = tmp_path / "report.txt"
    report.write_bytes(b"approved bytes")
    log, _, guard = setup(invoke=HELD, claims=[APPROVED])
    with pytest.raises(GuardianApprovalPending) as pending:
        next(copy_tool(log, guard, {})(str(report)))
    before = set(glob.glob(os.path.join(tempfile.gettempdir(), "*")))
    resumed = pending.value.resume()
    copies = set(glob.glob(os.path.join(tempfile.gettempdir(), "*"))) - before
    assert len(copies) == 1
    del resumed
    gc.collect()
    assert not any(os.path.exists(path) for path in copies)
    assert log == ["request", "claim:req_ask"]  # never started: nothing ran or was redeemed


async def test_async_a_dropped_stream_keeps_its_private_copy_until_the_body_has_closed(tmp_path):
    if os.name == "nt":
        pytest.skip("content pins are not supported on Windows")
    report = tmp_path / "report.txt"
    report.write_bytes(b"approved bytes")
    log, _, guard = asetup()
    seen = {}

    @guard("send_report", file_args={"path": "copy"})
    async def send_report(path: str):
        seen["path"] = path
        try:
            yield "started"
            yield "more"
        finally:
            with open(path, "rb") as handle:
                log.append(("finally read", handle.read()))

    stream = send_report(str(report))
    assert await stream.__anext__() == "started"
    del stream
    gc.collect()
    for _ in range(5):
        await asyncio.sleep(0)
    assert log == ["request", ("finally read", b"approved bytes"), "execute:req_allow"]
    assert not os.path.exists(seen["path"])


# --- async ---------------------------------------------------------------------


async def test_async_a_guarded_async_generator_function_is_still_one():
    log, _, guard = asetup()
    tool = async_tool(log, guard)
    assert inspect.isasyncgenfunction(tool)
    stream = tool(2)
    assert inspect.isasyncgen(stream)
    assert log == []
    assert await stream.__anext__() == "row 0"
    assert log == ["request", "body:start", "body:item0"]
    assert [item async for item in stream] == ["row 1"]
    assert log == ["request", "body:start", "body:item0", "body:item1", "body:end", "execute:req_allow"]


async def test_async_on_receipt_is_awaited_when_the_stream_ends():
    receipts = []

    async def on_receipt(tool, request_id, receipt):
        receipts.append(request_id)

    log, _, guard = asetup(on_receipt=on_receipt)
    assert [item async for item in async_tool(log, guard)(1)] == ["row 0"]
    assert receipts == ["req_allow"]


async def test_async_a_sync_generator_function_becomes_an_async_stream():
    log, _, guard = asetup()
    tool = sync_tool(log, guard)
    assert inspect.isasyncgenfunction(tool)
    assert [item async for item in tool(2)] == ["row 0", "row 1"]
    assert log == ["request", "body:start", "body:item0", "body:item1", "body:end", "execute:req_allow"]


async def test_async_deny_raises_on_the_first_item():
    log, _, guard = asetup(invoke=DENIED)
    stream = async_tool(log, guard)(2)
    with pytest.raises(GuardianDenied):
        await stream.__anext__()
    assert log == ["request"]


async def test_async_ask_then_resume_hands_back_the_stream():
    log, _, guard = asetup(invoke=HELD, claims=[APPROVED])
    with pytest.raises(GuardianApprovalPending) as pending:
        await async_tool(log, guard)(2).__anext__()
    assert log == ["request"]
    resumed = await pending.value.resume()
    assert log == ["request", "claim:req_ask"]
    assert resumed.receipt is None
    assert [item async for item in resumed.output] == ["row 0", "row 1"]
    assert log[-1] == "execute:req_ask"


async def test_async_result_mode_hands_the_decision_back_as_the_only_item():
    log, _, guard = asetup(invoke=HELD, claims=[APPROVED], on_ask="result", on_deny="result")
    tool = async_tool(log, guard)
    held = [item async for item in tool(1)]
    assert [item["guardian"]["decision"] for item in held] == ["ASK"]
    assert [item async for item in tool(1)] == ["row 0"]
    assert log == ["request", "claim:req_ask", "body:start", "body:item0", "body:end", "execute:req_ask"]


async def test_async_a_body_that_raises_is_not_redeemed():
    log, _, guard = asetup()

    @guard("export_rows")
    async def export_rows():
        yield "row 0"
        raise RuntimeError("the export failed")

    stream = export_rows()
    assert await stream.__anext__() == "row 0"
    with pytest.raises(RuntimeError, match="the export failed"):
        await stream.__anext__()
    assert log == ["request"]


async def test_async_a_stream_closed_early_is_redeemed_and_recorded():
    log, _, guard = asetup()
    stream = async_tool(log, guard)(5)
    assert await stream.__anext__() == "row 0"
    await stream.aclose()
    assert log == ["request", "body:start", "body:item0", "body:end", "execute:req_allow"]


async def test_async_a_dropped_stream_is_redeemed_when_it_is_collected():
    log, _, guard = asetup()
    stream = async_tool(log, guard)(5)
    assert await stream.__anext__() == "row 0"
    del stream
    gc.collect()
    for _ in range(5):  # the event loop closes a collected async generator
        await asyncio.sleep(0)
    assert log == ["request", "body:start", "body:item0", "body:end", "execute:req_allow"]


async def test_async_a_failed_redemption_raises_after_the_last_item():
    log, _, guard = asetup(executed=REVOKED)
    stream = async_tool(log, guard)(1)
    assert await stream.__anext__() == "row 0"
    with pytest.raises(GuardianExecutionFailed) as err:
        await stream.__anext__()
    assert err.value.local_effect_ran is True


async def test_async_a_failed_redemption_in_result_mode_is_the_last_item():
    log, _, guard = asetup(executed=REVOKED, on_deny="result")
    items = [item async for item in async_tool(log, guard)(1)]
    assert items[0] == "row 0"
    assert items[1]["guardian"]["outcome"] == "ran_unrecorded"


async def test_async_a_failed_redemption_of_a_closed_stream_raises_from_aclose():
    log, _, guard = asetup(executed=REVOKED)
    stream = async_tool(log, guard)(5)
    await stream.__anext__()
    with pytest.raises(GuardianExecutionFailed):
        await stream.aclose()


async def test_async_remote_mode_yields_guardians_result():
    log, _, guard = asetup(mode="remote")
    items = [item async for item in async_tool(log, guard)(2)]
    assert [item["guardian"]["decision"] for item in items] == ["ALLOW"]
    assert log == ["request", "execute:req_allow"]


async def test_async_a_coroutine_returning_an_async_generator_is_redeemed_when_it_returns():
    log, _, guard = asetup()

    async def rows():
        log.append("rows:start")
        yield "row 0"

    made = []

    @guard("export_rows")
    async def export_rows():
        log.append("body")
        made.append(rows())
        return made[0]

    stream = await export_rows()
    assert stream is made[0]
    assert log == ["request", "body", "execute:req_allow"]
    assert [item async for item in stream] == ["row 0"]


async def test_async_a_sync_function_returning_a_generator_gets_the_generator_itself():
    log, _, guard = asetup()

    @guard("rows")
    def rows(n: int):
        log.append("body")
        return (i for i in range(n))

    out = await rows(2)
    assert inspect.isgenerator(out)  # not wrapped in an async stream
    assert log == ["request", "body", "execute:req_allow"]  # redeemed at the return
    assert list(out) == [0, 1]


async def test_async_guard_run_with_an_async_generator_function_defers():
    log, _, guard = asetup()

    async def rows():
        log.append("body:start")
        yield "row 0"

    stream = await guard.run("export_rows", {}, rows)
    assert log == ["request"]
    assert [item async for item in stream] == ["row 0"]
    assert log == ["request", "body:start", "execute:req_allow"]


async def test_async_send_and_throw_reach_the_body():
    log, _, guard = asetup()

    @guard("chat")
    async def chat():
        try:
            got = yield "ready"
            yield f"got {got}"
        except KeyError:
            yield "recovered"

    stream = chat()
    assert await stream.__anext__() == "ready"
    assert await stream.asend("hello") == "got hello"
    assert await stream.athrow(KeyError("x")) == "recovered"
    assert [item async for item in stream] == []
    assert log == ["request", "execute:req_allow"]


async def test_async_an_exception_thrown_into_the_stream_is_not_redeemed():
    log, _, guard = asetup()
    stream = async_tool(log, guard)(5)
    await stream.__anext__()
    with pytest.raises(KeyError):
        await stream.athrow(KeyError("stop"))
    assert log == ["request", "body:start", "body:item0", "body:end"]


# --- ordinary functions are unchanged ------------------------------------------


def test_an_ordinary_function_is_decided_and_redeemed_at_the_call():
    log, _, guard = setup()

    @guard("pay")
    def pay(amount: int):
        log.append("body")
        return {"paid": amount}

    assert not inspect.isgeneratorfunction(pay)
    assert pay(5) == {"paid": 5}
    assert log == ["request", "body", "execute:req_allow"]


async def test_async_an_ordinary_coroutine_function_is_unchanged():
    log, _, guard = asetup()

    @guard("pay")
    async def pay(amount: int):
        log.append("body")
        return {"paid": amount}

    assert inspect.iscoroutinefunction(pay)
    assert await pay(5) == {"paid": 5}
    assert log == ["request", "body", "execute:req_allow"]
