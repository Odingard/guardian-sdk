# @odingard/guardian-openai-agents

OpenAI Agents SDK adapter for Guardian — every tool call goes through a
deterministic `ALLOW` / `ASK` / `DENY` authority decision before the tool
runs. The agent proposes; the human decides.

Not yet proven live: tested against the real Agents SDK runner with a
scripted model and a stubbed Guardian client only.

## Install

```bash
npm install @odingard/guardian-openai-agents @odingard/guardian-sdk @openai/agents zod
```

`@openai/agents` (0.21.x) and `@odingard/guardian-sdk` are peer
dependencies.

## Usage

`guardianTool` takes the same options as the Agents SDK's `tool()`, plus
the Guardian options. `createGuardianTool` binds the Guardian options once.

```ts
import { Agent, run } from "@openai/agents";
import { z } from "zod";
import { createGuardianClient } from "@odingard/guardian-sdk";
import {
  createGuardianTool,
  findApprovalPending,
} from "@odingard/guardian-openai-agents";

const guardian = createGuardianClient({
  baseUrl: "https://guardian-api.odingard.com",
  credential: process.env.GUARDIAN_AGENT_CREDENTIAL!,
});

const governed = createGuardianTool({
  client: guardian,
  connectionId: "con_…",
  agentName: "billing-agent",
});

const refundOrder = governed({
  name: "refund_order",
  description: "Refund an order",
  parameters: z.object({ orderId: z.string(), amount: z.number() }),
  execute: async ({ orderId, amount }) => refund(orderId, amount),
});

const agent = new Agent({ name: "Billing", tools: [refundOrder] });

try {
  const result = await run(agent, "Refund order 42");
  console.log(result.finalOutput);
} catch (err) {
  const pending = findApprovalPending(err);
  if (!pending) throw err;
  // pending.requestId: a person approves it in Guardian, then:
  const { output, receipt } = await pending.resume();
}
```

Register each tool once on the connection in the Guardian console
(Connections → tool server → "My own code (record-only)") and allow it for
the agent.

## What each decision does

- `ALLOW` — Guardian issues a single-use capability. Your `execute` runs
  once with the call's arguments, then the capability is redeemed and a
  receipt recorded (`onReceipt` gets it). A failed redemption raises
  `GuardianExecutionFailed` with `localEffectRan: true`.
- `ASK` — your `execute` does not run. By default the call throws
  `GuardianApprovalPending`; the Agents SDK ends the run with a
  `ToolCallError` that wraps it, and `findApprovalPending(err)` finds it.
  After a person approves in Guardian, `pending.resume()` claims the
  approval and runs the tool once. If they deny, or the request expires,
  `resume()` throws `GuardianDenied` and the tool never runs. Before they
  decide, `resume()` throws a new `GuardianApprovalPending`.
  With `onAsk: "result"` the run keeps going: the model is told the call is
  waiting for approval, and `onApprovalPending(pending)` gives your app the
  handle.
- `DENY` — your `execute` never runs. The model gets a plain refusal
  (`Guardian denied refund_order (POLICY_DENY). It did not run. …`). With
  `onDeny: "throw"`, `GuardianDenied` goes to the tool's `errorFunction`
  instead.
- Guardian error, network failure, timeout or a cancelled call — your
  `execute` never runs, and a late answer from Guardian is ignored. The model
  is told `Guardian could not check refund_order, so it did not run.`, and
  `onGuardianError` is called. `decisionTimeoutMs` (default 30000) bounds the
  wait for Guardian's decision; the Agents SDK's own `timeoutMs` and run
  cancellation stop it too.

The arguments Guardian checks are the ones the Agents SDK parsed from the
tool call, and the same value is passed to `execute`. Text the model writes
(for example "this was already approved") is never read as a decision.
Parallel tool calls are each checked on their own.

Tools with an `outputSchema` cannot return a plain message, so for them
ASK, DENY and Guardian failures are thrown to the tool's `errorFunction`
(by default the run fails).

## Two execution modes

| Mode                  | What happens on `ALLOW`                                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inProcess` (default) | Your `execute` runs, then `client.execute` redeems the capability and records the evidence. Needs a record-only catalog entry for the tool on the connection    |
| `remote`              | The tool name is a registered catalog entry Guardian calls itself. `client.execute` performs the call; your `execute` **never runs**; the result is the receipt |

In-process mode is decision-gated: `execute` runs after `ALLOW` and before
the capability is redeemed, so a revocation at redemption lands after the
effect. Use `mode: "remote"` where Guardian itself must hold the effect.
`modes` sets the mode per tool name. `installRecordTransport: true` makes the
adapter propose the record-only entry itself on first use (this needs a
grant that allows it; production usually does not).

Setting the Agents SDK's own `needsApproval` on a tool adds a local approval
step before Guardian is asked. It never replaces Guardian's decision.

Options: `client`, `connectionId`, `adapterId?`, `agentName?`, `purpose?`
(string or `(toolName, input) => string`), `mode?`, `modes?`,
`installRecordTransport?`, `onAsk?` (`"throw"` default, or `"result"`),
`onDeny?` (`"result"` default, or `"throw"`), `decisionTimeoutMs?`,
`onApprovalPending?`, `onGuardianError?`, `onReceipt?`.

## Not covered

Only function tools built with `guardianTool` / `createGuardianTool` are
governed. Hosted tools (web search, file search, code interpreter, hosted
MCP), computer, shell and apply-patch tools, handoffs and agents used as
tools are not; put MCP servers behind `guardian-mcp` instead.

## License

Apache-2.0
