import { describe, expect, it } from "vitest";

import { SPEND_ABOVE_CAP_TOOL } from "../src/index.js";
import { CONTEXT, fakeGuardian, fakeLink, makeGuard, ops, orderLog, terms, testStore } from "./helpers.js";

const NEW = terms({
  amount: 4_200,
  merchantUrl: "https://press.stripe.com/working-in-public",
  lineItems: [{ name: "Working in Public", quantity: 1, unitAmount: 4_200 }],
  totals: [{ type: "total", displayText: "Total", amount: 4_200 }],
});

describe("spend-request update is gated", () => {
  it("an update is a new decision on the full new terms, always for a person, before Link is called", async () => {
    const guardian = fakeGuardian({ decide: (inv) => ((inv as { toolName: string }).toolName === "link.spend" ? "ALLOW" : "ASK") });
    const { guard, link } = makeGuard({ guardian });
    const first = await guard.create(terms());
    const order = orderLog();
    const updated = await guard.update(first.spendRequestId, NEW);

    expect(updated.requestId).not.toBe(first.requestId);
    expect(updated.tool).toBe(SPEND_ABOVE_CAP_TOOL);
    expect(updated.approvedByPerson).toBe(true);
    const sent = guardian.requests[1];
    expect(sent.arguments).toMatchObject({
      amount: 4_200,
      merchantUrl: "https://press.stripe.com/working-in-public",
      spendRequestId: first.spendRequestId,
      reviewReasons: ["UPDATES_SPEND_REQUEST"],
    });
    expect(order.indexOf("guardian.receipt")).toBeLessThan(order.indexOf("link.update"));
    expect(link.requests.get(first.spendRequestId)!.amount).toBe(4_200);

    // Link approval and the card are checked against the new decision's terms.
    await guard.requestApproval(first.spendRequestId);
    link.approve(first.spendRequestId);
    expect(await guard.withCard(first.spendRequestId, () => "ok")).toBe("ok");
  });

  it("Guardian says no: Link is not updated", async () => {
    const guardian = fakeGuardian({
      decide: (inv) => ((inv as { toolName: string }).toolName === "link.spend" ? "ALLOW" : { deny: "POLICY_DENIED" }),
    });
    const { guard, link } = makeGuard({ guardian });
    const { spendRequestId } = await guard.create(terms());
    await expect(guard.update(spendRequestId, NEW)).rejects.toMatchObject({ code: "GUARDIAN_DENIED" });
    expect(ops(link)).not.toContain("update");
    // The original decision still stands.
    await guard.requestApproval(spendRequestId);
  });

  it("a rule ALLOW is not enough for an update", async () => {
    const { guard, link } = makeGuard();
    const { spendRequestId } = await guard.create(terms());
    await expect(guard.update(spendRequestId, NEW)).rejects.toMatchObject({ code: "PERSON_APPROVAL_REQUIRED" });
    expect(ops(link)).not.toContain("update");
  });

  it("after an update the earlier decision no longer counts: Link must hold the new terms", async () => {
    const guardian = fakeGuardian({ decide: (inv) => ((inv as { toolName: string }).toolName === "link.spend" ? "ALLOW" : "ASK") });
    const { guard, link } = makeGuard({ guardian, link: fakeLink({ personInLink: "approve" }) });
    const { spendRequestId } = await guard.create(terms());
    await guard.update(spendRequestId, NEW);
    // Someone sets the request back to the first decision's terms.
    link.changeOutside(spendRequestId, {
      amount: 3500,
      merchantUrl: "https://press.stripe.com",
      lineItems: [{ name: "Working in Public", quantity: 1, unitAmount: 3500 }],
      totals: [{ type: "total", displayText: "Total", amount: 3500 }],
    });
    await expect(guard.requestApproval(spendRequestId)).rejects.toMatchObject({ code: "TERMS_CHANGED" });
  });

  it("Link updated to other terms than decided: refused and canceled", async () => {
    const guardian = fakeGuardian({ decide: (inv) => ((inv as { toolName: string }).toolName === "link.spend" ? "ALLOW" : "ASK") });
    const link = fakeLink({ updateAs: () => ({ amount: 4_900 }) });
    const { guard } = makeGuard({ guardian, link });
    const { spendRequestId } = await guard.create(terms());
    await expect(guard.update(spendRequestId, NEW)).rejects.toMatchObject({ code: "TERMS_CHANGED" });
    expect(link.requests.get(spendRequestId)!.status).toBe("canceled");
  });

  it("merchant name or context cannot be updated (Link cannot); refused before Guardian", async () => {
    const { guard, guardian, link } = makeGuard();
    const { spendRequestId } = await guard.create(terms());
    const before = guardian.calls.length;
    await expect(guard.update(spendRequestId, terms({ merchantName: "Other Shop" }))).rejects.toMatchObject({
      code: "UPDATE_NOT_SUPPORTED",
    });
    await expect(guard.update(spendRequestId, terms({ context: `${CONTEXT} Also gift-wrap it.` }))).rejects.toMatchObject({
      code: "UPDATE_NOT_SUPPORTED",
    });
    expect(guardian.calls.length).toBe(before);
    expect(ops(link)).not.toContain("update");
  });

  it("no update once Link approval was requested", async () => {
    const { guard, guardian } = makeGuard();
    const { spendRequestId } = await guard.spend(terms());
    const before = guardian.calls.length;
    await expect(guard.update(spendRequestId, NEW)).rejects.toMatchObject({ code: "WRONG_STATE" });
    expect(guardian.calls.length).toBe(before);
  });

  it("the request changed outside the guard before the update: refused, no new decision", async () => {
    const { guard, guardian, link } = makeGuard();
    const { spendRequestId } = await guard.create(terms());
    link.changeOutside(spendRequestId, { amount: 100 });
    const before = guardian.calls.length;
    await expect(guard.update(spendRequestId, NEW)).rejects.toMatchObject({ code: "TERMS_CHANGED" });
    expect(guardian.calls.length).toBe(before);
  });
});

describe("a Link approval policy means no spend", () => {
  it("a policy exists: refused before Guardian is asked; nothing is created", async () => {
    const { guard, guardian, link } = makeGuard({ link: fakeLink({ policy: "present" }) });
    await expect(guard.create(terms())).rejects.toMatchObject({ code: "LINK_APPROVAL_POLICY_PRESENT" });
    expect(guardian.calls).toHaveLength(0);
    expect(ops(link)).toEqual(["approvalPolicy"]);
  });

  it("the policy cannot be read: refused the same way", async () => {
    for (const policy of ["unknown", "throw"] as const) {
      const { guard, guardian, link } = makeGuard({ link: fakeLink({ policy }) });
      await expect(guard.create(terms())).rejects.toMatchObject({ code: "LINK_APPROVAL_POLICY_UNKNOWN" });
      expect(guardian.calls).toHaveLength(0);
      expect(ops(link)).not.toContain("create");
    }
  });

  it("a policy appears while a person decides: refused before create", async () => {
    const link = fakeLink();
    const guardian = fakeGuardian({ decide: () => "ASK" });
    const origClaim = guardian.claim.bind(guardian);
    guardian.claim = async (id) => {
      link.setPolicy("present");
      return origClaim(id);
    };
    const { guard } = makeGuard({ guardian, link });
    await expect(guard.create(terms())).rejects.toMatchObject({ code: "LINK_APPROVAL_POLICY_PRESENT" });
    expect(ops(link)).not.toContain("create");
  });

  it("a policy appears before Link approval is requested: refused", async () => {
    const { guard, link } = makeGuard();
    const { spendRequestId } = await guard.create(terms());
    link.setPolicy("present");
    await expect(guard.requestApproval(spendRequestId)).rejects.toMatchObject({
      code: "LINK_APPROVAL_POLICY_PRESENT",
    });
    expect(ops(link)).not.toContain("requestApproval");
  });

  it("Link approves the request at create (no person): canceled and refused", async () => {
    const link = fakeLink({ createdStatus: "approved" });
    const { guard } = makeGuard({ link });
    const err = await guard.create(terms()).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "LINK_APPROVAL_POLICY_PRESENT" });
    const id = (err as { spendRequestId: string }).spendRequestId;
    expect(link.requests.get(id)!.status).toBe("canceled");
    await expect(guard.withCard(id, () => 1)).rejects.toMatchObject({ code: "WRONG_STATE" });
  });
});

describe("Link's own approval", () => {
  it("waits for the person in Link, then the card can be read once", async () => {
    const { guard, link } = makeGuard();
    const { spendRequestId } = await guard.spend(terms());
    setTimeout(() => link.approve(spendRequestId), 10);
    await guard.waitForLinkApproval(spendRequestId, { timeoutMs: 2_000 });
    expect(await guard.withCard(spendRequestId, (c) => c.expYear)).toBe(2030);
  });

  it("the card is not read before Link approved", async () => {
    const { guard, link } = makeGuard();
    const { spendRequestId } = await guard.spend(terms());
    await expect(guard.withCard(spendRequestId, () => 1)).rejects.toMatchObject({ code: "LINK_NOT_APPROVED" });
    expect(ops(link)).not.toContain("readCard");
    // Still readable once approved: the refusal spent nothing.
    link.approve(spendRequestId);
    expect(await guard.withCard(spendRequestId, () => "ok")).toBe("ok");
  });

  it("denied in Link: refused, and the decision is final so it frees its ledger slot", async () => {
    const store = testStore();
    const { guard } = makeGuard({ store, link: fakeLink({ personInLink: "deny" }) });
    const { spendRequestId } = await guard.spend(terms());
    await expect(guard.waitForLinkApproval(spendRequestId, { timeoutMs: 50 })).rejects.toMatchObject({
      code: "LINK_NOT_APPROVED",
    });
    const decisions = (
      JSON.parse(store.data.get("guardian-link:v1:ledger")!.value) as { decisions: { state: string }[] }
    ).decisions;
    expect(decisions.map((e) => e.state)).toEqual(["refused"]);
    await expect(guard.withCard(spendRequestId, () => 1)).rejects.toMatchObject({ code: "WRONG_STATE" });
  });

  it("no answer in Link in time: refused", async () => {
    const { guard } = makeGuard();
    const { spendRequestId } = await guard.spend(terms());
    await expect(guard.waitForLinkApproval(spendRequestId, { timeoutMs: 20 })).rejects.toMatchObject({
      code: "LINK_APPROVAL_TIMEOUT",
    });
  });
});
