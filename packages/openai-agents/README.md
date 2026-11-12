# @odingard/guardian-openai-agents

OpenAI Agents SDK adapter for Guardian — every tool call goes through a
deterministic `ALLOW` / `ASK` / `DENY` authority decision before the tool
runs. The agent proposes; the human decides.

**Tested, but not yet proven against a live Guardian and a live model.** The
tests run the real Agents SDK runner with a scripted model and a stubbed
Guardian client.

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
  connectionId: "pcn_…",
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
  // Show pending.requestId to a person. Poll until they decide or the
  // request expires. The tool runs only after approval; a denial or expiry
  // throws GuardianDenied.
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    try {
      const { output, receipt } = await pending.resume();
      console.log("approved", output, receipt);
      break;
    } catch (again) {
      if (findApprovalPending(again)) continue;
      console.log("not approved", again);
      break;
    }
  }
}
```

`refund` stands for your own code. Nothing here has been run against a
live Guardian or a live model.

Register each tool once on the connection in the Guardian console
(Connections → tool server → "My own code (record-only)") and allow it for
the agent.

## What each decision does

- `ALLOW` — Guardian issues a single-use capability. Your `execute` runs
  once with the call's arguments, then the capability is redeemed and a
  receipt recorded (`onReceipt` gets it). A failed redemption raises
  `GuardianExecutionFailed` with `localEffectRan: true`. Without your own
  `errorFunction`, the model is told the tool ran without a receipt and not
  to call it again. If the SDK's own `timeoutMs` has already fired, the SDK
  has told the model the tool timed out, and this failure is not reported
  to the model.
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
  is told `Guardian could not check refund_order, so it did not run. Try again later.`, and
  `onGuardianError` is called. `decisionTimeoutMs` (default 30000) bounds the
  wait for Guardian's decision; the Agents SDK's own `timeoutMs` and run
  cancellation stop the wait too, but only while Guardian is still deciding.
  Once Guardian has allowed the call and your `execute` has started, neither
  stops it: the SDK may tell the model the tool timed out while your
  `execute` and the receipt still finish. Keep your own `execute` within the
  SDK timeout, and make side effects idempotent.

The arguments Guardian checks are the ones the Agents SDK parsed from the
tool call, and the same value is passed to `execute`. Text the model writes
(for example "this was already approved") is never read as a decision.
Parallel tool calls are each checked on their own.

Tools with an `outputSchema` cannot return a plain message, so for them
DENY and Guardian failures are thrown to the tool's `errorFunction` (by
default the run fails), and ASK always throws `GuardianApprovalPending`,
even with `onAsk: "result"`.

## Two execution modes

| Mode                  | What happens on `ALLOW`                                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inProcess` (default) | Your `execute` runs, then `client.execute` redeems the capability and records the evidence. Needs a record-only catalog entry for the tool on the connection    |
| `remote`              | The tool name is a registered catalog entry Guardian calls itself. `client.execute` performs the call; your `execute` **never runs**; the result is the receipt |

In-process mode is decision-gated: `execute` runs after `ALLOW` and before
the capability is redeemed, so a revocation at redemption lands after the
effect. Use `mode: "remote"` where Guardian itself must hold the effect.
In remote mode, a call Guardian performed whose receipt status is not
`sent-verified` (for example the upstream answered with an error) is a
`GuardianExecutionFailed`, and the model is told it did not complete; it is
never reported as an `ALLOW` result.
`modes` sets the mode per tool name. The Agents SDK renames tools: every
character that is not a letter or a digit becomes `_` (`refund-order`
becomes `refund_order`), and Guardian sees the new name. A `modes` entry
under the name you wrote is applied to the new name; two entries for the
same tool that disagree are refused when the tool is built. `installRecordTransport`
is off by default. `true` makes the adapter propose the record-only entry
itself on first use (this needs a grant that allows it; production usually
does not), and it only works for a tool that has no entry yet: an "already
registered" answer is refused (`RECORD_TRANSPORT_UNVERIFIED`) and nothing
runs, including after a restart for an entry the adapter created itself,
because which entries it registered is kept in memory only. Once the entry
exists, use it with the option off.

Setting the Agents SDK's own `needsApproval` on a tool adds a local approval
step before Guardian is asked. It never replaces Guardian's decision.

Options: `client`, `connectionId`, `adapterId?`, `agentName?`, `purpose?`
(string or `(toolName, input) => string`), `mode?`, `modes?`,
`installRecordTransport?`, `onAsk?` (`"throw"` default, or `"result"`),
`onDeny?` (`"result"` default, or `"throw"`), `decisionTimeoutMs?`,
`onApprovalPending?`, `onGuardianError?`, `onReceipt?`.

## Pin the contents of file arguments — `fileArgs` (0.2)

Approval binds the exact arguments. A file path is an argument; the file's contents are not, unless you declare the argument in `fileArgs`.

With `fileArgs`, the SDK on your machine reads the file, puts its SHA-256 in the approved arguments, and checks it again just before the tool runs. Guardian's servers never see the file. If the file changed, the call is refused with `CONTENT_CHANGED_SINCE_APPROVAL` (`GuardianExecutionFailed`, `localEffectRan: false`): the tool does not run, the capability is not redeemed, and a new approval is needed.

```ts
const sendReport = guardianTool(
  { name: "send_report", description, parameters, execute },
  {
    client,
    connectionId: "pcn_…",
    fileArgs: { send_report: { attachmentPath: "bytes" } },
  },
);
```

The Agents SDK renames tools whose names contain characters other than letters and digits (`send-report` becomes `send_report`). A `fileArgs` entry under the name you wrote is moved to the new name, as `modes` is; two entries that disagree are refused when the tool is built. A content-pin refusal is reported to the model as "did not run". Retrying the same held call claims the held request; a changed file is proposed again and needs a new approval.

- `bytes` passes your tool the verified bytes. `copy` passes a private copy; another process running as the same user could still change it, and the copy is deleted when your tool returns, so a tool that keeps using the path afterwards (for example a background upload) must use `bytes`. `recheck` checks the file and then lets your tool open it, so a short window remains.
- File paths must be absolute. The SDK does not resolve relative paths or `~`.
- `fileArgs` needs `inProcess` mode (this wrapper's default). In `remote` mode Guardian runs the tool and cannot read your files, so `fileArgs` there is refused when the tool is built.
- Content pinning is supported on Linux and macOS. On Windows a declared file argument is refused (`CONTENT_PIN_UNSUPPORTED_PLATFORM`).
- **Digest privacy:** the SHA-256 of each pinned file is sent to Guardian, shown to the approver and kept in receipts. For a small or low-entropy file (a token, a PIN, a short config value), anyone who sees the digest can guess the contents offline by hashing candidates. Do not pin files like that, or treat the digest as sensitive as the file.
- This stops a changed file from running under an approval given for different contents. It does not protect against code that bypasses the SDK.
- Not pinned: URLs, provider file ids, and files a tool opens without naming them in a declared argument.

## Not covered

Only function tools built with `guardianTool` / `createGuardianTool` are
governed. Hosted tools (web search, file search, code interpreter, hosted
MCP), computer, shell and apply-patch tools, handoffs and agents used as
tools are not; put MCP servers behind `guardian-mcp` instead.

## License

Apache-2.0
