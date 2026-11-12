// Refusal tests. This file and mainnet.test.ts are the only fixtures allowed
// to name Base mainnet (see fixtures-check.test.ts).
import { describe, expect, it } from "vitest";

import { guardedFetch } from "../src/fetch.js";
import {
  accept,
  fakeGuardian,
  fakeServer,
  makeGuard,
  MERCHANT_2,
  paymentRequired,
  SEPOLIA,
  USDC_SEPOLIA,
} from "./helpers.js";

const URL_A = "https://api.example.test/paid";

async function refusedLocally(terms: unknown, expected: RegExp, guardOverrides = {}) {
  const guardian = fakeGuardian();
  const { guard, wallet } = makeGuard({ guardian, ...guardOverrides });
  const s = fakeServer({ terms: () => terms as Record<string, unknown> });
  await expect(guardedFetch(guard, s.fetch)(URL_A)).rejects.toThrow(expected);
  expect(guardian.calls).toHaveLength(0);
  expect(wallet.signed).toHaveLength(0);
  expect(s.paid).toHaveLength(0);
}

const one = (overrides: Record<string, unknown>) => paymentRequired(URL_A, [accept(overrides)]);

describe("refused locally, Guardian not called", () => {
  const cases: [string, unknown, RegExp][] = [
    ["scheme upto", one({ scheme: "upto" }), /UNSUPPORTED_SCHEME/],
    [
      "assetTransferMethod permit2",
      one({ extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" } }),
      /UNSUPPORTED_TRANSFER_METHOD/,
    ],
    [
      "assetTransferMethod erc7710",
      one({ extra: { name: "USDC", version: "2", assetTransferMethod: "erc7710" } }),
      /UNSUPPORTED_TRANSFER_METHOD/,
    ],
    [
      "paymentFlow upfront",
      one({ extra: { name: "USDC", version: "2", paymentFlow: "upfront" } }),
      /UNSUPPORTED_PAYMENT_FLOW/,
    ],
    [
      "extra.splits",
      one({ extra: { name: "USDC", version: "2", splits: [{ payTo: MERCHANT_2, bps: 100 }] } }),
      /SPLITS_REFUSED/,
    ],
    ["a Solana network", one({ network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" }), /UNSUPPORTED_NETWORK/],
    ["an unknown EVM chain id", one({ network: "eip155:999999" }), /UNSUPPORTED_NETWORK/],
    ["an unknown asset on Base Sepolia", one({ asset: MERCHANT_2 }), /UNSUPPORTED_ASSET/],
    [
      'extra.name "USD Coin" on Base Sepolia',
      one({ extra: { name: "USD Coin", version: "2" } }),
      /DOMAIN_MISMATCH/,
    ],
    ["an unknown extra field", one({ extra: { name: "USDC", version: "2", feePayer: MERCHANT_2 } }), /UNKNOWN_EXTRA_FIELD/],
    ['amount "0"', one({ amount: "0" }), /INVALID_AMOUNT/],
    ['amount "-1"', one({ amount: "-1" }), /INVALID_AMOUNT/],
    ['amount "1.5"', one({ amount: "1.5" }), /INVALID_AMOUNT/],
    ['amount "1e6"', one({ amount: "1e6" }), /INVALID_AMOUNT/],
    ["a non-string amount", one({ amount: 10000 }), /INVALID_AMOUNT/],
    ['payTo "merchant"', one({ payTo: "merchant" }), /INVALID_PAY_TO/],
    ["maxTimeoutSeconds above the limit", one({ maxTimeoutSeconds: 301 }), /TIMEOUT_ABOVE_LIMIT/],
    ["x402Version 3", { ...one({}), x402Version: 3 }, /UNSUPPORTED_VERSION/],
    ["no resource", { x402Version: 2, accepts: [accept()] }, /MISSING_RESOURCE/],
    ["Base mainnet when not enabled", one({ network: "eip155:8453" }), /NETWORK_NOT_ENABLED/],
    ["base64 that will not parse", "%%%not-base64%%%", /Failed to parse payment requirements/],
    ["JSON that will not parse", Buffer.from("{not json").toString("base64"), /Failed to parse payment requirements/],
  ];

  it.each(cases)("%s", async (_name, terms, expected) => {
    await refusedLocally(terms, expected);
  });

  it('v1 network "base" (Base mainnet) when not enabled', async () => {
    const v1 = {
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: "base",
          maxAmountRequired: "10000",
          resource: URL_A,
          description: "",
          mimeType: "application/json",
          payTo: MERCHANT_2,
          maxTimeoutSeconds: 60,
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          extra: { name: "USD Coin", version: "2" },
        },
      ],
    };
    const guardian = fakeGuardian();
    const { guard, wallet } = makeGuard({ guardian });
    const s = fakeServer({ version: 1, terms: () => v1 });
    await expect(guardedFetch(guard, s.fetch)(URL_A)).rejects.toThrow(/NETWORK_NOT_ENABLED/);
    expect(guardian.calls).toHaveLength(0);
    expect(wallet.signed).toHaveLength(0);
    expect(s.paid).toHaveLength(0);
  });

  it("a payTo outside the allowlist", async () => {
    await refusedLocally(one({}), /PAY_TO_NOT_ALLOWED/, {
      limits: [{ network: SEPOLIA, asset: USDC_SEPOLIA, askAbove: "50000", max: "500000", payTo: [MERCHANT_2] }],
    });
  });

  it("v1 JSON body that will not parse", async () => {
    const guardian = fakeGuardian();
    const { guard, wallet } = makeGuard({ guardian });
    const s = fakeServer({ version: 1, terms: () => "{not json" });
    await expect(guardedFetch(guard, s.fetch)(URL_A)).rejects.toThrow(/Failed to parse payment requirements/);
    expect(guardian.calls).toHaveLength(0);
    expect(wallet.signed).toHaveLength(0);
  });

  it("calling the guarded client directly, with no original request, is refused", async () => {
    const guardian = fakeGuardian();
    const { guard, wallet } = makeGuard({ guardian });
    await expect(guard.client.createPaymentPayload(one({}) as never)).rejects.toThrow(/ORIGINAL_REQUEST_MISSING/);
    expect(guardian.calls).toHaveLength(0);
    expect(wallet.signed).toHaveLength(0);
  });

  it("the guarded client takes no other schemes, no extensions, and cannot turn spendControls off", () => {
    const { guard } = makeGuard({ guardian: fakeGuardian() });
    expect(() => guard.client.register("eip155:*", {} as never)).toThrow(/GUARD_SEALED/);
    expect(() => guard.client.registerV1("base-sepolia", {} as never)).toThrow(/GUARD_SEALED/);
    expect(() => guard.client.registerExtension({ key: "x" })).toThrow(/GUARD_SEALED/);
    expect(() => guard.client.setSpendControls(false)).toThrow(/GUARD_SEALED/);
  });
});
