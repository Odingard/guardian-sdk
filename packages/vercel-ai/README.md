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
`execute` commits evidence instead of performing an HTTP call. The adapter
auto-proposes `mcp.install` of that entry the first time each tool is called
(it goes through the same ALLOW/ASK/DENY gate — a human may need to approve
it once). **This requires a Guardian control plane with record-transport support**; a client that can't
form the proposal raises `GuardianRecordTransportRequired` before any
network call. Pass `installRecordTransport: false` to opt out (entries must
then be installed some other way).

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
  },
);

try {
  await generateText({ model, tools, prompt });
} catch (err) {
  if (err instanceof GuardianApprovalPending) {
    // err.requestId — surface to a human approver, then:
    const { output, receipt } = await err.resume();
  } else if (err instanceof GuardianDenied) {
    // err.reasonCode — refused before execution
  }
}
```

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

Nothing runs before a decision, and no tool ever runs without a capability
issued for that exact request.

Options: `client`, `connectionId`, `adapterId?`, `agentName?`, `mode?`,
`modes?`, `installRecordTransport?`, `purpose?` (string or
`(toolName, input) => string`), `onAsk?`, `onDeny?`, `onReceipt?` (called
with `{ toolName, requestId, receipt }` after each `ALLOW`).

## License

Apache-2.0
