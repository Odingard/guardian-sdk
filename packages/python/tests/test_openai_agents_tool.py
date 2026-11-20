"""OpenAI Agents SDK: governed tools in the SDK's own run loop.

A scripted model stands in for the LLM and a fake client for Guardian; the
agent, ``Runner.run`` / ``Runner.run_streamed``, tool execution and the
approval interruptions are the Agents SDK's own.
"""

import asyncio
import json

import pytest

agents = pytest.importorskip("agents")

from agents import (  # noqa: E402
    Agent,
    FunctionTool,
    ModelResponse,
    Runner,
    Usage,
    function_tool,
    set_tracing_disabled,
)
from agents.models.interface import Model  # noqa: E402
from openai.types.responses import (  # noqa: E402
    Response,
    ResponseCompletedEvent,
    ResponseFunctionToolCall,
    ResponseOutputMessage,
    ResponseOutputText,
)

from odingard_guardian import (  # noqa: E402
    ExecuteResult,
    GuardianApprovalPending,
    GuardianDenied,
    GuardianExecutionFailed,
    RequestResult,
)
from odingard_guardian import openai_agents as module  # noqa: E402
from odingard_guardian.openai_agents import (  # noqa: E402
    create_guardian_tool,
    find_approval_pending,
    guardian_request_id,
    guardian_tool,
)

from test_guard import ALLOW, CONNECTION, HELD, AsyncFake, FakeClient  # noqa: E402

set_tracing_disabled(True)

DENIED = RequestResult(ok=True, request_id="req_d", decision="DENY", reason_code="POLICY_DENY")
UNREACHABLE = RequestResult(ok=False, reason_code="SERVICE_UNAVAILABLE")
APPROVED = RequestResult(ok=True, request_id="req_ask", decision="ALLOW", capability_token="cap")
DECLINED = RequestResult(ok=False, request_id="req_ask", reason_code="APPROVAL_DENIED")


class ScriptedModel(Model):
    """Asks for the scripted tool calls one turn at a time, then answers "done".

    A turn is one ``(name, arguments)`` call or a list of them (parallel
    calls). ``arguments`` is a dict or the raw JSON text.
    """

    def __init__(self, turns):
        self.turns = list(turns)
        self.count = 0
        self.tool_results = {}

    def _next(self, input):
        for item in input if isinstance(input, list) else []:
            if isinstance(item, dict) and item.get("type") == "function_call_output":
                self.tool_results[item["call_id"]] = item["output"]
        if not self.turns:
            text = ResponseOutputText(type="output_text", text="done", annotations=[])
            return [
                ResponseOutputMessage(
                    id="msg", type="message", role="assistant", status="completed", content=[text]
                )
            ]
        turn = self.turns.pop(0)
        calls = turn if isinstance(turn, list) else [turn]
        output = []
        for name, arguments in calls:
            self.count += 1
            output.append(
                ResponseFunctionToolCall(
                    type="function_call",
                    id=f"fc_{self.count}",
                    call_id=f"call_{self.count}",
                    name=name,
                    arguments=arguments if isinstance(arguments, str) else json.dumps(arguments),
                )
            )
        return output

    async def get_response(self, system_instructions, input, *args, **kwargs):
        return ModelResponse(output=self._next(input), usage=Usage(), response_id=None)

    async def stream_response(self, system_instructions, input, *args, **kwargs):
        response = Response(
            id="resp",
            created_at=0,
            model="scripted",
            object="response",
            output=self._next(input),
            tool_choice="none",
            tools=[],
            parallel_tool_calls=False,
            status="completed",
        )
        yield ResponseCompletedEvent(type="response.completed", response=response, sequence_number=0)

    def results(self):
        return [str(self.tool_results[key]) for key in sorted(self.tool_results, key=lambda k: int(k.split("_")[1]))]


ran = []


def refund_order(order_id: str, amount_cents: int) -> str:
    """Refund an order."""
    ran.append((order_id, amount_cents))
    return f"refunded {order_id}"


@pytest.fixture(autouse=True)
def _reset():
    ran.clear()
    module._held_requests.clear()


def governed(guardian, tool=refund_order, **options):
    return guardian_tool(tool, AsyncFake(guardian), connection_id=CONNECTION, **options)


async def run(turns, *tools, streamed=False):
    model = ScriptedModel(turns)
    agent = Agent(name="Billing", model=model, tools=list(tools))
    if streamed:
        result = Runner.run_streamed(agent, "refund order 42")
        async for _ in result.stream_events():
            pass
    else:
        result = await Runner.run(agent, "refund order 42")
    return model, result


CALL = ("refund_order", {"order_id": "o42", "amount_cents": 500})
both = pytest.mark.parametrize("streamed", [False, True], ids=["run", "run_streamed"])


def test_the_governed_tool_keeps_the_tools_name_description_and_schema():
    plain = function_tool(refund_order, strict_mode=False)
    tool = governed(FakeClient(ALLOW), plain)
    assert isinstance(tool, FunctionTool) and tool is not plain
    assert (tool.name, tool.description) == (plain.name, plain.description)
    assert tool.params_json_schema == plain.params_json_schema
    assert tool.strict_json_schema is False
    from_function = governed(FakeClient(ALLOW), name_override="refund", description_override="Refunds.")
    assert (from_function.name, from_function.description) == ("refund", "Refunds.")
    assert from_function.strict_json_schema is True


@both
async def test_allow_runs_the_tool_once_then_records_it(streamed):
    guardian = FakeClient(ALLOW)
    receipts = []
    tool = governed(guardian, on_receipt=lambda t, r, rc: receipts.append((t, r)))
    model, result = await run([CALL], tool, streamed=streamed)
    assert ran == [("o42", 500)]
    assert model.results() == ["refunded o42"]
    assert result.final_output == "done"
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    assert guardian.last_invocation["tool_name"] == "refund_order"
    assert guardian.last_invocation["arguments"] == {"order_id": "o42", "amount_cents": 500}
    assert receipts == [("refund_order", "req_allow")]


def test_run_sync_allow():
    guardian = FakeClient(ALLOW)
    model = ScriptedModel([CALL])
    result = Runner.run_sync(Agent(name="Billing", model=model, tools=[governed(guardian)]), "refund order 42")
    assert result.final_output == "done"
    assert ran == [("o42", 500)]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]


async def test_the_tool_receives_the_arguments_guardian_decided_on():
    seen = []

    class Recording(FakeClient):
        def request(self, invocation):
            seen.append(json.dumps(invocation["arguments"], sort_keys=True))
            invocation["arguments"]["amount_cents"] = 1  # changing the proposal changes nothing the tool gets
            return super().request(invocation)

    received = []
    plain = function_tool(refund_order)
    original = plain.on_invoke_tool

    async def spy(context, text):
        received.append(text)
        return await original(context, text)

    plain.on_invoke_tool = spy
    text = '{"order_id": "o42", "amount_cents": 500}'
    await run([("refund_order", text)], governed(Recording(ALLOW), plain))
    assert seen == ['{"amount_cents": 500, "order_id": "o42"}']
    assert received == [text]
    assert ran == [("o42", 500)]


@pytest.mark.parametrize(
    "text",
    [
        '{"order_id": "o42", "amount_cents": 1, "amount_cents": 500}',
        "[1]",
        "{not json",
        '{"amount_cents": NaN, "order_id": "o"}',
    ],
    ids=["repeated-key", "not-an-object", "not-json", "nan"],
)
async def test_arguments_guardian_cannot_read_are_not_proposed_and_do_not_run(text):
    guardian = FakeClient(ALLOW)
    model, _ = await run([("refund_order", text)], governed(guardian))
    assert ran == [] and guardian.calls == []
    assert "was not proposed and did not run" in model.results()[0]


@both
async def test_held_raises_the_pending_approval_and_resume_runs_the_tool_once(streamed):
    guardian = FakeClient(HELD, claims=[APPROVED])
    pending_seen = []
    tool = governed(guardian, on_approval_pending=lambda t, r: pending_seen.append((t, r)))
    with pytest.raises(Exception) as raised:
        await run([CALL], tool, streamed=streamed)
    pending = find_approval_pending(raised.value)
    assert isinstance(pending, GuardianApprovalPending)
    assert pending.request_id == "req_ask" and pending.arguments == {"order_id": "o42", "amount_cents": 500}
    assert pending_seen == [("refund_order", "req_ask")]
    assert ran == [] and guardian.calls == ["request:tool.invoke"]
    resumed = await pending.resume()
    assert resumed.output == "refunded o42" and resumed.request_id == "req_ask"
    assert ran == [("o42", 500)]
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask", "execute:req_ask"]


async def test_resume_before_approval_is_still_pending_and_after_a_denial_never_runs():
    guardian = FakeClient(HELD, claims=[HELD, DECLINED])
    with pytest.raises(Exception) as raised:
        await run([CALL], governed(guardian))
    pending = find_approval_pending(raised.value)
    with pytest.raises(GuardianApprovalPending) as again:
        await pending.resume()
    assert ran == []
    with pytest.raises(GuardianDenied) as denied:
        await again.value.resume()
    assert denied.value.reason_code == "APPROVAL_DENIED"
    assert ran == [] and "execute:req_ask" not in guardian.calls


@both
async def test_on_ask_result_tells_the_model_and_the_same_call_claims_the_approval(streamed):
    guardian = FakeClient(HELD, claims=[APPROVED])
    pending_seen = []
    tool = governed(guardian, on_ask="result", on_approval_pending=lambda t, r: pending_seen.append(r))
    model, _ = await run([CALL, CALL], tool, streamed=streamed)
    assert pending_seen == ["req_ask"]
    assert "held for human approval (request_id req_ask)" in model.results()[0]
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask", "execute:req_ask"]
    assert ran == [("o42", 500)]
    assert model.results()[1] == "refunded o42"


async def test_on_ask_result_not_yet_approved_does_not_run_or_ask_twice():
    guardian = FakeClient(HELD)
    model, _ = await run([CALL, CALL], governed(guardian, on_ask="result"))
    assert ran == []
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask"]
    assert all("held for human approval" in text for text in model.results())


async def test_on_ask_result_then_declined_never_runs():
    guardian = FakeClient(HELD, claims=[DECLINED])
    model, _ = await run([CALL, CALL], governed(guardian, on_ask="result"))
    assert ran == []
    assert "Guardian denied refund_order (APPROVAL_DENIED)" in model.results()[1]
    assert "execute:req_ask" not in guardian.calls


@both
async def test_denied_never_runs_and_the_model_is_told(streamed):
    guardian = FakeClient(DENIED)
    model, result = await run([CALL], governed(guardian), streamed=streamed)
    assert ran == []
    assert model.results() == ["Guardian denied refund_order (POLICY_DENY). Do not retry the same call."]
    assert result.final_output == "done"
    assert guardian.calls == ["request:tool.invoke"]


async def test_on_deny_raise_goes_to_the_tools_failure_policy():
    # The default policy still tells the model, and never "try again".
    model, _ = await run([CALL], governed(FakeClient(DENIED), on_deny="raise"))
    assert model.results() == [
        "Guardian denied refund_order (POLICY_DENY). It did not run (request_id req_d). Do not retry the same call."
    ]
    # failure_error_function=None: the run fails with the denial.
    with pytest.raises(Exception) as raised:
        await run([CALL], governed(FakeClient(DENIED), on_deny="raise", failure_error_function=None))
    denied = module._find(raised.value, GuardianDenied)
    assert denied is not None and denied.reason_code == "POLICY_DENY"
    # A custom one gets the denial.
    got = []

    def custom(context, error):
        got.append(error)
        return "custom"

    model, _ = await run([CALL], governed(FakeClient(DENIED), on_deny="raise", failure_error_function=custom))
    assert model.results() == ["custom"] and isinstance(got[0], GuardianDenied)
    assert ran == []


@both
async def test_unreachable_guardian_fails_closed(streamed):
    guardian = FakeClient(UNREACHABLE)
    model, _ = await run([CALL], governed(guardian, on_deny="raise"), streamed=streamed)
    assert ran == []
    assert "could not be reached" in model.results()[0] and "Try again later" in model.results()[0]


async def test_a_guardian_client_that_raises_fails_closed():
    class Broken(FakeClient):
        def request(self, invocation):
            raise RuntimeError("boom")

    model, _ = await run([CALL], governed(Broken(ALLOW)))
    assert ran == []
    assert model.results() == ["Guardian could not check refund_order, so it did not run. Try again later."]


async def test_refused_redemption_after_the_tool_ran_is_never_try_again():
    guardian = FakeClient(ALLOW, execute_ok=False)
    incidents = []
    model, _ = await run([CALL], governed(guardian, on_execution_error=incidents.append))
    assert ran == [("o42", 500)]
    assert "ran, but Guardian could not record it" in model.results()[0]
    assert "Do not call it again" in model.results()[0]
    assert isinstance(incidents[0], GuardianExecutionFailed) and incidents[0].local_effect_ran


async def test_a_lost_redemption_answer_is_settled_by_guardians_record():
    from odingard_guardian import ReceiptsResult

    class LostAnswer(AsyncFake):
        async def execute(self, *, request_id, capability_token):
            self.sync.calls.append(f"execute:{request_id}")
            return ExecuteResult(ok=False, reason_code="SERVICE_UNAVAILABLE")

        async def receipts(self, request_id):
            self.sync.calls.append(f"receipts:{request_id}")
            return ReceiptsResult(ok=True, receipts=[{"state": "verified", "attemptId": "att_1"}])

    guardian = FakeClient(ALLOW)
    tool = guardian_tool(refund_order, LostAnswer(guardian), connection_id=CONNECTION)
    model, _ = await run([CALL], tool)
    assert model.results() == ["refunded o42"]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow", "receipts:req_allow"]


async def test_guardian_decides_on_the_json_the_model_sent_before_the_tools_own_validation():
    # The Agents SDK converts "500" to the int parameter afterwards; Guardian
    # decided on, and recorded, what the model sent.
    guardian = FakeClient(ALLOW)
    lax = function_tool(refund_order, strict_mode=False)
    await run([("refund_order", {"order_id": "o42", "amount_cents": "500"})], governed(guardian, lax))
    assert guardian.last_invocation["arguments"] == {"order_id": "o42", "amount_cents": "500"}
    assert ran == [("o42", 500)]


async def test_a_tool_that_raises_is_not_redeemed_and_keeps_its_failure_policy():
    def broken(order_id: str) -> str:
        """Always fails."""
        ran.append(order_id)
        raise RuntimeError("card declined")

    guardian = FakeClient(ALLOW)
    model, _ = await run([("broken", {"order_id": "o1"})], governed(guardian, broken))
    assert ran == ["o1"]
    assert guardian.calls == ["request:tool.invoke"]  # nothing redeemed for a call that failed
    assert model.results() == ["An error occurred while running the tool."]

    custom = governed(FakeClient(ALLOW), broken, failure_error_function=lambda context, error: f"failed: {error}")
    model, _ = await run([("broken", {"order_id": "o1"})], custom)
    assert model.results() == ["failed: card declined"]

    with pytest.raises(Exception) as raised:
        await run([("broken", {"order_id": "o1"})], governed(FakeClient(ALLOW), broken, failure_error_function=None))
    assert "card declined" in str(raised.value)


async def test_parallel_calls_are_each_decided_on_their_own():
    class ByAmount(FakeClient):
        def request(self, invocation):
            self.calls.append(f"request:{invocation['arguments']['order_id']}")
            return DENIED if invocation["arguments"]["amount_cents"] > 1000 else ALLOW

    guardian = ByAmount(ALLOW)
    calls = [
        ("refund_order", {"order_id": "small", "amount_cents": 500}),
        ("refund_order", {"order_id": "large", "amount_cents": 5000}),
    ]
    model, _ = await run([calls], governed(guardian))
    assert ran == [("small", 500)]
    assert model.results() == [
        "refunded small",
        "Guardian denied refund_order (POLICY_DENY). Do not retry the same call.",
    ]


async def test_tool_names_maps_the_guardian_tool_name():
    guardian = FakeClient(ALLOW)
    await run([CALL], governed(guardian, tool_names={"refund_order": "billing.refund"}))
    assert guardian.last_invocation["tool_name"] == "billing.refund"


# --- remote mode ---


@both
async def test_remote_mode_guardian_performs_the_call_and_the_local_tool_never_runs(streamed):
    guardian = FakeClient(ALLOW)
    model, _ = await run([CALL], governed(guardian, mode="remote"), streamed=streamed)
    assert ran == []
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    record = json.loads(model.results()[0])["guardian"]
    assert record["decision"] == "ALLOW" and record["receipt"]["status"] == "sent-verified"


async def test_remote_mode_held_denied_and_unverified():
    for answer in (DENIED, UNREACHABLE):
        guardian = FakeClient(answer)
        await run([CALL], governed(guardian, mode="remote"))
        assert guardian.calls == ["request:tool.invoke"]
    guardian = FakeClient(HELD, claims=[APPROVED])
    with pytest.raises(Exception) as raised:
        await run([CALL], governed(guardian, mode="remote"))
    resumed = await find_approval_pending(raised.value).resume()
    assert resumed.output["guardian"]["receipt"]["status"] == "sent-verified"
    guardian = FakeClient(ALLOW, receipt_status="outcome-pending")
    model, _ = await run([CALL], governed(guardian, mode="remote"))
    assert "Guardian could not confirm that refund_order completed" in model.results()[0]
    assert "It may have run. Do not call it again" in model.results()[0]
    assert ran == []


async def test_modes_sets_the_mode_per_tool():
    def lookup_order(order_id: str) -> str:
        """Look an order up."""
        ran.append(order_id)
        return "found"

    guardian = FakeClient(ALLOW)
    make = create_guardian_tool(AsyncFake(guardian), connection_id=CONNECTION, modes={"refund_order": "remote"})
    await run([CALL, ("lookup_order", {"order_id": "o1"})], make(refund_order), make(lookup_order))
    assert ran == ["o1"]


# --- on_ask="interrupt": the Agents SDK's own approval interruption ---


async def resume(model, result, *tools, approve=True, streamed=False):
    state = result.to_state()
    for item in result.interruptions:
        state.approve(item) if approve else state.reject(item)
    agent = result.last_agent
    if streamed:
        resumed = Runner.run_streamed(agent, state)
        async for _ in resumed.stream_events():
            pass
        return resumed
    return await Runner.run(agent, state)


@both
async def test_interrupt_pauses_the_run_and_runs_after_guardians_approval(streamed):
    guardian = FakeClient(HELD, claims=[APPROVED])
    pending_seen = []
    tool = governed(guardian, on_ask="interrupt", on_approval_pending=lambda t, r: pending_seen.append(r))
    model, result = await run([CALL], tool, streamed=streamed)
    assert len(result.interruptions) == 1 and result.final_output is None
    assert guardian_request_id(result.interruptions[0]) == "req_ask"
    assert pending_seen == ["req_ask"]
    assert ran == [] and guardian.calls == ["request:tool.invoke"]
    # A person approved in Guardian; the app approves the interruption and resumes.
    resumed = await resume(model, result, streamed=streamed)
    assert resumed.final_output == "done"
    assert ran == [("o42", 500)]
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask", "execute:req_ask"]
    assert model.results() == ["refunded o42"]


async def test_a_local_approve_does_not_stand_in_for_guardians_approval():
    guardian = FakeClient(HELD)  # nobody has approved in Guardian
    model, result = await run([CALL], governed(guardian, on_ask="interrupt"))
    resumed = await resume(model, result)
    assert ran == []
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask"]
    assert "held for human approval (request_id req_ask)" in model.results()[0]
    assert resumed.final_output == "done"


async def test_interrupt_then_declined_in_guardian_never_runs():
    guardian = FakeClient(HELD, claims=[DECLINED])
    model, result = await run([CALL], governed(guardian, on_ask="interrupt"))
    await resume(model, result)
    assert ran == [] and "execute:req_ask" not in guardian.calls
    assert "Guardian denied refund_order (APPROVAL_DENIED)" in model.results()[0]


async def test_interrupt_rejected_locally_never_runs_or_claims():
    guardian = FakeClient(HELD, claims=[APPROVED])
    model, result = await run([CALL], governed(guardian, on_ask="interrupt"))
    await resume(model, result, approve=False)
    assert ran == [] and guardian.calls == ["request:tool.invoke"]


@both
async def test_interrupt_mode_allow_and_deny_do_not_pause_and_ask_guardian_once(streamed):
    guardian = FakeClient(ALLOW)
    model, result = await run([CALL], governed(guardian, on_ask="interrupt"), streamed=streamed)
    assert result.interruptions == [] and result.final_output == "done"
    assert ran == [("o42", 500)]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    ran.clear()
    guardian = FakeClient(DENIED)
    model, result = await run([CALL], governed(guardian, on_ask="interrupt"), streamed=streamed)
    assert result.interruptions == [] and ran == []
    assert guardian.calls == ["request:tool.invoke"]
    assert "Guardian denied refund_order (POLICY_DENY)" in model.results()[0]


async def test_interrupt_only_the_held_call_waits_the_others_in_the_turn_run():
    class ByAmount(FakeClient):
        def request(self, invocation):
            self.calls.append(f"request:{invocation['arguments']['order_id']}")
            return HELD if invocation["arguments"]["amount_cents"] > 1000 else ALLOW

    guardian = ByAmount(ALLOW, claims=[APPROVED])
    calls = [
        ("refund_order", {"order_id": "small", "amount_cents": 500}),
        ("refund_order", {"order_id": "large", "amount_cents": 5000}),
    ]
    model, result = await run([calls], governed(guardian, on_ask="interrupt"))
    assert len(result.interruptions) == 1 and ran == [("small", 500)]
    assert guardian.calls == ["request:small", "request:large", "execute:req_allow"]
    await resume(model, result)
    assert ran == [("small", 500), ("large", 5000)]
    assert guardian.calls[3:] == ["claim:req_ask", "execute:req_ask"]


async def test_interrupt_resumed_by_a_tool_that_does_not_know_the_held_request_does_not_run():
    # A serialized RunState resumed in another process: the held request is
    # not known there, so Guardian is asked again and nothing runs unapproved.
    from agents import RunState

    guardian = FakeClient(HELD)
    model, result = await run([CALL], governed(guardian, on_ask="interrupt"))
    text = result.to_state().to_string()
    agent = Agent(name="Billing", model=model, tools=[governed(guardian, on_ask="interrupt")])
    state = await RunState.from_string(agent, text)
    for item in state.get_interruptions():
        state.approve(item)
    await Runner.run(agent, state)
    assert ran == []
    assert guardian.calls == ["request:tool.invoke", "request:tool.invoke"]
    assert "held for human approval" in model.results()[0]


async def test_interrupt_mode_remote_executes_only_when_the_sdk_invokes_the_call():
    guardian = FakeClient(ALLOW)
    tool = governed(guardian, on_ask="interrupt", mode="remote")
    assert await tool.needs_approval(None, {"order_id": "o42", "amount_cents": 500}, "call_x") is False
    await asyncio.sleep(0)
    assert guardian.calls == ["request:tool.invoke"]  # allowed, waiting for the invocation
    model, _ = await run([CALL], governed(guardian, on_ask="interrupt", mode="remote"))
    assert "execute:req_allow" in guardian.calls and ran == []


async def test_interrupt_mode_an_allowed_call_the_sdk_never_invokes_is_dropped(monkeypatch):
    monkeypatch.setattr(module, "PARKED_SECONDS", 0.01)
    guardian = FakeClient(ALLOW)
    tool = governed(guardian, on_ask="interrupt")
    assert await tool.needs_approval(None, {"order_id": "o42", "amount_cents": 500}, "call_x") is False
    await asyncio.sleep(0.05)
    assert ran == [] and guardian.calls == ["request:tool.invoke"]


async def test_interrupt_mode_the_tools_own_needs_approval_comes_first():
    guardian = FakeClient(ALLOW)
    plain = function_tool(refund_order, needs_approval=True)
    model, result = await run([CALL], governed(guardian, plain, on_ask="interrupt"))
    assert len(result.interruptions) == 1 and guardian.calls == []
    assert guardian_request_id(result.interruptions[0]) is None
    await resume(model, result)
    assert ran == [("o42", 500)]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]


async def test_the_tools_own_needs_approval_is_kept_and_never_replaces_guardian():
    guardian = FakeClient(DENIED)
    plain = function_tool(refund_order, needs_approval=True)
    model, result = await run([CALL], governed(guardian, plain))
    assert len(result.interruptions) == 1 and guardian.calls == []
    await resume(model, result)
    assert ran == [] and guardian.calls == ["request:tool.invoke"]


# --- cancellation and the SDK's own tool timeout ---


async def test_a_call_the_sdk_times_out_while_guardian_decides_never_runs():
    release = asyncio.Event()

    class Slow(AsyncFake):
        async def request(self, invocation):
            self.sync.calls.append("request")
            await release.wait()
            return ALLOW

    async def slow_refund(order_id: str) -> str:
        """Refund."""
        ran.append(order_id)
        return "refunded"

    guardian = FakeClient(ALLOW)
    tool = guardian_tool(slow_refund, Slow(guardian), connection_id=CONNECTION, timeout=0.05)
    model, _ = await run([("slow_refund", {"order_id": "o1"})], tool)
    assert "timed out" in model.results()[0]
    release.set()
    await asyncio.sleep(0.05)
    assert ran == [] and guardian.calls == ["request"]


async def test_a_tool_that_ran_is_recorded_even_when_the_sdk_stops_waiting():
    release = asyncio.Event()

    class SlowExecute(AsyncFake):
        async def execute(self, *, request_id, capability_token):
            await release.wait()
            return self.sync.execute(request_id=request_id, capability_token=capability_token)

    async def quick_refund(order_id: str) -> str:
        """Refund."""
        ran.append(order_id)
        return "refunded"

    guardian = FakeClient(ALLOW)
    tool = guardian_tool(quick_refund, SlowExecute(guardian), connection_id=CONNECTION, timeout=0.05)
    model, _ = await run([("quick_refund", {"order_id": "o1"})], tool)
    assert "timed out" in model.results()[0] and ran == ["o1"]
    release.set()
    await asyncio.sleep(0.05)
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]


async def test_remote_mode_a_call_guardian_was_asked_to_perform_is_not_abandoned():
    release = asyncio.Event()

    class SlowExecute(AsyncFake):
        async def execute(self, *, request_id, capability_token):
            self.sync.calls.append("execute:sent")
            await release.wait()
            return self.sync.execute(request_id=request_id, capability_token=capability_token)

    async def remote_refund(order_id: str) -> str:
        """Refund."""
        raise AssertionError("remote mode never runs local code")

    guardian = FakeClient(ALLOW)
    receipts = []
    tool = guardian_tool(
        remote_refund,
        SlowExecute(guardian),
        connection_id=CONNECTION,
        mode="remote",
        timeout=0.05,
        on_receipt=lambda t, r, rc: receipts.append(r),
    )
    model, _ = await run([("remote_refund", {"order_id": "o1"})], tool)
    assert "timed out" in model.results()[0]
    release.set()
    await asyncio.sleep(0.05)
    assert guardian.calls == ["request:tool.invoke", "execute:sent", "execute:req_allow"]
    assert receipts == ["req_allow"]


# --- tools with an output schema cannot return a plain message ---


async def test_a_tool_with_an_output_schema_raises_its_refusals():
    from pydantic import BaseModel

    class Refund(BaseModel):
        order_id: str

    def typed_refund(order_id: str) -> Refund:
        """Refund."""
        ran.append(order_id)
        return Refund(order_id=order_id)

    typed = function_tool(typed_refund, output_type=Refund)
    call = ("typed_refund", {"order_id": "o1"})
    model, _ = await run([call], governed(FakeClient(ALLOW), typed))
    assert json.loads(model.results()[0]) == {"order_id": "o1"} and ran == ["o1"]
    ran.clear()
    for answer, kind in ((DENIED, GuardianDenied), (UNREACHABLE, GuardianDenied), (HELD, GuardianApprovalPending)):
        with pytest.raises(Exception) as raised:
            await run([call], governed(FakeClient(answer), typed))
        assert module._find(raised.value, kind) is not None
    assert ran == []
    with pytest.raises(ValueError, match="output schema"):
        governed(FakeClient(ALLOW), typed, on_ask="result")


# --- configuration ---


def test_configuration_errors_are_raised_when_the_tool_is_built():
    from odingard_guardian import GuardianClient

    with pytest.raises(TypeError, match="AsyncGuardianClient"):
        guardian_tool(refund_order, GuardianClient(credential="gak_test"), connection_id=CONNECTION)
    with pytest.raises(ValueError, match="on_ask"):
        governed(FakeClient(ALLOW), on_ask="approve")
    with pytest.raises(ValueError, match="mode"):
        governed(FakeClient(ALLOW), mode="local")
    with pytest.raises(TypeError, match="already a Guardian tool"):
        governed(FakeClient(ALLOW), governed(FakeClient(ALLOW)))
    with pytest.raises(TypeError, match="apply to a function"):
        governed(FakeClient(ALLOW), function_tool(refund_order), name_override="x")


def test_a_generator_tool_is_refused_when_the_tool_is_built():
    # The Agents SDK hands the model the generator object and never runs the
    # body, so Guardian would record a call that did not happen.
    def stream_refunds(order_id: str):
        """Refund in steps."""
        ran.append(order_id)
        yield "refunded"

    async def astream_refunds(order_id: str):
        """Refund in steps."""
        ran.append(order_id)
        yield "refunded"

    class Streaming:
        def __call__(self, order_id: str):
            """Refund in steps."""
            yield "refunded"

    for tool in (stream_refunds, astream_refunds, function_tool(stream_refunds)):
        with pytest.raises(TypeError, match="generator function"):
            governed(FakeClient(ALLOW), tool)
    with pytest.raises(TypeError, match="generator function"):
        governed(FakeClient(ALLOW), Streaming(), name_override="streaming")


async def test_remote_mode_an_error_after_guardian_performed_the_call_is_never_did_not_run():
    def failing_hook(tool, request_id, receipt):
        raise RuntimeError("hook failed")

    guardian = FakeClient(ALLOW)
    model, _ = await run([CALL], governed(guardian, mode="remote", on_receipt=failing_hook, on_deny="raise"))
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    assert "Guardian may have performed it" in model.results()[0]
    assert "Do not call it again" in model.results()[0] and "did not run" not in model.results()[0]


async def test_a_sync_tool_that_finishes_after_the_run_was_cancelled_is_still_recorded():
    # A sync tool runs in a worker thread, which a cancelled run cannot stop:
    # the action completes, so its capability must still be redeemed.
    import threading

    started, release = threading.Event(), threading.Event()

    def slow_payment(order_id: str) -> str:
        """Pay."""
        started.set()
        release.wait(5)
        ran.append(order_id)
        return "paid"

    guardian = FakeClient(ALLOW)
    receipts = []
    tool = governed(guardian, slow_payment, on_receipt=lambda t, r, rc: receipts.append(r))
    running = asyncio.ensure_future(run([("slow_payment", {"order_id": "o1"})], tool))
    while not started.is_set():
        await asyncio.sleep(0.01)
    running.cancel()
    with pytest.raises(asyncio.CancelledError):
        await running
    assert ran == [] and guardian.calls == ["request:tool.invoke"]
    release.set()
    for _ in range(100):
        if receipts:
            break
        await asyncio.sleep(0.01)
    assert ran == ["o1"]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    assert receipts == ["req_allow"]


async def test_an_async_tool_that_started_is_not_stopped_by_the_sdk_timeout_and_is_recorded():
    release = asyncio.Event()

    async def slow_refund(order_id: str) -> str:
        """Refund."""
        await release.wait()
        ran.append(order_id)
        return "refunded"

    guardian = FakeClient(ALLOW)
    model, _ = await run([("slow_refund", {"order_id": "o1"})], governed(guardian, slow_refund, timeout=0.05))
    assert "timed out" in model.results()[0] and ran == []
    release.set()
    await asyncio.sleep(0.05)
    assert ran == ["o1"]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]


def test_remote_mode_on_a_tool_with_an_output_schema_is_refused_when_the_tool_is_built():
    # Guardian's record cannot satisfy the tool's output type: the SDK would
    # fail the run after Guardian performed the call.
    from pydantic import BaseModel

    class Refund(BaseModel):
        order_id: str

    def typed_refund(order_id: str) -> Refund:
        """Refund."""
        return Refund(order_id=order_id)

    with pytest.raises(ValueError, match="remote"):
        governed(FakeClient(ALLOW), typed_refund, output_type=Refund, mode="remote")
    with pytest.raises(ValueError, match="remote"):
        governed(FakeClient(ALLOW), function_tool(typed_refund, output_type=Refund), modes={"typed_refund": "remote"})
    with pytest.raises(ValueError, match="remote"):
        governed(
            FakeClient(ALLOW),
            typed_refund,
            output_type=Refund,
            tool_names={"typed_refund": "billing.refund"},
            modes={"billing.refund": "remote"},
        )
    governed(FakeClient(ALLOW), typed_refund, output_type=Refund, modes={"other": "remote"})  # in-process: fine


def refund_with_default(order_id: str, amount_cents: int = 100_000) -> str:
    """Refund an order; the whole order by default."""
    ran.append((order_id, amount_cents))
    return "refunded"


async def large_refunds_need_approval(context, params, call_id) -> bool:
    return params.get("amount_cents", 0) > 1000


@pytest.mark.parametrize("on_ask", ["raise", "result", "interrupt"])
@pytest.mark.parametrize("arguments", [{"order_id": "o1"}, {"order_id": "o1", "amount_cents": "5000"}])
async def test_a_callable_needs_approval_policy_keeps_the_sdks_checks_for_defaults_and_conversions(on_ask, arguments):
    # The Agents SDK requires manual approval when the tool's validation
    # would default or convert an argument the policy did not see. The
    # governed tool must not be weaker than the tool it wraps.
    def plain():
        return function_tool(refund_with_default, strict_mode=False, needs_approval=large_refunds_need_approval)

    _, unwrapped = await run([("refund_with_default", arguments)], plain())
    assert len(unwrapped.interruptions) == 1 and ran == []
    guardian = FakeClient(ALLOW)
    _, result = await run([("refund_with_default", arguments)], governed(guardian, plain(), on_ask=on_ask))
    assert len(result.interruptions) == 1
    assert ran == [] and guardian.calls == []


@pytest.mark.parametrize("on_ask", ["raise", "interrupt"])
async def test_a_callable_needs_approval_policy_still_decides_unchanged_arguments(on_ask):
    def plain():
        return function_tool(refund_with_default, strict_mode=False, needs_approval=large_refunds_need_approval)

    guardian = FakeClient(ALLOW)
    small = ("refund_with_default", {"order_id": "o1", "amount_cents": 500})
    _, result = await run([small], governed(guardian, plain(), on_ask=on_ask))
    assert result.interruptions == [] and ran == [("o1", 500)]
    large = ("refund_with_default", {"order_id": "o1", "amount_cents": 5000})
    _, result = await run([large], governed(guardian, plain(), on_ask=on_ask))
    assert len(result.interruptions) == 1 and ran == [("o1", 500)]


def test_the_factory_is_a_decorator_like_function_tool():
    make = create_guardian_tool(AsyncFake(FakeClient(ALLOW)), connection_id=CONNECTION)

    @make
    def one(x: int) -> str:
        """One."""
        return "1"

    @make(name_override="second")
    def two(x: int) -> str:
        """Two."""
        return "2"

    assert isinstance(one, FunctionTool) and one.name == "one"
    assert isinstance(two, FunctionTool) and two.name == "second"
