"""langchain_agent.py — a LangChain agent (langchain.agents.create_agent, on LangGraph)
pays supplier invoices, with Guardian deciding before each tool call runs.

    $480 to a known supplier            → ALLOW: the tool runs, receipt recorded
    $12,400 to a known supplier         → ASK:   the graph pauses (LangGraph interrupt) with the
                                                 request id; resuming runs it only after approval
    $9,000 to a payee nobody approved   → DENY:  the tool never runs; the model is told

From the repo root: pip install -e "./packages/python[langchain]"
                    python examples/python/langchain_agent.py

The agent loop, the ToolNode, the checkpointer and the interrupt are LangChain's and
LangGraph's own. The model is scripted (no API key): it asks for the three payments in
turn. Labels are honest: [SIMULATED guardian] is a local demo policy, not Guardian.
Set GUARDIAN_AGENT_CREDENTIAL and GUARDIAN_CONNECTION_ID (and optionally
GUARDIAN_BASE_URL) to run the same agent against real hosted Guardian. Then
[LIVE guardian] is printed, your console policy decides, and ASK waits for a real
person. Hosted Guardian decides per tool (Allow or Ask); the $5k threshold and the
payee rule are demo-policy only. The payment itself is simulated here.
"""

import os
import secrets
import time

from langchain.agents import create_agent
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from odingard_guardian import DEFAULT_BASE_URL, ExecuteResult, GuardianClient, RequestResult
from odingard_guardian.langchain import GuardianMiddleware

KNOWN_PAYEES = {"acme-supplies", "northwind-logistics"}


class DemoGuardian:
    """LOCAL demo policy — NOT Guardian. Mirrors a typical console policy."""

    def __init__(self):
        self.held = {}  # request id → approved?

    def request(self, invocation):
        rid = f"req_{secrets.token_hex(8)}"
        if invocation["action"] != "tool.invoke":
            return RequestResult(ok=False, reason_code="TOOL_ALREADY_INSTALLED")
        args = invocation["arguments"]
        if args["payee_id"] not in KNOWN_PAYEES:
            return RequestResult(ok=True, request_id=rid, decision="DENY", reason_code="POLICY_DENY")
        if args["amount_cents"] > 500_000:
            self.held[rid] = False
            return RequestResult(ok=False, request_id=rid, reason_code="APPROVAL_REQUIRED")
        return RequestResult(ok=True, request_id=rid, decision="ALLOW", capability_token=f"gcap.demo.{rid}")

    def approve(self, request_id):  # demo: stands in for the person in the Guardian console
        self.held[request_id] = True

    def claim(self, request_id):
        if self.held.get(request_id):
            return RequestResult(ok=True, request_id=request_id, decision="ALLOW", capability_token="gcap.demo")
        return RequestResult(ok=False, request_id=request_id, reason_code="APPROVAL_PENDING")

    def execute(self, *, request_id, capability_token):
        return ExecuteResult(ok=True, receipt={"schemaVersion": 1, "requestId": request_id, "demo": True})


class ScriptedModel(BaseChatModel):
    """Stands in for the model: asks for one payment per turn, then sums up."""

    invoices: list

    def bind_tools(self, tools, **kwargs):
        return self

    @property
    def _llm_type(self):
        return "scripted"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        if not self.invoices:
            return ChatResult(generations=[ChatGeneration(message=AIMessage(content="All three invoices handled."))])
        invoice_id, payee_id, amount_cents = self.invoices.pop(0)
        call = {
            "name": "pay_invoice",
            "args": {"invoice_id": invoice_id, "amount_cents": amount_cents, "payee_id": payee_id},
            "id": f"call_{invoice_id}",
            "type": "tool_call",
        }
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="", tool_calls=[call]))])


credential = os.environ.get("GUARDIAN_AGENT_CREDENTIAL")
if credential:
    client = GuardianClient(credential=credential, base_url=os.environ.get("GUARDIAN_BASE_URL", DEFAULT_BASE_URL))
    connection_id = os.environ["GUARDIAN_CONNECTION_ID"]
    G = "[LIVE guardian]"
else:
    client, connection_id, G = DemoGuardian(), "con_demo", "[SIMULATED guardian]"


@tool
def pay_invoice(invoice_id: str, amount_cents: int, payee_id: str) -> str:
    """Pay a supplier invoice."""
    # Your payment code. Guardian only lets it run after ALLOW or a person's approval.
    print(f"  [SIMULATED payment] sim_{invoice_id}: ${amount_cents / 100:,.2f} to {payee_id}")
    return f"paid {invoice_id} (payment sim_{invoice_id})"


guardian = GuardianMiddleware(
    client,
    connection_id=connection_id,
    # LIVE: register pay_invoice once in the console as "My own code
    # (record-only)" and allow it for the agent.
    agent_name="ap-agent",
    purpose=lambda tool_name, a: f"Pay invoice {a['invoice_id']}: ${a['amount_cents'] / 100:,.2f} to {a['payee_id']}",
    on_ask="interrupt",  # pause the graph on ASK; needs the checkpointer below
)

agent = create_agent(
    ScriptedModel(
        invoices=[
            ("INV-1001", "acme-supplies", 48_000),
            ("INV-1002", "acme-supplies", 1_240_000),
            ("INV-1003", "acme-supplies-new-bank", 900_000),
        ]
    ),
    [pay_invoice],
    middleware=[guardian],
    checkpointer=InMemorySaver(),
)
thread = {"configurable": {"thread_id": "ap-run-1"}}

print("→ pay INV-1001 ($480), INV-1002 ($12,400) and INV-1003 ($9,000 to an unknown payee)")
state = agent.invoke({"messages": [("user", "Pay this week's invoices.")]}, thread)

deadline = time.time() + 300
while state.get("__interrupt__"):
    held = state["__interrupt__"][0].value
    print(f"  {G} ASK → graph paused, nothing paid yet (request_id {held['request_id']}, {held['arguments']})")
    if not credential:
        # Resuming is not approving: the resume value is ignored, Guardian is asked again.
        state = agent.invoke(Command(resume={"approved": True}), thread)
        print(f"  {G} resumed before approval → still paused: {bool(state.get('__interrupt__'))}")
        print(f"  {G} a person approves the exact invoice (simulated)…")
        client.approve(held["request_id"])
    else:
        print(f"  {G} approve request {held['request_id']} in the Guardian console (checking every 5 s)…")
        time.sleep(5)
        if time.time() > deadline:
            raise TimeoutError("approval timed out; nothing was paid")
    state = agent.invoke(Command(resume=True), thread)

print("\nWhat the model was told about each call:")
for message in state["messages"]:
    if isinstance(message, ToolMessage):
        decision = (message.artifact or {}).get("guardian", {}).get("decision", "ALLOW")
        print(f"  {G} {decision}: {message.content}")
print(f"\nmodel: {state['messages'][-1].content}")
