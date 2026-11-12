import { describe, expect, it } from "vitest";

import { flowStorage } from "../src/context.js";
import { guardedFetch } from "../src/fetch.js";
import type { X402Guard } from "../src/index.js";
import {
  accept,
  fakeGuardian,
  fakeServer,
  makeGuard,
  MERCHANT,
  MERCHANT_2,
  paymentRequired,
  USDC_SEPOLIA,
} from "./helpers.js";

const URL_A = "https://api.example.test/a";
const URL_B = "https://api.example.test/b";

type TypedData = {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
};

function goodTypedData(from: string, amount = "10000", payTo = MERCHANT): TypedData {
  const now = Math.floor(Date.now() / 1000);
  return {
    domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC_SEPOLIA },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from,
      to: payTo,
      value: BigInt(amount),
      validAfter: 0n,
      validBefore: BigInt(now + 60),
      nonce: `0x${"12".repeat(32)}`,
    },
  };
}

/**
 * After the guard's decision (ALLOW + execute), a hook that runs next in the
 * same flow tries to sign `typedData` with the guarded signer.
 */
async function trySignAfterAllow(tamper: (td: TypedData) => void) {
  const guardian = fakeGuardian();
  const { guard, wallet } = makeGuard({ guardian });
  let error: unknown;
  guard.client.onBeforePaymentCreation(async () => {
    const td = goodTypedData(wallet.account.address);
    tamper(td);
    try {
      await guard.guardedSigner.signTypedData(td);
    } catch (e) {
      error = e;
    }
    return { abort: true, reason: "test stops here" };
  });
  const s = fakeServer({ terms: (url) => paymentRequired(url, [accept()]) });
  await expect(guardedFetch(guard, s.fetch)(URL_A)).rejects.toThrow();
  return { error, wallet, guardian };
}

describe("the signer wrapper checks what is actually signed", () => {
  it("control: untampered typed data under the token is signed", async () => {
    const { error, wallet } = await trySignAfterAllow(() => undefined);
    expect(error).toBeUndefined();
    expect(wallet.signed).toHaveLength(1);
  });

  const cases: [string, (td: TypedData) => void][] = [
    ["payTo", (td) => (td.message.to = MERCHANT_2)],
    ["value", (td) => (td.message.value = 10001n)],
    ["from", (td) => (td.message.from = MERCHANT_2)],
    ["chainId", (td) => (td.domain.chainId = 1)],
    ["verifyingContract", (td) => (td.domain.verifyingContract = MERCHANT_2)],
    ["domain name", (td) => (td.domain.name = "USD Coin")],
    ["extra domain salt", (td) => (td.domain.salt = `0x${"00".repeat(32)}`)],
    [
      "types (reordered)",
      (td) => {
        const t = td.types.TransferWithAuthorization as unknown[];
        [t[0], t[1]] = [t[1], t[0]];
      },
    ],
    [
      "types (extra field)",
      (td) => (td.types.TransferWithAuthorization as unknown[]).push({ name: "x", type: "uint256" }),
    ],
    ["types (EIP712Domain added)", (td) => (td.types.EIP712Domain = [])],
    ["primary type Permit", (td) => (td.primaryType = "Permit")],
    ["later validBefore", (td) => (td.message.validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600))],
    ["future validAfter", (td) => (td.message.validAfter = BigInt(Math.floor(Date.now() / 1000) + 600))],
    ["short nonce", (td) => (td.message.nonce = "0x1234")],
    ["value as a float", (td) => (td.message.value = 10000.5)],
  ];

  it.each(cases)("a changed %s is refused", async (_name, tamper) => {
    const { error, wallet } = await trySignAfterAllow(tamper);
    expect(String(error)).toMatch(/TYPED_DATA_MISMATCH/);
    expect(wallet.signed).toHaveLength(0);
  });

  it("signTransaction is refused", async () => {
    const { guard } = makeGuard({ guardian: fakeGuardian() });
    await expect(guard.guardedSigner.signTransaction()).rejects.toThrow(/SIGNING_REFUSED/);
    expect(Object.isFrozen(guard.guardedSigner)).toBe(true);
    expect("readContract" in guard.guardedSigner).toBe(false);
  });

  it("single use: a second signature under the same token is refused", async () => {
    const guardian = fakeGuardian();
    const { guard, wallet } = makeGuard({ guardian });
    // Spend the token first; the official scheme's own signature then fails.
    guard.client.onBeforePaymentCreation(async () => {
      await guard.guardedSigner.signTypedData(goodTypedData(wallet.account.address));
    });
    const s = fakeServer({ terms: (url) => paymentRequired(url, [accept()]) });
    await expect(guardedFetch(guard, s.fetch)(URL_A)).rejects.toThrow(/SIGNING_TOKEN_USED/);
    expect(wallet.signed).toHaveLength(1);
    expect(s.paid).toHaveLength(0);
    expect(guardian.requests).toHaveLength(1);
  });

  it("typed data with no token in its flow is refused, and so is signing outside any flow", async () => {
    const { guard, wallet } = makeGuard({ guardian: fakeGuardian() });
    const td = goodTypedData(wallet.account.address);
    await expect(guard.guardedSigner.signTypedData(td)).rejects.toThrow(/NO_PAYMENT_FLOW/);
    const flow = {
      id: "x4f_test",
      paymentRequired: {},
      request: null,
      requestContext: null,
      dropped: [],
      decided: true,
      signAttempted: false,
    };
    await expect(flowStorage.run(flow, () => guard.guardedSigner.signTypedData(td))).rejects.toThrow(
      /NO_SIGNING_TOKEN/,
    );
    expect(wallet.signed).toHaveLength(0);
  });

  it("an expired signing token is refused", async () => {
    const guardian = fakeGuardian();
    const { guard, wallet } = makeGuard({ guardian, signingWindowMs: 5 });
    guard.client.onBeforePaymentCreation(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const s = fakeServer({ terms: (url) => paymentRequired(url, [accept()]) });
    await expect(guardedFetch(guard, s.fetch)(URL_A)).rejects.toThrow(/SIGNING_TOKEN_EXPIRED/);
    expect(wallet.signed).toHaveLength(0);
    expect(guard.records().some((r) => r.event === "redeemed-not-signed")).toBe(true);
  });

  it("two concurrent payments with different payTo and amount each sign only their own terms", async () => {
    const guardian = fakeGuardian({ decide: () => "ASK", person: "approve", claimsBeforeDecision: 2 });
    const { guard, wallet } = makeGuard({ guardian, claimPollIntervalMs: 3 });
    const s = fakeServer({
      terms: (url) =>
        url === URL_A
          ? paymentRequired(url, [accept({ amount: "10000", payTo: MERCHANT })])
          : paymentRequired(url, [accept({ amount: "20000", payTo: MERCHANT_2 })]),
    });
    const pay = guardedFetch(guard, s.fetch);
    const [a, b] = await Promise.all([pay(URL_A), pay(URL_B)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(wallet.signed).toHaveLength(2);
    const byTo = Object.fromEntries(
      s.paid.map((p) => {
        const auth = (p.payload as { authorization: Record<string, string> }).authorization;
        return [auth.to.toLowerCase(), auth.value];
      }),
    );
    expect(byTo).toEqual({ [MERCHANT.toLowerCase()]: "10000", [MERCHANT_2.toLowerCase()]: "20000" });
  });

  it("a selectedRequirements mutated during the ASK wait is refused at signing", async () => {
    let live: Record<string, unknown> | undefined;
    const guardian = fakeGuardian({ decide: () => "ASK", person: "approve", claimsBeforeDecision: 2 });
    const realClaim = guardian.claim.bind(guardian);
    guardian.claim = async (id) => {
      if (live) live.payTo = MERCHANT_2; // the server object changes while a person decides
      return realClaim(id);
    };
    const { guard, wallet } = makeGuard({ guardian });
    // A developer policy sees the live entry objects x402 will select.
    guard.client.registerPolicy((_v, reqs) => {
      live = reqs[0] as unknown as Record<string, unknown>;
      return reqs;
    });
    const s = fakeServer({ terms: (url) => paymentRequired(url, [accept()]) });
    await expect(guardedFetch(guard, s.fetch)(URL_A)).rejects.toThrow(/TERMS_CHANGED/);
    expect(wallet.signed).toHaveLength(0);
    expect(s.paid).toHaveLength(0);
  });
});

export type { X402Guard };
