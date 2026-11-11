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
  connectionId: "con_…",
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
    connectionId: "con_…",
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
