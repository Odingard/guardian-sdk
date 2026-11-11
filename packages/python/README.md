# odingard-guardian: Guardian SDK for Python

**Human Authority Infrastructure for Autonomous AI.** The agent proposes and the
human decides. Every action your agent wants to take gets a deterministic
`ALLOW` / `ASK` / `DENY` decision from Guardian **before it runs**. `ASK`
waits for a human, and every execution produces a tamper-evident receipt you
can verify offline.

Hosted Guardian: [guardian.odingard.com](https://guardian.odingard.com). The
free tier needs no card.

```bash
pip install odingard-guardian
```

Python 3.9.2+. Dependencies: `httpx`, `cryptography`.

## Govern your own action code: `Guard`

Guardian does not need to ship a connector for your provider. Wrap the
function that performs the action (your Stripe call, your WhatsApp send,
your production deploy, your database write) and Guardian decides whether it may
run.

```python
import os
from odingard_guardian import (
    Guard, GuardianClient, GuardianApprovalPending, GuardianDenied,
)

client = GuardianClient(credential=os.environ["GUARDIAN_AGENT_CREDENTIAL"])  # gac1.… per agent
guard = Guard(client, connection_id=os.environ["GUARDIAN_CONNECTION_ID"])

@guard("pay_invoice")
def pay_invoice(invoice_id: str, amount_cents: int, payee_id: str):
    return stripe.PaymentIntent.create(amount=amount_cents, currency="usd", ...)  # your code

try:
    pay_invoice("INV-1002", 1_240_000, "acme-supplies")
except GuardianApprovalPending as held:      # ASK: nothing ran
    notify_approver(held.request_id)
    ...                                      # after the human approves:
    result = held.resume()                   # runs your function, records the receipt
except GuardianDenied as denied:             # DENY: your function never ran
    log.warning("blocked: %s", denied.reason_code)
```

| Decision  | What happens to your function                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| **ALLOW** | Runs once. Then the capability is redeemed and the receipt recorded (`on_receipt=` callback).                     |
| **ASK**   | Does not run. `GuardianApprovalPending.resume()` runs it after approval; before approval it raises pending again. |
| **DENY**  | Never runs. `GuardianDenied.reason_code` says why. An unreachable Guardian is a DENY (fail closed).               |

An unreachable Guardian, or one that answers with a server error (HTTP 5xx),
is refused with `reason_code` `SERVICE_UNAVAILABLE`: nothing ran, and it is
reported as Guardian not answering, not as a denial. An answer whose
`decision` is anything other than `ALLOW`, `ASK` or `DENY` is refused with
`MALFORMED_RESPONSE`.

The proposal carries the tool name plus the call's bound arguments
(`{"invoice_id": …, "amount_cents": …, "payee_id": …}`). The arguments are
bound into the action and the receipt, so an approval does not carry over to
changed arguments. Hosted Guardian decides Allow or Ask **per tool** today.
Amount thresholds and payee rules on argument values are not evaluated yet;
the invoice example shows them only under the local demo policy.

### async

```python
from odingard_guardian import AsyncGuardianClient, Guard

guard = Guard(AsyncGuardianClient(credential=...), connection_id=...)

@guard("send_whatsapp")
async def send_whatsapp(to: str, body: str): ...

await send_whatsapp("+15550100", "Your invoice is ready")
# held.resume() is awaitable for an async guard
```

### Give the decision back to the model instead of raising

```python
guard = Guard(client, connection_id=..., on_ask="result", on_deny="result")
# ASK/DENY now return {"guardian": {"decision": "ASK", "request_id": …, "message": …}}
# so a framework that turns tool output into model context can tell the model what happened.
# After a person approves, calling the tool again with the same arguments runs
# the approved request (it is claimed, not proposed again). Calling it again
# before then returns the same ASK and does not create a second approval.
# (0.1.6 and later. In 0.1.5 an approved call never ran in this mode.)
```

With `on_deny="result"` a call that ran but could not be confirmed is also
handed back as data instead of raising `GuardianExecutionFailed`. That covers
an in-process call whose receipt could not be recorded after your function
ran, and a `remote` call whose receipt status is not `sent-verified` (or whose
answer was lost). The result is
`{"guardian": {"decision": "ALLOW", "outcome": "ran_unrecorded" | "unknown", "message": …}}`,
and the message says the call ran (or may have run) and must not be called
again, because calling it again is a new request and can repeat the action.
Set `on_execution_failed="raise"` or `"result"` to choose this separately
from `on_deny`, and pass `on_execution_error=callback(error)` to see every
such `GuardianExecutionFailed` in your app (for example to open an incident),
in either mode.

### Framework recipes

`@guard(...)` returns an ordinary function, so register the guarded function
wherever your framework expects a tool. These are recipes, not separate
integrations, and they are not all tested to the same level:

- **LangChain / LangGraph** (tested against Guardian; production proof
  pending): `StructuredTool.from_function(pay_invoice)`, or `@tool` on top of
  `@guard`. Map `GuardianApprovalPending` to a LangGraph `interrupt`.
- **OpenAI Agents SDK** (tested against Guardian; production proof pending):

  ```python
  from agents import function_tool
  from odingard_guardian.openai_agents import guardian_failure_error_function

  guard = Guard(client, connection_id=..., on_ask="result", on_deny="result")
  tool = function_tool(pay_invoice, failure_error_function=guardian_failure_error_function)
  ```

  Use 0.1.6 or later, so an approved call runs when the model calls the tool
  again. `guardian_failure_error_function` replaces the Agents SDK's default,
  which answers every exception with "An error occurred while running the
  tool. Please try again." After a call that ran, that message makes the
  model call the tool again, and the action can happen twice. The Guardian
  version tells the model that a call ran or may have run
  (`GuardianExecutionFailed`) and must not be called again, that a denied
  call did not run, and re-raises `GuardianApprovalPending` so the pending
  approval reaches your code. Other errors keep the Agents SDK's message.
  `make_guardian_failure_error_function(on_execution_failed=..., fallback=...)`
  adds an incident hook and your own message for other errors. With the
  default `"raise"` the same function works, or pass
  `failure_error_function=None` so every exception reaches your code. Do not
  use the Agents SDK's default `failure_error_function` with a guarded tool.

- **CrewAI** (example, not yet tested): `@tool("Pay invoice")` on top of
  `@guard`.
- **Claude Agent SDK** (example, not yet tested): guard the handler, or put
  any MCP server behind `guardian-mcp proxy` (see the [MCP package](../mcp)).

### Honest limits

- **In-process mode is decision-gated.** Your function runs after ALLOW and
  before the capability is redeemed. A revocation in that window is detected
  after the effect and raised as `GuardianExecutionFailed(local_effect_ran=True)`
  (or returned as a result that says the call ran, with
  `on_execution_failed="result"`). Treat that as an incident. Where Guardian itself must perform the call, use
  `mode="remote"` with a tool registered in your Guardian connection.
- Guardian governs what goes through it. An agent or app that never calls
  Guardian is not governed by it.
- **First-run setup:**
  1. In the Guardian console, connect a tool server.
  2. Add your function as "My own code (record-only)" (for example
     `pay_invoice`).
  3. Allow it for the agent.

  Since 0.1.1, `Guard` does not try to register tools itself.
  `install_record_transport=True` turns that back on, but it is denied unless
  the agent's grant pins `mcp.install`, and it only works for a tool that has
  no entry yet. If Guardian answers that the tool is already registered, the
  call is refused (`RECORD_TRANSPORT_UNVERIFIED`) and nothing runs, because
  the existing entry may make an HTTP call. Which entries a `Guard`
  registered is kept in memory only, so a restarted process, another worker
  or a new `Guard` is refused that way even for an entry the SDK created
  itself; use the console-registered tool with the option off. Denials carry a `hint` with the next
  step, for example `GuardianDenied.hint`.

## Hermes Agent plugin: `odingard_guardian.hermes`

[Hermes Agent](https://github.com/NousResearch/hermes-agent) runs its
`pre_tool_call` plugin hook before every tool call. This package ships that
hook as the Hermes plugin `guardian`:

```yaml
# Hermes config.yaml (add guardian to plugins.enabled by hand)
plugins:
  enabled: [guardian]
  hook_callback_timeout: 130 # Hermes blocks a hook that runs longer; 130 s fits a 2-minute ASK
```

Set `GUARDIAN_AGENT_CREDENTIAL`, `GUARDIAN_CONNECTION_ID` (everyday tools) and
`GUARDIAN_HOOK_ASK_CONNECTION_ID` (tools that need approval) in Hermes'
environment. `python -m odingard_guardian.hermes` prints the console setup.

- ALLOW: the capability is redeemed, then Hermes runs the tool.
- ASK: the hook waits for a person (up to the 2-minute request window, and
  never past Hermes' hook timeout: every Guardian call, the redeem included,
  finishes inside it). Not approved in time: blocked. The same call retried
  in the same Hermes process claims the open request; nothing is carried
  across processes.
- Edits to Hermes' own settings (`$HERMES_HOME`) or to this package are
  routed as `hermes_config` (needs approval), and the credential is moved out
  of `os.environ` so tool subprocesses do not inherit it. Both are best
  effort; the example README says what they do not catch.
- DENY, missing settings, Guardian unreachable, a crash or a timeout: blocked
  (`{"action": "block", "message": ...}`), so the tool never runs.

Read-only tools (`read_file`, `search_files`, `web_search`, …) are not routed,
and anything outside Hermes' tool dispatch is not governed. Details, the
Hosted setup and the MCP recipe: [examples/hermes](../../examples/hermes/README.md).
Example, not yet tested against Guardian. The install step is unverified: in
the only real attempt, `hermes plugins enable guardian` answered that the
plugin was "not installed or bundled". Install `odingard-guardian` into the
same Python environment Hermes runs in, list `guardian` under
`plugins.enabled` in `config.yaml` yourself, and check that Hermes loads it
before relying on it.

## Lower-level client

```python
from odingard_guardian import GuardianClient, classify_request_result

client = GuardianClient(credential=..., base_url="https://guardian-api.odingard.com")
result = client.request({
    "action": "tool.invoke",
    "connection_id": "con_…",
    "tool_name": "refund_order",
    "arguments": {"orderId": "ord_123"},
})
d = classify_request_result(result)
if d.decision == "ALLOW":
    client.execute(request_id=d.request_id, capability_token=d.capability_token)
elif d.decision == "ASK":
    ...  # keep d.request_id; client.claim(d.request_id) after the human approves
```

The request goes to `client.request`, `client.claim`, `client.execute`,
`client.receipts` and `client.portable_receipt`. It is sent as the same
canonical action proposal the TypeScript SDK sends.

## Verify a receipt offline

No account, credential or Guardian service is needed once you have the
published keys:

```python
from odingard_guardian import fetch_receipt_verification_keys, verify_receipt_offline

keys = fetch_receipt_verification_keys("https://guardian-api.odingard.com")["keys"]
receipt = client.portable_receipt(request_id).receipt   # client: your GuardianClient
verify_receipt_offline(receipt, keys)
# {"valid": True, "decision": "ALLOW", "effect": "verified", "subject": {...}}
# or {"valid": False, "reasonCode": "SIGNATURE_INVALID" | "EVIDENCE_CHAIN_INVALID" | ...}
```

The verifier checks the Ed25519 signature over the guardian-canonical-json.v1
body, then re-derives every evidence record's hash and link, the authority
lifecycle order, and every embedded object (decision, approval, capability,
execution, effect). Its results and reason codes match the TypeScript SDK on
the golden fixtures in `tests/fixtures/` (generated by
`scripts/gen-fixtures.ts`). The receipt envelope is schema-checked at the top
level. Nested records are covered by the signature and digest re-derivation
rather than a field-by-field schema.

## Verify before acting (for whoever receives the request)

An allowlist trusts the sender. When an agent asks your service to move
money, check **the request** instead: is it exactly the action a person
allowed, unchanged?

```python
from odingard_guardian import fetch_receipt_status, verify_before_acting

base = "https://guardian-api.odingard.com"
verdict = verify_before_acting(
    receipt,
    keys,                                   # fetch_receipt_verification_keys(base)
    {
        "action": "api.request",
        "material_parameters": request_you_received,  # method, url, headers, body
        "value_cents": 100,                 # what you are about to move
        "merchant_id": "your-merchant-id",  # you, as the destination
        "currency": "usd",
    },
    seen_request_ids=already_served,        # one authorization moves money once
    status=lambda r: fetch_receipt_status(base, r),  # still in force right now?
)
if not verdict["ok"]:
    refuse(verdict["reasonCode"], verdict["detail"])
```

It returns OK only if **all** of these hold:

- the receipt is valid offline;
- the request you received equals the authorized action field for field;
- Guardian allowed it, or a person approved it;
- a capability was issued, and it is not revoked, expired or used;
- amount, destination and currency match;
- it is fresh (default 5 minutes);
- you have not already acted on it.

`api.request` cannot declare an amount, so pass `"amount_field": "amount"`
(Stripe's form field) to read it from the signed request body instead. With
no declared amount, Guardian checked it against no cap, so it is accepted
only when a person approved the request.

The body is read only for a known JSON or form content type; anything else
is refused.

Its verdicts match the TypeScript `verifyBeforeActing` on 79 golden cases
(`tests/fixtures/verify-before-acting.json`, generated by
`scripts/gen-vba-fixtures.ts`).

## Development

```bash
cd packages/python
uv venv && uv pip install -e ".[test]"
.venv/bin/python -m pytest
# regenerate cross-language fixtures (from the repo root, after npm install):
npm run fixtures:python
```

Apache-2.0.
