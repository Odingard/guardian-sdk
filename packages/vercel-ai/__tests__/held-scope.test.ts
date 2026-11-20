import { describe, expect, it } from "vitest";
import { jsonSchema, tool } from "ai";
import type { GuardianClient } from "@odingard/guardian-sdk";
import { SCOPE_UNKNOWN } from "@odingard/guardian-sdk";
import { withGuardian } from "../src/index.js";

/**
 * Held requests are scoped per session. One wrapped tool set serves several
 * conversations; with the `scope` option a held call is claimed only by the
 * same call in the same scope.
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

function tools(client: GuardianClient, ran: string[], extra: object = {}) {
  return withGuardian(
    {
      refund_order: tool({
        description: "Refund an order",
        inputSchema: jsonSchema<{ orderId: string }>({
          type: "object",
          properties: { orderId: { type: "string" } },
          required: ["orderId"],
        }),
        execute: async ({ orderId }) => {
          ran.push(orderId);
          return `refunded ${orderId}`;
        },
      }),
    },
    {
      client,
      connectionId: "con_1",
      mode: "inProcess",
      onAsk: "result",
      onDeny: "result",
      ...extra,
    },
  );
}

const callAs = (wrapped: unknown, user: string) =>
  (
    wrapped as { execute: (i: unknown, o: unknown) => Promise<unknown> }
  ).execute(
    { orderId: "ord_1" },
    { toolCallId: "tc_1", messages: [], experimental_context: { user } },
  );

const byUser = (callOptions: { experimental_context?: unknown } | undefined) =>
  (callOptions?.experimental_context as { user?: string } | undefined)?.user;

const heldId = (out: unknown) =>
  (out as { guardian: { requestId: string } }).guardian.requestId;

describe("held requests are scoped per session", () => {
  it("a held call is claimed only in the same scope", async () => {
    const { client, calls } = holdingClient();
    const ran: string[] = [];
    const wrapped = tools(client, ran, { scope: byUser }).refund_order;

    expect(heldId(await callAs(wrapped, "alice"))).toBe("req_1");
    // The identical call in another conversation is a request of its own.
    expect(heldId(await callAs(wrapped, "bob"))).toBe("req_2");
    expect(ran).toEqual([]);
    // The first conversation's repeat call claims its own request, once.
    expect(await callAs(wrapped, "alice")).toBe("refunded ord_1");
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
      const wrapped = tools(client, [], { scope }).refund_order;
      await callAs(wrapped, "alice");
      await callAs(wrapped, "alice");
      expect(calls).toEqual(["request:req_1", "request:req_2"]);
    }
  });

  it("without a scope, held requests are shared as before", async () => {
    const { client, calls } = holdingClient();
    const wrapped = tools(client, []).refund_order;
    await callAs(wrapped, "alice");
    expect(await callAs(wrapped, "bob")).toBe("refunded ord_1");
    expect(calls).toEqual(["request:req_1", "claim:req_1", "execute:req_1"]);
  });
});
