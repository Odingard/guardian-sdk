<img src="https://raw.githubusercontent.com/Odingard/guardian-sdk/main/assets/guardian-mark.svg" alt="Guardian" width="48" height="48" />

# @odingard/guardian-vercel-ai

Vercel AI SDK adapter for Guardian — route every tool `execute` through a
deterministic `ALLOW` / `ASK` / `DENY` authority decision before anything
runs. The agent proposes; the human decides.

## Install

```bash
npm install @odingard/guardian-vercel-ai @odingard/guardian-sdk ai
```

`ai` and `@odingard/guardian-sdk` are peer dependencies.

## Two execution modes

| Mode                 | When to use                                                                                             | What happens on `ALLOW`                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `remote` (default)   | The tool name is a registered Guardian catalog entry — a bounded HTTP(S) endpoint Guardian calls itself | `client.execute` performs the call; the call resolves to `{ guardian: { decision: "ALLOW", requestId, receipt } }`. The local `execute` impl **never runs** |
| `inProcess` (opt-in) | The local `execute` impl IS the tool — the common framework case                                        | The impl runs (only after the capability is issued), then `client.execute` redeems + records the evidence; the call resolves to the impl's output           |

Set `mode` for every tool or `modes` per tool name:

```ts
withGuardian(tools, {
  client,
  connectionId: "pcn_…",
  modes: { refund_order: "inProcess" }, // everything else remote
});
```

`inProcess` needs a `transport: "record"` catalog entry on the connection so
`execute` commits evidence instead of performing an HTTP call.

**Register the tool in the Guardian console first** (connect a tool server,
add the tool as "My own code (record-only)", allow it for the agent). That is
all the adapter needs: `installRecordTransport` is off by default, so the
adapter never tries to register the tool itself. Hosted Guardian refuses the
adapter's own registration (`mcp.install`) unless the agent's grant pins it.

Auto-registration is off by default. `installRecordTransport: true` turns it
on: the adapter then proposes `mcp.install` and `mcp.enable` of that entry the
first time each tool is called, through the same ALLOW/ASK/DENY gate (a human may
need to approve it once). An "already enabled" answer goes on to the tool call,
which Guardian still decides. **It only works for a tool that has no entry
yet.** An "already installed" answer is refused (`RECORD_TRANSPORT_UNVERIFIED`)
and nothing runs: Guardian does not say whether the existing entry is
record-only, and if it makes an HTTP call your code and Guardian would both
act. Which entries the adapter registered is kept in memory only, so after a
restart, in another worker or on a cold start, the same tool is refused that
way even though the adapter created the entry itself. Once the entry exists,
use it as a console-registered tool with `installRecordTransport` off. **This
requires a Guardian control plane with record-transport support**; a client
that can't form the proposal raises `GuardianRecordTransportRequired` before
any network call.

## Usage

```ts
import { tool } from "ai";
import { z } from "zod";
import { createGuardianClient } from "@odingard/guardian-sdk";
import {
  GuardianApprovalPending,
  GuardianDenied,
  withGuardian,
} from "@odingard/guardian-vercel-ai";

const guardian = createGuardianClient({
  baseUrl: "https://guardian-api.odingard.com",
  credential: process.env.GUARDIAN_AGENT_CREDENTIAL!,
});

const tools = withGuardian(
  {
    refund_order: tool({
      description: "Refund an order",
      inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
      execute: async ({ orderId, amount }) => refund(orderId, amount),
    }),
  },
  {
    client: guardian,
    connectionId: "pcn_…",
    agentName: "billing-agent",
    mode: "inProcess",
    // refund_order is registered in the Guardian console (record-only);
    // installRecordTransport is off by default, so nothing is auto-registered.
  },
);

// With ai v5 and later, generateText does not throw a tool's error: it comes
// back as a `tool-error` content part (in `result.steps[i].content` for
// multi-step runs), and the model sees it as the result.
const result = await generateText({ model, tools, prompt });
for (const part of result.content) {
  if (part.type !== "tool-error") continue;
  if (part.error instanceof GuardianApprovalPending) {
    // part.error.requestId — surface to a human approver, then:
    const { output, receipt } = await part.error.resume();
  } else if (part.error instanceof GuardianDenied) {
    // part.error.reasonCode — refused before execution
  }
}
```

To have the model see the decision as ordinary tool output instead, pass
`onAsk: "result"` and `onDeny: "result"`.

The AI SDK's `abortSignal` is honoured: if the call is aborted while Guardian
has not answered, the tool call rejects at once, and nothing runs even if an
ALLOW arrives later: in-process, the local tool does not run; in remote mode,
Guardian is not asked to perform the call. Once the tool has started (the
local tool runs, or Guardian has been asked to perform the call), an abort no
longer rejects early, so a started action is never reported as not done. A
`resume()` after an approval is not tied to the original signal.

## Pin the contents of file arguments — `fileArgs` (0.4)

Approval binds the exact arguments. A file path is an argument; the file's contents are not, unless you declare the argument in `fileArgs`.

With `fileArgs`, the SDK on your machine reads the file, puts its SHA-256 in the approved arguments, and checks it again just before the tool runs. Guardian's servers never see the file. If the file changed, the call is refused with `CONTENT_CHANGED_SINCE_APPROVAL` (`GuardianExecutionFailed`, `localEffectRan: false`): the tool does not run, the capability is not redeemed, and a new approval is needed.

```ts
const tools = withGuardian(
  { send_report: sendReport },
  {
    client,
    connectionId: "pcn_…",
    mode: "inProcess", // required: the default "remote" cannot read your files
    fileArgs: { send_report: ["attachmentPath"] }, // no mode named: bytes
  },
);
// execute(input, options) receives input.attachmentPath as a PinnedFile
```

- **`bytes` is the default when you don't name a mode.** `fileArgs: { send_report: ["attachmentPath"] }` (or `{ attachmentPath: true }`) means `bytes`: your tool receives the verified bytes themselves, so there is no gap between the check and the read. Name `"copy"` or `"recheck"` only when a tool needs a path; explicit modes work as before.
- `bytes` passes your tool the verified bytes. `copy` passes a private copy; another process running as the same user could still change it, and the copy is deleted when your tool returns, so a tool that keeps using the path afterwards (for example a background upload) must use `bytes`. `recheck` checks the file and then lets your tool open it, so a short window remains.
- File paths must be absolute. The SDK does not resolve relative paths or `~`.
- `fileArgs` needs `inProcess` mode. The LangChain and Vercel AI wrappers default to `remote`, where Guardian runs the tool and cannot read your files.
- **Opt-in preview for the approver (sdk 0.5):** `{ attachmentPath: { mode: "bytes", preview: true } }` also puts the file's type, size and, for a text file, its first 20 lines (at most 2,048 bytes) in the pin, so the approval shows them next to the file name. The preview text leaves your machine and is stored with the approval like any other argument, also on deny; the short forms never send one. The agent picks the path, so add `previewRoots: ["/srv/reports"]` to preview only files in those folders (others get a size-only `withheld` preview). Details in the [SDK README](../sdk/README.md#show-the-approver-the-first-lines-of-the-file--preview-05-opt-in).
- Content pinning is supported on Linux and macOS. On Windows a declared file argument is refused (`CONTENT_PIN_UNSUPPORTED_PLATFORM`).
- **Digest privacy:** the SHA-256 of each pinned file is sent to Guardian, shown to the approver and kept in receipts. For a small or low-entropy file (a token, a PIN, a short config value), anyone who sees the digest can guess the contents offline by hashing candidates. Do not pin files like that, or treat the digest as sensitive as the file.
- This stops a changed file from running under an approval given for different contents. It does not protect against code that bypasses the SDK.
- Not pinned: URLs, provider file ids, and files a tool opens without naming them in a declared argument.

## Dollar amounts on tools — `amountArgs` (0.6)

If the owner set a dollar amount on a tool in the Guardian console, pass the same declaration in `amountArgs`, e.g. `amountArgs: { purchase: { argument: "amount", unit: "minor", currency: "usd" } }`. The wrapper passes it to the SDK unchanged: each call of that tool carries the declaration and the amount, Guardian decides on the amount, and a call whose amount cannot be read is blocked. In `remote` mode (the default) Guardian sends the call, so the limit applies to what reaches the tool; in `inProcess` mode your code runs the tool, so the limit applies to Guardian's decision. The owner states, by naming the argument, that it sets the charge and, without a currency argument, that the tool charges in US dollars; Guardian can't check either. Every tool on the same connection needs an amount (or none does); put tools that spend money on their own connection. See the [SDK README](../sdk/README.md#dollar-amounts-on-tools--amountargs-06).

## What the triad means here

- `ALLOW` — Guardian mints a single-use capability. Remote: `client.execute`
  performs the catalog call and returns the receipt. In-process: the local
  impl runs, then `client.execute` redeems + records it. A failed
  redemption throws `GuardianExecutionFailed` — and in `inProcess` mode the
  impl's own error propagates before the record call.
- `ASK` — throws `GuardianApprovalPending` carrying `requestId`. After the
  human approves in Guardian, `pending.resume()` claims the capability and
  completes the call. With `onAsk: "result"` the tool instead returns a
  serializable `{ guardian: { decision: "ASK", requestId, … } }` to the
  model.
- `DENY` — throws `GuardianDenied` carrying `reasonCode` (or returns
  `{ guardian: { decision: "DENY", … } }` with `onDeny: "result"`).
- A remote-mode call that Guardian performed but the upstream did not accept
  (any receipt status other than `sent-verified`) throws
  `GuardianExecutionFailed` with the `requestId`, the receipt and a
  `reasonCode` such as `EXECUTION_OUTCOME_PENDING`; it is never returned as
  an `ALLOW` result, and `onReceipt` is not called.

Nothing runs before a decision, and no tool ever runs without a capability
issued for that exact request.

Options: `client`, `connectionId`, `adapterId?`, `agentName?`, `mode?`,
`modes?`, `installRecordTransport?`, `purpose?` (string or
`(toolName, input) => string`), `onAsk?`, `onDeny?`, `onReceipt?` (called
with `{ toolName, requestId, receipt }` after each `ALLOW`).

## License

Apache-2.0
