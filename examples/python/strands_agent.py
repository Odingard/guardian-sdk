"""strands_agent.py — a Strands agent pays supplier invoices, with Guardian
deciding before any tool runs.

    $480 to a known supplier            → ALLOW: the tool runs, receipt recorded
    $12,400 to a known supplier         → ASK:   the agent run pauses until a human approves
    $9,000 to a payee nobody approved   → DENY:  the tool never runs

Run:  pip install "odingard-guardian[strands]" && python strands_agent.py

The agent, its event loop and its hooks are Strands' own. Labels are honest:
[SCRIPTED model] stands in for a model provider, so no model API key or
cloud account is needed, and [SIMULATED guardian] is a local demo policy,
not Guardian. Set GUARDIAN_AGENT_CREDENTIAL and GUARDIAN_CONNECTION_ID (and
optionally GUARDIAN_BASE_URL) to send the same tool calls to real hosted
Guardian: then [LIVE guardian] is printed, your console policy decides, and
ASK waits for a real human. Hosted Guardian decides per tool (Allow or Ask);
the $5k threshold and payee rule are demo-policy only. The payment itself is
simulated here; swap in your own provider call and your own model.
"""

import json
import os
import secrets
import time

from strands import Agent, tool
from strands.models import Model

from odingard_guardian import DEFAULT_BASE_URL, ExecuteResult, GuardianClient, RequestResult
from odingard_guardian.strands import GuardianHookProvider

KNOWN_PAYEES = {"acme-supplies", "northwind-logistics"}


class DemoGuardian:
    """LOCAL demo policy — NOT Guardian. Mirrors a typical console policy."""

    def __init__(self):
        self.approved = set()

    def request(self, invocation):
        rid = f"req_{secrets.token_hex(8)}"
        args = invocation["arguments"]
        if args["payee_id"] not in KNOWN_PAYEES:
            return RequestResult(ok=True, request_id=rid, decision="DENY", reason_code="POLICY_DENY")
        if args["amount_cents"] > 500_000:
            return RequestResult(ok=False, request_id=rid, reason_code="APPROVAL_REQUIRED")
        return RequestResult(ok=True, request_id=rid, decision="ALLOW", capability_token=f"gcap.demo.{rid}")

    def claim(self, request_id):
        if request_id not in self.approved:
            return RequestResult(ok=False, request_id=request_id, reason_code="APPROVAL_PENDING")
        return RequestResult(ok=True, request_id=request_id, decision="ALLOW", capability_token="gcap.demo")

    def execute(self, *, request_id, capability_token):
        return ExecuteResult(ok=True, receipt={"schemaVersion": 1, "requestId": request_id, "demo": True})


class ScriptedModel(Model):
    """Stands in for a model provider: asks for one pay_invoice call per invoice, then stops."""

    def __init__(self, invoices):
        self.invoices = list(invoices)

    def update_config(self, **model_config):
        pass

    def get_config(self):
        return {}

    async def structured_output(self, output_model, prompt, system_prompt=None, **kwargs):
        raise NotImplementedError
        yield

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        yield {"messageStart": {"role": "assistant"}}
        if self.invoices:
            arguments = self.invoices.pop(0)
            tool_use = {"toolUseId": f"call_{arguments['invoice_id']}", "name": "pay_invoice"}
            yield {"contentBlockStart": {"start": {"toolUse": tool_use}}}
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": json.dumps(arguments)}}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
        else:
            yield {"contentBlockStart": {"start": {}}}
            yield {"contentBlockDelta": {"delta": {"text": "All invoices handled."}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}
        usage = {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0}
        yield {"metadata": {"usage": usage, "metrics": {"latencyMs": 0}}}


@tool
def pay_invoice(invoice_id: str, amount_cents: int, payee_id: str) -> str:
    """Pay a supplier invoice."""
    # Your payment code. It only runs after ALLOW or a person's approval.
    print(f"  [SIMULATED payment] sim_{invoice_id}: ${amount_cents / 100:,.0f} to {payee_id}")
    return f"paid {invoice_id}"


credential = os.environ.get("GUARDIAN_AGENT_CREDENTIAL")
if credential:
    client = GuardianClient(credential=credential, base_url=os.environ.get("GUARDIAN_BASE_URL", DEFAULT_BASE_URL))
    connection_id = os.environ["GUARDIAN_CONNECTION_ID"]
    G = "[LIVE guardian]"
else:
    client, connection_id, G = DemoGuardian(), "con_demo", "[SIMULATED guardian]"

guardian = GuardianHookProvider(
    client,  # a sync client: agent(...) below is a sync call
    connection_id=connection_id,
    # LIVE: register pay_invoice once in the console as "My own code
    # (record-only)" and allow it for the agent.
    agent_name="ap-agent",
    purpose=lambda tool_name, a: f"Pay invoice {a['invoice_id']}: ${a['amount_cents'] / 100:,.2f} to {a['payee_id']}",
    on_ask="interrupt",  # a held call pauses the agent run
    on_receipt=lambda tool_name, request_id, receipt: print(f"  {G} recorded {tool_name} ({request_id})"),
)

agent = Agent(
    model=ScriptedModel(
        [
            {"invoice_id": "INV-1001", "amount_cents": 48_000, "payee_id": "acme-supplies"},
            {"invoice_id": "INV-1002", "amount_cents": 1_240_000, "payee_id": "acme-supplies"},
            {"invoice_id": "INV-1003", "amount_cents": 900_000, "payee_id": "acme-supplies-new-bank"},
        ]
    ),
    tools=[pay_invoice],
    hooks=[guardian],
    callback_handler=None,
)

print("[SCRIPTED model] asks to pay INV-1001 ($480), INV-1002 ($12,400) and INV-1003 ($9,000, unknown payee)")
result = agent("Pay the open supplier invoices.")
waited = 0
while result.stop_reason == "interrupt":
    held = result.interrupts[0]
    request_id = held.reason["guardian"]["request_id"]
    print(f"  {G} ASK → the run is paused, nothing paid yet (request_id {request_id})")
    if not credential:
        print(f"  {G} human approves the exact invoice (simulated)…")
        client.approved.add(request_id)
    else:
        if waited >= 300:
            raise TimeoutError("approval timed out; the held invoice was not paid")
        print(f"  {G} approve request {request_id} in the Guardian console (checking again in 5 s)…")
        time.sleep(5)
        waited += 5
    # Resuming approves nothing by itself: the paused call claims the
    # request from Guardian, and pauses again while it is still held.
    result = agent([{"interruptResponse": {"interruptId": held.id, "response": "resume"}}])

for message in agent.messages:
    for block in message["content"]:
        if "toolResult" in block and block["toolResult"]["status"] == "error":
            print(f"  {G} tool result: {block['toolResult']['content'][0]['text']}")
print(f"[SCRIPTED model] {result.message['content'][0]['text']}")
