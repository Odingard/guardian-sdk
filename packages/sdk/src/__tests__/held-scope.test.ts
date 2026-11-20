import { describe, expect, it } from "vitest";

import {
  createGuardianContext,
  GuardianApprovalPending,
  resolveHeldScope,
  runThroughGuardian,
  SCOPE_UNKNOWN,
  scopeHeldRequests,
  type GuardianClient,
  type GuardianContext,
  type GuardianInvocation,
  type HeldScope,
} from "../index.js";

/**
 * Held requests are scoped per session: `scopeHeldRequests(ctx, scope)`
 * around the real `runThroughGuardian`, with a stand-in Guardian client
 * that holds every request under its own id and approves each claim.
 */

const CONNECTION = "pcn_0123456789abcdef0123456789abcdef";

function holdingClient() {
  const calls: string[] = [];
  const requested: GuardianInvocation[] = [];
  const client: GuardianClient = {
    async request(invocation) {
      requested.push(invocation);
      const requestId = `req_${requested.length}`;
      calls.push(`request:${requestId}`);
      return { ok: true, requestId, decision: "ASK" };
    },
    async claim(requestId) {
      calls.push(`claim:${requestId}`);
      return { ok: true, requestId, decision: "ALLOW", capabilityToken: "cap" };
    },
    async execute({ requestId }) {
      calls.push(`execute:${requestId}`);
      return {
        ok: true,
        receipt: {
          schemaVersion: 1,
          requestId,
          receiptReference: "att_0123456789abcdef",
          status: "sent-verified",
        } as never,
      };
    },
    async portableReceipt() {
      return { ok: false, reasonCode: "NOT_FOUND" };
    },
    async receipts(requestId) {
      return { ok: true, requestId, receipts: [] };
    },
  };
  return { client, calls, requested };
}

function setup(onAsk: "result" | "throw" = "result") {
  const guardian = holdingClient();
  const ran: HeldScope[] = [];
  const ctx = createGuardianContext({
    client: guardian.client,
    connectionId: CONNECTION,
    mode: "inProcess",
    onAsk,
  });
  const refund = (scope: HeldScope) =>
    runThroughGuardian(
      scopeHeldRequests(ctx, scope),
      "refund_order",
      { orderId: "o42", amountCents: 500 },
      () => {
        ran.push(scope);
        return "refunded";
      },
    );
  return { ...guardian, ctx, ran, refund };
}

const heldId = (out: unknown) =>
  (out as { guardian: { requestId: string } }).guardian.requestId;

describe("scopeHeldRequests", () => {
  it("a held request is claimed only under the same scope", async () => {
    const { refund, calls, ran } = setup();
    expect(heldId(await refund("alice"))).toBe("req_1");
    // The identical call in another session is a request of its own.
    expect(heldId(await refund("bob"))).toBe("req_2");
    expect(ran).toEqual([]);
    // Each session's repeat call claims its own request and runs once.
    expect(await refund("alice")).toBe("refunded");
    expect(await refund("bob")).toBe("refunded");
    expect(calls).toEqual([
      "request:req_1",
      "request:req_2",
      "claim:req_1",
      "execute:req_1",
      "claim:req_2",
      "execute:req_2",
    ]);
    expect(ran).toEqual(["alice", "bob"]);
  });

  it("holds in the default throw mode too", async () => {
    const { refund, calls } = setup("throw");
    await expect(refund("alice")).rejects.toBeInstanceOf(
      GuardianApprovalPending,
    );
    await expect(refund("bob")).rejects.toBeInstanceOf(GuardianApprovalPending);
    expect(await refund("alice")).toBe("refunded");
    expect(calls).toEqual([
      "request:req_1",
      "request:req_2",
      "claim:req_1",
      "execute:req_1",
    ]);
  });

  it("does not send the scope to Guardian, and keeps only its digest", async () => {
    const { refund, requested, ctx } = setup();
    await refund("alice@example.test");
    await refund(undefined);
    expect(requested[0]).toEqual(requested[1]);
    expect(JSON.stringify(requested)).not.toContain("alice");
    expect([...ctx.heldInvocations!.keys()].join()).not.toContain("alice");
  });

  it("without a scope the context is used as it is, as before", async () => {
    const { refund, calls, ctx } = setup();
    expect(scopeHeldRequests(ctx, undefined)).toBe(ctx);
    await refund(undefined);
    expect(await refund(undefined)).toBe("refunded");
    expect(calls).toEqual(["request:req_1", "claim:req_1", "execute:req_1"]);
  });

  it("a scoped call and an unscoped call do not claim each other's request", async () => {
    const { refund, calls } = setup();
    await refund(undefined);
    expect(heldId(await refund("alice"))).toBe("req_2");
    expect(await refund(undefined)).toBe("refunded");
    expect(calls).toEqual([
      "request:req_1",
      "request:req_2",
      "claim:req_1",
      "execute:req_1",
    ]);
  });

  it("SCOPE_UNKNOWN never remembers a held request", async () => {
    const { refund, calls, ctx, ran } = setup();
    expect(heldId(await refund(SCOPE_UNKNOWN))).toBe("req_1");
    expect(heldId(await refund(SCOPE_UNKNOWN))).toBe("req_2");
    expect(ctx.heldInvocations!.size).toBe(0);
    expect(calls).toEqual(["request:req_1", "request:req_2"]);
    expect(ran).toEqual([]);
  });

  it("an empty scope names no session: it is never the shared or a common scope", async () => {
    const { refund, calls, ctx } = setup();
    expect(heldId(await refund(""))).toBe("req_1");
    expect(heldId(await refund(""))).toBe("req_2");
    expect(ctx.heldInvocations!.size).toBe(0);
    expect(calls).toEqual(["request:req_1", "request:req_2"]);
  });

  it("resume() of a pending approval claims its own request under any scope", async () => {
    const { refund, calls, ran } = setup("throw");
    const pending = (await refund("alice").catch(
      (e) => e,
    )) as GuardianApprovalPending;
    await refund("bob").catch(() => undefined);
    const resumed = await pending.resume();
    expect(resumed.output).toBe("refunded");
    expect(calls.slice(2)).toEqual(["claim:req_1", "execute:req_1"]);
    expect(ran).toEqual(["alice"]);
    // Claimed: the same call in that scope is a new request now.
    await refund("alice").catch(() => undefined);
    expect(calls.at(-1)).toBe("request:req_3");
  });

  it("shares everything else with the context", () => {
    const { ctx } = setup();
    const scoped: GuardianContext = scopeHeldRequests(ctx, "alice");
    expect(scoped.options).toBe(ctx.options);
    expect(scoped.ensured).toBe(ctx.ensured);
    expect(scoped.heldSetup).toBe(ctx.heldSetup);
  });

  it("refuses a scope that is not a string", () => {
    const { ctx } = setup();
    expect(() => scopeHeldRequests(ctx, 7 as never)).toThrow(TypeError);
  });
});

describe("resolveHeldScope", () => {
  it("keeps a non-empty string and SCOPE_UNKNOWN", () => {
    expect(resolveHeldScope(() => "thread-1")).toBe("thread-1");
    expect(resolveHeldScope(() => SCOPE_UNKNOWN)).toBe(SCOPE_UNKNOWN);
  });

  it("fails to the strict side", () => {
    for (const read of [
      () => undefined,
      () => null,
      () => "",
      () => 7,
      () => ({ user: "alice" }),
      () => {
        throw new Error("no session");
      },
    ]) {
      expect(resolveHeldScope(read)).toBe(SCOPE_UNKNOWN);
    }
  });
});
