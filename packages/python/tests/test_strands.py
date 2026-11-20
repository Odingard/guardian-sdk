"""Strands Agents: Guardian's hook provider in a real agent loop.

A scripted model stands in for the model provider and a fake client for
Guardian; the agent, its event loop, tool executors, hooks and middleware
are Strands' own. No network and no cloud credentials.
"""

import json

import pytest

pytest.importorskip("strands")

from strands import Agent, ToolContext, tool  # noqa: E402
from strands.hooks import BeforeToolCallEvent, HookOrder  # noqa: E402
from strands.middleware import ExecuteToolStage  # noqa: E402
from strands.models import Model  # noqa: E402
from strands.tools.executors import ConcurrentToolExecutor, SequentialToolExecutor  # noqa: E402

from odingard_guardian import GuardianClient, RequestResult  # noqa: E402
from odingard_guardian.strands import GuardianHookProvider  # noqa: E402

from test_guard import ALLOW, CONNECTION, HELD, AsyncFake, FakeClient  # noqa: E402

DENIED = RequestResult(ok=True, request_id="req_d", decision="DENY", reason_code="POLICY_DENY")
UNREACHABLE = RequestResult(ok=False, reason_code="SERVICE_UNAVAILABLE")
APPROVED = RequestResult(ok=True, request_id="req_ask", decision="ALLOW", capability_token="cap")
DECLINED = RequestResult(ok=False, request_id="req_ask", reason_code="APPROVAL_DENIED")


class ScriptedModel(Model):
    """Asks for the scripted tool calls one turn at a time, then answers "done"."""

    def __init__(self, turns):
        self.turns = [turn if isinstance(turn, list) else [turn] for turn in turns]
        self.asked = 0
        self.messages = []

    def update_config(self, **model_config):
        pass

    def get_config(self):
        return {}

    async def structured_output(self, output_model, prompt, system_prompt=None, **kwargs):
        raise NotImplementedError
        yield  # pragma: no cover

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.messages = messages
        self.asked += 1
        yield {"messageStart": {"role": "assistant"}}
        if self.turns:
            for index, (name, args) in enumerate(self.turns.pop(0)):
                tool_use = {"toolUseId": f"call_{self.asked}_{index}", "name": name}
                yield {"contentBlockStart": {"start": {"toolUse": tool_use}}}
                yield {"contentBlockDelta": {"delta": {"toolUse": {"input": json.dumps(args)}}}}
                yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
        else:
            yield {"contentBlockStart": {"start": {}}}
            yield {"contentBlockDelta": {"delta": {"text": "done"}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}
        yield {
            "metadata": {
                "usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2},
                "metrics": {"latencyMs": 1},
            }
        }

    def results(self):
        """Every tool result the model was given, in order."""
        return [
            block["toolResult"]
            for message in self.messages
            for block in message["content"]
            if "toolResult" in block
        ]

    def texts(self):
        return [result["content"][0]["text"] for result in self.results()]


ran = []


@tool
def refund_order(order_id: str, amount_cents: int) -> str:
    """Refund an order."""
    ran.append((order_id, amount_cents))
    return f"refunded {order_id}"


@tool
def lookup_order(order_id: str) -> str:
    """Look an order up."""
    ran.append(("lookup", order_id))
    return f"order {order_id}"


@tool
async def export_report(parts: int):
    """Export a report, part by part."""
    for part in range(parts):
        ran.append(("part", part))
        yield f"part {part}"
    yield "exported"


@pytest.fixture(autouse=True)
def _reset():
    ran.clear()


def provider(guardian, **options):
    return GuardianHookProvider(AsyncFake(guardian), connection_id=CONNECTION, **options)


def agent_for(calls, guardian_hooks, *more_hooks, tools=(refund_order, lookup_order, export_report), **options):
    model = ScriptedModel(calls)
    agent = Agent(
        model=model,
        tools=list(tools),
        hooks=[guardian_hooks, *more_hooks],
        callback_handler=None,
        **options,
    )
    return model, agent


CALL = ("refund_order", {"order_id": "o42", "amount_cents": 500})


# --- the three ways to call an agent -----------------------------------------


def test_allow_runs_the_tool_once_then_records_it():
    guardian = FakeClient(ALLOW)
    receipts = []
    model, agent = agent_for([CALL], provider(guardian, on_receipt=lambda t, r, rc: receipts.append((t, r))))
    result = agent("refund order 42")
    assert result.stop_reason == "end_turn"
    assert ran == [("o42", 500)]
    assert model.results() == [
        {"toolUseId": "call_1_0", "status": "success", "content": [{"text": "refunded o42"}]}
    ]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    assert guardian.last_invocation["tool_name"] == "refund_order"
    assert guardian.last_invocation["arguments"] == {"order_id": "o42", "amount_cents": 500}
    assert receipts == [("refund_order", "req_allow")]


async def test_invoke_async_allow():
    guardian = FakeClient(ALLOW)
    model, agent = agent_for([CALL], provider(guardian))
    await agent.invoke_async("refund order 42")
    assert ran == [("o42", 500)]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    assert model.texts() == ["refunded o42"]


async def test_stream_async_passes_a_streaming_tools_events_through():
    guardian = FakeClient(ALLOW)
    model, agent = agent_for([("export_report", {"parts": 2})], provider(guardian))
    order = []
    async for event in agent.stream_async("export"):
        if event.get("type") == "tool_stream":
            order.append((event["tool_stream_event"]["data"], list(guardian.calls)))
    # Each event arrives while the tool runs: after the decision, before the capability is redeemed.
    assert order == [
        ("part 0", ["request:tool.invoke"]),
        ("part 1", ["request:tool.invoke"]),
        ("exported", ["request:tool.invoke"]),
    ]
    assert ran == [("part", 0), ("part", 1)]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    assert model.texts() == ["exported"]


async def test_a_denied_streaming_tool_yields_nothing():
    guardian = FakeClient(DENIED)
    model, agent = agent_for([("export_report", {"parts": 2})], provider(guardian))
    streamed = [event async for event in agent.stream_async("export") if event.get("type") == "tool_stream"]
    assert streamed == [] and ran == []
    assert model.results()[0]["status"] == "error"


async def test_an_abandoned_stream_does_not_run_the_tool_on_or_redeem_anything():
    import asyncio

    guardian = FakeClient(ALLOW)
    _, agent = agent_for([("export_report", {"parts": 3})], provider(guardian))
    events = agent.stream_async("export")
    async for event in events:
        if event.get("type") == "tool_stream":
            break
    await events.aclose()
    await asyncio.sleep(0.05)
    # The tool is handed on one event at a time: with no one taking them it goes no further.
    assert ran == [("part", 0)]
    assert guardian.calls == ["request:tool.invoke"]


def test_a_sync_guardian_client_works_across_sync_agent_calls():
    guardian = FakeClient(ALLOW)
    hooks = GuardianHookProvider(guardian, connection_id=CONNECTION)
    model, agent = agent_for([CALL, CALL], hooks)
    agent("refund order 42")
    assert ran == [("o42", 500), ("o42", 500)]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"] * 2
    model.turns.append([CALL])
    agent("again")  # Strands runs each sync call on a new event loop
    assert len(ran) == 3


def test_a_real_sync_client_is_accepted():
    GuardianHookProvider(GuardianClient(credential="gak_test"), connection_id=CONNECTION)


def test_a_direct_tool_call_is_decided_too():
    guardian = FakeClient(DENIED)
    _, agent = agent_for([], provider(guardian))
    result = agent.tool.refund_order(order_id="o42", amount_cents=500)
    assert ran == []
    assert result["status"] == "error" and "Guardian denied refund_order" in result["content"][0]["text"]


# --- decisions -----------------------------------------------------------------


def test_held_then_approved_runs_on_the_same_call():
    guardian = FakeClient(HELD, claims=[APPROVED])
    pending = []
    model, agent = agent_for(
        [CALL, CALL], provider(guardian, on_approval_pending=lambda t, r: pending.append((t, r)))
    )
    agent("refund order 42")
    assert pending == [("refund_order", "req_ask")]
    assert model.results()[0]["status"] == "error"
    assert "held for human approval (request_id req_ask)" in model.texts()[0]
    # The second call claims the approved request instead of proposing a new one.
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask", "execute:req_ask"]
    assert ran == [("o42", 500)]
    assert model.texts()[1] == "refunded o42"


def test_held_and_not_yet_approved_does_not_run_or_ask_twice():
    guardian = FakeClient(HELD)
    model, agent = agent_for([CALL, CALL], provider(guardian))
    agent("refund order 42")
    assert ran == []
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask"]
    assert all("held for human approval" in text for text in model.texts())


def test_held_then_declined_never_runs():
    guardian = FakeClient(HELD, claims=[DECLINED])
    model, agent = agent_for([CALL, CALL], provider(guardian))
    agent("refund order 42")
    assert ran == []
    assert "Guardian denied refund_order (APPROVAL_DENIED)" in model.texts()[1]
    assert "execute:req_ask" not in guardian.calls


def test_denied_never_runs():
    guardian = FakeClient(DENIED)
    model, agent = agent_for([CALL], provider(guardian))
    agent("refund order 42")
    assert ran == []
    assert model.results() == [
        {
            "toolUseId": "call_1_0",
            "status": "error",
            "content": [{"text": "Guardian denied refund_order (POLICY_DENY). Do not retry the same call."}],
        }
    ]


def test_guardian_unreachable_fails_closed():
    guardian = FakeClient(UNREACHABLE)
    model, agent = agent_for([CALL], provider(guardian))
    agent("refund order 42")
    assert ran == []
    assert "could not be reached to check refund_order" in model.texts()[0]


@pytest.mark.parametrize("wrap", [AsyncFake, lambda sync: sync], ids=["async-client", "sync-client"])
def test_a_guardian_client_that_raises_fails_closed(wrap):
    class Broken(FakeClient):
        def request(self, invocation):
            raise ConnectionError("network down")

    hooks = GuardianHookProvider(wrap(Broken(ALLOW)), connection_id=CONNECTION)
    model, agent = agent_for([CALL], hooks)
    agent("refund order 42")
    assert ran == []
    assert model.texts() == ["Guardian could not check refund_order, so it did not run. Try again later."]


def test_a_failed_redemption_tells_the_model_not_to_call_again():
    guardian = FakeClient(ALLOW, execute_ok=False)
    failures = []
    model, agent = agent_for([CALL], provider(guardian, on_execution_error=failures.append))
    agent("refund order 42")
    assert ran == [("o42", 500)]
    assert model.results()[0]["status"] == "error"
    assert "could not record it" in model.texts()[0] and "Do not call it again" in model.texts()[0]
    assert failures[0].local_effect_ran is True


def test_a_tool_that_fails_is_reported_as_the_tool_reported_it_and_nothing_is_redeemed():
    @tool
    def charge(order_id: str) -> str:
        """Charge an order."""
        ran.append("charge")
        raise RuntimeError("card declined")

    guardian = FakeClient(ALLOW)
    model, agent = agent_for([("charge", {"order_id": "o1"})], provider(guardian), tools=(charge,))
    agent("charge")
    assert ran == ["charge"]
    assert guardian.calls == ["request:tool.invoke"]
    assert model.results()[0]["status"] == "error"
    assert model.texts() == ["Error: RuntimeError - card declined"]


def test_arguments_the_tool_rejects_are_not_redeemed():
    guardian = FakeClient(ALLOW)
    model, agent = agent_for([("refund_order", {"order_id": "o42"})], provider(guardian))
    agent("refund")
    assert ran == [] and guardian.calls == ["request:tool.invoke"]
    assert "amount_cents" in model.texts()[0]


def test_the_proposal_is_the_arguments_as_the_model_sent_them():
    guardian = FakeClient(ALLOW)
    _, agent = agent_for([("refund_order", {"order_id": "o42", "amount_cents": "500"})], provider(guardian))
    agent("refund")
    # Strands validates inside the tool, after the decision.
    assert guardian.last_invocation["arguments"] == {"order_id": "o42", "amount_cents": "500"}
    assert ran == [("o42", 500)]


def test_an_unknown_tool_proposes_nothing():
    guardian = FakeClient(ALLOW)
    model, agent = agent_for([("wire_money", {"to": "x"})], provider(guardian))
    agent("wire")
    assert guardian.calls == [] and ran == []
    assert "Unknown tool: wire_money" in model.texts()[0]


def test_arguments_that_are_not_json_are_refused_before_anything_is_proposed():
    guardian = FakeClient(ALLOW)
    _, agent = agent_for([], provider(guardian))
    result = agent.tool.refund_order(order_id=object(), amount_cents=500)
    assert guardian.calls == [] and ran == []
    assert "could not read the arguments of refund_order" in result["content"][0]["text"]


def test_amount_args_carry_the_declaration_and_the_amount():
    guardian = FakeClient(ALLOW)
    declaration = {"argument": "amount_cents", "unit": "minor", "currency": "usd"}
    _, agent = agent_for([CALL], provider(guardian, amount_args={"refund_order": declaration}))
    agent("refund order 42")
    assert guardian.last_invocation["amount_argument"] == declaration
    assert guardian.last_invocation["value_cents"] == 500


def test_tool_names_map_to_guardian_names():
    guardian = FakeClient(ALLOW)
    _, agent = agent_for([CALL], provider(guardian, tool_names={"refund_order": "billing.refund"}))
    agent("refund order 42")
    assert guardian.last_invocation["tool_name"] == "billing.refund"


# --- ASK as a Strands interrupt -------------------------------------------------


def respond(interrupt, response="yes, run it"):
    return [{"interruptResponse": {"interruptId": interrupt.id, "response": response}}]


def test_on_ask_interrupt_pauses_the_run_and_a_local_response_approves_nothing():
    not_yet = RequestResult(ok=False, request_id="req_ask", reason_code="APPROVAL_PENDING")
    guardian = FakeClient(HELD, claims=[not_yet, APPROVED])
    pending = []
    model, agent = agent_for(
        [CALL], provider(guardian, on_ask="interrupt", on_approval_pending=lambda t, r: pending.append(r))
    )
    paused = agent("refund order 42")
    assert paused.stop_reason == "interrupt" and ran == []
    (interrupt,) = paused.interrupts
    assert interrupt.reason["guardian"]["request_id"] == "req_ask"
    assert interrupt.reason["guardian"]["tool_name"] == "refund_order"

    # Resumed before the person approved: the response does not stand in for
    # Guardian's approval. The call claims the request and pauses again.
    still = agent(respond(interrupt))
    assert still.stop_reason == "interrupt" and ran == []
    (again,) = still.interrupts
    assert again.id != interrupt.id and again.response is None
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask"]

    # Resumed after the approval: the same call runs once, without asking the model again.
    done = agent(respond(again))
    assert done.stop_reason == "end_turn"
    assert ran == [("o42", 500)]
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask", "claim:req_ask", "execute:req_ask"]
    assert model.texts() == ["refunded o42"]
    assert pending == ["req_ask", "req_ask"]


def test_on_ask_interrupt_keeps_the_other_calls_of_the_turn():
    class ByTool(FakeClient):
        def request(self, invocation):
            self.invoke = HELD if invocation.get("tool_name") == "refund_order" else ALLOW
            return super().request(invocation)

    guardian = ByTool(ALLOW, claims=[APPROVED])
    model, agent = agent_for(
        [[("lookup_order", {"order_id": "o42"}), CALL]],
        provider(guardian, on_ask="interrupt"),
        tool_executor=SequentialToolExecutor(),
    )
    paused = agent("look up and refund")
    assert paused.stop_reason == "interrupt" and ran == [("lookup", "o42")]
    agent(respond(paused.interrupts[0]))
    # The allowed call is not made again; the held one runs after approval.
    assert ran == [("lookup", "o42"), ("o42", 500)]
    assert model.texts() == ["order o42", "refunded o42"]


def test_on_ask_takes_result_or_interrupt():
    with pytest.raises(ValueError, match="on_ask"):
        provider(FakeClient(ALLOW), on_ask="stop")


# --- nothing changes the arguments between the decision and the tool -----------


def rewrite(amount, in_place=False):
    def hook(event: BeforeToolCallEvent) -> None:
        if in_place:
            event.tool_use["input"]["amount_cents"] = amount
        else:
            event.tool_use = {**event.tool_use, "input": {**event.tool_use["input"], "amount_cents": amount}}

    return hook


@pytest.mark.parametrize("in_place", [False, True], ids=["replaced", "in-place"])
def test_a_hook_registered_after_guardian_is_decided_on(in_place):
    guardian = FakeClient(ALLOW)
    _, agent = agent_for([CALL], provider(guardian), rewrite(99_999, in_place))
    agent("refund order 42")
    # The decision is made after every hook: Guardian decided on what ran.
    assert guardian.last_invocation["arguments"] == {"order_id": "o42", "amount_cents": 99_999}
    assert ran == [("o42", 99_999)]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]


@pytest.mark.parametrize("in_place", [False, True], ids=["replaced", "in-place"])
def test_a_hook_ordered_after_guardians_is_decided_on(in_place):
    guardian = FakeClient(ALLOW)
    _, agent = agent_for([CALL], provider(guardian))
    agent.hooks.add_callback(BeforeToolCallEvent, rewrite(99_999, in_place), order=HookOrder.SDK_LAST + 1)
    agent("refund order 42")
    assert guardian.last_invocation["arguments"] == {"order_id": "o42", "amount_cents": 99_999}
    assert ran == [("o42", 99_999)]


def test_tool_middleware_is_decided_on():
    def tamper(context):
        return context.replace(tool_use={**context.tool_use, "input": {"order_id": "o42", "amount_cents": 99_999}})

    guardian = FakeClient(ALLOW)
    _, agent = agent_for([CALL], provider(guardian))
    agent.add_middleware(ExecuteToolStage.Input, tamper)
    agent("refund order 42")
    assert guardian.last_invocation["arguments"] == {"order_id": "o42", "amount_cents": 99_999}
    assert ran == [("o42", 99_999)]


def test_a_change_made_while_guardian_decides_does_not_reach_the_tool():
    seen = {}

    def capture(event: BeforeToolCallEvent) -> None:
        seen["tool_use"] = event.tool_use

    class Tampering(FakeClient):
        def request(self, invocation):
            # While Guardian is asked, something rewrites the call's record
            # and the proposal itself.
            seen["tool_use"]["input"]["amount_cents"] = 99_999
            seen["tool_use"]["input"]["order_id"] = "o666"
            answer = super().request(invocation)
            self.proposed = json.loads(json.dumps(invocation["arguments"]))
            invocation["arguments"]["amount_cents"] = 1
            return answer

    guardian = Tampering(ALLOW)
    model, agent = agent_for([CALL], provider(guardian), capture)
    agent("refund order 42")
    assert guardian.proposed == {"order_id": "o42", "amount_cents": 500}
    assert ran == [("o42", 500)]
    assert model.texts() == ["refunded o42"]


def test_a_change_made_while_waiting_for_approval_is_a_new_request():
    guardian = FakeClient(HELD, claims=[APPROVED])
    model, agent = agent_for(
        [CALL, ("refund_order", {"order_id": "o42", "amount_cents": 99_999})], provider(guardian)
    )
    agent("refund order 42")
    # Other arguments never claim the approved request.
    assert guardian.calls == ["request:tool.invoke", "request:tool.invoke"]
    assert ran == []


def test_the_tools_context_names_the_decided_call():
    seen = []

    @tool(context=True)
    def audit(note: str, tool_context: ToolContext) -> str:
        """Write an audit note."""
        seen.append((note, dict(tool_context.tool_use["input"])))
        return "noted"

    captured = {}

    def capture(event: BeforeToolCallEvent) -> None:
        captured["tool_use"] = event.tool_use

    class Rewrites(FakeClient):
        def request(self, invocation):
            captured["tool_use"]["input"]["note"] = "rewritten"
            return super().request(invocation)

    guardian = Rewrites(ALLOW)
    _, agent = agent_for([("audit", {"note": "paid"})], provider(guardian), capture, tools=(audit,))
    agent("audit")
    assert seen == [("paid", {"note": "paid"})]


def test_a_hook_that_renames_the_call_is_decided_under_the_tool_that_runs():
    def reroute(event: BeforeToolCallEvent) -> None:
        event.tool_use = {**event.tool_use, "name": "lookup_order", "input": {"order_id": "o42"}}

    guardian = FakeClient(ALLOW)
    model, agent = agent_for([CALL], provider(guardian), reroute)
    agent("refund order 42")
    assert guardian.last_invocation["tool_name"] == "lookup_order"
    assert guardian.last_invocation["arguments"] == {"order_id": "o42"}
    assert ran == [("lookup", "o42")]
    assert model.texts() == ["order o42"]


def test_a_hook_that_selects_another_tool_is_decided_under_that_tool():
    def substitute(event: BeforeToolCallEvent) -> None:
        event.selected_tool = lookup_order

    guardian = FakeClient(ALLOW)
    _, agent = agent_for([("refund_order", {"order_id": "o42"})], provider(guardian), substitute)
    agent("refund order 42")
    assert guardian.last_invocation["tool_name"] == "lookup_order"
    assert ran == [("lookup", "o42")]


def test_a_hook_that_cancels_the_call_proposes_nothing():
    def cancel(event: BeforeToolCallEvent) -> None:
        event.cancel_tool = "not today"

    guardian = FakeClient(ALLOW)
    model, agent = agent_for([CALL], provider(guardian), cancel)
    agent("refund order 42")
    assert guardian.calls == [] and ran == []
    assert model.texts() == ["not today"]


def test_a_hook_that_takes_guardians_tool_away_is_reported():
    def bypass(event: BeforeToolCallEvent) -> None:
        event.selected_tool = refund_order

    guardian = FakeClient(DENIED)
    model, agent = agent_for([CALL], provider(guardian))
    agent.hooks.add_callback(BeforeToolCallEvent, bypass, order=HookOrder.SDK_LAST + 1)
    agent("refund order 42")
    # Not prevented (see the README's limits): it is reported as an error.
    assert guardian.calls == []
    assert model.results()[0]["status"] == "error"
    assert "ran without a Guardian decision" in model.texts()[0]


def test_a_tool_that_pauses_itself_is_not_redeemed_and_is_decided_again_on_resume():
    @tool(context=True)
    def wire(amount_cents: int, tool_context: ToolContext) -> str:
        """Send a wire."""
        confirmed = tool_context.interrupt("confirm-wire", reason="confirm the wire")
        ran.append(("wire", amount_cents, confirmed))
        return "wired"

    guardian = FakeClient(ALLOW)
    model, agent = agent_for([("wire", {"amount_cents": 500})], provider(guardian), tools=(wire,))
    paused = agent("wire")
    assert paused.stop_reason == "interrupt" and ran == []
    assert guardian.calls == ["request:tool.invoke"]
    agent(respond(paused.interrupts[0], "confirmed"))
    assert ran == [("wire", 500, "confirmed")]
    assert guardian.calls == ["request:tool.invoke", "request:tool.invoke", "execute:req_allow"]
    assert model.texts() == ["wired"]


def test_the_structured_output_tool_is_decided_like_any_other():
    from pydantic import BaseModel

    class Summary(BaseModel):
        total: int

    guardian = FakeClient(ALLOW)
    _, agent = agent_for([("Summary", {"total": 3})], provider(guardian))
    result = agent("sum up", structured_output_model=Summary)
    assert result.structured_output == Summary(total=3)
    assert guardian.last_invocation["tool_name"] == "Summary"
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]


def test_a_retry_asked_for_by_a_hook_is_decided_again():
    from strands.hooks import AfterToolCallEvent

    retried = []

    def retry_once(event: AfterToolCallEvent) -> None:
        if not retried:
            retried.append(True)
            event.retry = True

    guardian = FakeClient(ALLOW)
    _, agent = agent_for([CALL], provider(guardian))
    agent.hooks.add_callback(AfterToolCallEvent, retry_once)
    agent("refund order 42")
    assert ran == [("o42", 500)] * 2
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"] * 2


# --- executors ------------------------------------------------------------------


@pytest.mark.parametrize("executor", [ConcurrentToolExecutor, SequentialToolExecutor])
def test_each_call_of_a_turn_gets_its_own_decision(executor):
    class ByTool(FakeClient):
        def request(self, invocation):
            self.calls.append(f"request:{invocation['tool_name']}")
            if invocation["tool_name"] == "refund_order":
                return DENIED
            return RequestResult(
                ok=True, request_id=f"req_{invocation['tool_name']}", decision="ALLOW", capability_token="cap"
            )

    guardian = ByTool(ALLOW)
    model, agent = agent_for(
        [[("lookup_order", {"order_id": "o42"}), CALL, ("export_report", {"parts": 1})]],
        provider(guardian),
        tool_executor=executor(),
    )
    agent("do it all")
    assert sorted(ran, key=str) == [("lookup", "o42"), ("part", 0)]
    assert sorted(guardian.calls) == [
        "execute:req_export_report",
        "execute:req_lookup_order",
        "request:export_report",
        "request:lookup_order",
        "request:refund_order",
    ]
    by_id = {result["toolUseId"]: result for result in model.results()}
    assert by_id["call_1_0"]["content"][0]["text"] == "order o42"
    assert by_id["call_1_1"]["status"] == "error" and "Guardian denied" in by_id["call_1_1"]["content"][0]["text"]
    assert by_id["call_1_2"]["content"][0]["text"] == "exported"


# --- remote mode ----------------------------------------------------------------


def test_remote_mode_never_runs_the_local_tool_and_gives_the_model_guardians_answer():
    guardian = FakeClient(ALLOW)
    model, agent = agent_for([CALL], provider(guardian, mode="remote"))
    agent("refund order 42")
    assert ran == []
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    (result,) = model.results()
    assert result["status"] == "success"
    assert json.loads(result["content"][0]["text"]) == {
        "guardian": {
            "decision": "ALLOW",
            "request_id": "req_allow",
            "tool_name": "refund_order",
            "receipt": {"schemaVersion": 1, "requestId": "req_allow", "status": "sent-verified"},
        }
    }


def test_modes_set_remote_per_tool():
    guardian = FakeClient(ALLOW)
    model, agent = agent_for(
        [[("lookup_order", {"order_id": "o42"}), CALL]],
        provider(guardian, modes={"refund_order": "remote"}),
        tool_executor=SequentialToolExecutor(),
    )
    agent("look up and refund")
    assert ran == [("lookup", "o42")]
    assert model.texts()[0] == "order o42"
    assert json.loads(model.texts()[1])["guardian"]["receipt"]["status"] == "sent-verified"


def test_remote_mode_held_denied_and_unreachable_do_not_execute():
    for answer in (HELD, DENIED, UNREACHABLE):
        guardian = FakeClient(answer)
        model, agent = agent_for([CALL], provider(guardian, mode="remote"))
        agent("refund order 42")
        assert ran == [] and guardian.calls == ["request:tool.invoke"]
        assert model.results()[0]["status"] == "error"


def test_remote_mode_an_unverified_receipt_is_not_reported_as_done():
    guardian = FakeClient(ALLOW, receipt_status="outcome-pending")
    model, agent = agent_for([CALL], provider(guardian, mode="remote"))
    agent("refund order 42")
    assert ran == []
    assert model.results()[0]["status"] == "error"
    assert "may have run" in model.texts()[0] and "Do not call it again" in model.texts()[0]


def test_an_unknown_mode_is_refused():
    with pytest.raises(ValueError, match="mode"):
        provider(FakeClient(ALLOW), mode="hosted")
