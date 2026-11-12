import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { guardedFetch } from "../src/fetch.js";
import { readTerms } from "../src/index.js";
import { assertSupportedX402, isSupportedX402Version, TESTED_X402_RANGE } from "../src/version.js";
import {
  accept,
  fakeGuardian,
  fakeServer,
  makeGuard,
  MERCHANT_2,
  orderLog,
  paymentRequired,
  SEPOLIA,
  signatureValid,
  testWallet,
  v1Accept,
} from "./helpers.js";

const URL_A = "https://api.example.test/v";

const argsOf = (g: ReturnType<typeof fakeGuardian>, i = 0) =>
  (g.requests[i] as { arguments: Record<string, unknown> }).arguments;
const omitVersion = (a: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(a).filter(([k]) => k !== "x402Version"));

describe("x402 v1 and v2", () => {
  it("v1 terms and v2 terms give equivalent canonical payment fields and the same decision; v1 signs through the guard", async () => {
    const g2 = fakeGuardian();
    const v2 = makeGuard({ guardian: g2 });
    const s2 = fakeServer({ terms: (url) => paymentRequired(url, [accept()]) });
    expect((await guardedFetch(v2.guard, s2.fetch)(URL_A)).status).toBe(200);

    const order = orderLog();
    const g1 = fakeGuardian();
    const v1 = makeGuard({ guardian: g1 });
    const s1 = fakeServer({
      version: 1,
      terms: (url) => ({ x402Version: 1, error: "payment required", accepts: [v1Accept(url)] }),
    });
    expect((await guardedFetch(v1.guard, s1.fetch)(URL_A)).status).toBe(200);

    expect(argsOf(g1).x402Version).toBe(1);
    expect(argsOf(g2).x402Version).toBe(2);
    expect(omitVersion(argsOf(g1))).toEqual(omitVersion(argsOf(g2)));
    expect((g1.requests[0] as { toolName: string }).toolName).toBe(
      (g2.requests[0] as { toolName: string }).toolName,
    );

    // The v1 scheme signed through the wrapped signer, after the decision.
    expect(order).toEqual(["request", "execute", "sign"]);
    expect(s1.paid[0]!.x402Version).toBe(1);
    expect(await signatureValid(s1.paid[0]!, 1)).toBe(true);
    // v1 settlement is read from X-PAYMENT-RESPONSE by the guard's wrapper.
    expect(v1.guard.records().find((r) => r.event === "settlement")).toMatchObject({ success: true });
  });

  it("readTerms maps base-sepolia (v1) to eip155:84532 and nothing else", () => {
    const opts = { enabledNetworks: [SEPOLIA] as const, maxTimeoutSecondsLimit: 300 };
    const req = { transport: "http", method: "GET", originalUrl: URL_A, finalUrl: URL_A } as const;
    const ok = readTerms(1, v1Accept(URL_A), { x402Version: 1 }, req, opts);
    expect(ok.ok && ok.terms.network).toBe(SEPOLIA);
    const other = readTerms(1, v1Accept(URL_A, { network: "polygon-amoy" }), {}, req, opts);
    expect(other).toMatchObject({ ok: false, code: "UNSUPPORTED_NETWORK" });
    const v2Name = readTerms(2, accept({ network: "base-sepolia" }), paymentRequired(URL_A, []), req, opts);
    expect(v2Name).toMatchObject({ ok: false, code: "UNSUPPORTED_NETWORK" });
  });
});

describe("failure hooks are sealed", () => {
  it("a developer cannot add an onPaymentCreationFailure hook that pays past a refusal", async () => {
    const guardian = fakeGuardian();
    const wallet = testWallet();
    const { guard } = makeGuard({ guardian }, wallet);
    expect(() =>
      guard.client.onPaymentCreationFailure(async ({ paymentRequired, selectedRequirements }) => ({
        recovered: true,
        payload: {
          x402Version: 2,
          resource: paymentRequired.resource,
          accepted: selectedRequirements,
          payload: { authorization: { to: MERCHANT_2 }, signature: "0xdeveloper" },
        },
      })),
    ).toThrow(/GUARD_SEALED/);
    // The developer changes the terms after the decision: the guard's signer refuses
    // and, with no failure hook, nothing is paid.
    guard.client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
      selectedRequirements.payTo = MERCHANT_2;
    });
    const s = fakeServer({ terms: (url) => paymentRequired(url, [accept()]) });
    await expect(guardedFetch(guard, s.fetch)(URL_A)).rejects.toThrow(/TERMS_CHANGED/);
    expect(guard.records().some((r) => r.code === "TERMS_CHANGED")).toBe(true);
    expect(wallet.signed).toHaveLength(0);
    expect(s.paid).toHaveLength(0);
  });
});

describe("logs and receipts hold no private key or signature", () => {
  it("nothing the guard records or sends to Guardian holds the key or a signature", async () => {
    const sink: unknown[] = [];
    const guardian = fakeGuardian({ decide: () => "ASK" });
    const wallet = testWallet();
    const { guard } = makeGuard({ guardian, onRecord: (r) => sink.push(r) }, wallet);
    const s = fakeServer({ terms: (url) => paymentRequired(url, [accept()]) });
    expect((await guardedFetch(guard, s.fetch)(URL_A)).status).toBe(200);
    const signature = (s.paid[0]!.payload as { signature: string }).signature;
    const everything = JSON.stringify([guardian.requests, guardian.calls, guard.records(), sink]);
    const key = wallet.privateKey.toLowerCase();
    expect(everything.toLowerCase()).not.toContain(key.slice(2));
    expect(everything.toLowerCase()).not.toContain(signature.toLowerCase().slice(2));
    expect(everything).not.toContain("PAYMENT-SIGNATURE");
    expect(sink.length).toBeGreaterThan(0);
  });
});

describe("timing options", () => {
  const bad = [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5];
  it.each([
    ["signingWindowMs", 120_000],
    ["claimPollIntervalMs", 60_000],
    ["guardianCallTimeoutMs", 60_000],
  ] as const)("%s must be a whole number of ms up to its max", (name, max) => {
    for (const value of [...bad, max + 1]) {
      expect(() => makeGuard({ guardian: fakeGuardian(), [name]: value })).toThrow(
        new RegExp(`${name} must be a whole number`),
      );
    }
    expect(() => makeGuard({ guardian: fakeGuardian(), [name]: max })).not.toThrow();
  });
});

describe("x402 version check", () => {
  const read = (version: string | null) => () => version;
  it("accepts only plain 2.30.x releases, the same range as the peer dependencies", async () => {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
    ) as { peerDependencies: Record<string, string> };
    for (const name of ["@x402/core", "@x402/evm", "@x402/fetch", "@x402/axios", "@x402/mcp"]) {
      expect(pkg.peerDependencies[name]).toBe(TESTED_X402_RANGE);
    }
    for (const ok of ["2.30.0", "2.30.7"]) {
      expect(assertSupportedX402("@x402/core", read(ok))).toBe(ok);
    }
    for (const refused of ["2.29.9", "2.31.0", "3.0.0", "1.30.0", "2.30.0-beta.1", "2.30", "x", null]) {
      expect(() => assertSupportedX402("@x402/core", read(refused))).toThrow(/supports @x402\/core ~2\.30\.0/);
    }
  });

  it("the installed x402 packages pass", () => {
    for (const name of ["@x402/core", "@x402/evm", "@x402/fetch", "@x402/axios", "@x402/mcp"]) {
      expect(isSupportedX402Version(assertSupportedX402(name))).toBe(true);
    }
  });
});
