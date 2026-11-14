// The ledger does not grow without end: finished decisions older than the
// retention window are dropped on write, decisions in progress are kept, a
// full ledger refuses before Guardian is asked, and a replay of a dropped
// decision is still refused (by Guardian's single-use execute).
import { describe, expect, it } from "vitest";

import { fakeGuardian, fakeLink, makeGuard, ops, terms, testStore } from "./helpers.js";

const DAY = 86_400_000;
const KEY = "guardian-link:v1:ledger";
const stored = (store: ReturnType<typeof testStore>) =>
  (JSON.parse(store.data.get(KEY)!.value) as { decisions: { requestId: string; state: string }[] }).decisions;

describe("one limit per currency", () => {
  it("refuses a currency listed twice, in any case", () => {
    const usd = { currency: "usd", askAbove: 1_000, max: 5_000 } as const;
    expect(() => makeGuard({ limits: [usd, { ...usd, max: 20_000 }] })).toThrow("guardian-link: one limit per currency.");
    expect(() => makeGuard({ limits: [usd, { ...usd, currency: "USD" as never }] })).toThrow(
      "guardian-link: one limit per currency.",
    );
    expect(() =>
      makeGuard({ currencies: ["usd", "cad"], limits: [usd, { currency: "cad", askAbove: 0, max: 100 }] }),
    ).not.toThrow();
  });
});

describe("ledger retention", () => {
  it("drops finished decisions past the window and keeps those in progress", async () => {
    let now = Date.parse("2026-11-14T10:00:00Z");
    const store = testStore();
    const link = fakeLink({ personInLink: "approve" });
    const { guard } = makeGuard({ store, link, now: () => now, ledgerRetentionMs: 2 * DAY });

    const read = await guard.spend(terms()); // will be card-read (finished)
    await guard.withCard(read.spendRequestId, () => "ok");
    const canceled = await guard.create(terms()); // will be canceled (finished)
    await guard.cancel(canceled.spendRequestId);
    const open = await guard.create(terms()); // stays "created" (in progress)
    expect(stored(store).map((e) => e.state)).toEqual(["card-read", "canceled", "created"]);

    now += 3 * DAY;
    const fresh = await guard.create(terms()); // a write prunes
    expect(stored(store).map((e) => e.requestId)).toEqual([open.requestId, fresh.requestId]);

    // The kept decision still works; the dropped ones fail closed.
    await guard.requestApproval(open.spendRequestId);
    await expect(guard.withCard(read.spendRequestId, () => "again")).rejects.toMatchObject({
      code: "UNKNOWN_SPEND_REQUEST",
    });
    await expect(guard.requestApproval(canceled.spendRequestId)).rejects.toMatchObject({
      code: "UNKNOWN_SPEND_REQUEST",
    });
    expect(link.cardsRead).toBe(1);
  });

  it("keeps finished decisions inside the window", async () => {
    let now = Date.parse("2026-11-14T10:00:00Z");
    const store = testStore();
    const { guard } = makeGuard({ store, now: () => now });
    const first = await guard.create(terms());
    await guard.cancel(first.spendRequestId);
    now += 29 * DAY;
    await guard.create(terms());
    expect(stored(store).map((e) => e.requestId)).toContain(first.requestId);
  });

  it("a replay of a dropped decision is still refused, by Guardian, before Link", async () => {
    let now = Date.parse("2026-11-14T10:00:00Z");
    const store = testStore();
    const guardian = fakeGuardian({ reuseRequestId: "req_000000000042", remembersUse: true });
    const { guard, link } = makeGuard({ store, guardian, now: () => now, ledgerRetentionMs: DAY });
    const first = await guard.create(terms());
    await guard.cancel(first.spendRequestId);
    now += 2 * DAY;
    // Any write prunes; the old entry is gone from the ledger.
    const { guard: other } = makeGuard({ store, now: () => now, ledgerRetentionMs: DAY });
    await other.create(terms());
    expect(stored(store).map((e) => e.requestId)).not.toContain("req_000000000042");

    const before = ops(link).filter((o) => o === "create").length;
    await expect(guard.create(terms())).rejects.toMatchObject({
      code: "EXECUTE_FAILED",
      guardianReasonCode: "CAPABILITY_USED",
    });
    expect(ops(link).filter((o) => o === "create").length).toBe(before);
  });

  it("refuses retention and cap settings out of bounds", () => {
    for (const ledgerRetentionMs of [0, DAY - 1, 366 * DAY, DAY + 0.5]) {
      expect(() => makeGuard({ ledgerRetentionMs })).toThrow(/ledgerRetentionMs/);
    }
    for (const ledgerMaxEntries of [0, 9, 100_001, 10.5]) {
      expect(() => makeGuard({ ledgerMaxEntries })).toThrow(/ledgerMaxEntries/);
    }
    expect(() => makeGuard({ ledgerRetentionMs: DAY, ledgerMaxEntries: 10 })).not.toThrow();
  });
});

describe("ledger cap", () => {
  it("a full ledger refuses before Guardian is asked; in-progress decisions still move on", async () => {
    const store = testStore();
    const link = fakeLink({ personInLink: "approve" });
    const { guard, guardian } = makeGuard({ store, link, ledgerMaxEntries: 10 });
    const handles = [];
    for (let i = 0; i < 10; i += 1) handles.push(await guard.create(terms()));
    const asked = guardian.calls.filter((c) => c.op === "request").length;

    await expect(guard.create(terms())).rejects.toMatchObject({ code: "LEDGER_FULL" });
    expect(guardian.calls.filter((c) => c.op === "request").length).toBe(asked);

    // Open requests can still go all the way, and be canceled.
    await guard.requestApproval(handles[0]!.spendRequestId);
    await guard.waitForLinkApproval(handles[0]!.spendRequestId, { timeoutMs: 1_000 });
    expect(await guard.withCard(handles[0]!.spendRequestId, () => "ok")).toBe("ok");
    await guard.cancel(handles[1]!.spendRequestId);
    // Finished entries inside the window still count: still full.
    await expect(guard.create(terms())).rejects.toMatchObject({ code: "LEDGER_FULL" });
  });
});
