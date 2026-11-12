import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { Ap2GuardRefused, type Ap2Guard } from "../src/index.js";
import {
  checkoutJwt,
  CP_CHALLENGE,
  fakeGuardian,
  INSTRUMENT,
  makeGuard,
  MERCHANT,
  MERCHANT_2,
  MERCHANT_CHALLENGE,
  NOW_SEC,
  payInput,
  world,
} from "./helpers.js";

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const unb64 = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString()) as Record<string, unknown>;
const sha = async (s: string) => (await import("node:crypto")).createHash("sha256").update(s).digest("base64url");

let approvedPaymentHop: { sdHash: string; content: Record<string, unknown> } = { sdHash: "", content: {} };

/** The payment hop with one field changed, under the approved sd_hash, aud and nonce. */
async function paymentHop(input: string, change: (c: Record<string, unknown>) => void): Promise<[string, string[]]> {
  const [x, d] = await swapContent(input, approvedPaymentHop.content, change);
  return tweak([x, d], (p) => {
    p.sd_hash = approvedPaymentHop.sdHash;
    p.aud = CP_CHALLENGE.aud;
    p.nonce = CP_CHALLENGE.nonce;
  });
}

type Variant = (input: string, approved: Record<string, unknown>) => Promise<[string, string[]]>;

/**
 * Inside an approved flow, while the agent key signs the first hop (the
 * closed Checkout Mandate), try to get the guarded signer to sign other
 * bytes. Every variant must be refused.
 */
async function attackInsideFlow(variants: Record<string, Variant>) {
  const w = world();
  const guardian = fakeGuardian({ decide: () => "ASK" });
  let guard: Ap2Guard | undefined;
  const results: Record<string, string> = {};
  let attacked = false;
  const inner = w.agentSigner;
  const input = payInput(w);
  const approved = { vct: "mandate.checkout.1", checkout_jwt: input.checkoutJwt, checkout_hash: await sha(input.checkoutJwt) };
  approvedPaymentHop = {
    sdHash: await sha(input.openPaymentMandate),
    content: {
      vct: "mandate.payment.1",
      transaction_id: approved.checkout_hash,
      payee: MERCHANT,
      payment_amount: { amount: 1999, currency: "USD" },
      payment_instrument: INSTRUMENT,
    },
  };
  const signer = {
    publicJwk: inner.publicJwk,
    async sign(bytes: Uint8Array) {
      if (!attacked) {
        attacked = true;
        const signingInput = Buffer.from(bytes).toString("ascii");
        for (const [name, make] of Object.entries(variants)) {
          const [i, d] = await make(signingInput, approved);
          try {
            await guard!.guardedSigner.sign(i, d);
            results[name] = "SIGNED";
          } catch (e) {
            results[name] = e instanceof Ap2GuardRefused ? e.code : "OTHER";
          }
        }
      }
      return inner.sign(bytes);
    },
  };
  guard = makeGuard({ ...w, agentSigner: signer } as typeof w, { guardian }).guard;
  const p = await guard.pay(input);
  return { results, p, w };
}

function tweak(
  [input, d]: [string, string[]],
  change: (p: Record<string, unknown>) => void,
  header?: (h: Record<string, unknown>) => void,
): [string, string[]] {
  return [withPayload(input, change, header), d];
}

function withPayload(input: string, change: (p: Record<string, unknown>) => void, header?: (h: Record<string, unknown>) => void) {
  const [h, p] = input.split(".");
  const hh = unb64(h!);
  const pp = unb64(p!);
  change(pp);
  header?.(hh);
  return `${b64(hh)}.${b64(pp)}`;
}

async function swapContent(
  input: string,
  approved: Record<string, unknown>,
  change: (c: Record<string, unknown>) => void,
): Promise<[string, string[]]> {
  const next = { ...approved };
  change(next);
  const d = Buffer.from(JSON.stringify([randomBytes(16).toString("base64url"), next])).toString("base64url");
  const digest = await sha(d);
  return [withPayload(input, (p) => (p.delegate_payload = [{ "...": digest }])), [d]];
}

const same = (input: string, approved: Record<string, unknown>) => swapContent(input, approved, () => undefined);

describe("the wrapped signer signs only the approved hop", () => {
  it("refuses other bytes inside an approved flow: swapped cart, amount, payee, instrument, aud, nonce, sd_hash, extra claims, typ, alg", async () => {
    const w0 = world();
    const otherCheckout = checkoutJwt(w0, { items: [{ id: "sku_mug", title: "Coffee mug", price: 1, quantity: 1 }] });
    const { results, p } = await attackInsideFlow({
      cartSwap: (i, a) => swapContent(i, a, (c) => {
        c.checkout_jwt = otherCheckout;
      }),
      checkoutHash: (i, a) => swapContent(i, a, (c) => {
        c.checkout_hash = "x".repeat(43);
      }),
      amount: (i, a) => swapContent(i, a, (c) => {
        c.payment_amount = { amount: 50000, currency: "USD" };
      }),
      currency: (i, a) => swapContent(i, a, (c) => {
        c.payment_amount = { amount: 1999, currency: "EUR" };
      }),
      payee: (i, a) => swapContent(i, a, (c) => {
        c.payee = MERCHANT_2;
      }),
      instrument: (i, a) => swapContent(i, a, (c) => {
        c.payment_instrument = { id: "pi_other", type: "card" };
      }),
      executionDate: (i, a) => swapContent(i, a, (c) => {
        c.execution_date = "2030-01-01";
      }),
      aud: async (i, a) => tweak(await same(i, a), (p) => (p.aud = "someone-else")),
      nonce: async (i, a) => tweak(await same(i, a), (p) => (p.nonce = "replayed-nonce-000")),
      sdHash: async (i, a) => tweak(await same(i, a), (p) => (p.sd_hash = "y".repeat(43))),
      extraClaim: async (i, a) => tweak(await same(i, a), (p) => (p.cnf = { jwk: {} })),
      iat: async (i, a) => tweak(await same(i, a), (p) => (p.iat = NOW_SEC + 86400)),
      typ: async (i, a) => tweak(await same(i, a), () => undefined, (h) => (h.typ = "kb+sd-jwt+kb")),
      alg: async (i, a) => tweak(await same(i, a), () => undefined, (h) => (h.alg = "none")),
      extraHeader: async (i, a) => tweak(await same(i, a), () => undefined, (h) => (h.jku = "https://evil.test")),
      twoDisclosures: async (i, a) => {
        const [x, d] = await same(i, a);
        return [x, [d[0]!, d[0]!]];
      },
      junk: async () => ["not-a-jws", []],
      paymentAmount: (i) => paymentHop(i, (c) => (c.payment_amount = { amount: 50000, currency: "USD" })),
      paymentPayee: (i) => paymentHop(i, (c) => (c.payee = MERCHANT_2)),
      paymentTransaction: (i) => paymentHop(i, (c) => (c.transaction_id = "z".repeat(43))),
      paymentWrongAud: (i) =>
        paymentHop(i, () => undefined).then((v) => tweak(v, (p) => (p.aud = MERCHANT_CHALLENGE.aud))),
    });
    expect(Object.keys(results)).toHaveLength(21);
    for (const [name, code] of Object.entries(results)) {
      expect([name, code]).toEqual([name, expect.stringMatching(/^(SIGNING_INPUT_MISMATCH)$/)]);
    }
    // The approved pair was still signed, exactly once each.
    expect(p.paymentReference).toBeTruthy();
  });

  it("signing the same approved hop twice is refused (single use)", async () => {
    const { results } = await attackInsideFlow({ same });
    // The attack runs while the first hop is being signed, so that hop is already marked used.
    expect(results.same).toBe("SIGNING_TOKEN_USED");
  });

  it("a signer call outside any guarded payment is refused", async () => {
    const w = world();
    const { guard } = makeGuard(w, { guardian: fakeGuardian() });
    const disclosure = Buffer.from(JSON.stringify([randomBytes(16).toString("base64url"), { vct: "mandate.payment.1" }])).toString("base64url");
    await expect(guard.guardedSigner.sign(`${b64({ alg: "ES256", typ: "kb+sd-jwt" })}.${b64({})}`, [disclosure])).rejects.toMatchObject({
      code: "NO_PAYMENT_FLOW",
    });
    expect(w.signed).toHaveLength(0);
    expect(guard.records().at(-1)).toMatchObject({ event: "refused", code: "NO_PAYMENT_FLOW" });
  });

  it("a signature that does not verify under the agent key is refused", async () => {
    const w = world();
    const signer = { publicJwk: w.agentSigner.publicJwk, sign: async () => new Uint8Array(64) };
    const { guard } = makeGuard({ ...w, agentSigner: signer } as typeof w, { guardian: fakeGuardian({ decide: () => "ASK" }) });
    await expect(guard.pay(payInput(w))).rejects.toMatchObject({ code: "SIGNING_REFUSED" });
    // A signature may exist: the pair stays counted, not released.
    expect((await guard.ledgerEntries())[0]!.state).toBe("signing");
  });

  it("an expired signing window refuses", async () => {
    const w = world();
    let t = 0;
    const base = Date.UTC(2026, 10, 12, 12);
    let late = false;
    const guardian = fakeGuardian({ decide: () => "ASK" });
    const orig = guardian.execute.bind(guardian);
    guardian.execute = async (x) => {
      const r = await orig(x);
      late = true;
      return r;
    };
    const { guard } = makeGuard(w, { guardian, signingWindowMs: 1000, now: () => base + (late ? (t += 2000) : 0) });
    await expect(guard.pay(payInput(w))).rejects.toMatchObject({ code: "SIGNING_TOKEN_EXPIRED" });
    expect(w.signed).toHaveLength(0);
  });
});

describe("inputs cannot change while a person decides", () => {
  it("a swapped cart, instrument or challenge during the ASK wait is refused; nothing is signed", async () => {
    for (const mutate of [
      (i: ReturnType<typeof payInput>) => {
        i.checkoutJwt = checkoutJwt(world());
      },
      (i: ReturnType<typeof payInput>) => {
        i.paymentInstrument.id = "pi_swapped";
      },
      (i: ReturnType<typeof payInput>) => {
        i.credentialProviderChallenge.nonce = "n-other-0123456789";
      },
    ]) {
      const w = world();
      const input = payInput(w);
      const guardian = fakeGuardian({ decide: () => "ASK", onClaim: () => mutate(input) });
      const { guard } = makeGuard(w, { guardian });
      await expect(guard.pay(input)).rejects.toMatchObject({ code: "TERMS_CHANGED" });
      expect(w.signed).toHaveLength(0);
      expect(guard.records().some((r) => r.event === "redeemed-not-signed")).toBe(true);
    }
  });

  it("two concurrent payments with different carts each sign only their own", async () => {
    const w = world();
    const guardian = fakeGuardian({ decide: () => "ASK" });
    const { guard } = makeGuard(w, { guardian });
    const a = payInput(w);
    const b = payInput(w, { checkout: { items: [{ id: "sku_mug", title: "Coffee mug", price: 999, quantity: 2 }] } });
    const [pa, pb] = await Promise.all([guard.pay(a), guard.pay(b)]);
    expect(pa.terms.amount).toBe(1999);
    expect(pb.terms.amount).toBe(1998);
    const chains: string[] = [];
    await pa.presentCheckout(async (c) => chains.push(c));
    await pb.presentCheckout(async (c) => chains.push(c));
    const closed = chains.map((c) => {
      const hop = c.split("~~")[1]!.split("~")[1]!;
      return (JSON.parse(Buffer.from(hop, "base64url").toString()) as [string, { checkout_jwt: string }])[1].checkout_jwt;
    });
    expect(closed).toEqual([a.checkoutJwt, b.checkoutJwt]);
    expect(w.signed).toHaveLength(4);
  });
});
