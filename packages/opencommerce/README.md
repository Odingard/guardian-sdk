<img src="https://raw.githubusercontent.com/Odingard/guardian-sdk/main/assets/guardian-mark.svg" alt="Guardian" width="48" height="48" />

# @odingard/guardian-opencommerce

**Guardian is the trust layer for agent commerce.** Human Authority Infrastructure for Autonomous AI: the agent proposes; the human decides.

Guardian for Agentcard's opencommerce buy tool (`buyTool` from
[`@agent-cards/commerce-sdk`](https://www.npmjs.com/package/@agent-cards/commerce-sdk)).
An agent that shops at real stores (Amazon, DoorDash, Shopify stores) with the
buy tool completes a purchase when Guardian allows it or a person approves it,
and each decision is a signed record.

`guardBuyTool(buy, options)` returns a tool of the same shape. Swap one line:

- **Search and browsing pass through.** A call with `confirm: false` goes to Agentcard as it is.
- **The checkout goes to Guardian before Agentcard.** A call with `confirm: true` (the shopper's yes), a wallet's `approve()`, and every call of a turn `nextStep` opens (which can carry an earlier yes) are proposed to Guardian as the money action `opencommerce.checkout` before anything reaches Agentcard.
- **ALLOW** → the call goes to Agentcard, and Guardian keeps the signed record. **ASK** → the call waits for the person, then goes ahead if they approved. **DENY, a timeout, Guardian unreachable or any error** → nothing reaches Agentcard, and the model reads `Guardian blocked this purchase: …`.
- **Bound to the exact cart.** If the cart, its amount or its store changes, the next confirm is a new request. A cart that changes while the person decides is refused.

Agentcard's own steps stay as they are: `sendLink` still hands the shopper the Vault and approval links, and the shopper's approval at Agentcard still applies after Guardian's decision.

## Install

```sh
npm i @odingard/guardian-opencommerce @odingard/guardian-sdk @agent-cards/commerce-sdk
```

Unreleased: not on npm yet. Build it from this repository (`packages/opencommerce`).

## Example (Anthropic tool runner)

```ts
import Anthropic from "@anthropic-ai/sdk";
import {
  AgentcardClient,
  appInstructions,
  buyTool,
} from "@agent-cards/commerce-sdk";
import { createGuardianClient } from "@odingard/guardian-sdk";
import { guardBuyTool } from "@odingard/guardian-opencommerce";

const agentcard = new AgentcardClient({
  clientId: process.env.AGENTCARD_CLIENT_ID!,
  clientSecret: process.env.AGENTCARD_CLIENT_SECRET!,
});
const guardian = createGuardianClient({
  baseUrl: process.env.GUARDIAN_BASE_URL!,
  credential: process.env.GUARDIAN_AGENT_CREDENTIAL!,
});
const buy = guardBuyTool(
  buyTool({
    agentcard,
    externalUserId: "shopper-1",
    sendLink: (l) => deliver(l),
  }),
  { client: guardian, connectionId: process.env.GUARDIAN_CONNECTION_ID! },
);

const final = await new Anthropic().beta.messages.toolRunner({
  model: "claude-opus-5-5",
  max_tokens: 16000,
  system: appInstructions({ markdown: false }),
  tools: [buy],
  messages: [
    { role: "user", content: "two packs of AA batteries from Amazon" },
  ],
});
```

In your own code, `buy.answer(input)` throws `GuardianPurchaseBlocked` (with `code`, `requestId`, `reasonCode` and the `checkout` that was proposed) where the model paths (`run`, `execute`, `handle`) return the refusal as JSON text. `onDecision` hears each decision.

A runnable version: [`examples/payments/opencommerce/batteries.mjs`](../../examples/payments/opencommerce/batteries.mjs).

## What the person approving sees

Each checkout is proposed with these arguments, which the approval screen and the signed record show:

| Field            | What it is                                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `amountMinor`    | The most the card can be charged, in cents: per cart the highest of its total, its hold and its Link charge, summed over the carts on the table                                  |
| `currency`       | `usd`                                                                                                                                                                            |
| `stores`         | Each store, such as `Amazon`                                                                                                                                                     |
| `carts`          | Per cart: store, merchant, Agentcard's cart `hash`, total, the most it can charge, whether the total is an estimate, and every line (name, quantity, price, line total, variant) |
| `conversationId` | Agentcard's conversation                                                                                                                                                         |
| `step`           | `confirm`, `approve` or `next_step`                                                                                                                                              |

The purpose line reads like `Buy 2 × Energizer AA batteries, 8 pack at Amazon for up to $11.12 (opencommerce)`. No card data and no Agentcard secret is sent to Guardian or logged.

## Set the rules in the Guardian console

1. On a tool connection, register the record tool (transport `record`) `opencommerce.checkout` (or the name you pass as `toolName`).
2. Under **Connections → Dollar amounts**, set its amount declaration to exactly `{ "argument": "amountMinor", "unit": "minor", "currency": "usd" }` (exported as `CHECKOUT_AMOUNT_DECLARATION`). Guardian refuses a call whose declaration differs.
3. Set the rules, for example: purchases under $25 run, above $25 ask, above $200 off. A rule on the `stores` argument can turn certain stores off or make them always ask.
4. Grant the tool to the agent whose credential (`gak_…`) the app uses.

## Test in the Agentcard sandbox

The sandbox searches real stores and builds real carts at their prices, and stops at payment: no order is placed and nothing is charged.

```sh
npx agent-cards credentials --mode sandbox   # prints a sandbox client id and secret
cd examples
AGENTCARD_CLIENT_ID=… AGENTCARD_CLIENT_SECRET=… \
GUARDIAN_AGENT_CREDENTIAL=gak_… GUARDIAN_CONNECTION_ID=pcn_… GUARDIAN_BASE_URL=https://… \
node payments/opencommerce/batteries.mjs
```

An allowed checkout ends `declined` with `decline_code: sandbox_mode`; that means the run worked. The example refuses production Agentcard credentials unless `ALLOW_LIVE_PURCHASE=1` is set. A store that prices tax at the confirm answers with a new total and hash, so Guardian decides that cart again.

## What is not governed

- **Steps outside the agent.** Guardian decides what the agent sends. A shopper who opens an Agentcard link (the Vault or an approval page) and pays there, or who buys at Agentcard in another app, is not seen by this package.
- **Auto-approval at Agentcard.** A shopper's auto-approval rule or your app's auto-approval permission can pay a confirm without an approval link. Guardian still decides the confirm before it reaches Agentcard, so such a purchase goes ahead after Guardian allows it and not before; keep Guardian's limits at or below those rules.
- **Cards added out of band.** Which card pays is the shopper's choice in the Vault or Link. Guardian decides the purchase, not the card.
- **Calls that bypass the wrapped tool.** `AgentcardClient` used directly (`buy(...)`, the HTTP Purchase API, the Commerce MCP server) is not governed. Give the agent the governed tool and nothing else that can confirm.
- **A cart Guardian has not seen.** The wrapper decides on the carts it saw in Agentcard's last answer. A confirm with none (for example after a process restart that loaded saved state) is refused; a call that shows the cart again lets the next confirm through Guardian.
- **Currencies other than US dollars** are refused, since Guardian's amount rules are in dollars.
- **What the store charges later.** Agentcard confirms the cart by its hash and refuses it if the cart changed; a store that charges a saved token later (as some Shopify checkouts do) can charge what its order says. The approved amount is the most the card can be held for, as Agentcard reports it.
- **The signed record after the purchase.** If the purchase reached Agentcard but Guardian's record of it failed, the result is returned and `onRecordError` is called; the purchase is not undone.

Peer dependencies: `@agent-cards/commerce-sdk` `>=0.31.3 <0.32.0` (tested with 0.31.3) and `@odingard/guardian-sdk` `^0.6.0`.
