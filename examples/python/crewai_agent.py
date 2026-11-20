"""crewai_agent.py — a crewAI accounts-payable agent pays supplier invoices, with
Guardian deciding before any money moves (the crewAI version of invoice_agent.py).

    $480 to a known supplier            → ALLOW: the tool runs, receipt recorded
    $12,400 to a known supplier         → ASK:   held; after a human approves, the same call runs
    $9,000 to a payee nobody approved   → DENY:  the tool never runs

Run:  pip install "odingard-guardian[crewai]" && python crewai_agent.py   (Python 3.10+)

The agent, the task, the crew and the tool-calling loop are crewAI's own. A
scripted model stands in for the LLM, so no API key is needed: it asks for one
pay_invoice call per invoice and calls again after an approval.

Labels are honest: [SIMULATED guardian] is a local demo policy, not Guardian.
Set GUARDIAN_AGENT_CREDENTIAL and GUARDIAN_CONNECTION_ID (and optionally
GUARDIAN_BASE_URL) to run the same tools against real hosted Guardian. Then
[LIVE guardian] is printed, your console policy decides, and ASK waits for a
real human. Hosted Guardian decides per tool (Allow or Ask); the $5k threshold
and payee rule are demo-policy only. The payment itself is simulated here;
swap in your own provider call.
"""

import json
import logging
import os
import secrets

os.environ.setdefault("CREWAI_DISABLE_TELEMETRY", "true")
os.environ.setdefault("CREWAI_TRACING_ENABLED", "false")
os.environ.setdefault("OTEL_SDK_DISABLED", "true")

from crewai import Agent, Crew, Task  # noqa: E402
from crewai.llms.base_llm import BaseLLM  # noqa: E402
from crewai.tools import tool  # noqa: E402

from odingard_guardian import DEFAULT_BASE_URL, ExecuteResult, GuardianClient, RequestResult  # noqa: E402
from odingard_guardian.crewai import guardian_tools  # noqa: E402

logging.getLogger("crewai").setLevel(logging.ERROR)  # the scripted model has no token counter

KNOWN_PAYEES = {"acme-supplies", "northwind-logistics"}
INVOICES = [
    ("INV-1001", "acme-supplies", 48_000),
    ("INV-1002", "acme-supplies", 1_240_000),
    ("INV-1003", "acme-supplies-new-bank", 900_000),
]


class DemoGuardian:
    """LOCAL demo policy — NOT Guardian. Mirrors a typical console policy."""

    def request(self, invocation):
        rid = f"req_{secrets.token_hex(8)}"
        if invocation["action"] != "tool.invoke":
            return RequestResult(ok=False, reason_code="TOOL_ALREADY_INSTALLED")
        args = invocation["arguments"]
        if args["payee_id"] not in KNOWN_PAYEES:
            return RequestResult(ok=True, request_id=rid, decision="DENY", reason_code="POLICY_DENY")
        if args["amount_cents"] > 500_000:
            return RequestResult(ok=False, request_id=rid, reason_code="APPROVAL_REQUIRED")
        return RequestResult(ok=True, request_id=rid, decision="ALLOW", capability_token=f"gcap.demo.{rid}")

    def claim(self, request_id):  # demo: the human's approval is simulated
        return RequestResult(ok=True, request_id=request_id, decision="ALLOW", capability_token="gcap.demo")

    def execute(self, *, request_id, capability_token):
        return ExecuteResult(ok=True, receipt={"schemaVersion": 1, "requestId": request_id, "demo": True})


credential = os.environ.get("GUARDIAN_AGENT_CREDENTIAL")
if credential:
    client = GuardianClient(credential=credential, base_url=os.environ.get("GUARDIAN_BASE_URL", DEFAULT_BASE_URL))
    connection_id = os.environ["GUARDIAN_CONNECTION_ID"]
    G = "[LIVE guardian]"
else:
    client, connection_id, G = DemoGuardian(), "con_demo", "[SIMULATED guardian]"


@tool("pay_invoice")
def pay_invoice(invoice_id: str, amount_cents: int, payee_id: str) -> str:
    """Pay a supplier invoice."""
    # Your payment code. Guardian only lets it run after ALLOW or human approval.
    print(f"  [SIMULATED payment] sim_{invoice_id} succeeded")
    return f"paid {invoice_id} (payment sim_{invoice_id})"


def approval_pending(tool_name, request_id):
    print(f"  {G} ASK → held, nothing paid yet (request_id {request_id})")


tools = guardian_tools(
    [pay_invoice],
    client,
    connection_id=connection_id,
    # LIVE: register pay_invoice once in the console as "My own code
    # (record-only)" and allow it for the agent.
    agent_name="ap-agent",
    purpose=lambda name, a: f"Pay invoice {a['invoice_id']}: ${a['amount_cents'] / 100:,.2f} to {a['payee_id']}",
    on_approval_pending=approval_pending,
    on_receipt=lambda name, request_id, receipt: print(f"  {G} ALLOW → receipt recorded ({request_id})"),
)


class ScriptedModel(BaseLLM):
    """Stands in for the LLM: one pay_invoice call per invoice, and the same
    call again after a held one was approved."""

    def __init__(self):
        super().__init__(model="scripted")
        self._todo = list(INVOICES)
        self._current = None
        self._retried = False

    def supports_function_calling(self):
        return True

    def _ask(self, invoice):
        invoice_id, payee_id, amount_cents = invoice
        arguments = {"invoice_id": invoice_id, "amount_cents": amount_cents, "payee_id": payee_id}
        call = {"name": "pay_invoice", "arguments": json.dumps(arguments)}
        return [{"id": f"call_{secrets.token_hex(4)}", "type": "function", "function": call}]

    def call(self, messages, tools=None, callbacks=None, available_functions=None, **kwargs):
        results = [str(m["content"]) for m in messages if m.get("role") == "tool"]
        last = results[-1] if results else ""
        if self._current and "held for human approval" in last and not self._retried:
            self._retried = True
            if credential:
                input(f"  {G} approve the request in the Guardian console, then press Enter…")
            else:
                print(f"  {G} human approves the exact invoice (simulated)…")
            return self._ask(self._current)  # the same call claims the approved request
        if self._current and "Guardian denied" in last:
            print(f"  {G} DENY → the payment code never ran")
        if not self._todo:
            return "All invoices were handled."
        self._current, self._retried = self._todo.pop(0), False
        invoice_id, payee_id, amount_cents = self._current
        print(f"\n→ pay {invoice_id}: ${amount_cents / 100:,.0f} to {payee_id}")
        return self._ask(self._current)


agent = Agent(
    role="Accounts payable agent",
    goal="Pay the open supplier invoices",
    backstory="You pay invoices with the pay_invoice tool.",
    llm=ScriptedModel(),
    tools=tools,  # the wrapped tools only
)
task = Task(description="Pay the open supplier invoices.", expected_output="A summary.", agent=agent)
result = Crew(agents=[agent], tasks=[task]).kickoff()
print(f"\nagent: {result.raw}")
