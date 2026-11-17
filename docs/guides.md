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
