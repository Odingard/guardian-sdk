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
