"""Microsoft Agent Framework: Guardian's function middleware in a real agent loop.

A scripted chat client stands in for the model and a fake client for
Guardian; the agent, its function-calling loop and the middleware pipeline
are Agent Framework's own.
"""

import pytest

af = pytest.importorskip("agent_framework")

from agent_framework import (  # noqa: E402
    Agent,
    BaseChatClient,
    ChatMiddlewareLayer,
    ChatResponse,
    Content,
    FunctionInvocationContext,
    FunctionInvocationLayer,
    Message,
    function_middleware,
    tool,
)

from odingard_guardian import GuardianClient, RequestResult  # noqa: E402
from odingard_guardian.agent_framework import GuardianFunctionMiddleware  # noqa: E402

from test_guard import ALLOW, CONNECTION, HELD, AsyncFake, FakeClient  # noqa: E402

DENIED = RequestResult(ok=True, request_id="req_d", decision="DENY", reason_code="POLICY_DENY")
UNREACHABLE = RequestResult(ok=False, reason_code="SERVICE_UNAVAILABLE")
APPROVED = RequestResult(ok=True, request_id="req_ask", decision="ALLOW", capability_token="cap")
DECLINED = RequestResult(ok=False, request_id="req_ask", reason_code="APPROVAL_DENIED")


class ScriptedModel(FunctionInvocationLayer, ChatMiddlewareLayer, BaseChatClient):
    """Asks for the scripted tool calls one turn at a time, then answers "done"."""

    def __init__(self, calls):
        super().__init__()
        self.calls = list(calls)
        self.tool_results = []

    async def _respond(self, messages):
        for message in messages:
            for content in message.contents:
                if content.type == "function_result" and content not in self.tool_results:
                    self.tool_results.append(content)
        if self.calls:
            name, args = self.calls.pop(0)
            call = Content.from_function_call(call_id=f"call_{len(self.calls)}", name=name, arguments=args)
            return ChatResponse(messages=[Message(role="assistant", contents=[call])])
        return ChatResponse(messages=[Message(role="assistant", contents=["done"])])

    def _inner_get_response(self, *, messages, stream, options, **kwargs):
        return self._respond(messages)

    def results(self):
        return [str(content.result) for content in self.tool_results]


ran = []


@tool(approval_mode="never_require")
def refund_order(order_id: str, amount_cents: int) -> str:
    """Refund an order."""
    ran.append((order_id, amount_cents))
    return f"refunded {order_id}"


@pytest.fixture(autouse=True)
def _reset():
    ran.clear()


def middleware(guardian, **options):
    return GuardianFunctionMiddleware(AsyncFake(guardian), connection_id=CONNECTION, **options)


async def run(calls, guardian_middleware, *extra, tools=(refund_order,)):
    model = ScriptedModel(calls)
    agent = Agent(client=model, tools=list(tools), middleware=[*extra, guardian_middleware])
    response = await agent.run("refund order 42")
    return model, response


CALL = ("refund_order", {"order_id": "o42", "amount_cents": 500})


async def test_allow_runs_the_tool_once_then_records_it():
    guardian = FakeClient(ALLOW)
    receipts = []
    model, _ = await run([CALL], middleware(guardian, on_receipt=lambda t, r, rc: receipts.append((t, r))))
    assert ran == [("o42", 500)]
    assert model.results() == ["refunded o42"]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    assert guardian.last_invocation["tool_name"] == "refund_order"
    assert guardian.last_invocation["arguments"] == {"order_id": "o42", "amount_cents": 500}
    assert receipts == [("refund_order", "req_allow")]


async def test_the_proposal_is_the_validated_arguments_the_tool_receives():
    guardian = FakeClient(ALLOW)
    await run([("refund_order", {"order_id": "o42", "amount_cents": "500"})], middleware(guardian))
    assert guardian.last_invocation["arguments"] == {"order_id": "o42", "amount_cents": 500}
    assert ran == [("o42", 500)]


async def test_held_then_approved_runs_on_the_same_call():
    guardian = FakeClient(HELD, claims=[APPROVED])
    pending = []
    model, _ = await run(
        [CALL, CALL], middleware(guardian, on_approval_pending=lambda t, r: pending.append((t, r)))
    )
    assert pending == [("refund_order", "req_ask")]
    assert "held for human approval (request_id req_ask)" in model.results()[0]
    # The second call claims the approved request instead of proposing a new one.
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask", "execute:req_ask"]
    assert ran == [("o42", 500)]
    assert model.results()[1] == "refunded o42"


async def test_held_and_not_yet_approved_does_not_run_or_ask_twice():
    guardian = FakeClient(HELD)
    model, _ = await run([CALL, CALL], middleware(guardian))
    assert ran == []
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask"]
    assert all("held for human approval" in text for text in model.results())


async def test_held_then_declined_never_runs():
    guardian = FakeClient(HELD, claims=[DECLINED])
    model, _ = await run([CALL, CALL], middleware(guardian))
    assert ran == []
    assert "Guardian denied refund_order (APPROVAL_DENIED)" in model.results()[1]
    assert "execute:req_ask" not in guardian.calls


async def test_denied_never_runs():
    guardian = FakeClient(DENIED)
    model, _ = await run([CALL], middleware(guardian))
    assert ran == []
    assert model.results() == ["Guardian denied refund_order (POLICY_DENY). Do not retry the same call."]


async def test_guardian_unreachable_fails_closed():
    guardian = FakeClient(UNREACHABLE)
    model, _ = await run([CALL], middleware(guardian))
    assert ran == []
    assert "could not be reached to check refund_order" in model.results()[0]


async def test_a_guardian_client_that_raises_fails_closed():
    class Broken(FakeClient):
        def request(self, invocation):
            raise ConnectionError("network down")

    model, _ = await run([CALL], middleware(Broken(ALLOW)))
    assert ran == []
    assert model.results() == ["Guardian could not check refund_order, so it did not run. Try again later."]


async def test_on_ask_stop_ends_the_run_without_running_the_tool():
    guardian = FakeClient(HELD)
    model, response = await run([CALL, CALL], middleware(guardian, on_ask="stop"))
    assert ran == []
    assert guardian.calls == ["request:tool.invoke"]  # the second call never came
    assert "held for human approval" in response.messages[-1].contents[0].result


async def test_on_deny_stop_ends_the_run():
    guardian = FakeClient(DENIED)
    model, response = await run([CALL, CALL], middleware(guardian, on_deny="stop"))
    assert ran == []
    assert guardian.calls == ["request:tool.invoke"]


async def test_amount_args_carry_the_declaration_and_the_amount():
    guardian = FakeClient(ALLOW)
    declaration = {"argument": "amount_cents", "unit": "minor", "currency": "usd"}
    await run([CALL], middleware(guardian, amount_args={"refund_order": declaration}))
    assert guardian.last_invocation["amount_argument"] == declaration
    assert guardian.last_invocation["value_cents"] == 500


async def test_tool_names_map_to_guardian_names():
    guardian = FakeClient(ALLOW)
    await run([CALL], middleware(guardian, tool_names={"refund_order": "billing.refund"}))
    assert guardian.last_invocation["tool_name"] == "billing.refund"


async def test_a_middleware_after_guardian_cannot_change_what_runs():
    seen = []

    @function_middleware
    async def tamper(context: FunctionInvocationContext, call_next):
        seen.append("tamper")
        context.arguments = {**context.arguments, "amount_cents": 99_999}
        await call_next()

    guardian = FakeClient(ALLOW)
    model = ScriptedModel([CALL])
    agent = Agent(client=model, tools=[refund_order], middleware=[middleware(guardian), tamper])
    await agent.run("refund order 42")
    # Guardian runs the tool itself with the decided arguments; the later
    # middleware never sees the call.
    assert seen == []
    assert ran == [("o42", 500)]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    assert model.results() == ["refunded o42"]


async def test_a_middleware_before_guardian_is_decided_on():
    @function_middleware
    async def repair(context: FunctionInvocationContext, call_next):
        context.arguments = {**context.arguments, "order_id": "o43"}
        await call_next()

    guardian = FakeClient(ALLOW)
    await run([CALL], middleware(guardian), repair)
    assert guardian.last_invocation["arguments"]["order_id"] == "o43"
    assert ran == [("o43", 500)]


async def test_a_failed_redemption_tells_the_model_not_to_call_again():
    guardian = FakeClient(ALLOW, execute_ok=False)
    model, _ = await run([CALL], middleware(guardian))
    assert ran == [("o42", 500)]
    assert "could not record it" in model.results()[0] and "Do not call it again" in model.results()[0]


def test_a_sync_client_is_refused():
    with pytest.raises(TypeError, match="AsyncGuardianClient"):
        GuardianFunctionMiddleware(GuardianClient(credential="gak_test"), connection_id=CONNECTION)


async def test_run_level_middleware_cannot_change_what_runs():
    @function_middleware
    async def tamper(context: FunctionInvocationContext, call_next):
        context.arguments = {**context.arguments, "amount_cents": 1}
        await call_next()

    guardian = FakeClient(ALLOW)
    agent = Agent(client=ScriptedModel([CALL]), tools=[refund_order], middleware=[middleware(guardian)])
    await agent.run("refund order 42", middleware=[tamper])
    assert ran == [("o42", 500)]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]


async def test_a_generator_tool_is_refused_before_anything_is_proposed():
    """Agent Framework never iterates a tool's generator, so its body would not run."""

    @tool(approval_mode="never_require")
    async def export_rows(n: int):
        """Export rows."""
        ran.append("started")
        for i in range(n):
            yield f"row {i}"

    @tool(approval_mode="never_require")
    def export_rows_sync(n: int):
        """Export rows."""
        ran.append("started")
        yield from range(n)

    for generator_tool in (export_rows, export_rows_sync):
        guardian = FakeClient(ALLOW)
        model, _ = await run([(generator_tool.name, {"n": 2})], middleware(guardian), tools=(generator_tool,))
        assert "is a generator function" in model.results()[0]
        assert "Nothing was proposed or run" in model.results()[0]
        assert ran == [] and guardian.calls == []


async def test_a_tool_that_changes_its_own_inputs_is_still_recorded():
    @tool(approval_mode="never_require")
    def submit(payload: dict) -> str:
        """Submit a payload."""
        payload.pop("invoice")
        ran.append("submitted")
        return "submitted"

    guardian = FakeClient(ALLOW)
    receipts = []
    model, _ = await run(
        [("submit", {"payload": {"invoice": {"id": "INV-1"}, "lines": [1, 2]}})],
        middleware(guardian, on_receipt=lambda t, r, rc: receipts.append(r)),
        tools=(submit,),
    )
    assert ran == ["submitted"] and receipts == ["req_allow"]
    assert model.results() == ["submitted"]
