import { describe, expect, it } from "vitest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { GuardianClient } from "@odingard/guardian-sdk";
import { SCOPE_UNKNOWN } from "@odingard/guardian-sdk";
import { guardianTool } from "../src/index.js";

/**
 * Held requests are scoped per session. One wrapped tool serves several
 * conversations; a held call is claimed only by the same call in the same
 * conversation (LangGraph's `configurable.thread_id`, or the `scope` option).
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
  return guardianTool(
    tool(
      async ({ orderId }: { orderId: string }) => {
        ran.push(orderId);
        return `refunded ${orderId}`;
      },
      {
        name: "refund_order",
        description: "Refund an order",
        schema: z.object({ orderId: z.string() }),
      },
    ),
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

const thread = (id: string) => ({ configurable: { thread_id: id } });
const heldId = (out: unknown) =>
  (out as { guardian: { requestId: string } }).guardian.requestId;

describe("held requests are scoped per session", () => {
  it("a held call is claimed only in the same LangGraph thread", async () => {
    const { client, calls } = holdingClient();
    const ran: string[] = [];
    const wrapped = refund(client, ran); // one tool for every conversation
    const input = { orderId: "ord_1" };

    expect(heldId(await wrapped.invoke(input, thread("alice")))).toBe("req_1");
    // The identical call in another thread is a request of its own.
    expect(heldId(await wrapped.invoke(input, thread("bob")))).toBe("req_2");
    expect(ran).toEqual([]);
    // The first thread's repeat call claims its own request and runs once.
    expect(await wrapped.invoke(input, thread("alice"))).toBe("refunded ord_1");
    expect(calls).toEqual([
      "request:req_1",
      "request:req_2",
      "claim:req_1",
      "execute:req_1",
    ]);
    expect(ran).toEqual(["ord_1"]);
  });

  it("a thread id that is a number scopes held calls like its string form", async () => {
    // LangGraph does not require a string: its checkpointers key a thread
    // by the id's string form, so 1 and "1" are one thread.
    const { client, calls } = holdingClient();
    const ran: string[] = [];
    const wrapped = refund(client, ran);
    const input = { orderId: "ord_1" };
    const numbered = (id: unknown) => ({ configurable: { thread_id: id } });

    expect(heldId(await wrapped.invoke(input, numbered(1)))).toBe("req_1");
    // Another user's thread, same call: its own request.
    expect(heldId(await wrapped.invoke(input, numbered(2)))).toBe("req_2");
    expect(heldId(await wrapped.invoke(input, numbered(0)))).toBe("req_3");
    expect(heldId(await wrapped.invoke(input, numbered(10n)))).toBe("req_4");
    expect(ran).toEqual([]);
    // The same thread, written as a string, claims its own request.
    expect(await wrapped.invoke(input, numbered("1"))).toBe("refunded ord_1");
    expect(await wrapped.invoke(input, numbered(0))).toBe("refunded ord_1");
    expect(calls.slice(4)).toEqual([
      "claim:req_1",
      "execute:req_1",
      "claim:req_3",
      "execute:req_3",
    ]);
  });

  it("a thread id that names no thread never reuses a held request", async () => {
    for (const id of ["", {}, [], true, Number.NaN, Symbol("t")]) {
      const { client, calls } = holdingClient();
      const wrapped = refund(client, []);
      const config = { configurable: { thread_id: id } };
      await wrapped.invoke({ orderId: "ord_1" }, config as never);
      await wrapped.invoke({ orderId: "ord_1" }, config as never);
      expect(calls).toEqual(["request:req_1", "request:req_2"]);
    }
  });

  it("only an absent thread id shares held calls as before", async () => {
    for (const config of [
      undefined,
      {},
      { configurable: {} },
      { configurable: { thread_id: undefined } },
      { configurable: { thread_id: null } },
    ]) {
      const { client, calls } = holdingClient();
      const wrapped = refund(client, []);
      await wrapped.invoke({ orderId: "ord_1" }, config as never);
      expect(await wrapped.invoke({ orderId: "ord_1" }, config as never)).toBe(
        "refunded ord_1",
      );
      expect(calls).toEqual(["request:req_1", "claim:req_1", "execute:req_1"]);
    }
  });

  it("the scope option overrides the thread", async () => {
    const { client, calls } = holdingClient();
    const ran: string[] = [];
    const wrapped = refund(client, ran, {
      scope: (config: { configurable?: { user?: string } } | undefined) =>
        config?.configurable?.user,
    });
    const input = { orderId: "ord_1" };
    const as = (user: string) => ({
      configurable: { thread_id: "one-thread", user },
    });
    await wrapped.invoke(input, as("alice"));
    expect(heldId(await wrapped.invoke(input, as("bob")))).toBe("req_2");
    expect(await wrapped.invoke(input, as("alice"))).toBe("refunded ord_1");
    expect(calls).toEqual([
      "request:req_1",
      "request:req_2",
      "claim:req_1",
      "execute:req_1",
    ]);
  });

  it("a scope option that gives no session never reuses a held request, thread id or not", async () => {
    // The option replaces the thread-id default, so `undefined` from it
    // must not fall back to held requests shared by every session.
    for (const scope of [() => undefined, () => "", () => null]) {
      for (const config of [thread("alice"), undefined]) {
        const { client, calls } = holdingClient();
        const ran: string[] = [];
        const wrapped = refund(client, ran, { scope });
        expect(heldId(await wrapped.invoke({ orderId: "ord_1" }, config))).toBe(
          "req_1",
        );
        // Another session, same call: its own request.
        expect(heldId(await wrapped.invoke({ orderId: "ord_1" }, config))).toBe(
          "req_2",
        );
        expect(calls).toEqual(["request:req_1", "request:req_2"]);
        expect(ran).toEqual([]);
      }
    }
  });

  it("SCOPE_UNKNOWN, or a scope option that throws, never reuses a held request", async () => {
    for (const scope of [
      () => SCOPE_UNKNOWN,
      () => {
        throw new Error("no session");
      },
    ]) {
      const { client, calls } = holdingClient();
      const wrapped = refund(client, [], { scope });
      await wrapped.invoke({ orderId: "ord_1" }, thread("alice"));
      await wrapped.invoke({ orderId: "ord_1" }, thread("alice"));
      expect(calls).toEqual(["request:req_1", "request:req_2"]);
    }
  });

  it("without a thread or a scope, held requests are shared as before", async () => {
    const { client, calls } = holdingClient();
    const ran: string[] = [];
    const wrapped = refund(client, ran);
    await wrapped.invoke({ orderId: "ord_1" });
    expect(await wrapped.invoke({ orderId: "ord_1" })).toBe("refunded ord_1");
    expect(calls).toEqual(["request:req_1", "claim:req_1", "execute:req_1"]);
  });
});
