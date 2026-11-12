import { describe, expect, it } from "vitest";

import type { ClosedCheckoutContent, ClosedPaymentContent, OpenCheckoutContent, OpenPaymentContent } from "../src/index.js";
import {
  checkoutJwt,
  fakeGuardian,
  INSTRUMENT,
  issueSdJwt,
  makeGuard,
  MERCHANT,
  NOW_SEC,
  orderLog,
  sdHashOf,
  toolOf,
  world,
  type World,
} from "./helpers.js";

function surface(w: World, change?: (c: Record<string, unknown>) => Record<string, unknown>) {
  const calls: unknown[] = [];
  const fn = async (closed: { checkoutMandate: ClosedCheckoutContent; paymentMandate: ClosedPaymentContent }) => {
    calls.push(closed);
    const sign = (c: Record<string, unknown>) => issueSdJwt(w.ts.privateKey, change ? change(c) : { ...c, iat: NOW_SEC });
    return { checkoutMandate: sign({ ...closed.checkoutMandate }), paymentMandate: sign({ ...closed.paymentMandate }) };
  };
  return { fn, calls };
}

describe("human present: Guardian decides, the Trusted Surface signs, the guard checks the result", () => {
  it("the TS signs exactly the approved content: presented once", async () => {
    const order = orderLog();
    const w = world();
    const guardian = fakeGuardian({ decide: () => "ALLOW" });
    const { guard } = makeGuard(w, { guardian });
    const ts = surface(w);
    const p = await guard.payHumanPresent({ checkoutJwt: checkoutJwt(w), paymentInstrument: INSTRUMENT, trustedSurface: ts.fn });
    expect(order).toEqual(["request", "execute"]);
    expect(ts.calls).toHaveLength(1);
    expect(guardian.requests[0].toolName).toBe("ap2.pay");
    expect(guardian.requests[0].arguments).toMatchObject({ mode: "human-present", keyBinding: null, openMandates: null, amountDisplay: "19.99 USD" });
    const sent: string[] = [];
    await p.presentPayment(async (m) => sent.push(m));
    await expect(p.presentPayment(async (m) => sent.push(m))).rejects.toMatchObject({ code: "ALREADY_PRESENTED" });
    expect(sent).toHaveLength(1);
    expect(w.signed).toHaveLength(0); // the agent key signs nothing in human present
  });

  it("a mandate whose content differs from the approval is not presented", async () => {
    const w = world();
    const { guard } = makeGuard(w, { guardian: fakeGuardian({ decide: () => "ALLOW" }) });
    const ts = surface(w, (c) =>
      c.vct === "mandate.payment.1" ? { ...c, payment_amount: { amount: 99999, currency: "USD" } } : c,
    );
    await expect(
      guard.payHumanPresent({ checkoutJwt: checkoutJwt(w), paymentInstrument: INSTRUMENT, trustedSurface: ts.fn }),
    ).rejects.toMatchObject({ code: "MANDATE_CONTENT_MISMATCH" });
  });

  it("a mandate not signed by a pinned Trusted Surface key is not presented", async () => {
    const w = world();
    const { guard } = makeGuard(w, { guardian: fakeGuardian({ decide: () => "ALLOW" }) });
    const fn = async (closed: { checkoutMandate: ClosedCheckoutContent; paymentMandate: ClosedPaymentContent }) => ({
      checkoutMandate: issueSdJwt(w.agent.privateKey, { ...closed.checkoutMandate }),
      paymentMandate: issueSdJwt(w.agent.privateKey, { ...closed.paymentMandate }),
    });
    await expect(guard.payHumanPresent({ checkoutJwt: checkoutJwt(w), paymentInstrument: INSTRUMENT, trustedSurface: fn })).rejects.toMatchObject({
      code: "MANDATE_CONTENT_MISMATCH",
    });
  });

  it("DENY: the Trusted Surface is never asked", async () => {
    const w = world();
    const { guard } = makeGuard(w, { guardian: fakeGuardian({ decide: () => ({ deny: "POLICY_DENIED" }) }) });
    const ts = surface(w);
    await expect(guard.payHumanPresent({ checkoutJwt: checkoutJwt(w), paymentInstrument: INSTRUMENT, trustedSurface: ts.fn })).rejects.toMatchObject({
      code: "GUARDIAN_DENIED",
    });
    expect(ts.calls).toHaveLength(0);
  });

  it("the same checkout cannot be paid again while the first is outstanding, whoever would approve", async () => {
    const w = world();
    const guardian = fakeGuardian({ decide: () => "ASK" });
    const { guard } = makeGuard(w, { guardian });
    const jwt = checkoutJwt(w);
    const ts2 = surface(w);
    const p = await guard.payHumanPresent({ checkoutJwt: jwt, paymentInstrument: INSTRUMENT, trustedSurface: surface(w).fn });
    await p.presentPayment(async () => "token");
    await expect(guard.payHumanPresent({ checkoutJwt: jwt, paymentInstrument: INSTRUMENT, trustedSurface: ts2.fn })).rejects.toMatchObject({
      code: "OUTSTANDING_PRESENTATION",
    });
    expect(ts2.calls).toHaveLength(0);
    expect(guardian.requests).toHaveLength(1);
  });

  it("a checkout that expires while a person decides is not handed to the Trusted Surface", async () => {
    const w = world();
    let m: ReturnType<typeof makeGuard> | undefined;
    const guardian = fakeGuardian({ decide: () => "ASK", onClaim: () => m!.advance(60_000), claimsBeforeDecision: 1 });
    m = makeGuard(w, { guardian, requestTtlMs: 300_000 });
    const ts = surface(w);
    const jwt = checkoutJwt(w, { extra: { expires_at: new Date((NOW_SEC + 30) * 1000).toISOString() } });
    await expect(m.guard.payHumanPresent({ checkoutJwt: jwt, paymentInstrument: INSTRUMENT, trustedSurface: ts.fn })).rejects.toMatchObject({
      code: "CHECKOUT_EXPIRED",
    });
    expect(ts.calls).toHaveLength(0);
  });
});

const exp = NOW_SEC + 3600;
const openCheckoutContent = {
  vct: "mandate.checkout.open.1",
  constraints: [
    { type: "checkout.allowed_merchants", allowed: [MERCHANT] },
    { type: "checkout.line_items", items: [{ id: "r1", acceptable_items: [{ id: "sku_mug", title: "Coffee mug" }], quantity: 1 }] },
  ],
  iat: NOW_SEC,
  exp,
};
const openPaymentContent = {
  vct: "mandate.payment.open.1",
  constraints: [
    { type: "payment.amount_range", currency: "USD", min: 0, max: 2500 },
    { type: "payment.allowed_payees", allowed: [MERCHANT] },
  ],
  iat: NOW_SEC,
  exp,
};

function tsSigner(w: World, tamper?: "checkout" | "payment") {
  const calls: string[] = [];
  return {
    calls,
    signOpenCheckout: async (c: OpenCheckoutContent) => {
      calls.push("checkout");
      return issueSdJwt(w.ts.privateKey, tamper === "checkout" ? { ...c, exp: c.exp + 999999 } : (c as never));
    },
    signOpenPayment: async (c: OpenPaymentContent) => {
      calls.push("payment");
      return issueSdJwt(w.ts.privateKey, tamper === "payment" ? { ...c, constraints: c.constraints.slice(1) } : (c as never));
    },
  };
}

describe("delegation: Guardian decides before the Trusted Surface is asked", () => {
  it("always needs a person; the guard sets cnf and payment.reference; the TS output is checked", async () => {
    const w = world();
    const guardian = fakeGuardian({ decide: () => "ASK" });
    const { guard } = makeGuard(w, { guardian });
    const ts = tsSigner(w);
    const d = await guard.delegate({ openCheckout: openCheckoutContent, openPayment: openPaymentContent, trustedSurface: ts });
    expect(ts.calls).toEqual(["checkout", "payment"]);
    expect(guardian.requests[0].toolName).toBe("ap2.delegate");
    expect(guardian.requests[0].arguments).toMatchObject({
      schema: "odingard.guardian.ap2.delegate.v1",
      recurring: false,
      amountMaxDisplay: "25.00 USD",
      openPayment: { paymentReference: expect.stringContaining("Set by the guard") },
    });
    const pay = JSON.parse(Buffer.from(d.openPaymentMandate.split("~")[1]!, "base64url").toString())[1];
    expect(pay.cnf.jwk.x).toBe(w.agent.publicJwk.x);
    expect(pay.constraints.at(-1)).toEqual({ type: "payment.reference", conditional_transaction_id: sdHashOf(d.openCheckoutMandate) });
  });

  it("a rule ALLOW is not enough, and the TS is never asked", async () => {
    const w = world();
    const { guard } = makeGuard(w, { guardian: fakeGuardian({ decide: () => "ALLOW" }) });
    const ts = tsSigner(w);
    await expect(guard.delegate({ openCheckout: openCheckoutContent, openPayment: openPaymentContent, trustedSurface: ts })).rejects.toMatchObject({
      code: "PERSON_APPROVAL_REQUIRED",
    });
    expect(ts.calls).toEqual([]);
  });

  it("recurring delegation is proposed as ap2.delegate.recurring", async () => {
    const w = world();
    const guardian = fakeGuardian({ decide: () => "ASK" });
    const { guard } = makeGuard(w, { guardian });
    await guard.delegate({
      openCheckout: openCheckoutContent,
      openPayment: {
        ...openPaymentContent,
        constraints: [
          ...openPaymentContent.constraints,
          { type: "payment.budget", currency: "USD", max: 100 },
          { type: "payment.agent_recurrence", frequency: "MONTHLY", max_occurrences: 12 },
        ],
      },
      trustedSurface: tsSigner(w),
    });
    expect(guardian.requests[0].toolName).toBe("ap2.delegate.recurring");
    expect(guardian.requests[0].arguments.recurring).toBe(true);
  });

  const lint: [string, Record<string, unknown>, Record<string, unknown>, string][] = [
    ["no amount_range", openCheckoutContent, { ...openPaymentContent, constraints: [openPaymentContent.constraints[1]] }, "MISSING_FIELD"],
    [
      "recurrence without budget",
      openCheckoutContent,
      { ...openPaymentContent, constraints: [...openPaymentContent.constraints, { type: "payment.agent_recurrence", frequency: "DAILY" }] },
      "MISSING_FIELD",
    ],
    ["a long exp", openCheckoutContent, { ...openPaymentContent, exp: NOW_SEC + 30 * 86400 }, "OPEN_MANDATE_LIFETIME_TOO_LONG"],
    ["an exp in the past", { ...openCheckoutContent, exp: NOW_SEC - 1 }, openPaymentContent, "OPEN_MANDATE_EXPIRED"],
    ["cnf not ours", { ...openCheckoutContent, cnf: { jwk: { kty: "EC", crv: "P-256", x: "A".repeat(43), y: "B".repeat(43) } } }, openPaymentContent, "CNF_NOT_AGENT_KEY"],
    [
      "a currency with no cap",
      openCheckoutContent,
      { ...openPaymentContent, constraints: [{ type: "payment.amount_range", currency: "EUR", max: 100 }] },
      "NO_CAP_FOR_CURRENCY",
    ],
    [
      "amount_range above the local max",
      openCheckoutContent,
      { ...openPaymentContent, constraints: [{ type: "payment.amount_range", currency: "USD", max: 999999 }] },
      "ABOVE_MAX",
    ],
    [
      "payment.reference supplied by the caller",
      openCheckoutContent,
      { ...openPaymentContent, constraints: [...openPaymentContent.constraints, { type: "payment.reference", conditional_transaction_id: "x" }] },
      "MALFORMED_MANDATE",
    ],
    [
      "an unknown constraint",
      openCheckoutContent,
      { ...openPaymentContent, constraints: [...openPaymentContent.constraints, { type: "payment.anything" }] },
      "UNKNOWN_CONSTRAINT",
    ],
  ];
  for (const [name, oc, op, code] of lint) {
    it(`lint before the Trusted Surface: ${name}`, async () => {
      const w = world();
      const guardian = fakeGuardian({ decide: () => "ASK" });
      const { guard } = makeGuard(w, { guardian });
      const ts = tsSigner(w);
      await expect(guard.delegate({ openCheckout: oc, openPayment: op, trustedSurface: ts })).rejects.toMatchObject({ code });
      expect(guardian.requests).toHaveLength(0);
      expect(ts.calls).toEqual([]);
    });
  }

  it("a Trusted Surface that signs other content than approved is refused", async () => {
    for (const tamper of ["checkout", "payment"] as const) {
      const w = world();
      const { guard } = makeGuard(w, { guardian: fakeGuardian({ decide: () => "ASK" }) });
      await expect(
        guard.delegate({ openCheckout: openCheckoutContent, openPayment: openPaymentContent, trustedSurface: tsSigner(w, tamper) }),
      ).rejects.toMatchObject({ code: tamper === "checkout" ? "MANDATE_CONTENT_MISMATCH" : "MANDATE_CONTENT_MISMATCH" });
    }
  });
});
