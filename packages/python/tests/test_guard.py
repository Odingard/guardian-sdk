"""Guard semantics: the same cases as the TypeScript core's guard.test.ts."""

import pytest

from odingard_guardian import (
    AsyncGuardianClient,
    ExecuteResult,
    Guard,
    GuardianApprovalPending,
    GuardianDenied,
    GuardianExecutionFailed,
    RequestResult,
)

CONNECTION = "pcn_0123456789abcdef0123456789abcdef"
ALLOW = RequestResult(ok=True, request_id="req_allow", decision="ALLOW", capability_token="cap")
HELD = RequestResult(ok=False, request_id="req_ask", reason_code="APPROVAL_REQUIRED")
INSTALLED = RequestResult(ok=False, reason_code="TOOL_ALREADY_INSTALLED")


class FakeClient:
    def __init__(self, invoke, claims=(), execute_ok=True, install=INSTALLED, receipt_status="sent-verified"):
        self.invoke = invoke
        self.claims = list(claims)
        self.execute_ok = execute_ok
        self.install = install
        self.receipt_status = receipt_status
        self.calls = []

    def request(self, invocation):
        self.calls.append(f"request:{invocation['action']}")
        self.last_invocation = invocation
        return self.install if invocation["action"] == "mcp.install" else self.invoke

    def claim(self, request_id):
        self.calls.append(f"claim:{request_id}")
        if self.claims:
            return self.claims.pop(0)
        return RequestResult(ok=False, request_id=request_id, reason_code="APPROVAL_PENDING")

    def execute(self, *, request_id, capability_token):
        self.calls.append(f"execute:{request_id}")
        if not self.execute_ok:
            return ExecuteResult(ok=False, reason_code="CAPABILITY_REVOKED")
        return ExecuteResult(
            ok=True, receipt={"schemaVersion": 1, "requestId": request_id, "status": self.receipt_status}
        )


class AsyncFake(AsyncGuardianClient):
    def __init__(self, sync):  # noqa: D401 — wraps the sync fake
        self.sync = sync

    async def request(self, invocation):
        return self.sync.request(invocation)

    async def claim(self, request_id):
        return self.sync.claim(request_id)

    async def execute(self, *, request_id, capability_token):
        return self.sync.execute(request_id=request_id, capability_token=capability_token)


def test_allow_runs_once_then_records_the_receipt():
    client = FakeClient(ALLOW)
    receipts = []
    guard = Guard(client, connection_id=CONNECTION, on_receipt=lambda t, r, rc: receipts.append(r))
    ran = []

    @guard("pay_invoice")
    def pay(invoice_id: str, amount_cents: int = 0):
        ran.append(invoice_id)
        return {"paid": amount_cents}

    assert pay("INV-1", amount_cents=100) == {"paid": 100}
    assert ran == ["INV-1"]
    assert receipts == ["req_allow"]
    # No first-use registration by default.
    assert client.calls == ["request:tool.invoke", "execute:req_allow"]
    # The proposal carries the bound call arguments.
    assert client.last_invocation["arguments"] == {"invoice_id": "INV-1", "amount_cents": 100}
    assert client.last_invocation["tool_name"] == "pay_invoice"


def test_deny_never_runs():
    client = FakeClient(RequestResult(ok=True, request_id="req_d", decision="DENY", reason_code="POLICY_DENY"))
    ran = []
    pay = Guard(client, connection_id=CONNECTION)("pay")(lambda: ran.append(1))
    with pytest.raises(GuardianDenied) as err:
        pay()
    assert err.value.reason_code == "POLICY_DENY"
    assert ran == []


def test_ask_never_runs_until_approved_then_resume_runs_it():
    client = FakeClient(
        HELD,
        claims=[
            RequestResult(ok=False, request_id="req_ask", reason_code="APPROVAL_PENDING"),
            RequestResult(ok=True, request_id="req_ask", decision="ALLOW", capability_token="cap"),
        ],
    )
    ran = []
    pay = Guard(client, connection_id=CONNECTION)("pay")(lambda: ran.append(1) or "paid")
    with pytest.raises(GuardianApprovalPending) as pending:
        pay()
    assert ran == []
    # Before the human decides: still pending, never denied.
    with pytest.raises(GuardianApprovalPending) as still:
        pending.value.resume()
    assert still.value.request_id == "req_ask" and ran == []
    done = still.value.resume()
    assert done.output == "paid" and done.request_id == "req_ask" and done.receipt["requestId"] == "req_ask"
    assert ran == [1]


def test_denied_claim_never_runs():
    client = FakeClient(HELD, claims=[RequestResult(ok=False, reason_code="NOT_AUTHORIZED")])
    ran = []
    pay = Guard(client, connection_id=CONNECTION)("pay")(lambda: ran.append(1))
    with pytest.raises(GuardianApprovalPending) as pending:
        pay()
    with pytest.raises(GuardianDenied):
        pending.value.resume()
    assert ran == []


def test_unreachable_guardian_fails_closed():
    client = FakeClient(RequestResult(ok=False, reason_code="SERVICE_UNAVAILABLE"))
    ran = []
    pay = Guard(client, connection_id=CONNECTION)("pay")(lambda: ran.append(1))
    with pytest.raises(GuardianDenied) as err:
        pay()
    assert err.value.reason_code == "SERVICE_UNAVAILABLE" and ran == []


def test_refused_redemption_after_local_effect_is_an_incident():
    client = FakeClient(ALLOW, execute_ok=False)
    pay = Guard(client, connection_id=CONNECTION)("pay")(lambda: "done")
    with pytest.raises(GuardianExecutionFailed) as err:
        pay()
    assert err.value.local_effect_ran is True


def test_remote_mode_never_runs_local_code():
    client = FakeClient(ALLOW)
    ran = []
    pay = Guard(client, connection_id=CONNECTION, mode="remote")("pay")(lambda: ran.append(1))
    result = pay()
    assert result["guardian"]["decision"] == "ALLOW" and ran == []
    assert "request:mcp.install" not in client.calls


def test_result_mode_hands_decisions_back_as_data():
    client = FakeClient(RequestResult(ok=True, request_id="r", decision="DENY", reason_code="NO"))
    pay = Guard(client, connection_id=CONNECTION, on_deny="result")("pay")(lambda: "never")
    assert pay()["guardian"]["decision"] == "DENY"


def test_held_registration_is_an_ask_and_resume_then_runs_the_call():
    client = FakeClient(
        ALLOW,
        install=RequestResult(ok=False, request_id="req_install", reason_code="APPROVAL_REQUIRED"),
        claims=[
            RequestResult(ok=False, request_id="req_install", reason_code="APPROVAL_PENDING"),
            RequestResult(ok=True, request_id="req_install", decision="ALLOW", capability_token="capi"),
        ],
    )
    ran = []
    pay = Guard(client, connection_id=CONNECTION, install_record_transport=True)("pay")(lambda: ran.append(1) or "paid")
    with pytest.raises(GuardianApprovalPending) as pending:
        pay()
    assert pending.value.request_id == "req_install"
    with pytest.raises(GuardianApprovalPending) as still:
        pending.value.resume()
    assert ran == []
    assert still.value.resume().output == "paid"
    assert ran == [1]


def test_sync_guard_rejects_async_functions():
    guard = Guard(FakeClient(ALLOW), connection_id=CONNECTION)

    async def pay():
        return 1

    with pytest.raises(TypeError):
        guard("pay")(pay)


async def test_async_guard_allow_ask_deny():
    client = FakeClient(ALLOW)
    guard = Guard(AsyncFake(client), connection_id=CONNECTION)
    ran = []

    @guard("pay")
    async def pay(amount_cents: int):
        ran.append(amount_cents)
        return "paid"

    assert await pay(5) == "paid" and ran == [5]

    client.invoke = HELD
    client.claims = [RequestResult(ok=True, request_id="req_ask", decision="ALLOW", capability_token="cap")]
    with pytest.raises(GuardianApprovalPending) as pending:
        await pay(7)
    assert ran == [5]
    done = await pending.value.resume()
    assert done.output == "paid" and ran == [5, 7]

    client.invoke = RequestResult(ok=True, request_id="req_d", decision="DENY", reason_code="POLICY_DENY")
    with pytest.raises(GuardianDenied):
        await pay(9)
    assert ran == [5, 7]


async def test_async_guard_accepts_sync_functions():
    guard = Guard(AsyncFake(FakeClient(ALLOW)), connection_id=CONNECTION)
    pay = guard("pay")(lambda: "ok")
    assert await pay() == "ok"


def test_wo050_denied_registration_explains_how_to_register_and_nothing_runs():
    client = FakeClient(ALLOW, install=RequestResult(ok=False, reason_code="INVALID_REQUEST"))
    ran = []
    pay = Guard(client, connection_id=CONNECTION, install_record_transport=True)("pay_invoice")(
        lambda: ran.append(1)
    )
    with pytest.raises(GuardianDenied) as err:
        pay()
    # INVALID_REQUEST is how hosted Guardian answers for a tool already
    # registered: the entry may be an HTTP tool, so nothing runs.
    assert err.value.reason_code == "RECORD_TRANSPORT_UNVERIFIED"
    assert "record-only" in err.value.hint
    assert "install_record_transport=False" in str(err.value)
    assert ran == []
    assert client.calls == ["request:mcp.install"]


def test_wo050_invalid_request_and_plan_limit_hints():
    client = FakeClient(RequestResult(ok=False, reason_code="INVALID_REQUEST"))
    with pytest.raises(GuardianDenied) as err:
        Guard(client, connection_id=CONNECTION)("pay_invoice")(lambda: None)()
    assert "Agents" in err.value.hint
    client = FakeClient(RequestResult(ok=False, reason_code="PLAN_LIMIT_EXCEEDED"))
    result = Guard(client, connection_id=CONNECTION, on_deny="result")("pay")(lambda: None)()
    assert result["guardian"]["reason_code"] == "PLAN_LIMIT_EXCEEDED"
    assert "plan" in result["guardian"]["message"]


def test_wo050_policy_deny_has_no_hint():
    client = FakeClient(RequestResult(ok=True, request_id="r", decision="DENY", reason_code="POLICY_DENY"))
    with pytest.raises(GuardianDenied) as err:
        Guard(client, connection_id=CONNECTION)("x")(lambda: None)()
    assert err.value.hint is None


def test_on_ask_result_rerun_after_approval_claims_the_held_request():
    # Before the fix, calling the tool again (as the ASK message says) proposed a
    # fresh request that needed a fresh approval, so the approved one never ran.
    approved = RequestResult(ok=True, request_id="req_ask", decision="ALLOW", capability_token="cap")
    client = FakeClient(HELD, claims=[RequestResult(ok=False, request_id="req_ask", reason_code="APPROVAL_PENDING"), approved])
    guard = Guard(client, connection_id=CONNECTION, on_ask="result")
    ran = []

    @guard("pay_invoice")
    def pay(invoice_id: str):
        ran.append(invoice_id)
        return "paid"

    first = pay("INV-1")
    assert first["guardian"]["decision"] == "ASK" and first["guardian"]["request_id"] == "req_ask"
    # Still pending: the same request, no second proposal.
    again = pay("INV-1")
    assert again["guardian"]["request_id"] == "req_ask"
    assert pay("INV-1") == "paid"
    assert ran == ["INV-1"]
    assert client.calls == ["request:tool.invoke", "claim:req_ask", "claim:req_ask", "execute:req_ask"]
    # Different arguments are a different proposal.
    client.invoke = ALLOW
    assert pay("INV-2") == "paid"
    assert client.calls[-2:] == ["request:tool.invoke", "execute:req_allow"]


def test_on_ask_result_rerun_after_denial_returns_deny_once():
    denied = RequestResult(ok=False, request_id="req_ask", reason_code="NOT_AUTHORIZED")
    client = FakeClient(HELD, claims=[denied])
    guard = Guard(client, connection_id=CONNECTION, on_ask="result", on_deny="result")

    @guard("pay_invoice")
    def pay(invoice_id: str):
        raise AssertionError("must not run")

    assert pay("INV-1")["guardian"]["decision"] == "ASK"
    out = pay("INV-1")
    assert out["guardian"]["decision"] == "DENY" and out["guardian"]["reason_code"] == "NOT_AUTHORIZED"


def test_on_ask_result_outage_while_claiming_keeps_the_request_held():
    approved = RequestResult(ok=True, request_id="req_ask", decision="ALLOW", capability_token="cap")
    down = RequestResult(ok=False, reason_code="SERVICE_UNAVAILABLE")
    client = FakeClient(HELD, claims=[down, approved])
    guard = Guard(client, connection_id=CONNECTION, on_ask="result", on_deny="result")
    ran = []

    @guard("pay_invoice")
    def pay(invoice_id: str):
        ran.append(invoice_id)
        return "paid"

    assert pay("INV-1")["guardian"]["decision"] == "ASK"
    assert pay("INV-1")["guardian"]["reason_code"] == "SERVICE_UNAVAILABLE"
    assert ran == []
    # The next try claims the same request instead of proposing a new one.
    assert pay("INV-1") == "paid"
    assert ran == ["INV-1"]
    assert client.calls.count("request:tool.invoke") == 1


def test_refusal_keeps_guardians_request_id():
    client = FakeClient(RequestResult(ok=False, request_id="req_denied", reason_code="NOT_AUTHORIZED"))
    with pytest.raises(GuardianDenied) as err:
        Guard(client, connection_id=CONNECTION)("pay_invoice")(lambda: None)()
    assert err.value.request_id == "req_denied"


@pytest.mark.parametrize("status", ["outcome-pending", "not-sent", "outcome-unconfirmed"])
def test_remote_mode_unverified_receipt_is_an_execution_failure_not_an_allow(status):
    client = FakeClient(ALLOW, receipt_status=status)
    receipts = []
    guard = Guard(client, connection_id=CONNECTION, mode="remote", on_receipt=lambda t, r, rc: receipts.append(r))
    with pytest.raises(GuardianExecutionFailed) as err:
        guard("pay")(lambda: None)()
    assert err.value.reason_code == "EXECUTION_" + status.upper().replace("-", "_")
    assert err.value.receipt["status"] == status
    assert receipts == []


def test_remote_mode_sent_verified_is_an_allow_with_its_receipt():
    client = FakeClient(ALLOW)
    receipts = []
    guard = Guard(client, connection_id=CONNECTION, mode="remote", on_receipt=lambda t, r, rc: receipts.append(r))
    out = guard("pay")(lambda: None)()
    assert out["guardian"]["decision"] == "ALLOW" and receipts == ["req_allow"]


def test_outage_while_claiming_a_held_registration_keeps_it_held():
    approved = RequestResult(ok=True, request_id="req_install", decision="ALLOW", capability_token="capi")
    down = RequestResult(ok=False, reason_code="SERVICE_UNAVAILABLE")
    client = FakeClient(
        ALLOW,
        install=RequestResult(ok=False, request_id="req_install", reason_code="APPROVAL_REQUIRED"),
        claims=[down, approved],
    )
    guard = Guard(client, connection_id=CONNECTION, install_record_transport=True, on_ask="result", on_deny="result")
    ran = []
    pay = guard("pay")(lambda: ran.append(1) or "paid")
    assert pay()["guardian"]["decision"] == "ASK"
    out = pay()["guardian"]
    assert out["reason_code"] == "SERVICE_UNAVAILABLE"
    assert "could not be reached" in out["message"] and "Do not retry" not in out["message"]
    assert ran == []
    # The next try claims the same registration; no second approval is needed.
    assert pay() == "paid"
    assert client.calls.count("request:mcp.install") == 1
    assert client.calls.count("claim:req_install") == 2


def test_outage_result_wording_says_try_again_not_denied():
    client = FakeClient(RequestResult(ok=False, reason_code="SERVICE_UNAVAILABLE"))
    out = Guard(client, connection_id=CONNECTION, on_deny="result")("pay")(lambda: None)()
    assert out["guardian"]["decision"] == "DENY"
    assert "Try again later" in out["guardian"]["message"]
    assert "Do not retry" not in out["guardian"]["message"]


@pytest.mark.parametrize("answer", ["TOOL_ALREADY_INSTALLED", "INVALID_REQUEST"])
def test_already_installed_is_refused_before_anything_runs(answer):
    # The existing entry could be an HTTP tool: running the function and then
    # redeeming would make Guardian perform the call too.
    client = FakeClient(ALLOW, install=RequestResult(ok=False, request_id="req_i", reason_code=answer))
    ran = []
    pay = Guard(client, connection_id=CONNECTION, install_record_transport=True)("send_note")(
        lambda: ran.append(1)
    )
    with pytest.raises(GuardianDenied) as err:
        pay()
    assert err.value.reason_code == "RECORD_TRANSPORT_UNVERIFIED"
    assert err.value.request_id == "req_i"
    assert answer in err.value.hint
    assert "install_record_transport=False" in err.value.hint
    assert ran == []
    # Not proposed, not redeemed: no effect at all. A retry asks again.
    assert client.calls == ["request:mcp.install"]
    with pytest.raises(GuardianDenied):
        pay()
    assert ran == []
    assert "request:tool.invoke" not in client.calls


class SharedGuardian(FakeClient):
    """One Guardian seen by several Guards (a restart, another worker)."""

    def __init__(self):
        super().__init__(ALLOW)
        self.entry = False

    def request(self, invocation):
        if invocation["action"] == "mcp.install":
            self.calls.append("request:mcp.install")
            if self.entry:
                return INSTALLED
            return RequestResult(ok=True, request_id="req_install", decision="ALLOW", capability_token="capi")
        return super().request(invocation)

    def execute(self, *, request_id, capability_token):
        if request_id == "req_install":
            self.entry = True
        return super().execute(request_id=request_id, capability_token=capability_token)


def test_a_new_guard_opted_in_is_refused_for_an_entry_an_earlier_guard_installed():
    client = SharedGuardian()
    ran = []

    def body():
        ran.append(1)
        return "sent"

    # Run 1: no entry yet, so this Guard registers it and remembers it.
    first = Guard(client, connection_id=CONNECTION, install_record_transport=True)("send_note")(body)
    assert first() == "sent"
    assert first() == "sent"
    assert client.calls.count("request:mcp.install") == 1
    assert ran == [1, 1]

    # Run 2, after a restart: the in-memory record is gone, so the SDK
    # cannot tell its own entry from an HTTP tool and refuses.
    client.calls.clear()
    second = Guard(client, connection_id=CONNECTION, install_record_transport=True, on_deny="result")(
        "send_note"
    )(body)
    out = second()["guardian"]
    assert out["decision"] == "DENY"
    assert out["reason_code"] == "RECORD_TRANSPORT_UNVERIFIED"
    assert "Automatic registration only works while no entry with that name exists" in out["message"]
    assert client.calls == ["request:mcp.install"]
    assert ran == [1, 1]

    # Run 3, with the default (the tool is registered as record-only): runs.
    client.calls.clear()
    third = Guard(client, connection_id=CONNECTION)("send_note")(body)
    assert third() == "sent"
    assert client.calls == ["request:tool.invoke", "execute:req_allow"]
    assert ran == [1, 1, 1]


# --- content pins (file_args) -------------------------------------------------

import asyncio  # noqa: E402
import os  # noqa: E402
import threading  # noqa: E402

from odingard_guardian import CONTENT_PIN_KEY, ContentPinError, PinnedFile  # noqa: E402

ASK_TOOL = RequestResult(ok=True, request_id="req_pin", decision="ASK")
ALLOW_PIN = RequestResult(ok=True, request_id="req_pin", decision="ALLOW", capability_token="cap")


@pytest.fixture
def attachment(tmp_path):
    path = tmp_path / "report.pdf"
    path.write_bytes(b"approved bytes")
    return str(path)


class RewritingClient(FakeClient):
    """Runs ``before_answer`` when Guardian answers (between proposal and run)."""

    def __init__(self, invoke, before_answer=None, **kwargs):
        super().__init__(invoke, **kwargs)
        self.before_answer = before_answer

    def request(self, invocation):
        result = super().request(invocation)
        if self.before_answer and invocation["action"] == "tool.invoke":
            self.before_answer()
        return result


def call_sync_or_async(is_async, fn, *args, **kwargs):
    result = fn(*args, **kwargs)
    if is_async:
        return asyncio.run(result) if asyncio.iscoroutine(result) else result
    return result


def make_guard(client, is_async, **kwargs):
    return Guard(AsyncFake(client) if is_async else client, connection_id=CONNECTION, **kwargs)


def rewrite(path, data=b"rewritten bytes"):
    def go():
        with open(path, "wb") as f:
            f.write(data)

    return go


@pytest.mark.parametrize("is_async", [False, True])
def test_pin_file_rewritten_between_allow_and_run_is_refused(attachment, is_async):
    client = RewritingClient(ALLOW_PIN, before_answer=rewrite(attachment))
    guard = make_guard(client, is_async)
    ran = []

    def body(to, attachment_path):
        ran.append(attachment_path)

    send = guard("send_report", file_args={"attachment_path": "recheck"})(
        _maybe_async(body, is_async)
    )
    with pytest.raises(GuardianExecutionFailed) as info:
        call_sync_or_async(is_async, send, "ops@example.test", attachment)
    assert info.value.reason_code == "CONTENT_CHANGED_SINCE_APPROVAL"
    assert info.value.local_effect_ran is False
    assert ran == []
    assert client.calls == ["request:tool.invoke"]  # never executed / redeemed
    pins = client.last_invocation["arguments"][CONTENT_PIN_KEY]
    assert pins == [
        {
            "arg": "attachment_path",
            "index": 0,
            "mode": "recheck",
            "name": "report.pdf",
            "size": 14,
            "sha256": pins[0]["sha256"],
        }
    ]


def _maybe_async(fn, is_async):
    if not is_async:
        return fn

    async def wrapper(*args, **kwargs):
        return fn(*args, **kwargs)

    wrapper.__signature__ = __import__("inspect").signature(fn)  # type: ignore[attr-defined]
    wrapper.__name__ = fn.__name__
    return wrapper


@pytest.mark.parametrize("is_async", [False, True])
def test_pin_resume_after_ask_rechecks(attachment, is_async):
    client = FakeClient(ASK_TOOL, claims=[ALLOW_PIN])
    guard = make_guard(client, is_async)
    ran = []
    send = guard("send_report", file_args={"attachment_path": "bytes"})(
        _maybe_async(lambda attachment_path: ran.append(attachment_path), is_async)
    )
    with pytest.raises(GuardianApprovalPending) as info:
        call_sync_or_async(is_async, send, attachment)
    pending = info.value
    assert CONTENT_PIN_KEY not in pending.arguments
    assert CONTENT_PIN_KEY in pending.proposed_args
    rewrite(attachment)()
    with pytest.raises(GuardianExecutionFailed) as failed:
        call_sync_or_async(is_async, pending.resume)
    assert failed.value.reason_code == "CONTENT_CHANGED_SINCE_APPROVAL"
    assert ran == []
    assert "execute:req_pin" not in client.calls


@pytest.mark.parametrize("is_async", [False, True])
def test_pin_held_recall_with_on_ask_result(attachment, is_async):
    client = FakeClient(ASK_TOOL, claims=[ALLOW_PIN])
    guard = make_guard(client, is_async, on_ask="result")
    ran = []
    send = guard("send_report", file_args={"attachment_path": "recheck"})(
        _maybe_async(lambda attachment_path: ran.append(1), is_async)
    )
    first = call_sync_or_async(is_async, send, attachment)
    assert first["guardian"]["decision"] == "ASK"
    # Unchanged file: the same pinned arguments claim the held request, and the
    # re-check passes.
    call_sync_or_async(is_async, send, attachment)
    assert client.calls[-2:] == ["claim:req_pin", "execute:req_pin"]
    assert ran == [1]


@pytest.mark.parametrize("is_async", [False, True])
def test_pin_held_recall_after_change_is_a_new_request(attachment, is_async):
    client = FakeClient(ASK_TOOL)
    guard = make_guard(client, is_async, on_ask="result")
    send = guard("send_report", file_args={"attachment_path": "recheck"})(
        _maybe_async(lambda attachment_path: None, is_async)
    )
    call_sync_or_async(is_async, send, attachment)
    rewrite(attachment)()
    call_sync_or_async(is_async, send, attachment)
    # A changed file gives a new key: proposed again, never a claim of the old one.
    assert client.calls == ["request:tool.invoke", "request:tool.invoke"]


@pytest.mark.parametrize("is_async", [False, True])
def test_pin_bytes_mode_hands_the_verified_bytes(attachment, is_async):
    client = FakeClient(ALLOW_PIN)
    guard = make_guard(client, is_async)
    seen = {}

    def body(to, attachment_path):
        seen["file"] = attachment_path
        seen["locals"] = dict(locals())
        rewrite(attachment, b"changed after the re-check")()
        return "sent"

    send = guard("send_report", file_args={"attachment_path": "bytes"})(_maybe_async(body, is_async))
    assert call_sync_or_async(is_async, send, "ops@example.test", attachment) == "sent"
    file = seen["file"]
    assert isinstance(file, PinnedFile)
    assert file.data == b"approved bytes"
    assert attachment not in str(file)
    assert "approved bytes" not in repr(file)
    assert CONTENT_PIN_KEY not in seen["locals"]


@pytest.mark.parametrize("is_async", [False, True])
def test_pin_copy_mode_private_copy_is_deleted_also_on_raise(attachment, is_async):
    for raises in (False, True):
        client = FakeClient(ALLOW_PIN)
        guard = make_guard(client, is_async)
        seen = {}

        def body(attachment_path):
            seen["path"] = attachment_path
            st = os.stat(attachment_path)
            seen["mode"] = st.st_mode & 0o777
            seen["dir_mode"] = os.stat(os.path.dirname(attachment_path)).st_mode & 0o777
            with open(attachment_path, "rb") as f:
                seen["data"] = f.read()
            if raises:
                raise RuntimeError("tool failed")
            return "ok"

        send = guard("send_report", file_args={"attachment_path": "copy"})(_maybe_async(body, is_async))
        if raises:
            with pytest.raises(RuntimeError):
                call_sync_or_async(is_async, send, attachment)
        else:
            call_sync_or_async(is_async, send, attachment)
        assert seen["path"] != attachment
        assert seen["mode"] == 0o600 and seen["dir_mode"] == 0o700
        assert seen["data"] == b"approved bytes"
        assert not os.path.exists(seen["path"])


@pytest.mark.parametrize("is_async", [False, True])
def test_pin_refusals_before_proposal_send_nothing(tmp_path, attachment, is_async):
    fifo = str(tmp_path / "fifo")
    os.mkfifo(fifo)
    cases = [
        ("relative.pdf", "CONTENT_PIN_INVALID_ARGUMENT"),
        ("~/x.pdf", "CONTENT_PIN_INVALID_ARGUMENT"),
        ("", "CONTENT_PIN_INVALID_ARGUMENT"),
        (str(tmp_path / "missing"), "CONTENT_PIN_UNREADABLE"),
        (str(tmp_path), "CONTENT_PIN_NOT_REGULAR_FILE"),
        (fifo, "CONTENT_PIN_NOT_REGULAR_FILE"),
        ("/dev/zero", "CONTENT_PIN_NOT_REGULAR_FILE"),
        (attachment, "CONTENT_PIN_TOO_LARGE"),
    ]
    for path, code in cases:
        client = FakeClient(ALLOW_PIN)
        # install_record_transport: even the record-transport request is not sent.
        guard = make_guard(client, is_async, install_record_transport=True, max_pin_bytes=4)
        send = guard("send_report", file_args={"attachment_path": "bytes"})(
            _maybe_async(lambda attachment_path: None, is_async)
        )
        with pytest.raises(GuardianDenied) as info:
            call_sync_or_async(is_async, send, path)
        assert info.value.reason_code == code, path
        assert client.calls == [], path


@pytest.mark.parametrize("is_async", [False, True])
def test_pin_refusal_as_a_result_with_on_deny_result(is_async):
    client = FakeClient(ALLOW_PIN)
    guard = make_guard(client, is_async, on_deny="result")
    send = guard("send_report", file_args={"attachment_path": "bytes"})(
        _maybe_async(lambda attachment_path: None, is_async)
    )
    out = call_sync_or_async(is_async, send, "relative.pdf")
    assert out["guardian"]["reason_code"] == "CONTENT_PIN_INVALID_ARGUMENT"
    assert "did not run" in out["guardian"]["message"]
    assert client.calls == []


@pytest.mark.parametrize("is_async", [False, True])
def test_reserved_key_is_refused_with_and_without_file_args(attachment, is_async):
    for file_args in (None, {"attachment_path": "recheck"}):
        client = FakeClient(ALLOW_PIN)
        guard = make_guard(client, is_async)
        with pytest.raises(GuardianDenied) as info:
            call_sync_or_async(
                is_async,
                guard.run,
                "send_report",
                {"attachment_path": attachment, CONTENT_PIN_KEY: [{"arg": "attachment_path"}]},
                lambda: None,
                file_args=file_args,
            )
        assert info.value.reason_code == "CONTENT_PIN_KEY_RESERVED"
        assert client.calls == []


def test_guard_run_supports_recheck_only(attachment):
    client = FakeClient(ALLOW_PIN)
    guard = Guard(client, connection_id=CONNECTION)
    for mode in ("bytes", "copy"):
        with pytest.raises(ContentPinError, match="decorator"):
            guard.run("send_report", {"p": attachment}, lambda: None, file_args={"p": mode})
    assert client.calls == []
    ran = []
    guard.run("send_report", {"p": attachment}, lambda: ran.append(1), file_args={"p": "recheck"})
    assert ran == [1]
    assert CONTENT_PIN_KEY in client.last_invocation["arguments"]


def test_file_args_in_remote_mode_is_a_decoration_time_error():
    guard = Guard(FakeClient(ALLOW_PIN), connection_id=CONNECTION, mode="remote")
    with pytest.raises(ContentPinError) as info:
        guard("send_report", file_args={"attachment_path": "bytes"})(lambda attachment_path: None)
    assert info.value.reason_code == "CONTENT_PIN_REMOTE_MODE"
    per_tool = Guard(FakeClient(ALLOW_PIN), connection_id=CONNECTION, modes={"send_report": "remote"})
    with pytest.raises(ContentPinError):
        per_tool.run("send_report", {"p": "/x"}, lambda: None, file_args={"p": "recheck"})


def test_file_args_must_name_a_named_parameter():
    guard = Guard(FakeClient(ALLOW_PIN), connection_id=CONNECTION)

    def tool(to, *paths, **extra):
        return None

    for key in ("paths", "extra", "attachment_path", "a.b"):
        with pytest.raises(ContentPinError):
            guard("send_report", file_args={key: "bytes"})(tool)


def test_decorator_rebind_positional_keyword_and_keyword_only(tmp_path):
    files = {}
    for name in ("a", "b", "c"):
        p = tmp_path / f"{name}.txt"
        p.write_bytes(name.encode())
        files[name] = str(p)
    client = FakeClient(ALLOW_PIN)
    guard = Guard(client, connection_id=CONNECTION)
    seen = {}

    @guard("combine", file_args={"first": "bytes", "second": "copy", "third": "bytes"})
    def combine(first, /, second, *, third, label="x"):
        with open(second, "rb") as f:
            seen["second"] = f.read()
        seen["first"] = first.data
        seen["third"] = third.data
        seen["label"] = label
        return "ok"

    assert combine(files["a"], files["b"], third=files["c"], label="L") == "ok"
    assert seen == {"first": b"a", "second": b"b", "third": b"c", "label": "L"}
    assert [p["arg"] for p in client.last_invocation["arguments"][CONTENT_PIN_KEY]] == [
        "first",
        "second",
        "third",
    ]


def test_a_list_of_paths_is_pinned_in_order(tmp_path):
    paths = []
    for i in range(3):
        p = tmp_path / f"{i}.txt"
        p.write_bytes(str(i).encode())
        paths.append(str(p))
    client = FakeClient(ALLOW_PIN)
    guard = Guard(client, connection_id=CONNECTION)
    seen = []

    @guard("bundle", file_args={"parts": "bytes"})
    def bundle(parts):
        seen.extend(part.data for part in parts)

    bundle(paths)
    assert seen == [b"0", b"1", b"2"]
    assert [p["index"] for p in client.last_invocation["arguments"][CONTENT_PIN_KEY]] == [0, 1, 2]


def test_a_mutable_argument_changed_while_waiting_does_not_reach_the_body(attachment):
    client = FakeClient(ASK_TOOL, claims=[ALLOW_PIN])
    guard = Guard(client, connection_id=CONNECTION)
    seen = []

    @guard("send_report", file_args={"attachment_path": "recheck"})
    def send(attachment_path, recipients):
        seen.append(list(recipients))

    recipients = ["ops@example.test"]
    with pytest.raises(GuardianApprovalPending) as info:
        send(attachment, recipients)
    recipients.append("attacker@example.test")  # changed while the approval waits
    info.value.resume()
    assert seen == [["ops@example.test"]]


@pytest.mark.parametrize("is_async", [False, True])
@pytest.mark.parametrize("field", ["arguments", "proposed_arguments"])
def test_mutating_the_pending_arguments_does_not_reach_the_body(attachment, field, is_async):
    client = FakeClient(ASK_TOOL, claims=[ALLOW_PIN])
    guard = make_guard(client, is_async)
    seen = []

    send = guard("send_report", file_args={"attachment_path": "recheck"})(
        _maybe_async(lambda attachment_path, recipients: seen.append(list(recipients)), is_async)
    )
    with pytest.raises(GuardianApprovalPending) as info:
        call_sync_or_async(is_async, send, attachment, ["ops@example.test"])
    # Code holding the pending object changes the exposed record while it waits.
    getattr(info.value, field)["recipients"].append("attacker@example.test")
    call_sync_or_async(is_async, info.value.resume)
    assert seen == [["ops@example.test"]]
    # What Guardian was asked to approve is what the body received.
    assert client.last_invocation["arguments"]["recipients"] == ["ops@example.test"]


@pytest.mark.parametrize("is_async", [False, True])
def test_pins_edited_on_the_pending_object_do_not_change_the_recheck(attachment, is_async):
    import hashlib

    client = FakeClient(ASK_TOOL, claims=[ALLOW_PIN])
    guard = make_guard(client, is_async)
    ran = []
    with pytest.raises(GuardianApprovalPending) as info:
        call_sync_or_async(
            is_async,
            guard.run,
            "send_report",
            {"attachment_path": attachment},
            lambda: ran.append(1),
            file_args={"attachment_path": "recheck"},
        )
    rewritten = b"other contents"
    rewrite(attachment, rewritten)()
    # Code holding the pending object rewrites the pin to match the new file.
    pin = info.value.proposed_arguments[CONTENT_PIN_KEY][0]
    pin["size"] = len(rewritten)
    pin["sha256"] = "sha256:" + hashlib.sha256(rewritten).hexdigest()
    with pytest.raises(GuardianExecutionFailed) as failed:
        call_sync_or_async(is_async, info.value.resume)
    assert failed.value.reason_code == "CONTENT_CHANGED_SINCE_APPROVAL"
    assert ran == []


@pytest.mark.parametrize("is_async", [False, True])
def test_a_path_edited_on_the_pending_object_does_not_change_the_recheck(attachment, tmp_path, is_async):
    client = FakeClient(ASK_TOOL, claims=[ALLOW_PIN])
    guard = make_guard(client, is_async)
    ran = []
    send = guard("send_report", file_args={"attachment_path": "recheck"})(
        _maybe_async(lambda attachment_path: ran.append(attachment_path), is_async)
    )
    with pytest.raises(GuardianApprovalPending) as info:
        call_sync_or_async(is_async, send, attachment)
    decoy = tmp_path / "decoy.pdf"
    decoy.write_bytes(b"approved bytes")  # the approved bytes, at another path
    rewrite(attachment)()
    info.value.proposed_arguments["attachment_path"] = str(decoy)
    with pytest.raises(GuardianExecutionFailed) as failed:
        call_sync_or_async(is_async, info.value.resume)
    assert failed.value.reason_code == "CONTENT_CHANGED_SINCE_APPROVAL"
    assert ran == []


@pytest.mark.parametrize("is_async", [False, True])
def test_a_declared_file_argument_set_to_none_is_refused_before_proposal(is_async):
    client = FakeClient(ALLOW_PIN)
    guard = make_guard(client, is_async)
    ran = []
    with pytest.raises(GuardianDenied) as info:
        call_sync_or_async(
            is_async,
            guard.run,
            "send_report",
            {"attachment_path": None},
            lambda: ran.append(1),
            file_args={"attachment_path": "recheck"},
        )
    assert info.value.reason_code == "CONTENT_PIN_INVALID_ARGUMENT"
    assert client.calls == [] and ran == []

    send = guard("send_report", file_args={"attachment_path": "recheck"})(
        _maybe_async(lambda to, attachment_path=None: ran.append(attachment_path), is_async)
    )
    with pytest.raises(GuardianDenied) as info:
        call_sync_or_async(is_async, send, "ops@example.test", None)
    assert info.value.reason_code == "CONTENT_PIN_INVALID_ARGUMENT"
    assert client.calls == [] and ran == []


@pytest.mark.parametrize("is_async", [False, True])
def test_a_declared_parameter_left_at_its_default_is_absent(is_async):
    client = FakeClient(ALLOW_PIN)
    guard = make_guard(client, is_async)
    ran = []
    send = guard("send_report", file_args={"attachment_path": "recheck"})(
        _maybe_async(lambda to, attachment_path=None: ran.append((to, attachment_path)), is_async)
    )
    call_sync_or_async(is_async, send, "ops@example.test")
    assert ran == [("ops@example.test", None)]
    proposed = client.last_invocation["arguments"]
    assert proposed == {"to": "ops@example.test"}  # not pinned, not proposed


@pytest.mark.parametrize("is_async", [False, True])
def test_a_declared_parameter_with_a_path_default_is_pinned(attachment, is_async):
    # Only a None default means "no file"; a path default is opened by the
    # function, so it is pinned like a passed value.
    client = FakeClient(ALLOW_PIN)
    guard = make_guard(client, is_async)
    ran = []
    send = guard("send_report", file_args={"attachment_path": "recheck"})(
        _maybe_async(lambda to, attachment_path=attachment: ran.append(attachment_path), is_async)
    )
    call_sync_or_async(is_async, send, "ops@example.test")
    assert ran == [attachment]
    proposed = client.last_invocation["arguments"]
    assert proposed["attachment_path"] == attachment
    assert [p["arg"] for p in proposed[CONTENT_PIN_KEY]] == ["attachment_path"]


@pytest.mark.parametrize("is_async", [False, True])
def test_pins_edited_on_a_decorated_tools_pending_object_do_not_change_the_recheck(attachment, is_async):
    import hashlib

    client = FakeClient(ASK_TOOL, claims=[ALLOW_PIN])
    guard = make_guard(client, is_async)
    ran = []
    send = guard("send_report", file_args={"attachment_path": "recheck"})(
        _maybe_async(lambda attachment_path: ran.append(attachment_path), is_async)
    )
    with pytest.raises(GuardianApprovalPending) as info:
        call_sync_or_async(is_async, send, attachment)
    rewritten = b"other contents"
    rewrite(attachment, rewritten)()
    pin = info.value.proposed_arguments[CONTENT_PIN_KEY][0]
    pin["size"] = len(rewritten)
    pin["sha256"] = "sha256:" + hashlib.sha256(rewritten).hexdigest()
    with pytest.raises(GuardianExecutionFailed) as failed:
        call_sync_or_async(is_async, info.value.resume)
    assert failed.value.reason_code == "CONTENT_CHANGED_SINCE_APPROVAL"
    assert ran == []


def test_an_argument_deepcopy_cannot_copy_is_refused_only_for_file_args_tools(attachment):
    lock = threading.Lock()  # copy.deepcopy cannot copy a lock
    client = FakeClient(ALLOW_PIN)
    guard = Guard(client, connection_id=CONNECTION)

    @guard("send_report", file_args={"attachment_path": "recheck"})
    def pinned(attachment_path, handle):
        return "ran"

    with pytest.raises(GuardianDenied) as info:
        pinned(attachment, lock)
    assert info.value.reason_code == "CONTENT_PIN_INVALID_ARGUMENT"
    assert client.calls == []

    @guard("send_plain")
    def plain(attachment_path, handle):
        return "ran"

    # Without file_args nothing is deep-copied: same behaviour as before
    # (the lock does not canonicalize, which the request path handles as today).
    try:
        plain(attachment, lock)
    except Exception as err:  # noqa: BLE001
        assert not isinstance(err, ContentPinError)


def test_a_tool_without_file_args_proposes_unchanged_arguments(attachment):
    client = FakeClient(ALLOW_PIN)
    guard = Guard(client, connection_id=CONNECTION)

    @guard("send_report")
    def send(to, attachment_path, meta=None):
        return "ok"

    send("ops@example.test", attachment, meta={"b": [1, 2], "a": "é"})
    assert client.last_invocation["arguments"] == {
        "to": "ops@example.test",
        "attachment_path": attachment,
        "meta": {"b": [1, 2], "a": "é"},
    }


# --- "bytes" is the default when no mode is named ----------------------

from odingard_guardian import DEFAULT_FILE_ARG_MODE  # noqa: E402
from odingard_guardian.content_pins import normalize_file_args_spec  # noqa: E402

SHORT_FORMS = (["attachment_path"], ("attachment_path",), {"attachment_path": True})


def test_default_file_arg_mode_is_bytes():
    assert DEFAULT_FILE_ARG_MODE == "bytes"


@pytest.mark.parametrize("is_async", [False, True])
@pytest.mark.parametrize("file_args", SHORT_FORMS)
def test_short_form_pins_in_bytes_mode(attachment, is_async, file_args):
    client = FakeClient(ALLOW_PIN)
    guard = make_guard(client, is_async)
    seen = []
    send = guard("send_report", file_args=file_args)(
        _maybe_async(lambda to, attachment_path: seen.append(attachment_path), is_async)
    )
    call_sync_or_async(is_async, send, "ops@example.test", attachment)
    pins = client.last_invocation["arguments"][CONTENT_PIN_KEY]
    assert [(p["arg"], p["mode"]) for p in pins] == [("attachment_path", "bytes")]
    assert len(seen) == 1
    assert isinstance(seen[0], PinnedFile)
    assert seen[0].data == b"approved bytes"
    assert "execute:req_pin" in client.calls


@pytest.mark.parametrize("is_async", [False, True])
@pytest.mark.parametrize("file_args", SHORT_FORMS)
def test_short_form_refuses_a_changed_file(attachment, is_async, file_args):
    client = RewritingClient(ALLOW_PIN, before_answer=rewrite(attachment))
    guard = make_guard(client, is_async)
    ran = []
    send = guard("send_report", file_args=file_args)(
        _maybe_async(lambda attachment_path: ran.append(1), is_async)
    )
    with pytest.raises(GuardianExecutionFailed) as info:
        call_sync_or_async(is_async, send, attachment)
    assert info.value.reason_code == "CONTENT_CHANGED_SINCE_APPROVAL"
    assert info.value.local_effect_ran is False
    assert ran == []
    assert client.calls == ["request:tool.invoke"]


def test_short_form_and_explicit_bytes_propose_identical_arguments(attachment):
    proposals = []
    for file_args in (*SHORT_FORMS, {"attachment_path": "bytes"}):
        client = FakeClient(ALLOW_PIN)
        guard = Guard(client, connection_id=CONNECTION)
        guard("send_report", file_args=file_args)(lambda attachment_path: None)(attachment)
        proposals.append(client.last_invocation["arguments"])
    assert all(p == proposals[0] for p in proposals)


def test_explicit_modes_unchanged_and_mixed_with_short_form(tmp_path):
    paths = {}
    for name in ("first", "second", "third"):
        p = tmp_path / f"{name}.txt"
        p.write_bytes(name.encode())
        paths[name] = str(p)
    client = FakeClient(ALLOW_PIN)
    guard = Guard(client, connection_id=CONNECTION)
    seen = {}

    @guard("combine", file_args={"first": True, "second": "recheck", "third": "copy"})
    def combine(first, second, third):
        seen.update(first=first, second=second, third=third)

    combine(paths["first"], paths["second"], paths["third"])
    pins = client.last_invocation["arguments"][CONTENT_PIN_KEY]
    assert [(p["arg"], p["mode"]) for p in pins] == [("first", "bytes"), ("second", "recheck"), ("third", "copy")]
    assert isinstance(seen["first"], PinnedFile)
    assert seen["second"] == paths["second"]
    assert isinstance(seen["third"], str) and seen["third"] != paths["third"]
    for mode in ("bytes", "copy", "recheck"):
        assert normalize_file_args_spec("t", {"p": mode}) == {"p": mode}


@pytest.mark.parametrize(
    "file_args, message",
    [
        (["attachment_path", "attachment_path"], "twice"),
        ([""], "top-level"),
        (["report.path"], "top-level"),
        ([CONTENT_PIN_KEY], "top-level"),
        ([1], "not a string"),
        ([None], "not a string"),
        ({"attachment_path": False}, 'or True, which means "bytes"'),
        ({"attachment_path": 1}, 'or True, which means "bytes"'),
        ({"attachment_path": "stream"}, 'or True, which means "bytes"'),
        ({"attachment_path": None}, 'or True, which means "bytes"'),
        ("attachment_path", "list of argument names"),
        (True, "list of argument names"),
        ({"attachment_path"}, "list of argument names"),
    ],
)
def test_invalid_short_forms_are_refused_at_decoration_time(file_args, message):
    client = FakeClient(ALLOW_PIN)
    guard = Guard(client, connection_id=CONNECTION)
    with pytest.raises(ContentPinError, match=message) as info:
        guard("send_report", file_args=file_args)(lambda attachment_path: None)
    assert info.value.reason_code == "CONTENT_PIN_INVALID_ARGUMENT"
    assert client.calls == []


@pytest.mark.parametrize("file_args", SHORT_FORMS)
def test_guard_run_refuses_the_short_form_instead_of_downgrading(attachment, file_args):
    client = FakeClient(ALLOW_PIN)
    guard = Guard(client, connection_id=CONNECTION)
    run_args = {"attachment_path": attachment}
    with pytest.raises(ContentPinError, match='without a mode, which means "bytes".*recheck') as info:
        guard.run("send_report", run_args, lambda: None, file_args=file_args)
    assert info.value.reason_code == "CONTENT_PIN_INVALID_ARGUMENT"
    assert client.calls == []


@pytest.mark.parametrize("file_args", SHORT_FORMS)
def test_short_form_in_remote_mode_is_refused(file_args):
    guard = Guard(FakeClient(ALLOW_PIN), connection_id=CONNECTION, mode="remote")
    with pytest.raises(ContentPinError) as info:
        guard("send_report", file_args=file_args)(lambda attachment_path: None)
    assert info.value.reason_code == "CONTENT_PIN_REMOTE_MODE"
