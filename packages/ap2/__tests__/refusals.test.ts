import { describe, expect, it } from "vitest";

import { formatMinor } from "../src/index.js";
import {
  checkoutJwt,
  checkoutPayload,
  fakeGuardian,
  issueSdJwt,
  makeGuard,
  MERCHANT,
  MERCHANT_2,
  NOW_MS,
  NOW_SEC,
  openMandates,
  payInput,
  sdHashOf,
  signJws,
  world,
  type World,
} from "./helpers.js";

type Input = ReturnType<typeof payInput>;

/** Refused before Guardian is asked; nothing signed. */
async function refusedLocally(
  w: World,
  input: Input | Record<string, unknown>,
  code: string,
  config: Partial<Parameters<typeof makeGuard>[1]> = {},
) {
  const guardian = fakeGuardian({ decide: () => "ASK" });
  const { guard } = makeGuard(w, { guardian, ...config });
  await expect(guard.pay(input as Input)).rejects.toMatchObject({ code });
  expect(guardian.requests).toHaveLength(0);
  expect(w.signed).toHaveLength(0);
  expect(guard.records().at(-1)).toMatchObject({ event: "refused", code });
}

const ref = (open: string) => ({ type: "payment.reference", conditional_transaction_id: sdHashOf(open) });

describe("the closed pair must agree with the checkout", () => {
  it("payment amount not the checkout total, or another currency", async () => {
    const w = world();
    await refusedLocally(w, payInput(w, { extra: { paymentAmount: { amount: 50000, currency: "USD" } } }), "AMOUNT_TOTAL_MISMATCH");
    await refusedLocally(w, payInput(w, { extra: { paymentAmount: { amount: 1999, currency: "EUR" } } }), "AMOUNT_TOTAL_MISMATCH");
  });
  it("payee not the checkout merchant", async () => {
    const w = world();
    await refusedLocally(w, payInput(w, { extra: { payee: MERCHANT_2 } }), "PAYEE_MERCHANT_MISMATCH");
  });
  it("transaction_id not the hash of checkout_jwt", async () => {
    const w = world();
    await refusedLocally(w, payInput(w, { extra: { transactionId: "a".repeat(43) } }), "CHECKOUT_HASH_MISMATCH");
  });
});

describe("the merchant's checkout must verify", () => {
  it("no pinned key for the merchant", async () => {
    const w = world();
    const input = payInput(w, { checkout: { merchant: { id: "merchant_9", name: "Unknown" } } });
    await refusedLocally(w, input, "MERCHANT_KEY_NOT_PINNED");
  });
  it("signed by another key", async () => {
    const w = world();
    const input = { ...payInput(w), checkoutJwt: checkoutJwt(w, {}, w.merchant2.privateKey) };
    await refusedLocally(w, input, "CHECKOUT_SIGNATURE_INVALID");
  });
  it("no merchant in the checkout", async () => {
    const w = world();
    await refusedLocally(w, payInput(w, { checkout: { merchant: undefined } }), "MERCHANT_MISSING");
  });
  it("expired checkout, or one not ready to complete", async () => {
    const w = world();
    await refusedLocally(w, payInput(w, { checkout: { extra: { expires_at: new Date(NOW_MS - 1000).toISOString() } } }), "CHECKOUT_EXPIRED");
    await refusedLocally(w, payInput(w, { checkout: { status: "completed" } }), "CHECKOUT_NOT_PAYABLE");
  });
  it("two totals, or none", async () => {
    const w = world();
    const p = checkoutPayload();
    const two = signJws(w.merchant.privateKey, { alg: "ES256" }, { ...p, totals: [...p.totals, { type: "total", amount: 1 }] });
    await refusedLocally(w, { ...payInput(w), checkoutJwt: two }, "MALFORMED_CHECKOUT");
    const none = signJws(w.merchant.privateKey, { alg: "ES256" }, { ...p, totals: [{ type: "subtotal", amount: 1999 }] });
    await refusedLocally(w, { ...payInput(w), checkoutJwt: none }, "MALFORMED_CHECKOUT");
  });
  it("amounts that are floats, strings, negative or above 2^53", async () => {
    const w = world();
    const p = checkoutPayload();
    for (const price of [19.99, "1999", -1, 2 ** 53 + 2]) {
      const li = [{ ...p.line_items[0]!, item: { ...p.line_items[0]!.item, price } }];
      const jwt = signJws(w.merchant.privateKey, { alg: "ES256" }, { ...p, line_items: li });
      await refusedLocally(w, { ...payInput(w), checkoutJwt: jwt }, "INVALID_AMOUNT");
    }
    const jwt = signJws(w.merchant.privateKey, { alg: "ES256" }, { ...p, totals: [{ type: "total", amount: 19.99 }] });
    await refusedLocally(w, { ...payInput(w), checkoutJwt: jwt }, "INVALID_AMOUNT");
  });
  it("a currency the guard does not know", async () => {
    const w = world();
    await refusedLocally(w, payInput(w, { checkout: { currency: "XYZ" } }), "CURRENCY_NOT_SUPPORTED");
  });
});

describe("open mandates: v0.2 only, known constraints only, signed by the Trusted Surface, for this agent key", () => {
  it("a vct with another version suffix", async () => {
    const w = world();
    const input = payInput(w, {
      open: {
        checkoutItem: { vct: "mandate.checkout.open.2", constraints: [], cnf: { jwk: w.agent.publicJwk }, exp: NOW_SEC + 60 },
      },
    });
    await refusedLocally(w, input, "UNSUPPORTED_VCT");
  });
  it("an AP2 v0.1 IntentMandate or CartMandate shape", async () => {
    const w = world();
    const intent = issueSdJwt(w.ts.privateKey, { natural_language_description: "buy a mug", intent_expiry: "2026-12-01" });
    await refusedLocally(w, { ...payInput(w), openCheckoutMandate: intent }, "UNSUPPORTED_VCT");
    const cart = issueSdJwt(w.ts.privateKey, { contents: { id: "cart_1" }, merchant_authorization: "x" });
    await refusedLocally(w, { ...payInput(w), openPaymentMandate: cart }, "UNSUPPORTED_VCT");
  });
  it("an unknown constraint type", async () => {
    const w = world();
    const input = payInput(w, {
      open: {
        paymentConstraints: (o) => [
          { type: "payment.amount_range", currency: "USD", max: 5000 },
          ref(o),
          { type: "payment.velocity", per_hour: 3 },
        ],
      },
    });
    await refusedLocally(w, input, "UNKNOWN_CONSTRAINT");
  });
  it("an unknown field in a constraint or a mandate", async () => {
    const w = world();
    const input = payInput(w, {
      open: { paymentConstraints: (o) => [{ type: "payment.amount_range", currency: "USD", max: 5000, soft: true }, ref(o)] },
    });
    await refusedLocally(w, input, "UNKNOWN_FIELD");
    await refusedLocally(w, payInput(w, { open: { payment: { note: "hi" } } }), "UNKNOWN_FIELD");
  });
  it("not signed by a pinned Trusted Surface key", async () => {
    const w = world();
    const { openPayment } = openMandates(w);
    const forged = issueSdJwt(w.merchant.privateKey, { vct: "mandate.payment.open.1" });
    await refusedLocally(w, { ...payInput(w), openPaymentMandate: forged }, "MANDATE_SIGNATURE_INVALID");
    void openPayment;
  });
  it("a delegation chain, or a key-binding hop, in place of a Trusted Surface mandate", async () => {
    const w = world();
    const input = payInput(w);
    await refusedLocally(w, { ...input, openPaymentMandate: `${input.openPaymentMandate.slice(0, -1)}~~${input.openPaymentMandate}` }, "UNSUPPORTED_CHAIN");
    const hop = issueSdJwt(w.ts.privateKey, { vct: "mandate.payment.open.1" }, { header: { typ: "kb+sd-jwt+kb" } });
    await refusedLocally(w, { ...input, openPaymentMandate: hop }, "UNSUPPORTED_CHAIN");
  });
  it("cnf names another key", async () => {
    const w = world();
    await refusedLocally(w, payInput(w, { open: { cnf: { jwk: w.mpp.publicJwk } } }), "CNF_NOT_AGENT_KEY");
  });
  it("an expired open mandate, or one with no exp", async () => {
    const w = world();
    await refusedLocally(w, payInput(w, { open: { exp: NOW_SEC - 1 } }), "OPEN_MANDATE_EXPIRED");
    await refusedLocally(
      w,
      payInput(w, {
        open: {
          checkoutItem: {
            vct: "mandate.checkout.open.1",
            constraints: [{ type: "checkout.line_items", items: [{ id: "r", acceptable_items: [], quantity: 1 }] }],
            cnf: { jwk: w.agent.publicJwk },
          },
        },
      }),
      "MISSING_FIELD",
    );
  });
  it("a disclosure the payload does not reference", async () => {
    const w = world();
    const input = payInput(w);
    const extra = Buffer.from(JSON.stringify(["c2FsdHNhbHRzYWx0c2FsdA", "hidden"])).toString("base64url");
    await refusedLocally(w, { ...input, openPaymentMandate: `${input.openPaymentMandate}${extra}~` }, "MALFORMED_MANDATE");
  });
  it("decoy digests are ignored (RFC 9901 §4.2.5)", async () => {
    const w = world();
    const guardian = fakeGuardian({ decide: () => "ASK" });
    const { guard } = makeGuard(w, { guardian });
    const input = payInput(w, { open: { decoys: 3 } });
    const payload = JSON.parse(Buffer.from(input.openPaymentMandate.split(".")[1]!, "base64url").toString());
    expect(payload.delegate_payload).toHaveLength(4);
    const p = await guard.pay(input);
    expect(p.terms.amount).toBe(1999);
  });
});

describe("the open mandates' own constraints, checked by the guard", () => {
  it("merchant not allowed by the open checkout mandate", async () => {
    const w = world();
    const input = payInput(w, {
      open: {
        checkoutConstraints: [
          { type: "checkout.allowed_merchants", allowed: [MERCHANT_2] },
          { type: "checkout.line_items", items: [{ id: "r", acceptable_items: [], quantity: 5 }] },
        ],
      },
    });
    await refusedLocally(w, input, "CONSTRAINT_VIOLATED");
  });
  it("more items than allowed, or an item not acceptable", async () => {
    const w = world();
    await refusedLocally(w, payInput(w, { checkout: { items: [{ id: "sku_mug", title: "Coffee mug", price: 100, quantity: 3 }] } }), "CONSTRAINT_VIOLATED");
    await refusedLocally(w, payInput(w, { checkout: { items: [{ id: "sku_tv", title: "TV", price: 100, quantity: 1 }] } }), "CONSTRAINT_VIOLATED");
  });
  it("amount above the open mandate's amount_range, or in another currency", async () => {
    const w = world();
    await refusedLocally(w, payInput(w, { checkout: { items: [{ id: "sku_mug", title: "Coffee mug", price: 2600, quantity: 2 }] } }), "CONSTRAINT_VIOLATED");
    const eur = payInput(w, { checkout: { currency: "EUR" } });
    await refusedLocally(w, eur, "CONSTRAINT_VIOLATED", { limits: [{ currency: "USD", askAbove: 1, max: 9999 }, { currency: "EUR", askAbove: 1, max: 9999 }] });
  });
  it("a payment instrument the open mandate does not allow", async () => {
    const w = world();
    const input = payInput(w, {
      open: {
        paymentConstraints: (o) => [
          { type: "payment.amount_range", currency: "USD", max: 5000 },
          { type: "payment.allowed_payment_instruments", allowed: [{ id: "pi_other", type: "card" }] },
          ref(o),
        ],
      },
    });
    await refusedLocally(w, input, "CONSTRAINT_VIOLATED");
  });
  it("payment.reference names another open checkout mandate", async () => {
    const w = world();
    const input = payInput(w, {
      open: { paymentConstraints: () => [{ type: "payment.amount_range", currency: "USD", max: 5000 }, { type: "payment.reference", conditional_transaction_id: "b".repeat(43) }] },
    });
    await refusedLocally(w, input, "PAYMENT_REFERENCE_MISMATCH");
  });
  it("no amount_range, or no payment.reference", async () => {
    const w = world();
    await refusedLocally(w, payInput(w, { open: { paymentConstraints: (o) => [ref(o)] } }), "MISSING_FIELD");
    await refusedLocally(w, payInput(w, { open: { paymentConstraints: () => [{ type: "payment.amount_range", currency: "USD", max: 5000 }] } }), "MISSING_FIELD");
  });
  it("a preset payee, amount or instrument that the closed mandate would change", async () => {
    const w = world();
    await refusedLocally(w, payInput(w, { open: { payment: { payee: MERCHANT_2 } } }), "PRESET_MISMATCH");
    await refusedLocally(w, payInput(w, { open: { payment: { payment_amount: { amount: 1000, currency: "USD" } } } }), "PRESET_MISMATCH");
    await refusedLocally(w, payInput(w, { open: { payment: { payment_instrument: { id: "pi_x", type: "card" } } } }), "PRESET_MISMATCH");
  });
  it("budget in a currency whose exponent is not 2, or not exact cents", async () => {
    const w = world();
    for (const [currency, max] of [["JPY", 5000], ["KWD", 5], ["USD", 10.005]] as const) {
      const input = payInput(w, {
        open: {
          paymentConstraints: (o) => [
            { type: "payment.amount_range", currency: "USD", max: 5000 },
            { type: "payment.budget", currency, max },
            ref(o),
          ],
        },
      });
      await refusedLocally(w, input, "BUDGET_UNIT_AMBIGUOUS");
    }
  });
  it("recurrence without a durable store", async () => {
    const w = world();
    const input = payInput(w, {
      open: {
        paymentConstraints: (o) => [
          { type: "payment.amount_range", currency: "USD", max: 5000 },
          { type: "payment.budget", currency: "USD", max: 100 },
          { type: "payment.agent_recurrence", frequency: "MONTHLY", max_occurrences: 3 },
          ref(o),
        ],
      },
    });
    await refusedLocally(w, input, "STORE_REQUIRED", { store: undefined });
  });
});

describe("local caps", () => {
  it("above max: refused locally, Guardian not asked", async () => {
    const w = world();
    const input = payInput(w, {
      open: { paymentConstraints: (o) => [{ type: "payment.amount_range", currency: "USD", max: 99999 }, ref(o)] },
      checkout: { items: [{ id: "sku_mug", title: "Coffee mug", price: 15000, quantity: 2 }] },
    });
    await refusedLocally(w, input, "ABOVE_MAX");
  });
  it("above askAbove, or a currency with no cap: above_cap with the reason", async () => {
    const w = world();
    const guardian = fakeGuardian({ decide: () => "ASK" });
    const { guard } = makeGuard(w, { guardian });
    await guard.pay(payInput(w, { checkout: { items: [{ id: "sku_mug", title: "Coffee mug", price: 3000, quantity: 1 }] } }));
    expect(guardian.requests[0].toolName).toBe("ap2.pay.above_cap");
    expect(guardian.requests[0].arguments.reviewReasons).toEqual(["ABOVE_ASK_ABOVE", "FIRST_USE_OF_OPEN_MANDATE"]);
    const { guard: g2 } = makeGuard(w, { guardian, limits: [] });
    await g2.pay(payInput(w));
    expect(guardian.requests[1].arguments.reviewReasons).toEqual(["NO_CAP_FOR_CURRENCY", "FIRST_USE_OF_OPEN_MANDATE"]);
  });
  it("payee not on the currency's allowlist", async () => {
    const w = world();
    await refusedLocally(w, payInput(w), "PAYEE_NOT_ALLOWED", { limits: [{ currency: "USD", askAbove: 100, max: 9999, payees: ["merchant_2"] }] });
  });
  it("a missing or short verifier challenge", async () => {
    const w = world();
    await refusedLocally(w, { ...payInput(w), merchantChallenge: { aud: "m", nonce: "short" } }, "INVALID_AUDIENCE");
    const { credentialProviderChallenge: _c, ...rest } = payInput(w);
    void _c;
    await refusedLocally(w, rest, "INVALID_AUDIENCE");
  });
});

describe("display amounts use the guard's ISO 4217 exponents, never a $ sign", () => {
  it("USD 2, JPY 0, KWD 3", () => {
    expect(formatMinor(1999, "USD")).toBe("19.99 USD");
    expect(formatMinor(5, "USD")).toBe("0.05 USD");
    expect(formatMinor(1999, "JPY")).toBe("1999 JPY");
    expect(formatMinor(1999, "KWD")).toBe("1.999 KWD");
    expect(formatMinor(-250, "EUR")).toBe("-2.50 EUR");
    expect(() => formatMinor(1.5, "USD")).toThrow();
    expect(() => formatMinor(1, "XYZ")).toThrow();
  });
});

describe("expiry is checked again after the decision, before the agent key signs", () => {
  const asks = (getGuard: () => ReturnType<typeof makeGuard>) =>
    fakeGuardian({ decide: () => "ASK", onClaim: () => getGuard().advance(60_000), claimsBeforeDecision: 1 });

  it("an open mandate that expires during the ASK wait: nothing is signed", async () => {
    const w = world();
    let m: ReturnType<typeof makeGuard> | undefined;
    m = makeGuard(w, { guardian: asks(() => m!), requestTtlMs: 300_000 });
    await expect(m.guard.pay(payInput(w, { open: { exp: NOW_SEC + 30 } }))).rejects.toMatchObject({ code: "OPEN_MANDATE_EXPIRED" });
    expect(w.signed).toHaveLength(0);
    expect((await m.guard.ledgerEntries())[0]!.state).toBe("released");
  });

  it("a checkout that expires during the ASK wait: nothing is signed", async () => {
    const w = world();
    let m: ReturnType<typeof makeGuard> | undefined;
    m = makeGuard(w, { guardian: asks(() => m!), requestTtlMs: 300_000 });
    const expiresAt = new Date((NOW_SEC + 30) * 1000).toISOString();
    await expect(m.guard.pay(payInput(w, { checkout: { extra: { expires_at: expiresAt } } }))).rejects.toMatchObject({
      code: "CHECKOUT_EXPIRED",
    });
    expect(w.signed).toHaveLength(0);
  });
});
