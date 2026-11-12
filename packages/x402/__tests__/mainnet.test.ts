// Base mainnet fixtures live only here and in refusals.test.ts. No test
// reaches a mainnet RPC or facilitator: the fake signer records the
// attempt and stops; the only "network" is the in-memory fake server.
import { describe, expect, it } from "vitest";

import { guardedFetch } from "../src/fetch.js";
import { BASE_MAINNET, BASE_SEPOLIA, createX402Guard } from "../src/index.js";
import { CONNECTION, fakeGuardian, fakeServer, paymentRequired, testStore } from "./helpers.js";

const MAINNET = "eip155:8453";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const URL_A = "https://api.example.test/main";
const WALLET = "0x3333333333333333333333333333333333333333";

const mainnetAccept = () => ({
  scheme: "exact",
  network: MAINNET,
  asset: USDC_BASE,
  amount: "10000",
  payTo: "0x1111111111111111111111111111111111111111",
  maxTimeoutSeconds: 60,
  extra: { name: "USD Coin", version: "2" },
});

function recordingSigner() {
  const attempts: { domain: Record<string, unknown> }[] = [];
  return {
    attempts,
    signer: {
      address: WALLET as `0x${string}`,
      async signTypedData(m: { domain: Record<string, unknown> }): Promise<`0x${string}`> {
        attempts.push(m);
        throw new Error("fake signer: recorded, not signed");
      },
    },
  };
}

describe("Base mainnet", () => {
  it("is off by default: mainnet terms are refused and Guardian is not asked", async () => {
    const guardian = fakeGuardian();
    const fake = recordingSigner();
    const guard = createX402Guard({ guardian, connectionId: CONNECTION, signer: fake.signer, store: testStore() });
    const s = fakeServer({ terms: (url) => paymentRequired(url, [mainnetAccept()]) });
    await expect(guardedFetch(guard, s.fetch)(URL_A)).rejects.toThrow(/NETWORK_NOT_ENABLED/);
    expect(guardian.calls).toHaveLength(0);
    expect(fake.attempts).toHaveLength(0);
  });

  it("when enabled by name, the guard decides and stops at the fake signer; no RPC or facilitator call is made", async () => {
    const guardian = fakeGuardian();
    const fake = recordingSigner();
    const guard = createX402Guard({
      guardian,
      connectionId: CONNECTION,
      signer: fake.signer,
      store: testStore(),
      enabledNetworks: [BASE_SEPOLIA, BASE_MAINNET],
      limits: [{ network: BASE_MAINNET, asset: USDC_BASE, askAbove: "50000", max: "50000" }],
    });
    const s = fakeServer({ terms: (url) => paymentRequired(url, [mainnetAccept()]) });
    await expect(guardedFetch(guard, s.fetch)(URL_A)).rejects.toThrow(/SIGNING_REFUSED/);

    expect((guardian.requests[0] as { arguments: { network: string } }).arguments.network).toBe(MAINNET);
    expect(fake.attempts).toHaveLength(1);
    expect(fake.attempts[0]!.domain).toMatchObject({ chainId: 8453, name: "USD Coin" });
    // The only HTTP traffic is the one unpaid request to the fake server.
    expect(s.seen.map((r) => new URL(r.url).host)).toEqual(["api.example.test"]);
    expect(s.paid).toHaveLength(0);
    // The guard's signer offers no on-chain reads or transaction signing.
    expect("readContract" in guard.guardedSigner).toBe(false);
  });
});
