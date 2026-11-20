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

### Dollar amounts on tools: `amount_args` (0.5.0)

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

### Watch mode (unreleased, opt-in)

While the agent is in watch mode (the console's **Start watching**), Guardian records what it would have decided for each action and blocks nothing at that step. For a call it would have asked about or denied, it issues no capability and performs nothing. With `watch_mode=True`, `Guard` then runs an in-process function anyway: its `file_args` are still checked, and there is nothing to record. `on_watched` tells you when that happened:

```python
guard = Guard(
    client,
    connection_id=os.environ["GUARDIAN_CONNECTION_ID"],
    watch_mode=True,
    on_watched=lambda tool, request_id, decision: print(tool, request_id, decision),
)
```

Without `watch_mode`, such a call raises `GuardianDenied` and the function does not run. A `remote` tool is never run this way: Guardian performs nothing for it. Outside watch mode nothing changes.

### async

```python
from odingard_guardian import AsyncGuardianClient, Guard

guard = Guard(AsyncGuardianClient(credential=...), connection_id=...)

@guard("send_whatsapp")
async def send_whatsapp(to: str, body: str): ...

await send_whatsapp("+15550100", "Your invoice is ready")
# held.resume() is awaitable for an async guard
```

### Generator tools: streams (unreleased)

Calling a generator function runs none of its body, so a guarded generator is decided and recorded around its iteration, not around the call:

```python
@guard("export_rows")
def export_rows(table: str):
    for row in read(table):   # your code
        yield row

stream = export_rows("invoices")   # nothing asked, nothing run
for row in stream:                 # Guardian is asked here, before the first row
    ...
# the stream ended: the capability is redeemed and the receipt recorded
```

`@guard` on a generator function gives a generator function (`inspect.isgeneratorfunction` stays true). Under an async guard it gives an async generator function, for `async def` generators and for sync ones: `async for row in export_rows(...)`.

| When                                      | What happens                                                                                                                                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The first item is requested               | Guardian is asked. The body starts only after ALLOW.                                                                                                                                                      |
| **ASK**, **DENY**, Guardian unreachable   | Raised on that first request; the body never runs. With `on_ask="result"` / `on_deny="result"` the decision is the stream's only item.                                                                    |
| After approval                            | `held.resume()` returns the stream as `output`, with `receipt=None`: it runs when you consume it, and `on_receipt` gets the receipt then. In result mode, call the tool again with the same arguments.     |
| The stream ends                           | The capability is redeemed and the receipt recorded (`on_receipt`).                                                                                                                                       |
| The consumer closes it early              | `close()`, `aclose()`, or leaving the loop and dropping the stream: the body is closed, then the capability is redeemed and the receipt recorded. The body ran in part, so Guardian records the call.      |
| The body raises                           | The error reaches the consumer and nothing is redeemed, as for a function that raises.                                                                                                                    |
| The redemption fails after the stream     | `GuardianExecutionFailed(local_effect_ran=True)` is raised after the last item (from `close()` for a stream closed early). With `on_execution_failed="result"` it is the stream's last item; for a closed stream only `on_execution_error` sees it. |
| `mode="remote"`                           | The body never runs. The stream's only item is Guardian's result.                                                                                                                                         |

Only a generator function is a stream: `@guard` on one, or one passed as `fn` to `guard.run(...)`. A function that *returns* a generator is an ordinary call. Its own body has run when it returns, so the capability is redeemed then, also when nobody consumes what it returned, and the generator is handed back as it is. A sync guard refuses an async generator function with a `TypeError` (use an `AsyncGuardianClient`).

Limits:

- What an ordinary function returns is data, whatever it is (a generator, a list, a file object, a `map`): it is returned as it is, and the capability is redeemed when the function returns. If the returned generator is where the action happens, make the tool a generator function.
- A stream dropped without `close()` is redeemed when Python collects it, which can be late, and not at all if the process exits first. Close a stream you abandon.
- With `file_args`, the files are checked once, just before the body starts, not between items. A private copy (`"copy"`) is kept until the stream has ended and its body has closed, also for a stream that is dropped midway; a stream that is dropped before it started deletes it at once.
- Before this change a guarded generator function was redeemed when the generator object was created, before any of its body ran, and a stream that failed was recorded as a success.

In Semantic Kernel, `invoke()` consumes a generator function before the filter's step returns, so it is recorded after it ran. Agent Framework does not iterate a tool's generator, so Guardian's middleware refuses a generator tool before anything is proposed.

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

### Held requests are scoped per session (unreleased)

With `on_ask="result"` the `Guard` remembers a held request, so that the same call made again after approval claims it. It is remembered by connection, tool name and arguments. When one `Guard` serves several users or conversations, say which session each call belongs to, so that a held request is claimed only by the same call in the same session:

```python
import contextvars

session = contextvars.ContextVar("session")   # your app sets it per request
guard = Guard(client, connection_id=..., on_ask="result", on_deny="result", scope=session.get)

# or for one call:
guard.run("refund_order", {"order_id": "o42"}, do_refund, scope=authenticated_user_id)
```

- A scope is any hashable value (a user id, a conversation id, a tuple). It is part of an in-memory key only and is not sent to Guardian.
- **The scope must come from data your application sets** (the authenticated user, the session of the request), never from the tool call's arguments or anything else the model writes: a model could then name another session's scope.
- A request held under one scope is claimed only by the same call under the same scope. An identical call under another scope is proposed as its own request and needs its own approval.
- **Without a scope, one `Guard` must serve one principal** (one user, one conversation): an identical call from anywhere claims the held request. This is the behaviour of earlier versions.
- `SCOPE_UNKNOWN` (from `odingard_guardian`) is the scope of a call whose session is not known: its held request is not remembered, so no later call can claim it and every call proposes its own. The result then says that calling again asks for a new approval.
- A `scope` function that raises, or a scope that cannot be hashed, raises before anything is proposed.
- A `scope` function that returns `None` (a `ContextVar` your app has not set yet) means the session is not known: the call is treated as `SCOPE_UNKNOWN`, not as unscoped. An empty string as a scope, from the function or given with the call, is a missing id and is treated the same; other falsy values such as `0` are scopes. `guard.run(..., scope=None)` means "use the Guard's `scope` function"; only a `Guard` without a `scope` function is unscoped.
- With `on_ask="raise"` nothing is remembered: `GuardianApprovalPending.resume()` claims that call's own request, whatever the scope.

The LangChain / LangGraph integration, the Agent Framework middleware and the Semantic Kernel filter below scope held requests themselves.

### Framework recipes

`@guard(...)` returns an ordinary function, so register the guarded function
wherever your framework expects a tool. These are recipes, not separate
integrations:

- **LangChain / LangGraph**: use the integration below
  ([`odingard_guardian.langchain`](#langchain-and-langgraph-odingard_guardianlangchain-unreleased)):
  governed tools, agent middleware, and ASK as a LangGraph `interrupt`.
- **OpenAI Agents SDK**: use `guardian_tool` / `create_guardian_tool`
  ([below](#openai-agents-sdk-odingard_guardianopenai_agents-unreleased)),
  which make each tool a governed `FunctionTool`. To keep `@guard` on the
  function instead:

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

- **CrewAI**: `@tool("Pay invoice")` on top of `@guard`. A recipe only: this
  repository has no CrewAI example or test yet.
- **Microsoft Agent Framework** and **Semantic Kernel**: use the middleware and
  the filter below, which decide every function call the agent makes.
- **Claude Agent SDK**: guard the handler of a tool you define, or put
  any MCP server behind `guardian-mcp proxy` (see the [MCP package](../mcp)).
  A recipe only: this repository has no Python Claude Agent SDK example or
  test yet.

### Honest limits

- **In-process mode is decision-gated.** Your function runs after ALLOW and
  before the capability is redeemed. A revocation in that window is detected
  after the effect and raised as `GuardianExecutionFailed(local_effect_ran=True)`
  (or returned as a result that says the call ran, with
  `on_execution_failed="result"`). Treat that as an incident. Where Guardian itself must perform the call, use
  `mode="remote"` with a tool registered in your Guardian connection. What remote mode does, needs and does
  not support, also for Agent Framework and Semantic Kernel: [Enforced mode](../../docs/guides.md#enforced-mode-guardian-makes-the-call-remote).
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

## LangChain and LangGraph: `odingard_guardian.langchain` (unreleased)

[LangChain](https://docs.langchain.com/oss/python/langchain/overview) agents
(`langchain.agents.create_agent`) and [LangGraph](https://docs.langchain.com/oss/python/langgraph/overview)
graphs run the tools a model asks for. `odingard_guardian.langchain` sends each
of those calls to Guardian before the tool runs.

```bash
pip install "odingard-guardian[langchain]"   # Python 3.11+
```

```python
import os
from langchain.agents import create_agent
from langchain_core.tools import tool
from odingard_guardian import GuardianClient
from odingard_guardian.langchain import GuardianMiddleware

@tool
def refund_order(order_id: str, amount_cents: int) -> str:
    """Refund an order."""
    return billing.refund(order_id, amount_cents)  # your code

guardian = GuardianMiddleware(
    GuardianClient(credential=os.environ["GUARDIAN_AGENT_CREDENTIAL"]),
    connection_id=os.environ["GUARDIAN_CONNECTION_ID"],
    agent_name="billing-agent",
    amount_args={"refund_order": {"argument": "amount_cents", "unit": "minor", "currency": "usd"}},
)
agent = create_agent(model, [refund_order], middleware=[guardian])  # list Guardian's middleware last
```

There are three ways to put it in place. They take the same options and can
share one `GuardianGate`:

| Where                                 | How                                                                                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any tool (`bind_tools`, any graph)    | `guardian_tool(tool, client, connection_id=...)`, or `guardian_tools([...], client, connection_id=...)`: a `BaseTool` with the same name, description and schema |
| `create_agent(..., middleware=[...])` | `GuardianMiddleware(client, connection_id=...)`: every tool call of the agent (`wrap_tool_call` / `awrap_tool_call`)                                             |
| LangGraph `ToolNode`                  | `gate = GuardianGate(client, connection_id=...)`, then `ToolNode(tools, wrap_tool_call=gate.wrap_tool_call, awrap_tool_call=gate.awrap_tool_call)`               |

| Decision                 | What happens                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ALLOW**                | The tool runs once, with the arguments Guardian decided on. Then the capability is redeemed and the decision recorded. The model gets the tool's own result.                                                                                            |
| **ASK**                  | The tool does not run. `on_ask="result"` (default): the model is told the call is held for a person; after the person approves, the same call (same tool, same arguments) in the same thread runs the approved request. `on_ask="interrupt"`: the graph pauses, see below. |
| **DENY**                 | The tool does not run. The model gets `Guardian denied refund_order (POLICY_DENY). Do not retry the same call.` in a `ToolMessage` with `status="error"`.                                                                                               |
| **Guardian unreachable** | The tool does not run (fail closed), and the model is told Guardian could not check it.                                                                                                                                                                 |

**Held requests are scoped per session.** A held call is remembered for the
LangGraph thread it was made in, `config["configurable"]["thread_id"]`: the
same call (same tool, same arguments) in the same thread claims the approved
request, and an identical call in another thread is proposed as its own
request and needs its own approval. One `GuardianGate`, middleware or
governed tool can therefore serve many conversations.

- The thread id is what your application passes when it invokes the graph
  (`agent.invoke(..., {"configurable": {"thread_id": "order-42"}})`). It
  reaches the tool in its run config, not in the tool call, so the model
  cannot write it. A string is used as it is, a number as its string form.
- `scope=callback(config)` names the session yourself, from the tool's run
  config: for example `scope=lambda config: config["metadata"]["user_id"]`.
  It replaces the thread id. **Take the scope from data your application
  sets** (the authenticated user, the request's session), never from the
  tool call's arguments or anything else the model writes.
- **With no thread id and no `scope`** (a graph invoked without a thread id,
  a bare `tool.invoke(args)`), the session is not known: the held request is
  not remembered, the same call again is proposed as a new request, and the
  message says so. The same holds when `scope` returns `None` or an empty
  string, raises, or returns something that cannot be a key. `0` is a scope.
  With `on_ask="interrupt"` such a call does not pause the graph (a resume
  could never claim its request); the model is told it is held.
- The scope is part of an in-memory key and is not sent to Guardian. See
  [Held requests are scoped per session](#held-requests-are-scoped-per-session-unreleased).

When the model gets Guardian's message in place of the tool's result, the
`ToolMessage` carries the decision in `message.artifact["guardian"]`
(`decision`, `tool_name`, `reason_code`, `request_id`), so your app can read
the request id without parsing text.

### Pause the graph on ASK: `on_ask="interrupt"`

```python
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

agent = create_agent(
    model,
    [refund_order],
    middleware=[GuardianMiddleware(client, connection_id=..., on_ask="interrupt")],
    checkpointer=InMemorySaver(),  # interrupts need a checkpointer
)
thread = {"configurable": {"thread_id": "order-42"}}

state = agent.invoke({"messages": [("user", "Refund order 42")]}, thread)
held = state["__interrupt__"][0].value
# {"type": "guardian_approval", "decision": "ASK", "request_id": "req_…", "tool_name": "refund_order",
#  "tool": "refund_order", "tool_call_id": "…", "arguments": {...}, "message": "…"}

# Show held["request_id"] to the person; they approve it in Guardian. Then:
state = agent.invoke(Command(resume=True), thread)
```

- A held call pauses the graph with LangGraph's `interrupt`. The Guardian
  `request_id` and the proposed arguments are in the interrupt payload.
- **Resuming is not approving.** On resume the call claims its request from
  Guardian. If a person approved it, the tool runs once. If it is still
  pending, nothing runs and the graph pauses again with the same
  `request_id`. If the person declined, the model is told the call was
  denied. The resume value is not read: nothing in it can stand in for
  Guardian's approval. Pass any value other than `None`.
- The graph needs a checkpointer. Without one the run still stops at the
  held call and nothing runs, but LangGraph cannot resume it.
- When several calls of one model turn are held, LangGraph asks for a resume
  value per interrupt: `Command(resume={interrupt.id: True for interrupt in state["__interrupt__"]})`.
  Each call still needs its own approval.
- **Several tool calls in one node.** LangGraph runs an interrupted node
  again from its start when the graph resumes, so everything the node did
  before the pause happens again. `create_agent` is not affected: it runs
  each tool call as its own task, and a pause belongs to the held call
  alone. A hand-built graph whose `ToolNode` gets all of a model turn's tool
  calls at once is affected, so there a governed call pauses the graph only
  while no governed call of that node has started to act:
  - If another governed call of the node already ran (or is running), the
    held call does not pause. The model is told it is held, as with
    `on_ask="result"`, and the same call after approval runs the approved
    request. Nothing runs twice.
  - If the held call pauses first, governed calls of the node that have not
    started yet do not run in that pass. They are proposed again when the
    graph resumes and run then, once.
  - This covers tools behind Guardian (any `GuardianGate` in the process).
    A tool in the same `ToolNode` that is **not** behind Guardian is run
    again by LangGraph on resume, as with any interrupt. Use
    `gate.wrap_tool_call` on the `ToolNode` so every call of the node is
    governed, or send each tool call to the node on its own (`Send`), as
    `create_agent` does.
- Which request a paused call waits for is kept in the process's memory. If
  another process resumes the thread (a restart, another worker), the call
  is proposed again and pauses with a new `request_id` that needs its own
  approval. It never runs on the earlier resume.
- **A tool that calls `interrupt()` itself and a call that needs approval
  do not go together.** LangGraph runs such a tool again from the start
  when the graph resumes, and Guardian decides on that run again. A person's
  approval is used once, so it cannot wait for the tool's own pause: the
  next run would need a new approval, then stop at the tool's question
  again, without end. So when a tool that started under an approved request
  (after ASK, with `on_ask="interrupt"` or `"result"`) calls `interrupt()`,
  the pause is not passed on. The call ends there, the model gets an error
  `ToolMessage` saying it was approved, started and did not complete
  (`reason_code` `INTERRUPT_AFTER_APPROVAL`), and a warning is logged.
  Whatever the tool did before its `interrupt()` has happened; nothing after
  it runs. Ask the person before the tool call instead, or pass the answer
  as an argument, so it is part of what is approved.
- A tool that calls `interrupt()` and is allowed without a person (ALLOW by
  rule) works: on resume the call is decided again and the tool gets its
  answer. A value sent to resume Guardian's pause is not handed to a
  tool's `interrupt()` (which pauses were Guardian's is kept in the process's
  memory). Other calls of the same node that already ran are
  run again by LangGraph when a tool interrupts itself.
- Outside a LangGraph run (a plain `tool.invoke`) there is nothing to pause;
  a held call answers as with `on_ask="result"`.

### Enforced mode: `mode="remote"`

```python
gate = GuardianGate(client, connection_id=..., modes={"send_wire": "remote"})
tools = gate.tools([send_wire, lookup_order])
```

| Mode                     | What runs after ALLOW                                                                                                                                                                | What it guarantees                                                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"in_process"` (default) | Your tool, in your process, then Guardian records it. Register the tool once in the console as "My own code (record-only)".                                                          | Decision-gated: the integration does not start the tool without ALLOW. Your process holds the credentials, so code that calls the upstream without going through the governed tool is not stopped. A revocation between ALLOW and the record is reported after the effect. |
| `"remote"`               | Guardian makes the call to a tool registered in the connection. The local tool body never runs; the model gets `{"guardian": {"decision": "ALLOW", "request_id": …, "receipt": …}}`. | Enforced: Guardian holds the credential and performs the call, so the action cannot happen without its decision. A receipt status other than `sent-verified` is reported to the model as "may have run, do not call it again", never as done.                              |

In remote mode the LangChain tool supplies the name, description and schema
the model sees; its function is not called, and the model gets Guardian's
result as JSON text. If something fails after Guardian was asked to make the
call, the model is told Guardian may have performed it and not to call it
again, never that it did not run. A `mode` other than `"in_process"` or
`"remote"` raises a `ValueError`. What remote mode needs and does not
support: [Enforced mode](../../docs/guides.md#enforced-mode-guardian-makes-the-call-remote).

### Arguments

- Guardian decides on the arguments as the tool's own schema validated them
  (`"500"` for an `int` parameter is proposed as `500`), and the tool runs
  with exactly those: the wrapped tool's `_run` / `_arun` is called directly,
  so a schema that transforms its input is applied once. Arguments that fail
  validation are never proposed.
- The decision is taken inside the tool invocation. With the middleware or
  the `ToolNode` hook, a middleware that changes the call's arguments, before
  or after Guardian's, changes what Guardian decides on, not what runs after
  the decision.
- Arguments LangChain and LangGraph fill in (`InjectedState`, `InjectedStore`,
  `ToolRuntime`, `InjectedToolCallId`) are not proposed and reach the tool
  unchanged. `ToolNode` and `create_agent` overwrite anything a model puts
  in them. An argument your app injects (`Annotated[str, InjectedToolArg]`)
  is proposed like any other, so it must be JSON.
- Arguments that cannot be written as JSON are refused before anything is
  proposed.

### Options and limits

- `tool_names={"refund_order": "billing.refund"}` (or a function) maps
  LangChain tool names to Guardian tool names. `amount_args`, `purpose`,
  `agent_name`, `adapter_id`, `on_receipt` and `on_execution_error` are
  `Guard`'s. `on_approval_pending=callback(tool_name, request_id)` is called
  once per held request. `on_approval_pending`, `on_receipt` and
  `on_execution_error` may be coroutine functions for async calls. On a sync
  call (`invoke`, a sync graph) a coroutine callback cannot be awaited, so
  the call raises `TypeError` before anything is proposed.
- **Sync and async.** A `GuardianClient` serves `invoke` and `ainvoke` (async
  calls make each Guardian call in a worker thread). An `AsyncGuardianClient`
  serves `ainvoke` only: a sync call raises `TypeError` before anything runs.
- **List `GuardianMiddleware` last.** It puts the call's tool behind Guardian
  and hands the call on. A middleware listed after it runs closer to the
  tool and could answer the call itself or replace the tool; Guardian's
  middleware cannot see that. `guardian_tools` does not have this limit: the
  governed tool is the only tool the agent has.
- A call to a tool the hook was not given (a name the model made up, or a
  tool another middleware adds later in the chain) is refused, and the model
  is told it did not run.
- A tool whose function is a generator function is refused at wrap time: a
  LangChain tool returns its result, and a generator's body would run after
  the call was recorded, or not at all.
- A single-string `Tool` without an `args_schema` is refused at wrap time;
  build it with `@tool` or `StructuredTool`. A single-input call (a `Tool`
  with a one-field `args_schema`, or a string passed to a one-argument tool)
  is proposed under that argument's name, for example `{"q": "abc"}`, so
  `amount_args` and console rules see the name the model sees.
- A tool that is already behind another `GuardianGate` is refused
  (`TypeError` from `gate.tool`, a refusal message from the middleware and
  the `ToolNode` hook): neither gate's decision is skipped. Give each gate
  the original tool, or share one gate.
- Tools with a JSON-schema `args_schema` (as MCP adapters build them) work;
  a sync call of an async-only tool is refused before anything is proposed.
- If Guardian allowed the call and the tool ran but redeeming the capability
  failed, the model is told the tool ran and not to call it again.
- The tool's own errors are the tool's: `ToolException`, `handle_tool_error`
  and `ToolNode(handle_tool_errors=...)` work as without Guardian. The
  governed tool copies the wrapped tool's `return_direct`, `response_format`,
  callbacks, tags and metadata.
- `file_args` (content pins) and watch mode are not available here; use
  `Guard` directly for those.
- Unlike `@odingard/guardian-langchain` (LangChain.js), which raises
  `GuardianDenied` / `GuardianApprovalPending` by default and defaults to
  `remote`, this integration answers the model with a message and defaults
  to `in_process`, like the other Python integrations.
- Not covered: tools the model provider runs itself (server-side tools), and
  code that calls your function without going through the governed tool.
- Tested with `langchain` 1.5.2, `langchain-core` 1.8.4 and `langgraph`
  1.2.24: `create_agent`, hand-built graphs with `ToolNode`, `InMemorySaver`
  and real interrupts, sync, async and streaming, with a scripted model and
  a stand-in Guardian. Before relying on it, run one governed tool with your
  model against your Guardian and check that an Ask waits for approval.
  Example: [`examples/python/langchain_agent.py`](../../examples/python/langchain_agent.py).

## Microsoft Agent Framework: `odingard_guardian.agent_framework` (0.5.0)

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

| Decision                 | What happens                                                                                                                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ALLOW**                | The tool runs once, with the arguments Guardian decided on. Then the capability is redeemed and the decision recorded.                                                                                                             |
| **ASK**                  | The tool does not run. The model is told the call is held for a person. After the person approves in the Guardian console, the same call (same tool, same arguments, same session) runs the approved request; before then it does not ask again. |
| **DENY**                 | The tool does not run, and the model is told it was refused and not to retry.                                                                                                                                                      |
| **Guardian unreachable** | The tool does not run (fail closed), and the model is told Guardian could not check it.                                                                                                                                            |

- `on_ask="stop"` or `on_deny="stop"` also stops the agent run, with Guardian's message as the tool result. `on_approval_pending=callback(tool_name, request_id)` lets your app show a held call to a person.
- Guardian decides on the arguments as Agent Framework validated them for the tool (for example `"500"` for an `int` parameter is proposed as `500`), and the tool runs with them.
- **After ALLOW, Guardian's middleware runs the tool itself** (`FunctionTool.invoke`) with the arguments Guardian decided on, so nothing can change them between the decision and the tool. Function middleware listed after Guardian's, and middleware passed to `agent.run(middleware=...)`, does not run for the call. Put middleware that should see the call (argument repair, logging) before Guardian's in the agent's list.
- If Guardian allowed the call and the tool ran but redeeming the capability failed, the model is told the tool ran and not to call it again.
- `tool_names={"refund_order": "billing.refund"}` (or a function) maps Agent Framework function names to Guardian tool names. Register each tool once in the Guardian console as "My own code (record-only)" and allow it for the agent.
- Agent Framework's own `approval_mode="always_require"` adds a local approval step before Guardian is asked; it does not replace Guardian's decision.
- **Held calls are scoped per session.** A held call is claimed only by the same call in the same `AgentSession` (`agent.run(..., session=session)`); the scope is the session's `session_id`. An identical call in another session is its own request. Without a session a held call is never claimed by a later call, so each call asks for its own approval: run the agent with a session, or pass `scope=callback(context)` returning a hashable value for the user or conversation (it overrides the session; `None`, an empty string or an error means unknown). Read it from something your app sets, never from `context.arguments`, which the model writes.
- `mode="remote"`, or `modes={"refund_order": "remote"}` by Guardian tool name, is for a tool registered on the connection as a call Guardian makes itself: after ALLOW Guardian performs it, the tool's own function does not run, and the model gets Guardian's result (`{"guardian": {"decision": "ALLOW", "request_id": …, "tool_name": …, "receipt": …}}`) as JSON text. A `mode` other than `"in_process"` or `"remote"` raises a `ValueError`. See [Enforced mode](../../docs/guides.md#enforced-mode-guardian-makes-the-call-remote).
- A tool that is a generator function is refused before anything is proposed: Agent Framework does not iterate a tool's generator, so it would not run.
- Not covered: tools the model provider runs itself (hosted tools), and anything that does not go through Agent Framework's function-calling loop. Put MCP servers behind `guardian-mcp` (see the [MCP package](../mcp)).
- Tested with `agent-framework-core` 1.26.0 in a real agent loop with a scripted model and a stand-in Guardian. Before relying on it, run one governed tool with your model against your Guardian and check that an Ask waits for approval.

## Semantic Kernel: `odingard_guardian.semantic_kernel` (0.5.0)

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
kernel.add_filter(FilterTypes.FUNCTION_INVOCATION, guardian)  # add it last
```

- The decisions work as in the Agent Framework table above: ALLOW runs the native function once with the arguments Guardian decided on; ASK, DENY and an unreachable Guardian do not run it, and the function result tells the model why. After approval, the same call in the same scope runs the approved request (see `scope` below).
- The Guardian tool name is Semantic Kernel's fully qualified name, `plugin-function` (for example `billing-refund_order`); `tool_names` maps it to another name. The proposal carries the function's own parameters, not other kernel arguments; a function with an `arguments` parameter receives every kernel argument, so then every kernel argument is proposed.
- Prompt functions pass through without a decision: they call the model, and each native function the model then asks for is decided. A streaming call of a native function (`invoke_stream`) is refused, because the function would run after the filter returns.
- **Add Guardian's filter last.** Filters added later run closer to the function, between Guardian's decision and the call. While another function invocation filter is added after Guardian's, every native function call is refused before anything is proposed or run.
- **Held calls are scoped per session, and Semantic Kernel does not name one.** Its filter context carries the function, the kernel and the arguments, nothing that identifies a conversation. So by default a held call is never claimed by a later call: each call asks for its own approval, and the result says so. Pass `scope=callback(context)` returning a hashable value for the user or conversation, read from something your app sets per request and the model cannot write, such as a `contextvars.ContextVar`: `scope=lambda context: current_user.get(None)`. Then the same call in the same scope runs the approved request. `None`, an empty string or an error means unknown. **Do not read the scope from `context.arguments`.** Kernel arguments are writable by the model: Semantic Kernel puts the arguments the model wrote in its function call over the ones your app passed, so for a function with a `user_id` parameter the model can put another user's id there and the call would claim that user's approval. (semantic-kernel 1.47.0 refuses a model argument the function has no parameter for, before any filter runs; do not rely on that.) The filter cannot tell where your `scope` reads from.
- `mode="remote"`, or `modes={"billing-refund_order": "remote"}` by Guardian tool name, is for a function registered on the connection as a call Guardian makes itself: after ALLOW Guardian performs it, the kernel function does not run, and its result is Guardian's result as JSON text. See [Enforced mode](../../docs/guides.md#enforced-mode-guardian-makes-the-call-remote).
- Tested with `semantic-kernel` 1.47.0 through the kernel's own automatic function-calling path, with a stand-in Guardian.

## OpenAI Agents SDK: `odingard_guardian.openai_agents` (unreleased)

The [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/) runs
each tool the model asks for as a `FunctionTool`. `guardian_tool` and
`create_guardian_tool` turn a function, or a `FunctionTool` you already have,
into a `FunctionTool` with the same name, description, parameter schema and
settings whose every call is sent to Guardian before it runs.

```bash
pip install "odingard-guardian[openai-agents]"   # Python 3.10+
```

```python
import os
from agents import Agent, Runner
from odingard_guardian import AsyncGuardianClient
from odingard_guardian.openai_agents import create_guardian_tool, find_approval_pending

governed = create_guardian_tool(
    AsyncGuardianClient(credential=os.environ["GUARDIAN_AGENT_CREDENTIAL"]),
    connection_id=os.environ["GUARDIAN_CONNECTION_ID"],
    agent_name="billing-agent",
)

@governed                       # or governed(existing_function_tool), or @governed(name_override=...)
def refund_order(order_id: str, amount_cents: int) -> str:
    """Refund an order."""
    return billing.refund(order_id, amount_cents)  # your code

agent = Agent(name="Billing", tools=[refund_order])

try:
    result = await Runner.run(agent, "Refund order 42")
except Exception as error:
    pending = find_approval_pending(error)
    if pending is None:
        raise
    # Show pending.request_id to a person. After they approve in Guardian:
    resumed = await pending.resume()    # claims the approval and runs the tool once
```

`guardian_tool(tool_or_function, client, connection_id=..., ...)` wraps one
tool; `create_guardian_tool(client, ...)` binds the Guardian options once, and
tools made by it share the held requests, each under its own scope (below). For a function, any `function_tool`
option (`name_override`, `strict_mode`, `failure_error_function`, `timeout`,
…) can be passed along. `billing` stands for your own code.

| Decision                 | What happens                                                                                                                                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ALLOW**                | The tool runs once, with the arguments Guardian decided on. Then the capability is redeemed and the decision recorded (`on_receipt` gets the record).                                                                                                                                     |
| **ASK**                  | The tool does not run. What happens next is set by `on_ask` (below). In every case the tool runs only by claiming the request a person approved in Guardian.                                                                                                                              |
| **DENY**                 | The tool does not run, and the model is told it was refused and not to retry. With `on_deny="raise"`, `GuardianDenied` goes to the tool's `failure_error_function`: the default one still tells the model, your own one gets the error, and `failure_error_function=None` fails the run. |
| **Guardian unreachable** | The tool does not run (fail closed), and the model is told Guardian could not check it and to try again later.                                                                                                                                                                            |

`on_ask` chooses how a held call reaches you:

- `"raise"` (default): `GuardianApprovalPending` ends the run. The Agents SDK wraps it in its own `UserError`; `find_approval_pending(error)` finds it. After a person approves, `await pending.resume()` claims the approval, runs the tool once and returns its output (`resumed.output`). Before they decide, `resume()` raises a new `GuardianApprovalPending`; if they deny, or the request expires, it raises `GuardianDenied` and the tool never runs. The run itself is over: the output goes to your code, not to the model.
- `"result"`: the run goes on. The model is told the call is held, with the `request_id`. With the `scope` option (below), when the model calls the tool again with the same arguments in the same session, that call claims the held request: it runs if a person approved, and is reported as still held (no second approval request) if not. Without `scope` nothing is remembered: every call proposes its own request and needs its own approval.
- `"interrupt"`: the run pauses the way the Agents SDK's own `needs_approval` pauses it. It needs the `scope` option (below); without it the tool is refused with a `ValueError` when it is built. `result.interruptions` lists the held call and `guardian_request_id(interruption, scope)` gives the Guardian request to show to a person, for the scope of that run. After they approve in Guardian, approve the interruption and resume:

  ```python
  governed = create_guardian_tool(client, connection_id=..., on_ask="interrupt",
                                  scope=lambda context: context.context.session_id)

  result = await Runner.run(agent, "Refund order 42", context=app_context)   # app_context.session_id: set by your app
  while result.interruptions:
      state = result.to_state()
      for held in result.interruptions:
          request_id = guardian_request_id(held, app_context.session_id)
          print("waiting for approval of", request_id)   # a person approves in Guardian
          state.approve(held)
      result = await Runner.run(agent, state)
  ```

  `state.approve(...)` is not the approval. It only lets the SDK invoke the call again; the tool then claims Guardian's request and runs only if a person approved it there. Resumed too early, the tool does not run and the model is told the call is still held; denied in Guardian, the model is told so. `state.reject(...)` skips the call without asking Guardian again. The other tool calls of the same turn are not held back.

`on_approval_pending=callback(tool_name, request_id)` is called whenever a call is held, in each mode.

**Held requests are scoped per session** (`scope=`). One governed tool usually serves many users and conversations, so a held request must be claimed only by the same call of the same session:

```python
governed = create_guardian_tool(
    client,
    connection_id=...,
    on_ask="result",
    scope=lambda context: context.context.session_id,   # what your app passed to Runner.run(context=...)
)
result = await Runner.run(agent, user_message, context=AppContext(session_id=authenticated_session))
```

- **There is no default scope.** The Agents SDK gives a tool no session identity that outlives a paused run: a `Session` passed to `Runner.run` is not reachable from the tool's context, `RunConfig.group_id` is a tracing label that the approval check does not receive, and a run's own state is copied when it is paused. Without `scope`, a held request is not remembered, so no later call can claim it and each call asks for its own approval. `on_ask="raise"` needs no scope: `resume()` claims that call's own request.
- `scope` is called with the Agents SDK's run context (a `RunContextWrapper` at the approval check, a `ToolContext` at invocation) and returns any hashable value. **Read it from data your application sets**, `context.context`, the object you pass to `Runner.run(context=...)`, which the model never sees. Never read it from the tool call's arguments (`context.tool_arguments`) or anything else the model writes: a model could then name another session.
- A `scope` that returns `None` or an empty string, cannot be hashed, or raises, means the session is not known for that call: nothing is remembered for it, and with `on_ask="interrupt"` the call is not paused but reported to the model as held when it is invoked. `0` and other falsy values are scopes.
- An identical call in another scope is proposed as its own request and never claims the first one's approval. The scope is part of an in-memory key only and is not sent to Guardian.
- With `on_ask="interrupt"`, a call Guardian allowed during the approval check is started only by the run that asked, in the same scope and with the same call id and arguments. Any other call is decided on its own.

**Two execution modes** (`mode=`, or `modes={"tool_name": ...}` per Guardian tool name; what remote mode needs and does not support is in [Enforced mode](../../docs/guides.md#enforced-mode-guardian-makes-the-call-remote)):

| Mode                     | What happens on ALLOW                                                                                                                                                          | What it guarantees                                                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `"in_process"` (default) | Your function runs here, then the capability is redeemed and the record kept. Register the tool once in the Guardian console as "My own code (record-only)".                   | The function does not start without Guardian's ALLOW or a person's approval. It runs before the capability is redeemed, so a revocation in that window is found after the effect; the model is told the tool ran and not to call it again. |
| `"remote"`               | The tool name is a registered catalog entry Guardian calls itself, with the credential it holds. Your local function never runs; the model gets Guardian's record of the call. | The effect happens in Guardian, under the capability. A call Guardian performed whose record is not `sent-verified` is reported to the model as "may have run, do not call it again", never as a result. An error while Guardian handles the call is reported as "Guardian may have performed it", never as "did not run". |

Limits:

- **Arguments.** Guardian decides on the JSON arguments of the tool call as the model sent them, and the original tool is handed that same text, so nothing changes them between the decision and the tool. The Agents SDK validates them for your function afterwards and may convert a value to the parameter's type (`"500"` to `500` for an `int`); the decision and its record hold what the model sent. With the SDK's default strict schema, arguments from an OpenAI model already match the schema. Arguments that are not a JSON object, repeat a key or hold a value JSON cannot carry are not proposed and the tool does not run.
- **Generator tools are refused.** The Agents SDK hands the model the generator object of a generator function (sync or async) and never runs its body, so Guardian would record a call that did not happen. Wrapping one raises `TypeError`; return the result instead.
- **A tool that raises** is not redeemed. The model gets what the tool's own `failure_error_function` says, as without Guardian. If the tool ran and redeeming the capability then failed, the model is told the tool ran and not to call it again, and `on_execution_error` gets the `GuardianExecutionFailed`.
- **Timeouts and cancelled runs.** Each Guardian call is bounded by the client's `timeout` (30 s by default). If the SDK's own tool `timeout` or a cancelled run stops a call while Guardian is still deciding, the tool does not run and a late ALLOW is dropped. Once the tool has started (or, in remote mode, once Guardian was asked to perform the call), neither stops it: the tool runs to its end in the background and the capability is then redeemed, although the SDK may already have told the model the tool timed out. This holds for async tools too, so keep a tool within the SDK timeout and make its side effects idempotent. The background work lives on the event loop of the run: if your program closes that loop before the tool has finished (for example `asyncio.run` returning right after a cancelled run), a sync tool's worker thread can still complete the action and nothing is recorded for it. Let the loop run until the tool is done.
- **`on_ask="interrupt"`** asks Guardian during the SDK's approval check, before the SDK's tool input guardrails and `on_tool_start` hooks; in the other modes Guardian is asked when the tool is invoked, after them. An allowed call waits up to 30 seconds for the SDK to invoke it, and in remote mode Guardian is asked to perform the call only then. Which Guardian request a paused call waits on is kept in memory by the tool, under the call's scope: a `RunState` serialized and resumed in another process, or with tools built anew, asks Guardian again, which starts a new request that needs its own approval. Nothing runs unapproved in either case. Use `"raise"` or `"result"` when the approval may outlive the process.
- The SDK's own `needs_approval` on a tool is kept. It adds a local approval step before Guardian is asked and never replaces Guardian's decision. A callable policy is evaluated by the Agents SDK against the original tool, with the SDK's own check: a call whose arguments the tool's validation would default or convert needs manual approval, as without Guardian. On an SDK version without that evaluation, a tool with a callable policy always needs manual approval.
- A tool with an output schema (`output_type`) cannot return a plain message, so its refusals are raised (the run fails with the Guardian error) and it needs `on_ask="raise"`. It cannot run in remote mode, where the tool output is Guardian's record and not the tool's type: that combination is refused with a `ValueError` when the tool is built.
- `tool_names={"refund_order": "billing.refund"}` (or a function) maps Agents SDK tool names to Guardian tool names. `amount_args` takes dollar amounts on tools, keyed by the Guardian tool name, as for `Guard`. `file_args` (content pins) and `watch_mode` are not available here; use `@guard` with the recipe above for those.
- Not covered: hosted tools (web search, file search, code interpreter, hosted MCP), computer, shell and apply-patch tools, handoffs, agents used as tools, tools the SDK builds from MCP servers (put those servers behind `guardian-mcp`, see the [MCP package](../mcp)), and realtime or voice agents, which were not tested.
- Tested with `openai-agents` 0.25.0 through `Runner.run`, `Runner.run_sync` and `Runner.run_streamed`, with a scripted model and a stand-in Guardian. Before relying on it, run one governed tool with your model against your Guardian and check that an Ask waits for approval. A runnable example with a scripted model: [`examples/python/openai_agents_agent.py`](../../examples/python/openai_agents_agent.py).

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
  routed as `hermes_config` (needs approval), however the path is spelled
  (repeated separators, `.` and `..` segments, a symbolic link that leads
  there; also for each file a V4A patch names), and the credential is moved out
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
Hosted setup and the MCP recipe: [examples/agents/hermes](../../examples/agents/hermes/README.md).
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
