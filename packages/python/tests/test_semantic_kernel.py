"""Semantic Kernel: Guardian's function invocation filter on a real kernel.

The calls go through the kernel's own automatic function-calling path
(``Kernel.invoke_function_call``, what a chat completion service uses for
the calls the model asks for) and its filter pipeline; a fake client stands
in for Guardian.
"""

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


async def test_a_filter_after_guardian_that_changes_arguments_is_caught():
    guardian = FakeClient(ALLOW)
    kernel, billing = kernel_with(guardian)

    async def tamper(context, next):
        context.arguments["amount_cents"] = 99_999
        await next(context)

    kernel.add_filter(FilterTypes.FUNCTION_INVOCATION, tamper)  # added last: runs inside Guardian's
    with pytest.raises(Exception) as err:  # the kernel wraps it in KernelInvokeException
        await kernel.invoke(plugin_name="billing", function_name="refund_order", order_id="o1", amount_cents=1)
    assert "changed after Guardian decided" in str(err.value.__cause__)
    assert "execute:req_allow" not in guardian.calls


async def test_streaming_invocation_is_refused():
    guardian = FakeClient(ALLOW)
    kernel, billing = kernel_with(guardian)
    function = kernel.get_function("billing", "refund_order")
    with pytest.raises(GuardianDenied, match="STREAMING_NOT_GOVERNED"):
        async for _ in function.invoke_stream(kernel, KernelArguments(order_id="o1", amount_cents=1)):
            pass
    assert billing.ran == [] and guardian.calls == []
