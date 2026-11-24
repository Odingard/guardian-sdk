"""openai_agents_agent.py — an OpenAI Agents SDK agent pays supplier invoices,
with Guardian deciding every tool call before it runs.

    $480 to a known supplier            → ALLOW: the tool runs, receipt recorded
    $12,400 to a known supplier         → ASK:   the run pauses (an Agents SDK
                                                 interruption) until a person
                                                 approves in Guardian, then pays
    $9,000 to a payee nobody approved   → DENY:  the tool never runs

From the repo root: pip install -e "./packages/python[openai-agents]"
                    python examples/python/openai_agents_agent.py

The agent, Runner.run, the tool call loop and the pause/resume are the Agents
SDK's own. Labels are honest: [SCRIPTED model] asks for the three payments in
turn instead of an LLM, so no API key is needed, and [SIMULATED guardian] is a
local demo policy, not Guardian. Set GUARDIAN_AGENT_CREDENTIAL and
GUARDIAN_CONNECTION_ID (and optionally GUARDIAN_BASE_URL) to run the same
tools against real hosted Guardian: then [LIVE guardian] is printed, your
console policy decides, and ASK waits for a real person. The payment itself
is simulated here; swap in your own provider call.
"""

import asyncio
import json
import os
import secrets

from agents import Agent, ModelResponse, Runner, Usage, set_tracing_disabled
from agents.models.interface import Model
from openai.types.responses import ResponseFunctionToolCall, ResponseOutputMessage, ResponseOutputText

from odingard_guardian import DEFAULT_BASE_URL, AsyncGuardianClient, ExecuteResult, RequestResult
from odingard_guardian.openai_agents import create_guardian_tool, guardian_request_id

set_tracing_disabled(True)  # this example sends nothing to OpenAI

KNOWN_PAYEES = {"acme-supplies", "northwind-logistics"}
INVOICES = [
    {"invoice_id": "INV-1001", "payee_id": "acme-supplies", "amount_cents": 48_000},
    {"invoice_id": "INV-1002", "payee_id": "acme-supplies", "amount_cents": 1_240_000},
    {"invoice_id": "INV-1003", "payee_id": "acme-supplies-new-bank", "amount_cents": 900_000},
]


class DemoGuardian:
    """LOCAL demo policy — NOT Guardian. Mirrors a typical console policy."""

    def __init__(self):
        self.approved = set()  # request ids a person approved (simulated below)

    async def request(self, invocation):
        rid = f"req_{secrets.token_hex(8)}"
        args = invocation["arguments"]
        if args["payee_id"] not in KNOWN_PAYEES:
            return RequestResult(ok=True, request_id=rid, decision="DENY", reason_code="POLICY_DENY")
        if args["amount_cents"] > 500_000:
            return RequestResult(ok=False, request_id=rid, reason_code="APPROVAL_REQUIRED")
        return RequestResult(ok=True, request_id=rid, decision="ALLOW", capability_token=f"gcap.demo.{rid}")

    async def claim(self, request_id):
        if request_id not in self.approved:
            return RequestResult(ok=False, request_id=request_id, reason_code="APPROVAL_PENDING")
        return RequestResult(ok=True, request_id=request_id, decision="ALLOW", capability_token="gcap.demo")

    async def execute(self, *, request_id, capability_token):
        return ExecuteResult(ok=True, receipt={"schemaVersion": 1, "requestId": request_id, "demo": True})


class ScriptedModel(Model):
    """Stands in for the LLM: asks to pay each invoice in turn, then sums up."""

    def __init__(self):
        self.todo = list(INVOICES)

    async def get_response(self, system_instructions, input, *args, **kwargs):
        if self.todo:
            invoice = self.todo.pop(0)
            n = len(INVOICES) - len(self.todo)
            print(f"\n→ [SCRIPTED model] pay_invoice({json.dumps(invoice)})")
            call = ResponseFunctionToolCall(
                type="function_call",
                id=f"fc_{n}",
                call_id=f"call_{n}",
                name="pay_invoice",
                arguments=json.dumps(invoice),
            )
            return ModelResponse(output=[call], usage=Usage(), response_id=None)
        # What the tool calls returned is what the model was told.
        for item in input:
            if isinstance(item, dict) and item.get("type") == "function_call_output":
                print(f"  model was told ({item['call_id']}): {item['output']}")
        text = ResponseOutputText(type="output_text", text="Paid what Guardian let through.", annotations=[])
        message = ResponseOutputMessage(
            id="msg_1", type="message", role="assistant", status="completed", content=[text]
        )
        return ModelResponse(output=[message], usage=Usage(), response_id=None)

    def stream_response(self, *args, **kwargs):
        raise NotImplementedError("this example does not stream")


credential = os.environ.get("GUARDIAN_AGENT_CREDENTIAL")
if credential:
    client = AsyncGuardianClient(credential=credential, base_url=os.environ.get("GUARDIAN_BASE_URL", DEFAULT_BASE_URL))
    connection_id = os.environ["GUARDIAN_CONNECTION_ID"]
    G = "[LIVE guardian]"
else:
    client, connection_id, G = DemoGuardian(), "con_demo", "[SIMULATED guardian]"

governed = create_guardian_tool(
    client,
    connection_id=connection_id,
    # LIVE: register pay_invoice once in the console as "My own code
    # (record-only)" and allow it for the agent.
    agent_name="ap-agent",
    purpose=lambda tool, a: f"Pay invoice {a['invoice_id']}: ${a['amount_cents'] / 100:,.2f} to {a['payee_id']}",
    on_ask="interrupt",  # a held call pauses the run, as an Agents SDK interruption
    # Whose call this is: read from what the app passes to Runner.run(context=...),
    # never from the tool call's arguments, which the model writes. A held call
    # is claimed only by the same call of the same session.
    scope=lambda context: context.context["session"],
    on_receipt=lambda tool, request_id, receipt: print(f"  {G} recorded {tool} ({request_id})"),
)


@governed
def pay_invoice(invoice_id: str, amount_cents: int, payee_id: str) -> str:
    """Pay a supplier invoice."""
    # Your payment code. It runs only after ALLOW, or after a person approved.
    print(f"  [SIMULATED payment] {invoice_id}: ${amount_cents / 100:,.2f} to {payee_id}")
    return f"paid {invoice_id} (payment sim_{invoice_id})"


async def wait_for_person(request_id):
    if not credential:
        print(f"  {G} a person approves request {request_id} (simulated)")
        client.approved.add(request_id)
        return
    print(f"  {G} approve request {request_id} in the Guardian console, then press Enter")
    await asyncio.to_thread(input)


async def main():
    agent = Agent(name="Accounts payable", model=ScriptedModel(), tools=[pay_invoice])
    session = "ap-clerk-7"  # your app knows who it runs the agent for; the model does not set this
    result = await Runner.run(agent, "Pay this week's invoices.", context={"session": session})
    while result.interruptions:
        # Guardian holds a call (ASK). Nothing ran; the run is paused.
        state = result.to_state()
        for held in result.interruptions:
            request_id = guardian_request_id(held, session)
            print(f"  {G} ASK → {held.name} is held, nothing paid yet (request_id {request_id})")
            await wait_for_person(request_id)
            # Approving here only lets the SDK invoke the call again. The tool
            # then claims Guardian's request and runs only if a person
            # approved it there.
            state.approve(held)
        result = await Runner.run(agent, state)
    print(f"\n{result.final_output}")
    if credential:
        await client.aclose()


asyncio.run(main())
