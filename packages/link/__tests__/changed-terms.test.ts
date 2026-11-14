// A changed amount, merchant, currency or item after
// approval is refused, wherever the change comes in.
import { describe, expect, it } from "vitest";

import type { LinkSpendRequestView } from "../src/index.js";
import { fakeGuardian, fakeLink, makeGuard, ops, terms } from "./helpers.js";

type Change = {
  name: string;
  /** The change, as Link would show it on the spend request. */
  link: Partial<LinkSpendRequestView>;
  /** The same change, in the arguments a receipt says were approved. */
  args: (a: Record<string, unknown>) => Record<string, unknown>;
};

const CHANGES: Change[] = [
  { name: "amount", link: { amount: 4_500 }, args: (a) => ({ ...a, amount: 4_500 }) },
  { name: "merchant name", link: { merchantName: "Other Shop" }, args: (a) => ({ ...a, merchantName: "Other Shop" }) },
  {
    name: "merchant URL",
    link: { merchantUrl: "https://other.example" },
    args: (a) => ({ ...a, merchantUrl: "https://other.example" }),
  },
  { name: "currency", link: { currency: "cad" }, args: (a) => ({ ...a, currency: "cad" }) },
  {
    name: "item",
    link: { lineItems: [{ name: "Working in Public", quantity: 2, unitAmount: 3500 }] },
    args: (a) => ({ ...a, lineItems: [{ name: "Working in Public", quantity: 2, unitAmount: 3500 }] }),
  },
  {
    name: "total",
    link: { totals: [{ type: "total", displayText: "Total", amount: 4_500 }] },
    args: (a) => ({ ...a, totals: [{ type: "total", displayText: "Total", amount: 4_500 }] }),
  },
];

describe.each(CHANGES)("a changed $name after approval is refused", (change) => {
  it("in the approval itself: the receipt shows other arguments, so nothing is created", async () => {
    const guardian = fakeGuardian({ decide: () => "ASK", receiptArguments: change.args });
    const { guard, link } = makeGuard({ guardian });
    await expect(guard.create(terms())).rejects.toMatchObject({ code: "RECEIPT_CHECK_FAILED" });
    expect(ops(link)).not.toContain("create");
  });

  it("at create: Link created other terms, so it is canceled and no card is read", async () => {
    const link = fakeLink({ createAs: () => change.link });
    const { guard } = makeGuard({ link });
    const err = await guard.create(terms()).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "TERMS_CHANGED" });
    const id = (err as { spendRequestId: string }).spendRequestId;
    expect(link.requests.get(id)!.status).toBe("canceled");
    await expect(guard.requestApproval(id)).rejects.toMatchObject({ code: "WRONG_STATE" });
    await expect(guard.withCard(id, () => "x")).rejects.toMatchObject({ code: "WRONG_STATE" });
    expect(link.cardsRead).toBe(0);
  });

  it("before Link approval is requested: changed outside the guard, so it is canceled", async () => {
    const { guard, link } = makeGuard();
    const { spendRequestId } = await guard.create(terms());
    link.changeOutside(spendRequestId, change.link);
    await expect(guard.requestApproval(spendRequestId)).rejects.toMatchObject({ code: "TERMS_CHANGED" });
    expect(ops(link)).not.toContain("requestApproval");
    expect(link.requests.get(spendRequestId)!.status).toBe("canceled");
  });

  it("after Link approved: changed outside the guard, so the card is never read", async () => {
    const { guard, link } = makeGuard({ link: fakeLink({ personInLink: "approve" }) });
    const { spendRequestId } = await guard.spend(terms());
    link.changeOutside(spendRequestId, change.link);
    let ran = false;
    await expect(
      guard.withCard(spendRequestId, () => {
        ran = true;
      }),
    ).rejects.toMatchObject({ code: "TERMS_CHANGED" });
    expect(ran).toBe(false);
    expect(link.cardsRead).toBe(0);
    expect(link.requests.get(spendRequestId)!.status).toBe("canceled");
  });

  it("with the card: Link returns the card for other terms, so the card is not handed over", async () => {
    const { guard, link } = makeGuard({
      link: fakeLink({ personInLink: "approve", cardRequestAs: () => change.link }),
    });
    const { spendRequestId } = await guard.spend(terms());
    let ran = false;
    await expect(
      guard.withCard(spendRequestId, () => {
        ran = true;
      }),
    ).rejects.toMatchObject({ code: "TERMS_CHANGED" });
    expect(ran).toBe(false);
  });

  it("while waiting for Link approval: changed outside the guard, so the wait is refused", async () => {
    const { guard, link } = makeGuard();
    const { spendRequestId } = await guard.spend(terms());
    link.changeOutside(spendRequestId, change.link);
    link.approve(spendRequestId);
    await expect(guard.waitForLinkApproval(spendRequestId, { timeoutMs: 50 })).rejects.toMatchObject({
      code: "TERMS_CHANGED",
    });
  });
});

describe("the decided terms are a frozen copy", () => {
  it("changing the caller's object while a person decides does not change what is created", async () => {
    const guardian = fakeGuardian({ decide: () => "ASK", claimsBeforeDecision: 3 });
    const { guard, link } = makeGuard({ guardian });
    const mine = structuredClone(terms()) as { amount: number; merchantName: string };
    const pending = guard.create(mine as never);
    mine.amount = 9_999;
    mine.merchantName = "Other Shop";
    const handle = await pending;
    expect(handle.terms.amount).toBe(3500);
    expect(link.calls.find((c) => c.op === "create")!.input).toMatchObject({
      amount: 3500,
      merchantName: "Stripe Press",
    });
    expect(Object.isFrozen(handle.terms)).toBe(true);
  });
});
