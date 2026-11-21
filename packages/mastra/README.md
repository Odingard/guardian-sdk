<img src="https://raw.githubusercontent.com/Odingard/guardian-sdk/main/assets/guardian-mark.svg" alt="Guardian" width="48" height="48" />

# @odingard/guardian-mastra (unreleased)

**Guardian is the trust layer for agent commerce.** Human Authority Infrastructure for Autonomous AI: the agent proposes; the human decides.

Mastra adapter for Guardian: route a Mastra tool's `execute` through a
deterministic `ALLOW` / `ASK` / `DENY` authority decision before anything
runs.

## Install

This package is not on npm yet. Until it is released, build it from this
repository (`npm install && npm run build` at the root) and use the workspace
package. After the release:

```bash
npm install @odingard/guardian-mastra @odingard/guardian-sdk @mastra/core
```

`@mastra/core` (`>=1.83.0 <2.0.0`) and `@odingard/guardian-sdk` are peer
dependencies. The package needs the `@odingard/guardian-sdk` release that
adds `abortable` and `scopeHeldRequests`; with an earlier SDK it fails to
load. Tested with `@mastra/core` 1.83.0, 1.84.0 and 1.85.0; the
repository's tests run against 1.85.0.

## Usage

```ts
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { createGuardianClient } from "@odingard/guardian-sdk";
import { guardianTools } from "@odingard/guardian-mastra";

const guardian = createGuardianClient({
  baseUrl: "https://guardian-api-azure.odingard.com",
  credential: process.env.GUARDIAN_AGENT_CREDENTIAL!,
});

const refundOrder = createTool({
  id: "refund_order",
  description: "Refund an order",
  inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
  execute: async ({ orderId, amount }) => refund(orderId, amount),
});

const agent = new Agent({
  id: "billing-agent",
  name: "billing-agent",
  instructions: "Refund orders when asked.",
  model,
  tools: guardianTools(
    { refund_order: refundOrder },
    {
      client: guardian,
      connectionId: "pcn_…",
      agentName: "billing-agent",
      mode: "inProcess",
      // refund_order is registered in the Guardian console (record-only);
      // installRecordTransport is off by default, so nothing is auto-registered.
    },
  ),
});
```

`guardianTool(tool, options)` wraps one tool; `guardianTools({ … }, options)`
wraps a tool record and keeps its keys. Each returned tool is a Mastra tool
with the same `id`, description, schemas and flags, so it goes wherever the
original went. **Guardian knows a tool by its `id`**, not by the key it has
in the agent's `tools`: `modes`, `fileArgs` and `amountArgs` are keyed by
`id`, and that is the name to register in the Guardian console.

A tool without `execute` (a client-side tool) and a render-only tool are
returned unchanged: Mastra does not run them on the server.

## Two execution modes

| Mode                 | When to use                                                                                           | What happens on `ALLOW`                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `remote` (default)   | The tool id is a registered Guardian catalog entry — a bounded HTTP(S) endpoint Guardian calls itself | `client.execute` performs the call; the tool call resolves to `{ guardian: { decision: "ALLOW", requestId, toolName, receipt } }`. The local `execute` **never runs** |
| `inProcess` (opt-in) | The local `execute` IS the tool — the common framework case                                           | The local `execute` runs (only after the capability is issued), then `client.execute` redeems + records the evidence; the tool call resolves to its output         |

Set `mode` for every tool or `modes` per tool id:

```ts
guardianTools(tools, {
  client,
  connectionId: "pcn_…",
  mode: "inProcess",
  modes: { send_wire: "remote" }, // Guardian makes this call itself
});
```

What each mode guarantees:

- **`remote` (enforced):** Guardian holds the credential for the endpoint and
  makes the call. Your process cannot make it without Guardian, the local
  `execute` body is not run, and the model gets Guardian's result (the signed
  record), not your tool's output. A tool's `toModelOutput` and
  `outputSchema` are not applied to that result.
- **`inProcess` (decision-gated):** the tool body runs in your process, only
  after `ALLOW`, on the arguments Guardian decided. The capability is
  redeemed after the body ran, so revocation, expiry and single use are
  checked after the effect. Code that calls the unwrapped tool, or the
  service behind it, directly is not stopped. Use `remote` where Guardian
  must hold the effect itself.

What remote mode needs, and what it does not support, is in
[Enforced mode](../../docs/guides.md#enforced-mode-guardian-makes-the-call-remote).

`inProcess` needs a `transport: "record"` catalog entry on the connection so
`execute` commits evidence instead of performing an HTTP call.

**Register the tool in the Guardian console first** (connect a tool server,
add the tool as "My own code (record-only)", allow it for the agent). That is
all the adapter needs: `installRecordTransport` is off by default, so the
adapter never tries to register the tool itself. Hosted Guardian refuses the
adapter's own registration (`mcp.install`) unless the agent's grant pins it.

`installRecordTransport: true` turns auto-registration on; it behaves as in
the other adapters (see the
[LangChain adapter](../langchain/README.md#two-execution-modes)): it only
works for a tool that has no entry yet, and an "already installed" answer is
refused (`RECORD_TRANSPORT_UNVERIFIED`) and nothing runs.

## What the triad means here

| Guardian says        | What the wrapped tool does                                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALLOW`              | Runs once (`inProcess`), or Guardian performs the call (`remote`), on the decided arguments. The single-use capability is redeemed                                                                                                                      |
| `ASK`                | Does not run. Default: throws `GuardianApprovalPending` with the `requestId`. `onAsk: "result"`: returns `{ guardian: { decision: "ASK", requestId, … } }`. `onAsk: "suspend"`: suspends the Mastra run. The same call after approval claims the request |
| `DENY`               | Does not run. Throws `GuardianDenied` with the `reasonCode` (or returns `{ guardian: { decision: "DENY", … } }` with `onDeny: "result"`). Don't retry with rephrased arguments                                                                          |
| Guardian unreachable | Does not run (fail closed). The error from the client is thrown, or a refusal is reported as `GuardianDenied`                                                                                                                                           |

In a Mastra agent run, an error a tool throws does not end the run: the
model receives the error's message as the tool's result. So with the default
settings the model is told `Guardian held "refund_order" for human approval
(requestId=…)` or `Guardian denied "refund_order" (reasonCode=…)`, and your
code does not see the exception. To handle a held call in your own code, use
`onAsk: "suspend"`.

### Held calls: `onAsk: "suspend"`

With `onAsk: "suspend"`, a held call suspends the Mastra run through the
tool's `suspend`. The run ends with `finishReason: "suspended"` and the
request id in its suspend payload:

```ts
const run = await agent.generate("Refund order ord_9, $250");
if (run.finishReason === "suspended") {
  const { toolCallId, suspendPayload } = run.suspendPayload;
  const { requestId } = suspendPayload.guardian; // show this to the approver
  // …after the person approved the request in Guardian:
  const done = await agent.resumeGenerate({}, { runId: run.runId, toolCallId });
}
```

- **Resuming is not approving.** A resumed run calls the tool again, and the
  wrapper asks Guardian again with the same arguments, which claims the held
  request. The tool runs only if a person approved that request in Guardian.
  The resume data you pass to Mastra is not read. A run resumed before the
  approval suspends again; a request the person denied throws
  `GuardianDenied`.
- Suspend and resume need what they always need in Mastra: the agent
  registered on a `Mastra` instance with storage.
- The held request is remembered in memory, per `guardianTool` /
  `guardianTools` call. A run resumed in another process, or after a
  restart, proposes the call again as a new request, which Guardian decides
  again.
- The resumed call runs on the arguments Guardian was asked about, kept in
  memory for that run and tool call. This matters for a schema that
  generates a value while parsing (a default such as a new id or the
  current time): Mastra hands a resumed tool the model's unparsed
  arguments, and parsing them again would give other values. In another
  process the arguments are parsed again, so such a tool gets a new request
  there. They are kept for 24 hours and removed when the run resumes; a run
  that is never resumed has its entry removed the next time a call of that
  tool is suspended after those 24 hours. A request Guardian holds stays
  open for at most 5 minutes, so nothing a pending approval needs is
  dropped. There is no cap on the number of entries within the 24 hours.
- A tool that declares its own `suspendSchema` or `resumeSchema` cannot be
  wrapped with `onAsk: "suspend"` (wrapping it throws): Mastra would validate
  Guardian's suspend payload against the tool's schema. Use `"throw"` or
  `"result"` for it.
- When the call has no `suspend` (a direct `tool.execute(input)` call), the
  wrapper throws `GuardianApprovalPending` instead.
- The other two answers work without suspending: with `"throw"` (default) or
  `"result"` the model is told the call is held, and when it makes the same
  call again after the approval, that call claims the approved request and
  runs.

Mastra's own tool approval (`requireApproval`, `approveToolCall`) is kept on
the wrapped tool and runs before `execute`, as it does without Guardian. It
does not stand in for Guardian's decision: after a local approval the wrapper
still asks Guardian, and the tool does not run on `ASK` or `DENY`.

### Held requests are scoped per session

The wrapped tools remember each call held for approval, by connection, tool
id and arguments, so that the same call made again claims the held request.
One agent usually serves many conversations, so a held call is claimed only
in its own scope:

- **Default: the run's Mastra thread and resource.** When the run has them
  (`agent.generate(prompt, { memory: { thread, resource } })`, which the
  tool sees as `context.agent.threadId` and `context.agent.resourceId`),
  both together are the scope. The same call in another thread, or in the
  same thread id under another resource, proposes its own request and never
  claims this one. An id that is present but is not a non-empty string is an
  unknown session (see below).
- `scope: (context) => string` names the scope yourself, for example a
  tenant from the request context:
  `scope: (context) => context?.requestContext?.get("tenantId")`. It
  replaces the default: with `scope` set, thread and resource are not used.
- `scope` returns a non-empty string. Anything else means the session is not
  known, and a held call is then never claimed by a later call:
  `SCOPE_UNKNOWN` (from `@odingard/guardian-sdk`), `undefined`, `null`, an
  empty string, any other value, or the function throwing.
- **Without a thread or resource and without `scope`, held calls are
  shared** by every call of the wrapped tools: they must then serve one
  principal (one user, one conversation).
- The scope comes from the context Mastra builds for the tool from what your
  application passes to the run. **It is never read from the tool call's
  arguments**, which the model writes; don't read it from them in a `scope`
  function either.
- The scope stays in this process; it is not sent to Guardian. The arguments
  kept for a call suspended with `onAsk: "suspend"` are kept under the same
  scope, and nothing is kept for a call whose session is not known.

### Arguments

- In an agent or workflow run, Mastra parses the model's arguments with the
  tool's `inputSchema` before `execute`. Guardian decides on that parsed
  value, and the tool body receives a copy of exactly what Guardian decided:
  nothing can change the arguments between the decision and the tool.
  Arguments the schema refuses reach neither Guardian nor the tool.
- When you call `tool.execute(input)` yourself, Guardian decides on the
  value you pass, and the tool's own schema parses it when the tool runs. If
  the schema refuses it, the body does not run, the capability is not
  redeemed, and you get Mastra's validation error.
- Mastra also checks a call's request context (`requestContextSchema`) and
  resume data (`resumeSchema`) before the tool body. A call those checks
  refuse gets Mastra's validation error and Guardian is not asked. If they
  only start refusing after Guardian's answer, the body does not run and the
  capability is not redeemed. An output the tool's `outputSchema` refuses
  comes after the body ran, so that call is recorded.
- The input must be plain data (it is copied with `structuredClone`).

### Abort

Mastra's `abortSignal` is honoured: if the run is aborted while Guardian has
not answered, the tool call rejects at once, and nothing runs even if an
ALLOW arrives later: in-process, the local tool does not run; in remote mode,
Guardian is not asked to perform the call. Once the tool has started (the
local tool runs, or Guardian has been asked to perform the call), an abort no
longer rejects early, so a started action is never reported as not done.

## Pin the contents of file arguments — `fileArgs`

Approval binds the exact arguments. A file path is an argument; the file's
contents are not, unless you declare the argument in `fileArgs`:

```ts
guardianTools(
  { send_report: sendReport },
  {
    client,
    connectionId: "pcn_…",
    mode: "inProcess", // required: the default "remote" cannot read your files
    fileArgs: { send_report: ["attachmentPath"] }, // no mode named: bytes
  },
);
// in an agent run, execute(input) receives input.attachmentPath as a PinnedFile
```

It works as in the other adapters; see the
[SDK README](../sdk/README.md) for the modes, limits and digest privacy. One
point is specific to Mastra: `"bytes"` hands the tool a `PinnedFile` in place
of the path, which works in an agent or workflow run. On a direct
`tool.execute(input)` call the tool's schema parses the input again and
refuses a `PinnedFile` where it expects a string, so nothing runs; use
`"copy"` or `"recheck"` for tools you call directly.

## Dollar amounts on tools — `amountArgs`

If the owner set a dollar amount on a tool in the Guardian console, pass the
same declaration in `amountArgs`, keyed by tool id, e.g.
`amountArgs: { purchase: { argument: "amount", unit: "minor", currency: "usd" } }`.
The wrapper passes it to the SDK unchanged. See the
[SDK README](../sdk/README.md#dollar-amounts-on-tools--amountargs-06).

## Limits

- The wrapper governs the tools you wrap. A tool you add to an agent without
  wrapping it, Mastra's built-in tools, MCP tools you pass in unwrapped, and
  sub-agents or workflows used as tools are not decided by Guardian.
- `inProcess` is decision-gated, not enforced (see above). `remote` is the
  enforced mode.
- A tool that suspends itself (`context.suspend` in its own `execute`) is
  decided once per run of its body: when the run resumes, the call is
  proposed to Guardian again.
- Tested in Mastra's agent loop (`generate`, `stream`, suspend and resume,
  tool approval). Workflow steps, background tasks, tools served through
  Mastra's MCP server and `autoResumeSuspendedTools` reach the same wrapped
  `execute`, but are not covered by this package's tests.
- With `@mastra/core` before 1.83.0 the agent runtime parses a tool's input
  twice, so a tool whose schema changes its input (a `transform`) is refused
  by its own validation after Guardian's answer and does not run. Use 1.83.0
  or later.

Options: `client`, `connectionId`, `adapterId?`, `agentName?`, `mode?`,
`modes?`, `installRecordTransport?`, `purpose?` (string or
`(toolName, input) => string`), `onAsk?` (`"throw"`, `"result"` or
`"suspend"`), `onDeny?`, `scope?`, `onReceipt?` (called with
`{ toolName, requestId, receipt }` after each `ALLOW`), `fileArgs?`,
`amountArgs?`.

## Example

[`examples/agents/mastra-agent.mjs`](../../examples/agents/mastra-agent.mjs)
runs a Mastra agent with a scripted model against the local demo policy (no
account, no API key): ALLOW, ASK with suspend and resume, DENY.

## License

Apache-2.0
