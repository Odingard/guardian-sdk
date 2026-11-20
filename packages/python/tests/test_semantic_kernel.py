"""Semantic Kernel: Guardian's function invocation filter on a real kernel.

The calls go through the kernel's own automatic function-calling path
(``Kernel.invoke_function_call``, what a chat completion service uses for
the calls the model asks for) and its filter pipeline; a fake client stands
in for Guardian.
"""

import json

import pytest

pytest.importorskip("semantic_kernel")

from semantic_kernel import Kernel  # noqa: E402
from semantic_kernel.contents import ChatHistory, FunctionCallContent  # noqa: E402
from semantic_kernel.filters import FilterTypes  # noqa: E402
from semantic_kernel.functions import KernelArguments, kernel_function  # noqa: E402

from odingard_guardian import GuardianDenied, RequestResult  # noqa: E402
from odingard_guardian.semantic_kernel import GuardianFunctionInvocationFilter  # noqa: E402

from test_guard import ALLOW, CONNECTION, HELD, AsyncFake, FakeClient  # noqa: E402

DENIED = RequestResult(ok=True, request_id="req_d", decision="DENY", reason_code="POLICY_DENY")
UNREACHABLE = RequestResult(ok=False, reason_code="SERVICE_UNAVAILABLE")
APPROVED = RequestResult(ok=True, request_id="req_ask", decision="ALLOW", capability_token="cap")
DECLINED = RequestResult(ok=False, request_id="req_ask", reason_code="APPROVAL_DENIED")


class Billing:
    def __init__(self):
        self.ran = []

    @kernel_function(name="refund_order", description="Refund an order")
    def refund_order(self, order_id: str, amount_cents: int) -> str:
        self.ran.append((order_id, amount_cents))
        return f"refunded {order_id}"


def kernel_with(guardian, *before, **options):
    kernel = Kernel()
    billing = Billing()
    kernel.add_plugin(billing, plugin_name="billing")
    for extra in before:
        kernel.add_filter(FilterTypes.FUNCTION_INVOCATION, extra)
    kernel.add_filter(
        FilterTypes.FUNCTION_INVOCATION,
        GuardianFunctionInvocationFilter(AsyncFake(guardian), connection_id=CONNECTION, **options),
    )
    return kernel, billing


async def model_calls(kernel, arguments='{"order_id": "o42", "amount_cents": 500}'):
    """One tool call the model asked for, through the kernel's auto function calling."""
    history = ChatHistory()
    call = FunctionCallContent(id="call_1", function_name="refund_order", plugin_name="billing", arguments=arguments)
    await kernel.invoke_function_call(call, history)
    return str(history.messages[-1].items[0].result)


async def test_allow_runs_the_function_once_then_records_it():
    guardian = FakeClient(ALLOW)
    kernel, billing = kernel_with(guardian)
    assert await model_calls(kernel) == "refunded o42"
    assert billing.ran == [("o42", 500)]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    assert guardian.last_invocation["tool_name"] == "billing-refund_order"
    assert guardian.last_invocation["arguments"] == {"order_id": "o42", "amount_cents": 500}


async def test_held_then_approved_runs_on_the_same_call():
    guardian = FakeClient(HELD, claims=[APPROVED])
    kernel, billing = kernel_with(guardian)
    assert "held for human approval (request_id req_ask)" in await model_calls(kernel)
    assert billing.ran == []
    assert await model_calls(kernel) == "refunded o42"
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask", "execute:req_ask"]
    assert billing.ran == [("o42", 500)]


async def test_held_then_declined_never_runs():
    guardian = FakeClient(HELD, claims=[DECLINED])
    kernel, billing = kernel_with(guardian)
    await model_calls(kernel)
    assert "Guardian denied billing-refund_order (APPROVAL_DENIED)" in await model_calls(kernel)
    assert billing.ran == []


async def test_denied_never_runs():
    guardian = FakeClient(DENIED)
    kernel, billing = kernel_with(guardian)
    assert await model_calls(kernel) == "Guardian denied billing-refund_order (POLICY_DENY). Do not retry the same call."
    assert billing.ran == []


async def test_guardian_unreachable_fails_closed():
    guardian = FakeClient(UNREACHABLE)
    kernel, billing = kernel_with(guardian)
    assert "could not be reached to check billing-refund_order" in await model_calls(kernel)
    assert billing.ran == []


async def test_direct_invoke_is_governed_too():
    guardian = FakeClient(DENIED)
    kernel, billing = kernel_with(guardian)
    result = await kernel.invoke(plugin_name="billing", function_name="refund_order", order_id="o1", amount_cents=1)
    assert "Guardian denied" in str(result.value)
    assert billing.ran == []


async def test_only_the_function_parameters_are_proposed():
    guardian = FakeClient(ALLOW)
    kernel, _ = kernel_with(guardian)
    arguments = KernelArguments(order_id="o1", amount_cents=1, session_note="not a parameter")
    await kernel.invoke(plugin_name="billing", function_name="refund_order", arguments=arguments)
    assert guardian.last_invocation["arguments"] == {"order_id": "o1", "amount_cents": 1}


async def test_amount_args_and_tool_names():
    guardian = FakeClient(ALLOW)
    declaration = {"argument": "amount_cents", "unit": "minor", "currency": "usd"}
    kernel, _ = kernel_with(
        guardian,
        tool_names={"billing-refund_order": "billing.refund"},
        amount_args={"billing.refund": declaration},
    )
    await model_calls(kernel)
    assert guardian.last_invocation["tool_name"] == "billing.refund"
    assert guardian.last_invocation["amount_argument"] == declaration
    assert guardian.last_invocation["value_cents"] == 500


async def test_a_filter_added_after_guardian_blocks_every_call():
    guardian = FakeClient(ALLOW)
    kernel, billing = kernel_with(guardian)
    seen = []

    async def tamper(context, next):
        seen.append("tamper")
        context.arguments["amount_cents"] = 99_999
        await next(context)

    kernel.add_filter(FilterTypes.FUNCTION_INVOCATION, tamper)  # added last: would run inside Guardian's
    text = await model_calls(kernel)
    assert "another function invocation filter was added after Guardian's" in text
    assert billing.ran == [] and guardian.calls == [] and seen == []


async def test_a_filter_added_before_guardian_is_decided_on():
    async def repair(context, next):
        context.arguments["order_id"] = "o43"
        await next(context)

    guardian = FakeClient(ALLOW)
    kernel, billing = kernel_with(guardian, repair)
    assert await model_calls(kernel) == "refunded o43"
    assert guardian.last_invocation["arguments"]["order_id"] == "o43"
    assert billing.ran == [("o43", 500)]


async def test_a_function_that_reads_all_kernel_arguments_has_them_all_proposed():
    class Mailer:
        def __init__(self):
            self.sent = []

        @kernel_function(name="send")
        def send(self, arguments: KernelArguments) -> str:
            self.sent.append(arguments["recipient"])
            return "sent"

    guardian = FakeClient(ALLOW)
    kernel = Kernel()
    mailer = Mailer()
    kernel.add_plugin(mailer, plugin_name="mail")
    kernel.add_filter(
        FilterTypes.FUNCTION_INVOCATION,
        GuardianFunctionInvocationFilter(AsyncFake(guardian), connection_id=CONNECTION),
    )
    await kernel.invoke(plugin_name="mail", function_name="send", recipient="ops@example.com")
    assert guardian.last_invocation["arguments"] == {"recipient": "ops@example.com"}
    assert mailer.sent == ["ops@example.com"]


async def test_a_function_that_changes_its_own_inputs_is_still_recorded():
    class Orders:
        @kernel_function(name="submit")
        def submit(self, payload: dict) -> str:
            payload.pop("invoice")
            return "submitted"

    guardian = FakeClient(ALLOW)
    receipts = []
    kernel = Kernel()
    kernel.add_plugin(Orders(), plugin_name="orders")
    kernel.add_filter(
        FilterTypes.FUNCTION_INVOCATION,
        GuardianFunctionInvocationFilter(
            AsyncFake(guardian), connection_id=CONNECTION, on_receipt=lambda t, r, rc: receipts.append(r)
        ),
    )
    result = await kernel.invoke(plugin_name="orders", function_name="submit", payload={"invoice": {"id": "INV-1"}})
    assert str(result.value) == "submitted"
    assert receipts == ["req_allow"]


async def test_a_generator_function_runs_to_its_end_before_it_is_recorded():
    """Semantic Kernel's invoke() consumes a generator function inside the
    filter's next step, so the capability is redeemed after the body ran."""
    guardian = FakeClient(ALLOW)
    kernel = Kernel()

    class Exports:
        @kernel_function(name="export_rows")
        async def export_rows(self, n: int):
            guardian.calls.append("body:start")
            for i in range(n):
                yield f"row {i}"
            guardian.calls.append("body:end")

        @kernel_function(name="export_rows_sync")
        def export_rows_sync(self, n: int):
            guardian.calls.append("body:start")
            yield from (f"row {i}" for i in range(n))
            guardian.calls.append("body:end")

    kernel.add_plugin(Exports(), plugin_name="exports")
    kernel.add_filter(
        FilterTypes.FUNCTION_INVOCATION,
        GuardianFunctionInvocationFilter(AsyncFake(guardian), connection_id=CONNECTION),
    )
    for name in ("export_rows", "export_rows_sync"):
        guardian.calls.clear()
        history = ChatHistory()
        call = FunctionCallContent(id="call_1", function_name=name, plugin_name="exports", arguments='{"n": 2}')
        await kernel.invoke_function_call(call, history)
        assert "row 0" in str(history.messages[-1].items[0].result)
        assert "row 1" in str(history.messages[-1].items[0].result)
        assert guardian.calls == ["request:tool.invoke", "body:start", "body:end", "execute:req_allow"]


async def test_streaming_invocation_is_refused():
    guardian = FakeClient(ALLOW)
    kernel, billing = kernel_with(guardian)
    function = kernel.get_function("billing", "refund_order")
    with pytest.raises(GuardianDenied, match="STREAMING_NOT_GOVERNED"):
        async for _ in function.invoke_stream(kernel, KernelArguments(order_id="o1", amount_cents=1)):
            pass
    assert billing.ran == [] and guardian.calls == []


# --- remote mode: Guardian performs the call; the kernel function never runs ---


def guardian_result(text):
    return json.loads(text)["guardian"]


async def test_remote_allow_never_runs_the_function_and_the_result_is_guardians():
    guardian = FakeClient(ALLOW)
    receipts = []
    kernel, billing = kernel_with(guardian, mode="remote", on_receipt=lambda t, r, rc: receipts.append((t, r)))
    result = guardian_result(await model_calls(kernel))
    assert billing.ran == []
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    assert guardian.last_invocation["arguments"] == {"order_id": "o42", "amount_cents": 500}
    assert result == {
        "decision": "ALLOW",
        "request_id": "req_allow",
        "tool_name": "billing-refund_order",
        "receipt": {"schemaVersion": 1, "requestId": "req_allow", "status": "sent-verified"},
    }
    assert receipts == [("billing-refund_order", "req_allow")]


async def test_remote_held_then_approved_is_performed_by_guardian_on_the_same_call():
    guardian = FakeClient(HELD, claims=[APPROVED])
    kernel, billing = kernel_with(guardian, mode="remote")
    assert "held for human approval (request_id req_ask)" in await model_calls(kernel)
    assert guardian_result(await model_calls(kernel))["request_id"] == "req_ask"
    assert billing.ran == []
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask", "execute:req_ask"]


async def test_remote_denied_or_unreachable_performs_nothing():
    for answer in (DENIED, UNREACHABLE):
        guardian = FakeClient(answer)
        kernel, billing = kernel_with(guardian, mode="remote")
        text = await model_calls(kernel)
        assert billing.ran == []
        assert guardian.calls == ["request:tool.invoke"]
        assert "billing-refund_order" in text and "ALLOW" not in text


async def test_remote_a_call_guardian_did_not_send_is_not_reported_as_done():
    guardian = FakeClient(ALLOW, receipt_status="not-sent")
    errors = []
    kernel, billing = kernel_with(guardian, mode="remote", on_execution_error=errors.append)
    text = await model_calls(kernel)
    assert billing.ran == []
    assert [error.reason_code for error in errors] == ["EXECUTION_NOT_SENT"]
    assert '"decision": "ALLOW"' not in text


async def test_modes_set_the_mode_per_guardian_tool_name():
    guardian = FakeClient(ALLOW)
    kernel, billing = kernel_with(guardian, modes={"billing-refund_order": "remote"})
    assert guardian_result(await model_calls(kernel))["decision"] == "ALLOW"
    assert billing.ran == []

    guardian = FakeClient(ALLOW)
    kernel, billing = kernel_with(guardian, modes={"billing-other": "remote"})
    assert await model_calls(kernel) == "refunded o42"  # in-process by default
    assert billing.ran == [("o42", 500)]


def test_a_mistyped_mode_is_refused():
    with pytest.raises(ValueError, match="in_process"):
        kernel_with(FakeClient(ALLOW), mode="Remote")
    with pytest.raises(ValueError, match="in_process"):
        kernel_with(FakeClient(ALLOW), modes={"billing-refund_order": "inProcess"})
