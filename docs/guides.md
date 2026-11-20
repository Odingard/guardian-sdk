# Guides

The snippets use the `guardian` client from the [Quickstart](../README.md#quickstart). The package READMEs have the full reference: [packages/sdk](../packages/sdk/README.md) · [packages/python](../packages/python/README.md) · [packages/mcp](../packages/mcp/README.md).

## Govern your own action code (any framework)

```ts
import { createGuard } from "@odingard/guardian-sdk";

const guard = createGuard({ client: guardian, connectionId: "pcn_…" });
const payInvoice = guard("pay_invoice", async (inv) =>
  myPaymentProvider.pay(inv),
); // your code
await payInvoice({
  invoiceId: "INV-1002",
  amountCents: 1_240_000,
  payeeId: "acme",
});
// ALLOW → your code runs + signed record. ASK → GuardianApprovalPending (resume() after approval). DENY → never runs.
```

```python
from odingard_guardian import Guard, GuardianClient

guard = Guard(GuardianClient(credential=...), connection_id="pcn_…")

@guard("pay_invoice")
def pay_invoice(invoice_id: str, amount_cents: int, payee_id: str): ...  # your code
```

## Pin the contents of file arguments (`fileArgs`, 0.4)

Approval binds the exact arguments. A file path is an argument; the file's contents are not, unless you declare the argument in `fileArgs` (`file_args` in Python).

```ts
const guard = createGuard({
  client: guardian,
  connectionId: "pcn_…",
  mode: "inProcess",
  fileArgs: { send_report: ["attachmentPath"] }, // bytes: no mode named
});
```

With `fileArgs`, the SDK on your machine reads the file, puts its SHA-256 in the approved arguments, and checks it again just before the tool runs. Guardian's servers never see the file. A changed file is refused with `CONTENT_CHANGED_SINCE_APPROVAL` and nothing runs.

- **`bytes` is the default when you don't name a mode.** `fileArgs: { send_report: ["attachmentPath"] }` (or `{ attachmentPath: true }`) means `bytes`: your tool receives the verified bytes themselves, so there is no gap between the check and the read. Name `"copy"` or `"recheck"` only when a tool needs a path; explicit modes work as before.
- `bytes` passes your tool the verified bytes. `copy` passes a private copy; another process running as the same user could still change it, and the copy is deleted when your tool returns, so a tool that keeps using the path afterwards (for example a background upload) must use `bytes`. `recheck` checks the file and then lets your tool open it, so a short window remains.
- File paths must be absolute. The SDK does not resolve relative paths or `~`.
- `fileArgs` needs `inProcess` mode. The LangChain and Vercel AI wrappers default to `remote`, where Guardian runs the tool and cannot read your files.
- **Opt-in preview (sdk 0.5, Python 0.3):** `{ attachmentPath: { mode: "bytes", preview: true } }` (Python: `{"attachment_path": {"mode": "bytes", "preview": True}}`) also shows the approver the file's type, size and, for a text file, its first 20 lines (at most 2,048 bytes). That text leaves your machine and is stored with the approval like any other argument (also on deny); the agent picks the path, so add `previewRoots` to preview only files in your folders (others get a size-only `withheld` preview). Nothing decides on it, the check before the run is still the SHA-256. See the [SDK README](../packages/sdk/README.md#show-the-approver-the-first-lines-of-the-file--preview-05-opt-in).
- Content pinning is supported on Linux and macOS. On Windows a declared file argument is refused (`CONTENT_PIN_UNSUPPORTED_PLATFORM`).
- **Digest privacy:** the SHA-256 of each pinned file is sent to Guardian, shown to the approver and kept in the signed decision record. For a small or low-entropy file (a token, a PIN, a short config value), anyone who sees the digest can guess the contents offline by hashing candidates. Do not pin files like that, or treat the digest as sensitive as the file.
- This stops a changed file from running under an approval given for different contents. It does not protect against code that bypasses the SDK.
- Python: the same short form, `@guard("send_report", file_args=["attachment_path"])` (or `{"attachment_path": True}`), means `bytes`. `Guard.run` supports `recheck` only; use the `@guard` decorator for `bytes` and `copy`. A file argument declared on `Guard.run` without a mode means `bytes`, so it is refused there rather than checked in a weaker mode; name `"recheck"`. The OpenAI Agents helper works with `@guard(file_args=...)` tools unchanged.
- The MCP proxy pins declared arguments of a stdio upstream (`--pin-file <tool>:<arg>`, `recheck` only), and the coding-agent hook pins the target of Edit-type tools (not Write, not shell commands); in both a short window remains because the tool opens the file itself. Neither can hand a tool bytes, so neither takes the `bytes` default: you name no mode there, and the mode is always `recheck`. A LangChain tool reachable only through `invoke()` cannot take bytes either, so declaring a file argument without a mode on it is refused when the tool is wrapped (name `"copy"`).
- Not pinned: URLs, provider file ids, paths on a remote MCP server, files named inside shell commands, and files a tool opens without naming them. The Steel integration, the OpenClaw plugin and the Hermes adapter do not pin the contents of files their tools read. The path is bound; the file's bytes are not.

## Dollar amounts on tools (`amountArgs`, sdk 0.6)

An owner can put a dollar limit on a tool in the Guardian console: name the argument that holds the amount, then allow up to an amount, ask a person above it and block above a maximum. Guardian reads the amount from each call. Send the same declaration from your agent:

```ts
const guard = createGuard({
  client: guardian,
  connectionId: "pcn_…",
  amountArgs: {
    purchase: { argument: "amount", unit: "minor", currency: "usd" },
  },
});
```

For a tool Guardian sends itself the limit applies to what reaches the tool; for a tool your own process runs it applies to Guardian's decision, not to what the code runs. The owner states that the named argument sets the charge and, without a currency argument, that the tool charges in US dollars; Guardian can't check either. Every tool on the same connection needs an amount (or none does); put tools that spend money on their own connection. A call whose amount cannot be read is blocked. Supported in the SDK (0.6), the MCP proxy (`--amount-arg`, 0.5), LangChain and Vercel AI (0.6) and the OpenAI Agents SDK wrapper (0.4); through the hook, OpenClaw, x402, AP2 and Python, a tool with an amount set in the console is refused. See the [SDK README](../packages/sdk/README.md#dollar-amounts-on-tools--amountargs-06).

## Enforced mode: Guardian makes the call (`remote`)

Every integration has two execution modes. This section is about the second one.

- **In-process** (`inProcess`, Python `in_process`): your code is the tool. It runs after ALLOW and before the capability is redeemed, so Guardian gates the decision; a revocation that lands at redemption is found after the effect.
- **Remote** (`remote`): Guardian is the tool. After ALLOW the SDK redeems the capability, and that redemption is the call: Guardian makes it. The local function body does not run, and the agent's process does not need the tool's credential.

### What remote mode does

It is the same in every integration below, because they share one implementation (`packages/sdk/src/guard.ts`; in Python, `guard.py`).

1. The SDK proposes `tool.invoke` with the tool's name and the call's exact arguments, as in-process mode does.
2. **ALLOW**: the SDK calls `execute` with the single-use capability and Guardian performs the call. Your function is not called.
3. The result is Guardian's, not your function's: `{ guardian: { decision: "ALLOW", requestId, toolName, receipt } }` (Python: `request_id`, `tool_name`). The receipt is Guardian's record of the call (`requestId`, `receiptReference`, `status`). The SDK does not return a response body from the tool, so remote mode fits actions (send, pay, refund), not lookups whose answer the model needs.
4. Only a receipt with status `sent-verified` is a result. `not-sent`, any other status and an answer that was lost are a `GuardianExecutionFailed` (where failures are handed back as a result, a result whose message says the call did not complete or may have happened), never a plain ALLOW result. When the outcome is unknown (`outcomeUnknown`, Python `outcome_unknown`) the call may have happened and must not be retried as a new request.
5. **ASK**: nothing is performed. After a person approves, `resume()` (or, with the decision handed back as a result, the same call again) claims the approved request and Guardian performs it. **DENY**, or Guardian unreachable: nothing is performed.

### What it needs

- The tool name is registered on the Guardian connection as a call Guardian makes itself (an HTTP(S) endpoint), and allowed for the agent. The tool's credential stays in Guardian; the agent holds only its agent credential (`gak_…`).
- Not a "My own code (record-only)" entry. That type is for in-process tools: redeeming it records the call and performs nothing. The receipt does not say which kind of entry answered, so the SDK cannot check this for you.
- A local function is still passed where the framework needs one (its name, description and schema are what the model sees). Its body is never run.

### What it does not support

- **Content pins** (`fileArgs`, Python `file_args`): refused when the tool is wrapped, with `CONTENT_PIN_REMOTE_MODE`. Guardian performs the call and cannot read files on your machine.
- **Watch mode**: a remote tool never asks for the watched answer and never runs on one.
- `installRecordTransport` (Python `install_record_transport`): in-process only; remote mode registers nothing.
- **Streams**: nothing local runs, so there is nothing to stream. A Python generator tool yields Guardian's result as its only item.

Dollar amounts (`amountArgs`, Python `amount_args`) are sent in remote mode as in in-process mode, and in remote mode the limit applies to what reaches the tool.

### Per integration

| Integration                                                    | Default mode | Enforced mode                                                                                           |
| -------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------- |
| `createGuard` (`@odingard/guardian-sdk`)                       | `inProcess`  | `mode: "remote"`, or `modes: { send_wire: "remote" }`                                                   |
| `@odingard/guardian-langchain`                                 | `remote`     | the default; `mode: "inProcess"` opts out                                                               |
| `@odingard/guardian-vercel-ai`                                 | `remote`     | the default; `mode: "inProcess"` opts out                                                               |
| `@odingard/guardian-openai-agents`                             | `inProcess`  | `mode: "remote"`, or `modes`                                                                            |
| `@odingard/guardian-mastra` (unreleased)                       | `remote`     | the default; `mode: "inProcess"` opts out (unreleased)                                                  |
| Python `Guard`                                                 | `in_process` | `mode="remote"`, or `modes={"send_wire": "remote"}`                                                     |
| Microsoft Agent Framework (Python, unreleased)                 | `in_process` | `mode="remote"`, or `modes` (unreleased)                                                                |
| Semantic Kernel (Python, unreleased)                           | `in_process` | `mode="remote"`, or `modes` (unreleased)                                                                |
| `guardian-mcp proxy`                                           | in-process   | none: the proxy always forwards an allowed call to the upstream server. Use `guardian-mcp` (see below). |

`modes` is keyed by the tool name Guardian sees.

**`createGuard`**

```ts
import { createGuard } from "@odingard/guardian-sdk";

const guard = createGuard({
  client: guardian,
  connectionId: "pcn_…",
  mode: "remote",
});
const sendWire = guard(
  "send_wire", // registered on the connection as a call Guardian makes
  async (_wire: { amountCents: number; payeeId: string }) => {
    throw new Error("never runs: Guardian makes this call");
  },
);

const result = await sendWire({ amountCents: 1_240_000, payeeId: "acme" });
// { guardian: { decision: "ALLOW", requestId, toolName: "send_wire", receipt } }
// ASK → GuardianApprovalPending; resume() after approval makes Guardian perform it.
```

**LangChain.js** (`guardianTool`, `guardianTools`): remote is the default.

```ts
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { guardianTool } from "@odingard/guardian-langchain";

const sendWire = guardianTool(
  tool(async () => "never runs: Guardian makes this call", {
    name: "send_wire",
    description: "Send a wire transfer",
    schema: z.object({ amountCents: z.number(), payeeId: z.string() }),
  }),
  { client: guardian, connectionId: "pcn_…" }, // mode: "remote" is the default
);

await sendWire.invoke({ amountCents: 1_240_000, payeeId: "acme" });
// { guardian: { decision: "ALLOW", requestId, toolName: "send_wire", receipt } }
```

**Vercel AI SDK** (`withGuardian`): remote is the default. The tool's result is Guardian's.

```ts
import { tool } from "ai";
import { z } from "zod";
import { withGuardian } from "@odingard/guardian-vercel-ai";

const tools = withGuardian(
  {
    send_wire: tool({
      description: "Send a wire transfer",
      inputSchema: z.object({ amountCents: z.number(), payeeId: z.string() }),
      execute: async () => "never runs: Guardian makes this call",
    }),
  },
  { client: guardian, connectionId: "pcn_…" }, // mode: "remote" is the default
);
```

**OpenAI Agents SDK** (`guardianTool`, `createGuardianTool`): in-process is the default. In remote mode the model gets Guardian's result as the tool output, and a call that did not complete is reported to the model as not completed.

```ts
import { z } from "zod";
import { createGuardianTool } from "@odingard/guardian-openai-agents";

const governed = createGuardianTool({
  client: guardian,
  connectionId: "pcn_…",
  mode: "remote",
});
const sendWire = governed({
  name: "send_wire",
  description: "Send a wire transfer",
  parameters: z.object({ amountCents: z.number(), payeeId: z.string() }),
  execute: async () => "never runs: Guardian makes this call",
});
```

**Mastra** (`guardianTool`, `guardianTools`; unreleased): remote is the default. The model gets Guardian's result as the tool result; the tool's `outputSchema` and `toModelOutput` are not applied to it.

```ts
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { guardianTools } from "@odingard/guardian-mastra";

const tools = guardianTools(
  {
    send_wire: createTool({
      id: "send_wire", // Guardian knows the tool by its id
      description: "Send a wire transfer",
      inputSchema: z.object({ amountCents: z.number(), payeeId: z.string() }),
      execute: async () => {
        throw new Error("never runs: Guardian makes this call");
      },
    }),
  },
  { client: guardian, connectionId: "pcn_…" }, // mode: "remote" is the default
);
```

**Python `Guard`**

```python
from odingard_guardian import Guard, GuardianClient

guard = Guard(GuardianClient(credential=...), connection_id="pcn_…", mode="remote")

@guard("send_wire")
def send_wire(amount_cents: int, payee_id: str):
    raise RuntimeError("never runs: Guardian makes this call")

result = send_wire(amount_cents=1_240_000, payee_id="acme")
# {"guardian": {"decision": "ALLOW", "request_id": …, "tool_name": "send_wire", "receipt": …}}
```

**Microsoft Agent Framework** (unreleased). The middleware does not call the tool's function. The tool result the model sees is Guardian's result as JSON text.

```python
guardian = GuardianFunctionMiddleware(
    AsyncGuardianClient(credential=os.environ["GUARDIAN_AGENT_CREDENTIAL"]),
    connection_id=os.environ["GUARDIAN_CONNECTION_ID"],
    modes={"send_wire": "remote"},  # or mode="remote" for every tool
)
agent = Agent(client=..., tools=[send_wire, lookup_order], middleware=[guardian])
```

**Semantic Kernel** (unreleased). The kernel function does not run. Its result is Guardian's result as JSON text. `modes` is keyed by the Guardian tool name, by default `plugin-function`.

```python
guardian = GuardianFunctionInvocationFilter(
    AsyncGuardianClient(credential=os.environ["GUARDIAN_AGENT_CREDENTIAL"]),
    connection_id=os.environ["GUARDIAN_CONNECTION_ID"],
    modes={"billing-send_wire": "remote"},  # or mode="remote" for every function
)
kernel.add_filter(FilterTypes.FUNCTION_INVOCATION, guardian)
```

In both Python integrations a `mode` other than `"in_process"` or `"remote"` raises a `ValueError` when the integration is built.

**MCP**. `guardian-mcp proxy` has no remote mode: after ALLOW it forwards the call to the upstream MCP server, which runs the tool, and then redeems the capability (in-process). For a call Guardian makes itself, give the agent the `guardian-mcp` server without `proxy`: its `guardian_invoke_tool` takes the registered `toolName` and `arguments` (and a `connectionId` unless `GUARDIAN_CONNECTION_ID` is set), Guardian performs an allowed call and the tool returns the decision, `requestId` and receipt; `guardian_claim` does the same for a request a person approved.

```json
{
  "mcpServers": {
    "guardian": {
      "command": "guardian-mcp",
      "env": {
        "GUARDIAN_BASE_URL": "https://guardian-api.odingard.com",
        "GUARDIAN_AGENT_CREDENTIAL": "gak_…",
        "GUARDIAN_CONNECTION_ID": "pcn_…"
      }
    }
  }
}
```

## Govern an MCP server you already use

```bash
guardian-mcp proxy -- npx -y your-whatsapp-mcp-server
```

## Govern Hermes Agent (Nous Research)

```bash
pip install odingard-guardian   # in Hermes' Python; ships the Hermes plugin "guardian"
# then list guardian under plugins.enabled in Hermes' config.yaml,
# with plugins.hook_callback_timeout: 130
```

Hermes calls the plugin before every tool call (terminal, file edits,
`execute_code`, the browser, MCP tools, …). Guardian decides; a block holds.
Read-only tools are not routed, and anything outside Hermes' tool dispatch is
not governed. After installing, check that Hermes loads the plugin. See
[examples/agents/hermes](../examples/agents/hermes/README.md).
