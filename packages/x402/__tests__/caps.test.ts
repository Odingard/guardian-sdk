import { describe, expect, it } from "vitest";

import { guardedFetch } from "../src/fetch.js";
import {
  accept,
  fakeGuardian,
  fakeServer,
  makeGuard,
  MERCHANT,
  MERCHANT_2,
  paymentRequired,
  SEPOLIA,
  USDC_SEPOLIA,
} from "./helpers.js";

const URL_A = "https://api.example.test/data";

const serve = (accepts: unknown[]) =>
  fakeServer({ terms: (url) => paymentRequired(url, accepts) });

const toolOf = (inv: unknown) => (inv as { toolName: string }).toolName;

describe("local caps, ask-above and units", () => {
  it("above askAbove: proposed as x402.pay.above_cap; a rule ALLOW is not enough", async () => {
    const guardian = fakeGuardian({ decide: () => "ALLOW" });
    const { guard, wallet } = makeGuard({ guardian });
    const s = serve([accept({ amount: "60000" })]);
    await expect(guardedFetch(guard, s.fetch)(URL_A)).rejects.toThrow(/PERSON_APPROVAL_REQUIRED/);
    expect(toolOf(guardian.requests[0])).toBe("x402.pay.above_cap");
    expect(guardian.calls.some((c) => c.op === "execute")).toBe(false);
    expect(wallet.signed).toHaveLength(0);
  });

  it("above askAbove: a person's approval (receipt shows it) is enough", async () => {
    const guardian = fakeGuardian({ decide: () => "ASK", person: "approve" });
    const { guard, wallet } = makeGuard({ guardian });
    const s = serve([accept({ amount: "60000" })]);
    expect((await guardedFetch(guard, s.fetch)(URL_A)).status).toBe(200);
    expect(wallet.signed).toHaveLength(1);
    expect(guardian.calls.map((c) => c.op)).toContain("portableReceipt");
    expect(guard.records().find((r) => r.event === "redeemed")?.approvedByPerson).toBe(true);
  });

  it("above askAbove: the receipt is read after execute and shows \"consumed\", as Guardian records it", async () => {
    const guardian = fakeGuardian({ decide: () => "ASK", person: "approve" });
    const seen: unknown[] = [];
    const read = guardian.portableReceipt.bind(guardian);
    guardian.portableReceipt = async (id) => {
      const got = await read(id);
      seen.push((got as { receipt?: { approval?: { state?: string } | null } }).receipt?.approval?.state);
      return got;
    };
    const { guard, wallet } = makeGuard({ guardian });
    const s = serve([accept({ amount: "60000" })]);
    expect((await guardedFetch(guard, s.fetch)(URL_A)).status).toBe(200);
    const ops = guardian.calls.map((c) => c.op);
    expect(ops.indexOf("execute")).toBeGreaterThan(-1);
    expect(ops.indexOf("portableReceipt")).toBeGreaterThan(ops.indexOf("execute"));
    expect(seen).toEqual(["consumed"]);
    expect(wallet.signed).toHaveLength(1);
  });

  it("above askAbove: a receipt whose approval reads \"approved\" is also accepted", async () => {
    const guardian = fakeGuardian({ decide: () => "ASK", person: "approve", receiptApproval: "approved" });
    const { guard, wallet } = makeGuard({ guardian });
    const s = serve([accept({ amount: "60000" })]);
    expect((await guardedFetch(guard, s.fetch)(URL_A)).status).toBe(200);
    expect(wallet.signed).toHaveLength(1);
  });

  it("above askAbove: an ALLOW from claim whose receipt shows no person is refused", async () => {
    const guardian = fakeGuardian({ decide: () => "ASK", person: "approve", receiptApproval: null });
    const { guard, wallet } = makeGuard({ guardian });
    const s = serve([accept({ amount: "60000" })]);
    await expect(guardedFetch(guard, s.fetch)(URL_A)).rejects.toThrow(/RECEIPT_CHECK_FAILED/);
    expect(wallet.signed).toHaveLength(0);
  });

  it.each(["pending", "denied", "expired"] as const)(
    "above askAbove: a receipt whose approval is %s is refused",
    async (state) => {
      const guardian = fakeGuardian({ decide: () => "ASK", person: "approve", receiptApproval: state });
      const { guard, wallet } = makeGuard({ guardian });
      const s = serve([accept({ amount: "60000" })]);
      await expect(guardedFetch(guard, s.fetch)(URL_A)).rejects.toThrow(/RECEIPT_CHECK_FAILED/);
      expect(wallet.signed).toHaveLength(0);
    },
  );

  it("above askAbove: the receipt of an earlier request on the same terms is refused", async () => {
    let first: string | undefined;
    const guardian = fakeGuardian({
      decide: () => "ASK",
      person: "approve",
      receiptOf: (requestId) => (first ??= requestId),
    });
    const { guard, wallet } = makeGuard({ guardian, limits: [] });
    const s = serve([accept({ amount: "60000", maxTimeoutSeconds: 1 })]);
    expect((await guardedFetch(guard, s.fetch)(URL_A)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1_100)); // the first authorization expires
    await expect(guardedFetch(guard, s.fetch)(URL_A)).rejects.toThrow(/RECEIPT_CHECK_FAILED/);
    expect(wallet.signed).toHaveLength(1);
  });

  it("above max: refused locally, Guardian not called", async () => {
    const guardian = fakeGuardian();
    const { guard, wallet } = makeGuard({ guardian });
    const s = serve([accept({ amount: "500001" })]);
    await expect(guardedFetch(guard, s.fetch)(URL_A)).rejects.toThrow(/ABOVE_MAX/);
    expect(guardian.calls).toHaveLength(0);
    expect(wallet.signed).toHaveLength(0);
  });

  it("no cap set for the asset: treated as above-cap", async () => {
    const guardian = fakeGuardian({ decide: () => "ALLOW" });
    const { guard } = makeGuard({ guardian, limits: [] });
    const s = serve([accept({ amount: "1" })]);
    await expect(guardedFetch(guard, s.fetch)(URL_A)).rejects.toThrow(/PERSON_APPROVAL_REQUIRED/);
    expect(toolOf(guardian.requests[0])).toBe("x402.pay.above_cap");
    expect((guardian.requests[0] as { arguments: { reviewReasons: string[] } }).arguments.reviewReasons).toContain(
      "NO_CAP_FOR_ASSET",
    );
  });

  it("x402 caps first: 2 USDC with default spendControls is filtered by x402 before Guardian is asked", async () => {
    const guardian = fakeGuardian();
    const { guard, wallet } = makeGuard({
      guardian,
      limits: [{ network: SEPOLIA, asset: USDC_SEPOLIA, askAbove: "5000000", max: "5000000" }],
    });
    const s = serve([accept({ amount: "2000000" })]);
    await expect(guardedFetch(guard, s.fetch)(URL_A)).rejects.toThrow(/spendControls/);
    expect(guardian.calls).toHaveLength(0);
    expect(wallet.signed).toHaveLength(0);
  });

  it("units: a cap of 10000 atomic USDC refuses 10001", async () => {
    const guardian = fakeGuardian();
    const { guard } = makeGuard({
      guardian,
      limits: [{ network: SEPOLIA, asset: USDC_SEPOLIA, askAbove: "10000", max: "10000" }],
    });
    await expect(guardedFetch(guard, serve([accept({ amount: "10001" })]).fetch)(URL_A)).rejects.toThrow(
      /ABOVE_MAX/,
    );
    expect(guardian.calls).toHaveLength(0);
    expect((await guardedFetch(guard, serve([accept({ amount: "10000" })]).fetch)(URL_A)).status).toBe(200);
  });

  it("units: no money fact is sent, so a USD-cent cap on the connection cannot apply", async () => {
    const guardian = fakeGuardian();
    const { guard } = makeGuard({ guardian });
    await guardedFetch(guard, serve([accept()]).fetch)(URL_A);
    const inv = guardian.requests[0] as Record<string, unknown>;
    for (const k of ["valueCents", "merchantId", "merchantCategory", "materialParameters"]) {
      expect(inv).not.toHaveProperty(k);
    }
    expect(JSON.stringify(inv)).not.toContain("$");
  });

  it("a payTo outside the allowlist is refused locally", async () => {
    const guardian = fakeGuardian();
    const { guard } = makeGuard({
      guardian,
      limits: [{ network: SEPOLIA, asset: USDC_SEPOLIA, askAbove: "50000", max: "500000", payTo: [MERCHANT_2] }],
    });
    await expect(guardedFetch(guard, serve([accept()]).fetch)(URL_A)).rejects.toThrow(/PAY_TO_NOT_ALLOWED/);
    expect(guardian.calls).toHaveLength(0);
    expect((await guardedFetch(guard, serve([accept({ payTo: MERCHANT_2 })]).fetch)(URL_A)).status).toBe(200);
  });

  it("mixed accepts: a permit2 entry first and a supported eip3009 entry second pays the supported entry", async () => {
    const guardian = fakeGuardian();
    const { guard } = makeGuard({ guardian });
    const s = serve([
      accept({ amount: "20000", extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" } }),
      accept({ amount: "10000" }),
    ]);
    expect((await guardedFetch(guard, s.fetch)(URL_A)).status).toBe(200);
    expect((guardian.requests[0] as { arguments: { amount: string } }).arguments.amount).toBe("10000");
    expect(s.paid[0]!.accepted.amount).toBe("10000");
    expect(s.paid[0]!.accepted.extra.assetTransferMethod).toBeUndefined();
  });

  it("a resource.url host different from the request host is refused", async () => {
    const guardian = fakeGuardian();
    const { guard, wallet } = makeGuard({ guardian });
    const s = fakeServer({ terms: () => paymentRequired("https://b.example.test/x", [accept()]) });
    await expect(guardedFetch(guard, s.fetch)("https://a.example.test/x")).rejects.toThrow(
      /RESOURCE_HOST_MISMATCH/,
    );
    expect(guardian.calls).toHaveLength(0);
    expect(wallet.signed).toHaveLength(0);
  });

  it("a request to a.com redirected to a server at b.com that names b.com is refused", async () => {
    const guardian = fakeGuardian();
    const { guard, wallet } = makeGuard({ guardian });
    const s = fakeServer({
      redirectTo: "https://b.example.test/x",
      terms: (url) => paymentRequired(url, [accept()]),
    });
    await expect(guardedFetch(guard, s.fetch)("https://a.example.test/x")).rejects.toThrow(
      /RESOURCE_HOST_MISMATCH/,
    );
    expect(guardian.calls).toHaveLength(0);
    expect(wallet.signed).toHaveLength(0);
  });

  it("the decision carries payTo, amount with unit, network, asset and resource in full", async () => {
    const guardian = fakeGuardian({ decide: () => "ASK" });
    const { guard } = makeGuard({ guardian });
    const longUrl = `${URL_A}?q=${"x".repeat(2000)}`;
    await guardedFetch(guard, serve([accept()]).fetch)(longUrl);
    const inv = guardian.requests[0] as { purpose: string; arguments: Record<string, unknown> };
    expect(inv.arguments.payTo).toBe(MERCHANT.toLowerCase());
    expect(inv.arguments.amountDisplay).toBe("0.01 USDC");
    expect(inv.arguments.network).toBe(SEPOLIA);
    expect(inv.arguments.networkName).toBe("Base Sepolia");
    expect(inv.arguments.asset).toBe(USDC_SEPOLIA.toLowerCase());
    expect(inv.arguments.resourceUrl).toBe(longUrl);
    expect(inv.purpose).toContain("0.01 USDC");
    expect(inv.purpose).not.toContain("$");
  });
});
