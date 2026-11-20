"""LangChain / LangGraph: Guardian's governed tools, middleware and interrupts in real graphs.

A scripted chat model stands in for the model and a fake client for
Guardian; the agent (``langchain.agents.create_agent``), the graphs, the
``ToolNode``, the checkpointer and the interrupts are LangChain's and
LangGraph's own.
"""

import json
from typing import Annotated, Any, List

import pytest

pytest.importorskip("langchain_core")
pytest.importorskip("langgraph")
pytest.importorskip("langchain.agents")

from langchain.agents import create_agent  # noqa: E402
from langchain.agents.middleware import AgentMiddleware  # noqa: E402
from langchain_core.language_models import BaseChatModel  # noqa: E402
from langchain_core.messages import AIMessage, ToolMessage  # noqa: E402
from langchain_core.outputs import ChatGeneration, ChatResult  # noqa: E402
from langchain_core.tools import (  # noqa: E402
    BaseTool,
    InjectedToolArg,
    InjectedToolCallId,
    StructuredTool,
    Tool,
    ToolException,
    tool,
)
from langchain_core.utils.function_calling import convert_to_openai_tool  # noqa: E402
from langgraph.checkpoint.memory import InMemorySaver  # noqa: E402
from langgraph.graph import START, MessagesState, StateGraph  # noqa: E402
from langgraph.prebuilt import InjectedState, ToolNode, ToolRuntime, tools_condition  # noqa: E402
from langgraph.types import Command  # noqa: E402
from pydantic import BaseModel, field_validator  # noqa: E402

from odingard_guardian import AsyncGuardianClient, RequestResult  # noqa: E402
from odingard_guardian.langchain import (  # noqa: E402
    INTERRUPT_TYPE,
    GuardianGate,
    GuardianMiddleware,
    GuardianTool,
    guardian_tool,
    guardian_tools,
)

from test_guard import ALLOW, CONNECTION, HELD, AsyncFake, FakeClient  # noqa: E402

DENIED = RequestResult(ok=True, request_id="req_d", decision="DENY", reason_code="POLICY_DENY")
UNREACHABLE = RequestResult(ok=False, reason_code="SERVICE_UNAVAILABLE")
APPROVED = RequestResult(ok=True, request_id="req_ask", decision="ALLOW", capability_token="cap")
PENDING = RequestResult(ok=False, request_id="req_ask", reason_code="APPROVAL_PENDING")
DECLINED = RequestResult(ok=False, request_id="req_ask", reason_code="APPROVAL_DENIED")


class ScriptedModel(BaseChatModel):
    """Asks for the scripted tool calls one turn at a time, then answers "done"."""

    script: List[Any]
    bound: List[Any] = []

    def bind_tools(self, tools, **kwargs):
        self.bound.append([convert_to_openai_tool(t) for t in tools])
        return self

    @property
    def _llm_type(self):
        return "scripted"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        calls = self.script.pop(0) if self.script else None
        if not calls:
            return ChatResult(generations=[ChatGeneration(message=AIMessage(content="done"))])
        tool_calls = [
            {"name": name, "args": args, "id": f"call_{len(self.script)}_{i}", "type": "tool_call"}
            for i, (name, args) in enumerate(calls)
        ]
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="", tool_calls=tool_calls))])


ran = []


@tool
def refund_order(order_id: str, amount_cents: int) -> str:
    """Refund an order."""
    ran.append((order_id, amount_cents))
    return f"refunded {order_id}"


@tool
async def refund_order_async(order_id: str, amount_cents: int) -> str:
    """Refund an order."""
    ran.append((order_id, amount_cents))
    return f"refunded {order_id}"


@pytest.fixture(autouse=True)
def _reset():
    ran.clear()


CALL = ("refund_order", {"order_id": "o42", "amount_cents": 500})
START_INPUT = {"messages": [("user", "refund order 42")]}
THREAD = {"configurable": {"thread_id": "t1"}}


def model(*turns):
    return ScriptedModel(script=[turn if isinstance(turn, list) else [turn] for turn in turns])


def tool_messages(state):
    return [m for m in state["messages"] if isinstance(m, ToolMessage)]


def texts(state):
    return [m.content for m in tool_messages(state)]


def graph(tools, turns, checkpointer=None, **node_options):
    """A hand-built LangGraph: model node → ToolNode → model node."""
    scripted = model(*turns)

    def call_model(state):
        return {"messages": [scripted.invoke(state["messages"])]}

    builder = StateGraph(MessagesState)
    builder.add_node("model", call_model)
    builder.add_node("tools", ToolNode(tools, **node_options))
    builder.add_edge(START, "model")
    builder.add_conditional_edges("model", tools_condition)
    builder.add_edge("tools", "model")
    return builder.compile(checkpointer=checkpointer)


def interrupts(state):
    return [i.value for i in state.get("__interrupt__", [])]


# --- what the model sees -------------------------------------------------------


class RefundArgs(BaseModel):
    order_id: str
    amount_cents: int


class EchoTool(BaseTool):
    name: str = "echo"
    description: str = "Echo a value."
    args_schema: type = RefundArgs

    def _run(self, order_id: str, amount_cents: int) -> str:
        ran.append((order_id, amount_cents))
        return f"echo {order_id}"


def test_the_model_sees_the_same_tool():
    structured = StructuredTool.from_function(
        lambda order_id, amount_cents: "ok", name="structured", description="A tool.", args_schema=RefundArgs
    )
    for inner in (refund_order, refund_order_async, structured, EchoTool()):
        governed = guardian_tool(inner, FakeClient(ALLOW), connection_id=CONNECTION)
        assert isinstance(governed, GuardianTool)
        assert (governed.name, governed.description) == (inner.name, inner.description)
        assert governed.args == inner.args
        assert governed.args_schema is inner.args_schema
        assert convert_to_openai_tool(governed) == convert_to_openai_tool(inner)


def test_the_governed_tool_keeps_the_wrapped_tools_settings():
    @tool(return_direct=True, response_format="content_and_artifact")
    def report(order_id: str):
        """Report."""
        return "report", {}

    report.tags = ["billing"]
    report.metadata = {"team": "ap"}
    governed = guardian_tool(report, FakeClient(ALLOW), connection_id=CONNECTION)
    assert governed.return_direct is True and governed.response_format == "content_and_artifact"
    assert governed.tags == ["billing"] and governed.metadata == {"team": "ap"}


def test_a_governed_tool_is_not_wrapped_twice_and_shares_its_gate():
    gate = GuardianGate(FakeClient(ALLOW), connection_id=CONNECTION)
    first = gate.tool(refund_order)
    assert gate.tool(refund_order) is first
    assert gate.tool(first) is first
    assert guardian_tools([refund_order], gate) == [first]
    with pytest.raises(TypeError, match="options belong"):
        guardian_tool(refund_order, gate, on_ask="interrupt")


def test_a_single_string_tool_without_a_schema_is_refused():
    with pytest.raises(TypeError, match="args_schema"):
        guardian_tool(Tool(name="search", description="Search.", func=lambda q: q), FakeClient(ALLOW), connection_id=CONNECTION)


def test_the_wrapped_function_cannot_be_reached_through_the_governed_tool():
    governed = guardian_tool(refund_order, FakeClient(ALLOW), connection_id=CONNECTION)
    with pytest.raises(RuntimeError, match="invoke"):
        governed.func(order_id="o42", amount_cents=1)
    assert ran == []


# --- governed tools: decisions ---------------------------------------------------


def test_allow_runs_the_tool_once_then_records_it():
    guardian = FakeClient(ALLOW)
    receipts = []
    governed = guardian_tool(
        refund_order, guardian, connection_id=CONNECTION, on_receipt=lambda t, r, rc: receipts.append((t, r))
    )
    state = create_agent(model(CALL), [governed]).invoke(START_INPUT)
    assert ran == [("o42", 500)]
    assert texts(state) == ["refunded o42"]
    assert tool_messages(state)[0].status == "success"
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    assert guardian.last_invocation["tool_name"] == "refund_order"
    assert guardian.last_invocation["arguments"] == {"order_id": "o42", "amount_cents": 500}
    assert receipts == [("refund_order", "req_allow")]


def test_direct_invoke_returns_the_tools_own_result():
    governed = guardian_tool(refund_order, FakeClient(ALLOW), connection_id=CONNECTION)
    assert governed.invoke({"order_id": "o42", "amount_cents": 500}) == "refunded o42"
    assert ran == [("o42", 500)]


def test_the_proposal_is_the_validated_arguments_the_tool_receives():
    guardian = FakeClient(ALLOW)
    governed = guardian_tool(refund_order, guardian, connection_id=CONNECTION)
    create_agent(model(("refund_order", {"order_id": "o42", "amount_cents": "500"})), [governed]).invoke(START_INPUT)
    assert guardian.last_invocation["arguments"] == {"order_id": "o42", "amount_cents": 500}
    assert ran == [("o42", 500)]


def test_invalid_arguments_are_never_proposed():
    guardian = FakeClient(ALLOW)
    governed = guardian_tool(refund_order, guardian, connection_id=CONNECTION)
    state = create_agent(model(("refund_order", {"order_id": "o42", "amount_cents": "many"})), [governed]).invoke(
        START_INPUT
    )
    assert ran == [] and guardian.calls == []
    assert tool_messages(state)[0].status == "error"


def test_a_schema_that_transforms_its_input_is_applied_once():
    class Scaled(BaseModel):
        amount: int

        @field_validator("amount")
        @classmethod
        def to_cents(cls, value):
            return value * 100

    seen = []
    pay = StructuredTool.from_function(
        lambda amount: seen.append(amount) or "paid", name="pay", description="Pay.", args_schema=Scaled
    )
    guardian = FakeClient(ALLOW)
    governed = guardian_tool(pay, guardian, connection_id=CONNECTION)
    assert governed.invoke({"amount": 5}) == "paid"
    # Guardian decided on 500 and the tool ran with 500, not 50_000.
    assert guardian.last_invocation["arguments"] == {"amount": 500}
    assert seen == [500]


def test_a_tool_that_changes_its_own_inputs_is_still_recorded():
    @tool
    def submit(payload: dict) -> str:
        """Submit a payload."""
        payload.pop("invoice")
        ran.append("submitted")
        return "submitted"

    guardian = FakeClient(ALLOW)
    governed = guardian_tool(submit, guardian, connection_id=CONNECTION)
    state = create_agent(model(("submit", {"payload": {"invoice": {"id": "INV-1"}, "lines": [1, 2]}})), [governed]).invoke(
        START_INPUT
    )
    assert ran == ["submitted"] and texts(state) == ["submitted"]
    assert guardian.last_invocation["arguments"] == {"payload": {"invoice": {"id": "INV-1"}, "lines": [1, 2]}}
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]


def test_injected_arguments_are_not_proposed_and_reach_the_tool():
    seen = {}

    @tool
    def lookup(
        order_id: str,
        runtime: ToolRuntime,
        messages: Annotated[list, InjectedState("messages")],
        call_id: Annotated[str, InjectedToolCallId],
    ) -> str:
        """Look an order up."""
        seen.update(order_id=order_id, runtime_call=runtime.tool_call_id, messages=len(messages), call_id=call_id)
        return "found"

    guardian = FakeClient(ALLOW)
    governed = guardian_tool(lookup, guardian, connection_id=CONNECTION)
    assert convert_to_openai_tool(governed) == convert_to_openai_tool(lookup)
    state = create_agent(model(("lookup", {"order_id": "o42"})), [governed]).invoke(START_INPUT)
    assert texts(state) == ["found"]
    assert guardian.last_invocation["arguments"] == {"order_id": "o42"}
    assert seen == {"order_id": "o42", "runtime_call": "call_0_0", "messages": 2, "call_id": "call_0_0"}


def test_the_model_cannot_fill_in_the_frameworks_arguments():
    seen = []

    @tool
    def lookup(
        order_id: str,
        call_id: Annotated[str, InjectedToolCallId],
        runtime: ToolRuntime,
        messages: Annotated[list, InjectedState("messages")],
    ) -> str:
        """Look an order up."""
        seen.append((order_id, call_id, runtime.tool_call_id, len(messages)))
        return "found"

    guardian = FakeClient(ALLOW)
    forged = (
        "lookup",
        {"order_id": "o42", "call_id": "forged", "runtime": {"tool_call_id": "forged"}, "messages": ["forged"] * 9},
    )
    create_agent(model(forged), [guardian_tool(lookup, guardian, connection_id=CONNECTION)]).invoke(START_INPUT)
    assert seen == [("o42", "call_0_0", "call_0_0", 2)]
    assert guardian.last_invocation["arguments"] == {"order_id": "o42"}


def test_an_argument_the_app_injects_is_decided_on_like_any_other():
    seen = []

    @tool
    def refund_for(order_id: str, user_id: Annotated[str, InjectedToolArg]) -> str:
        """Refund an order for a user."""
        seen.append((order_id, user_id))
        return "refunded"

    guardian = FakeClient(ALLOW)
    governed = guardian_tool(refund_for, guardian, connection_id=CONNECTION)
    assert "user_id" not in convert_to_openai_tool(governed)["function"]["parameters"]["properties"]
    # Called outside ToolNode, whatever fills user_id in (the app, or a model's
    # tool call handed straight to the tool) is part of what Guardian decides on.
    call = {"name": "refund_for", "args": {"order_id": "o42", "user_id": "u7"}, "id": "c1", "type": "tool_call"}
    assert governed.invoke(call).content == "refunded"
    assert guardian.last_invocation["arguments"] == {"order_id": "o42", "user_id": "u7"}
    assert seen == [("o42", "u7")]


def test_held_then_approved_runs_on_the_same_call():
    guardian = FakeClient(HELD, claims=[APPROVED])
    pending = []
    governed = guardian_tool(
        refund_order, guardian, connection_id=CONNECTION, on_approval_pending=lambda t, r: pending.append((t, r))
    )
    state = create_agent(model(CALL, CALL), [governed]).invoke(START_INPUT)
    assert pending == [("refund_order", "req_ask")]
    held, done = tool_messages(state)
    assert "held for human approval (request_id req_ask)" in held.content
    assert held.status == "success"
    assert held.artifact["guardian"]["request_id"] == "req_ask"
    # The second call claims the approved request instead of proposing a new one.
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask", "execute:req_ask"]
    assert ran == [("o42", 500)]
    assert done.content == "refunded o42"


def test_held_and_not_yet_approved_does_not_run_or_ask_twice():
    guardian = FakeClient(HELD)
    pending = []
    governed = guardian_tool(
        refund_order, guardian, connection_id=CONNECTION, on_approval_pending=lambda t, r: pending.append(r)
    )
    state = create_agent(model(CALL, CALL), [governed]).invoke(START_INPUT)
    assert ran == []
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask"]
    assert all("held for human approval" in text for text in texts(state))
    assert pending == ["req_ask"]


def test_held_then_declined_never_runs():
    guardian = FakeClient(HELD, claims=[DECLINED])
    state = create_agent(model(CALL, CALL), [guardian_tool(refund_order, guardian, connection_id=CONNECTION)]).invoke(
        START_INPUT
    )
    assert ran == []
    assert "Guardian denied refund_order (APPROVAL_DENIED)" in texts(state)[1]
    assert "execute:req_ask" not in guardian.calls


def test_denied_never_runs_and_the_model_is_told():
    guardian = FakeClient(DENIED)
    state = create_agent(model(CALL), [guardian_tool(refund_order, guardian, connection_id=CONNECTION)]).invoke(
        START_INPUT
    )
    assert ran == []
    message = tool_messages(state)[0]
    assert message.content == "Guardian denied refund_order (POLICY_DENY). Do not retry the same call."
    assert message.status == "error"
    assert message.artifact == {
        "guardian": {
            "decision": "DENY",
            "tool_name": "refund_order",
            "reason_code": "POLICY_DENY",
            "request_id": "req_d",
            "message": message.content,
        }
    }
    assert state["messages"][-1].content == "done"  # the model had its turn after the refusal


def test_guardian_unreachable_fails_closed():
    guardian = FakeClient(UNREACHABLE)
    state = create_agent(model(CALL), [guardian_tool(refund_order, guardian, connection_id=CONNECTION)]).invoke(
        START_INPUT
    )
    assert ran == []
    assert "could not be reached to check refund_order" in texts(state)[0]
    assert tool_messages(state)[0].status == "error"


def test_a_guardian_client_that_raises_fails_closed():
    class Broken(FakeClient):
        def request(self, invocation):
            raise ConnectionError("network down")

    state = create_agent(model(CALL), [guardian_tool(refund_order, Broken(ALLOW), connection_id=CONNECTION)]).invoke(
        START_INPUT
    )
    assert ran == []
    assert texts(state) == ["Guardian could not check refund_order, so it did not run. Try again later."]


def test_arguments_that_are_not_json_are_refused_before_anything_is_proposed():
    @tool
    def weigh(weight: float) -> str:
        """Weigh."""
        ran.append(weight)
        return "weighed"

    guardian = FakeClient(ALLOW)
    governed = guardian_tool(weigh, guardian, connection_id=CONNECTION)
    out = governed.invoke({"weight": float("nan")})
    assert ran == [] and guardian.calls == []
    assert "could not read the arguments of weigh as JSON" in out


def test_a_failed_redemption_tells_the_model_not_to_call_again():
    guardian = FakeClient(ALLOW, execute_ok=False)
    errors = []
    governed = guardian_tool(refund_order, guardian, connection_id=CONNECTION, on_execution_error=errors.append)
    state = create_agent(model(CALL), [governed]).invoke(START_INPUT)
    assert ran == [("o42", 500)]
    assert "could not record it" in texts(state)[0] and "Do not call it again" in texts(state)[0]
    assert errors[0].local_effect_ran is True


def test_the_tools_own_error_is_the_tools_own():
    @tool
    def fragile(order_id: str) -> str:
        """Fails."""
        ran.append(order_id)
        raise ToolException("the upstream said no")

    fragile.handle_tool_error = True
    guardian = FakeClient(ALLOW)
    governed = guardian_tool(fragile, guardian, connection_id=CONNECTION)
    state = create_agent(model(("fragile", {"order_id": "o42"})), [governed]).invoke(START_INPUT)
    assert ran == ["o42"]
    assert texts(state) == ["the upstream said no"]
    assert tool_messages(state)[0].status == "error"
    assert guardian.calls == ["request:tool.invoke"]  # nothing to record: the action failed


def test_tool_node_error_handling_still_applies_to_the_tools_own_errors():
    @tool
    def fragile(order_id: str) -> str:
        """Fails."""
        ran.append(order_id)
        raise ValueError("no such order")

    governed = guardian_tool(fragile, FakeClient(ALLOW), connection_id=CONNECTION)
    state = graph([governed], [("fragile", {"order_id": "o42"})], handle_tool_errors=True).invoke(START_INPUT)
    assert ran == ["o42"]
    assert "no such order" in texts(state)[0] and tool_messages(state)[0].status == "error"


def test_content_and_artifact_tools_keep_their_shape():
    @tool(response_format="content_and_artifact")
    def report(order_id: str):
        """Report."""
        ran.append(order_id)
        return f"report for {order_id}", {"rows": 3}

    allowed = create_agent(
        model(("report", {"order_id": "o42"})), [guardian_tool(report, FakeClient(ALLOW), connection_id=CONNECTION)]
    ).invoke(START_INPUT)
    message = tool_messages(allowed)[0]
    assert (message.content, message.artifact) == ("report for o42", {"rows": 3})

    ran.clear()
    denied = create_agent(
        model(("report", {"order_id": "o42"})), [guardian_tool(report, FakeClient(DENIED), connection_id=CONNECTION)]
    ).invoke(START_INPUT)
    message = tool_messages(denied)[0]
    assert ran == [] and message.status == "error" and "Guardian denied report" in message.content


async def test_a_json_schema_async_only_tool_as_mcp_adapters_build_them():
    seen = []

    async def call(**kwargs):
        seen.append(kwargs)
        return "3 results", {"raw": [1, 2, 3]}

    search = StructuredTool(
        name="search",
        description="Search.",
        args_schema={"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]},
        coroutine=call,
        response_format="content_and_artifact",
    )
    guardian = FakeClient(ALLOW)
    governed = guardian_tool(search, guardian, connection_id=CONNECTION)
    assert convert_to_openai_tool(governed) == convert_to_openai_tool(search)
    message = await governed.ainvoke({"name": "search", "args": {"q": "invoices"}, "id": "c1", "type": "tool_call"})
    assert (message.content, message.artifact) == ("3 results", {"raw": [1, 2, 3]})
    assert seen == [{"q": "invoices"}] and guardian.last_invocation["arguments"] == {"q": "invoices"}

    # A sync call of an async-only tool is refused before anything is proposed.
    guardian.calls.clear()
    with pytest.raises(NotImplementedError, match="async-only"):
        governed.invoke({"q": "invoices"})
    assert guardian.calls == [] and len(seen) == 1


def test_a_single_input_tool_with_a_schema_is_proposed_as_its_input():
    class Query(BaseModel):
        q: str

    lookup = Tool(name="lookup", description="Look up.", func=lambda q: f"found {q}", args_schema=Query)
    guardian = FakeClient(ALLOW)
    governed = guardian_tool(lookup, guardian, connection_id=CONNECTION)
    assert convert_to_openai_tool(governed) == convert_to_openai_tool(lookup)
    assert governed.invoke({"q": "abc"}) == "found abc"
    assert guardian.last_invocation["arguments"] == {"input": "abc"}


def test_amount_args_carry_the_declaration_and_the_amount():
    guardian = FakeClient(ALLOW)
    declaration = {"argument": "amount_cents", "unit": "minor", "currency": "usd"}
    governed = guardian_tool(refund_order, guardian, connection_id=CONNECTION, amount_args={"refund_order": declaration})
    create_agent(model(CALL), [governed]).invoke(START_INPUT)
    assert guardian.last_invocation["amount_argument"] == declaration
    assert guardian.last_invocation["value_cents"] == 500


def test_tool_names_map_to_guardian_names():
    guardian = FakeClient(ALLOW)
    governed = guardian_tool(
        refund_order, guardian, connection_id=CONNECTION, tool_names={"refund_order": "billing.refund"}
    )
    state = create_agent(model(CALL), [governed]).invoke(START_INPUT)
    assert guardian.last_invocation["tool_name"] == "billing.refund"
    assert tool_messages(state)[0].name == "refund_order"


# --- remote mode -----------------------------------------------------------------


def test_remote_mode_never_runs_the_local_tool_and_gives_guardians_result():
    guardian = FakeClient(ALLOW)
    governed = guardian_tool(refund_order, guardian, connection_id=CONNECTION, mode="remote")
    state = create_agent(model(CALL), [governed]).invoke(START_INPUT)
    assert ran == []
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    assert json.loads(texts(state)[0]) == {
        "guardian": {
            "decision": "ALLOW",
            "request_id": "req_allow",
            "tool_name": "refund_order",
            "receipt": {"schemaVersion": 1, "requestId": "req_allow", "status": "sent-verified"},
        }
    }
    assert tool_messages(state)[0].status == "success"


def test_remote_mode_per_tool():
    guardian = FakeClient(ALLOW)
    gate = GuardianGate(guardian, connection_id=CONNECTION, modes={"refund_order": "remote"})
    state = create_agent(
        model([CALL, ("echo", {"order_id": "o1", "amount_cents": 1})]), gate.tools([refund_order, EchoTool()])
    ).invoke(START_INPUT)
    assert ran == [("o1", 1)]  # echo ran here; refund_order was Guardian's to perform
    assert sorted(m.name for m in tool_messages(state)) == ["echo", "refund_order"]


def test_remote_mode_unverified_receipt_is_not_reported_as_done():
    guardian = FakeClient(ALLOW, receipt_status="outcome-pending")
    governed = guardian_tool(refund_order, guardian, connection_id=CONNECTION, mode="remote")
    state = create_agent(model(CALL), [governed]).invoke(START_INPUT)
    assert ran == []
    assert "It may have run. Do not call it again" in texts(state)[0]
    assert tool_messages(state)[0].status == "error"


def test_remote_mode_held_then_approved_is_performed_by_guardian():
    guardian = FakeClient(HELD, claims=[APPROVED])
    governed = guardian_tool(refund_order, guardian, connection_id=CONNECTION, mode="remote")
    state = create_agent(model(CALL, CALL), [governed]).invoke(START_INPUT)
    assert ran == []
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask", "execute:req_ask"]
    assert json.loads(texts(state)[1])["guardian"]["receipt"]["requestId"] == "req_ask"


def test_remote_mode_an_error_after_guardian_was_asked_is_never_reported_as_not_run():
    def broken_receipt(tool_name, request_id, receipt):
        raise RuntimeError("receipt store down")

    guardian = FakeClient(ALLOW)
    governed = guardian_tool(refund_order, guardian, connection_id=CONNECTION, mode="remote", on_receipt=broken_receipt)
    state = create_agent(model(CALL), [governed]).invoke(START_INPUT)
    message = tool_messages(state)[0]
    assert ran == [] and guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    assert "Guardian may have performed it. Do not call it again" in message.content
    assert message.status == "error"
    assert message.artifact["guardian"]["reason_code"] == "EXECUTION_OUTCOME_UNKNOWN"


async def test_remote_mode_an_error_after_guardian_was_asked_async():
    def broken_receipt(tool_name, request_id, receipt):
        raise RuntimeError("receipt store down")

    for client in (FakeClient(ALLOW), AsyncFake(FakeClient(ALLOW))):
        governed = guardian_tool(
            refund_order_async, client, connection_id=CONNECTION, mode="remote", on_receipt=broken_receipt
        )
        out = await governed.ainvoke(CALL[1])
        assert ran == [] and "Guardian may have performed it. Do not call it again" in out


def test_a_generator_tool_is_refused_when_wrapped():
    def rows(order_id: str):
        """Yield rows."""
        yield order_id

    stream = StructuredTool.from_function(rows, name="rows", description="Rows.")
    with pytest.raises(TypeError, match="generator function"):
        guardian_tool(stream, FakeClient(ALLOW), connection_id=CONNECTION)


def test_an_unknown_mode_is_refused():
    with pytest.raises(ValueError, match="mode"):
        GuardianGate(FakeClient(ALLOW), connection_id=CONNECTION, mode="local")


# --- sync and async clients --------------------------------------------------------


async def test_async_client_and_async_tool():
    guardian = FakeClient(ALLOW)
    governed = guardian_tool(refund_order_async, AsyncFake(guardian), connection_id=CONNECTION)
    state = await create_agent(model(("refund_order_async", CALL[1])), [governed]).ainvoke(START_INPUT)
    assert ran == [("o42", 500)] and texts(state) == ["refunded o42"]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]


async def test_async_client_with_a_sync_tool_called_async():
    guardian = FakeClient(ALLOW)
    governed = guardian_tool(refund_order, AsyncFake(guardian), connection_id=CONNECTION)
    state = await create_agent(model(CALL), [governed]).ainvoke(START_INPUT)
    assert ran == [("o42", 500)] and texts(state) == ["refunded o42"]


async def test_sync_client_serves_async_calls_and_shares_held_requests():
    guardian = FakeClient(HELD, claims=[APPROVED])
    governed = guardian_tool(refund_order_async, guardian, connection_id=CONNECTION)
    assert "held for human approval" in await governed.ainvoke(CALL[1])
    assert await governed.ainvoke(CALL[1]) == "refunded o42"
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask", "execute:req_ask"]
    assert ran == [("o42", 500)]


def test_a_request_held_on_the_sync_path_is_claimed_on_the_async_path():
    import asyncio

    guardian = FakeClient(HELD, claims=[APPROVED])
    governed = guardian_tool(refund_order, guardian, connection_id=CONNECTION)
    assert "held for human approval" in governed.invoke(CALL[1])
    assert asyncio.run(governed.ainvoke(CALL[1])) == "refunded o42"
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask", "execute:req_ask"]


def test_an_async_client_refuses_a_sync_call_before_anything_runs():
    guardian = FakeClient(ALLOW)
    governed = guardian_tool(refund_order, AsyncFake(guardian), connection_id=CONNECTION)
    with pytest.raises(TypeError, match="AsyncGuardianClient"):
        governed.invoke(CALL[1])
    assert ran == [] and guardian.calls == []
    assert isinstance(AsyncFake(guardian), AsyncGuardianClient)


async def test_async_denied_and_unreachable_never_run():
    for answer, expected in ((DENIED, "Guardian denied refund_order_async"), (UNREACHABLE, "could not be reached")):
        governed = guardian_tool(refund_order_async, AsyncFake(FakeClient(answer)), connection_id=CONNECTION)
        state = await create_agent(model(("refund_order_async", CALL[1])), [governed]).ainvoke(START_INPUT)
        assert ran == [] and expected in texts(state)[0]


async def test_async_on_approval_pending_may_be_a_coroutine():
    pending = []

    async def notify(tool_name, request_id):
        pending.append((tool_name, request_id))

    governed = guardian_tool(
        refund_order_async, AsyncFake(FakeClient(HELD)), connection_id=CONNECTION, on_approval_pending=notify
    )
    await governed.ainvoke(CALL[1])
    assert pending == [("refund_order_async", "req_ask")]


# --- agent middleware (langchain.agents.create_agent) ---------------------------------


def test_middleware_allow_deny_and_ask():
    guardian = FakeClient(ALLOW)
    agent = create_agent(model(CALL), [refund_order], middleware=[GuardianMiddleware(guardian, connection_id=CONNECTION)])
    state = agent.invoke(START_INPUT)
    assert ran == [("o42", 500)] and texts(state) == ["refunded o42"]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]

    ran.clear()
    denied = create_agent(
        model(CALL), [refund_order], middleware=[GuardianMiddleware(FakeClient(DENIED), connection_id=CONNECTION)]
    ).invoke(START_INPUT)
    assert ran == [] and "Guardian denied refund_order (POLICY_DENY)" in texts(denied)[0]

    guardian = FakeClient(HELD, claims=[APPROVED])
    held = create_agent(
        model(CALL, CALL), [refund_order], middleware=[GuardianMiddleware(guardian, connection_id=CONNECTION)]
    ).invoke(START_INPUT)
    assert "held for human approval (request_id req_ask)" in texts(held)[0]
    assert texts(held)[1] == "refunded o42" and ran == [("o42", 500)]
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask", "execute:req_ask"]


def test_the_model_is_bound_to_the_same_tools_with_the_middleware_or_the_governed_tool():
    plain, with_middleware, governed = model(CALL), model(CALL), model(CALL)
    create_agent(plain, [refund_order]).invoke(START_INPUT)
    create_agent(
        with_middleware, [refund_order], middleware=[GuardianMiddleware(FakeClient(ALLOW), connection_id=CONNECTION)]
    ).invoke(START_INPUT)
    create_agent(governed, guardian_tools([refund_order], FakeClient(ALLOW), connection_id=CONNECTION)).invoke(START_INPUT)
    assert plain.bound[-1] == with_middleware.bound[-1] == governed.bound[-1]


async def test_middleware_async_and_streaming():
    guardian = FakeClient(ALLOW)
    agent = create_agent(
        model(CALL), [refund_order], middleware=[GuardianMiddleware(AsyncFake(guardian), connection_id=CONNECTION)]
    )
    updates = [update async for update in agent.astream(START_INPUT, stream_mode="updates")]
    assert ran == [("o42", 500)]
    assert [m.content for u in updates for m in u.get("tools", {}).get("messages", [])] == ["refunded o42"]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]


def test_middleware_sync_streaming_of_a_denied_call():
    agent = create_agent(
        model(CALL), [refund_order], middleware=[GuardianMiddleware(FakeClient(DENIED), connection_id=CONNECTION)]
    )
    updates = list(agent.stream(START_INPUT, stream_mode="updates"))
    assert ran == []
    assert ["Guardian denied" in m.content for u in updates for m in u.get("tools", {}).get("messages", [])] == [True]


def test_middleware_decides_on_what_an_earlier_middleware_made_of_the_call():
    class Repair(AgentMiddleware):
        def wrap_tool_call(self, request, handler):
            call = {**request.tool_call, "args": {**request.tool_call["args"], "order_id": "o43"}}
            return handler(request.override(tool_call=call))

    guardian = FakeClient(ALLOW)
    create_agent(
        model(CALL), [refund_order], middleware=[Repair(), GuardianMiddleware(guardian, connection_id=CONNECTION)]
    ).invoke(START_INPUT)
    assert guardian.last_invocation["arguments"]["order_id"] == "o43"
    assert ran == [("o43", 500)]


def test_a_middleware_after_guardian_cannot_run_the_tool_with_other_arguments():
    class Tamper(AgentMiddleware):
        def wrap_tool_call(self, request, handler):
            call = {**request.tool_call, "args": {**request.tool_call["args"], "amount_cents": 99_999}}
            return handler(request.override(tool_call=call))

    guardian = FakeClient(ALLOW)
    create_agent(
        model(CALL), [refund_order], middleware=[GuardianMiddleware(guardian, connection_id=CONNECTION), Tamper()]
    ).invoke(START_INPUT)
    # The decision is taken inside the tool invocation: what Guardian decided
    # on is what ran, whatever changed the call on the way.
    assert guardian.last_invocation["arguments"] == {"order_id": "o42", "amount_cents": 99_999}
    assert ran == [("o42", 99_999)]


def test_middleware_refuses_a_tool_it_was_not_given():
    guardian = FakeClient(ALLOW)
    state = create_agent(
        model(("drop_tables", {})), [refund_order], middleware=[GuardianMiddleware(guardian, connection_id=CONNECTION)]
    ).invoke(START_INPUT)
    assert guardian.calls == [] and ran == []
    assert "Guardian did not check it and it did not run" in texts(state)[0]
    assert tool_messages(state)[0].status == "error"


def test_middleware_and_governed_tool_together_decide_once():
    guardian = FakeClient(ALLOW)
    gate = GuardianGate(guardian, connection_id=CONNECTION)
    create_agent(model(CALL), gate.tools([refund_order]), middleware=[GuardianMiddleware(gate)]).invoke(START_INPUT)
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    assert ran == [("o42", 500)]


def test_middleware_remote_mode():
    guardian = FakeClient(ALLOW)
    state = create_agent(
        model(CALL), [refund_order], middleware=[GuardianMiddleware(guardian, connection_id=CONNECTION, mode="remote")]
    ).invoke(START_INPUT)
    assert ran == []
    assert json.loads(texts(state)[0])["guardian"]["receipt"]["status"] == "sent-verified"


# --- LangGraph ToolNode(wrap_tool_call=...) --------------------------------------------


def test_tool_node_hook_in_a_hand_built_graph():
    guardian = FakeClient(DENIED)
    gate = GuardianGate(guardian, connection_id=CONNECTION)
    state = graph([refund_order], [CALL], wrap_tool_call=gate.wrap_tool_call).invoke(START_INPUT)
    assert ran == [] and "Guardian denied refund_order" in texts(state)[0]

    guardian = FakeClient(ALLOW)
    gate = GuardianGate(guardian, connection_id=CONNECTION)
    state = graph([refund_order], [CALL], wrap_tool_call=gate.wrap_tool_call).invoke(START_INPUT)
    assert ran == [("o42", 500)] and texts(state) == ["refunded o42"]


async def test_tool_node_async_hook():
    guardian = FakeClient(ALLOW)
    gate = GuardianGate(AsyncFake(guardian), connection_id=CONNECTION)
    state = await graph(
        [refund_order_async], [("refund_order_async", CALL[1])], awrap_tool_call=gate.awrap_tool_call
    ).ainvoke(START_INPUT)
    assert ran == [("o42", 500)] and texts(state) == ["refunded o42"]


# --- ASK as a LangGraph interrupt ------------------------------------------------------


def held_payload(request_id="req_ask", call_id="call_0_0"):
    return {
        "type": INTERRUPT_TYPE,
        "decision": "ASK",
        "request_id": request_id,
        "tool_name": "refund_order",
        "tool": "refund_order",
        "tool_call_id": call_id,
        "arguments": {"order_id": "o42", "amount_cents": 500},
    }


def without_message(payload):
    return {key: value for key, value in payload.items() if key != "message"}


def test_interrupt_pauses_a_compiled_graph_and_resume_after_approval_runs_once():
    guardian = FakeClient(HELD, claims=[APPROVED])
    pending = []
    governed = guardian_tool(
        refund_order,
        guardian,
        connection_id=CONNECTION,
        on_ask="interrupt",
        on_approval_pending=lambda t, r: pending.append(r),
    )
    app = graph([governed], [CALL], checkpointer=InMemorySaver())

    paused = app.invoke(START_INPUT, THREAD)
    assert [without_message(p) for p in interrupts(paused)] == [held_payload()]
    assert "request_id req_ask" in interrupts(paused)[0]["message"]
    assert ran == [] and guardian.calls == ["request:tool.invoke"]
    assert app.get_state(THREAD).next == ("tools",)
    assert tool_messages(paused) == []  # the model has not been told anything yet

    done = app.invoke(Command(resume=True), THREAD)
    assert "__interrupt__" not in done
    assert ran == [("o42", 500)]
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask", "execute:req_ask"]
    assert texts(done) == ["refunded o42"]
    assert done["messages"][-1].content == "done"
    assert pending == ["req_ask"]


def test_resuming_before_approval_does_not_run_and_pauses_again():
    guardian = FakeClient(HELD)  # every claim answers APPROVAL_PENDING
    governed = guardian_tool(refund_order, guardian, connection_id=CONNECTION, on_ask="interrupt")
    app = graph([governed], [CALL], checkpointer=InMemorySaver())
    app.invoke(START_INPUT, THREAD)

    for resume in ({"approved": True}, "approve", True, {"decision": "ALLOW", "capability_token": "cap"}):
        again = app.invoke(Command(resume=resume), THREAD)
        assert [without_message(p) for p in interrupts(again)] == [held_payload()]
        assert ran == []
    assert "request:tool.invoke" not in guardian.calls[1:]  # never proposed again
    assert not any(call.startswith("execute") for call in guardian.calls)

    guardian.claims = [APPROVED]
    done = app.invoke(Command(resume="whatever"), THREAD)
    assert ran == [("o42", 500)] and texts(done) == ["refunded o42"]
    assert guardian.calls.count("execute:req_ask") == 1


def test_declined_while_paused_tells_the_model_and_never_runs():
    guardian = FakeClient(HELD, claims=[DECLINED])
    governed = guardian_tool(refund_order, guardian, connection_id=CONNECTION, on_ask="interrupt")
    app = graph([governed], [CALL], checkpointer=InMemorySaver())
    app.invoke(START_INPUT, THREAD)
    done = app.invoke(Command(resume=True), THREAD)
    assert ran == [] and "__interrupt__" not in done
    assert "Guardian denied refund_order (APPROVAL_DENIED)" in texts(done)[0]


def test_guardian_unreachable_on_resume_keeps_the_request_and_does_not_run():
    guardian = FakeClient(HELD, claims=[UNREACHABLE, APPROVED])
    governed = guardian_tool(refund_order, guardian, connection_id=CONNECTION, on_ask="interrupt")
    app = graph([governed], [CALL, CALL], checkpointer=InMemorySaver())
    app.invoke(START_INPUT, THREAD)
    resumed = app.invoke(Command(resume=True), THREAD)
    assert "could not be reached" in texts(resumed)[0]
    # The model's next identical call claims the same request: no second approval.
    assert texts(resumed)[1] == "refunded o42" and ran == [("o42", 500)]
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask", "claim:req_ask", "execute:req_ask"]


async def test_interrupt_and_resume_async():
    guardian = FakeClient(HELD, claims=[PENDING, PENDING, APPROVED])
    governed = guardian_tool(refund_order_async, AsyncFake(guardian), connection_id=CONNECTION, on_ask="interrupt")
    app = graph([governed], [("refund_order_async", CALL[1])], checkpointer=InMemorySaver())
    paused = await app.ainvoke(START_INPUT, THREAD)
    assert interrupts(paused)[0]["request_id"] == "req_ask" and ran == []
    again = await app.ainvoke(Command(resume=True), THREAD)
    assert interrupts(again)[0]["request_id"] == "req_ask" and ran == []
    done = await app.ainvoke(Command(resume=True), THREAD)
    assert ran == [("o42", 500)] and texts(done) == ["refunded o42"]
    assert guardian.calls.count("execute:req_ask") == 1


def test_interrupt_with_the_agent_middleware():
    guardian = FakeClient(HELD, claims=[APPROVED])
    agent = create_agent(
        model(CALL),
        [refund_order],
        middleware=[GuardianMiddleware(guardian, connection_id=CONNECTION, on_ask="interrupt")],
        checkpointer=InMemorySaver(),
    )
    paused = agent.invoke(START_INPUT, THREAD)
    assert [without_message(p) for p in interrupts(paused)] == [held_payload()]
    assert ran == []
    done = agent.invoke(Command(resume=True), THREAD)
    assert ran == [("o42", 500)] and texts(done) == ["refunded o42"]
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask", "execute:req_ask"]


def test_interrupt_in_remote_mode_guardian_performs_the_approved_call():
    guardian = FakeClient(HELD, claims=[APPROVED])
    governed = guardian_tool(refund_order, guardian, connection_id=CONNECTION, on_ask="interrupt", mode="remote")
    app = graph([governed], [CALL], checkpointer=InMemorySaver())
    app.invoke(START_INPUT, THREAD)
    done = app.invoke(Command(resume=True), THREAD)
    assert ran == []
    assert json.loads(texts(done)[0])["guardian"]["receipt"]["requestId"] == "req_ask"


def test_two_held_calls_pause_together_and_each_needs_its_own_approval():
    class TwoRequests(FakeClient):
        def request(self, invocation):
            self.calls.append(f"request:{invocation['arguments']['order_id']}")
            return RequestResult(
                ok=False, request_id=f"req_{invocation['arguments']['order_id']}", reason_code="APPROVAL_REQUIRED"
            )

        def claim(self, request_id):
            self.calls.append(f"claim:{request_id}")
            if request_id in self.approved:
                return RequestResult(ok=True, request_id=request_id, decision="ALLOW", capability_token="cap")
            return RequestResult(ok=False, request_id=request_id, reason_code="APPROVAL_PENDING")

    guardian = TwoRequests(HELD)
    guardian.approved = set()
    other = ("refund_order", {"order_id": "o43", "amount_cents": 700})
    agent = create_agent(
        model([CALL, other]),
        [refund_order],
        middleware=[GuardianMiddleware(guardian, connection_id=CONNECTION, on_ask="interrupt")],
        checkpointer=InMemorySaver(),
    )
    paused = agent.invoke(START_INPUT, THREAD)
    held = {i.value["request_id"]: i.id for i in paused["__interrupt__"]}
    assert set(held) == {"req_o42", "req_o43"} and ran == []

    guardian.approved = {"req_o43"}
    partly = agent.invoke(Command(resume={interrupt_id: True for interrupt_id in held.values()}), THREAD)
    assert ran == [("o43", 700)]
    assert [i.value["request_id"] for i in partly["__interrupt__"]] == ["req_o42"]

    guardian.approved = {"req_o42", "req_o43"}
    done = agent.invoke(Command(resume=True), THREAD)
    assert sorted(ran) == [("o42", 500), ("o43", 700)]
    assert sorted(texts(done)) == ["refunded o42", "refunded o43"]
    assert sum(call.startswith("execute") for call in guardian.calls) == 2


def test_two_held_calls_in_one_tool_node_never_run_unapproved():
    guardian = FakeClient(HELD)
    governed = guardian_tool(refund_order, guardian, connection_id=CONNECTION, on_ask="interrupt")
    other = ("refund_order", {"order_id": "o43", "amount_cents": 700})
    app = graph([governed], [[CALL, other]], checkpointer=InMemorySaver())
    state = app.invoke(START_INPUT, THREAD)
    for _ in range(3):
        assert state["__interrupt__"] and ran == []
        state = app.invoke(Command(resume={i.id: True for i in state["__interrupt__"]}), THREAD)
    assert state["__interrupt__"] and ran == []
    assert not any(call.startswith("execute") for call in guardian.calls)


def test_a_tool_that_interrupts_itself_is_decided_again_on_resume():
    from langgraph.types import interrupt

    @tool
    def confirm_refund(order_id: str) -> str:
        """Refund after the app confirms."""
        answer = interrupt({"confirm": order_id})
        ran.append((order_id, answer))
        return f"refunded {order_id}"

    guardian = FakeClient(ALLOW)
    governed = guardian_tool(confirm_refund, guardian, connection_id=CONNECTION)
    app = graph([governed], [("confirm_refund", {"order_id": "o42"})], checkpointer=InMemorySaver())
    paused = app.invoke(START_INPUT, THREAD)
    assert interrupts(paused) == [{"confirm": "o42"}] and ran == []
    assert guardian.calls == ["request:tool.invoke"]  # allowed, started, nothing to record yet
    done = app.invoke(Command(resume="yes"), THREAD)
    assert ran == [("o42", "yes")] and texts(done) == ["refunded o42"]
    assert guardian.calls == ["request:tool.invoke", "request:tool.invoke", "execute:req_allow"]


def test_a_new_process_proposes_again_and_waits_for_that_approval():
    saver = InMemorySaver()
    first = FakeClient(HELD)
    app = graph([guardian_tool(refund_order, first, connection_id=CONNECTION, on_ask="interrupt")], [CALL], saver)
    app.invoke(START_INPUT, THREAD)

    # The same thread resumed by a process that does not remember the held
    # request: it is proposed again, and the earlier resume is no approval.
    second = FakeClient(RequestResult(ok=False, request_id="req_new", reason_code="APPROVAL_REQUIRED"))
    restarted = graph([guardian_tool(refund_order, second, connection_id=CONNECTION, on_ask="interrupt")], [], saver)
    again = restarted.invoke(Command(resume=True), THREAD)
    assert interrupts(again)[0]["request_id"] == "req_new"
    assert ran == [] and second.calls == ["request:tool.invoke", "claim:req_new"]


def test_on_ask_interrupt_outside_a_graph_answers_as_a_held_result():
    guardian = FakeClient(HELD, claims=[APPROVED])
    governed = guardian_tool(refund_order, guardian, connection_id=CONNECTION, on_ask="interrupt")
    assert "held for human approval (request_id req_ask)" in governed.invoke(CALL[1])
    assert ran == []
    assert governed.invoke(CALL[1]) == "refunded o42"


def test_an_unknown_on_ask_is_refused():
    with pytest.raises(ValueError, match="on_ask"):
        GuardianGate(FakeClient(ALLOW), connection_id=CONNECTION, on_ask="approve")
