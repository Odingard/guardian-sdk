import { describe, expect, it } from "vitest";

import { SPEND_ABOVE_CAP_TOOL, SPEND_TOOL } from "../src/index.js";
import { fakeGuardian, fakeLink, makeGuard, ops, orderLog, priced, terms } from "./helpers.js";

describe("Guardian decides before the spend request exists", () => {
  it("ALLOW under the cap: one test-mode spend request with exactly the decided terms", async () => {
    const order = orderLog();
    const { guard, guardian, link } = makeGuard();
    const handle = await guard.create(terms());
    expect(handle.tool).toBe(SPEND_TOOL);
    expect(handle.approvedByPerson).toBe(false);

    // Guardian decided and redeemed before Link was asked to create anything.
    expect(order.indexOf("guardian.request")).toBeLessThan(order.indexOf("link.create"));
    expect(order.indexOf("guardian.execute")).toBeLessThan(order.indexOf("link.create"));
    expect(ops(link).filter((o) => o === "create")).toHaveLength(1);

    const created = link.calls.find((c) => c.op === "create")!.input as Record<string, unknown>;
    expect(created).toMatchObject({
      test: true,
      requestApproval: false,
      credentialType: "card",
      merchantName: "Stripe Press",
      merchantUrl: "https://press.stripe.com",
      amount: 3500,
      currency: "usd",
      lineItems: [{ name: "Working in Public", quantity: 1, unitAmount: 3500 }],
      totals: [{ type: "total", displayText: "Total", amount: 3500 }],
      idempotencyKey: `guardian-link-${handle.requestId}`,
    });

    const sent = guardian.requests[0];
    expect(sent).toMatchObject({ action: "tool.invoke", toolName: SPEND_TOOL });
    expect(sent.arguments).toMatchObject({
      merchantName: "Stripe Press",
      merchantUrl: "https://press.stripe.com",
      merchantHost: "press.stripe.com",
      amount: 3500,
      currency: "usd",
      amountDisplay: "35.00 USD",
      credentialType: "card",
      linkMode: "test",
      payeeEnforcedByLink: false,
      spendRequestId: null,
      reviewReasons: [],
    });
    expect(guard.records().map((r) => r.event)).toEqual(["created"]);
  });

  it("above askAbove: the above-cap tool, a person approves, the receipt is checked, then one create", async () => {
    const guardian = fakeGuardian({ decide: () => "ASK" });
    const { guard, link } = makeGuard({ guardian });
    const order = orderLog();
    const handle = await guard.create(
      terms({
        amount: 12_000,
        lineItems: [{ name: "Boxed set", quantity: 2, unitAmount: 6_000 }],
        totals: [{ type: "total", displayText: "Total", amount: 12_000 }],
      }),
    );
    expect(handle.tool).toBe(SPEND_ABOVE_CAP_TOOL);
    expect(handle.approvedByPerson).toBe(true);
    expect(guardian.requests[0].arguments.reviewReasons).toEqual(["ABOVE_ASK_ABOVE"]);
    expect(order.indexOf("guardian.receipt")).toBeLessThan(order.indexOf("link.create"));
    expect(ops(link).filter((o) => o === "create")).toHaveLength(1);
  });

  it("above cap: a rule ALLOW is not enough; nothing is created", async () => {
    const { guard, link } = makeGuard();
    await expect(
      guard.create(priced(9_000)),
    ).rejects.toMatchObject({ code: "PERSON_APPROVAL_REQUIRED" });
    expect(ops(link)).not.toContain("create");
  });

  it("a currency with no cap always needs a person", async () => {
    const { guard, guardian } = makeGuard({
      currencies: ["usd", "cad"],
      guardian: fakeGuardian({ decide: () => "ASK" }),
    });
    await guard.create(terms({ currency: "CAD" }));
    expect(guardian.requests[0].toolName).toBe(SPEND_ABOVE_CAP_TOOL);
    expect(guardian.requests[0].arguments).toMatchObject({ currency: "cad", reviewReasons: ["NO_CAP_FOR_CURRENCY"] });
  });

  it("DENY, a person's no, or no answer in time: nothing reaches Link", async () => {
    for (const guardian of [
      fakeGuardian({ decide: () => ({ deny: "POLICY_DENIED" }) }),
      fakeGuardian({ decide: () => "ASK", person: "deny" }),
    ]) {
      const { guard, link } = makeGuard({ guardian });
      await expect(guard.create(terms())).rejects.toMatchObject({ code: "GUARDIAN_DENIED" });
      expect(ops(link)).not.toContain("create");
    }
    const { guard, link } = makeGuard({
      guardian: fakeGuardian({ decide: () => "ASK", person: "never" }),
      requestTtlMs: 30,
    });
    await expect(guard.create(terms())).rejects.toMatchObject({ code: "APPROVAL_TIMEOUT" });
    expect(ops(link)).not.toContain("create");
  });

  it("above the local max or Link's own limit: refused before Guardian is asked", async () => {
    const { guard, guardian, link } = makeGuard();
    await expect(
      guard.create(priced(30_000)),
    ).rejects.toMatchObject({ code: "ABOVE_MAX" });
    await expect(
      guard.create(priced(50_001)),
    ).rejects.toMatchObject({ code: "ABOVE_LINK_LIMIT" });
    expect(guardian.calls).toHaveLength(0);
    expect(ops(link)).toEqual([]);
  });

  it("terms it cannot read exactly are refused before Guardian is asked", async () => {
    const { guard, guardian } = makeGuard();
    const bad: [Record<string, unknown>, string][] = [
      [{ amount: 35.5 }, "INVALID_TERMS"],
      [{ amount: "3500" }, "INVALID_TERMS"],
      [{ currency: "jpy" }, "CURRENCY_NOT_ENABLED"],
      [{ currency: "cad" }, "CURRENCY_NOT_ENABLED"],
      [{ merchantUrl: "http://press.stripe.com" }, "INVALID_TERMS"],
      [{ merchantUrl: "https://user:pw@press.stripe.com" }, "INVALID_TERMS"],
      [{ merchantName: "--approve" }, "INVALID_TERMS"],
      [{ merchantName: " Stripe Press" }, "INVALID_TERMS"],
      [{ merchantName: "Stripe‮Press" }, "INVALID_TERMS"],
      [{ context: "too short" }, "INVALID_TERMS"],
      [{ lineItems: [] }, "INVALID_TERMS"],
      [{ lineItems: [{ name: "a,unit_amount:1", quantity: 1, unitAmount: 3500 }] }, "INVALID_TERMS"],
      [{ lineItems: [{ name: "Book", quantity: 1, unitAmount: 3500, sku: "x" }] }, "INVALID_TERMS"],
      [{ totals: [{ type: "subtotal", displayText: "Subtotal", amount: 3500 }] }, "TOTAL_MISMATCH"],
      [{ totals: [{ type: "total", displayText: "Total", amount: 3400 }] }, "TOTAL_MISMATCH"],
      [{ totals: [{ type: "bogus", displayText: "Total", amount: 3500 }] }, "INVALID_TERMS"],
      [{ extra: true }, "INVALID_TERMS"],
    ];
    for (const [patch, code] of bad) {
      await expect(guard.create(terms(patch as never))).rejects.toMatchObject({ code });
    }
    expect(guardian.calls).toHaveLength(0);
  });

  it("the guard holds the adapter: it is not reachable from the guard object", () => {
    const link = fakeLink();
    const { guard } = makeGuard({ link });
    expect(Object.values(guard)).not.toContain(link);
    expect(JSON.stringify(guard)).not.toContain("createSpendRequest");
  });
});
