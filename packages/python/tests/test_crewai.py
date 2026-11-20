"""crewAI: Guardian's governed tools in a real crew.

A scripted LLM stands in for the model and a fake client for Guardian; the
agent, the task, the crew and both tool-calling loops (native function
calling and the text/ReAct path) are crewAI's own.
"""

import json
import os
import threading
import time
import types
import warnings
from typing import List

import pytest

os.environ.setdefault("CREWAI_DISABLE_TELEMETRY", "true")
os.environ.setdefault("CREWAI_TRACING_ENABLED", "false")
os.environ.setdefault("OTEL_SDK_DISABLED", "true")

crewai = pytest.importorskip("crewai")

from crewai import Agent, Crew, Task  # noqa: E402
from pydantic import TypeAdapter  # noqa: E402
from crewai.hooks import (  # noqa: E402
    register_before_tool_call_hook,
    unregister_before_tool_call_hook,
)
from crewai.llms.base_llm import BaseLLM  # noqa: E402
from crewai.tools import BaseTool, tool  # noqa: E402
from crewai.tools.tool_failure import ToolExecutionFailedError, ToolFailure  # noqa: E402

from odingard_guardian import ExecuteResult, RequestResult  # noqa: E402
from odingard_guardian.crewai import GuardianTool, guardian_tool, guardian_tools  # noqa: E402

from test_guard import ALLOW, CONNECTION, HELD, AsyncFake, FakeClient  # noqa: E402

DENIED = RequestResult(ok=True, request_id="req_d", decision="DENY", reason_code="POLICY_DENY")
UNREACHABLE = RequestResult(ok=False, reason_code="SERVICE_UNAVAILABLE")
APPROVED = RequestResult(ok=True, request_id="req_ask", decision="ALLOW", capability_token="cap")
DECLINED = RequestResult(ok=False, request_id="req_ask", reason_code="APPROVAL_DENIED")

NATIVE, REACT = "native", "react"
BOTH = pytest.mark.parametrize("path", [NATIVE, REACT])

# crewAI warns about its own deprecated fields while it builds a crew.
pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")


class ScriptedLLM(BaseLLM):
    """Asks for the scripted tool calls one turn at a time, then answers "done".

    ``native=True`` answers with tool calls (crewAI's native function-calling
    loop); ``native=False`` answers with ``Action:`` text (the ReAct loop).
    """

    def __init__(self, calls, native):
        super().__init__(model="scripted")
        self._calls = list(calls)
        self._native = native
        self.messages = []

    def supports_function_calling(self):
        return self._native

    def call(self, messages, tools=None, callbacks=None, available_functions=None, **kwargs):
        self.messages = [dict(m) for m in messages]
        if self._calls:
            turn = self._calls.pop(0)
            if isinstance(turn, list):  # several native tool calls in one model turn
                return [
                    {"id": f"call_{i}", "type": "function", "function": {"name": n, "arguments": json.dumps(a)}}
                    for i, (n, a) in enumerate(turn)
                ]
            name, args = turn
            if self._native:
                call = {"name": name, "arguments": json.dumps(args)}
                return [{"id": f"call_{len(self._calls)}", "type": "function", "function": call}]
            return f"Thought: I should use the tool.\nAction: {name}\nAction Input: {json.dumps(args)}"
        return "done" if self._native else "Thought: I now know the final answer\nFinal Answer: done"

    def results(self):
        """The tool results the model was shown, in order."""
        if self._native:
            return [str(m["content"]) for m in self.messages if m.get("role") == "tool"]
        return [
            str(m["content"]).split("Observation: ", 1)[1]
            for m in self.messages
            if m.get("role") == "assistant" and "Observation: " in str(m.get("content"))
        ]


ran = []


@tool("refund_order")
def refund_order(order_id: str, amount_cents: int) -> str:
    """Refund an order."""
    ran.append((order_id, amount_cents))
    return f"refunded {order_id}"


@tool("lookup_order")
def lookup_order(order_id: str) -> str:
    """Look an order up."""
    return f"order {order_id}"


@pytest.fixture(autouse=True)
def _reset():
    ran.clear()
    refund_order.current_usage_count = 0
    refund_order.max_usage_count = None


def governed(guardian, tools=(refund_order,), **options):
    return guardian_tools(list(tools), guardian, connection_id=CONNECTION, **options)


def crew_for(calls, tools, path, **crew_options):
    llm = ScriptedLLM(calls, native=path == NATIVE)
    agent = Agent(role="billing", goal="refund orders", backstory="b", llm=llm, tools=list(tools))
    task = Task(description="refund order 42", expected_output="done", agent=agent)
    return llm, Crew(agents=[agent], tasks=[task], **crew_options)


def run(calls, tools, path=NATIVE, **crew_options):
    llm, crew = crew_for(calls, tools, path, **crew_options)
    return llm, crew.kickoff()


CALL = ("refund_order", {"order_id": "o42", "amount_cents": 500})
LOOKUP = ("lookup_order", {"order_id": "o42"})


@BOTH
def test_allow_runs_the_tool_once_then_records_it(path):
    guardian = FakeClient(ALLOW)
    receipts = []
    llm, output = run([CALL], governed(guardian, on_receipt=lambda t, r, rc: receipts.append((t, r))), path)
    assert ran == [("o42", 500)]
    assert llm.results() == ["refunded o42"]
    assert output.raw == "done"
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    assert guardian.last_invocation["tool_name"] == "refund_order"
    assert guardian.last_invocation["arguments"] == {"order_id": "o42", "amount_cents": 500}
    assert receipts == [("refund_order", "req_allow")]


@BOTH
def test_the_proposal_is_the_validated_arguments_the_tool_receives(path):
    guardian = FakeClient(ALLOW)
    run([("refund_order", {"order_id": "o42", "amount_cents": "500"})], governed(guardian), path)
    assert guardian.last_invocation["arguments"] == {"order_id": "o42", "amount_cents": 500}
    assert ran == [("o42", 500)]


def test_held_then_approved_runs_on_the_same_call():
    guardian = FakeClient(HELD, claims=[APPROVED])
    pending = []
    llm, _ = run([CALL, CALL], governed(guardian, on_approval_pending=lambda t, r: pending.append((t, r))))
    assert pending == [("refund_order", "req_ask")]
    assert "held for human approval (request_id req_ask)" in llm.results()[0]
    # The second call claims the approved request instead of proposing a new one.
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask", "execute:req_ask"]
    assert ran == [("o42", 500)]
    assert llm.results()[1] == "refunded o42"


def test_held_and_not_yet_approved_does_not_run_or_ask_twice():
    guardian = FakeClient(HELD)
    llm, _ = run([CALL, CALL], governed(guardian))
    assert ran == []
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask"]
    assert all("held for human approval" in text for text in llm.results())


def test_react_refuses_an_identical_call_in_a_row_so_the_retry_comes_later():
    # crewAI's text path answers a call identical to the previous one itself,
    # before it reaches the tool. The approved request is claimed by the same
    # call after another tool call, or in the next task or kickoff.
    guardian = FakeClient(HELD, claims=[APPROVED])
    tools = governed(guardian, tools=(refund_order, lookup_order))
    llm, _ = run([CALL, CALL], tools, REACT)
    assert ran == [] and guardian.calls == ["request:tool.invoke"]
    assert "held for human approval" in llm.results()[0]
    assert "I tried reusing the same input" in llm.results()[1]

    llm, _ = run([CALL], tools, REACT)  # the next kickoff, same wrapped tools
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask", "execute:req_ask"]
    assert ran == [("o42", 500)]
    assert llm.results() == ["refunded o42"]


def test_react_claims_after_another_tool_call_in_the_same_run():
    class PerTool(FakeClient):
        def request(self, invocation):
            self.calls.append(f"request:{invocation['tool_name']}")
            return ALLOW if invocation["tool_name"] == "lookup_order" else HELD

    guardian = PerTool(HELD, claims=[APPROVED])
    tools = governed(guardian, tools=(refund_order, lookup_order))
    llm, _ = run([CALL, LOOKUP, CALL], tools, REACT)
    assert guardian.calls == [
        "request:refund_order",
        "request:lookup_order",
        "execute:req_allow",
        "claim:req_ask",
        "execute:req_ask",
    ]
    assert ran == [("o42", 500)]
    assert llm.results()[-1].startswith("refunded o42")


@BOTH
def test_held_then_declined_never_runs(path):
    guardian = FakeClient(HELD, claims=[DECLINED])
    tools = governed(guardian)
    run([CALL], tools, path)
    llm, _ = run([CALL], tools, path)
    assert ran == []
    assert "Guardian denied refund_order (APPROVAL_DENIED)" in llm.results()[0]
    assert "execute:req_ask" not in guardian.calls


@BOTH
def test_denied_never_runs(path):
    guardian = FakeClient(DENIED)
    llm, _ = run([CALL], governed(guardian), path)
    assert ran == []
    assert llm.results()[0].startswith("Guardian denied refund_order (POLICY_DENY). Do not retry the same call.")
    assert guardian.calls == ["request:tool.invoke"]


@BOTH
def test_guardian_unreachable_fails_closed(path):
    guardian = FakeClient(UNREACHABLE)
    llm, _ = run([CALL], governed(guardian), path)
    assert ran == []
    assert "could not be reached to check refund_order" in llm.results()[0]


@BOTH
def test_a_guardian_client_that_raises_fails_closed(path):
    class Broken(FakeClient):
        def request(self, invocation):
            raise ConnectionError("network down")

    llm, _ = run([CALL], governed(Broken(ALLOW)), path)
    assert ran == []
    assert llm.results()[0].startswith("Guardian could not check refund_order, so it did not run. Try again later.")


def test_refusals_are_tool_failures_with_the_request_id():
    guardian = FakeClient(HELD)
    _, output = run([CALL], governed(guardian))
    (record,) = output.tasks_output[0].tool_failures
    assert record.tool_name == "refund_order"
    assert record.failure.code == "APPROVAL_REQUIRED" and record.failure.retryable
    assert record.failure.details["guardian"]["request_id"] == "req_ask"


@BOTH
def test_tool_failure_policy_raise_stops_the_run_on_a_refusal(path):
    guardian = FakeClient(DENIED)
    llm, crew = crew_for([CALL, CALL], governed(guardian), path, tool_failure_policy="raise")
    with pytest.raises(ToolExecutionFailedError) as stopped:
        crew.kickoff()
    assert stopped.value.record.failure.code == "POLICY_DENY"
    assert ran == [] and guardian.calls == ["request:tool.invoke"]  # the second call never came


def test_amount_args_carry_the_declaration_and_the_amount():
    guardian = FakeClient(ALLOW)
    declaration = {"argument": "amount_cents", "unit": "minor", "currency": "usd"}
    run([CALL], governed(guardian, amount_args={"refund_order": declaration}))
    assert guardian.last_invocation["amount_argument"] == declaration
    assert guardian.last_invocation["value_cents"] == 500


def test_tool_names_map_to_guardian_names():
    guardian = FakeClient(ALLOW)
    run([CALL], governed(guardian, tool_names={"refund_order": "billing.refund"}))
    assert guardian.last_invocation["tool_name"] == "billing.refund"


def test_the_default_guardian_name_is_the_name_the_model_calls():
    @tool("Refund Order")
    def spaced(order_id: str) -> str:
        """Refund an order."""
        return "ok"

    guardian = FakeClient(ALLOW)
    (wrapped,) = governed(guardian, tools=(spaced,))
    assert wrapped.name == "Refund Order" and wrapped.guardian_tool_name == "refund_order"
    assert governed(guardian, tools=(spaced,), tool_names={"Refund Order": "billing.refund"})[
        0
    ].guardian_tool_name == "billing.refund"


@BOTH
def test_a_before_hook_runs_before_the_decision_so_its_change_is_decided_on(path):
    def repair(context):
        context.tool_input["order_id"] = "o43"

    register_before_tool_call_hook(repair)
    try:
        guardian = FakeClient(ALLOW)
        run([CALL], governed(guardian), path)
    finally:
        unregister_before_tool_call_hook(repair)
    assert guardian.last_invocation["arguments"]["order_id"] == "o43"
    assert ran == [("o43", 500)]


@BOTH
def test_a_hook_that_raises_does_not_let_a_refused_call_run(path):
    # crewAI ignores a hook that raises (the call goes on). The decision is
    # made inside the tool, so the refusal still holds.
    def broken(context):
        raise RuntimeError("hook failed")

    register_before_tool_call_hook(broken)
    try:
        guardian = FakeClient(DENIED)
        run([CALL], governed(guardian), path)
    finally:
        unregister_before_tool_call_hook(broken)
    assert ran == [] and guardian.calls == ["request:tool.invoke"]


@BOTH
def test_a_failed_redemption_tells_the_model_not_to_call_again(path):
    guardian = FakeClient(ALLOW, execute_ok=False)
    errors = []
    llm, _ = run([CALL], governed(guardian, on_execution_error=errors.append), path)
    assert ran == [("o42", 500)]
    assert "could not record it" in llm.results()[0] and "Do not call it again" in llm.results()[0]
    assert errors and errors[0].local_effect_ran


def test_a_tool_that_raises_is_not_recorded():
    @tool("refund_order")
    def failing(order_id: str, amount_cents: int) -> str:
        """Refund an order."""
        ran.append("tried")
        raise RuntimeError("billing is down")

    guardian = FakeClient(ALLOW)
    llm, _ = run([CALL], governed(guardian, tools=(failing,)))
    assert ran == ["tried"]
    assert guardian.calls == ["request:tool.invoke"]  # nothing redeemed
    assert "billing is down" in llm.results()[0]


def test_react_retries_of_a_tool_that_raised_are_each_decided():
    # crewAI's text path calls a tool that raised again by itself. Every one
    # of those calls goes through Guardian again; none is redeemed.
    @tool("refund_order")
    def failing(order_id: str, amount_cents: int) -> str:
        """Refund an order."""
        ran.append("tried")
        raise RuntimeError("billing is down")

    guardian = FakeClient(ALLOW)
    run([CALL], governed(guardian, tools=(failing,)), REACT)
    assert len(ran) > 1
    assert guardian.calls == ["request:tool.invoke"] * len(ran)


def test_an_async_client_is_refused():
    with pytest.raises(TypeError, match="GuardianClient"):
        guardian_tool(refund_order, AsyncFake(FakeClient(ALLOW)), connection_id=CONNECTION)


def test_only_crewai_tools_are_wrapped_and_only_once():
    with warnings.catch_warnings():
        warnings.simplefilter("error")  # wrapping is silent
        (wrapped,) = governed(FakeClient(ALLOW))
    assert isinstance(wrapped, GuardianTool)
    with pytest.raises(TypeError, match="already"):
        governed(FakeClient(ALLOW), tools=(wrapped,))
    with pytest.raises(TypeError, match="BaseTool"):
        governed(FakeClient(ALLOW), tools=(lambda: None,))


# --- remote mode ---------------------------------------------------------------


@BOTH
def test_remote_mode_guardian_performs_the_call_and_the_tool_body_never_runs(path):
    guardian = FakeClient(ALLOW)
    llm, _ = run([CALL], governed(guardian, mode="remote"), path)
    assert ran == []
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    answer = json.loads(llm.results()[0])["guardian"]
    assert answer["decision"] == "ALLOW" and answer["request_id"] == "req_allow"
    assert answer["receipt"]["status"] == "sent-verified"


def test_remote_mode_per_tool():
    guardian = FakeClient(ALLOW)
    tools = governed(guardian, tools=(refund_order, lookup_order), modes={"refund_order": "remote"})
    llm, _ = run([CALL, LOOKUP], tools)
    assert ran == []
    assert json.loads(llm.results()[0])["guardian"]["receipt"]["requestId"] == "req_allow"
    assert llm.results()[1] == "order o42"  # in-process: the tool's own result


def test_remote_mode_refusals_do_not_reach_guardian_execute():
    for answer in (DENIED, HELD, UNREACHABLE):
        guardian = FakeClient(answer)
        run([CALL], governed(guardian, mode="remote"))
        assert ran == [] and guardian.calls == ["request:tool.invoke"]


def test_remote_mode_held_then_approved_is_performed_by_guardian():
    guardian = FakeClient(HELD, claims=[APPROVED])
    llm, _ = run([CALL, CALL], governed(guardian, mode="remote"))
    assert ran == []
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask", "execute:req_ask"]
    assert json.loads(llm.results()[1])["guardian"]["request_id"] == "req_ask"


def test_remote_mode_an_unverified_send_is_a_failure_not_a_result():
    guardian = FakeClient(ALLOW, receipt_status="outcome-pending")
    llm, output = run([CALL], governed(guardian, mode="remote"))
    assert ran == []
    assert "It may have run. Do not call it again" in llm.results()[0]
    assert output.tasks_output[0].tool_failures[0].failure.code == "EXECUTION_OUTCOME_PENDING"


@BOTH
def test_remote_mode_a_raising_on_receipt_keeps_guardians_verified_result(path):
    def broken_receipt(tool_name, request_id, receipt):
        raise RuntimeError("receipt store is down")

    guardian = FakeClient(ALLOW)
    llm, output = run([CALL], governed(guardian, mode="remote", on_receipt=broken_receipt), path)
    assert ran == [] and guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    answer = json.loads(llm.results()[0])["guardian"]
    assert answer["decision"] == "ALLOW" and answer["receipt"]["status"] == "sent-verified"
    assert "did not run" not in llm.results()[0]
    assert not output.tasks_output[0].tool_failures


def test_remote_mode_a_client_that_raises_is_reported_as_unknown():
    class Broken(FakeClient):
        def execute(self, *, request_id, capability_token):
            raise ConnectionError("network down")

    llm, output = run([CALL], governed(Broken(ALLOW), mode="remote"))
    assert ran == []
    assert "Guardian may have performed it. Do not call it again" in llm.results()[0]
    assert "did not run" not in llm.results()[0]
    failure = output.tasks_output[0].tool_failures[0].failure
    assert failure.code == "EXECUTION_OUTCOME_UNKNOWN" and failure.retryable is False


def test_a_mistyped_mode_is_refused():
    with pytest.raises(ValueError, match="in_process"):
        governed(FakeClient(ALLOW), mode="inProcess")
    with pytest.raises(ValueError, match="in_process"):
        governed(FakeClient(ALLOW), modes={"refund_order": "Remote"})


def test_a_generator_tool_is_refused_when_wrapped():
    # crewAI does not consume a tool's stream: the body would never run, and
    # Guardian would record a call that did not happen.
    @tool("export_rows")
    def export_rows(table: str) -> str:
        """Export rows."""
        ran.append(table)
        yield "row"

    class Export(BaseTool):
        name: str = "export_rows"
        description: str = "Export rows."

        def _run(self, table: str):
            ran.append(table)
            yield "row"

    for generator_tool in (export_rows, Export()):
        with pytest.raises(TypeError, match="generator function"):
            governed(FakeClient(ALLOW), tools=(generator_tool,))
    # Remote: the body never runs anyway, and Guardian performs the call.
    guardian = FakeClient(ALLOW)
    llm, _ = run([("export_rows", {"table": "invoices"})], governed(guardian, tools=(export_rows,), mode="remote"))
    assert ran == [] and json.loads(llm.results()[0])["guardian"]["decision"] == "ALLOW"


# --- crewAI's cache, usage limits, result_as_answer ------------------------------


def test_a_held_call_is_not_cached_so_the_approved_retry_runs():
    guardian = FakeClient(HELD, claims=[APPROVED])
    llm, _ = run([CALL, CALL], governed(guardian), cache=True)
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask", "execute:req_ask"]
    assert ran == [("o42", 500)]
    assert llm.results()[1] == "refunded o42"


def test_with_the_crew_cache_on_a_repeated_allowed_call_is_answered_by_crewai():
    # crewAI's cache (off by default) answers before the tool is reached:
    # nothing runs and nothing is proposed for the repeat.
    guardian = FakeClient(ALLOW)
    llm, _ = run([CALL, CALL], governed(guardian), cache=True)
    assert ran == [("o42", 500)]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    assert llm.results()[:2] == ["refunded o42", "refunded o42"]


def test_the_wrapped_tools_cache_function_still_decides():
    class Uncached(BaseTool):
        name: str = "refund_order"
        description: str = "Refund an order."
        cache_function: object = lambda _args=None, _result=None: False

        def _run(self, order_id: str, amount_cents: int) -> str:
            ran.append((order_id, amount_cents))
            return f"refunded {order_id}"

    guardian = FakeClient(ALLOW)
    run([CALL, CALL], governed(guardian, tools=(Uncached(),)), cache=True)
    assert ran == [("o42", 500), ("o42", 500)]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"] * 2


def test_a_held_call_does_not_spend_the_tools_usage_limit():
    refund_order.max_usage_count = 1
    guardian = FakeClient(HELD, claims=[APPROVED])
    llm, _ = run([CALL, CALL, CALL], governed(guardian))
    assert ran == [("o42", 500)]
    # The third call is over the limit: nothing is proposed for it.
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask", "execute:req_ask"]
    assert "reached its usage limit of 1" in llm.results()[2]


@BOTH
def test_a_refusal_is_never_the_final_answer_of_a_result_as_answer_tool(path):
    @tool("refund_order", result_as_answer=True)
    def final(order_id: str, amount_cents: int) -> str:
        """Refund an order."""
        ran.append((order_id, amount_cents))
        return f"refunded {order_id}"

    _, output = run([CALL], governed(FakeClient(DENIED), tools=(final,)), path)
    assert ran == [] and output.raw == "done"
    _, output = run([CALL], governed(FakeClient(ALLOW), tools=(final,)), path)
    assert ran == [("o42", 500)] and output.raw == "refunded o42"


# --- tool kinds and async runs ----------------------------------------------------


def test_a_tool_class_and_an_async_tool_are_governed():
    class Refund(BaseTool):
        name: str = "refund_order"
        description: str = "Refund an order."

        def _run(self, order_id: str, amount_cents: int) -> str:
            ran.append((order_id, amount_cents))
            return f"refunded {order_id}"

    @tool("lookup_order")
    async def lookup(order_id: str) -> str:
        """Look an order up."""
        ran.append(order_id)
        return f"order {order_id}"

    guardian = FakeClient(ALLOW)
    llm, _ = run([CALL, LOOKUP], governed(guardian, tools=(Refund(), lookup)))
    assert ran == [("o42", 500), "o42"]
    assert llm.results() == ["refunded o42", "order o42"]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"] * 2


@BOTH
@pytest.mark.parametrize("kickoff", ["akickoff", "kickoff_async"])
async def test_async_kickoff(path, kickoff):
    guardian = FakeClient(HELD, claims=[APPROVED])
    tools = governed(guardian)
    llm, crew = crew_for([CALL], tools, path)
    await getattr(crew, kickoff)()
    assert ran == [] and "held for human approval" in llm.results()[0]
    llm, crew = crew_for([CALL], tools, path)
    await getattr(crew, kickoff)()
    assert ran == [("o42", 500)] and llm.results() == ["refunded o42"]
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask", "execute:req_ask"]


async def test_an_async_tool_under_akickoff():
    @tool("lookup_order")
    async def lookup(order_id: str) -> str:
        """Look an order up."""
        ran.append(order_id)
        return f"order {order_id}"

    guardian = FakeClient(ALLOW)
    llm, crew = crew_for([LOOKUP], governed(guardian, tools=(lookup,)), NATIVE)
    await crew.akickoff()
    assert ran == ["o42"] and llm.results() == ["order o42"]


# --- the tool on its own ----------------------------------------------------------


def test_calling_the_tool_directly_is_governed_too():
    guardian = FakeClient(DENIED)
    (wrapped,) = governed(guardian)
    refused = wrapped.run(order_id="o42", amount_cents=500)
    assert isinstance(refused, ToolFailure) and refused.code == "POLICY_DENY" and ran == []

    guardian = FakeClient(ALLOW)
    (wrapped,) = governed(guardian)
    assert wrapped.run("o42", "500") == "refunded o42"  # positional, validated
    assert guardian.last_invocation["arguments"] == {"order_id": "o42", "amount_cents": 500}
    assert ran == [("o42", 500)]


async def test_arun_is_governed():
    guardian = FakeClient(ALLOW)
    (wrapped,) = governed(guardian)
    assert await wrapped.arun(order_id="o42", amount_cents=500) == "refunded o42"
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]


def test_the_tool_cannot_change_what_was_decided_through_its_arguments():
    @tool("submit")
    def submit(payload: dict) -> str:
        """Submit a payload."""
        payload.pop("invoice")
        ran.append("submitted")
        return "submitted"

    guardian = FakeClient(ALLOW)
    receipts = []
    llm, _ = run(
        [("submit", {"payload": {"invoice": {"id": "INV-1"}, "lines": [1, 2]}})],
        governed(guardian, tools=(submit,), on_receipt=lambda t, r, rc: receipts.append(r)),
    )
    assert ran == ["submitted"] and receipts == ["req_allow"]
    assert guardian.last_invocation["arguments"] == {"payload": {"invoice": {"id": "INV-1"}, "lines": [1, 2]}}


def test_a_tool_restored_without_its_client_refuses_every_call():
    (wrapped,) = governed(FakeClient(ALLOW))
    # crewAI's own restore path for a checkpointed tool list.
    (restored,) = TypeAdapter(List[BaseTool]).validate_python([wrapped.model_dump(mode="json")])
    assert isinstance(restored, GuardianTool)
    refused = restored.run(order_id="o42", amount_cents=500)
    assert isinstance(refused, ToolFailure) and refused.code == "GUARDIAN_NOT_CONFIGURED"
    assert ran == []


def test_a_copy_keeps_the_guardian_client_and_the_held_requests():
    import copy

    guardian = FakeClient(HELD, claims=[APPROVED])
    (wrapped,) = governed(guardian)
    wrapped.run(order_id="o42", amount_cents=500)
    assert copy.deepcopy(wrapped).run(order_id="o42", amount_cents=500) == "refunded o42"
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask", "execute:req_ask"]


# --- a call that ran is never retryable, and never runs again by itself ------------


def test_a_call_that_ran_is_not_retryable_when_guardian_could_not_record_it():
    class LostRedemption(FakeClient):
        def execute(self, *, request_id, capability_token):
            self.calls.append(f"execute:{request_id}")
            return ExecuteResult(ok=False, reason_code="SERVICE_UNAVAILABLE")

        def receipts(self, request_id):
            return types.SimpleNamespace(ok=True, receipts=[{"state": "aborted"}])

    guardian = LostRedemption(ALLOW)
    llm, output = run([CALL], governed(guardian))
    assert ran == [("o42", 500)]
    failure = output.tasks_output[0].tool_failures[0].failure
    assert failure.code == "SERVICE_UNAVAILABLE" and failure.details["guardian"]["local_effect_ran"]
    assert failure.retryable is False
    assert "Do not call it again" in llm.results()[0]


@BOTH
def test_a_raising_on_receipt_does_not_make_a_recorded_call_run_again(path):
    def broken_receipt(tool_name, request_id, receipt):
        raise RuntimeError("receipt store is down")

    guardian = FakeClient(ALLOW)
    llm, output = run([CALL], governed(guardian, on_receipt=broken_receipt), path)
    assert ran == [("o42", 500)]  # once: crewAI is not handed an error to retry
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    assert llm.results() == ["refunded o42"]
    assert not output.tasks_output[0].tool_failures


@BOTH
def test_an_error_after_the_tool_ran_is_reported_as_ran_and_never_retried(path):
    class Broken(FakeClient):
        def execute(self, *, request_id, capability_token):
            self.calls.append(f"execute:{request_id}")
            raise ConnectionError("network down")

    guardian = Broken(ALLOW)
    errors = []
    llm, output = run([CALL], governed(guardian, on_execution_error=errors.append), path)
    assert ran == [("o42", 500)]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    assert "refund_order ran, but Guardian could not confirm that it recorded it" in llm.results()[0]
    assert "Do not call it again" in llm.results()[0]
    failure = output.tasks_output[0].tool_failures[0].failure
    assert failure.code == "EXECUTION_OUTCOME_UNKNOWN" and failure.retryable is False
    assert errors and errors[0].local_effect_ran and errors[0].outcome_unknown


# --- usage limits: concurrent calls, and a fresh budget per task -------------------


class SlowExecute(FakeClient):
    """Guardian takes a moment to perform a call, so parallel calls overlap."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._lock = threading.Lock()

    def request(self, invocation):
        with self._lock:
            return super().request(invocation)

    def execute(self, *, request_id, capability_token):
        time.sleep(0.2)
        with self._lock:
            return super().execute(request_id=request_id, capability_token=capability_token)


def test_parallel_remote_calls_cannot_exceed_the_usage_limit():
    refund_order.max_usage_count = 1
    guardian = SlowExecute(ALLOW)
    other = ("refund_order", {"order_id": "o43", "amount_cents": 700})
    llm, _ = run([[CALL, other]], governed(guardian, mode="remote"))
    assert guardian.calls.count("execute:req_allow") == 1
    assert sum("reached its usage limit of 1" in text for text in llm.results()) == 1


def test_parallel_in_process_calls_cannot_exceed_the_usage_limit():
    @tool("refund_order", max_usage_count=1)
    def slow(order_id: str, amount_cents: int) -> str:
        """Refund an order."""
        time.sleep(0.2)
        ran.append(order_id)
        return f"refunded {order_id}"

    guardian = SlowExecute(ALLOW)
    other = ("refund_order", {"order_id": "o43", "amount_cents": 700})
    run([[CALL, other]], governed(guardian, tools=(slow,)))
    assert len(ran) == 1 and guardian.calls.count("execute:req_allow") == 1


@pytest.mark.parametrize("mode", ["in_process", "remote"])
@BOTH
def test_each_task_and_each_kickoff_gets_a_fresh_usage_budget(path, mode):
    refund_order.max_usage_count = 1
    guardian = FakeClient(ALLOW)
    tools = governed(guardian, mode=mode)
    other = ("refund_order", {"order_id": "o43", "amount_cents": 700})

    # Two tasks in one kickoff, one call each.
    llm = ScriptedLLM([CALL], native=path == NATIVE)
    llm2 = ScriptedLLM([other], native=path == NATIVE)
    first = Agent(role="billing", goal="refund orders", backstory="b", llm=llm, tools=tools)
    second = Agent(role="billing two", goal="refund orders", backstory="b", llm=llm2, tools=tools)
    tasks = [
        Task(description="refund order 42", expected_output="done", agent=first),
        Task(description="refund order 43", expected_output="done", agent=second),
    ]
    Crew(agents=[first, second], tasks=tasks).kickoff()
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"] * 2

    # The next kickoff with the same wrapped tools.
    llm3, _ = run([CALL, other], tools, path)
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"] * 3
    assert "reached its usage limit of 1" in llm3.results()[1]  # the second call of that task

    (wrapped,) = tools
    wrapped.reset_usage_count()
    assert not isinstance(wrapped.run(order_id="o44", amount_cents=1), ToolFailure)
