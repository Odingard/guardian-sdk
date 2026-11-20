<p align="center">
  <img src="https://raw.githubusercontent.com/Odingard/guardian-sdk/main/.github/assets/guardian-logo.png" alt="Guardian — human authority for AI" width="640" />
</p>

# @odingard/guardian-sdk

[![npm version](https://img.shields.io/npm/v/@odingard/guardian-sdk)](https://www.npmjs.com/package/@odingard/guardian-sdk)
[![npm downloads](https://img.shields.io/npm/dm/@odingard/guardian-sdk)](https://www.npmjs.com/package/@odingard/guardian-sdk)
[![MCP registry](https://img.shields.io/badge/MCP_registry-guardian--mcp-blue)](https://registry.modelcontextprotocol.io/)
[![Guardian MCP server on mcprush](https://mcprush.com/badge/odingard-guardian-mcp/card.svg)](https://mcprush.com/to/odingard-guardian-mcp?ref=badge)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/Odingard/guardian-sdk/blob/main/LICENSE)

**Guardian is the trust layer for agent commerce.** Human Authority Infrastructure for Autonomous AI: the agent proposes; the human decides.

This SDK lets an AI agent request governed capabilities and execute
consequential actions under human authority. Every decision is deterministic (`ALLOW` / `ASK` / `DENY`), and every
execution produces a signed, tamper-evident decision record you can verify without an account.

Hosted Guardian: [guardian.odingard.com](https://guardian.odingard.com) — free tier for developers
(2 connections, 1 agent, 500 protected actions a month), no card required.

## Install

```bash
npm install @odingard/guardian-sdk
```

Requires Node.js >= 22 (offline verification uses `node:crypto` Ed25519; browser runtimes are not supported).

## Quickstart

```ts
import {
  classifyRequestResult,
  createGuardianClient,
} from "@odingard/guardian-sdk";

const guardian = createGuardianClient({
  baseUrl: "https://guardian-api.odingard.com",
  credential: process.env.GUARDIAN_AGENT_CREDENTIAL!, // gak_… issued per agent
});

// 1. The agent asks for a capability — it never holds real credentials.
const result = await guardian.request({
  action: "tool.invoke",
  connectionId: "pcn_…",
  toolName: "refund_order",
  arguments: { orderId: "ord_123" },
});

const d = classifyRequestResult(result); // the one fail-closed reading

if (d.decision === "ALLOW") {
  // 2. Guardian minted a single-use capability. Execute it.
  const execution = await guardian.execute({
    requestId: d.requestId,
    capabilityToken: d.capabilityToken,
  });
  console.log(execution.ok ? execution.receipt : execution.reasonCode);
} else if (d.decision === "ASK") {
  // Held for a human. Keep d.requestId; after the human approves:
  const granted = classifyRequestResult(await guardian.claim(d.requestId));
  // …execute as above once granted.decision === "ALLOW".
}
// d.decision === "DENY" → refused before execution, with d.reasonCode.
// Ambiguity (ALLOW without a token, unreachable Guardian, unknown shape)
// is always DENY.
```

## Govern your own action code — `createGuard` (0.3)

Guardian does not need to ship a connector for your provider. Wrap the
function that performs the action (your Stripe call, WhatsApp send, production
deploy, database write). Guardian decides whether it may run, and records
the signed decision when it does. This works from any agent framework: OpenAI Agents
SDK, Claude Agent SDK, Mastra, or plain code.

```ts
import {
  createGuard,
  createGuardianClient,
  GuardianApprovalPending,
  GuardianDenied,
} from "@odingard/guardian-sdk";

const client = createGuardianClient({
  baseUrl: "https://guardian-api.odingard.com",
  credential: process.env.GUARDIAN_AGENT_CREDENTIAL!,
});
const guard = createGuard({
  client,
  connectionId: process.env.GUARDIAN_CONNECTION_ID!,
});

const payInvoice = guard(
  "pay_invoice",
  async (inv: { invoiceId: string; amountCents: number; payeeId: string }) =>
    stripe.paymentIntents.create({
      amount: inv.amountCents,
      currency: "usd" /* … */,
    }), // your code
);

try {
  await payInvoice({
    invoiceId: "INV-1002",
    amountCents: 1_240_000,
    payeeId: "acme-supplies",
  });
} catch (err) {
  if (err instanceof GuardianApprovalPending) {
    notifyApprover(err.requestId); // ASK: nothing ran
    const { output } = await err.resume(); // after approval: runs your code, records the decision
  } else if (err instanceof GuardianDenied) {
    console.warn("blocked:", err.reasonCode); // DENY: your code never ran
  } else throw err;
}
```

| Decision  | Your function                                                                             |
| --------- | ----------------------------------------------------------------------------------------- |
| **ALLOW** | Runs once, then the capability is redeemed and the signed record kept (`onReceipt`).      |
| **ASK**   | Does not run. `resume()` runs it after approval; before approval it throws pending again. |
| **DENY**  | Never runs. An unreachable Guardian is a DENY (fail closed).                              |

`onAsk: "result"` / `onDeny: "result"` return the decision as data instead of
throwing, which is handy as a tool result for a model.

**In-process mode is decision-gated.** Your function runs after ALLOW and
before the capability is redeemed. A revocation in that window is detected
after the effect and thrown as `GuardianExecutionFailed` with
`localEffectRan: true`. Treat that as an incident. Where Guardian itself must
perform the call, use `mode: "remote"` with a tool registered on your
connection. The LangChain and Vercel AI adapters use this same core.
What remote mode does, needs and does not support, per framework:
[Enforced mode](../../docs/guides.md#enforced-mode-guardian-makes-the-call-remote).

**First-run setup:**

1. In the Guardian console, connect a tool server.
2. Add your function as "My own code (record-only)" (for example
   `pay_invoice`).
3. Allow it for your agent.

Since 0.3.1, `createGuard` does not try to register tools itself, and
`createGuardianContext` (and so the LangChain and Vercel AI adapters) now
defaults the same way. `installRecordTransport: true` turns that back on, but
it is denied unless the agent's grant pins `mcp.install`, and it only works
for a tool that has no entry yet. If Guardian answers that the tool is
already registered, the call is refused (`RECORD_TRANSPORT_UNVERIFIED`) and
nothing runs, because the existing entry may make an HTTP call. Which entries
the SDK registered is kept in memory only, so a restarted process, another
worker or a cold start is refused that way even for an entry the SDK created
itself; use the console-registered tool with the option off. When Guardian
refuses, `GuardianDenied.hint`
says what to fix: register the tool, allow it for the agent, or check the plan
limit. The decision itself never changes.

Runnable: [`examples/payments/invoice-agent.mjs`](../../examples/payments/invoice-agent.mjs).
For Python, see [`odingard-guardian`](../python).

## Watch mode (unreleased, opt-in)

While the agent is in watch mode (the console's **Start watching**), Guardian records what it would have decided for each action and blocks nothing at that step. For a call it would have asked about or denied, it issues no capability and performs nothing. With `watchMode: true`, `createGuard` (and the LangChain, Vercel AI and OpenAI Agents adapters built on it) then runs an `inProcess` tool anyway: its `fileArgs` are still checked, and there is nothing to record. `onWatched` tells you when that happened:

```ts
const guard = createGuard({
  client,
  connectionId: "pcn_…",
  watchMode: true,
  onWatched: ({ toolName, requestId, wouldDecision }) =>
    console.log(`${toolName} (${requestId}) would have been ${wouldDecision}`),
});
```

Without `watchMode`, such a call is refused (`GuardianDenied`) and the tool does not run. A `remote` tool is never run this way: Guardian performs nothing for it. Outside watch mode nothing changes.

## Pin the contents of file arguments — `fileArgs` (0.4)

Approval binds the exact arguments. A file path is an argument; the file's contents are not, unless you declare the argument in `fileArgs`.

With `fileArgs`, the SDK on your machine reads the file, puts its SHA-256 in the approved arguments, and checks it again just before the tool runs. Guardian's servers never see the file. If the file changed, the call is refused with `CONTENT_CHANGED_SINCE_APPROVAL` (`GuardianExecutionFailed`, `localEffectRan: false`): the tool does not run, the capability is not redeemed, and a new approval is needed.

```ts
const guard = createGuard({
  client,
  connectionId: "pcn_…",
  mode: "inProcess",
  fileArgs: { send_report: ["attachmentPath"] }, // no mode named: bytes
});
const sendReport = guard("send_report", async ({ to, attachmentPath }) => {
  // attachmentPath is a PinnedFile: { path, name, bytes, size, sha256 }
  return mailer.send({ to, attachment: attachmentPath.bytes });
});
await sendReport({
  to: "ops@example.com",
  attachmentPath: "/srv/reports/q3.pdf",
});
```

A declared argument is a top-level argument holding one absolute path or an array of them. The pins go into the proposed arguments under the reserved key `guardianContentPins` (`CONTENT_PIN_KEY`), one record per file: `{ arg, index, mode, name, size, sha256 }` (plus `preview` when you ask for one, below), where `name` is the basename with control and bidi characters removed. A call that supplies `guardianContentPins` itself is refused (`CONTENT_PIN_KEY_RESERVED`) for every tool. Each file is capped at 25 MiB (`maxPinBytes`) and each call at 64 MiB (`maxPinTotalBytes`) and 16 files; a symlink as the last path component, a directory, FIFO, device, an unreadable file or a file that changes while it is read is refused before anything is proposed, with no request sent. `GuardianApprovalPending.input` is your input without pins; `proposedInput` is what was proposed.

- **`bytes` is the default when you don't name a mode.** `fileArgs: { send_report: ["attachmentPath"] }` (or `{ attachmentPath: true }`) means `bytes`: your tool receives the verified bytes themselves, so there is no gap between the check and the read. Name `"copy"` or `"recheck"` only when a tool needs a path; explicit modes work as before.
- `bytes` passes your tool the verified bytes. `copy` passes a private copy; another process running as the same user could still change it, and the copy is deleted when your tool returns, so a tool that keeps using the path afterwards (for example a background upload) must use `bytes`. `recheck` checks the file and then lets your tool open it, so a short window remains.
- File paths must be absolute. The SDK does not resolve relative paths or `~`.
- `fileArgs` needs `inProcess` mode. The LangChain and Vercel AI wrappers default to `remote`, where Guardian runs the tool and cannot read your files.
- Content pinning is supported on Linux and macOS. On Windows a declared file argument is refused (`CONTENT_PIN_UNSUPPORTED_PLATFORM`).
- **Digest privacy:** the SHA-256 of each pinned file is sent to Guardian, shown to the approver and kept in the signed decision record. For a small or low-entropy file (a token, a PIN, a short config value), anyone who sees the digest can guess the contents offline by hashing candidates. Do not pin files like that, or treat the digest as sensitive as the file.
- This stops a changed file from running under an approval given for different contents. It does not protect against code that bypasses the SDK.
- Not pinned: URLs, provider file ids, and files a tool opens without naming them in a declared argument.

### Show the approver the first lines of the file — `preview` (0.5, opt-in)

A digest tells the approver the bytes cannot change after approval, not what they are. For a file argument you choose, the SDK can also put a short preview in the pin, so the approval shows it next to the file name:

```ts
fileArgs: {
  send_report: {
    attachmentPath: {
      mode: "bytes", // the default
      preview: true,
      previewRoots: ["/srv/reports"], // preview only files in these folders
    },
  },
},
```

- **Opt-in, per argument.** Only the object form with `preview: true` sends a preview. The short forms (`["attachmentPath"]`, `{ attachmentPath: true }`, `{ attachmentPath: "bytes" }`) never do. A `preview` that is not `true` or `false`, a `mode` that is not a mode (`null` included; leave it out for `"bytes"`), any key other than `mode`, `preview` and `previewRoots`, or bad `previewRoots` (below) is refused when the tool is wrapped (`CONTENT_PIN_INVALID_ARGUMENT`).
- **What is sent.** The pin gets `preview`, computed from the same bytes that are hashed (the file is read once):
  - a text file (valid UTF-8, no NUL byte, not a known binary type such as pdf, images, archives or office files): `{ kind: "text", mediaType, size, text, truncated }`, where `text` is the **first 20 lines, at most 2,048 bytes**, cut on a character boundary. Control characters other than tab and newline, direction-changing (bidi) characters and zero-width characters are replaced with U+FFFD; CRLF becomes LF.
  - any other file: `{ kind: "binary", mediaType, size }`, no content.
  - a file outside the `previewRoots` folders: `{ kind: "withheld", size }`, no content and no type.
- **The agent picks the file, not you.** `preview: true` is set per argument, but the path in that argument comes from the agent. Without `previewRoots`, **any file the agent process can read may be previewed** if the agent names it there, for example `~/.aws/credentials` or a `.env` file after a prompt injection: a file that is valid UTF-8 and has no known binary extension is sent as text. Set `previewRoots` to the folders your tool is meant to send from (1 to 16 absolute paths; symbolic links are resolved for the folders and the file, and on Linux the file's path is taken from the descriptor that was read). Any other file still gets its pin (name, size, digest) and the call goes ahead for the approver to decide, but its preview is `withheld`.
- **Privacy: the preview text leaves your machine.** It travels to Guardian inside the proposed arguments, is shown to the approver, and is stored with the approval and in the decision record like any other argument, **also when the approver denies the call**. Without `preview: true` only the name, size and digest leave your machine. Use `previewRoots` so that only files from folders you chose can be previewed.
- **Display only.** The approval binds the preview because it is part of the arguments, but nothing decides on it: the check just before the tool runs compares the size and SHA-256, as before. The console shows the text as plain text, never as HTML or Markdown.
- Previews count toward the 16 KB tool-arguments limit; a call whose previews push it over is refused (`CONTENT_PIN_TOO_MANY`, "preview fewer files"), never cut silently.
- `contentPreview(name, bytes)` returns the preview for bytes you hold; `normalizeFileArgPreviews(toolName, declaration)` lists the arguments that ask for one and `normalizeFileArgPreviewRoots(toolName, declaration)` their folders. `PREVIEW_MAX_LINES` is 20, `PREVIEW_MAX_BYTES` 2,048 and `PREVIEW_MAX_ROOTS` 16.

`normalizeFileArgs(fileArgs)` / `normalizeFileArgsSpec(toolName, declaration)` return a declaration in the full form (a mode per argument; `DEFAULT_FILE_ARG_MODE` is `"bytes"`) and throw `CONTENT_PIN_INVALID_ARGUMENT` for an invalid one: a mode other than `"bytes"`, `"copy"`, `"recheck"` or `true` (so `false` is refused), or a name that is empty, dotted, reserved, not a string or listed twice. `createGuardianContext` stores the full form.

`pinFile(path, { allowAbsent })` and `verifyPin(path, pin)` are the same checks for code that pins a file itself (the coding-agent hook uses them).

## Dollar amounts on tools — `amountArgs` (0.6)

An owner can put a dollar limit on a tool in the Guardian console: allow up to an amount, ask a person above it, and block above a maximum. The owner names the argument that holds the amount on the tool. Guardian reads the amount from the arguments of each call and decides on it. Your agent sends the same declaration with each call, with `amountArgs`:

```ts
const guard = createGuard({
  client,
  connectionId: "pcn_…",
  amountArgs: {
    // exactly as set on the tool in the Guardian console
    purchase: { argument: "amount", unit: "minor", currency: "usd" },
  },
});
const purchase = guard("purchase", async ({ sku, amount }) =>
  shop.buy({ sku, amountCents: amount }),
);
await purchase({ sku: "mug-1", amount: 2000 }); // $20.00
```

- **What the limit binds.** For a tool Guardian sends itself (registered with a web address, `remote` mode), Guardian's tool adapter sends the call with the arguments Guardian decided on, so the limit applies to what reaches the tool. For a tool your own code runs (`inProcess`, a tool registered as your own code), the limit applies to Guardian's decision and its record, not to what your code runs.
- **You state that the argument sets the charge.** Guardian reads one top-level argument. When the owner sets it, they state that this argument sets how much the tool charges; if other arguments (a quantity, a tip, a second amount) change the charge, Guardian can't see that. `allowedArguments: ["amount", "sku"]` blocks calls that carry any other argument; it does not show how the tool computes its charge. Content pins from `fileArgs` count as allowed. Without a `currencyArgument`, the owner also states that the tool charges in US dollars; Guardian can't check that.
- **Units.** `unit: "minor"` is cents: a whole number, `2000` or `"2000"`. `unit: "major"` is dollars: a whole number (`20`) or text with up to two decimals (`"19.99"`). A JSON number with cents (`19.99`), a sign, `$`, commas, spaces, leading zeros or an exponent are refused. Currency: US dollars (`currency: "usd"`). With `currencyArgument: "currency"` each call must carry `"usd"` (any letter case) in that argument.
- **A call whose amount cannot be read is blocked.** The SDK sends it without an amount and Guardian refuses it before any decision; the `GuardianDenied` hint says which argument could not be read. Nothing runs.
- **The declaration must match the console.** A declared tool is refused unless the call carries the owner's declaration exactly, and a tool the owner did not declare is refused if the call carries one. The SDK's error names the declaration it sent. If the owner changes the declaration, a call held for approval is refused when it is claimed; propose it again.
- An invalid declaration (a dotted name, another currency, an unknown field, an `allowedArguments` list without the amount argument) throws a `TypeError` when the tool is wrapped.
- **All tools on a connection, or none.** Every tool on a connection needs an amount (or none does); put tools that spend money on their own connection.
- In the console a declared tool needs a maximum on the grant; without one every call of that tool is blocked.
- `readToolAmount(declaration, args)` and `ToolAmountDeclarationSchema` (from `@odingard/guardian-sdk/contracts`) are the reader and the schema Guardian uses.
- Supported in `@odingard/guardian-sdk` 0.6.0, `@odingard/guardian-mcp` 0.5.0, `@odingard/guardian-langchain` 0.6.0, `@odingard/guardian-vercel-ai` 0.6.0 and `@odingard/guardian-openai-agents` 0.4.0. Through any other integration or an earlier version (guardian-hook, OpenClaw, x402, AP2, the Python SDK 0.4.0 and earlier), a tool with an amount set in the console is refused. The Python SDK in this repository adds `amount_args` (not yet released).

## A time limit and an abort signal for Guardian calls (unreleased)

`createGuardianClient` sets no time limit of its own: a Guardian call that is never answered waits for as long as the connection stays open. The client takes a `fetch`, and `withRequestTimeout` bounds it:

```ts
import {
  createGuardianClient,
  withRequestTimeout,
} from "@odingard/guardian-sdk";

const client = createGuardianClient(
  withRequestTimeout(
    {
      baseUrl: "https://guardian-api.odingard.com",
      credential: process.env.GUARDIAN_AGENT_CREDENTIAL!,
    },
    { timeoutMs: 10_000, signal: shutdown.signal }, // both optional
  ),
);
```

Every HTTP call the client makes then ends after `timeoutMs` at the latest (default 15,000), reading the answer included, and at once when `signal` aborts. `createTimeoutFetch({ timeoutMs, signal, fetch })` returns the bounded `fetch` itself, for a transport of your own. The client reports an ended call as it reports an unreachable Guardian:

| Call                                       | When it is not answered in time, or is aborted                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request`, `claim`                         | `{ ok: false, reasonCode: "SERVICE_UNAVAILABLE" }` (`HTTP_<status>` when the answer started and could not be read to its end). `createGuard` and the adapters refuse the call and nothing runs. A held request stays held: the same call made again claims it.                                                                                         |
| `execute`                                  | `{ ok: false, outcomeUnknown: true }`: it was sent, and Guardian may have redeemed the capability. `createGuard` and the adapters then look the request up, on a new time limit. A verified attempt is the result; an attempt that was not sent is a failure; otherwise the call throws `GuardianExecutionFailed` with `outcomeUnknown: true`. Do not retry that as a new request. |
| `withdraw`                                 | `{ ok: false, outcomeUnknown: true }`; withdrawing again with the same `requestId` is safe.                                                                                                                                                                                                                                                      |
| `receipts`, `portableReceipt`, `pending`   | `{ ok: false }`.                                                                                                                                                                                                                                                                                                                                 |

What it does not do:

- The limit is per HTTP call, not per guarded tool call, which makes several (the request, the redemption, and a lookup after a lost answer).
- It does not limit your own function, or how long a person takes to approve: a held request is answered at once and claimed later.
- A `request` that is not answered in time is refused locally, but Guardian may have received it and may hold it for a person. The SDK does not know its outcome and proposes a new request on a retry; `client.pending()` lists what is held and `client.withdraw(requestId)` withdraws one.
- `signal` ends every call of the client, a redemption in flight included (its outcome is then unknown, and the lookup is refused too). To stop one tool call without abandoning an action that already started, wrap the call in `abortable(client, signal, run)`, as the LangChain and Vercel AI adapters do.

`abortable(client, signal, run)` is that helper: `run(client, startTool)` gets the client to use for this one call and calls `startTool()` just before the local tool runs. An abort before the tool starts rejects at once and refuses every later step, so a late ALLOW runs nothing and redeems nothing; once the tool has started (your function runs, or Guardian was asked to perform a `remote` call), the call waits for its real outcome. A later `GuardianApprovalPending.resume()` is unaffected. With `installRecordTransport: true`, pass the Guardian context as a fourth argument (`abortable(client, signal, run, ctx)`), so that executing a registration step an earlier call left held for approval is not taken for the tool starting.

## Held requests are scoped per session (unreleased)

A Guardian context (`createGuardianContext`, and so `createGuard` and every adapter) remembers each call held for approval, by connection, tool name and arguments. The same call made again then claims the held request instead of opening a new one, in both `onAsk` modes. When one context serves several users or conversations, say which session each call belongs to, so that a held request is claimed only by the same call in the same session:

```ts
import {
  createGuardianContext,
  runThroughGuardian,
  scopeHeldRequests,
} from "@odingard/guardian-sdk";

const ctx = createGuardianContext({ client, connectionId: "pcn_…", mode: "inProcess" }); // once

// per call: `sessionId` is your user id, conversation id or thread id
const result = await runThroughGuardian(
  scopeHeldRequests(ctx, sessionId),
  "refund_order",
  input,
  (approved) => refund(approved),
);
```

- A scope is a string. It is part of an in-memory key only, as a SHA-256 digest; it is not sent to Guardian or put in the proposal.
- A request held under one scope is claimed only by the same call under the same scope. An identical call under another scope is proposed as its own request and needs its own approval.
- `SCOPE_UNKNOWN` is the scope of a call whose session is not known: its held request is not remembered, so no later call can claim it and every call proposes its own. `resolveHeldScope(() => …)` turns a failing or non-string answer into `SCOPE_UNKNOWN`.
- **Without a scope (`undefined`), one context must serve one principal** (one user, one conversation): an identical call from anywhere claims the held request. This is the behaviour of earlier versions, and of `createGuard`, which takes no scope: make one guard per session with `createGuard`, or use `runThroughGuardian` with `scopeHeldRequests` as above.
- `GuardianApprovalPending.resume()` claims that call's own request, whatever the scope.
- The adapters take a `scope` option: LangChain (default: LangGraph's `configurable.thread_id`), Vercel AI and the OpenAI Agents SDK (no default; see their READMEs).

## What the agent can and cannot do

- The agent only ever holds a scoped, revocable agent credential (`gak_…`).
- Provider secrets (API keys, OAuth tokens) live in the Guardian vault and are
  leased to the adapter at execution time — the agent never sees them.
- `ASK` decisions wait for a human. `DENY` stops the action before execution.
- `receipts(requestId)` returns the machine-readable proof of what happened,
  who authorized it, and what authority version applied.

## Lifecycle and governed actions (0.2)

| Result from `request` / `claim`                                                                | `classifyRequestResult` | What to do                                                   |
| ---------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------ |
| `{ ok: true, decision: "ALLOW", capabilityToken }`                                             | `ALLOW`                 | `execute({ requestId, capabilityToken })`                    |
| `{ ok: true, decision: "ASK" }` or `{ ok: false, reasonCode: "APPROVAL_REQUIRED", requestId }` | `ASK`                   | keep `requestId`; `claim(requestId)` after the human decides |
| anything else (DENY, `SERVICE_UNAVAILABLE`, ALLOW without token)                               | `DENY`                  | do not run the effect                                        |

A held ASK always carries its `requestId` (0.2 and later).

Invocation types: `tool.invoke`, `mcp.install`, `mcp.enable` (typed), and the
governed pass-through actions `api.request`, `protected_data.derive|transform|export`,
`agent.message`, `agent.share_context`, `agent.share_memory`,
`agent.transfer_task`, `agent.transfer_capability` (you supply
`materialParameters`; Guardian validates them). Optional provenance:
`purpose`, `intentId`, `planId`, `parentActionId`, `sourceEffectId`. The wire
schemas are exported from `@odingard/guardian-sdk/contracts`.

## Verify a decision without an account

```ts
import {
  fetchReceiptVerificationKeys,
  verifyReceiptOffline,
  verifyReceiptOnline,
} from "@odingard/guardian-sdk";

const { receipt } = await guardian.portableReceipt(requestId); // greceipt.v1
const keys = await fetchReceiptVerificationKeys(
  "https://guardian-api.odingard.com",
); // public
verifyReceiptOffline(receipt, keys.keys);
// → { valid: true, decision: "ALLOW", effect: "verified", subject } — or { valid: false, reasonCode }
```

Offline verification checks the Ed25519 signature over the
`guardian-canonical-json.v1` body and re-derives every embedded record against
the record's evidence chain. It needs no credential, plan or Guardian service
once you hold the keys, and is never billed. Guardian publishes its newest keys. For a record signed by an older key, fetch with `fetchReceiptVerificationKeys(base, { forReceipt: receipt })`. `verifyReceiptOnline` asks a
Guardian deployment to do the same over the public `POST /v1/receipts/verify`.

### From the command line

```bash
npx @odingard/guardian-sdk verify record.json                  # keys from guardian-api.odingard.com
npx @odingard/guardian-sdk verify record.json --keys keys.json # no network at all
```

`verify` prints `VALID` with the decision, effect, request and agent, or
`NOT VALID: <reasonCode>`; `--json` prints the result object. It exits 0 for
a valid record, 1 for one that is not valid, and 2 for a usage or input
error (including keys that could not be downloaded). The file may hold the
record itself or an API answer `{ "receipt": … }`. `--base-url <https-url>` fetches
the keys from another Guardian deployment. No account or credential is
needed.

## Verify before acting — for whoever receives the request (0.3.6)

An allowlist trusts the sender. If an agent asks your service to move money
(or do anything else), check **the request**: that it is exactly the action a
person allowed, unchanged.

```ts
import {
  fetchReceiptStatus,
  fetchReceiptVerificationKeys,
  verifyBeforeActing,
} from "@odingard/guardian-sdk";

const base = "https://guardian-api.odingard.com";
const keys = await fetchReceiptVerificationKeys(base); // cache it
const verdict = await verifyBeforeActing(
  record, // the signed decision record the agent sent you
  keys,
  {
    action: "api.request",
    materialParameters: requestYouReceived, // method, url, headers, body
    valueCents: 100, // what you are about to move
    merchantId: "your-merchant-id", // you, as the destination
    currency: "usd",
  },
  {
    seenRequestIds: alreadyServed, // one authorization moves money once
    status: (r) => fetchReceiptStatus(base, r), // still in force right now?
  },
);
if (!verdict.ok) refuse(verdict.reasonCode, verdict.detail);
```

It returns OK only if **all** of these hold:

- the record is a genuine `greceipt.v1`, valid offline;
- the request you received equals the authorized action field for field;
- Guardian allowed it, or a person approved it;
- it is not revoked, expired or already used;
- amount, destination and currency match;
- it is fresh (default 5 minutes);
- you have not already acted on it.

Anything else refuses with a reason code such as `REQUEST_MISMATCH` or `AMOUNT_MISMATCH`.

`fetchReceiptStatus` calls the public `POST /v1/receipts/status`. The signed record itself is the credential, and the reply is only a status (`active`, `pending`, `revoked`, `expired`, `used`, `paused` or `unknown`), never identities.

## Missions (unreleased)

A person approves one mission card in the Guardian console: an agent, a total
budget, an end time, and the connections, actions and sites it covers. The
approval issues a mission credential for that agent. Inside the card's limits,
requests made with it need no new approval; sending email still asks.

```ts
import { createMissionClient } from "@odingard/guardian-sdk";

const guardian = createMissionClient({
  baseUrl: "https://guardian-api.odingard.com",
  agentCredential: process.env.GUARDIAN_AGENT_CREDENTIAL!,
  missionCredential: process.env.GUARDIAN_MISSION_CREDENTIAL!,
});

const result = await guardian.request({
  action: "tool.invoke",
  connectionId: "pcn_…",
  toolName: "book_flight",
  arguments: { amount: "640.00" },
});
// result.via: "mission" (decided under the mission) or "standing"
```

- `createMissionClient(config)` has the methods of `createGuardianClient`.
  `request` uses the mission credential. When Guardian refuses because the
  mission does not cover the action (`missionFallsBack`,
  `MISSION_FALLBACK_REASONS`: an authorization refusal, which hosted Guardian
  answers as `NOT_AUTHORIZED`, or the mission has ended), the same action is
  sent as a new request with the agent credential, where the person's usual
  permissions apply with every check, so a fallback can cost one extra
  approval request, never an unapproved action. Guardian unreachable, a
  malformed or conflicting request, or an approval already required are
  returned as they are. The result names the credential that
  decided (`via`) and, after a fallback, the mission's refusal
  (`missionReasonCode`). `claim`, `execute` and record lookups use the
  credential that made the request; a request id the client did not make is
  refused with `MISSION_REQUEST_UNKNOWN`.
- `verifyMissionRecordOffline(record, keys)` checks a signed mission record
  (`guardian.mission-record.v1`: the approved card, its limits, the
  permissions the approval issued, who approved it and when) against
  Guardian's published keys (the key set in
  [Verify a decision without an account](#verify-a-decision-without-an-account)).
  The record is signed under its own
  domain (`MISSION_RECORD_DOMAIN`). It returns `{ valid: true, keyId }` or
  `{ valid: false, reasonCode }` with `RECORD_MALFORMED`,
  `RECORD_KEY_UNKNOWN`, `RECORD_SIGNATURE_INVALID` or `RECORD_DIGEST_MISMATCH`.

## Embedded approvals — humans only

`createEmbeddedApprovalClient({ baseUrl, sessionToken })` lets your own UI list,
view, approve/deny and revoke pending approvals. It requires a **human** session
token. Agent credentials (`gak_…`, `gac1.…`) and capability tokens (`gcap.…`)
are refused locally (`HUMAN_SESSION_REQUIRED`) before any request is sent, and
the server independently accepts only human sessions on these routes. Agent
credentials can never approve, create grants or revoke.

## Catalog metadata (declarative)

`guardianCatalog` (also `@odingard/guardian-sdk/catalog.json`) is generated from
Guardian's canonical catalog: verticals, agent systems, agent roles and
entities, each vertical with its tier and maturity. `guardianCatalog.counts`
gives the current totals, and `guardianCatalog.tierLegend` explains each tier.
It grants nothing: every action is still decided at runtime under a human's
policy. Tiers: `governed` (built-in actions and existing adapters cover the
vertical), `integration-ready` (governed decision path; external adapters
declared, not built) and `production-integrated` (recorded external-system
proof). Maturity L1 = built-in governed, L2 = modeled/decidable, L3 =
production-integrated with recorded proof.
`verticalsForAction("tool.invoke")` lists verticals using an action.

## What this SDK reaches

- Decision, capability and execute for `api.request`, Gmail, Calendar and tool/MCP connections.
- Signed decision record retrieval and offline or online verification.
- Embedded human approvals; these need a human session from your Guardian sign-in.
- Framework `inProcess` mode: decision-gated — see below.

## Plans and limits

The free tier needs no card. Over a limit, the API returns
`403 PLAN_LIMIT_EXCEEDED` naming your plan, the limit and current usage.
Plans: Free ($0), Developer ($99/month, 25,000 billable executions included, then $0.001 each, $500 default overage cap) and Enterprise (talk to us). Details: [odingard.com/guardian](https://odingard.com/guardian#gd-pricing).
Reading signed decision records and verifying them is never metered.

## Related packages

MCP server, LangChain.js and Vercel AI SDK adapters, plus runnable
examples, live in the [guardian-sdk repository](https://github.com/Odingard/guardian-sdk#packages).

## License

Apache-2.0
