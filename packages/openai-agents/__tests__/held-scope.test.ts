import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RunContext } from "@openai/agents";
import type { GuardianClient } from "@odingard/guardian-sdk";
import { SCOPE_UNKNOWN } from "@odingard/guardian-sdk";
import { createGuardianTool } from "../src/index.js";

/**
 * Held requests are scoped per session. One tool serves several runs; with
 * the `scope` option a held call is claimed only by the same call in the
 * same scope (for example a user id in the run's context).
 */

/** Holds every request under its own id; a claim is approved. */
function holdingClient() {
  const calls: string[] = [];
  let count = 0;
  const client = {
    async request() {
      count += 1;
      calls.push(`request:req_${count}`);
      return { ok: true, requestId: `req_${count}`, decision: "ASK" };
    },
    async claim(requestId: string) {
      calls.push(`claim:${requestId}`);
      return { ok: true, requestId, decision: "ALLOW", capabilityToken: "cap" };
    },
    async execute({ requestId }: { requestId: string }) {
      calls.push(`execute:${requestId}`);
      return { ok: true, receipt: { requestId, status: "sent-verified" } };
    },
    async receipts(requestId: string) {
      return { ok: true, requestId, receipts: [] };
    },
  } as unknown as GuardianClient;
  return { client, calls };
}

function refund(client: GuardianClient, ran: string[], extra: object = {}) {
  return createGuardianTool({
    client,
    connectionId: "con_1",
    onAsk: "result",
    ...extra,
  })({
    name: "refund_order",
    description: "Refund an order",
    parameters: z.object({ orderId: z.string() }),
    execute: async ({ orderId }) => {
      ran.push(orderId);
      return `refunded ${orderId}`;
    },
  });
}

const callAs = (t: ReturnType<typeof refund>, user: string) =>
  t.invoke(new RunContext({ user }), JSON.stringify({ orderId: "ord_1" }));

const byUser = (runContext: { context?: unknown } | undefined) =>
  (runContext?.context as { user?: string } | undefined)?.user;

describe("held requests are scoped per session", () => {
  it("a held call is claimed only in the same scope", async () => {
    const { client, calls } = holdingClient();
    const ran: string[] = [];
    const t = refund(client, ran, { scope: byUser });

    expect(String(await callAs(t, "alice"))).toContain("req_1");
    // The identical call in another run context is a request of its own.
    expect(String(await callAs(t, "bob"))).toContain("req_2");
    expect(ran).toEqual([]);
    // The first context's repeat call claims its own request and runs once.
    expect(await callAs(t, "alice")).toBe("refunded ord_1");
    expect(calls).toEqual([
      "request:req_1",
      "request:req_2",
      "claim:req_1",
      "execute:req_1",
    ]);
    expect(ran).toEqual(["ord_1"]);
  });

  it("SCOPE_UNKNOWN, or a scope option that throws, never reuses a held request", async () => {
    for (const scope of [
      () => SCOPE_UNKNOWN,
      () => {
        throw new Error("no session");
      },
    ]) {
      const { client, calls } = holdingClient();
      const t = refund(client, [], { scope });
      await callAs(t, "alice");
      await callAs(t, "alice");
      expect(calls).toEqual(["request:req_1", "request:req_2"]);
    }
  });

  it("without a scope, held requests are shared as before", async () => {
    const { client, calls } = holdingClient();
    const t = refund(client, []);
    await callAs(t, "alice");
    expect(await callAs(t, "bob")).toBe("refunded ord_1");
    expect(calls).toEqual(["request:req_1", "claim:req_1", "execute:req_1"]);
  });
});
