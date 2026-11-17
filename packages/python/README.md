<img src="https://raw.githubusercontent.com/Odingard/guardian-sdk/main/assets/guardian-mark.svg" alt="Guardian" width="48" height="48" />

# odingard-guardian: Guardian SDK for Python

**Guardian is the trust layer for agent commerce.** Human Authority Infrastructure for Autonomous AI: the agent proposes; the human decides.

Every action your agent wants to take gets a deterministic
`ALLOW` / `ASK` / `DENY` decision from Guardian **before it runs**. `ASK`
waits for a human, and every execution produces a signed, tamper-evident
decision record you can verify offline.

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

client = GuardianClient(credential=os.environ["GUARDIAN_AGENT_CREDENTIAL"])  # gak_… per agent
guard = Guard(client, connection_id=os.environ["GUARDIAN_CONNECTION_ID"])

@guard("pay_invoice")
def pay_invoice(invoice_id: str, amount_cents: int, payee_id: str):
    return stripe.PaymentIntent.create(amount=amount_cents, currency="usd", ...)  # your code

try:
    pay_invoice("INV-1002", 1_240_000, "acme-supplies")
except GuardianApprovalPending as held:      # ASK: nothing ran
    notify_approver(held.request_id)
    ...                                      # after the human approves:
    result = held.resume()                   # runs your function, records the decision
except GuardianDenied as denied:             # DENY: your function never ran
    log.warning("blocked: %s", denied.reason_code)
```

| Decision  | What happens to your function                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| **ALLOW** | Runs once. Then the capability is redeemed and the signed record kept (`on_receipt=` callback).                   |
| **ASK**   | Does not run. `GuardianApprovalPending.resume()` runs it after approval; before approval it raises pending again. |
| **DENY**  | Never runs. `GuardianDenied.reason_code` says why. An unreachable Guardian is refused too (fail closed).          |

An unreachable Guardian, or one that answers with a server error (HTTP 5xx),
is refused with `reason_code` `SERVICE_UNAVAILABLE`: nothing ran, and it is
reported as Guardian not answering, not as a denial. With the default
`on_deny="raise"` it raises `GuardianUnavailable` (a subclass of
`GuardianDenied`, so `except GuardianDenied` still catches it), whose text
says Guardian could not be reached and the call did not run. An answer whose
`decision` is anything other than `ALLOW`, `ASK` or `DENY` is refused with
`MALFORMED_RESPONSE`.

The proposal carries the tool name plus the call's bound arguments
(`{"invoice_id": …, "amount_cents": …, "payee_id": …}`). The arguments are
bound into the action and its signed record, so an approval does not carry over to
changed arguments. Hosted Guardian decides Allow or Ask **per tool** today.
Amount thresholds and payee rules on argument values are not evaluated yet;
the invoice example shows them only under the local demo policy.

### Pin the contents of file arguments: `file_args` (0.2.0)

Approval binds the exact arguments. A file path is an argument; the file's contents are not, unless you declare the argument in `file_args`.

With `file_args`, the SDK on your machine reads the file, puts its SHA-256 in the approved arguments, and checks it again just before the tool runs. Guardian's servers never see the file. If the file changed, the call is refused with `GuardianExecutionFailed` (`reason_code="CONTENT_CHANGED_SINCE_APPROVAL"`, `local_effect_ran=False`): your function does not run and a new approval is needed.

```python
from odingard_guardian import PinnedFile

@guard("send_report", file_args=["attachment_path"])  # no mode named: bytes
def send_report(to: str, attachment_path: PinnedFile):
    return mailer.send(to=to, attachment=attachment_path.data)

send_report("ops@example.com", "/srv/reports/q3.pdf")

# Guard.run takes a zero-argument fn, so it supports "recheck" only:
guard.run("send_report", {"attachment_path": p}, lambda: send(p), file_args={"attachment_path": "recheck"})
```

- **`bytes` is the default when you don't name a mode.** `file_args=["attachment_path"]` (or `{"attachment_path": True}`) means `bytes`: your function receives the verified bytes themselves, so there is no gap between the check and the read. Name `"copy"` or `"recheck"` only when a function needs a path; explicit modes work as before. Any other value (`False`, an unknown mode, a name listed twice) is refused when the function is decorated (`CONTENT_PIN_INVALID_ARGUMENT`).
- `bytes` passes your function the verified bytes (a frozen `PinnedFile` with `path`, `name`, `data`, `size`, `sha256`; `data` is not in its `repr`, and it has no `__fspath__`, so it cannot be reopened by accident). `copy` passes a private copy; another process running as the same user could still change it, and the copy is deleted when your function returns, so a function that keeps using the path afterwards (for example a background upload) must use `bytes`. `recheck` checks the file and then lets your function open it, so a short window remains.
- `Guard.run` supports `recheck` only; use the `@guard` decorator for `bytes` and `copy`. A file argument declared on `Guard.run` without a mode means `bytes`, so it is refused there (`CONTENT_PIN_INVALID_ARGUMENT`) rather than checked in a weaker mode; name `"recheck"`.
- A `file_args` key must name a parameter of the function (not one that comes from `*args` or `**kwargs`). For such a tool the bound arguments are deep-copied when the call is proposed, and the function is called on that copy, so a mutable argument changed while the call waits does not reach it. `Guard.run` with `file_args` deep-copies the `arguments` you pass in the same way (your zero-argument `fn` is not affected). An argument `copy.deepcopy` cannot copy is refused before proposal (`CONTENT_PIN_INVALID_ARGUMENT`). Tools without `file_args` are not copied.
- A declared argument passed as `None` is refused before proposal (`CONTENT_PIN_INVALID_ARGUMENT`), as `null` is in TypeScript. A declared argument left out (a key missing from `Guard.run` arguments, or a decorated parameter the caller does not pass whose default is `None`) is not pinned and is left out of the proposal, and the function gets its default. A declared parameter with any other default is pinned like a passed value.
- File paths must be absolute. The SDK does not resolve relative paths or `~`.
- `file_args` needs in-process mode; with `mode="remote"` Guardian runs the tool and cannot read your files, so it is refused when the function is decorated (`CONTENT_PIN_REMOTE_MODE`).
- Content pinning is supported on Linux and macOS. On Windows a declared file argument is refused (`CONTENT_PIN_UNSUPPORTED_PLATFORM`).
- **Digest privacy:** the SHA-256 of each pinned file is sent to Guardian, shown to the approver and kept in the signed decision record. For a small or low-entropy file (a token, a PIN, a short config value), anyone who sees the digest can guess the contents offline by hashing candidates. Do not pin files like that, or treat the digest as sensitive as the file.
- This stops a changed file from running under an approval given for different contents. It does not protect against code that bypasses the SDK.
- `GuardianApprovalPending.arguments` is your call without pins; `proposed_arguments` is what was proposed. For a `file_args` tool both are copies: changing them does not change what is checked or what your function receives.
- The OpenAI Agents helper works with `@guard(file_args=...)` tools unchanged, and tells the model a refused call did not run.

#### Show the approver the first lines of the file: `preview` (0.3.0, opt-in)

```python
@guard(
    "send_report",
    file_args={"attachment_path": {"mode": "bytes", "preview": True, "previewRoots": ["/srv/reports"]}},
)  # mode defaults to "bytes"; previewRoots limits previews to these folders
def send_report(to: str, attachment_path: PinnedFile) -> str: ...
```

- **Opt-in, per argument.** Only the dict form with `"preview": True` sends a preview; the short forms (`["attachment_path"]`, `{"attachment_path": True}`, a mode string) never do. A `preview` that is not `True` or `False`, a `"mode"` that is not a mode (`None` included; leave the key out for `"bytes"`), any key other than `"mode"`, `"preview"` and `"previewRoots"`, or bad `"previewRoots"` is refused when the function is decorated (`CONTENT_PIN_INVALID_ARGUMENT`). `Guard.run` takes it with `"mode": "recheck"` only, as for any declaration there.
- **What is sent,** computed from the same bytes that are hashed: for a text file (valid UTF-8, no NUL byte, not a known binary type) `{"kind": "text", "mediaType", "size", "text", "truncated"}` with the **first 20 lines, at most 2,048 bytes**, cut on a character boundary, control, bidi and zero-width characters replaced with U+FFFD and CRLF read as LF; for any other file `{"kind": "binary", "mediaType", "size"}` and no content; for a file outside the `"previewRoots"` folders `{"kind": "withheld", "size"}`. The same preview as the TypeScript SDK, byte for byte.
- **The agent picks the file, not you.** Without `"previewRoots"`, **any file the agent process can read may be previewed** if the agent names it in that argument (for example `~/.aws/credentials` or a `.env` file after a prompt injection). Set `"previewRoots"` to the folders the tool is meant to send from (1 to 16 absolute paths; symbolic links resolved, and on Linux the file's path is taken from the descriptor that was read); any other file keeps its pin but its preview is `withheld`.
- **Privacy: the preview text leaves your machine.** It is sent inside the proposed arguments, shown to the approver and stored with the approval and in the decision record like any other argument, also when the approver denies the call. Without it only the name, size and digest leave your machine.
- **Display only.** The check before the function runs compares the size and SHA-256, as before. Previews count toward the 16 KB arguments limit; over it the call is refused (`CONTENT_PIN_TOO_MANY`).
- `content_preview(name, data)` returns the preview for bytes you hold; `normalize_file_arg_preview_roots(tool_name, file_args)` returns the folders per argument. `PREVIEW_MAX_LINES` is 20, `PREVIEW_MAX_BYTES` 2,048 and `PREVIEW_MAX_ROOTS` 16.

### Dollar amounts on tools: `amount_args` (unreleased)

An owner can put a dollar limit on a tool in the Guardian console: allow up to an amount, ask a person above it, and block above a maximum. The owner names the argument that holds the amount. Pass the same declaration in `amount_args`, keyed by the tool name:

```python
guard = Guard(
    client,
    connection_id=...,
    amount_args={
        # exactly as set on the tool in the Guardian console
        "purchase": {"argument": "amount_cents", "unit": "minor", "currency": "usd"},
    },
)

@guard("purchase")
def purchase(sku: str, amount_cents: int): ...

purchase("mug-1", 2000)  # $20.00
```

- Each call of that tool carries the declaration and the amount in cents, and Guardian decides on the amount. In in-process mode your function runs the tool, so the limit applies to Guardian's decision and its record, not to what your code runs.
- The same reading as the TypeScript SDK (`readToolAmount`), checked against golden files generated from it: `unit: "minor"` is cents (`2000` or `"2000"`); `unit: "major"` is dollars, a whole number (`20`) or text with up to two decimals (`"19.99"`). A number with cents (`19.99`), a sign, `$`, commas, spaces, leading zeros or an exponent cannot be read. Optional `"currencyArgument"` and `"allowedArguments"` work as in the [SDK README](../sdk/README.md#dollar-amounts-on-tools--amountargs-06).
- A call whose amount cannot be read is sent without an amount, Guardian refuses it before any decision, and nothing runs; `GuardianDenied.hint` names the argument. A declaration that differs from the console's is refused the same way.
- An invalid declaration raises `TypeError` when the `Guard` is built.
- Every tool on a connection needs an amount (or none does); put tools that spend money on their own connection.

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
an in-process call whose execution could not be recorded after your function
ran, and a `remote` call whose recorded status is not `sent-verified` (or whose
answer was lost). The result is
`{"guardian": {"decision": "ALLOW", "outcome": "ran_unrecorded" | "ran_unconfirmed" | "unknown", "message": …}}`,
and the message says the call ran (or may have run) and must not be called
again, because calling it again is a new request and can repeat the action.

When Guardian's answer to the final redemption is lost (no answer, a 5xx, an
unreadable answer), the SDK looks the request up (`client.receipts`). A
verified execution is reported as success, with its signed record (`on_receipt`
gets it). If the lookup does not settle it, `GuardianExecutionFailed` has
`reason_code="EXECUTION_OUTCOME_UNKNOWN"`, `outcome_unknown=True` and what was
observed in `detail` (such as `SERVICE_UNAVAILABLE`); its text says the call
ran (in-process, `local_effect_ran=True`) or may have run (remote), not to
retry, and which request to check. In result mode its outcome is
`ran_unconfirmed` (in-process) or `unknown` (remote).
Set `on_execution_failed="raise"` or `"result"` to choose this separately
from `on_deny`, and pass `on_execution_error=callback(error)` to see every
such `GuardianExecutionFailed` in your app (for example to open an incident),
in either mode.

### Framework recipes

`@guard(...)` returns an ordinary function, so register the guarded function
wherever your framework expects a tool. These are recipes, not separate
integrations:

- **LangChain / LangGraph**: `StructuredTool.from_function(pay_invoice)`, or `@tool` on top of
  `@guard`. Map `GuardianApprovalPending` to a LangGraph `interrupt`.
- **OpenAI Agents SDK**:

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

- **CrewAI** (example): `@tool("Pay invoice")` on top of
  `@guard`.
- **Microsoft Agent Framework** and **Semantic Kernel**: use the middleware and
  the filter below, which decide every function call the agent makes.
- **Claude Agent SDK** (example): guard the handler, or put
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

## Microsoft Agent Framework: `odingard_guardian.agent_framework` (unreleased)

[Microsoft Agent Framework](https://learn.microsoft.com/agent-framework/overview/)
runs function middleware around each tool call in its function-calling loop.
`GuardianFunctionMiddleware` sends each call to Guardian before the tool runs.

```bash
pip install "odingard-guardian[agent-framework]"   # Python 3.11+
```

```python
import os
from agent_framework import Agent, tool
from odingard_guardian import AsyncGuardianClient
from odingard_guardian.agent_framework import GuardianFunctionMiddleware

@tool
def refund_order(order_id: str, amount_cents: int) -> str:
    """Refund an order."""
    return billing.refund(order_id, amount_cents)  # your code

guardian = GuardianFunctionMiddleware(
    AsyncGuardianClient(credential=os.environ["GUARDIAN_AGENT_CREDENTIAL"]),
    connection_id=os.environ["GUARDIAN_CONNECTION_ID"],
    agent_name="billing-agent",
    amount_args={"refund_order": {"argument": "amount_cents", "unit": "minor", "currency": "usd"}},
)
agent = Agent(client=..., tools=[refund_order], middleware=[guardian])
```

| Decision                | What happens                                                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ALLOW**               | The tool runs once, with the arguments Guardian decided on. Then the capability is redeemed and the decision recorded.                                                                                                              |
| **ASK**                 | The tool does not run. The model is told the call is held for a person. After the person approves in the Guardian console, the same call (same tool, same arguments) runs the approved request; before then it does not ask again. |
| **DENY**                | The tool does not run, and the model is told it was refused and not to retry.                                                                                                                                                       |
| **Guardian unreachable** | The tool does not run (fail closed), and the model is told Guardian could not check it.                                                                                                                                             |

- `on_ask="stop"` or `on_deny="stop"` also stops the agent run, with Guardian's message as the tool result. `on_approval_pending=callback(tool_name, request_id)` lets your app show a held call to a person.
- Guardian decides on the arguments as Agent Framework validated them for the tool (for example `"500"` for an `int` parameter is proposed as `500`), and the tool runs with them.
- **Put Guardian's middleware last** in the list, after any middleware that repairs or changes arguments: middleware after it runs between the decision and the tool. If one changes the arguments, the run is aborted with `MiddlewareFailure` when the tool returns (the tool has run by then), and Guardian records no execution for that call. Middleware passed to `agent.run(middleware=...)` runs after the agent's own.
- If Guardian allowed the call and the tool ran but redeeming the capability failed, the model is told the tool ran and not to call it again.
- `tool_names={"refund_order": "billing.refund"}` (or a function) maps Agent Framework function names to Guardian tool names. Register each tool once in the Guardian console as "My own code (record-only)" and allow it for the agent.
- Agent Framework's own `approval_mode="always_require"` adds a local approval step before Guardian is asked; it does not replace Guardian's decision.
- Not covered: tools the model provider runs itself (hosted tools), and anything that does not go through Agent Framework's function-calling loop. Put MCP servers behind `guardian-mcp` (see the [MCP package](../mcp)).
- Tested with `agent-framework-core` 1.26.0 in a real agent loop with a scripted model and a stand-in Guardian. Before relying on it, run one governed tool with your model against your Guardian and check that an Ask waits for approval.

## Semantic Kernel: `odingard_guardian.semantic_kernel` (unreleased)

[Semantic Kernel](https://learn.microsoft.com/semantic-kernel/concepts/enterprise-readiness/filters)
runs function invocation filters around each kernel function call, including
the calls the model asks for through automatic function calling.

```bash
pip install "odingard-guardian[semantic-kernel]"   # Python 3.11+
```

```python
from semantic_kernel.filters import FilterTypes
from odingard_guardian import AsyncGuardianClient
from odingard_guardian.semantic_kernel import GuardianFunctionInvocationFilter

guardian = GuardianFunctionInvocationFilter(
    AsyncGuardianClient(credential=os.environ["GUARDIAN_AGENT_CREDENTIAL"]),
    connection_id=os.environ["GUARDIAN_CONNECTION_ID"],
)
kernel.add_filter(FilterTypes.FUNCTION_INVOCATION, guardian)  # add it after your other filters
```

- The decisions work as in the Agent Framework table above: ALLOW runs the native function once with the arguments Guardian decided on; ASK, DENY and an unreachable Guardian do not run it, and the function result tells the model why. After approval, the same call runs the approved request.
- The Guardian tool name is Semantic Kernel's fully qualified name, `plugin-function` (for example `billing-refund_order`); `tool_names` maps it to another name. The proposal carries the function's own parameters, not other kernel arguments.
- Prompt functions pass through without a decision: they call the model, and each native function the model then asks for is decided. A streaming call of a native function (`invoke_stream`) is refused, because the function would run after the filter returns.
- Filters added later run closer to the function. If one of them changes the arguments after Guardian decided, the call raises when the function returns, and Guardian records no execution for it.
- Tested with `semantic-kernel` 1.47.0 through the kernel's own automatic function-calling path, with a stand-in Guardian.

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
- Guardian's answer to the redeem lost (no answer, a 5xx, an unreadable
  answer): the hook looks the request up in Guardian. Recorded as verified:
  the tool runs. Aborted: blocked as `EXECUTION_NOT_SENT`. Otherwise blocked
  as `EXECUTION_OUTCOME_UNKNOWN`, and the agent is told nothing ran, not to
  retry, and which request to check in the console.

Read-only tools (`read_file`, `search_files`, `web_search`, …) are not routed,
and anything outside Hermes' tool dispatch is not governed. Details, the
Hosted setup and the MCP recipe: [examples/hermes](../../examples/hermes/README.md).
Install `odingard-guardian` into the
same Python environment Hermes runs in, list `guardian` under
`plugins.enabled` in `config.yaml` yourself, and check that Hermes loads it
before relying on it.

Hermes does not pin the contents of files its tools read. The path is bound; the file's bytes are not. (Hermes runs the tool itself after the hook returns, so there is no point just before it runs where the SDK could check the file. The `write_file`/`patch` `contentDigest` covers the call's own arguments, such as the new text the agent supplies, not the file on disk.)

## Lower-level client

```python
from odingard_guardian import GuardianClient, classify_request_result

client = GuardianClient(credential=..., base_url="https://guardian-api.odingard.com")
result = client.request({
    "action": "tool.invoke",
    "connection_id": "pcn_…",
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

## Verify a decision offline

No account, credential or Guardian service is needed once you have the
published keys:

```python
from odingard_guardian import fetch_receipt_verification_keys, verify_receipt_offline

keys = fetch_receipt_verification_keys("https://guardian-api.odingard.com")["keys"]
record = client.portable_receipt(request_id).receipt    # client: your GuardianClient
verify_receipt_offline(record, keys)
# {"valid": True, "decision": "ALLOW", "effect": "verified", "subject": {...}}
# or {"valid": False, "reasonCode": "SIGNATURE_INVALID" | "EVIDENCE_CHAIN_INVALID" | ...}
```

The verifier checks the Ed25519 signature over the guardian-canonical-json.v1
body, then re-derives every evidence record's hash and link, the authority
lifecycle order, and every embedded object (decision, approval, capability,
execution, effect). Its results and reason codes match the TypeScript SDK on
the golden fixtures in `tests/fixtures/` (generated by
`scripts/gen-fixtures.ts`). The record's envelope is schema-checked at the top
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
    record,                                 # the signed decision record the agent sent you
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

- the record is valid offline;
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
