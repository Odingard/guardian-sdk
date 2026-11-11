# @odingard/guardian-langchain

LangChain.js adapter for Guardian — route a tool's `func` through a
deterministic `ALLOW` / `ASK` / `DENY` authority decision before anything
runs. The agent proposes; the human decides.

## Install

```bash
npm install @odingard/guardian-langchain @odingard/guardian-sdk @langchain/core
```

`@langchain/core` and `@odingard/guardian-sdk` are peer dependencies.

## Two execution modes

| Mode                 | When to use                                                                                             | What happens on `ALLOW`                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `remote` (default)   | The tool name is a registered Guardian catalog entry — a bounded HTTP(S) endpoint Guardian calls itself | `client.execute` performs the call; `invoke` resolves to `{ guardian: { decision: "ALLOW", requestId, receipt } }`. The wrapped impl **never runs** |
| `inProcess` (opt-in) | The wrapped impl IS the tool — the common framework case                                                | The impl runs (only after the capability is issued), then `client.execute` redeems + records the evidence; `invoke` resolves to the impl's output   |

Set `mode` for every tool or `modes` per tool name:

```ts
guardianTool(t, { client, connectionId: "con_…", mode: "inProcess" });
guardianTools(tools, { client, connectionId, modes: { send_wire: "remote" } });
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
first time each tool runs, through the same ALLOW/ASK/DENY gate (a human may
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
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createGuardianClient } from "@odingard/guardian-sdk";
import {
  GuardianApprovalPending,
  GuardianDenied,
  guardianTool,
} from "@odingard/guardian-langchain";

const guardian = createGuardianClient({
  baseUrl: "https://guardian-api.odingard.com",
  credential: process.env.GUARDIAN_AGENT_CREDENTIAL!,
});

const refundOrder = guardianTool(
  tool(async ({ orderId }) => refund(orderId), {
    name: "refund_order",
    description: "Refund an order",
    schema: z.object({ orderId: z.string() }),
  }),
  {
    client: guardian,
    connectionId: "con_…",
    mode: "inProcess",
    // refund_order is registered in the Guardian console (record-only);
    // installRecordTransport is off by default, so nothing is auto-registered.
  },
);

// bindTools([refundOrder]) / use in a LangGraph node — name, description,
// schema and returnDirect are preserved.

try {
  await refundOrder.invoke({ orderId: "ord_123" });
} catch (err) {
  if (err instanceof GuardianApprovalPending) {
    // err.requestId — surface to a human approver, then:
    const { output, receipt } = await err.resume();
  } else if (err instanceof GuardianDenied) {
    // err.reasonCode — refused before execution
  }
}
```

## Pin the contents of file arguments — `fileArgs` (0.4)

Approval binds the exact arguments. A file path is an argument; the file's contents are not, unless you declare the argument in `fileArgs`.

With `fileArgs`, the SDK on your machine reads the file, puts its SHA-256 in the approved arguments, and checks it again just before the tool runs. Guardian's servers never see the file. If the file changed, the call is refused with `CONTENT_CHANGED_SINCE_APPROVAL` (`GuardianExecutionFailed`, `localEffectRan: false`): the tool does not run, the capability is not redeemed, and a new approval is needed.

```ts
const tools = guardianTools([sendReport], {
  client,
  connectionId: "pcn_…",
  mode: "inProcess", // required: the default "remote" cannot read your files
  fileArgs: { send_report: { attachmentPath: "copy" } },
});
```

`"bytes"` hands the tool a `PinnedFile` in place of the path. The wrapper calls a `tool()` / `DynamicStructuredTool` directly (`func`), so `"bytes"` works there; a tool it can only reach through `invoke()` re-validates its input against its schema, so wrapping it with `"bytes"` throws and names `"copy"` as the option. `"copy"` and `"recheck"` work for every tool.

- `bytes` passes your tool the verified bytes. `copy` passes a private copy; another process running as the same user could still change it, and the copy is deleted when your tool returns, so a tool that keeps using the path afterwards (for example a background upload) must use `bytes`. `recheck` checks the file and then lets your tool open it, so a short window remains.
- File paths must be absolute. The SDK does not resolve relative paths or `~`.
- `fileArgs` needs `inProcess` mode. The LangChain and Vercel AI wrappers default to `remote`, where Guardian runs the tool and cannot read your files.
- Content pinning is supported on Linux and macOS. On Windows a declared file argument is refused (`CONTENT_PIN_UNSUPPORTED_PLATFORM`).
- **Digest privacy:** the SHA-256 of each pinned file is sent to Guardian, shown to the approver and kept in receipts. For a small or low-entropy file (a token, a PIN, a short config value), anyone who sees the digest can guess the contents offline by hashing candidates. Do not pin files like that, or treat the digest as sensitive as the file.
- This stops a changed file from running under an approval given for different contents. It does not protect against code that bypasses the SDK.
- Not pinned: URLs, provider file ids, and files a tool opens without naming them in a declared argument.

## What the triad means here

- `ALLOW` — Guardian mints a single-use capability. Remote: `client.execute`
  performs the catalog call and returns the receipt. In-process: the impl
  runs, then `client.execute` redeems + records it. A failed redemption
  throws `GuardianExecutionFailed` — and the impl's own error propagates
  before the record call.
- `ASK` — throws `GuardianApprovalPending` carrying `requestId`. In a
  LangGraph node, catch it and call `interrupt(...)` to pause the graph;
  after human approval, `pending.resume()` claims the capability and
  completes the call. With `onAsk: "result"` the tool instead returns a
  serializable `{ guardian: { decision: "ASK", requestId, … } }`.
- `DENY` — throws `GuardianDenied` carrying `reasonCode` (or returns
  `{ guardian: { decision: "DENY", … } }` with `onDeny: "result"`).

Nothing runs before a decision, and no tool ever runs without a capability
issued for that exact request.

**Arguments are parsed once.** The wrapper parses the call's input with the
wrapped tool's schema, sends that value to Guardian, and calls the wrapped
tool's own function (`func` / `_call`) with the same value. The schema is
not applied a second time, so a schema that transforms its input (for example
dollars to cents) runs the tool with exactly the arguments Guardian approved.
The wrapper reports to LangChain callbacks as one tool run; the wrapped tool
does not start a run of its own. A streaming (async generator) tool is run to
completion before the evidence is recorded.

**`config.signal` (and `config.timeout`) is honoured.** An abort before the
tool starts rejects the call at once, and a late ALLOW then neither runs the
local impl (`inProcess`) nor asks Guardian to perform the call (`remote`).
Once the tool has started (the impl runs, or Guardian has been asked to
perform the call), an abort no longer rejects early: the call waits for the
real outcome and records it, so a started action is never reported as not
done. The wrapped tool does not receive the signal.

**LangGraph's prebuilt `ToolNode`** catches tool errors by default and hands
them to the model as text, so a `GuardianApprovalPending` never reaches your
code and the approval is lost. Use one of:

- `onAsk: "result"` (and `onDeny: "result"`), so the tool returns the
  decision as its output;
- `new ToolNode(tools, { handleToolErrors: false })`, so the error reaches
  your graph and you can `interrupt(...)`;
- your own tool node that catches `GuardianApprovalPending`.

A remote-mode call that Guardian performed but the upstream did not accept
(any receipt status other than `sent-verified`) throws
`GuardianExecutionFailed` with the `requestId`, the receipt and a
`reasonCode` such as `EXECUTION_OUTCOME_PENDING`; it is never returned as an
`ALLOW` result.

`guardianTools(tools, options)` wraps a whole list in one call, sharing one
ensured-catalog cache so a record-transport entry installs at most once.

## License

Apache-2.0
