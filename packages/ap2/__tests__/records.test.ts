import { sign as cryptoSign } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { Ap2GuardRecord } from "../src/index.js";
import {
  CP_CHALLENGE,
  fakeGuardian,
  makeGuard,
  MERCHANT,
  payInput,
  receipt,
  RECEIPT_ISS_MPP,
  verifyChain,
  world,
} from "./helpers.js";

describe("what the person sees: every material term, in full", () => {
  it("the Guardian arguments carry every field of the closed pair, the checkout and the open mandates", async () => {
    const w = world();
    const guardian = fakeGuardian({ decide: () => "ASK" });
    const { guard } = makeGuard(w, { guardian });
    const longTitle = `Stoneware coffee mug, hand glazed, 350 ml, ${"speckled ".repeat(20)}finish`;
    const input = payInput(w, {
      checkout: {
        items: [{ id: "sku_mug", title: longTitle, price: 1999, quantity: 1 }],
        extra: {
          buyer: { email: "person@example.test", first_name: "Pat" },
          messages: [{ type: "info", content: "Ships in 2 days" }],
          expires_at: "2026-11-12T13:00:00Z",
          links: [
            { type: "terms_of_service", url: "https://store.example.test/terms" },
            { type: "refund_policy", url: "https://store.example.test/refunds" },
          ],
        },
      },
      extra: {
        pisp: { legal_name: "Pisp Ltd", brand_name: "Pisp", domain_name: "pisp.example.test" },
        executionDate: "2026-11-20",
        riskData: { device_score: 0.98, ip_country: "NO" },
      },
    });
    await guard.pay(input);
    const a = guardian.requests[0].arguments;
    expect(a.payment).toEqual({
      vct: "mandate.payment.1",
      transactionId: a.checkout.checkoutHash,
      payee: MERCHANT,
      paymentAmount: { amount: 1999, currency: "USD" },
      amountDisplay: "19.99 USD",
      paymentInstrument: { id: "pi_card_1", type: "card", description: "Card ending 4242" },
      pisp: { legal_name: "Pisp Ltd", brand_name: "Pisp", domain_name: "pisp.example.test" },
      executionDate: "2026-11-20",
      riskDataKeys: ["device_score", "ip_country"],
      riskDataDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(a.checkout).toMatchObject({
      vct: "mandate.checkout.1",
      id: "chk_0001",
      status: "ready_for_complete",
      currency: "USD",
      expiresAt: "2026-11-12T13:00:00Z",
      lineItems: [{ itemId: "sku_mug", title: longTitle, unitPrice: 1999, unitPriceDisplay: "19.99 USD", quantity: 1 }],
      total: 1999,
      totalDisplay: "19.99 USD",
      messages: [{ type: "info", content: "Ships in 2 days" }],
      refundTerms: "Refund terms: see https://store.example.test/refunds",
      buyerFields: ["email", "first_name"],
    });
    expect(a.checkout.totals.map((t: { type: string }) => t.type)).toEqual(["subtotal", "total"]);
    expect(a.keyBinding).toMatchObject({
      agentKeyThumbprint: expect.any(String),
      checkout: { aud: "merchant_1", nonce: expect.any(String), bindsToOpenMandate: expect.any(String) },
      payment: { aud: "credential-provider", nonce: CP_CHALLENGE.nonce },
    });
    expect(a.openMandates.payment).toMatchObject({
      vct: "mandate.payment.open.1",
      cnfThumbprint: a.keyBinding.agentKeyThumbprint,
      constraints: [
        { type: "payment.amount_range", currency: "USD", min: 0, max: 5000, maxDisplay: "50.00 USD", minDisplay: "0.00 USD" },
        { type: "payment.allowed_payees", allowed: [MERCHANT] },
        { type: "payment.reference", conditional_transaction_id: a.openMandates.checkout.sdHash },
      ],
      presets: { payee: null, paymentAmount: null },
    });
    expect(a.openMandates.checkout.constraints).toHaveLength(2);
    // Nothing shortened; PII and risk values never in the terms.
    const text = JSON.stringify(a);
    expect(text).toContain(longTitle);
    expect(text).not.toContain("person@example.test");
    expect(text).not.toContain("0.98");
    expect(text).not.toContain("…");
  });
});

describe("records never hold keys, signatures, mandates, tokens, PII or risk values", () => {
  it("over a full flow with a refusal and receipts", async () => {
    const w = world();
    const sink: Ap2GuardRecord[] = [];
    const { guard } = makeGuard(w, { guardian: fakeGuardian({ decide: () => "ASK" }), onRecord: (r) => sink.push(r) });
    const input = payInput(w, { extra: { riskData: { secret_score: 4242.4242 } }, checkout: { extra: { buyer: { email: "who@example.test" } } } });
    const p = await guard.pay(input);
    let chain = "";
    await p.presentPayment(async (c) => (chain = c));
    await expect(p.presentPayment(async () => 0)).rejects.toBeTruthy();
    await guard.recordReceipt(
      receipt(w.mpp.privateKey, RECEIPT_ISS_MPP, {
        status: "Success",
        reference: p.paymentReference,
        payment_id: "pay_9",
        psp_confirmation_id: "psp_9",
        network_confirmation_id: "net_9",
      }),
    );
    const all = JSON.stringify(guard.records());
    expect(sink).toHaveLength(guard.records().length);
    const sig = chain.split("~~")[1]!.split("~")[0]!.split(".")[2]!;
    for (const secret of [
      sig,
      chain,
      input.openPaymentMandate,
      input.openCheckoutMandate.split("~")[1]!,
      input.checkoutJwt,
      "who@example.test",
      "4242.4242",
      w.agent.privateKey.export({ format: "jwk" }).d as string,
      "cap_req_",
    ]) {
      expect(all).not.toContain(secret);
    }
    expect(guard.records().map((r) => r.event)).toEqual(["redeemed", "signed", "presented", "refused", "receipt"]);
    expect(guard.records().at(-1)!.receipt).toMatchObject({ kind: "payment", status: "Success", paymentId: "pay_9", pspConfirmationId: "psp_9" });
  });
});

describe("not governed: the agent key used outside the guard", () => {
  it("code that holds the key can sign a closed mandate the guard never saw (documented bypass)", async () => {
    const w = world();
    const { guard } = makeGuard(w, { guardian: fakeGuardian({ decide: () => ({ deny: "DENIED" }) }) });
    const input = payInput(w);
    await expect(guard.pay(input)).rejects.toMatchObject({ code: "GUARDIAN_DENIED" });
    // The guard refused; but the private key itself is not governed:
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const disclosure = b64(["c2FsdHNhbHRzYWx0c2FsdA", { vct: "mandate.payment.1", note: "outside the guard" }]);
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256").update(disclosure).digest("base64url");
    const sdHash = createHash("sha256").update(input.openPaymentMandate).digest("base64url");
    const si = `${b64({ alg: "ES256", typ: "kb+sd-jwt" })}.${b64({
      _sd_alg: "sha-256",
      aud: CP_CHALLENGE.aud,
      nonce: CP_CHALLENGE.nonce,
      iat: 1,
      sd_hash: sdHash,
      delegate_payload: [{ "...": digest }],
    })}`;
    const sig = cryptoSign("sha256", Buffer.from(si), { key: w.agent.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    const chain = `${input.openPaymentMandate.slice(0, -1)}~~${si}.${sig}~${disclosure}~`;
    expect(verifyChain(chain, w.ts.publicJwk, CP_CHALLENGE).closed).toMatchObject({ note: "outside the guard" });
    expect(guard.records().some((r) => r.event === "signed")).toBe(false);
  });
});
