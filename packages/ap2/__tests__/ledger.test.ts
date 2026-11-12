import { describe, expect, it } from "vitest";

import { createAp2Guard } from "../src/index.js";
import {
  askFirstUse,
  checkoutJwt,
  CONNECTION,
  fakeGuardian,
  makeGuard,
  MERCHANT,
  MERCHANT_2,
  NOW_MS,
  NOW_SEC,
  openMandates,
  payInput,
  receipt,
  RECEIPT_ISS_M,
  RECEIPT_ISS_MPP,
  sdHashOf,
  testStore,
  world,
  type World,
} from "./helpers.js";

const DAY = 24 * 3600 * 1000;

function recurring(w: World, frequency: string, maxOccurrences: number | undefined, budgetMax: number) {
  return openMandates(w, {
    exp: NOW_SEC + 400 * 86400,
    paymentConstraints: (o) => [
      { type: "payment.amount_range", currency: "USD", max: 5000 },
      { type: "payment.budget", currency: "USD", max: budgetMax },
      { type: "payment.agent_recurrence", frequency, ...(maxOccurrences !== undefined ? { max_occurrences: maxOccurrences } : {}) },
      { type: "payment.reference", conditional_transaction_id: sdHashOf(o) },
    ],
  });
}

function inputWith(w: World, open: { openCheckout: string; openPayment: string }) {
  return { ...payInput(w), openCheckoutMandate: open.openCheckout, openPaymentMandate: open.openPayment };
}

const successPayment = (w: World, reference: string) =>
  receipt(w.mpp.privateKey, RECEIPT_ISS_MPP, {
    status: "Success",
    reference,
    payment_id: "pay_1",
    psp_confirmation_id: "psp_1",
    network_confirmation_id: "net_1",
  });

const errorPayment = (w: World, reference: string, error = "declined") =>
  receipt(w.mpp.privateKey, RECEIPT_ISS_MPP, {
    status: "Error",
    reference,
    payment_id: "pay_1",
    error,
    error_description: "The payment was declined.",
  });

async function payAndSettle(guard: ReturnType<typeof makeGuard>["guard"], w: World, input: ReturnType<typeof payInput>) {
  const p = await guard.pay(input);
  await p.presentPayment(async () => "token");
  await p.presentCheckout(async () => "order");
  await guard.recordReceipt(successPayment(w, p.paymentReference));
  return p;
}

describe("recurrence: frequency and max_occurrences, enforced by the guard", () => {
  it("MONTHLY, 3 occurrences: a second charge in the same month is refused; the 4th is refused", async () => {
    const w = world();
    const guardian = fakeGuardian({ decide: askFirstUse });
    const m = makeGuard(w, { guardian });
    const open = recurring(w, "MONTHLY", 3, 100);
    await payAndSettle(m.guard, w, inputWith(w, open));
    expect(guardian.requests[0].toolName).toBe("ap2.pay.above_cap");
    await expect(m.guard.pay(inputWith(w, open))).rejects.toMatchObject({ code: "RECURRENCE_EXCEEDED" });

    m.setNow(Date.UTC(2026, 11, 3));
    await payAndSettle(m.guard, w, inputWith(w, open));
    expect(guardian.requests.at(-1).toolName).toBe("ap2.pay"); // repeats may follow a rule
    m.setNow(Date.UTC(2027, 0, 3));
    await payAndSettle(m.guard, w, inputWith(w, open));
    m.setNow(Date.UTC(2027, 1, 3));
    await expect(m.guard.pay(inputWith(w, open))).rejects.toMatchObject({ code: "RECURRENCE_EXCEEDED" });
    expect(w.signed).toHaveLength(6);
  });

  it("the ledger survives a restart (same store, new guard)", async () => {
    const w = world();
    const store = testStore();
    const guardian = fakeGuardian({ decide: askFirstUse });
    const a = makeGuard(w, { guardian, store });
    const open = recurring(w, "DAILY", 5, 100);
    await payAndSettle(a.guard, w, inputWith(w, open));
    const b = makeGuard(w, { guardian, store });
    await expect(b.guard.pay(inputWith(w, open))).rejects.toMatchObject({ code: "RECURRENCE_EXCEEDED" });
    b.setNow(NOW_MS + DAY);
    await payAndSettle(b.guard, w, inputWith(w, open));
  });

  it("WEEKLY uses ISO weeks; BIWEEKLY needs 14 days between payments; ON_DEMAND only counts", async () => {
    const w = world();
    const guardian = fakeGuardian({ decide: askFirstUse });
    const m = makeGuard(w, { guardian });
    const weekly = recurring(w, "WEEKLY", undefined, 100);
    await payAndSettle(m.guard, w, inputWith(w, weekly)); // Thursday
    m.setNow(Date.UTC(2026, 10, 15)); // Sunday, same ISO week
    await expect(m.guard.pay(inputWith(w, weekly))).rejects.toMatchObject({ code: "RECURRENCE_EXCEEDED" });
    m.setNow(Date.UTC(2026, 10, 16)); // Monday
    await payAndSettle(m.guard, w, inputWith(w, weekly));

    const n = makeGuard(w, { guardian });
    const biweekly = recurring(w, "BIWEEKLY", undefined, 100);
    await payAndSettle(n.guard, w, inputWith(w, biweekly));
    n.setNow(NOW_MS + 13 * DAY);
    await expect(n.guard.pay(inputWith(w, biweekly))).rejects.toMatchObject({ code: "RECURRENCE_EXCEEDED" });
    n.setNow(NOW_MS + 14 * DAY);
    await payAndSettle(n.guard, w, inputWith(w, biweekly));

    const o = makeGuard(w, { guardian });
    const onDemand = recurring(w, "ON_DEMAND", 2, 100);
    await payAndSettle(o.guard, w, inputWith(w, onDemand));
    await payAndSettle(o.guard, w, inputWith(w, onDemand));
    await expect(o.guard.pay(inputWith(w, onDemand))).rejects.toMatchObject({ code: "RECURRENCE_EXCEEDED" });
  });

  it("two concurrent payments from one open mandate cannot both reserve", async () => {
    const w = world();
    const guardian = fakeGuardian({ decide: () => "ASK" });
    const m = makeGuard(w, { guardian });
    const open = recurring(w, "ON_DEMAND", 1, 100);
    const results = await Promise.allSettled([m.guard.pay(inputWith(w, open)), m.guard.pay(inputWith(w, open))]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(bad[0]!.reason.code).toBe("MANDATE_IN_USE");
    expect(w.signed).toHaveLength(2);
  });

  it("a store that fails refuses, and nothing is signed", async () => {
    const w = world();
    const store = testStore();
    store.failing = true;
    const guardian = fakeGuardian({ decide: () => "ASK" });
    const m = makeGuard(w, { guardian, store });
    await expect(m.guard.pay(payInput(w))).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
    expect(guardian.requests).toHaveLength(0);
    expect(w.signed).toHaveLength(0);
  });
});

describe("budget", () => {
  it("the cumulative total above budget.max is refused", async () => {
    const w = world();
    const guardian = fakeGuardian({ decide: askFirstUse });
    const m = makeGuard(w, { guardian });
    const open = recurring(w, "ON_DEMAND", 10, 30);
    await payAndSettle(m.guard, w, inputWith(w, open)); // 19.99 of 30.00
    await expect(m.guard.pay(inputWith(w, open))).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(guardian.requests).toHaveLength(1);
  });
});

describe("double spend: one outstanding pair per open mandate", () => {
  it("a second pair before any receipt is refused outright, even when a person would approve; Guardian is not asked", async () => {
    const w = world();
    const guardian = fakeGuardian({ decide: () => "ASK" });
    const m = makeGuard(w, { guardian });
    const input = payInput(w);
    await m.guard.pay(input); // signed, never presented
    await expect(m.guard.pay({ ...input, checkoutJwt: checkoutJwt(w) })).rejects.toMatchObject({ code: "OUTSTANDING_PRESENTATION" });
    const p2 = await (async () => {
      const w2 = world();
      const m2 = makeGuard(w2, { guardian: fakeGuardian({ decide: () => "ASK" }) });
      const input2 = payInput(w2);
      const first = await m2.guard.pay(input2);
      await first.presentPayment(async () => "token");
      await expect(m2.guard.pay({ ...input2, checkoutJwt: checkoutJwt(w2) })).rejects.toMatchObject({ code: "OUTSTANDING_PRESENTATION" });
      return w2.signed.length;
    })();
    expect(p2).toBe(2);
    expect(guardian.requests).toHaveLength(1);
    expect(w.signed).toHaveLength(2);
  });

  it("recurring mandates too: the next occurrence waits for the previous pair's receipt", async () => {
    const w = world();
    const guardian = fakeGuardian({ decide: () => "ASK" });
    const m = makeGuard(w, { guardian });
    const open = recurring(w, "ON_DEMAND", 10, 5000);
    const p = await m.guard.pay(inputWith(w, open));
    await p.presentPayment(async () => "token");
    await expect(m.guard.pay(inputWith(w, open))).rejects.toMatchObject({ code: "OUTSTANDING_PRESENTATION" });
    await m.guard.recordReceipt(successPayment(w, p.paymentReference));
    await m.guard.pay(inputWith(w, open));
    expect(guardian.requests).toHaveLength(2);
  });

  it("a single-use mandate stays used after a Success receipt", async () => {
    const w = world();
    const m = makeGuard(w, { guardian: fakeGuardian({ decide: () => "ASK" }) });
    const input = payInput(w);
    const p = await m.guard.pay(input);
    await p.presentPayment(async () => "token");
    await m.guard.recordReceipt(successPayment(w, p.paymentReference));
    await expect(m.guard.pay({ ...input, checkoutJwt: checkoutJwt(w) })).rejects.toMatchObject({ code: "MANDATE_ALREADY_USED" });
  });

  it("a checkout Error after the payment mandate was presented does not release the pair; a late payment Success counts", async () => {
    const w = world();
    const guardian = fakeGuardian({ decide: askFirstUse });
    const m = makeGuard(w, { guardian });
    const open = recurring(w, "ON_DEMAND", undefined, 50); // budget 50.00 USD
    await payAndSettle(m.guard, w, inputWith(w, open)); // 19.99 of 50.00
    const p2 = await m.guard.pay(inputWith(w, open));
    await p2.presentPayment(async () => "token");
    await p2.presentCheckout(async () => "order");
    const r = await m.guard.recordReceipt(
      receipt(w.merchant.privateKey, RECEIPT_ISS_M, { status: "Error", reference: p2.checkoutReference, error: "out_of_stock", error_description: "x" }),
    );
    expect(r).toMatchObject({ kind: "checkout", status: "Error", released: false, conflict: false });
    await expect(m.guard.pay(inputWith(w, open))).rejects.toMatchObject({ code: "OUTSTANDING_PRESENTATION" });
    const late = await m.guard.recordReceipt(successPayment(w, p2.paymentReference));
    expect(late).toMatchObject({ kind: "payment", status: "Success", released: false, conflict: false });
    const entries = await m.guard.ledgerEntries();
    expect(entries.map((e) => e.state)).toEqual(["complete", "complete"]);
    // 19.99 + 19.99 used; a third would be 59.97 > 50.00, with no person involved or not.
    await expect(m.guard.pay(inputWith(w, open))).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  it("a checkout Error before the payment mandate was presented releases the pair, and that payment mandate is then never presented", async () => {
    const w = world();
    const m = makeGuard(w, { guardian: fakeGuardian({ decide: () => "ASK" }) });
    const p = await m.guard.pay(payInput(w));
    await p.presentCheckout(async () => "order");
    const r = await m.guard.recordReceipt(
      receipt(w.merchant.privateKey, RECEIPT_ISS_M, { status: "Error", reference: p.checkoutReference, error: "out_of_stock", error_description: "x" }),
    );
    expect(r).toMatchObject({ released: true });
    const sent: string[] = [];
    await expect(p.presentPayment(async (c) => sent.push(c))).rejects.toMatchObject({ code: "PAIR_RELEASED" });
    await expect(p.presentPayment(async (c) => sent.push(c))).rejects.toMatchObject({ code: "PAIR_RELEASED" });
    expect(sent).toHaveLength(0);
  });

  it("a Success payment receipt for a released pair is flagged as a conflict and the pair counts again", async () => {
    const w = world();
    const m = makeGuard(w, { guardian: fakeGuardian({ decide: () => "ASK" }) });
    const p = await m.guard.pay(payInput(w));
    await p.presentPayment(async () => "token");
    expect(await m.guard.recordReceipt(errorPayment(w, p.paymentReference))).toMatchObject({ released: true });
    const late = await m.guard.recordReceipt(successPayment(w, p.paymentReference));
    expect(late).toMatchObject({ status: "Success", conflict: true });
    const [e] = await m.guard.ledgerEntries();
    expect(e).toMatchObject({ state: "complete", conflict: true });
    expect(m.guard.records().filter((r) => r.event === "receipt").at(-1)?.receipt).toMatchObject({ conflict: true });
    // An Error after Success never releases.
    expect(await m.guard.recordReceipt(errorPayment(w, p.paymentReference))).toMatchObject({ released: false, conflict: true });
  });

  it("receipts are tied to the issuer's role: a merchant key cannot sign a payment receipt, nor a processor key a checkout receipt", async () => {
    const w = world();
    const m = makeGuard(w, { guardian: fakeGuardian({ decide: () => "ASK" }) });
    const p = await m.guard.pay(payInput(w));
    await p.presentPayment(async () => "token");
    const merchantSignedPaymentError = receipt(w.merchant.privateKey, RECEIPT_ISS_M, {
      status: "Error",
      reference: p.paymentReference,
      error: "declined",
      error_description: "x",
    });
    await expect(m.guard.recordReceipt(merchantSignedPaymentError)).rejects.toMatchObject({ code: "RECEIPT_INVALID" });
    // Even claiming the processor's iss does not help: the signature is not the processor's.
    const claimingMpp = receipt(w.merchant.privateKey, RECEIPT_ISS_MPP, {
      status: "Error",
      reference: p.paymentReference,
      error: "declined",
      error_description: "x",
    });
    await expect(m.guard.recordReceipt(claimingMpp)).rejects.toMatchObject({ code: "RECEIPT_INVALID" });
    const mppSignedCheckoutError = receipt(w.mpp.privateKey, RECEIPT_ISS_MPP, {
      status: "Error",
      reference: p.checkoutReference,
      error: "out_of_stock",
      error_description: "x",
    });
    await expect(m.guard.recordReceipt(mppSignedCheckoutError)).rejects.toMatchObject({ code: "RECEIPT_INVALID" });
    expect((await m.guard.ledgerEntries())[0]!.state).toBe("presented");
  });

  it("receiptIssuerKeys must name roles", () => {
    const w = world();
    expect(() =>
      makeGuard(w, {
        guardian: fakeGuardian(),
        receiptIssuerKeys: { [RECEIPT_ISS_MPP]: [w.mpp.publicJwk] } as never,
      }),
    ).toThrow(/receiptIssuerKeys/);
  });

  it("after a verified Error receipt a new decision may sign; a forged receipt keeps the lock; Success uses the mandate up", async () => {
    const w = world();
    const guardian = fakeGuardian({ decide: askFirstUse });
    const m = makeGuard(w, { guardian });
    const input = payInput(w);
    const p = await m.guard.pay(input);
    await p.presentPayment(async () => "token");

    // Forged: signed by a key that is not the processor's.
    const forged = receipt(w.merchant2.privateKey, RECEIPT_ISS_MPP, {
      status: "Error",
      reference: p.paymentReference,
      payment_id: "p",
      error: "declined",
      error_description: "x",
    });
    await expect(m.guard.recordReceipt(forged)).rejects.toMatchObject({ code: "RECEIPT_INVALID" });
    expect((await m.guard.ledgerEntries())[0]!.state).toBe("presented");

    const r = await m.guard.recordReceipt(errorPayment(w, p.paymentReference));
    expect(r).toMatchObject({ kind: "payment", status: "Error", released: true, returnToHumanPresent: false });
    const second = await m.guard.pay({ ...input, checkoutJwt: checkoutJwt(w) });
    expect(guardian.requests.at(-1).arguments.reviewReasons).toEqual(["FIRST_USE_OF_OPEN_MANDATE"]);
    await second.presentPayment(async () => "token");
    await m.guard.recordReceipt(successPayment(w, second.paymentReference));
    await expect(m.guard.pay({ ...input, checkoutJwt: checkoutJwt(w) })).rejects.toMatchObject({ code: "MANDATE_ALREADY_USED" });
  });

  it("unresolved_constraint is an error receipt: released, and the caller is told to go back to the user", async () => {
    const w = world();
    const m = makeGuard(w, { guardian: fakeGuardian({ decide: () => "ASK" }) });
    const p = await m.guard.pay(payInput(w));
    const r = await m.guard.recordReceipt(
      receipt(w.merchant.privateKey, RECEIPT_ISS_M, {
        status: "Error",
        reference: p.checkoutReference,
        error: "unresolved_constraint",
        error_description: "The merchant needs the user.",
      }),
    );
    expect(r).toMatchObject({ kind: "checkout", status: "Error", returnToHumanPresent: true, released: true });
  });

  it("receipts that do not verify, name an unpinned issuer, an unknown reference or miss fields are refused", async () => {
    const w = world();
    const m = makeGuard(w, { guardian: fakeGuardian({ decide: () => "ASK" }) });
    const p = await m.guard.pay(payInput(w));
    const bad = [
      receipt(w.mpp.privateKey, "https://unknown.test", { status: "Success", reference: p.paymentReference }),
      successPayment(w, "c".repeat(43)),
      receipt(w.mpp.privateKey, RECEIPT_ISS_MPP, { status: "Success", reference: p.paymentReference, payment_id: "p" }),
      receipt(w.mpp.privateKey, RECEIPT_ISS_MPP, { status: "Done", reference: p.paymentReference }),
      receipt(w.mpp.privateKey, RECEIPT_ISS_MPP, { status: "Error", reference: p.paymentReference }),
      "not.a.jwt",
    ];
    for (const r of bad) await expect(m.guard.recordReceipt(r)).rejects.toMatchObject({ code: "RECEIPT_INVALID" });
    expect((await m.guard.ledgerEntries())[0]!.state).toBe("signed");
  });

  it("each signed mandate is presented once", async () => {
    const w = world();
    const m = makeGuard(w, { guardian: fakeGuardian({ decide: () => "ASK" }) });
    const p = await m.guard.pay(payInput(w));
    const sent: string[] = [];
    await p.presentPayment(async (c) => sent.push(c));
    await expect(p.presentPayment(async (c) => sent.push(c))).rejects.toMatchObject({ code: "ALREADY_PRESENTED" });
    await p.presentCheckout(async (c) => sent.push(c));
    await expect(p.presentCheckout(async (c) => sent.push(c))).rejects.toMatchObject({ code: "ALREADY_PRESENTED" });
    expect(sent).toHaveLength(2);
  });
});

describe("configuration fails closed", () => {
  it("private keys are refused as pinned keys; the agent key is not a Trusted Surface key", () => {
    const w = world();
    const priv = w.ts.privateKey.export({ format: "jwk" });
    const base = {
      guardian: fakeGuardian(),
      connectionId: CONNECTION,
      agentSigner: w.agentSigner,
      trustedSurfaceKeys: [w.ts.publicJwk],
      merchantKeys: { [MERCHANT.id]: [w.merchant.publicJwk] },
    };
    expect(() => createAp2Guard({ ...base, trustedSurfaceKeys: [priv] })).toThrow(/public keys only/);
    expect(() => createAp2Guard({ ...base, merchantKeys: { [MERCHANT_2.id]: [priv] } })).toThrow(/public keys only/);
    expect(() => createAp2Guard({ ...base, trustedSurfaceKeys: [] })).toThrow(/at least one/);
    expect(() => createAp2Guard({ ...base, trustedSurfaceKeys: [w.agent.publicJwk] })).toThrow(/agent key/);
    expect(() => createAp2Guard({ ...base, agentSigner: { publicJwk: priv, sign: async () => new Uint8Array() } })).toThrow();
    expect(() => createAp2Guard({ ...base, limits: [{ currency: "USD", askAbove: 10.5, max: 100 }] })).toThrow();
    expect(() => createAp2Guard({ ...base, limits: [{ currency: "XYZ", askAbove: 1, max: 100 }] })).toThrow();
    expect(() => createAp2Guard({ ...base, signingWindowMs: 10 ** 9 })).toThrow();
  });
});
