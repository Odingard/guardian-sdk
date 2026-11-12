import { describe, expect, it } from "vitest";

import { Ap2GuardRefused } from "../src/index.js";
import {
  askFirstUse,
  CP_CHALLENGE,
  fakeGuardian,
  INSTRUMENT,
  makeGuard,
  MERCHANT,
  MERCHANT_CHALLENGE,
  NOW_MS,
  orderLog,
  payInput,
  toolOf,
  verifyChain,
  world,
} from "./helpers.js";

async function refusal(p: Promise<unknown>): Promise<Ap2GuardRefused> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(Ap2GuardRefused);
    return e as Ap2GuardRefused;
  }
  throw new Error("expected a refusal");
}

describe("human not present: decide, redeem, then sign once", () => {
  it("a person approves a 19.99 USD pair: request, claim, execute, receipt check, then the checkout hop and the payment hop are signed", async () => {
    const order = orderLog();
    const w = world();
    const guardian = fakeGuardian({ decide: askFirstUse });
    const { guard } = makeGuard(w, { guardian });
    const input = payInput(w);

    const p = await guard.pay(input);
    expect(order).toEqual(["request", "claim", "claim", "execute", "sign", "sign"]);
    expect(guardian.calls.map((c) => c.op)).toEqual(["request", "claim", "claim", "execute", "portableReceipt"]);
    expect(p.approvedByPerson).toBe(true);

    const inv = guardian.requests[0];
    expect(inv.action).toBe("tool.invoke");
    expect(inv.toolName).toBe("ap2.pay.above_cap");
    expect(inv.arguments.reviewReasons).toEqual(["FIRST_USE_OF_OPEN_MANDATE"]);
    expect(inv.arguments).toMatchObject({
      schema: "odingard.guardian.ap2.pay.v1",
      ap2Version: "0.2",
      mode: "human-not-present",
      merchant: MERCHANT,
      amount: 1999,
      currency: "USD",
      amountDisplay: "19.99 USD",
      payment: {
        vct: "mandate.payment.1",
        payee: MERCHANT,
        paymentAmount: { amount: 1999, currency: "USD" },
        paymentInstrument: INSTRUMENT,
        executionDate: "now",
        pisp: null,
      },
      checkout: { vct: "mandate.checkout.1", total: 1999, totalDisplay: "19.99 USD", refundTerms: "Refund terms: not stated by the merchant" },
      keyBinding: { checkout: { aud: MERCHANT_CHALLENGE.aud, nonce: MERCHANT_CHALLENGE.nonce }, payment: { aud: CP_CHALLENGE.aud } },
    });
    expect(inv.arguments.termsDigest).toBe(p.termsDigest);
    expect(inv.arguments.payment.transactionId).toBe(inv.arguments.checkout.checkoutHash);
    expect(inv.purpose).toContain("19.99 USD");

    // Presented chains verify like an AP2 verifier checks them.
    const sentToCp: string[] = [];
    const sentToMerchant: string[] = [];
    await p.presentPayment(async (chain) => sentToCp.push(chain));
    await p.presentCheckout(async (chain) => sentToMerchant.push(chain));
    const pay = verifyChain(sentToCp[0]!, w.ts.publicJwk, CP_CHALLENGE);
    const chk = verifyChain(sentToMerchant[0]!, w.ts.publicJwk, MERCHANT_CHALLENGE);
    expect(pay.closed).toEqual({
      vct: "mandate.payment.1",
      transaction_id: inv.arguments.checkout.checkoutHash,
      payee: MERCHANT,
      payment_amount: { amount: 1999, currency: "USD" },
      payment_instrument: INSTRUMENT,
    });
    expect(chk.closed).toEqual({
      vct: "mandate.checkout.1",
      checkout_jwt: input.checkoutJwt,
      checkout_hash: inv.arguments.checkout.checkoutHash,
    });
    expect(pay.reference).toBe(p.paymentReference);
    expect(chk.reference).toBe(p.checkoutReference);
    // The receipt Guardian recorded holds the full terms and digest.
    const redeemed = guard.records().find((r) => r.event === "redeemed")!;
    expect(redeemed.termsDigest).toBe(p.termsDigest);
    expect(redeemed.terms).toEqual(p.terms);
  });

  it("a rule ALLOW suffices once a person approved the open mandate through delegate(): request, execute, sign, sign", async () => {
    const w = world();
    const guardian = fakeGuardian({ decide: (inv) => (toolOf(inv).startsWith("ap2.delegate") ? "ASK" : "ALLOW") });
    const { guard } = makeGuard(w, { guardian });
    const base = payInput(w);
    const { issueSdJwt } = await import("./helpers.js");
    const d = await guard.delegate({
      openCheckout: {
        vct: "mandate.checkout.open.1",
        constraints: [
          { type: "checkout.line_items", items: [{ id: "r1", acceptable_items: [{ id: "sku_mug", title: "Coffee mug" }], quantity: 1 }] },
        ],
        exp: Math.floor(Date.UTC(2026, 10, 12, 13) / 1000),
      },
      openPayment: {
        vct: "mandate.payment.open.1",
        constraints: [{ type: "payment.amount_range", currency: "USD", max: 2500 }],
        exp: Math.floor(Date.UTC(2026, 10, 12, 13) / 1000),
      },
      trustedSurface: {
        signOpenCheckout: async (c) => issueSdJwt(w.ts.privateKey, c as never),
        signOpenPayment: async (c) => issueSdJwt(w.ts.privateKey, c as never),
      },
    });
    const order = orderLog();
    const before = guardian.calls.length;
    const p = await guard.pay({ ...base, openCheckoutMandate: d.openCheckoutMandate, openPaymentMandate: d.openPaymentMandate });
    expect(order).toEqual(["request", "execute", "sign", "sign"]);
    expect(guardian.requests.at(-1).toolName).toBe("ap2.pay");
    expect(guardian.requests.at(-1).arguments.reviewReasons).toEqual([]);
    expect(guardian.calls.slice(before).map((c) => c.op)).toEqual(["request", "execute"]);
    expect(p.approvedByPerson).toBe(false);
  });

  it("ASK that expires: nothing is signed and the reservation is released", async () => {
    const w = world();
    const guardian = fakeGuardian({ decide: () => "ASK", person: "never" });
    let t = NOW_MS;
    const { guard } = makeGuard(w, { guardian, requestTtlMs: 30, now: () => (t += 5) });
    const err = await refusal(guard.pay(payInput(w)));
    expect(err.code).toBe("APPROVAL_TIMEOUT");
    expect(w.signed).toHaveLength(0);
    expect((await guard.ledgerEntries()).every((e) => e.state === "released")).toBe(true);
  });

  it("DENY by a person: nothing is signed and Guardian's reason is surfaced", async () => {
    const w = world();
    const guardian = fakeGuardian({ decide: () => "ASK", person: "deny" });
    const { guard } = makeGuard(w, { guardian });
    const err = await refusal(guard.pay(payInput(w)));
    expect(err.code).toBe("GUARDIAN_DENIED");
    expect(err.guardianReasonCode).toBe("APPROVAL_DENIED");
    expect(w.signed).toHaveLength(0);
  });

  it("DENY at request (missing catalog entry or grant): nothing is signed, nothing is installed", async () => {
    for (const reason of ["TOOL_NOT_IN_CATALOG", "TOOL_NOT_GRANTED"]) {
      const w = world();
      const guardian = fakeGuardian({ decide: () => ({ deny: reason }) });
      const { guard } = makeGuard(w, { guardian });
      const err = await refusal(guard.pay(payInput(w)));
      expect(err.code).toBe("GUARDIAN_DENIED");
      expect(err.guardianReasonCode).toBe(reason);
      expect(guardian.requests.every((r) => r.action === "tool.invoke")).toBe(true);
      expect(w.signed).toHaveLength(0);
    }
  });

  it("an above-cap payment refuses a rule ALLOW", async () => {
    const w = world();
    const guardian = fakeGuardian({ decide: () => "ALLOW" });
    const { guard } = makeGuard(w, { guardian });
    const err = await refusal(guard.pay(payInput(w)));
    expect(err.code).toBe("PERSON_APPROVAL_REQUIRED");
    expect(guardian.calls.map((c) => c.op)).toEqual(["request"]);
    expect(w.signed).toHaveLength(0);
  });

  it("an approval whose receipt does not show a person approving is not enough", async () => {
    for (const receiptApproval of ["pending", null] as const) {
      const w = world();
      const guardian = fakeGuardian({ decide: () => "ASK", receiptApproval });
      const { guard } = makeGuard(w, { guardian });
      const err = await refusal(guard.pay(payInput(w)));
      expect(err.code).toBe("RECEIPT_CHECK_FAILED");
      expect(w.signed).toHaveLength(0);
    }
  });
});

describe("Guardian failures: fail closed", () => {
  const cases: [string, Parameters<typeof fakeGuardian>[0], string][] = [
    ["unreachable", { decide: () => "THROW" }, "GUARDIAN_UNREACHABLE"],
    ["service unavailable", { decide: () => "UNAVAILABLE" }, "GUARDIAN_UNREACHABLE"],
    ["malformed", { decide: () => "MALFORMED" }, "GUARDIAN_UNREACHABLE"],
    ["hangs", { decide: () => "HANG" }, "GUARDIAN_TIMEOUT"],
    ["execute refuses", { decide: () => "ASK", executeFails: "CAPABILITY_EXPIRED" }, "EXECUTE_FAILED"],
    ["revoked after the decision", { decide: () => "ASK", revokeAfterDecision: true }, "EXECUTE_FAILED"],
    ["execute throws (outcome unknown)", { decide: () => "ASK", executeThrows: true }, "EXECUTE_FAILED"],
    ["execute outcome unknown", { decide: () => "ASK", executeOutcomeUnknown: true }, "EXECUTE_FAILED"],
  ];
  for (const [name, opts, code] of cases) {
    it(`${name}: nothing is signed`, async () => {
      const w = world();
      const { guard } = makeGuard(w, { guardian: fakeGuardian(opts), guardianCallTimeoutMs: 20 });
      const err = await refusal(guard.pay(payInput(w)));
      expect(err.code).toBe(code);
      expect(w.signed).toHaveLength(0);
      expect((await guard.ledgerEntries()).every((e) => e.state === "released")).toBe(true);
    });
  }

  it("execute with an unknown outcome is recorded as redeemed or unknown, not signed", async () => {
    const w = world();
    const { guard } = makeGuard(w, { guardian: fakeGuardian({ decide: () => "ASK", executeThrows: true }) });
    const err = await refusal(guard.pay(payInput(w)));
    expect(err.outcomeUnknown).toBe(true);
    expect(err.requestId).toMatch(/^req_/);
    const r = guard.records().find((x) => x.event === "redeemed-not-signed")!;
    expect(r.outcomeUnknown).toBe(true);
    expect(r.detail).toContain("Redeemed or unknown, not signed");
  });
});
