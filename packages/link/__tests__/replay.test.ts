// A replayed approval is refused, and one decision acts once
// (never a second spend request on one decision).
import { describe, expect, it } from "vitest";

import { createLinkGuard } from "../src/index.js";
import { CONNECTION, fakeGuardian, fakeLink, makeGuard, ops, terms, testStore } from "./helpers.js";

const creates = (link: ReturnType<typeof fakeLink>) => ops(link).filter((o) => o === "create").length;

describe("a replayed approval is refused", () => {
  it("the receipt is for an earlier request (an earlier approval on the same terms)", async () => {
    // The second request's receipt lookup is answered with the first's.
    const guardian = fakeGuardian({
      decide: () => "ASK",
      receiptOf: (id) => (id === "req_000000000002" ? "req_000000000001" : id),
    });
    const { guard, link } = makeGuard({ guardian });
    await guard.create(terms()); // req_...1, approved by a person
    await expect(guard.create(terms())).rejects.toMatchObject({ code: "RECEIPT_CHECK_FAILED" });
    expect(creates(link)).toBe(1);
  });

  it("the claim answers for another request id", async () => {
    const guardian = fakeGuardian({ decide: () => "ASK", claimAnswersFor: () => "req_999999999999" });
    const { guard, link } = makeGuard({ guardian });
    await expect(guard.create(terms())).rejects.toMatchObject({ code: "GUARDIAN_UNREACHABLE" });
    expect(creates(link)).toBe(0);
  });

  it("Guardian refuses to redeem the capability again", async () => {
    const { guard, link } = makeGuard({ guardian: fakeGuardian({ executeFails: "CAPABILITY_USED" }) });
    await expect(guard.create(terms())).rejects.toMatchObject({
      code: "EXECUTE_FAILED",
      guardianReasonCode: "CAPABILITY_USED",
    });
    expect(creates(link)).toBe(0);
  });

  it("the same decision handed out again is refused by the guard's own ledger", async () => {
    const guardian = fakeGuardian({ reuseRequestId: "req_000000000042" });
    const { guard, link } = makeGuard({ guardian });
    await guard.create(terms());
    await expect(guard.create(terms())).rejects.toMatchObject({ code: "DECISION_ALREADY_USED" });
    expect(creates(link)).toBe(1);
  });

  it("…also after a restart, with a durable store", async () => {
    const store = testStore();
    const link = fakeLink();
    const mk = () =>
      createLinkGuard({
        guardian: fakeGuardian({ reuseRequestId: "req_000000000042" }),
        connectionId: CONNECTION,
        link,
        store,
        limits: [{ currency: "usd", askAbove: 5_000, max: 20_000 }],
        claimPollIntervalMs: 2,
      });
    await mk().create(terms());
    await expect(mk().create(terms())).rejects.toMatchObject({ code: "DECISION_ALREADY_USED" });
    expect(creates(link)).toBe(1);
  });

  it("two spends racing on one replayed decision: exactly one spend request", async () => {
    const guardian = fakeGuardian({ reuseRequestId: "req_000000000042" });
    const { guard, link } = makeGuard({ guardian });
    const results = await Promise.allSettled([guard.create(terms()), guard.create(terms())]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    // Refused by the guard's ledger, or by Guardian's single-use capability.
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(["DECISION_ALREADY_USED", "EXECUTE_FAILED"]).toContain(rejected.reason.code);
    expect(creates(link)).toBe(1);
  });
});

describe("one decision, one spend request", () => {
  it("a create whose outcome is unknown is never retried; the decision is spent", async () => {
    for (const when of ["before-create", "after-create"] as const) {
      const { guard, link } = makeGuard({ link: fakeLink({ createThrows: when }) });
      const err = await guard.create(terms()).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "LINK_OUTCOME_UNKNOWN", outcomeUnknown: true });
      expect(creates(link)).toBe(1);
      expect(guard.records().some((r) => r.event === "outcome-unknown")).toBe(true);
    }
  });

  it("the create carries an idempotency key from the decision, so Link makes at most one", async () => {
    const { guard, link } = makeGuard();
    const handle = await guard.create(terms());
    const input = link.calls.find((c) => c.op === "create")!.input as { idempotencyKey: string };
    expect(input.idempotencyKey).toBe(`guardian-link-${handle.requestId}`);
  });

  it("Link returning a spend request another decision holds is refused", async () => {
    const link = fakeLink({ createReturnsId: "lsrq_test_fixed" });
    const { guard } = makeGuard({ link });
    await guard.create(terms());
    await expect(guard.create(terms())).rejects.toMatchObject({ code: "SPEND_REQUEST_REUSED" });
  });

  it("the card is read once: a second withCard is refused", async () => {
    const { guard, link } = makeGuard({ link: fakeLink({ personInLink: "approve" }) });
    const { spendRequestId } = await guard.spend(terms());
    await guard.withCard(spendRequestId, (c) => c.number.length);
    await expect(guard.withCard(spendRequestId, (c) => c.number)).rejects.toMatchObject({
      code: "CARD_ALREADY_READ",
    });
    expect(link.cardsRead).toBe(1);
  });

  it("two withCard calls racing: the card is read once", async () => {
    const { guard, link } = makeGuard({ link: fakeLink({ personInLink: "approve" }) });
    const { spendRequestId } = await guard.spend(terms());
    const results = await Promise.allSettled([
      guard.withCard(spendRequestId, () => 1),
      guard.withCard(spendRequestId, () => 2),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(link.cardsRead).toBe(1);
  });

  it("Link approval is requested once", async () => {
    const { guard, link } = makeGuard();
    const { spendRequestId } = await guard.spend(terms());
    await expect(guard.requestApproval(spendRequestId)).rejects.toMatchObject({ code: "WRONG_STATE" });
    expect(ops(link).filter((o) => o === "requestApproval")).toHaveLength(1);
  });

  it("only spend requests this guard created are touched", async () => {
    const { guard, link } = makeGuard();
    for (const call of [
      () => guard.requestApproval("lsrq_someone_else"),
      () => guard.withCard("lsrq_someone_else", () => 1),
      () => guard.update("lsrq_someone_else", terms()),
      () => guard.cancel("lsrq_someone_else"),
      () => guard.withCard("../etc/passwd", () => 1),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "UNKNOWN_SPEND_REQUEST" });
    }
    expect(link.calls).toHaveLength(0);
  });
});
