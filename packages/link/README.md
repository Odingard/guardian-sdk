# @odingard/guardian-link

> **DRAFT. Not released. The wording must be approved before any release.** Every
> sentence in this file is draft wording. Nothing here is published to npm.
> The package is marked `"private": true` until the wording is approved.

**DRAFT:** Guardian for the [Stripe Link](https://github.com/stripe/link-cli)
agent wallet, **in Link test mode only**. Before a Link spend request is
created or changed, Guardian decides ALLOW, ASK or DENY on its exact terms:
merchant name and URL, amount, currency, line items and totals. The guard
creates the spend request only after an ALLOW or a person's approval, once,
on those terms, and reads the card once, for that approved request only.

**DRAFT: Decision-gated, not enforced outside your process.** The guard
holds the Link login (the CLI's `--auth` file). It governs spend requests
made through it. It cannot stop code that runs `link-cli` with the same
login some other way. Run the guard where the agent cannot read that file,
for example as another user. See [Not governed](#not-governed).

**DRAFT: Proof status.** Tested with a fake Guardian, a fake Link and a fake
`link-cli`. **Not yet run against a real Link account**, even in test mode.
The exact JSON the CLI prints and the error Link returns when no approval
policy exists are taken from the Link CLI source (stripe/link-cli 308a15a),
not from a real run.

## DRAFT: What it covers

- **Test mode only.** Every spend request is created with `--test`. Link
  returns test card numbers and does not charge the payment method. There is
  no live mode in this package.
- **Card credentials only** (`--credential-type card`). Shared Payment Tokens
  and Link Pay Tokens are not covered.
- **One-time purchases only.** Recurring spend requests are not covered.
- **Currencies:** USD by default. CAD, EUR and GBP can be enabled. Amounts are
  integer cents. Link's own limit, 50,000 cents, is enforced before Guardian
  is asked.
- **The merchant is evidence, not a lock.** A Link card works at any merchant.
  Guardian decides on the merchant the agent names, and the approval shows
  it, but Link does not stop the card being used elsewhere. The terms
  Guardian sees say so: `payeeEnforcedByLink: false`. Line items are evidence
  too.

Anything the guard cannot read exactly is refused, not ignored.

## DRAFT: How it works

1. `create(terms)` checks the terms, refuses if a Link approval policy
   exists, and proposes `tool.invoke` on `link.spend` (or
   `link.spend.above_cap`) with the full terms. On ASK it waits for a
   person; then it redeems the decision with `execute`. After a person
   approved, it reads the Guardian receipt and refuses unless the approval is
   for this request and these exact arguments.
2. Only then does it create the spend request, once, with `--test`, an
   idempotency key from the Guardian request, and without Link's approval
   push. It reads back what Link created; anything different is canceled and
   refused.
3. `requestApproval(id)` checks the request again and asks Link to send the
   person the approval push. `spend(terms)` does steps 1 to 3.
4. `waitForLinkApproval(id)` waits for the person to approve in Link.
5. `withCard(id, use)` checks the request again, reads the card once through
   `--output-file` into a private folder it deletes, and hands it to `use`.
   The card prints as `[guardian-link card: redacted]` and cannot be read
   after `use` returns. A second call is refused.
6. `update(id, terms)` changes a request before Link's approval is requested.
   It is a new decision on the full new terms and always needs a person. The
   merchant name and context cannot be changed (Link cannot change them).

One Guardian decision acts once. A decision seen before is refused
(`DECISION_ALREADY_USED`), also after a restart when you give the guard a
durable `store`.

## DRAFT: Setup

1. In the Guardian console, on a tool connection, install and enable two
   record-transport catalog entries: `link.spend` and `link.spend.above_cap`.
   `link.spend.above_cap` always needs a person: the guard refuses a rule
   ALLOW for it.
2. Log in to Link for the guard only, into a file only the guard can read:
   `link-cli auth login --client-name "Guardian guard" --auth /path/guard-link-auth.json`,
   then `chmod 600` the file. The adapter refuses a file anyone else can read.
3. Make sure no Link approval policy exists
   (`link-cli approval-policy retrieve --format json` must fail). While one
   exists, the guard refuses to act.

```ts
import { createGuardianClient } from "@odingard/guardian-sdk";
import { createLinkGuard, linkCliAdapter } from "@odingard/guardian-link";

const guard = createLinkGuard({
  guardian: createGuardianClient({ baseUrl, credential }),
  connectionId: "pcn_…",
  link: linkCliAdapter({ authPath: "/path/guard-link-auth.json" }),
  limits: [{ currency: "usd", askAbove: 2_000, max: 20_000 }],
  store, // a compare-and-set store, so used decisions survive a restart
});

const { spendRequestId } = await guard.spend({
  merchantName: "Stripe Press",
  merchantUrl: "https://press.stripe.com",
  amount: 3500,
  currency: "usd",
  lineItems: [{ name: "Working in Public", quantity: 1, unitAmount: 3500 }],
  totals: [{ type: "total", displayText: "Total", amount: 3500 }],
  context: "…at least 100 characters: what is bought and why…",
});
await guard.waitForLinkApproval(spendRequestId);
await guard.withCard(spendRequestId, async (card) => {
  // fill the merchant's checkout form with card.number, card.cvc, …
});
```

## DRAFT: Console dollar limits

Console limits ("allow up to $X, ask above") apply only when the owner
declares the amount on both tools in the console as
`{"argument":"amount","unit":"minor","currency":"usd","currencyArgument":"currency"}`
(`LINK_AMOUNT_DECLARATION`) and the guard is built with the same
`amountArgument`. That needs an `@odingard/guardian-sdk` release whose
tool.invoke carries amount declarations; with an older SDK the guard
refuses to be built with `amountArgument`. Console merchant limits do not
apply to these tools.

## DRAFT: Not governed

- Code that runs `link-cli`, the Link SDK or the Link API with the guard's
  login, outside the guard.
- What happens with the card after `withCard`: the merchant, the amount
  charged and the items are Link's and the card network's to enforce.
- Live mode, Shared Payment Tokens, Link Pay Tokens and recurring requests.
