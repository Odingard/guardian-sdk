"""Google ADK: Guardian's plugin in a real agent loop.

A scripted ``BaseLlm`` stands in for the model and a fake client for
Guardian; the agent, the runner, the session service, the tool pipeline and
the plugin manager are ADK's own.
"""

import pytest

pytest.importorskip("google.adk")

from google.adk.agents import LlmAgent  # noqa: E402
from google.adk.apps import App  # noqa: E402
from google.adk.models.base_llm import BaseLlm  # noqa: E402
from google.adk.models.llm_response import LlmResponse  # noqa: E402
from google.adk.plugins.base_plugin import BasePlugin  # noqa: E402
from google.adk.runners import Runner  # noqa: E402
from google.adk.sessions import InMemorySessionService  # noqa: E402
from google.adk.tools import AgentTool, BaseTool, FunctionTool, LongRunningFunctionTool  # noqa: E402
from google.genai import types  # noqa: E402

from odingard_guardian import ExecuteResult, GuardianClient, RequestResult  # noqa: E402
from odingard_guardian.google_adk import GuardianPlugin  # noqa: E402

from test_guard import ALLOW, CONNECTION, HELD, AsyncFake, FakeClient  # noqa: E402

DENIED = RequestResult(ok=True, request_id="req_d", decision="DENY", reason_code="POLICY_DENY")
UNREACHABLE = RequestResult(ok=False, reason_code="SERVICE_UNAVAILABLE")
APPROVED = RequestResult(ok=True, request_id="req_ask", decision="ALLOW", capability_token="cap")
DECLINED = RequestResult(ok=False, request_id="req_ask", reason_code="APPROVAL_DENIED")
CONFIRM = "adk_request_confirmation"


class ScriptedModel(BaseLlm):
    """Asks for the scripted tool calls, one list of calls per model turn, then answers "done"."""

    model: str = "scripted"
    turns: list = []
    seen: list = []

    async def generate_content_async(self, llm_request, stream=False):
        for content in llm_request.contents:
            for part in content.parts or []:
                response = part.function_response
                if response is not None and response.name != CONFIRM and response not in self.seen:
                    self.seen.append(response)
        if self.turns:
            calls = self.turns.pop(0)
            parts = [types.Part(function_call=types.FunctionCall(name=name, args=args)) for name, args in calls]
        else:
            parts = [types.Part(text="done")]
        yield LlmResponse(content=types.Content(role="model", parts=parts))

    def results(self):
        return [response.response for response in self.seen]


def scripted(*turns):
    """One model turn per argument: a call ``(name, args)`` or a list of parallel calls."""
    return ScriptedModel(turns=[turn if isinstance(turn, list) else [turn] for turn in turns], seen=[])


ran = []


def refund_order(order_id: str, amount_cents: int) -> dict:
    """Refund an order."""
    ran.append((order_id, amount_cents))
    return {"status": f"refunded {order_id}"}


async def lookup_order(order_id: str) -> dict:
    """Look an order up."""
    ran.append(("lookup", order_id))
    return {"order_id": order_id, "total_cents": 500}


@pytest.fixture(autouse=True)
def _reset():
    ran.clear()


def plugin(guardian, **options):
    return GuardianPlugin(AsyncFake(guardian), connection_id=CONNECTION, **options)


def user(text="refund order 42"):
    return types.Content(role="user", parts=[types.Part(text=text)])


class Harness:
    def __init__(self, model, plugins, *, tools=(refund_order, lookup_order), **agent_options):
        self.model = model
        agent = LlmAgent(name="billing", model=model, tools=list(tools), **agent_options)
        self.runner = Runner(
            app=App(name="billing_app", root_agent=agent, plugins=list(plugins)),
            session_service=InMemorySessionService(),
        )
        self.session = None

    async def send(self, message=None):
        if self.session is None:
            self.session = await self.runner.session_service.create_session(app_name="billing_app", user_id="u")
        events = []
        async for event in self.runner.run_async(
            user_id="u", session_id=self.session.id, new_message=message or user()
        ):
            events.append(event)
        return events


async def run(turns, *plugins, **options):
    harness = Harness(scripted(*turns), plugins, **options)
    await harness.send()
    return harness.model


CALL = ("refund_order", {"order_id": "o42", "amount_cents": 500})


def text_of(result):
    return result["error"]


async def test_allow_runs_the_tool_once_then_records_it():
    guardian = FakeClient(ALLOW)
    receipts = []
    model = await run([CALL], plugin(guardian, on_receipt=lambda t, r, rc: receipts.append((t, r))))
    assert ran == [("o42", 500)]
    assert model.results() == [{"status": "refunded o42"}]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    assert guardian.last_invocation["tool_name"] == "refund_order"
    assert guardian.last_invocation["arguments"] == {"order_id": "o42", "amount_cents": 500}
    assert receipts == [("refund_order", "req_allow")]


async def test_an_async_tool_runs_after_allow():
    guardian = FakeClient(ALLOW)
    model = await run([("lookup_order", {"order_id": "o42"})], plugin(guardian))
    assert ran == [("lookup", "o42")]
    assert model.results() == [{"order_id": "o42", "total_cents": 500}]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]


async def test_the_sync_runner_is_governed_too():
    guardian = FakeClient(DENIED)
    harness = Harness(scripted(CALL), [plugin(guardian)])
    session = harness.runner.session_service.create_session_sync(app_name="billing_app", user_id="u")
    import asyncio

    def drive():
        return list(harness.runner.run(user_id="u", session_id=session.id, new_message=user()))

    await asyncio.to_thread(drive)
    assert ran == []
    assert "Guardian denied refund_order (POLICY_DENY)" in text_of(harness.model.results()[0])


async def test_held_then_approved_runs_on_the_same_call():
    guardian = FakeClient(HELD, claims=[APPROVED])
    pending = []
    model = await run([CALL, CALL], plugin(guardian, on_approval_pending=lambda t, r: pending.append((t, r))))
    assert pending == [("refund_order", "req_ask")]
    held = model.results()[0]
    assert "held for human approval (request_id req_ask)" in held["error"]
    assert held["guardian"]["decision"] == "ASK" and held["guardian"]["request_id"] == "req_ask"
    # The second call claims the approved request instead of proposing a new one.
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask", "execute:req_ask"]
    assert ran == [("o42", 500)]
    assert model.results()[1] == {"status": "refunded o42"}


async def test_held_and_not_yet_approved_does_not_run_or_ask_twice():
    guardian = FakeClient(HELD)
    model = await run([CALL, CALL], plugin(guardian))
    assert ran == []
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask"]
    assert all("held for human approval" in text_of(result) for result in model.results())


async def test_held_then_declined_never_runs():
    guardian = FakeClient(HELD, claims=[DECLINED])
    model = await run([CALL, CALL], plugin(guardian))
    assert ran == []
    assert "Guardian denied refund_order (APPROVAL_DENIED)" in text_of(model.results()[1])
    assert "execute:req_ask" not in guardian.calls


async def test_denied_never_runs():
    guardian = FakeClient(DENIED)
    model = await run([CALL], plugin(guardian))
    assert ran == []
    assert model.results() == [
        {
            "error": "Guardian denied refund_order (POLICY_DENY). Do not retry the same call.",
            "guardian": {
                "decision": "DENY",
                "tool_name": "refund_order",
                "reason_code": "POLICY_DENY",
                "request_id": "req_d",
                "message": "Guardian denied refund_order (POLICY_DENY). Do not retry the same call.",
            },
        }
    ]


async def test_guardian_unreachable_fails_closed():
    guardian = FakeClient(UNREACHABLE)
    model = await run([CALL], plugin(guardian))
    assert ran == []
    assert "could not be reached to check refund_order" in text_of(model.results()[0])


async def test_a_guardian_client_that_raises_fails_closed():
    class Broken(FakeClient):
        def request(self, invocation):
            raise ConnectionError("network down")

    model = await run([CALL], plugin(Broken(ALLOW)))
    assert ran == []
    assert text_of(model.results()[0]) == "Guardian could not check refund_order, so it did not run. Try again later."
    assert model.results()[0]["guardian"]["reason_code"] == "SERVICE_UNAVAILABLE"


async def test_parallel_calls_in_one_model_turn_are_each_decided():
    class ByOrder(FakeClient):
        def request(self, invocation):
            super().request(invocation)
            order = invocation["arguments"]["order_id"]
            if order == "o2":
                return DENIED
            return RequestResult(ok=True, request_id=f"req_{order}", decision="ALLOW", capability_token="cap")

    guardian = ByOrder(ALLOW)
    turn = [
        ("refund_order", {"order_id": "o1", "amount_cents": 100}),
        ("refund_order", {"order_id": "o2", "amount_cents": 200}),
        ("lookup_order", {"order_id": "o3"}),
    ]
    model = await run([turn], plugin(guardian))
    assert sorted(ran, key=str) == [("lookup", "o3"), ("o1", 100)]
    assert sorted(guardian.calls) == [
        "execute:req_o1",
        "execute:req_o3",
        "request:tool.invoke",
        "request:tool.invoke",
        "request:tool.invoke",
    ]
    results = model.results()
    assert len(results) == 3
    assert {"status": "refunded o1"} in results and {"order_id": "o3", "total_cents": 500} in results
    assert sum("Guardian denied refund_order" in result.get("error", "") for result in results) == 1


async def test_amount_args_carry_the_declaration_and_the_amount():
    guardian = FakeClient(ALLOW)
    declaration = {"argument": "amount_cents", "unit": "minor", "currency": "usd"}
    await run([CALL], plugin(guardian, amount_args={"refund_order": declaration}))
    assert guardian.last_invocation["amount_argument"] == declaration
    assert guardian.last_invocation["value_cents"] == 500


async def test_tool_names_map_to_guardian_names():
    guardian = FakeClient(ALLOW)
    await run([CALL], plugin(guardian, tool_names={"refund_order": "billing.refund"}))
    assert guardian.last_invocation["tool_name"] == "billing.refund"


class Tamper(BasePlugin):
    """Changes the amount in its before-tool callback, like an argument-repair plugin would."""

    def __init__(self, amount):
        super().__init__(name=f"tamper_{amount}")
        self.amount = amount
        self.before = []
        self.after = []

    async def before_tool_callback(self, *, tool, tool_args, tool_context):
        self.before.append(tool.name)
        tool_args["amount_cents"] = self.amount

    async def after_tool_callback(self, *, tool, tool_args, tool_context, result):
        self.after.append((tool.name, dict(tool_args), result))


async def test_a_plugin_after_guardian_cannot_change_what_runs():
    guardian = FakeClient(ALLOW)
    later = Tamper(99_999)
    model = await run([CALL], plugin(guardian), later)
    # Guardian's plugin runs the tool itself with the decided arguments; the
    # later plugin's before-tool callback never sees the call.
    assert later.before == []
    assert ran == [("o42", 500)]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    assert model.results() == [{"status": "refunded o42"}]
    # Its after-tool callback still sees the call and the tool's result.
    assert later.after == [
        ("refund_order", {"order_id": "o42", "amount_cents": 500}, {"status": "refunded o42"})
    ]


async def test_a_plugin_before_guardian_is_decided_on():
    guardian = FakeClient(ALLOW)
    earlier = Tamper(700)
    await run([CALL], earlier, plugin(guardian))
    assert guardian.last_invocation["arguments"] == {"order_id": "o42", "amount_cents": 700}
    assert ran == [("o42", 700)]


async def test_a_plugin_before_guardian_that_answers_the_call_means_no_tool_and_no_proposal():
    class Answer(BasePlugin):
        def __init__(self):
            super().__init__(name="answer")

        async def before_tool_callback(self, *, tool, tool_args, tool_context):
            return {"status": "cached"}

    guardian = FakeClient(ALLOW)
    model = await run([CALL], Answer(), plugin(guardian))
    assert ran == [] and guardian.calls == []
    assert model.results() == [{"status": "cached"}]


async def test_an_after_tool_callback_can_replace_what_the_model_is_told_after_the_tool_ran():
    def after(tool, args, tool_context, tool_response):
        return {"status": "redacted"}

    guardian = FakeClient(ALLOW)
    model = await run([CALL], plugin(guardian), after_tool_callback=after)
    assert ran == [("o42", 500)]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    assert model.results() == [{"status": "redacted"}]


async def test_an_agent_before_tool_callback_cannot_change_what_runs():
    seen = []

    def tamper(tool, args, tool_context):
        seen.append(tool.name)
        args["amount_cents"] = 1

    guardian = FakeClient(ALLOW)
    await run([CALL], plugin(guardian), before_tool_callback=tamper)
    # Plugins run before the agent's own callbacks, and Guardian's answers the call.
    assert seen == []
    assert ran == [("o42", 500)]


async def test_after_tool_callbacks_still_run_and_see_guardians_refusal():
    seen = []

    def after(tool, args, tool_context, tool_response):
        seen.append((tool.name, tool_response.get("error", tool_response)))

    await run([CALL], plugin(FakeClient(ALLOW)), after_tool_callback=after)
    await run([CALL], plugin(FakeClient(DENIED)), after_tool_callback=after)
    assert seen == [
        ("refund_order", {"status": "refunded o42"}),
        ("refund_order", "Guardian denied refund_order (POLICY_DENY). Do not retry the same call."),
    ]
    assert ran == [("o42", 500)]


async def test_a_tool_that_changes_its_arguments_does_not_change_what_callbacks_see():
    def submit(payload: dict) -> dict:
        """Submit a payload."""
        payload.pop("invoice")
        ran.append("submitted")
        return {"status": "submitted"}

    guardian = FakeClient(ALLOW)
    receipts = []
    later = Tamper(0)
    model = await run(
        [("submit", {"payload": {"invoice": {"id": "INV-1"}, "lines": [1, 2]}})],
        plugin(guardian, on_receipt=lambda t, r, rc: receipts.append(r)),
        later,
        tools=(submit,),
    )
    assert ran == ["submitted"] and receipts == ["req_allow"]
    assert model.results() == [{"status": "submitted"}]
    assert later.after[0][1] == {"payload": {"invoice": {"id": "INV-1"}, "lines": [1, 2]}}


async def test_as_an_agent_callback_it_governs_that_agents_tools():
    guardian = FakeClient(ALLOW)
    callback = plugin(guardian).agent_before_tool_callback
    model = await run([CALL], before_tool_callback=callback)
    assert ran == [("o42", 500)]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    assert model.results() == [{"status": "refunded o42"}]

    ran.clear()
    denied = await run([CALL], before_tool_callback=plugin(FakeClient(DENIED)).agent_before_tool_callback)
    assert ran == []
    assert "Guardian denied refund_order" in text_of(denied.results()[0])


async def test_registered_both_ways_a_call_is_decided_once():
    guardian = FakeClient(ALLOW)
    both = plugin(guardian)
    await run([CALL], both, before_tool_callback=both.agent_before_tool_callback)
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    assert ran == [("o42", 500)]


async def test_a_failed_redemption_tells_the_model_not_to_call_again():
    guardian = FakeClient(ALLOW, execute_ok=False)
    errors = []
    model = await run([CALL], plugin(guardian, on_execution_error=errors.append))
    assert ran == [("o42", 500)]
    message = text_of(model.results()[0])
    assert "could not record it" in message and "Do not call it again" in message
    assert model.results()[0]["guardian"]["outcome"] == "ran_unrecorded"
    assert len(errors) == 1 and errors[0].local_effect_ran


def test_a_sync_client_is_refused():
    with pytest.raises(TypeError, match="AsyncGuardianClient"):
        GuardianPlugin(GuardianClient(credential="gak_test"), connection_id=CONNECTION)


def test_on_ask_takes_result_or_confirmation():
    with pytest.raises(ValueError, match="on_ask"):
        plugin(FakeClient(ALLOW), on_ask="stop")


# --- tools that are not plain functions ---------------------------------------


async def test_a_tool_that_returns_none_runs_once():
    def ping(order_id: str) -> None:
        """Ping an order."""
        ran.append(("ping", order_id))

    guardian = FakeClient(ALLOW)
    model = await run([("ping", {"order_id": "o42"})], plugin(guardian), tools=(ping,))
    assert ran == [("ping", "o42")]  # a None answer would make ADK run the tool again
    assert model.results() == [{"result": None}]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]


async def test_a_custom_base_tool_is_governed():
    class Ledger(BaseTool):
        def __init__(self):
            super().__init__(name="ledger_write", description="Write a ledger entry.")

        def _get_declaration(self):
            return types.FunctionDeclaration(
                name=self.name,
                description=self.description,
                parameters=types.Schema(
                    type=types.Type.OBJECT, properties={"entry": types.Schema(type=types.Type.STRING)}
                ),
            )

        async def run_async(self, *, args, tool_context):
            ran.append(("ledger", args["entry"]))
            return {"written": args["entry"]}

    call = ("ledger_write", {"entry": "refund o42"})
    guardian = FakeClient(ALLOW)
    model = await run([call], plugin(guardian), tools=(Ledger(),))
    assert ran == [("ledger", "refund o42")]
    assert model.results() == [{"written": "refund o42"}]
    assert guardian.last_invocation["tool_name"] == "ledger_write"

    ran.clear()
    await run([call], plugin(FakeClient(DENIED)), tools=(Ledger(),))
    assert ran == []


async def test_a_long_running_tool_is_decided_before_it_starts():
    def start_export(order_id: str) -> dict:
        """Start an export."""
        ran.append(("export", order_id))
        return {"status": "pending", "ticket": "t1"}

    call = ("start_export", {"order_id": "o42"})
    guardian = FakeClient(ALLOW)
    model = await run([call], plugin(guardian), tools=(LongRunningFunctionTool(start_export),))
    assert ran == [("export", "o42")]
    assert model.results() == [{"status": "pending", "ticket": "t1"}]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]

    ran.clear()
    await run([call], plugin(FakeClient(DENIED)), tools=(LongRunningFunctionTool(start_export),))
    assert ran == []


# ADK's AgentTool itself hands the plugins on through Runner's deprecated argument.
_agent_tool_warning = pytest.mark.filterwarnings("ignore:The `plugins` argument is deprecated:DeprecationWarning")


@_agent_tool_warning
async def test_a_sub_agents_tools_are_governed_through_an_agent_tool():
    guardian = FakeClient(ALLOW)
    inner = LlmAgent(name="refunder", model=scripted(CALL), tools=[refund_order])
    model = await run(
        [("refunder", {"request": "refund o42"})], plugin(guardian), tools=(AgentTool(agent=inner),)
    )
    assert ran == [("o42", 500)]
    # The call of the agent tool and the sub-agent's own tool call are each decided.
    assert guardian.calls == ["request:tool.invoke", "request:tool.invoke", "execute:req_allow", "execute:req_allow"]
    assert model.results() == [{"result": "done"}]


@_agent_tool_warning
async def test_a_sub_agents_denied_tool_does_not_run():
    class ByTool(FakeClient):
        def request(self, invocation):
            super().request(invocation)
            return DENIED if invocation["tool_name"] == "refund_order" else ALLOW

    guardian = ByTool(ALLOW)
    inner = LlmAgent(name="refunder", model=scripted(CALL), tools=[refund_order])
    await run([("refunder", {"request": "refund o42"})], plugin(guardian), tools=(AgentTool(agent=inner),))
    assert ran == []


async def test_a_transfer_and_the_sub_agents_tool_are_each_decided():
    class Recording(FakeClient):
        def request(self, invocation):
            self.tools = [*getattr(self, "tools", []), invocation["tool_name"]]
            return super().request(invocation)

    guardian = Recording(ALLOW)
    inner = LlmAgent(name="refunder", model=scripted(CALL), tools=[refund_order])
    await run(
        [("transfer_to_agent", {"agent_name": "refunder"})], plugin(guardian), tools=(), sub_agents=[inner]
    )
    # ADK's transfer is a tool call like any other; the plugin on the App
    # covers the sub-agent it hands over to.
    assert guardian.tools == ["transfer_to_agent", "refund_order"]
    assert ran == [("o42", 500)]


async def test_a_denied_transfer_does_not_hand_over():
    guardian = FakeClient(DENIED)
    inner = LlmAgent(name="refunder", model=scripted(CALL), tools=[refund_order])
    model = await run(
        [("transfer_to_agent", {"agent_name": "refunder"})], plugin(guardian), tools=(), sub_agents=[inner]
    )
    assert ran == [] and guardian.calls == ["request:tool.invoke"]
    assert "Guardian denied transfer_to_agent" in text_of(model.results()[0])


async def test_a_made_up_tool_name_is_left_to_adk():
    guardian = FakeClient(ALLOW)
    model = await run([("wire_money", {"amount_cents": 1})], plugin(guardian))
    assert guardian.calls == [] and ran == []
    assert "no tool with that name is available" in text_of(model.results()[0])


async def test_arguments_guardian_cannot_read_are_refused():
    guardian = FakeClient(ALLOW)

    class Poison(BasePlugin):
        def __init__(self):
            super().__init__(name="poison")

        async def before_tool_callback(self, *, tool, tool_args, tool_context):
            tool_args["amount_cents"] = float("nan")

    model = await run([CALL], Poison(), plugin(guardian))
    assert ran == [] and guardian.calls == []
    assert "was not proposed and did not run" in text_of(model.results()[0])


async def test_a_call_adk_answers_for_a_missing_argument_was_decided_and_recorded():
    # A documented limit: ADK checks a function tool's mandatory arguments
    # inside the tool step, after the decision. The function body does not
    # run, but for Guardian the allowed tool call happened.
    guardian = FakeClient(ALLOW)
    model = await run([("refund_order", {"order_id": "o42"})], plugin(guardian))
    assert ran == []
    assert "mandatory input parameters are not present" in text_of(model.results()[0])
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    assert guardian.last_invocation["arguments"] == {"order_id": "o42"}


# --- tool errors ---------------------------------------------------------------


def broken_refund(order_id: str) -> dict:
    """Refund an order (always fails)."""
    ran.append(("broken", order_id))
    raise ValueError("gateway down")


BROKEN = ("broken_refund", {"order_id": "o42"})


async def test_a_tool_error_is_not_recorded_and_ends_the_run():
    guardian = FakeClient(ALLOW)
    with pytest.raises(RuntimeError, match="gateway down") as raised:
        await run([BROKEN], plugin(guardian), tools=(broken_refund,))
    assert isinstance(raised.value.__cause__, ValueError)  # ADK wraps a plugin callback's error
    assert ran == [("broken", "o42")]
    assert guardian.calls == ["request:tool.invoke"]  # nothing redeemed


async def test_a_tool_error_reaches_on_tool_error_callbacks():
    class Recover(BasePlugin):
        def __init__(self):
            super().__init__(name="recover")
            self.errors = []

        async def on_tool_error_callback(self, *, tool, tool_args, tool_context, error):
            self.errors.append((tool.name, dict(tool_args), str(error)))
            return {"error": "the gateway is down"}

    guardian = FakeClient(ALLOW)
    recover = Recover()
    model = await run([BROKEN], plugin(guardian), recover, tools=(broken_refund,))
    assert recover.errors == [("broken_refund", {"order_id": "o42"}, "gateway down")]
    assert model.results() == [{"error": "the gateway is down"}]
    assert guardian.calls == ["request:tool.invoke"]


async def test_a_tool_error_reaches_the_agents_on_tool_error_callback():
    seen = []

    async def on_error(tool, args, tool_context, error):
        seen.append(str(error))
        return {"error": "handled by the agent"}

    model = await run(
        [BROKEN], plugin(FakeClient(ALLOW)), tools=(broken_refund,), on_tool_error_callback=on_error
    )
    assert seen == ["gateway down"]
    assert model.results() == [{"error": "handled by the agent"}]


# --- ADK tool confirmation -----------------------------------------------------


def confirmation_requests(events):
    return [
        call
        for event in events
        for call in event.get_function_calls()
        if call.name == CONFIRM
    ]


def confirm(request, confirmed=True):
    return types.Content(
        role="user",
        parts=[
            types.Part(
                function_response=types.FunctionResponse(
                    id=request.id, name=CONFIRM, response={"confirmed": confirmed}
                )
            )
        ],
    )


async def test_a_tool_that_requires_confirmation_is_held_before_guardian_is_asked():
    guardian = FakeClient(ALLOW)
    harness = Harness(scripted(CALL), [plugin(guardian)], tools=(FunctionTool(refund_order, require_confirmation=True),))
    events = await harness.send()
    requests = confirmation_requests(events)
    assert len(requests) == 1 and ran == [] and guardian.calls == []

    await harness.send(confirm(requests[0]))
    assert ran == [("o42", 500)]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]


async def test_a_rejected_confirmation_never_reaches_guardian_or_the_tool():
    guardian = FakeClient(ALLOW)
    harness = Harness(scripted(CALL), [plugin(guardian)], tools=(FunctionTool(refund_order, require_confirmation=True),))
    requests = confirmation_requests(await harness.send())
    await harness.send(confirm(requests[0], confirmed=False))
    assert ran == [] and guardian.calls == []


async def test_a_confirmation_check_that_raises_fails_closed():
    def needs_confirmation(order_id: str, amount_cents: int) -> bool:
        raise RuntimeError("policy store down")

    guardian = FakeClient(ALLOW)
    tool = FunctionTool(refund_order, require_confirmation=needs_confirmation)
    model = await run([CALL], plugin(guardian), tools=(tool,))
    assert ran == [] and guardian.calls == []
    assert model.results()[0]["guardian"]["reason_code"] == "CONFIRMATION_CHECK_FAILED"


async def test_on_ask_confirmation_pauses_the_run_and_resumes_on_the_approved_request():
    guardian = FakeClient(HELD, claims=[APPROVED])
    harness = Harness(scripted(CALL), [plugin(guardian, on_ask="confirmation")])
    events = await harness.send()
    requests = confirmation_requests(events)
    assert len(requests) == 1
    asked = requests[0].args["toolConfirmation"]
    assert "request_id req_ask" in asked["hint"]
    assert asked["payload"] == {"guardian": {"request_id": "req_ask", "tool_name": "refund_order"}}
    assert requests[0].args["originalFunctionCall"]["name"] == "refund_order"
    # The run paused: the model was not called again and nothing ran.
    assert ran == [] and harness.model.results() == []
    assert guardian.calls == ["request:tool.invoke"]

    # The person approved in Guardian; the app answers ADK's confirmation.
    await harness.send(confirm(requests[0]))
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask", "execute:req_ask"]
    assert ran == [("o42", 500)]
    assert harness.model.results() == [{"status": "refunded o42"}]


async def test_a_local_confirmation_does_not_stand_in_for_guardians_approval():
    # The person has not approved in Guardian when the app confirms in ADK.
    guardian = FakeClient(HELD, claims=[RequestResult(ok=False, request_id="req_ask", reason_code="APPROVAL_PENDING"), APPROVED])
    harness = Harness(scripted(CALL, CALL), [plugin(guardian, on_ask="confirmation")])
    first = confirmation_requests(await harness.send())
    events = await harness.send(confirm(first[0]))
    assert guardian.calls[:2] == ["request:tool.invoke", "claim:req_ask"]
    # Still held. ADK asks for one confirmation per call, so the model is
    # told the call is held, as with on_ask="result" ...
    assert confirmation_requests(events) == []
    assert "held for human approval (request_id req_ask)" in text_of(harness.model.results()[0])
    # ... and its next same call, made after the approval, claims the request.
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask", "claim:req_ask", "execute:req_ask"]
    assert ran == [("o42", 500)]


async def test_a_local_rejection_does_not_run_or_claim():
    guardian = FakeClient(HELD, claims=[APPROVED])
    harness = Harness(scripted(CALL), [plugin(guardian, on_ask="confirmation")])
    first = confirmation_requests(await harness.send())
    await harness.send(confirm(first[0], confirmed=False))
    assert ran == []
    assert guardian.calls == ["request:tool.invoke"]


# --- remote mode ---------------------------------------------------------------


async def test_remote_mode_guardian_performs_the_call_and_the_tool_body_does_not_run():
    guardian = FakeClient(ALLOW)
    receipts = []
    model = await run([CALL], plugin(guardian, mode="remote", on_receipt=lambda t, r, rc: receipts.append(rc)))
    assert ran == []
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]
    receipt = {"schemaVersion": 1, "requestId": "req_allow", "status": "sent-verified"}
    assert model.results() == [
        {"guardian": {"decision": "ALLOW", "request_id": "req_allow", "tool_name": "refund_order", "receipt": receipt}}
    ]
    assert receipts == [receipt]


async def test_remote_mode_per_tool():
    guardian = FakeClient(ALLOW)
    turn = [CALL, ("lookup_order", {"order_id": "o42"})]
    model = await run([turn], plugin(guardian, modes={"refund_order": "remote"}))
    assert ran == [("lookup", "o42")]  # the in-process tool ran; Guardian made the refund
    assert sorted(guardian.calls) == ["execute:req_allow", "execute:req_allow", "request:tool.invoke", "request:tool.invoke"]
    assert {"order_id": "o42", "total_cents": 500} in model.results()


async def test_remote_mode_held_denied_and_unreachable_do_nothing():
    for answer, text in (
        (HELD, "held for human approval"),
        (DENIED, "Guardian denied refund_order"),
        (UNREACHABLE, "could not be reached"),
    ):
        guardian = FakeClient(answer)
        model = await run([CALL], plugin(guardian, mode="remote"))
        assert ran == [] and guardian.calls == ["request:tool.invoke"]
        assert text in text_of(model.results()[0])


async def test_remote_mode_held_then_approved_is_performed_by_guardian():
    guardian = FakeClient(HELD, claims=[APPROVED])
    model = await run([CALL, CALL], plugin(guardian, mode="remote"))
    assert ran == []
    assert guardian.calls == ["request:tool.invoke", "claim:req_ask", "execute:req_ask"]
    assert model.results()[1]["guardian"]["receipt"]["requestId"] == "req_ask"


async def test_remote_mode_an_unverified_execution_is_not_reported_as_done():
    guardian = FakeClient(ALLOW, receipt_status="outcome-pending")
    model = await run([CALL], plugin(guardian, mode="remote"))
    assert ran == []
    result = model.results()[0]
    assert result["guardian"]["reason_code"] == "EXECUTION_OUTCOME_PENDING"
    assert "error" in result


async def test_remote_mode_a_refused_execution_is_not_reported_as_done():
    class Refusing(FakeClient):
        def execute(self, *, request_id, capability_token):
            self.calls.append(f"execute:{request_id}")
            return ExecuteResult(ok=False, reason_code="CAPABILITY_REVOKED")

    model = await run([CALL], plugin(Refusing(ALLOW), mode="remote"))
    assert ran == []
    assert model.results()[0]["guardian"]["reason_code"] == "CAPABILITY_REVOKED"


async def test_remote_mode_an_error_after_guardian_performed_the_call_is_not_reported_as_not_run():
    def on_receipt(tool_name, request_id, receipt):
        raise RuntimeError("receipt store down")

    guardian = FakeClient(ALLOW)
    model = await run([CALL], plugin(guardian, mode="remote", on_receipt=on_receipt))
    assert ran == []
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]  # Guardian performed it
    result = model.results()[0]
    assert result["guardian"]["reason_code"] == "EXECUTION_OUTCOME_UNKNOWN"
    assert "may have performed it" in text_of(result) and "Do not call it again" in text_of(result)
    assert "did not run" not in text_of(result)


def test_a_mistyped_mode_is_refused():
    with pytest.raises(ValueError, match="mode"):
        plugin(FakeClient(ALLOW), mode="Remote")
    with pytest.raises(ValueError, match="mode"):
        plugin(FakeClient(ALLOW), modes={"refund_order": "enforced"})


# --- generator (streaming) function tools ---------------------------------------


class Ordered(FakeClient):
    """Notes in ``ran`` when the capability is redeemed."""

    def execute(self, *, request_id, capability_token):
        ran.append("redeemed")
        return super().execute(request_id=request_id, capability_token=capability_token)


async def export_rows(table: str):
    """Export a table."""
    ran.append(("exported", table))
    yield {"rows": 3}


def export_rows_sync(table: str):
    """Export a table."""
    ran.append(("exported", table))
    yield {"rows": 3}


@pytest.mark.parametrize("tool", [export_rows, export_rows_sync])
async def test_a_generator_tool_is_consumed_before_the_capability_is_redeemed(tool):
    guardian = Ordered(ALLOW)
    model = await run([(tool.__name__, {"table": "invoices"})], plugin(guardian), tools=(tool,))
    # ADK runs the generator to its end inside the tool step of a run that is not live.
    assert ran == [("exported", "invoices"), "redeemed"]
    assert model.results() == [{"rows": 3}]


async def test_a_denied_generator_tool_never_starts():
    guardian = FakeClient(DENIED)
    await run([("export_rows", {"table": "invoices"})], plugin(guardian), tools=(export_rows,))
    assert ran == []


class Live(BasePlugin):
    """Marks the invocation as a live one, as ``Runner.run_live`` does."""

    def __init__(self):
        super().__init__(name="live")

    async def before_tool_callback(self, *, tool, tool_args, tool_context):
        from google.adk.agents.live_request_queue import LiveRequestQueue

        tool_context._invocation_context.live_request_queue = LiveRequestQueue()


async def test_a_generator_tool_in_a_live_run_is_refused_before_anything_is_proposed():
    guardian = FakeClient(ALLOW)
    model = await run([("export_rows", {"table": "invoices"})], Live(), plugin(guardian), tools=(export_rows,))
    assert ran == [] and guardian.calls == []
    result = model.results()[0]
    assert result["guardian"]["reason_code"] == "STREAMING_NOT_GOVERNED"
    assert "did not run" in text_of(result)


async def test_a_plain_tool_in_a_live_marked_run_is_still_governed():
    guardian = FakeClient(ALLOW)
    await run([CALL], Live(), plugin(guardian))
    assert ran == [("o42", 500)]
    assert guardian.calls == ["request:tool.invoke", "execute:req_allow"]


async def test_an_input_streaming_tool_is_refused():
    async def watch(order_id: str, input_stream=None):
        """Watch an order."""
        ran.append(("watch", order_id))
        yield {"seen": order_id}

    guardian = FakeClient(ALLOW)
    model = await run([("watch", {"order_id": "o42"})], plugin(guardian), tools=(watch,))
    assert ran == [] and guardian.calls == []
    assert model.results()[0]["guardian"]["reason_code"] == "STREAMING_NOT_GOVERNED"


async def test_a_generator_tool_in_remote_mode_is_performed_by_guardian():
    guardian = FakeClient(ALLOW)
    model = await run(
        [("export_rows", {"table": "invoices"})], Live(), plugin(guardian, mode="remote"), tools=(export_rows,)
    )
    assert ran == []
    assert model.results()[0]["guardian"]["receipt"]["requestId"] == "req_allow"


async def test_a_generator_tool_whose_stream_comes_back_unconsumed_is_not_recorded():
    class Lazy(FunctionTool):
        """Hands its stream back instead of running it, as ADK does in a live run."""

        async def run_async(self, *, args, tool_context):
            return self.func(**args)

    guardian = FakeClient(ALLOW)
    model = await run([("export_rows", {"table": "invoices"})], plugin(guardian), tools=(Lazy(export_rows),))
    assert ran == []
    assert guardian.calls == ["request:tool.invoke"]  # allowed, never redeemed
    result = model.results()[0]
    assert result["guardian"]["reason_code"] == "STREAMING_NOT_GOVERNED"
    assert "nothing ran and nothing was recorded" in text_of(result)
