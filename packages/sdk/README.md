<p align="center">
  <img src="https://raw.githubusercontent.com/Odingard/guardian-sdk/main/.github/assets/guardian-logo.png" alt="Guardian — human authority for AI" width="640" />
</p>

# @odingard/guardian-sdk

[![npm version](https://img.shields.io/npm/v/@odingard/guardian-sdk)](https://www.npmjs.com/package/@odingard/guardian-sdk)
[![npm downloads](https://img.shields.io/npm/dm/@odingard/guardian-sdk)](https://www.npmjs.com/package/@odingard/guardian-sdk)
[![MCP registry](https://img.shields.io/badge/MCP_registry-guardian--mcp-blue)](https://registry.modelcontextprotocol.io/)
[![Guardian MCP server on mcprush](https://mcprush.com/badge/odingard-guardian-mcp/card.svg)](https://mcprush.com/to/odingard-guardian-mcp?ref=badge)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/Odingard/guardian-sdk/blob/main/LICENSE)

**Human Authority Infrastructure for Autonomous AI.** The agent proposes; the human
decides. This SDK lets an AI agent request governed capabilities and execute
consequential actions under human authority. Every decision is deterministic (`ALLOW` / `ASK` / `DENY`) and every
execution produces a tamper-evident receipt.

Hosted Guardian: [guardian.odingard.com](https://guardian.odingard.com) — free tier for developers
(2 connections, 1 agent, 500 protected actions a month), no card required.

## Install

```bash
npm install @odingard/guardian-sdk
```

Requires Node.js >= 22 (receipt verification uses `node:crypto` Ed25519; browser runtimes are not supported).

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
the receipt when it does. This works from any agent framework: OpenAI Agents
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
    const { output } = await err.resume(); // after approval: runs your code, records the receipt
  } else if (err instanceof GuardianDenied) {
    console.warn("blocked:", err.reasonCode); // DENY: your code never ran
  } else throw err;
}
```

| Decision  | Your function                                                                             |
| --------- | ----------------------------------------------------------------------------------------- |
| **ALLOW** | Runs once, then the capability is redeemed and the receipt recorded (`onReceipt`).        |
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

Runnable: [`examples/invoice-agent.mjs`](../../examples/invoice-agent.mjs).
For Python, see [`odingard-guardian`](../python).

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
- **Digest privacy:** the SHA-256 of each pinned file is sent to Guardian, shown to the approver and kept in receipts. For a small or low-entropy file (a token, a PIN, a short config value), anyone who sees the digest can guess the contents offline by hashing candidates. Do not pin files like that, or treat the digest as sensitive as the file.
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
- **Privacy: the preview text leaves your machine.** It travels to Guardian inside the proposed arguments, is shown to the approver, and is stored with the approval and in receipts like any other argument, **also when the approver denies the call**. Without `preview: true` only the name, size and digest leave your machine. Use `previewRoots` so that only files from folders you chose can be previewed.
- **Display only.** The approval binds the preview because it is part of the arguments, but nothing decides on it: the check just before the tool runs compares the size and SHA-256, as before. The console shows the text as plain text, never as HTML or Markdown.
- Previews count toward the 16 KB tool-arguments limit; a call whose previews push it over is refused (`CONTENT_PIN_TOO_MANY`, "preview fewer files"), never cut silently.
- `contentPreview(name, bytes)` returns the preview for bytes you hold; `normalizeFileArgPreviews(toolName, declaration)` lists the arguments that ask for one and `normalizeFileArgPreviewRoots(toolName, declaration)` their folders. `PREVIEW_MAX_LINES` is 20, `PREVIEW_MAX_BYTES` 2,048 and `PREVIEW_MAX_ROOTS` 16.

`normalizeFileArgs(fileArgs)` / `normalizeFileArgsSpec(toolName, declaration)` return a declaration in the full form (a mode per argument; `DEFAULT_FILE_ARG_MODE` is `"bytes"`) and throw `CONTENT_PIN_INVALID_ARGUMENT` for an invalid one: a mode other than `"bytes"`, `"copy"`, `"recheck"` or `true` (so `false` is refused), or a name that is empty, dotted, reserved, not a string or listed twice. `createGuardianContext` stores the full form.

`pinFile(path, { allowAbsent })` and `verifyPin(path, pin)` are the same checks for code that pins a file itself (the coding-agent hook uses them).

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

A held ASK always carries its `requestId` (fixed in 0.2 — 0.1 dropped it).

Invocation types: `tool.invoke`, `mcp.install`, `mcp.enable` (typed), and the
governed pass-through actions `api.request`, `protected_data.derive|transform|export`,
`agent.message`, `agent.share_context`, `agent.share_memory`,
`agent.transfer_task`, `agent.transfer_capability` (you supply
`materialParameters`; Guardian validates them). Optional provenance:
`purpose`, `intentId`, `planId`, `parentActionId`, `sourceEffectId`. The wire
schemas are exported from `@odingard/guardian-sdk/contracts`.

## Portable receipts — verify without an account

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
the receipt's evidence chain. It needs no credential, plan or Guardian service
once you hold the keys, and is never billed. Guardian publishes its newest keys. For a receipt signed by an older key, fetch with `fetchReceiptVerificationKeys(base, { forReceipt: receipt })`. `verifyReceiptOnline` asks a
Guardian deployment to do the same over the public `POST /v1/receipts/verify`.

### From the command line

```bash
npx @odingard/guardian-sdk verify receipt.json                  # keys from guardian-api.odingard.com
npx @odingard/guardian-sdk verify receipt.json --keys keys.json # no network at all
```

`verify` prints `VALID` with the decision, effect, request and agent, or
`NOT VALID: <reasonCode>`; `--json` prints the result object. It exits 0 for
a valid receipt, 1 for one that is not valid, and 2 for a usage or input
error (including keys that could not be downloaded). The file may hold the
receipt or an API answer `{ "receipt": … }`. `--base-url <https-url>` fetches
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
  receipt,
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

- the receipt is a genuine `greceipt.v1`, valid offline;
- the request you received equals the authorized action field for field;
- Guardian allowed it, or a person approved it;
- it is not revoked, expired or already used;
- amount, destination and currency match;
- it is fresh (default 5 minutes);
- you have not already acted on it.

Anything else refuses with a reason code such as `REQUEST_MISMATCH` or `AMOUNT_MISMATCH`.

`fetchReceiptStatus` calls the public `POST /v1/receipts/status`. The receipt itself is the credential, and the reply is only a status (`active`, `pending`, `revoked`, `expired`, `used`, `paused` or `unknown`), never identities.

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

## Guardian for Steel — `@odingard/guardian-steel`

Browser-agent checkout governed by Guardian: the agent can only propose
`steel.checkout.submit`; ALLOW/ASK/DENY happens before the order; the Steel
session and merchant credential stay on the protected executor side. See
[`packages/steel`](https://github.com/Odingard/guardian-sdk/tree/main/packages/steel) for the boundary and
current maturity.

## Maturity of what this SDK reaches

| Path                                                                                     | Status                                                                                            |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Decision + capability + execute for `api.request`, Gmail, Calendar, tool/MCP connections | LIVE on hosted Guardian                                                                           |
| Portable receipt retrieval + offline/online verification                                 | LIVE (staging and production publish keys)                                                        |
| Embedded human approvals                                                                 | LIVE routes; needs a human session from your Guardian sign-in                                     |
| Steel checkout                                                                           | agent side published; protected executor proven in-process, not yet injected into hosted Guardian |
| Framework `inProcess` mode                                                               | decision-gated only — see below                                                                   |

## Plans and limits

The free tier needs no card. Over a limit, the API returns
`403 PLAN_LIMIT_EXCEEDED` naming your plan, the limit and current usage.
Plans: Free ($0), Developer ($99/month, 25,000 billable executions included, then $0.001 each, $500 default overage cap) and Business (contact sales). Details: [odingard.com/guardian](https://odingard.com/guardian#gd-pricing).
Reading receipts and verifying them is never metered.

## Related packages

MCP server, LangChain.js, Vercel AI SDK and Steel adapters, plus runnable
examples, live in the [guardian-sdk repository](https://github.com/Odingard/guardian-sdk#packages).

## License

Apache-2.0
