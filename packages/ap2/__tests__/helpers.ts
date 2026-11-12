// Test fixtures: a fake Guardian, a stand-in Trusted Surface, merchant and
// receipt issuers, an independent chain verifier, and throwaway P-256 keys
// made fresh at runtime. Nothing here reaches a network.
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

import type { GuardianClient, GuardianInvocation } from "@odingard/guardian-sdk";

import { createAp2Guard, nodeKeySigner, type Ap2GuardConfig, type Ap2GuardStore } from "../src/index.js";

export const CONNECTION = "pcn_0123456789abcdef0123456789abcdef";
export const MERCHANT = { id: "merchant_1", name: "Example Store", website: "https://store.example.test" };
export const MERCHANT_2 = { id: "merchant_2", name: "Other Store", website: "https://other.example.test" };
export const INSTRUMENT = { id: "pi_card_1", type: "card", description: "Card ending 4242" };
export const RECEIPT_ISS_M = "https://store.example.test";
export const RECEIPT_ISS_MPP = "https://mpp.example.test";

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("base64url");

/** A throwaway P-256 key pair, made at runtime. Never a real key. */
export function testKey() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as { kty: string; crv: string; x: string; y: string };
  const publicJwk = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } as const;
  return { privateKey, publicJwk };
}

export function signJws(privateKey: KeyObject, header: Record<string, unknown>, payload: Record<string, unknown>): string {
  const input = `${b64(header)}.${b64(payload)}`;
  const sig = cryptoSign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${input}.${sig.toString("base64url")}`;
}

/** A root SD-JWT as the AP2 reference issuer makes it: delegate_payload = [one disclosed item]. */
export function issueSdJwt(
  privateKey: KeyObject,
  item: Record<string, unknown>,
  opts: { decoys?: number; header?: Record<string, unknown>; extraPayload?: Record<string, unknown> } = {},
): string {
  const disclosure = Buffer.from(JSON.stringify([randomBytes(16).toString("base64url"), item])).toString("base64url");
  const dp: unknown[] = [{ "...": sha(disclosure) }];
  for (let i = 0; i < (opts.decoys ?? 0); i += 1) dp.push({ "...": randomBytes(32).toString("base64url") });
  const jwt = signJws(privateKey, { alg: "ES256", ...(opts.header ?? {}) }, {
    delegate_payload: dp,
    _sd_alg: "sha-256",
    ...(opts.extraPayload ?? {}),
  });
  return `${jwt}~${disclosure}~`;
}

export function sdHashOf(token: string): string {
  return sha(token);
}

// --------------------------------------------------------------- the world

export type World = ReturnType<typeof world>;

/** Keys for the agent, the Trusted Surface, two merchants and two receipt issuers. */
export function world() {
  const agent = testKey();
  const ts = testKey();
  const merchant = testKey();
  const merchant2 = testKey();
  const mpp = testKey();
  const signed: string[] = [];
  const agentSigner = nodeKeySigner(agent.privateKey);
  const countingSigner = {
    publicJwk: agentSigner.publicJwk,
    async sign(input: Uint8Array) {
      signed.push(Buffer.from(input).toString("ascii"));
      log?.push("sign");
      return agentSigner.sign(input);
    },
  };
  return { agent, ts, merchant, merchant2, mpp, signed, agentSigner: countingSigner };
}

export const NOW_MS = Date.UTC(2026, 10, 12, 12, 0, 0);
export const NOW_SEC = Math.floor(NOW_MS / 1000);

export type CheckoutOpts = {
  items?: { id: string; title: string; price: number; quantity: number }[];
  merchant?: Record<string, unknown> | undefined;
  currency?: string;
  total?: number;
  extra?: Record<string, unknown>;
  status?: string;
};

export function checkoutPayload(opts: CheckoutOpts = {}) {
  const currency = opts.currency ?? "USD";
  const items = opts.items ?? [{ id: "sku_mug", title: "Coffee mug", price: 1999, quantity: 1 }];
  const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
  const total = opts.total ?? subtotal;
  return {
    id: "chk_0001",
    ...(opts.merchant === undefined && !("merchant" in opts) ? { merchant: MERCHANT } : opts.merchant ? { merchant: opts.merchant } : {}),
    line_items: items.map((i, n) => ({
      id: `li_${n + 1}`,
      item: { id: i.id, title: i.title, price: i.price },
      quantity: i.quantity,
      totals: [{ type: "total", amount: i.price * i.quantity }],
    })),
    status: opts.status ?? "ready_for_complete",
    currency,
    totals: [
      { type: "subtotal", amount: subtotal },
      { type: "total", amount: total },
    ],
    links: [{ type: "terms_of_service", url: "https://store.example.test/terms" }],
    ...(opts.extra ?? {}),
  };
}

export function checkoutJwt(w: World, opts: CheckoutOpts = {}, key = w.merchant.privateKey) {
  return signJws(key, { alg: "ES256" }, checkoutPayload(opts));
}

export type OpenOpts = {
  checkoutConstraints?: unknown[];
  paymentConstraints?: (openCheckout: string) => unknown[];
  payment?: Record<string, unknown>;
  exp?: number;
  cnf?: unknown;
  checkoutItem?: Record<string, unknown>;
  paymentItem?: (openCheckout: string) => Record<string, unknown>;
  decoys?: number;
};

/** Open mandates the stand-in Trusted Surface signs for the agent key. */
export function openMandates(w: World, opts: OpenOpts = {}) {
  const cnf = opts.cnf ?? { jwk: w.agent.publicJwk };
  const exp = opts.exp ?? NOW_SEC + 3600;
  const checkoutItem = opts.checkoutItem ?? {
    vct: "mandate.checkout.open.1",
    constraints: opts.checkoutConstraints ?? [
      { type: "checkout.allowed_merchants", allowed: [MERCHANT] },
      {
        type: "checkout.line_items",
        items: [{ id: "req_1", acceptable_items: [{ id: "sku_mug", title: "Coffee mug" }], quantity: 2 }],
      },
    ],
    cnf,
    iat: NOW_SEC - 60,
    exp,
  };
  const openCheckout = issueSdJwt(w.ts.privateKey, checkoutItem, { decoys: opts.decoys ?? 0 });
  const paymentItem = opts.paymentItem?.(openCheckout) ?? {
    vct: "mandate.payment.open.1",
    constraints: opts.paymentConstraints?.(openCheckout) ?? [
      { type: "payment.amount_range", currency: "USD", min: 0, max: 5000 },
      { type: "payment.allowed_payees", allowed: [MERCHANT] },
      { type: "payment.reference", conditional_transaction_id: sdHashOf(openCheckout) },
    ],
    cnf,
    iat: NOW_SEC - 60,
    exp,
    ...(opts.payment ?? {}),
  };
  const openPayment = issueSdJwt(w.ts.privateKey, paymentItem, { decoys: opts.decoys ?? 0 });
  return { openCheckout, openPayment };
}

export const MERCHANT_CHALLENGE = { aud: "merchant_1", nonce: "n-merchant-0123456789" };
export const CP_CHALLENGE = { aud: "credential-provider", nonce: "n-cp-0123456789abcdef" };

export function payInput(w: World, o: { open?: OpenOpts; checkout?: CheckoutOpts; extra?: Record<string, unknown> } = {}) {
  const { openCheckout, openPayment } = openMandates(w, o.open);
  return {
    openCheckoutMandate: openCheckout,
    openPaymentMandate: openPayment,
    checkoutJwt: checkoutJwt(w, o.checkout),
    paymentInstrument: { ...INSTRUMENT },
    merchantChallenge: { ...MERCHANT_CHALLENGE },
    credentialProviderChallenge: { ...CP_CHALLENGE },
    ...(o.extra ?? {}),
  };
}

// ------------------------------------------------- independent verifier

/**
 * Verifies a presented chain the way an AP2 verifier does (open SD-JWT under
 * the Trusted Surface key, then the KB-SD-JWT hop under the open mandate's
 * cnf.jwk, typ, sd_hash binding, aud and nonce). Written from the spec and
 * the reference verifier, independently of the guard's code.
 */
export function verifyChain(
  chain: string,
  tsPublicJwk: Record<string, unknown>,
  expected: { aud: string; nonce: string },
) {
  const segs = chain.split("~~");
  if (segs.length !== 2) throw new Error("expected open~~closed");
  const open = segs[0]!.endsWith("~") ? segs[0]! : `${segs[0]}~`;
  const hop = segs[1]!;
  const verifyJwt = (jwt: string, jwk: Record<string, unknown>) => {
    const [h, p, s] = jwt.split(".");
    const key = createPublicKey({ key: jwk as never, format: "jwk" });
    const ok = cryptoVerify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s!, "base64url"));
    if (!ok) throw new Error("bad signature");
    return {
      header: JSON.parse(Buffer.from(h!, "base64url").toString()) as Record<string, unknown>,
      payload: JSON.parse(Buffer.from(p!, "base64url").toString()) as Record<string, unknown>,
    };
  };
  const resolveItem = (payload: Record<string, unknown>, disclosures: string[]) => {
    const dp = payload.delegate_payload as { "...": string }[];
    const items = dp
      .map((e) => disclosures.find((d) => sha(d) === e["..."]))
      .filter((d): d is string => d !== undefined)
      .map((d) => JSON.parse(Buffer.from(d, "base64url").toString())[1] as Record<string, unknown>);
    if (items.length !== 1) throw new Error("expected one delegate item");
    return items[0]!;
  };
  const openParts = open.split("~");
  const openJwt = verifyJwt(openParts[0]!, tsPublicJwk);
  const openItem = resolveItem(openJwt.payload, openParts.slice(1, -1));
  const cnfJwk = (openItem.cnf as { jwk: Record<string, unknown> }).jwk;
  if (!hop.endsWith("~")) throw new Error("hop must end with ~");
  const hopParts = hop.split("~");
  const hopJwt = verifyJwt(hopParts[0]!, cnfJwk);
  if (hopJwt.header.typ !== "kb+sd-jwt") throw new Error("typ");
  if (hopJwt.payload.sd_hash !== sha(open)) throw new Error("sd_hash");
  if (hopJwt.payload.aud !== expected.aud || hopJwt.payload.nonce !== expected.nonce) throw new Error("aud/nonce");
  if (typeof hopJwt.payload.iat !== "number") throw new Error("iat");
  const closed = resolveItem(hopJwt.payload, hopParts.slice(1, -1));
  if ("cnf" in closed) throw new Error("terminal hop must not carry cnf");
  return { open: openItem, closed, closedJwt: hopParts[0]!, reference: sha(hopParts[0]!) };
}

/** A receipt the merchant or the processor signs. */
export function receipt(key: KeyObject, iss: string, body: Record<string, unknown>) {
  return signJws(key, { alg: "ES256" }, { iss, iat: NOW_SEC, ...body });
}

// ------------------------------------------------------------- Guardian

let log: string[] | undefined;
/** One shared order log: fake Guardian calls and agent-key signatures. */
export function orderLog(): string[] {
  log = [];
  return log;
}

export type FakeGuardianOptions = {
  decide?: (inv: GuardianInvocation) => "ALLOW" | "ASK" | { deny: string } | "THROW" | "HANG" | "MALFORMED" | "UNAVAILABLE";
  person?: "approve" | "deny" | "never";
  claimsBeforeDecision?: number;
  executeFails?: string;
  executeThrows?: boolean;
  executeOutcomeUnknown?: boolean;
  revokeAfterDecision?: boolean;
  receiptApproval?: "approved" | "consumed" | "pending" | null;
  /** Called on each claim (to mutate inputs while a person decides). */
  onClaim?: () => void;
};

export type FakeGuardian = GuardianClient & {
  calls: { op: string; invocation?: GuardianInvocation; requestId?: string }[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requests: any[];
};

export function fakeGuardian(opts: FakeGuardianOptions = {}): FakeGuardian {
  let counter = 0;
  const calls: FakeGuardian["calls"] = [];
  const requests: FakeGuardian["requests"] = [];
  const revoked = new Set<string>();
  const state = new Map<string, { inv: GuardianInvocation; decision: "ALLOW" | "ASK"; claims: number; token?: string; used: boolean }>();
  const person = opts.person ?? "approve";
  const g: FakeGuardian = {
    calls,
    requests,
    async request(inv) {
      calls.push({ op: "request", invocation: inv });
      requests.push(JSON.parse(JSON.stringify(inv)));
      log?.push("request");
      const d = opts.decide?.(inv) ?? "ALLOW";
      if (d === "THROW") throw new Error("network down");
      if (d === "HANG") return new Promise(() => undefined);
      if (d === "MALFORMED") return { ok: "yes", decision: 7 } as never;
      if (d === "UNAVAILABLE") return { ok: false, reasonCode: "SERVICE_UNAVAILABLE" };
      counter += 1;
      const requestId = `req_${String(counter).padStart(12, "0")}`;
      if (typeof d === "object" && "deny" in d) return { ok: false, reasonCode: d.deny, requestId };
      if (d === "ALLOW") {
        const token = `cap_${requestId}`;
        state.set(requestId, { inv, decision: "ALLOW", claims: 0, token, used: false });
        if (opts.revokeAfterDecision) revoked.add(requestId);
        return { ok: true, requestId, decision: "ALLOW", capabilityToken: token };
      }
      state.set(requestId, { inv, decision: "ASK", claims: 0, used: false });
      return { ok: true, requestId, decision: "ASK", reasonCode: "APPROVAL_REQUIRED" };
    },
    async claim(requestId) {
      calls.push({ op: "claim", requestId });
      log?.push("claim");
      opts.onClaim?.();
      const s = state.get(requestId);
      if (!s) return { ok: false, reasonCode: "NOT_FOUND" };
      s.claims += 1;
      if (person === "never" || s.claims <= (opts.claimsBeforeDecision ?? 1)) {
        return { ok: false, reasonCode: "APPROVAL_PENDING", requestId };
      }
      if (person === "deny") return { ok: true, requestId, decision: "DENY", reasonCode: "APPROVAL_DENIED" };
      s.token = `cap_${requestId}`;
      if (opts.revokeAfterDecision) revoked.add(requestId);
      return { ok: true, requestId, decision: "ALLOW", capabilityToken: s.token };
    },
    async execute({ requestId, capabilityToken }) {
      calls.push({ op: "execute", requestId });
      log?.push("execute");
      if (opts.executeThrows) throw new Error("connection reset");
      if (opts.executeOutcomeUnknown) return { ok: false, reasonCode: "HTTP_502", outcomeUnknown: true } as never;
      const s = state.get(requestId);
      if (opts.executeFails) return { ok: false, reasonCode: opts.executeFails };
      if (revoked.has(requestId)) return { ok: false, reasonCode: "CAPABILITY_REVOKED" };
      if (!s || s.token !== capabilityToken) return { ok: false, reasonCode: "CAPABILITY_INVALID" };
      if (s.used) return { ok: false, reasonCode: "CAPABILITY_USED" };
      s.used = true;
      return {
        ok: true,
        receipt: {
          schemaVersion: 1,
          requestId: requestId as never,
          receiptReference: `att_${requestId.slice(4)}` as never,
          status: "sent-verified",
        },
      };
    },
    async portableReceipt(requestId) {
      calls.push({ op: "portableReceipt", requestId });
      const s = state.get(requestId);
      if (!s) return { ok: false, reasonCode: "NOT_FOUND" };
      const inv = s.inv as { toolName: string; arguments: unknown; connectionId: string };
      const approved =
        opts.receiptApproval !== undefined
          ? opts.receiptApproval
          : s.decision === "ASK" && person === "approve"
            ? s.used
              ? "consumed"
              : "approved"
            : null;
      return {
        ok: true,
        receipt: {
          format: "greceipt.v1",
          subject: { requestId },
          action: {
            requestId,
            action: "tool.invoke",
            materialParameters: {
              schema: "odingard.guardian.tool.invoke.v1",
              connectionId: inv.connectionId,
              toolName: inv.toolName,
              arguments: inv.arguments,
            },
          },
          decision: { decision: s.decision },
          approval: approved ? { state: approved } : null,
        },
      } as never;
    },
    async receipts() {
      return { ok: false, reasonCode: "NOT_USED" } as never;
    },
  } as FakeGuardian;
  return g;
}

/** A test store with real compare-and-set; can be told to fail. */
export function testStore() {
  const data = new Map<string, { value: string; version: string }>();
  let v = 0;
  const s = {
    failing: false,
    data,
    async get(key: string) {
      if (s.failing) throw new Error("store down");
      return data.get(key) ?? null;
    },
    async compareAndSet(key: string, expected: string | null, value: string) {
      if (s.failing) throw new Error("store down");
      await new Promise((r) => setTimeout(r, 0));
      const cur = data.get(key) ?? null;
      if ((cur?.version ?? null) !== expected) return false;
      v += 1;
      data.set(key, { value, version: String(v) });
      return true;
    },
  };
  return s satisfies Ap2GuardStore;
}

export function makeGuard(w: World, overrides: Partial<Ap2GuardConfig> & { guardian: GuardianClient }) {
  let clock = NOW_MS;
  const guard = createAp2Guard({
    connectionId: CONNECTION,
    agentSigner: w.agentSigner,
    trustedSurfaceKeys: [w.ts.publicJwk],
    merchantKeys: { [MERCHANT.id]: [w.merchant.publicJwk], [MERCHANT_2.id]: [w.merchant2.publicJwk] },
    receiptIssuerKeys: { checkout: { [RECEIPT_ISS_M]: [w.merchant.publicJwk] }, payment: { [RECEIPT_ISS_MPP]: [w.mpp.publicJwk] } },
    limits: [{ currency: "USD", askAbove: 2500, max: 20000 }],
    store: testStore(),
    claimPollIntervalMs: 2,
    now: () => clock,
    ...overrides,
  });
  return {
    guard,
    advance(ms: number) {
      clock += ms;
    },
    setNow(ms: number) {
      clock = ms;
    },
  };
}

/** Approves the first use of an open mandate (it always needs a person) and lets rules ALLOW repeats. */
export const toolOf = (inv: GuardianInvocation) => ("toolName" in inv ? inv.toolName : "");
export const askFirstUse = (inv: GuardianInvocation) =>
  toolOf(inv) === "ap2.pay.above_cap" ? ("ASK" as const) : ("ALLOW" as const);
