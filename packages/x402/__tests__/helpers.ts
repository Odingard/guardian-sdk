// Test fixtures: a fake Guardian, a fake 402 server and throwaway Base
// Sepolia keys made fresh for each test. Nothing here reaches a network.
import type { GuardianClient, GuardianInvocation } from "@odingard/guardian-sdk";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";

import {
  createX402Guard,
  type X402GuardConfig,
  type X402GuardStore,
} from "../src/index.js";

export const SEPOLIA = "eip155:84532" as const;
export const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const CONNECTION = "pcn_0123456789abcdef0123456789abcdef";
export const MERCHANT = "0x1111111111111111111111111111111111111111";
export const MERCHANT_2 = "0x2222222222222222222222222222222222222222";

/** A throwaway Base Sepolia test key, made fresh, never a real key. */
export function testWallet() {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const signed: unknown[] = [];
  const signer = {
    address: account.address,
    async signTypedData(message: Parameters<typeof account.signTypedData>[0]) {
      signed.push(message);
      log?.push("sign");
      return account.signTypedData(message as never);
    },
  };
  return { privateKey, account, signer, signed };
}

let log: string[] | undefined;
/** One shared order log: fake Guardian calls and wallet signatures. */
export function orderLog(): string[] {
  log = [];
  return log;
}

export function accept(overrides: Record<string, unknown> = {}) {
  return {
    scheme: "exact",
    network: SEPOLIA,
    asset: USDC_SEPOLIA,
    amount: "10000",
    payTo: MERCHANT,
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
    ...overrides,
  };
}

export function v1Accept(resource: string, overrides: Record<string, unknown> = {}) {
  return {
    scheme: "exact",
    network: "base-sepolia",
    maxAmountRequired: "10000",
    resource,
    description: "",
    mimeType: "application/json",
    outputSchema: {},
    payTo: MERCHANT,
    maxTimeoutSeconds: 60,
    asset: USDC_SEPOLIA,
    extra: { name: "USDC", version: "2" },
    ...overrides,
  };
}

export function paymentRequired(url: string, accepts: unknown[], version = 2) {
  return { x402Version: version, resource: { url }, accepts };
}

// ------------------------------------------------------------- Guardian

export type FakeGuardianOptions = {
  /** Decision for each request (default ALLOW). */
  decide?: (inv: GuardianInvocation) =>
    | "ALLOW"
    | "ASK"
    | { deny: string }
    | { askAsForbidden: true }
    | "THROW"
    | "HANG"
    | "MALFORMED"
    | "UNAVAILABLE";
  /** What the person does on an ASK: approve after n claims, deny, or nothing. */
  person?: "approve" | "deny" | "never";
  claimsBeforeDecision?: number;
  /** Make execute fail with this reason code. */
  executeFails?: string;
  /** Mark the grant revoked after the decision (execute then fails). */
  revokeAfterDecision?: boolean;
  /**
   * Receipt approval state override. By default an approved ASK reads
   * "approved" before execute and "consumed" after, as Guardian records it.
   */
  receiptApproval?: "approved" | "consumed" | "pending" | "denied" | "expired" | null;
  /** Serve the receipt of another request (a replay), by request id. */
  receiptOf?: (requestId: string) => string;
};

export type FakeGuardian = GuardianClient & {
  calls: { op: string; invocation?: GuardianInvocation; requestId?: string }[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requests: any[];
  revoked: Set<string>;
};

export function fakeGuardian(opts: FakeGuardianOptions = {}): FakeGuardian {
  let counter = 0;
  const calls: FakeGuardian["calls"] = [];
  const requests: FakeGuardian["requests"] = [];
  const revoked = new Set<string>();
  const state = new Map<
    string,
    { inv: GuardianInvocation; decision: "ALLOW" | "ASK"; claims: number; token?: string; used: boolean }
  >();
  const person = opts.person ?? "approve";
  const g: FakeGuardian = {
    calls,
    requests,
    revoked,
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
      if (typeof d === "object" && "deny" in d) {
        return { ok: false, reasonCode: d.deny, requestId };
      }
      if (typeof d === "object" && "askAsForbidden" in d) {
        state.set(requestId, { inv, decision: "ASK", claims: 0, used: false });
        return { ok: false, reasonCode: "APPROVAL_REQUIRED", requestId };
      }
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
      const s = state.get(requestId);
      if (!s) return { ok: false, reasonCode: "NOT_FOUND" };
      s.claims += 1;
      if (person === "never" || s.claims <= (opts.claimsBeforeDecision ?? 1)) {
        return { ok: false, reasonCode: "APPROVAL_PENDING", requestId };
      }
      if (person === "deny") return { ok: true, requestId, decision: "DENY", reasonCode: "APPROVAL_DENIED" };
      s.token = `cap_${requestId}`;
      return { ok: true, requestId, decision: "ALLOW", capabilityToken: s.token };
    },
    async execute({ requestId, capabilityToken }) {
      calls.push({ op: "execute", requestId });
      log?.push("execute");
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
    async portableReceipt(asked) {
      calls.push({ op: "portableReceipt", requestId: asked });
      const requestId = opts.receiptOf?.(asked) ?? asked;
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
      };
    },
    async receipts() {
      return { ok: false, reasonCode: "NOT_USED" };
    },
  };
  return g;
}

// --------------------------------------------------------------- store

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
  return s satisfies X402GuardStore;
}

// -------------------------------------------------------- 402 server

export type FakeServerOptions = {
  /** PaymentRequired per request (by URL). */
  terms: (url: string, attempt: number) => Record<string, unknown> | string;
  /** "v2" header (default) or "v1" body. */
  version?: 1 | 2;
  settle?: (payload: PaymentPayload) => { success: boolean; errorReason?: string };
  /** Answer the paid request with a 402 again (corrective). */
  answerPaidWith402?: boolean;
  /** Pretend the request was redirected to this URL. */
  redirectTo?: string;
};

export function fakeServer(opts: FakeServerOptions) {
  const seen: { url: string; method: string; headers: Record<string, string> }[] = [];
  const paid: PaymentPayload[] = [];
  let attempt = 0;
  const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const req = new Request(input, init);
    const headers = Object.fromEntries(req.headers.entries());
    seen.push({ url: req.url, method: req.method, headers });
    const finalUrl = opts.redirectTo ?? req.url;
    const sig = req.headers.get("PAYMENT-SIGNATURE") ?? req.headers.get("X-PAYMENT");
    let decoded: PaymentPayload | null = null;
    try {
      decoded = sig ? decodePaymentSignatureHeader(sig) : null;
    } catch {
      decoded = null;
    }
    let res: Response;
    if (decoded && !opts.answerPaidWith402) {
      const payload = decoded;
      paid.push(payload);
      const outcome = opts.settle?.(payload) ?? { success: true };
      const settle = {
        success: outcome.success,
        ...(outcome.errorReason ? { errorReason: outcome.errorReason } : {}),
        transaction: outcome.success ? `0x${"ab".repeat(32)}` : "",
        network: SEPOLIA,
      };
      const name = payload.x402Version === 1 ? "X-PAYMENT-RESPONSE" : "PAYMENT-RESPONSE";
      res = new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { [name]: encodePaymentResponseHeader(settle as never) },
      });
    } else {
      if (decoded) paid.push(decoded);
      attempt += 1;
      const t = opts.terms(finalUrl, attempt);
      if ((opts.version ?? 2) === 1) {
        res = new Response(typeof t === "string" ? t : JSON.stringify(t), {
          status: 402,
          headers: { "content-type": "application/json" },
        });
      } else {
        res = new Response("{}", {
          status: 402,
          headers: {
            "PAYMENT-REQUIRED": typeof t === "string" ? t : encodePaymentRequiredHeader(t as never),
          },
        });
      }
    }
    Object.defineProperty(res, "url", { value: finalUrl });
    return res;
  };
  return { fetch: fetchImpl as typeof fetch, seen, paid };
}

/** Checks a payment header's signature locally (no RPC). */
export async function signatureValid(payload: PaymentPayload, version: 1 | 2 = 2) {
  const auth = (payload.payload as { authorization: Record<string, string>; signature: `0x${string}` });
  const a = auth.authorization;
  return verifyTypedData({
    address: a.from as `0x${string}`,
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
      from: a.from as `0x${string}`,
      to: a.to as `0x${string}`,
      value: BigInt(a.value),
      validAfter: BigInt(a.validAfter),
      validBefore: BigInt(a.validBefore),
      nonce: a.nonce as `0x${string}`,
    },
    signature: auth.signature,
  }).then((ok) => ok && version > 0);
}

export function makeGuard(
  overrides: Partial<X402GuardConfig> & { guardian: GuardianClient },
  wallet = testWallet(),
) {
  const guard = createX402Guard({
    connectionId: CONNECTION,
    signer: wallet.signer,
    store: testStore(),
    limits: [{ network: SEPOLIA, asset: USDC_SEPOLIA, askAbove: "50000", max: "500000" }],
    claimPollIntervalMs: 2,
    ...overrides,
  });
  return { guard, wallet };
}
