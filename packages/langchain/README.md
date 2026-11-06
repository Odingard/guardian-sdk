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
`execute` commits evidence instead of performing an HTTP call. The adapter
auto-proposes `mcp.install` of that entry the first time each tool runs
(same ALLOW/ASK/DENY gate — a human may approve it once). **This requires
a Guardian control plane with record-transport support**; a client that can't form the proposal raises
`GuardianRecordTransportRequired` before any network call. Pass
`installRecordTransport: false` to opt out.

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
  { client: guardian, connectionId: "con_…", mode: "inProcess" },
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

`guardianTools(tools, options)` wraps a whole list in one call, sharing one
ensured-catalog cache so a record-transport entry installs at most once.

## License

Apache-2.0
