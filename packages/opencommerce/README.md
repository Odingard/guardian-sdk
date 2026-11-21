<img src="https://raw.githubusercontent.com/Odingard/guardian-sdk/main/assets/guardian-mark.svg" alt="Guardian" width="48" height="48" />

# @odingard/guardian-opencommerce

**Guardian is the trust layer for agent commerce.** Human Authority Infrastructure for Autonomous AI: the agent proposes; the human decides.

Guardian for Agentcard's opencommerce buy tool (`buyTool` from
[`@agent-cards/commerce-sdk`](https://www.npmjs.com/package/@agent-cards/commerce-sdk)).
An agent that shops at real stores (Amazon, DoorDash, Shopify stores) with the
buy tool completes a purchase when Guardian allows it or a person approves it,
and each decision is a signed record.

`guardBuyTool(buy, options)` returns a tool of the same shape. Swap one line:

- **Search and browsing pass through.** A request that does not pay goes to Agentcard as it is, including a `nextStep` turn that only replays the shopper's search once their card is saved.
- **Every request that pays goes to Guardian before Agentcard.** The gate sits on the Agentcard client the tool was built with (pass it as `agentcard`): any request with a `confirm` or a Link payment, whichever method sent it (the model's yes, a wallet's `approve()`, a `nextStep` turn carrying an earlier yes, or a turn's `handled()` fast path), is proposed to Guardian as the money action `opencommerce.checkout`. A paying request made on that client outside the governed tool is refused (`UNGOVERNED_CALL`).
- **The carts it pays, as they stand.** The proposal is read from Agentcard's conversation at the moment of the request, for exactly the carts it pays: the one cart a confirm names by its hash, or every cart for a combined approval. A conversation that cannot be read is refused.
- **Redeem, then buy.** On ALLOW, or ASK and a person approved, the carts are read again and must be unchanged; after a person approved, the portable signed record must name that request, the tool, the connection and exactly the arguments about to be sent (and verify against `receiptVerificationKeys` when you pass them, from `fetchReceiptVerificationKeys`); then Guardian redeems the decision (so revocation, expiry and single use apply), and only then does the request reach Agentcard. **DENY, expiry, a timeout, Guardian unreachable, a failed redemption or any error** → nothing reaches Agentcard, and the model reads `Guardian blocked this purchase: …`.

- **Build the tool on the client you pass.** `buyTool({ accessToken })` builds its own internal client, which the gate cannot see, and the buy tool does not expose the client it was built with, so a mismatch cannot be caught when you wrap it. Build the tool with `buyTool({ agentcard })` and pass that same client. If a result still shows a confirm was sent (`confirm_sent`) with no paying request through Guardian in that call, or an order placed (`order_id`, `placing`, `order_placed`) when none ever went through Guardian for the tool, the call fails with `UNGOVERNED_CLIENT`. Agentcard may already have acted by then: this surfaces the misconfiguration loudly rather than preventing that one request.

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
  {
    client: guardian,
    connectionId: process.env.GUARDIAN_CONNECTION_ID!,
    agentcard, // the same client the buy tool was built with
  },
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

In your own code, `buy.answer(input)`, `approve()` and a turn's `handled()` reject with `GuardianPurchaseBlocked` (with `code`, `requestId`, `reasonCode`, `outcomeUnknown` and the `checkout` that was proposed) where the model paths (`run`, `execute`, `handle`) return the refusal as JSON text. A Stripe Link payment's `awaitWallet()` rejects the same way. `GuardianPurchaseBlocked` is an `AgentcardApiError` with status 403, so the buy tool reads it as a refusal that sent nothing: a Link payment is released and its cart stays payable, never held as an order that may have gone through. `onDecision` hears each decision.

### Waiting for a person

A checkout request stays open at Guardian for `requestTtlMs` (default and maximum 5 minutes, the gateway's limit), and an ASK waits for a person at most that long. Codes:

| `code`              | Meaning                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GUARDIAN_DENIED`   | The owner's rules do not allow it                                                                                         |
| `APPROVAL_DECLINED` | A person declined it                                                                                                      |
| `APPROVAL_EXPIRED`  | Guardian reports the request expired before anyone decided                                                                |
| `APPROVAL_TIMEOUT`  | No one decided within `requestTtlMs`; the request is withdrawn                                                            |
| `CART_CHANGED`      | The carts changed while the person decided                                                                                |
| `CART_UNREADABLE`   | The conversation, or the cart the request names, could not be read                                                        |
| `RECORD_MISMATCH`   | After a person approved, the signed record names another request, tool, connection or arguments, or does not verify       |
| `UNGOVERNED_CLIENT` | Agentcard reports a purchase that did not go through Guardian: the tool was built on another client                       |
| `EXECUTE_FAILED`    | Guardian did not redeem the decision (revoked, expired, used). With `outcomeUnknown`, look the request up before retrying |

A runnable version: [`examples/payments/opencommerce/batteries.mjs`](../../examples/payments/opencommerce/batteries.mjs).

## What the person approving sees

Each checkout is proposed with these arguments, which the approval screen and the signed record show:

| Field            | What it is                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `amountMinor`    | The most the card can be charged, in cents: per cart the highest of its total, its hold and its Link charge, summed over the carts the request pays (or a Link payment's amount, if higher) |
| `currency`       | `usd`                                                                                                                                                                                       |
| `stores`         | Each store, such as `Amazon`                                                                                                                                                                |
| `carts`          | Per cart: store, merchant, Agentcard's cart `hash`, total, the most it can charge, whether the total is an estimate, and every line (name, quantity, price, line total, variant)            |
| `confirms`       | `one_cart` (a confirm of one cart by its hash) or `every_cart` (one approval for every cart of the conversation)                                                                            |
| `conversationId` | Agentcard's conversation                                                                                                                                                                    |
| `step`           | `confirm`, `approve` or `next_step`                                                                                                                                                         |

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
- **Calls that bypass the gated client.** A confirm on the client passed as `agentcard` is refused outside the governed tool, a buy tool built on another `AgentcardClient` fails with `UNGOVERNED_CLIENT` only after the fact (see above), and the HTTP Purchase API or the Commerce MCP server is not governed. Give the agent the governed tool and nothing else that can confirm.
- **A shopper's own words.** Guardian governs the requests that carry a `confirm` or a Link payment. Words the buy tool sends as an `ask` are the shopper's message, and Agentcard reads them; keep Agentcard's own approval step (the approval link) on.
- **No conversation known.** A confirm when the wrapper has seen no conversation (for example after a process restart that loaded saved state) is refused; a call that shows the cart again lets the next confirm through Guardian.
- **Currencies other than US dollars** are refused, since Guardian's amount rules are in dollars.
- **What the store charges later.** Agentcard confirms the cart by its hash and refuses it if the cart changed; a store that charges a saved token later (as some Shopify checkouts do) can charge what its order says. The approved amount is the most the card can be held for, as Agentcard reports it.
- **What Agentcard does after the redemption.** Guardian redeems the decision before the request goes out. If Agentcard then fails or refuses the request, its error is returned as usual; the decision is spent, and a retry needs a new one.

Peer dependencies: `@agent-cards/commerce-sdk` `>=0.31.3 <0.32.0` (tested with 0.31.3) and `@odingard/guardian-sdk` `^0.6.0`.
