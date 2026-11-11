<p align="center">
  <img src=".github/assets/guardian-logo.png" alt="Guardian — human authority for AI" width="640" />
</p>

# Guardian SDK

[![npm version](https://img.shields.io/npm/v/@odingard/guardian-sdk)](https://www.npmjs.com/package/@odingard/guardian-sdk)
[![MCP registry](https://img.shields.io/badge/MCP_registry-guardian--mcp-blue)](https://registry.modelcontextprotocol.io/)
[![Guardian MCP server on mcprush](https://mcprush.com/badge/odingard-guardian-mcp/card.svg)](https://mcprush.com/to/odingard-guardian-mcp?ref=badge)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**Human Authority Infrastructure for Autonomous AI.** The agent proposes; the
human decides. Every tool call an agent makes gets a deterministic
`ALLOW` / `ASK` / `DENY` decision before it runs, and every execution produces a
tamper-evident receipt you can verify without an account. The receipt format is an open specification: [`greceipt.v1`](docs/spec/greceipt-v1.md).

Hosted Guardian: [guardian.odingard.com](https://guardian.odingard.com) — free
tier, no card required. [Pricing](https://odingard.com/guardian#gd-pricing): Free, Developer $99/month with 25,000 billable executions included, Business via sales.

## Packages

| Package                                                                                              | Use it when                                                                                                                                                                                                                       | Docs                                             |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| [`@odingard/guardian-sdk`](https://www.npmjs.com/package/@odingard/guardian-sdk)                     | You call Guardian from your own agent code: `createGuard` for your own action code, plus the core client, receipts and approvals                                                                                                  | [packages/sdk](packages/sdk)                     |
| [`odingard-guardian`](packages/python) (PyPI)                                                        | You build in Python (LangChain, CrewAI, OpenAI Agents, Claude Agent SDK, plain code), sync or async                                                                                                                               | [packages/python](packages/python)               |
| [`@odingard/guardian-mcp`](https://www.npmjs.com/package/@odingard/guardian-mcp)                     | Your agent speaks MCP (Claude, Cursor, …), with no code needed. `guardian-mcp proxy` governs an existing MCP server: local (stdio) is proven on production; remote (`--url`) is tested against Guardian, production proof pending | [packages/mcp](packages/mcp)                     |
| [`@odingard/guardian-langchain`](https://www.npmjs.com/package/@odingard/guardian-langchain)         | You build with LangChain.js / LangGraph                                                                                                                                                                                           | [packages/langchain](packages/langchain)         |
| [`@odingard/guardian-vercel-ai`](https://www.npmjs.com/package/@odingard/guardian-vercel-ai)         | You build with the Vercel AI SDK                                                                                                                                                                                                  | [packages/vercel-ai](packages/vercel-ai)         |
| [`@odingard/guardian-steel`](https://www.npmjs.com/package/@odingard/guardian-steel)                 | Your browser agent checks out on Steel. Not yet available on hosted Guardian                                                                                                                                                      | [packages/steel](packages/steel)                 |
| [`@odingard/guardian-hook`](https://www.npmjs.com/package/@odingard/guardian-hook)                   | Your coding agent runs shell commands and edits files (Claude Code, Claude Agent SDK, Codex CLI, DeepSeek Harness)                                                                                                                | [packages/hook](packages/hook)                   |
| [`@odingard/guardian-openai-agents`](https://www.npmjs.com/package/@odingard/guardian-openai-agents) | You build with the OpenAI Agents SDK (TypeScript): every tool you wrap with `guardianTool` is decided by Guardian before it runs. Tested against Guardian; production proof pending                                               | [packages/openai-agents](packages/openai-agents) |
| [`@odingard/guardian-openclaw`](https://www.npmjs.com/package/@odingard/guardian-openclaw)           | You run an OpenClaw agent: a native plugin governs exec, file edits, messages and MCP tools                                                                                                                                       | [packages/openclaw](packages/openclaw)           |

## Works with

Any agent can use Guardian by one of three routes: put its MCP servers behind
the **MCP proxy** (`guardian-mcp proxy`), add the **coding-agent hook**
(`guardian-hook`), or call the **SDK / HTTP API** in front of any action
(`createGuard`, Python `@guard`). The table lists the integrations we ship or
document, and how far each has been tested.

| Integration                                     | Package                                                | Status                                            |
| ----------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------- |
| Claude Code                                     | `@odingard/guardian-hook`                              | Proven on production                              |
| Claude Agent SDK (TypeScript)                   | `@odingard/guardian-hook`                              | Proven on production                              |
| Any MCP server, local (stdio)                   | `@odingard/guardian-mcp`                               | Proven on production                              |
| Any MCP server, remote (`--url`)                | `@odingard/guardian-mcp`                               | Tested against Guardian; production proof pending |
| LangChain.js / LangGraph                        | `@odingard/guardian-langchain`                         | Tested against Guardian; production proof pending |
| Vercel AI SDK                                   | `@odingard/guardian-vercel-ai`                         | Tested against Guardian; production proof pending |
| OpenAI Agents SDK (TypeScript)                  | `@odingard/guardian-openai-agents`                     | Tested against Guardian; production proof pending |
| Python with LangChain / OpenAI Agents SDK       | `odingard-guardian`                                    | Tested against Guardian; production proof pending |
| Python with CrewAI                              | `odingard-guardian`                                    | Example, not yet tested                           |
| Claude Agent SDK (Python)                       | `odingard-guardian`                                    | Example, not yet tested                           |
| Codex CLI                                       | `@odingard/guardian-hook`                              | Example, not yet tested                           |
| DeepSeek Harness                                | `@odingard/guardian-hook`                              | Example, not yet tested                           |
| Hermes Agent                                    | `odingard-guardian`                                    | Example, not yet tested                           |
| ZeroClaw                                        | `@odingard/guardian-mcp` ([recipe](examples/zeroclaw)) | Example, not yet tested                           |
| Your own container (CrewAI, LangGraph, AutoGen) | `@odingard/guardian-mcp` ([recipe](examples/byo))      | Example, not yet tested                           |
| Steel browser checkout                          | `@odingard/guardian-steel`                             | Not yet available on hosted Guardian              |
| OpenClaw                                        | `@odingard/guardian-openclaw`                          | Proven on production (shell commands)             |

"Tested against Guardian" means the integration ran end to end against the
real Guardian server code, with real approvals and receipts verified offline,
but not yet on hosted production.

## Quickstart

```bash
npm install @odingard/guardian-sdk
```

```ts
import {
  classifyRequestResult,
  createGuardianClient,
} from "@odingard/guardian-sdk";

const guardian = createGuardianClient({
  baseUrl: "https://guardian-api.odingard.com",
  credential: process.env.GUARDIAN_AGENT_CREDENTIAL!, // gak_… issued per agent
});

const d = classifyRequestResult(
  await guardian.request({
    action: "tool.invoke",
    connectionId: "con_…",
    toolName: "refund_order",
    arguments: { orderId: "ord_123" },
  }),
);

if (d.decision === "ALLOW") {
  await guardian.execute({
    requestId: d.requestId,
    capabilityToken: d.capabilityToken,
  });
}
// ASK → held for a human (keep d.requestId, then guardian.claim). DENY → never runs.
```

### Govern your own action code (any framework)

```ts
import { createGuard } from "@odingard/guardian-sdk";

const guard = createGuard({ client: guardian, connectionId: "con_…" });
const payInvoice = guard("pay_invoice", async (inv) =>
  myPaymentProvider.pay(inv),
); // your code
await payInvoice({
  invoiceId: "INV-1002",
  amountCents: 1_240_000,
  payeeId: "acme",
});
// ALLOW → your code runs + receipt. ASK → GuardianApprovalPending (resume() after approval). DENY → never runs.
```

```python
from odingard_guardian import Guard, GuardianClient

guard = Guard(GuardianClient(credential=...), connection_id="con_…")

@guard("pay_invoice")
def pay_invoice(invoice_id: str, amount_cents: int, payee_id: str): ...  # your code
```

### Pin the contents of file arguments (`fileArgs`, 0.4)

Approval binds the exact arguments. A file path is an argument; the file's contents are not, unless you declare the argument in `fileArgs` (`file_args` in Python).

```ts
const guard = createGuard({
  client: guardian,
  connectionId: "con_…",
  mode: "inProcess",
  fileArgs: { send_report: { attachmentPath: "bytes" } },
});
```

With `fileArgs`, the SDK on your machine reads the file, puts its SHA-256 in the approved arguments, and checks it again just before the tool runs. Guardian's servers never see the file. A changed file is refused with `CONTENT_CHANGED_SINCE_APPROVAL` and nothing runs.

- `bytes` passes your tool the verified bytes. `copy` passes a private copy; another process running as the same user could still change it, and the copy is deleted when your tool returns, so a tool that keeps using the path afterwards (for example a background upload) must use `bytes`. `recheck` checks the file and then lets your tool open it, so a short window remains.
- File paths must be absolute. The SDK does not resolve relative paths or `~`.
- `fileArgs` needs `inProcess` mode. The LangChain and Vercel AI wrappers default to `remote`, where Guardian runs the tool and cannot read your files.
- Content pinning is supported on Linux and macOS. On Windows a declared file argument is refused (`CONTENT_PIN_UNSUPPORTED_PLATFORM`).
- **Digest privacy:** the SHA-256 of each pinned file is sent to Guardian, shown to the approver and kept in receipts. For a small or low-entropy file (a token, a PIN, a short config value), anyone who sees the digest can guess the contents offline by hashing candidates. Do not pin files like that, or treat the digest as sensitive as the file.
- This stops a changed file from running under an approval given for different contents. It does not protect against code that bypasses the SDK.
- Python: `Guard.run` supports `recheck` only; use the `@guard` decorator for `bytes` and `copy`. The OpenAI Agents helper works with `@guard(file_args=...)` tools unchanged.
- The MCP proxy pins declared arguments of a stdio upstream (`--pin-file <tool>:<arg>`, `recheck` only), and the coding-agent hook pins the target of Edit-type tools (not Write, not shell commands); in both a short window remains because the tool opens the file itself.
- Not pinned: URLs, provider file ids, paths on a remote MCP server, files named inside shell commands, and files a tool opens without naming them. The Steel integration, the OpenClaw plugin and the Hermes adapter do not pin the contents of files their tools read. The path is bound; the file's bytes are not.

### Govern an MCP server you already use

```bash
guardian-mcp proxy -- npx -y your-whatsapp-mcp-server
```

### Govern Hermes Agent (Nous Research)

```bash
pip install odingard-guardian   # in Hermes' Python; ships the Hermes plugin "guardian"
# then list guardian under plugins.enabled in Hermes' config.yaml,
# with plugins.hook_callback_timeout: 130
```

Hermes calls the plugin before every tool call (terminal, file edits,
`execute_code`, the browser, MCP tools, …). Guardian decides; a block holds.
Read-only tools are not routed, and anything outside Hermes' tool dispatch is
not governed. Example, not yet tested against Guardian. The install step is
unverified: `hermes plugins enable guardian` failed with "not installed or
bundled" in the only real attempt, so check that Hermes loads the plugin. See
[examples/hermes](examples/hermes/README.md).

Full guides: [packages/sdk](packages/sdk/README.md) ·
[packages/python](packages/python/README.md) · [packages/mcp](packages/mcp/README.md).

## Examples

Runnable demos in [`examples/`](examples/) — each prints `SIMULATED` (local
demo policy) or `LIVE` (real hosted Guardian or real published keys).

```bash
npm install && npm run build
cd examples
node verify-receipt.mjs         # LIVE, no account: verify a real receipt offline, then tamper
node demo-classes.mjs           # the 7 demo classes
node steel-checkout.mjs         # Steel checkout → ASK → resume
node shopping-agent.mjs         # purchase → ASK, human approves, receipt
node prompt-injection-deny.mjs  # injected "export contacts" → DENY
node coding-agent-ask.mjs       # consequential command → ASK
node invoice-agent.mjs          # B2B invoices: ALLOW under $5k, ASK above, DENY unknown payee (createGuard)
python python/invoice_agent.py  # the same, in Python (pip install odingard-guardian)
node remote-mcp.mjs             # guardian-mcp in front of a remote (HTTP) MCP server; SIMULATED fail-closed, LIVE with Guardian env (tested against Guardian; production proof pending)
node agent-hooks.mjs codex       # Codex CLI hook: shell, apply_patch, MCP → ALLOW / ASK / DENY (guardian-hook codex)
node agent-hooks.mjs dsh         # DeepSeek Harness hook via its Claude Code bridge (guardian-hook dsh)
python hermes/hermes_hook_demo.py  # Hermes Agent's pre_tool_call hook: ALLOW / ASK / DENY (SIMULATED unless env set)
(cd openclaw && npm install && npm run simulated)  # OpenClaw plugin in OpenClaw's real hook runtime (SIMULATED Guardian)
```

Recipes (LIVE, examples not yet tested): [ZeroClaw](examples/zeroclaw/README.md) ·
[your own container: CrewAI, LangGraph, AutoGen](examples/byo/README.md).

## Repository layout

```text
packages/sdk            @odingard/guardian-sdk            core client
packages/mcp            @odingard/guardian-mcp            MCP server
packages/hook           @odingard/guardian-hook           coding-agent hooks
packages/langchain      @odingard/guardian-langchain
packages/vercel-ai      @odingard/guardian-vercel-ai
packages/openai-agents  @odingard/guardian-openai-agents  OpenAI Agents SDK adapter
packages/steel          @odingard/guardian-steel
packages/openclaw       @odingard/guardian-openclaw       OpenClaw plugin
packages/python         odingard-guardian (PyPI)          Python SDK
examples/               runnable demos
```

`packages/sdk/src/contracts`, `packages/sdk/src/evidence`, the SDK client,
guard, lifecycle and receipts sources, and the Steel adapter sources are generated
— don't edit them here. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0
