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
  connectionId: "con_…",
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

Since 0.3.1, `createGuard` does not try to register tools itself.
`installRecordTransport: true` turns that back on, but it is denied unless the
agent's grant pins `mcp.install`. When Guardian refuses, `GuardianDenied.hint`
says what to fix: register the tool, allow it for the agent, or check the plan
limit. The decision itself never changes.

Runnable: [`examples/invoice-agent.mjs`](../../examples/invoice-agent.mjs).
For Python, see [`odingard-guardian`](../python).

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
