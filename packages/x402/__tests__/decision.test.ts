import { describe, expect, it } from "vitest";

import { guardedFetch } from "../src/fetch.js";
import {
  accept,
  fakeGuardian,
  fakeServer,
  makeGuard,
  MERCHANT,
  orderLog,
  paymentRequired,
  SEPOLIA,
  signatureValid,
  USDC_SEPOLIA,
} from "./helpers.js";

const URL_A = "https://api.example.test/report";

function server(amount = "10000", extra: Record<string, unknown> = {}) {
  return fakeServer({
    terms: (url) => paymentRequired(url, [accept({ amount, ...extra })]),
  });
}

describe("decisions before signing (fetch)", () => {
  it("ALLOW: a 0.01 USDC payment is signed after request and execute; the receipt holds the exact terms", async () => {
    const order = orderLog();
    const guardian = fakeGuardian();
    const { guard, wallet } = makeGuard({ guardian });
    const s = server();
    const pay = guardedFetch(guard, s.fetch);

    const res = await pay(URL_A);
    expect(res.status).toBe(200);
    expect(order).toEqual(["request", "execute", "sign"]);
    expect(s.paid).toHaveLength(1);
    expect(await signatureValid(s.paid[0]!)).toBe(true);

    const inv = guardian.requests[0] as { action: string; toolName: string; arguments: Record<string, unknown> };
    expect(inv.action).toBe("tool.invoke");
    expect(inv.toolName).toBe("x402.pay");
    expect(inv.arguments).toMatchObject({
      x402Version: 2,
      scheme: "exact",
      network: SEPOLIA,
      asset: USDC_SEPOLIA.toLowerCase(),
      amount: "10000",
      amountDisplay: "0.01 USDC",
      payTo: MERCHANT.toLowerCase(),
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009", paymentFlow: "authorization" },
      resourceUrl: URL_A,
      request: { transport: "http", method: "GET", originalUrl: URL_A, finalUrl: URL_A },
    });
    // What was signed is what was decided.
    const auth = (s.paid[0]!.payload as { authorization: Record<string, string> }).authorization;
    expect(auth.to.toLowerCase()).toBe(MERCHANT.toLowerCase());
    expect(auth.value).toBe("10000");
    expect(auth.from).toBe(wallet.account.address);

    const recs = guard.records();
    const redeemed = recs.find((r) => r.event === "redeemed")!;
    const signed = recs.find((r) => r.event === "signed")!;
    const settled = recs.find((r) => r.event === "settlement")!;
    expect(redeemed.terms).toEqual(
      Object.fromEntries(Object.entries(inv.arguments).filter(([k]) => k !== "reviewReasons")),
    );
    expect(signed.requestId).toBe(redeemed.requestId);
    expect(signed.nonce).toBe(auth.nonce.toLowerCase());
    expect(settled).toMatchObject({ success: true, network: SEPOLIA, nonce: auth.nonce.toLowerCase() });
  });

  it("ASK then a person approves (claim): the payment waits, then signs", async () => {
    const order = orderLog();
    const guardian = fakeGuardian({ decide: () => "ASK", person: "approve", claimsBeforeDecision: 2 });
    const { guard } = makeGuard({ guardian });
    const s = server();
    const res = await guardedFetch(guard, s.fetch)(URL_A);
    expect(res.status).toBe(200);
    expect(order).toEqual(["request", "claim", "claim", "claim", "execute", "sign"]);
  });

  it("a held ASK reported as APPROVAL_REQUIRED is waited on too", async () => {
    const guardian = fakeGuardian({ decide: () => ({ askAsForbidden: true }), person: "approve" });
    const { guard } = makeGuard({ guardian });
    const s = server();
    expect((await guardedFetch(guard, s.fetch)(URL_A)).status).toBe(200);
  });

  it("ASK then the request expires: no signature", async () => {
    const guardian = fakeGuardian({ decide: () => "ASK", person: "never" });
    const { guard, wallet } = makeGuard({ guardian, requestTtlMs: 40 });
    const s = server();
    await expect(guardedFetch(guard, s.fetch)(URL_A)).rejects.toThrow(/APPROVAL_TIMEOUT/);
    expect(wallet.signed).toHaveLength(0);
    expect(s.paid).toHaveLength(0);
    expect(guardian.calls.some((c) => c.op === "execute")).toBe(false);
  });

  it("ASK then a person denies: no signature", async () => {
    const guardian = fakeGuardian({ decide: () => "ASK", person: "deny" });
    const { guard, wallet } = makeGuard({ guardian });
    await expect(guardedFetch(guard, server().fetch)(URL_A)).rejects.toThrow(/GUARDIAN_DENIED:APPROVAL_DENIED/);
    expect(wallet.signed).toHaveLength(0);
  });

  it("DENY: no signature, and the error names Guardian's reason", async () => {
    const guardian = fakeGuardian({ decide: () => ({ deny: "POLICY_DENIED" }) });
    const { guard, wallet } = makeGuard({ guardian });
    const s = server();
    await expect(guardedFetch(guard, s.fetch)(URL_A)).rejects.toThrow(
      /Failed to create payment payload: .*GUARDIAN_DENIED:POLICY_DENIED/,
    );
    expect(wallet.signed).toHaveLength(0);
    expect(s.paid).toHaveLength(0);
  });

  it.each([
    ["unreachable", "THROW", /GUARDIAN_UNREACHABLE/],
    ["service unavailable", "UNAVAILABLE", /GUARDIAN_UNREACHABLE/],
    ["timing out", "HANG", /GUARDIAN_TIMEOUT/],
    ["malformed", "MALFORMED", /GUARDIAN_UNREACHABLE/],
  ] as const)("Guardian %s: no signature", async (_name, mode, error) => {
    const guardian = fakeGuardian({ decide: () => mode });
    const { guard, wallet } = makeGuard({ guardian, guardianCallTimeoutMs: 30 });
    const s = server();
    await expect(guardedFetch(guard, s.fetch)(URL_A)).rejects.toThrow(error);
    expect(wallet.signed).toHaveLength(0);
    expect(s.paid).toHaveLength(0);
  });

  it.each([
    ["an empty requestId", () => ""],
    ["another request's id", (id: string) => `${id}_other`],
  ] as const)("a claim ALLOW naming %s is refused: no execute, no signature", async (_n, idFor) => {
    const guardian = fakeGuardian({ decide: () => "ASK", person: "approve", claimsBeforeDecision: 0 });
    const claim = guardian.claim.bind(guardian);
    guardian.claim = async (requestId: string) => {
      const answer = await claim(requestId);
      return answer.ok ? { ...answer, requestId: idFor(requestId) } : answer;
    };
    const { guard, wallet } = makeGuard({ guardian });
    const s = server();
    await expect(guardedFetch(guard, s.fetch)(URL_A)).rejects.toThrow(/GUARDIAN_UNREACHABLE/);
    expect(guardian.calls.some((c) => c.op === "execute")).toBe(false);
    expect(wallet.signed).toHaveLength(0);
    expect(s.paid).toHaveLength(0);
  });

  it("execute failing after ALLOW: no signature", async () => {
    const guardian = fakeGuardian({ executeFails: "EXECUTION_FAILED" });
    const { guard, wallet } = makeGuard({ guardian });
    await expect(guardedFetch(guard, server().fetch)(URL_A)).rejects.toThrow(/EXECUTE_FAILED:EXECUTION_FAILED/);
    expect(wallet.signed).toHaveLength(0);
  });

  it("revoked between ALLOW and signing: execute fails and nothing is signed", async () => {
    const guardian = fakeGuardian({ revokeAfterDecision: true });
    const { guard, wallet } = makeGuard({ guardian });
    await expect(guardedFetch(guard, server().fetch)(URL_A)).rejects.toThrow(/CAPABILITY_REVOKED/);
    expect(wallet.signed).toHaveLength(0);
  });

  it.each(["TOOL_NOT_IN_CATALOG", "TOOL_NOT_GRANTED"])(
    "%s: no signature and no mcp.install is proposed",
    async (code) => {
      const guardian = fakeGuardian({ decide: () => ({ deny: code }) });
      const { guard, wallet } = makeGuard({ guardian });
      await expect(guardedFetch(guard, server().fetch)(URL_A)).rejects.toThrow(code);
      expect(wallet.signed).toHaveLength(0);
      expect(guardian.requests).toHaveLength(1);
      expect(guardian.requests.every((r) => r.action === "tool.invoke")).toBe(true);
    },
  );
});
