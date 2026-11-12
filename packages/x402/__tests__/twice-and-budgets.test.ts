import { describe, expect, it } from "vitest";

import { guardedFetch } from "../src/fetch.js";
import { createX402Guard } from "../src/index.js";
import {
  accept,
  CONNECTION,
  fakeGuardian,
  fakeServer,
  makeGuard,
  paymentRequired,
  SEPOLIA,
  testStore,
  testWallet,
  USDC_SEPOLIA,
} from "./helpers.js";

const URL_A = "https://api.example.test/item";
const tools = (g: ReturnType<typeof fakeGuardian>) =>
  g.requests.map((r) => (r as { toolName: string }).toolName);
const serve = (amount = "10000", settle?: Parameters<typeof fakeServer>[0]["settle"]) =>
  fakeServer({ terms: (url) => paymentRequired(url, [accept({ amount })]), ...(settle ? { settle } : {}) });

function recoverOnce(guard: ReturnType<typeof makeGuard>["guard"]) {
  let n = 0;
  guard.client.onPaymentResponse(async () => {
    n += 1;
    return n === 1 ? { recovered: true } : undefined;
  });
}

describe("paying twice", () => {
  it("fetch recovered retry: a fresh decision, needs a person while the first authorization is live, both counted", async () => {
    const guardian = fakeGuardian({
      decide: (inv) => ((inv as { toolName: string }).toolName === "x402.pay" ? "ALLOW" : "ASK"),
      person: "approve",
    });
    const { guard, wallet } = makeGuard({ guardian });
    recoverOnce(guard);
    const s = serve();
    expect((await guardedFetch(guard, s.fetch)(URL_A)).status).toBe(200);
    expect(tools(guardian)).toEqual(["x402.pay", "x402.pay.above_cap"]);
    const second = guardian.requests[1] as { arguments: { reviewReasons: string[] } };
    expect(second.arguments.reviewReasons).toContain("LIVE_AUTHORIZATION_FOR_REQUEST");
    expect(wallet.signed).toHaveLength(2);
    expect(await guard.liveAuthorizations()).toHaveLength(2);
  });

  it("fetch recovered retry: a rule ALLOW is not enough for the second payment", async () => {
    const guardian = fakeGuardian({ decide: () => "ALLOW" });
    const { guard, wallet } = makeGuard({ guardian });
    recoverOnce(guard);
    await expect(guardedFetch(guard, serve().fetch)(URL_A)).rejects.toThrow(/PERSON_APPROVAL_REQUIRED/);
    expect(tools(guardian)).toEqual(["x402.pay", "x402.pay.above_cap"]);
    expect(wallet.signed).toHaveLength(1);
  });

  it("fetch recovered retry whose second 402 names another resource on the host still needs a person", async () => {
    const guardian = fakeGuardian({ decide: () => "ALLOW" });
    const { guard, wallet } = makeGuard({ guardian });
    recoverOnce(guard);
    const s = fakeServer({
      terms: (url, attempt) => paymentRequired(attempt === 1 ? url : `${url}?again=1`, [accept()]),
    });
    await expect(guardedFetch(guard, s.fetch)(URL_A)).rejects.toThrow(/PERSON_APPROVAL_REQUIRED/);
    expect(tools(guardian)).toEqual(["x402.pay", "x402.pay.above_cap"]);
    expect(wallet.signed).toHaveLength(1);
  });

  it('"Payment already attempted" in fetch is recorded as signed, not sent, and stays live', async () => {
    const guardian = fakeGuardian();
    const { guard, wallet } = makeGuard({ guardian });
    const s = serve();
    await expect(
      guardedFetch(guard, s.fetch)(URL_A, { headers: { "PAYMENT-SIGNATURE": "not-a-payment" } }),
    ).rejects.toThrow("Payment already attempted");
    expect(wallet.signed).toHaveLength(1);
    expect(s.paid).toHaveLength(0);
    expect(guard.records().some((r) => r.event === "signed-not-sent")).toBe(true);
    const live = await guard.liveAuthorizations();
    expect(live).toHaveLength(1);
    expect(live[0]!.sent).toBe("not-sent");
    // The next payment for the same request needs a person.
    const guardian2Calls = guardian.requests.length;
    await expect(guardedFetch(guard, s.fetch)(URL_A)).rejects.toThrow(/PERSON_APPROVAL_REQUIRED/);
    expect(tools(guardian)[guardian2Calls]).toBe("x402.pay.above_cap");
  });

  it("after a restart with a durable store, a payment for the same request while one is live needs a person", async () => {
    const store = testStore();
    const wallet = testWallet();
    const guardian = fakeGuardian({ decide: () => "ALLOW" });
    const first = makeGuard({ guardian, store }, wallet).guard;
    expect((await guardedFetch(first, serve().fetch)(URL_A)).status).toBe(200);

    const restarted = makeGuard({ guardian, store }, wallet).guard; // same store, new process
    await expect(guardedFetch(restarted, serve().fetch)(URL_A)).rejects.toThrow(/PERSON_APPROVAL_REQUIRED/);
    expect(tools(guardian)).toEqual(["x402.pay", "x402.pay.above_cap"]);
    // Another request is not a repeat.
    expect((await guardedFetch(restarted, serve().fetch)(`${URL_A}/other`)).status).toBe(200);
  });

  it("with no store, any payment within maxTimeoutSeconds of start needs a person", async () => {
    const guardian = fakeGuardian({ decide: () => "ALLOW" });
    const wallet = testWallet();
    const base = {
      guardian,
      connectionId: CONNECTION,
      signer: wallet.signer,
      limits: [{ network: SEPOLIA, asset: USDC_SEPOLIA, askAbove: "50000", max: "500000" }] as const,
    } as const;
    const fresh = createX402Guard(base);
    await expect(guardedFetch(fresh, serve().fetch)(URL_A)).rejects.toThrow(/PERSON_APPROVAL_REQUIRED/);
    expect(
      (guardian.requests[0] as { arguments: { reviewReasons: string[] } }).arguments.reviewReasons,
    ).toContain("RECENT_START_WITHOUT_STORE");

    const started = Date.now();
    let clock = started;
    const later = createX402Guard({ ...base, now: () => clock });
    clock = started + 301_000; // past the 300 s limit
    expect((await guardedFetch(later, serve().fetch)(URL_A)).status).toBe(200);

    // The window follows the guard's configured maxTimeoutSecondsLimit.
    let c2 = Date.now();
    const t0 = c2;
    const short = createX402Guard({ ...base, maxTimeoutSecondsLimit: 60, now: () => c2 });
    c2 = t0 + 59_000;
    await expect(guardedFetch(short, serve().fetch)(`${URL_A}/short`)).rejects.toThrow(/PERSON_APPROVAL_REQUIRED/);
    c2 = t0 + 61_000;
    expect((await guardedFetch(short, serve().fetch)(`${URL_A}/short2`)).status).toBe(200);
  });
});

describe("budgets", () => {
  const budget = (limit: string) => [{ network: SEPOLIA, asset: USDC_SEPOLIA, period: "month" as const, limit }];

  it("budgets cannot be enabled without a store", () => {
    expect(() =>
      createX402Guard({
        guardian: fakeGuardian(),
        connectionId: CONNECTION,
        signer: testWallet().signer,
        budgets: budget("1"),
      }),
    ).toThrow(/durable/);
  });

  it("two payments that together exceed the daily limit: the second is refused before Guardian is asked", async () => {
    const guardian = fakeGuardian();
    const { guard } = makeGuard({
      guardian,
      budgets: [{ network: SEPOLIA, asset: USDC_SEPOLIA, period: "day", limit: "15000" }],
    });
    expect((await guardedFetch(guard, serve().fetch)(URL_A)).status).toBe(200);
    await expect(guardedFetch(guard, serve().fetch)(`${URL_A}/2`)).rejects.toThrow(/BUDGET_EXCEEDED/);
    expect(guardian.requests).toHaveLength(1);
  });

  it("two concurrent payments cannot both reserve the last amount", async () => {
    const guardian = fakeGuardian();
    const { guard, wallet } = makeGuard({ guardian, budgets: budget("10000") });
    const pay = guardedFetch(guard, serve().fetch);
    const results = await Promise.allSettled([pay(URL_A), pay(`${URL_A}/2`)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/BUDGET_EXCEEDED/);
    expect(wallet.signed).toHaveLength(1);
  });

  it("a store failure refuses the payment", async () => {
    const store = testStore();
    const guardian = fakeGuardian();
    const { guard, wallet } = makeGuard({ guardian, store, budgets: budget("100000") });
    store.failing = true;
    await expect(guardedFetch(guard, serve().fetch)(URL_A)).rejects.toThrow(/STORE_UNAVAILABLE/);
    expect(guardian.calls).toHaveLength(0);
    expect(wallet.signed).toHaveLength(0);
  });

  it("a restart with the same store keeps the spent total", async () => {
    const store = testStore();
    const wallet = testWallet();
    const guardian = fakeGuardian();
    const a = makeGuard({ guardian, store, budgets: budget("15000") }, wallet).guard;
    expect((await guardedFetch(a, serve().fetch)(URL_A)).status).toBe(200);
    const b = makeGuard({ guardian, store, budgets: budget("15000") }, wallet).guard;
    await expect(guardedFetch(b, serve().fetch)(`${URL_A}/2`)).rejects.toThrow(/BUDGET_EXCEEDED/);
  });

  it("success: false then a later settlement of the same authorization never lets spend exceed the budget", async () => {
    const store = testStore();
    const wallet = testWallet();
    const guardian = fakeGuardian();
    const failed = serve("10000", () => ({ success: false, errorReason: "insufficient_funds" }));
    const a = makeGuard({ guardian, store, budgets: budget("15000") }, wallet).guard;
    expect((await guardedFetch(a, failed.fetch)(URL_A)).status).toBe(200);
    expect(a.records().find((r) => r.event === "settlement")).toMatchObject({ success: false });
    // The authorization may still be settled: it stays counted.
    await expect(guardedFetch(a, serve().fetch)(`${URL_A}/2`)).rejects.toThrow(/BUDGET_EXCEEDED/);

    // After validBefore, the chain shows it was settled after all: still spent.
    let used = true;
    const reader = async () => used;
    const later = makeGuard(
      { guardian, store, budgets: budget("15000"), authorizationState: reader, now: () => Date.now() + 400_000 },
      wallet,
    ).guard;
    expect(await later.reconcile()).toEqual({ released: 0, spent: 1 });
    await expect(guardedFetch(later, serve().fetch)(`${URL_A}/3`)).rejects.toThrow(/BUDGET_EXCEEDED/);

    // Only an unused nonce after validBefore is released.
    used = false;
    expect(await later.reconcile()).toEqual({ released: 0, spent: 0 });
  });

  it("a reservation is released after validBefore only when the chain shows the nonce unused", async () => {
    const store = testStore();
    const wallet = testWallet();
    const guardian = fakeGuardian();
    const failed = serve("10000", () => ({ success: false }));
    const a = makeGuard({ guardian, store, budgets: budget("15000") }, wallet).guard;
    await guardedFetch(a, failed.fetch)(URL_A);
    const early = makeGuard({ guardian, store, budgets: budget("15000"), authorizationState: async () => false }, wallet).guard;
    expect(await early.reconcile()).toEqual({ released: 0, spent: 0 }); // validBefore not passed yet
    // Just past validBefore by the local clock: the chain's block time may
    // still be before it, so nothing is released yet.
    const justPast = makeGuard(
      { guardian, store, budgets: budget("15000"), authorizationState: async () => false, now: () => Date.now() + 120_000 },
      wallet,
    ).guard;
    expect(await justPast.reconcile()).toEqual({ released: 0, spent: 0 });
    const later = makeGuard(
      { guardian, store, budgets: budget("15000"), authorizationState: async () => false, now: () => Date.now() + 400_000 },
      wallet,
    ).guard;
    expect(await later.reconcile()).toEqual({ released: 1, spent: 0 });
  });

  it("reconcile releasing a reservation mid-decision never lets both payments sign over the budget", async () => {
    const store = testStore();
    const wallet = testWallet();
    let clock = Date.now();
    const base = fakeGuardian();
    let second: Promise<Response> | undefined;
    let guard!: ReturnType<typeof makeGuard>["guard"];
    const guardian = {
      ...base,
      async execute(arg: Parameters<typeof base.execute>[0]) {
        if (!second) {
          // The first payment is slow; meanwhile its reservation is released
          // and a second payment takes the budget.
          clock += 400_000;
          expect(await guard.reconcile()).toEqual({ released: 1, spent: 0 });
          second = guardedFetch(guard, serve().fetch)(`${URL_A}/2`);
          await second;
        }
        return base.execute(arg);
      },
    };
    guard = makeGuard({ guardian, store, budgets: budget("15000"), now: () => clock }, wallet).guard;
    await expect(guardedFetch(guard, serve().fetch)(URL_A)).rejects.toThrow(/SIGNING_REFUSED/);
    expect((await second!).status).toBe(200);
    expect(wallet.signed).toHaveLength(1);
    const doc = JSON.parse([...store.data.values()][0]!.value) as { entries: { state: string; amount: string }[] };
    expect(doc.entries.map((e) => [e.state, e.amount])).toEqual([
      ["released", "10000"],
      ["spent", "10000"],
    ]);
  });

  it("reconcile keeps a reservation while its flow may still be deciding", async () => {
    const store = testStore();
    let clock = Date.now();
    let checked = false;
    const base = fakeGuardian();
    let guard!: ReturnType<typeof makeGuard>["guard"];
    const guardian = {
      ...base,
      async execute(arg: Parameters<typeof base.execute>[0]) {
        clock += 200_000; // within request TTL + call timeouts + signing window
        expect(await guard.reconcile()).toEqual({ released: 0, spent: 0 });
        checked = true;
        return base.execute(arg);
      },
    };
    guard = makeGuard({ guardian, store, budgets: budget("15000"), now: () => clock }).guard;
    expect((await guardedFetch(guard, serve().fetch)(URL_A)).status).toBe(200);
    expect(checked).toBe(true);
  });

  it("a refused payment releases its reservation (no signature was made)", async () => {
    const guardian = fakeGuardian({ decide: () => ({ deny: "POLICY_DENIED" }) });
    const store = testStore();
    const { guard } = makeGuard({ guardian, store, budgets: budget("10000") });
    await expect(guardedFetch(guard, serve().fetch)(URL_A)).rejects.toThrow(/POLICY_DENIED/);
    const doc = JSON.parse([...store.data.values()][0]!.value) as { entries: { state: string }[] };
    expect(doc.entries.map((e) => e.state)).toEqual(["released"]);
  });
});
