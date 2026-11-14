// Test fixtures: a fake Guardian, a fake Link (test mode, in memory) and a
// test store. Nothing here reaches a network or a real Link account.
import type { GuardianClient, GuardianInvocation } from "@odingard/guardian-sdk";

import {
  createLinkGuard,
  type LinkAdapter,
  type LinkCreateInput,
  type LinkGuardConfig,
  type LinkGuardStore,
  type LinkSpendRequestView,
  type LinkSpendTerms,
  type LinkUpdateInput,
} from "../src/index.js";

export const CONNECTION = "pcn_0123456789abcdef0123456789abcdef";
/** Link's documented test card number (README: test mode). */
export const TEST_CARD_NUMBER = "4000009990001984";
export const TEST_CVC = "321";

export const CONTEXT =
  "Buying one copy of 'Working in Public' from press.stripe.com for the user, who asked for it in the shopping chat today.";

export function terms(overrides: Partial<Record<keyof LinkSpendTerms, unknown>> = {}): LinkSpendTerms {
  return {
    merchantName: "Stripe Press",
    merchantUrl: "https://press.stripe.com",
    amount: 3500,
    currency: "usd",
    lineItems: [{ name: "Working in Public", quantity: 1, unitAmount: 3500 }],
    totals: [{ type: "total", displayText: "Total", amount: 3500 }],
    context: CONTEXT,
    ...overrides,
  } as LinkSpendTerms;
}

let log: string[] | undefined;
/** One shared order log: fake Guardian and fake Link calls. */
export function orderLog(): string[] {
  log = [];
  return log;
}

// ------------------------------------------------------------- Guardian

export type FakeGuardianOptions = {
  decide?: (inv: GuardianInvocation) => "ALLOW" | "ASK" | { deny: string } | "THROW";
  person?: "approve" | "deny" | "never";
  claimsBeforeDecision?: number;
  executeFails?: string;
  /** Serve the receipt of another request (a replayed approval), by request id. */
  receiptOf?: (requestId: string) => string;
  /** Change the arguments the receipt says were approved. */
  receiptArguments?: (args: Record<string, unknown>) => Record<string, unknown>;
  /** Change the amount declaration the receipt says was approved. */
  receiptAmountArgument?: unknown;
  /** Answer claims for another request id. */
  claimAnswersFor?: (requestId: string) => string;
  /** Hand out this request id (and capability) again: a replayed decision. */
  reuseRequestId?: string;
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
  const state = new Map<
    string,
    { inv: GuardianInvocation; decision: "ALLOW" | "ASK"; claims: number; token?: string; used: boolean }
  >();
  const person = opts.person ?? "approve";
  const g: FakeGuardian = {
    calls,
    requests,
    async request(inv) {
      calls.push({ op: "request", invocation: inv });
      requests.push(JSON.parse(JSON.stringify(inv)));
      log?.push("guardian.request");
      const d = opts.decide?.(inv) ?? "ALLOW";
      if (d === "THROW") throw new Error("network down");
      counter += 1;
      const requestId = opts.reuseRequestId ?? `req_${String(counter).padStart(12, "0")}`;
      if (typeof d === "object") return { ok: false, reasonCode: d.deny, requestId };
      const token = `cap_${requestId}`;
      if (d === "ALLOW") {
        // A replayed decision keeps its "used" flag only in the real Guardian;
        // this fake hands out a fresh capability, so the guard's ledger is
        // what must refuse it.
        state.set(requestId, { inv, decision: "ALLOW", claims: 0, token, used: false });
        return { ok: true, requestId, decision: "ALLOW", capabilityToken: token };
      }
      state.set(requestId, { inv, decision: "ASK", claims: 0, used: false });
      return { ok: true, requestId, decision: "ASK", reasonCode: "APPROVAL_REQUIRED" };
    },
    async claim(requestId) {
      calls.push({ op: "claim", requestId });
      log?.push("guardian.claim");
      const s = state.get(requestId);
      if (!s) return { ok: false, reasonCode: "NOT_FOUND" };
      s.claims += 1;
      if (person === "never" || s.claims <= (opts.claimsBeforeDecision ?? 1)) {
        return { ok: false, reasonCode: "APPROVAL_PENDING", requestId };
      }
      const answeredId = opts.claimAnswersFor?.(requestId) ?? requestId;
      if (person === "deny") return { ok: true, requestId: answeredId, decision: "DENY", reasonCode: "APPROVAL_DENIED" };
      s.token = `cap_${requestId}`;
      return { ok: true, requestId: answeredId, decision: "ALLOW", capabilityToken: s.token };
    },
    async execute({ requestId, capabilityToken }) {
      calls.push({ op: "execute", requestId });
      log?.push("guardian.execute");
      const s = state.get(requestId);
      if (opts.executeFails) return { ok: false, reasonCode: opts.executeFails };
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
      log?.push("guardian.receipt");
      const requestId = opts.receiptOf?.(asked) ?? asked;
      const s = state.get(requestId);
      if (!s) return { ok: false, reasonCode: "NOT_FOUND" };
      const inv = s.inv as {
        toolName: string;
        arguments: Record<string, unknown>;
        connectionId: string;
        amountArgument?: unknown;
      };
      const approved = s.decision === "ASK" && person === "approve" ? (s.used ? "consumed" : "approved") : null;
      const args = opts.receiptArguments ? opts.receiptArguments(structuredClone(inv.arguments)) : inv.arguments;
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
              arguments: args,
              ...(opts.receiptAmountArgument !== undefined
                ? { amountArgument: opts.receiptAmountArgument }
                : inv.amountArgument !== undefined
                  ? { amountArgument: inv.amountArgument }
                  : {}),
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

// ------------------------------------------------------------- store

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
  return s satisfies LinkGuardStore;
}

// ------------------------------------------------------------- Link

type StoredRequest = {
  -readonly [K in keyof LinkSpendRequestView]: LinkSpendRequestView[K];
} & { test: boolean; idempotencyKey: string };

export type FakeLinkOptions = {
  policy?: "none" | "present" | "unknown" | "throw";
  /** Link creates something other than what was asked (adapter or Link misbehaving). */
  createAs?: (input: LinkCreateInput) => Partial<LinkSpendRequestView>;
  /** Link updates to something other than what was asked. */
  updateAs?: (input: LinkUpdateInput) => Partial<LinkSpendRequestView>;
  /** Status Link gives a new request. Default "created". */
  createdStatus?: string;
  /** Throw from create (outcome unknown), after storing the request or before. */
  createThrows?: "after-create" | "before-create";
  /** Return this id from create (for example one another decision holds). */
  createReturnsId?: string;
  /** What the person does in Link after approval is requested. Default nothing (stays pending). */
  personInLink?: "approve" | "deny" | "nothing";
  /** Return another request with the card. */
  cardRequestAs?: (view: LinkSpendRequestView) => Partial<LinkSpendRequestView>;
};

export type FakeLink = LinkAdapter & {
  calls: { op: string; id?: string; input?: unknown }[];
  requests: Map<string, StoredRequest>;
  /** Someone with the Link login changes the request outside the guard. */
  changeOutside(id: string, patch: Partial<LinkSpendRequestView>): void;
  /** The person approves in the Link app. */
  approve(id: string): void;
  setPolicy(p: NonNullable<FakeLinkOptions["policy"]>): void;
  cardsRead: number;
};

export function fakeLink(opts: FakeLinkOptions = {}): FakeLink {
  let counter = 0;
  let policy = opts.policy ?? "none";
  const calls: FakeLink["calls"] = [];
  const requests = new Map<string, StoredRequest>();
  const byKey = new Map<string, string>();
  const view = (r: StoredRequest): LinkSpendRequestView => {
    const { test: _t, idempotencyKey: _k, ...rest } = r;
    return structuredClone(rest);
  };
  const link: FakeLink = {
    calls,
    requests,
    cardsRead: 0,
    changeOutside(id, patch) {
      Object.assign(requests.get(id)!, patch);
    },
    approve(id) {
      requests.get(id)!.status = "approved";
    },
    setPolicy(p) {
      policy = p;
    },
    async approvalPolicy() {
      calls.push({ op: "approvalPolicy" });
      log?.push("link.policy");
      if (policy === "throw") throw new Error("link down");
      return policy === "unknown" ? { state: "unknown" } : { state: policy };
    },
    async createSpendRequest(input) {
      calls.push({ op: "create", input: structuredClone(input) });
      log?.push("link.create");
      if (opts.createThrows === "before-create") throw new Error("timeout");
      const existing = byKey.get(input.idempotencyKey);
      if (existing) return view(requests.get(existing)!);
      counter += 1;
      const id = opts.createReturnsId ?? `lsrq_test_${String(counter).padStart(6, "0")}`;
      const stored: StoredRequest = {
        id,
        status: opts.createdStatus ?? "created",
        merchantName: input.merchantName,
        merchantUrl: input.merchantUrl,
        context: input.context,
        amount: input.amount,
        currency: input.currency,
        credentialType: input.credentialType,
        lineItems: input.lineItems.map((l) => ({ ...l })),
        totals: input.totals.map((t) => ({ ...t })),
        test: input.test,
        idempotencyKey: input.idempotencyKey,
        ...(opts.createAs?.(input) ?? {}),
      };
      if (!requests.has(id)) requests.set(id, stored);
      byKey.set(input.idempotencyKey, id);
      if (opts.createThrows === "after-create") throw new Error("timeout");
      return view(requests.get(id)!);
    },
    async updateSpendRequest(id, input) {
      calls.push({ op: "update", id, input: structuredClone(input) });
      log?.push("link.update");
      const r = requests.get(id);
      if (!r) throw new Error("not found");
      Object.assign(r, {
        merchantUrl: input.merchantUrl,
        amount: input.amount,
        currency: input.currency,
        lineItems: input.lineItems.map((l) => ({ ...l })),
        totals: input.totals.map((t) => ({ ...t })),
        ...(opts.updateAs?.(input) ?? {}),
      });
      return view(r);
    },
    async requestApproval(id) {
      calls.push({ op: "requestApproval", id });
      log?.push("link.requestApproval");
      const r = requests.get(id);
      if (!r) throw new Error("not found");
      r.status = "pending_approval";
      if (opts.personInLink === "approve") r.status = "approved";
      if (opts.personInLink === "deny") r.status = "denied";
    },
    async retrieveSpendRequest(id) {
      calls.push({ op: "retrieve", id });
      log?.push("link.retrieve");
      const r = requests.get(id);
      if (!r) throw new Error("not found");
      return view(r);
    },
    async readCard(id) {
      calls.push({ op: "readCard", id });
      log?.push("link.readCard");
      const r = requests.get(id);
      if (!r || r.status !== "approved" || !r.test) throw new Error("no card");
      link.cardsRead += 1;
      const v = view(r);
      return {
        request: { ...v, ...(opts.cardRequestAs?.(v) ?? {}) },
        card: { number: TEST_CARD_NUMBER, cvc: TEST_CVC, expMonth: 12, expYear: 2030, brand: "visa" },
      };
    },
    async cancelSpendRequest(id) {
      calls.push({ op: "cancel", id });
      log?.push("link.cancel");
      const r = requests.get(id);
      if (r) r.status = "canceled";
    },
  };
  return link;
}

export const ops = (link: FakeLink) => link.calls.map((c) => c.op);

export function makeGuard(
  overrides: Partial<LinkGuardConfig> & { guardian?: GuardianClient; link?: LinkAdapter } = {},
) {
  const guardian = (overrides.guardian as FakeGuardian | undefined) ?? fakeGuardian();
  const link = (overrides.link as FakeLink | undefined) ?? fakeLink();
  const guard = createLinkGuard({
    connectionId: CONNECTION,
    store: testStore(),
    limits: [{ currency: "usd", askAbove: 5_000, max: 20_000 }],
    claimPollIntervalMs: 2,
    linkPollIntervalMs: 2,
    ...overrides,
    guardian,
    link,
  });
  return { guard, guardian, link };
}
