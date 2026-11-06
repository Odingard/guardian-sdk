"""invoice_agent.py — an accounts-payable agent pays supplier invoices, with
Guardian deciding before any money moves (Python version of invoice-agent.mjs).

    $480 to a known supplier            → ALLOW: your payment code runs, receipt recorded
    $12,400 to a known supplier         → ASK:   held until a human approves, then paid
    $9,000 to a payee nobody approved   → DENY:  your payment code never runs

Run:  pip install odingard-guardian && python invoice_agent.py

Labels are honest: [SIMULATED guardian] is a local demo policy, not Guardian.
Set GUARDIAN_AGENT_CREDENTIAL and GUARDIAN_CONNECTION_ID (and optionally
GUARDIAN_BASE_URL) to run the identical code against real hosted Guardian.
Then [LIVE guardian] is printed, your console policy decides, and ASK waits for
a real human. Hosted Guardian decides per tool (Allow or Ask); the $5k
threshold and payee rule are demo-policy only. The payment itself is
simulated here; swap in your own provider call.
"""

import os
import secrets
import time

from odingard_guardian import (
    DEFAULT_BASE_URL,
    ExecuteResult,
    Guard,
    GuardianApprovalPending,
    GuardianClient,
    GuardianDenied,
    RequestResult,
)

KNOWN_PAYEES = {"acme-supplies", "northwind-logistics"}


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

guard = Guard(
    client,
    connection_id=connection_id,
    # LIVE: register pay_invoice once in the console as "My own code
    # (record-only)" and allow it for the agent.
    agent_name="ap-agent",
    purpose=lambda tool, a: f"Pay invoice {a['invoice_id']}: ${a['amount_cents'] / 100:,.2f} to {a['payee_id']}",
)


@guard("pay_invoice")
def pay_invoice(invoice_id: str, amount_cents: int, payee_id: str):
    # Your payment code. Guardian only lets it run after ALLOW or human approval.
    return {"payment_id": f"sim_{invoice_id}", "status": "succeeded"}


def wait_for_human(held: GuardianApprovalPending):
    if not credential:
        print(f"  {G} human approves the exact invoice (simulated)…")
        return held.resume()
    print(f"  {G} approve request {held.request_id} in the Guardian console (polling for 5 min)…")
    for _ in range(60):
        time.sleep(5)
        try:
            return held.resume()
        except GuardianApprovalPending:
            continue
    raise TimeoutError("approval timed out; nothing was paid")


for invoice_id, payee_id, amount_cents in [
    ("INV-1001", "acme-supplies", 48_000),
    ("INV-1002", "acme-supplies", 1_240_000),
    ("INV-1003", "acme-supplies-new-bank", 900_000),
]:
    print(f"\n→ pay {invoice_id}: ${amount_cents / 100:,.0f} to {payee_id}")
    try:
        paid = pay_invoice(invoice_id, amount_cents, payee_id)
        print(f"  {G} ALLOW → [SIMULATED payment] {paid['payment_id']}; receipt recorded")
    except GuardianApprovalPending as held:
        print(f"  {G} ASK → held, nothing paid yet (request_id {held.request_id})")
        done = wait_for_human(held)
        print(f"  {G} approved → [SIMULATED payment] {done.output['payment_id']}; receipt recorded")
    except GuardianDenied as denied:
        print(f"  {G} DENY ({denied.reason_code}) → your payment code never ran")
