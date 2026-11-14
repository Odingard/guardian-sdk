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
login some other way, nor an agent that has a Link login of its own. Run
the guard where the agent cannot read that file, for example as another
user. See [Not governed](#not-governed).

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
  integer cents (minor units). Before Guardian is asked, the guard refuses
  anything above 50,000 minor units in any currency, and above the `max` you
  set for that currency (one limit per currency; a second is refused). Link's own limit is 50,000 US cents or the
  equivalent in the request's currency, so in CAD, EUR or GBP a request the
  guard lets through can still be above Link's limit; Link then refuses it.
- **The merchant is evidence, not a lock.** A Link card works at any merchant.
  Guardian decides on the merchant the agent names, and the approval shows
  it, but Link does not stop the card being used elsewhere. The terms
  Guardian sees say so: `payeeEnforcedByLink: false`. Line items are evidence
  too.

- **Items must add up.** With `items` the sum of quantity times unit amount:
  `items_base_amount`, if given, equals `items`; `subtotal`, if given, equals
  `items` less `items_discount`; `total` equals `items` less
  `items_discount`, `discount` and `store_credit`, plus `tax`, `fulfillment`,
  `shipping`, `fee`, `gift_wrap` and `tip`; and `total` equals `amount`.
  Anything else is refused (`TOTAL_MISMATCH`).

**What the guard compares.** Each time it reads the spend request from Link
(after creating or updating it, before Link's approval push, while waiting,
and with the card), it requires the merchant name and URL, context, amount,
currency, credential type `card`, every line item (name, quantity, unit
amount) and every total to be exactly the decided terms; a missing field
counts as different. A recurring schedule, metadata, a Shared Payment Token
or Link Pay Token, any other line item or total field, an expiry more than
7 days after creation (Link's one-time default), and any field the guard
does not know are refused. Not compared: Link's own state (status, ids,
times, approval and activity links, status details) and the person's own
payment method, which the person chooses in Link (`payment_method`,
`payment_details`, card brand and last 4). Anything else is canceled and
refused.

## DRAFT: How it works

1. `create(terms)` checks the terms, refuses if a Link approval policy
   exists, and proposes `tool.invoke` on `link.spend` (or
   `link.spend.above_cap`) with the full terms. On ASK it waits for a
   person; then it redeems the decision with `execute`. After a person
   approved, it reads the Guardian receipt and refuses unless the approval is
   for this request and these exact arguments.
2. Only then does it create the spend request, once, with `--test`, an
   idempotency key from the Guardian request, and without Link's approval
   push. It checks Link's approval policy again first. It reads back what
   Link created; anything different, or a status other than `created`, is
   canceled and refused.
3. `requestApproval(id)` checks the request again and asks Link to send the
   person the approval push. `spend(terms)` does steps 1 to 3.
4. `waitForLinkApproval(id)` waits for the person to approve in Link.
5. `withCard(id, use)` checks the request again, reads the card once through
   `--output-file` into a private folder, and hands it to `use`. The folder
   is wiped and deleted when the call ends; folders a crash left behind are
   wiped the next time the adapter is built. The card object prints as
   `[guardian-link card: redacted]`, and the card object cannot be read
   after `use` returns (values `use` copied out are yours to protect). A
   second call is refused.
6. `update(id, terms)` changes a request before Link's approval is requested.
   It is a new decision on the full new terms and always needs a person.
   Like `create`, it checks Link's approval policy again after the decision
   and refuses unless Link returns the new terms with status `created`. The
   merchant name and context cannot be changed (Link cannot change them).
7. `cancel(id)` marks the request canceled in the guard's ledger first, then
   asks Link to cancel it; the guard does nothing more with it either way.

One Guardian decision acts once. A decision seen before is refused
(`DECISION_ALREADY_USED`), also after a restart when you give the guard a
durable `store`. Only the guard may be able to write to that store: whoever
can write it can mark a used decision unused. The guard checks every stored
entry when it reads it and refuses one it cannot read exactly
(`STORE_UNAVAILABLE`).

**DRAFT: Replay protection and retention.** The guard keeps all its
decisions in one stored document, so it drops old ones on each write:
finished decisions (card read, canceled, refused, superseded, outcome
unknown) made more than `ledgerRetentionMs` ago (default 30 days, 1 to 365
days). Decisions still in progress are kept while Link could still
approve their spend request, and dropped once they are older than 7 days
and 1 hour (Link's expiry for a one-time spend request, plus slack). Until
then, a full ledger refuses new spends (`LEDGER_FULL`). This keeps replay
protection because a decision acts only after Guardian's `execute`
redeemed it, before the guard writes anything or calls Link. `execute` is
single-use and a Guardian request expires within 5 minutes, so a dropped
decision handed out again is refused by Guardian itself before Link is
called. A dropped decision's spend request is unknown to the guard from
then on, so the guard refuses to act on it or read its card. The store
holds at most `ledgerMaxEntries` decisions (default 1,000, 10 to 100,000;
an entry is typically about 1 KB, at most about 30 KB). When it is full
after dropping old ones, a new spend is refused (`LEDGER_FULL`) before
Guardian is asked, and open spend requests can still be completed or
canceled.

## DRAFT: Setup

1. In the Guardian console, on a tool connection, install and enable two
   record-transport catalog entries: `link.spend` and `link.spend.above_cap`.
   `link.spend.above_cap` always needs a person: the guard refuses a rule
   ALLOW for it.
2. Install `@stripe/link-cli` where only the guard's user can change it, and
   give the adapter the CLI by absolute path, for example
   `["/usr/bin/node", "/opt/guard/node_modules/@stripe/link-cli/dist/cli.js"]`.
   The adapter refuses a bare name looked up in PATH, npx, npm, pnpm, yarn
   and bun, and a relative script path. Every entry that is not a flag (the
   program and the script) must be an existing regular file owned by the
   guard's user or root that others cannot write to, in a folder owned by
   the guard's user or root that others cannot write to (also where a link
   resolves), checked again before every command. `timeoutMs` is 1 ms to
   10 minutes. It
   runs each command from a new private folder of its own, never from the
   guard's working folder, with a minimal environment: only `PATH`, `HOME`,
   the locale variables, `TZ` and `TMPDIR` are passed. `NODE_OPTIONS`,
   `NODE_PATH`, the other `NODE_*` settings, proxy variables and `LINK_*`
   settings are not, so a proxy cannot be used to reach Link.
3. Log in to Link for the guard only, into a file only the guard can read:
   `link-cli auth login --client-name "Guardian guard" --auth /path/guard-link-auth.json`,
   then `chmod 600` the file. The adapter refuses, before every command, a
   path that does not end in `.json`, a link, a file with more than one hard
   link, a file anyone else can read or that belongs to another user, and a
   folder that belongs to another user or that others can write to.
4. Make sure no Link approval policy exists:
   `link-cli approval-policy retrieve --format json` must fail with
   "No approval policy has been configured". Only that answer counts as no
   policy; while one exists, or Link answers anything else, the guard
   refuses to act.

```ts
import { createGuardianClient } from "@odingard/guardian-sdk";
import { createLinkGuard, linkCliAdapter } from "@odingard/guardian-link";

const guard = createLinkGuard({
  guardian: createGuardianClient({ baseUrl, credential }),
  connectionId: "pcn_…",
  link: linkCliAdapter({
    authPath: "/path/guard-link-auth.json",
    command: ["/usr/bin/node", "/opt/guard/node_modules/@stripe/link-cli/dist/cli.js"],
  }),
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
- An agent with its own, separate Link login: it can make spend requests the
  guard never sees.
- What happens with the card after `withCard`: the merchant, the amount
  charged and the items are Link's and the card network's to enforce.
- Live mode, Shared Payment Tokens, Link Pay Tokens and recurring requests.

## DRAFT: Not verified

- No run against Link yet. The JSON the CLI prints, the fields of a spend
  request and the "no approval policy" answer are read from the Link CLI
  source (stripe/link-cli 308a15a).
- If Link normalises what it stores, for example adding a trailing `/` to
  the merchant URL, changing the case of the host, trimming item names or
  filling in item fields, the exact comparison refuses every such request.
  That fails closed, but would make the guard unusable until the comparison
  is adjusted to what Link really returns. The same holds for a field Link
  returns that the guard does not know.
- Whether Link replaces or appends line items on update. The read-back
  refuses either way.
- Whether a `--test` request still sends the person an approval push.
