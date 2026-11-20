"""google_adk_agent.py — a Google ADK agent pays supplier invoices, with
Guardian's plugin deciding every tool call before it runs.

    $480 to a known supplier            → ALLOW: the tool runs, receipt recorded
    $12,400 to a known supplier         → ASK:   held; the same call after approval runs
    $9,000 to a payee nobody approved   → DENY:  the tool never runs

Run:  pip install "odingard-guardian[google-adk]" && python google_adk_agent.py

The agent loop is ADK's own (LlmAgent, App, Runner, InMemorySessionService).
Labels are honest: [SCRIPTED model] stands in for the LLM, so no API key is
needed, and [SIMULATED guardian] is a local demo policy, not Guardian.
Set GUARDIAN_AGENT_CREDENTIAL and GUARDIAN_CONNECTION_ID (and optionally
GUARDIAN_BASE_URL) to run the same agent against real hosted Guardian. Then
[LIVE guardian] is printed and your console policy decides: register
pay_invoice once as "My own code (record-only)" and allow it for the agent.
Hosted Guardian decides per tool (Allow or Ask); the $5k threshold and payee
rule are demo-policy only. The payment itself is simulated here.
"""

import asyncio
import logging
import os
import secrets

from google.adk.agents import LlmAgent
from google.adk.apps import App
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from odingard_guardian import DEFAULT_BASE_URL, AsyncGuardianClient, ExecuteResult, RequestResult
from odingard_guardian.google_adk import GuardianPlugin

logging.getLogger("google_adk").setLevel(logging.ERROR)  # the scripted model reports no token usage

KNOWN_PAYEES = {"acme-supplies", "northwind-logistics"}


class DemoGuardian:
    """LOCAL demo policy — NOT Guardian. Mirrors a typical console policy."""

    async def request(self, invocation):
        rid = f"req_{secrets.token_hex(8)}"
        args = invocation["arguments"]
        if args["payee_id"] not in KNOWN_PAYEES:
            return RequestResult(ok=True, request_id=rid, decision="DENY", reason_code="POLICY_DENY")
        if args["amount_cents"] > 500_000:
            return RequestResult(ok=False, request_id=rid, reason_code="APPROVAL_REQUIRED")
        return RequestResult(ok=True, request_id=rid, decision="ALLOW", capability_token=f"gcap.demo.{rid}")

    async def claim(self, request_id):  # demo: the human's approval is simulated
        return RequestResult(ok=True, request_id=request_id, decision="ALLOW", capability_token="gcap.demo")

    async def execute(self, *, request_id, capability_token):
        return ExecuteResult(ok=True, receipt={"schemaVersion": 1, "requestId": request_id, "demo": True})


INVOICES = [
    {"invoice_id": "INV-1001", "payee_id": "acme-supplies", "amount_cents": 48_000},
    {"invoice_id": "INV-1002", "payee_id": "acme-supplies", "amount_cents": 1_240_000},
    {"invoice_id": "INV-1002", "payee_id": "acme-supplies", "amount_cents": 1_240_000},  # again, after approval
    {"invoice_id": "INV-1003", "payee_id": "acme-supplies-new-bank", "amount_cents": 900_000},
]


class ScriptedModel(BaseLlm):
    """Stands in for the LLM: asks for one payment per turn, then finishes."""

    model: str = "scripted"
    script: list = []

    async def generate_content_async(self, llm_request, stream=False):
        if self.script:
            call = types.FunctionCall(name="pay_invoice", args=self.script.pop(0))
            parts = [types.Part(function_call=call)]
        else:
            parts = [types.Part(text="All invoices handled.")]
        yield LlmResponse(content=types.Content(role="model", parts=parts))


def pay_invoice(invoice_id: str, amount_cents: int, payee_id: str) -> dict:
    """Pay a supplier invoice."""
    # Your payment code. Guardian's plugin only runs it after ALLOW or human approval.
    return {"payment_id": f"sim_{invoice_id}", "status": "succeeded"}


async def main() -> None:
    credential = os.environ.get("GUARDIAN_AGENT_CREDENTIAL")
    if credential:
        client = AsyncGuardianClient(
            credential=credential, base_url=os.environ.get("GUARDIAN_BASE_URL", DEFAULT_BASE_URL)
        )
        connection_id, label = os.environ["GUARDIAN_CONNECTION_ID"], "[LIVE guardian]"
    else:
        client, connection_id, label = DemoGuardian(), "con_demo", "[SIMULATED guardian]"

    guardian = GuardianPlugin(
        client,
        connection_id=connection_id,
        agent_name="ap-agent",
        purpose=lambda tool, a: f"Pay invoice {a['invoice_id']}: ${a['amount_cents'] / 100:,.2f} to {a['payee_id']}",
        on_approval_pending=lambda tool, request_id: print(
            f"  {label} show request {request_id} to a person"
            + (" (approval simulated)" if not credential else " (approve it in the Guardian console)")
        ),
    )
    agent = LlmAgent(
        name="ap_agent",
        model=ScriptedModel(script=[dict(invoice) for invoice in INVOICES]),
        instruction="Pay the open supplier invoices.",
        tools=[pay_invoice],
    )
    # On the App, the plugin covers every agent and tool the runner drives.
    runner = Runner(
        app=App(name="accounts_payable", root_agent=agent, plugins=[guardian]),
        session_service=InMemorySessionService(),
    )
    session = await runner.session_service.create_session(app_name="accounts_payable", user_id="demo")
    message = types.Content(role="user", parts=[types.Part(text="Pay the open invoices.")])

    async for event in runner.run_async(user_id="demo", session_id=session.id, new_message=message):
        for call in event.get_function_calls():
            a = call.args
            print(f"\n→ [SCRIPTED model] pay {a['invoice_id']}: ${a['amount_cents'] / 100:,.0f} to {a['payee_id']}")
        for response in event.get_function_responses():
            result = response.response
            info = result.get("guardian")
            if info is None:
                print(f"  {label} ALLOW → [SIMULATED payment] {result['payment_id']}; receipt recorded")
            elif info["decision"] == "ASK":
                print(f"  {label} ASK → held, nothing paid yet (request_id {info['request_id']})")
            else:
                print(f"  {label} {info['decision']} ({info.get('reason_code')}) → your payment code never ran")
        if event.is_final_response() and event.content and event.content.parts and event.content.parts[0].text:
            print(f"\n[SCRIPTED model] {event.content.parts[0].text}")


asyncio.run(main())
