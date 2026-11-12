# @odingard/guardian-ap2

Guardian for [AP2](https://github.com/google-agentic-commerce/AP2), the Agent
Payments Protocol, **version 0.2**. Before your agent's key signs a closed
Checkout Mandate and a closed Payment Mandate, Guardian decides ALLOW, ASK or
DENY on the exact terms. The agent key signs only after an ALLOW or a
person's approval, only once, and only those terms.

**Decision-gated, not enforced outside your process.** Your agent's process
holds the agent key. The guard governs mandates signed through it. It cannot
stop code that signs with the key some other way. See
[Not governed](#not-governed).

**Not the Trusted Surface.** AP2 requires a non-agentic Trusted Surface where
the user approves and signs. A Guardian approval is your operator control,
not the user's AP2 consent, and never replaces the Trusted Surface step. The
guard never signs open mandates and never acts as the Trusted Surface.

**Proof status.** Tested with a fake Guardian, stand-in Trusted Surface,
merchant and processor keys made fresh for each test, and the AP2
specification's own example tokens. **Not yet proven live**, and not yet
checked against the AP2 Python SDK's verifier. AP2 has no public sandbox.

## What it covers

- AP2 **v0.2** only: `vct` exactly `mandate.checkout.1`,
  `mandate.checkout.open.1`, `mandate.payment.1`, `mandate.payment.open.1`.
  Other versions, and the v0.1 IntentMandate and CartMandate, are refused.
- **Human not present** (`pay`): the agent key signs the closed pair under
  open mandates your Trusted Surface signed. This is the guard's main job.
- **Human present** (`payHumanPresent`): Guardian decides before your
  Trusted Surface is asked; the guard presents only what the user signed
  there if it is exactly what was approved.
- **Delegation** (`delegate`): Guardian decides, always with a person,
  before your Trusted Surface is asked to sign open mandates for the agent
  key.
- **Receipts** (`recordReceipt`): Checkout and Payment Receipts, verified
  against keys you pin for each role (merchant for Checkout Receipts,
  processor for Payment Receipts), update the guard's ledger.
- Known constraint types only: `checkout.allowed_merchants`,
  `checkout.line_items`, `payment.amount_range`, `payment.budget`,
  `payment.agent_recurrence`, `payment.allowed_payees`,
  `payment.allowed_payment_instruments`, `payment.allowed_pisps`,
  `payment.execution_date`, `payment.reference`. Anything else is refused.
- Amounts are integer minor units. Display uses the guard's own ISO 4217
  exponents (USD 2, JPY 0, KWD 3, …), never a `$` sign. Tested in USD.

Everything the guard cannot read exactly is refused, not ignored.

## Setup

1. In the Guardian console, on a tool connection, install and enable four
   record-transport catalog entries for your agent: `ap2.pay`,
   `ap2.pay.above_cap`, `ap2.delegate` and `ap2.delegate.recurring`. Without
   them Guardian refuses (`TOOL_NOT_IN_CATALOG` or `TOOL_NOT_GRANTED`) and
   nothing is signed. The guard never installs them itself.
2. Allow `ap2.pay` with a rule only if repeat payments under an open mandate
   a person already approved may go through without a person.
   `ap2.pay.above_cap`, `ap2.delegate` and `ap2.delegate.recurring` always
   need a person: the guard refuses a rule ALLOW for them.

```bash
npm install @odingard/guardian-ap2 @odingard/guardian-sdk
```

```ts
import { createGuardianClient } from "@odingard/guardian-sdk";
import { createAp2Guard, nodeKeySigner } from "@odingard/guardian-ap2";

const guard = createAp2Guard({
  guardian: createGuardianClient({
    baseUrl: "https://guardian-api.odingard.com",
    credential: process.env.GUARDIAN_AGENT_CREDENTIAL!,
  }),
  connectionId: "pcn_…", // the connection holding the ap2.* entries
  agentSigner: nodeKeySigner(agentPrivateKey), // a P-256 KeyObject; it stays in your process
  trustedSurfaceKeys: [trustedSurfacePublicJwk],
  merchantKeys: { merchant_1: [merchantPublicJwk] },
  receiptIssuerKeys: {
    checkout: { "https://merchant.example": [merchantReceiptPublicJwk] }, // Checkout Receipts
    payment: { "https://processor.example": [processorPublicJwk] }, // Payment Receipts
  },
  limits: [{ currency: "USD", askAbove: 2500, max: 20000 }], // minor units: 25.00 and 200.00 USD
  store: myDurableStore, // needed for recurring mandates
});

const signed = await guard.pay({
  openCheckoutMandate, // from your Trusted Surface
  openPaymentMandate,
  checkoutJwt, // from the merchant
  paymentInstrument: { id: "pi_1", type: "card", description: "Card ending 4242" },
  merchantChallenge: { aud: "merchant_1", nonce: merchantNonce },
  credentialProviderChallenge: { aud: "credential-provider", nonce: cpNonce },
});

const token = await signed.presentPayment((chain) => credentialProvider.issueToken(chain));
await signed.presentCheckout((chain) => merchant.complete(chain, token));
await guard.recordReceipt(paymentReceiptJwt);
```

`agentSigner` can be any object with `publicJwk` and
`sign(bytes) => Promise<Uint8Array>` returning a raw ES256 (r‖s, 64 byte)
signature, for example one backed by a KMS or HSM.

## How a payment is decided (human not present)

1. **Read or refuse locally.** The guard verifies both open mandates under a
   pinned Trusted Surface key (a single SD-JWT each, no deeper chain),
   resolves their disclosures (decoy digests are ignored, unreferenced
   disclosures refused), checks the exact `vct`, known fields and
   constraints, that `cnf` is the agent key and that neither has expired. It
   verifies `checkout_jwt` under a pinned key of the merchant it names; with
   no pinned key it refuses.
2. **Build the closed pair from verified data.** The payee is the checkout's
   merchant, the amount is the checkout's single `total` in the checkout
   currency, and `transaction_id` = `checkout_hash` =
   base64url(SHA-256(`checkout_jwt`)). If you pass `payee`, `paymentAmount`
   or `transactionId`, each must equal what the guard derived. AP2 does not
   require these cross-checks; without them a 10 USD checkout could ride a
   500 USD payment mandate.
3. **Local checks.** The open mandates' own constraints and presets, checked
   by the guard; per-currency `max` (above it: refused, Guardian not asked)
   and `askAbove`; an optional payee allowlist; the ledger (below).
4. **Guardian.** `tool.invoke` on `ap2.pay` or `ap2.pay.above_cap` with the
   canonical terms (below) and `termsDigest` = SHA-256 of their JCS form
   (RFC 8785). On ASK the guard polls `claim` until a person decides or the
   request expires (default 120 s, at most 300 s). On ALLOW it calls
   `execute`, where Guardian checks single use, expiry and revocation, before
   any signature exists. For `ap2.pay.above_cap` it then reads the receipt
   and continues only if it shows a person approved this exact request.
5. **Inputs unchanged, still valid.** If anything you passed changed while
   a person decided, the guard refuses (`TERMS_CHANGED`). It checks again
   that neither open mandate's `exp` nor the checkout's `expires_at` has
   passed (`OPEN_MANDATE_EXPIRED`, `CHECKOUT_EXPIRED`); a decision that took
   minutes does not sign under an expired mandate.
6. **Sign once.** A single-use signing token (30 s by default,
   `signingWindowMs`, at most 120 s) allows one Checkout hop and one Payment
   hop. The guard builds each terminal KB-SD-JWT hop itself (`typ`
   `kb+sd-jwt`, ES256, `iat`, `aud`, `nonce`, `sd_hash` of the open mandate,
   one disclosed closed mandate) and checks the bytes field by field before
   the agent key signs. Any other signing call is refused. The signature is
   verified under the agent's public key.
7. **Present once.** `presentPayment` and `presentCheckout` each send their
   chain once. A pair already released by a verified Error receipt is not
   presented (`PAIR_RELEASED`).

ASK needs a person (`ap2.pay.above_cap`) when the amount is above
`askAbove`, the currency has no cap, or this is the first payment under an
open mandate that was not approved by a person through this guard's
`delegate()`. A pair from the same open mandate that is still outstanding
is not a reason to ask: it is a refusal (below).

An unreachable Guardian, a timeout, malformed answers, a failed `execute`,
an approval that never comes, a store error, or a refusal at any step means
nothing is signed and nothing is presented.

### What Guardian sees

```json
{
  "schema": "odingard.guardian.ap2.pay.v1",
  "ap2Version": "0.2",
  "mode": "human-not-present",
  "merchant": { "id": "merchant_1", "name": "Example Store", "website": "https://store.example" },
  "amount": 1999,
  "currency": "USD",
  "amountDisplay": "19.99 USD",
  "payment": {
    "vct": "mandate.payment.1",
    "transactionId": "…",
    "payee": { "id": "merchant_1", "name": "Example Store", "website": "https://store.example" },
    "paymentAmount": { "amount": 1999, "currency": "USD" },
    "amountDisplay": "19.99 USD",
    "paymentInstrument": { "id": "pi_1", "type": "card", "description": "Card ending 4242" },
    "pisp": null,
    "executionDate": "now",
    "riskDataKeys": [],
    "riskDataDigest": null
  },
  "checkout": {
    "vct": "mandate.checkout.1",
    "checkoutHash": "…",
    "id": "chk_1",
    "status": "ready_for_complete",
    "currency": "USD",
    "expiresAt": null,
    "lineItems": [{ "id": "li_1", "itemId": "sku_mug", "title": "Coffee mug", "unitPrice": 1999, "unitPriceDisplay": "19.99 USD", "quantity": 1, "totals": [] }],
    "totals": [{ "type": "subtotal", "amount": 1999, "display": "19.99 USD" }, { "type": "total", "amount": 1999, "display": "19.99 USD" }],
    "total": 1999,
    "totalDisplay": "19.99 USD",
    "messages": [],
    "links": [],
    "refundTerms": "Refund terms: not stated by the merchant",
    "buyerFields": [],
    "continueUrl": null,
    "otherFieldNames": []
  },
  "keyBinding": {
    "agentKeyThumbprint": "…",
    "checkout": { "aud": "merchant_1", "nonce": "…", "bindsToOpenMandate": "…" },
    "payment": { "aud": "credential-provider", "nonce": "…", "bindsToOpenMandate": "…" }
  },
  "openMandates": { "checkout": { "…": "every constraint, exp, cnf" }, "payment": { "…": "every constraint and preset" } },
  "termsDigest": "sha256:…",
  "reviewReasons": ["FIRST_USE_OF_OPEN_MANDATE"]
}
```

The person sees all of it, untruncated. The buyer is shown as field names
only, and risk data as its keys and a digest; their values are never sent to
Guardian or written to the guard's records. AP2 has no structured refund,
shipping or cancellation terms: the guard shows a merchant link whose type
names refunds or returns, or says the merchant did not state them. It shows
these; it cannot gate them.

### What a receipt means

A Guardian receipt says Guardian authorized and redeemed one decision on
these exact terms. It does not say a mandate was signed, presented or paid.
If signing fails after `execute`, the decision is spent and the guard
records "redeemed, not signed"; a retry needs a new decision. If `execute`
was sent but its outcome is unknown, nothing is signed, the refusal
(`EXECUTE_FAILED`) carries `outcomeUnknown: true` and the request id, and the
guard records "redeemed or unknown, not signed". The guard's records link the
Guardian request id to the closed mandate references
(base64url(SHA-256(closed mandate JWT)), the AP2 receipt `reference`) and
then to the Checkout and Payment Receipts (`order_id`, `payment_id`,
`psp_confirmation_id`). They never hold a key, a signature, a mandate, a
token, buyer details or risk data values.

## The ledger: single use, recurrence, budget, double spend

Kept per open Payment Mandate (its `sd_hash`), in your `store` (a durable
key-value store with an atomic compare-and-set) or in process memory if you
give none:

```ts
interface Ap2GuardStore {
  get(key: string): Promise<{ value: string; version: string } | null>;
  compareAndSet(key: string, expectedVersion: string | null, value: string): Promise<boolean>;
}
```

- **At most one outstanding pair per open mandate.** AP2 says an agent MUST
  NOT present a subsequent pair under an open mandate before a rejection
  receipt for the previous one. While a pair is signed or presented with no
  verified receipt that settles it, another pair from the same open mandate
  is refused (`OUTSTANDING_PRESENTATION`) before Guardian is asked; no
  approval overrides this. Two at once: the second is refused
  (`MANDATE_IN_USE`). A pair whose receipt never comes keeps the open
  mandate locked; ask the user for a new one. Human present works the same
  way per checkout.
- **Single use.** Without `payment.agent_recurrence`, an open mandate signs
  one pair. After a verified Success Payment Receipt it is used up
  (`MANDATE_ALREADY_USED`); before any receipt the outstanding-pair rule
  refuses a second.
- **Recurrence.** The guard enforces both `max_occurrences` and `frequency`
  (DAILY, WEEKLY = ISO week, MONTHLY, QUARTERLY, ANNUALLY = UTC calendar
  periods; BIWEEKLY = 14 days since the last payment; ON_DEMAND counts only).
  Recurring mandates need a `store`.
- **Budget.** AP2 does not define the unit of `payment.budget.max`. The guard
  reads it only as major units with at most two decimals, and only for a
  currency whose exponent is 2; anything else is refused
  (`BUDGET_UNIT_AMBIGUOUS`).
- **Receipts by role.** `receiptIssuerKeys.checkout` pins the merchant's
  receipt keys, `receiptIssuerKeys.payment` the processor's. A receipt is
  accepted only for the side its issuer is pinned for: a merchant key cannot
  sign a Payment Receipt, nor a processor key a Checkout Receipt.
- **Release.** The amount stays spent unless a verified Error Payment
  Receipt references the closed payment mandate, or a verified Error
  Checkout Receipt arrives before the payment mandate was ever presented. A
  checkout Error after the payment mandate went to the credential provider
  does not release the pair: the payment may still settle, so only the
  payment side can release it. A timeout or a missing receipt keeps it.
  `unresolved_constraint` is treated as an error; `recordReceipt` returns
  `returnToHumanPresent: true`, and any new pair needs a new decision.
- **Conflicting receipts.** A verified Success Payment Receipt for a pair
  that was released counts the pair again (money moved) and is flagged:
  `recordReceipt` returns `conflict: true` and the ledger entry is marked.
  An Error after a Success never releases. Look at flagged pairs by hand;
  the budget may already be exceeded by then.
- If the store cannot be read or written, the payment is refused.

These are local limits, not Guardian-enforced budgets.

## Delegation (open mandates)

`delegate()` checks the open mandate content you want your Trusted Surface
to sign, refusing before anyone is asked: no `payment.amount_range`;
recurrence without a budget; a lifetime longer than
`maxOpenMandateLifetimeSeconds` (default 7 days; AP2 recommends the shortest
`exp`); a currency with no local cap; a maximum above the local `max`; an
unknown constraint; a `cnf` that is not the agent key. It then asks Guardian
(`ap2.delegate`, or `ap2.delegate.recurring`), always with a person. After a
redeemed approval it calls your Trusted Surface once per mandate, sets
`cnf` to the agent key and `payment.reference` to the signed open checkout
mandate's hash, and checks that what came back is signed by a pinned
Trusted Surface key and is exactly what was approved.

## Human present

`payHumanPresent()` builds the closed pair the same way, asks Guardian, then
calls your Trusted Surface once with the closed mandate content. It presents
the returned mandates only if they verify under a pinned Trusted Surface key
and their content equals the approved content (an added `iat` or `exp` is
allowed). Guardian does not enforce anything else in this mode.

## Not governed

- Code that signs with the agent key directly, outside the guard.
- Mandate strings after the guard hands them to your `send` function: code
  that copies a chain can send it again. The guard presents each once and
  counts it in its ledger.
- Your Trusted Surface itself. AP2 requires it to be non-agentic and to
  authenticate the user; the guard cannot check that.
- Merchant and processor key discovery: AP2 does not specify it. You pin the
  keys; without a pinned key the guard refuses.
- Delegation chains deeper than Trusted Surface → agent, and intermediate
  (`kb+sd-jwt+kb`) hops.
- Console USD-cent caps, spending budgets and recipient rules: they do not
  apply to AP2 payments.

## Where this does not conform to AP2 v0.2

- **Selective disclosure.** AP2 says an agent MUST present only the
  disclosures from the open mandates that are needed to evaluate the closed
  mandates. The guard does not: it presents each open mandate with every
  disclosure the Trusted Surface issued (for example every entry of
  `payment.allowed_payees`, `payment.allowed_payment_instruments` and
  `checkout.allowed_merchants`) to both the merchant and the credential
  provider. Chains the guard presents do not conform to this requirement.
  Dropping disclosures changes the open mandate's `sd_hash`, which the KB
  hop and the open payment mandate's `payment.reference` bind to, and the
  AP2 reference implementation also discloses everything; the guard keeps
  its chains verifiable by that implementation instead. If this matters to
  you, have your Trusted Surface issue open mandates with only what the
  verifiers need.

## Limits of AP2 v0.2 to know

- AP2 is pre-standard and moving to a standards body; a breaking change is
  likely. The guard pins the `.1` `vct` values and refuses anything else.
- The delegation format (Delegate SD-JWT) is an individual draft. The guard's
  hop follows the AP2 reference implementation's form: a terminal
  `kb+sd-jwt` hop with `sd_hash` binding.
- There is no official TypeScript AP2 SDK; the guard implements the SD-JWT
  parts it needs (RFC 9901) with Node's built-in crypto.

## Refusal codes

Refusals throw `Ap2GuardRefused` with a `code`, for example
`UNSUPPORTED_VCT`, `UNKNOWN_CONSTRAINT`, `MERCHANT_KEY_NOT_PINNED`,
`CHECKOUT_SIGNATURE_INVALID`, `CHECKOUT_HASH_MISMATCH`,
`AMOUNT_TOTAL_MISMATCH`, `PAYEE_MERCHANT_MISMATCH`, `CONSTRAINT_VIOLATED`,
`CURRENCY_NOT_SUPPORTED`, `BUDGET_UNIT_AMBIGUOUS`, `RECURRENCE_EXCEEDED`,
`MANDATE_ALREADY_USED`, `OUTSTANDING_PRESENTATION`, `MANDATE_IN_USE`,
`OPEN_MANDATE_EXPIRED`, `CHECKOUT_EXPIRED`, `ABOVE_MAX`,
`PERSON_APPROVAL_REQUIRED`, `TERMS_CHANGED`, `SIGNING_INPUT_MISMATCH`,
`SIGNING_TOKEN_USED`, `ALREADY_PRESENTED`, `PAIR_RELEASED`, `RECEIPT_INVALID`. Guardian's own
reason follows the code, for example `GUARDIAN_DENIED:TOOL_NOT_GRANTED`.

## Example

[`examples/ap2/simulated-payments.mjs`](../../examples/ap2) (SIMULATED:
stand-in Guardian, Trusted Surface, merchant and processor, throwaway keys,
no network).

## License

Apache-2.0
