import { describe, expect, it, vi } from "vitest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { GuardianClient } from "@odingard/guardian-sdk";
import {
  GuardianApprovalPending,
  GuardianDenied,
  GuardianExecutionFailed,
  GuardianRecordTransportRequired,
  guardianTool,
  guardianTools,
} from "../src/index.js";

function stubClient(overrides: Partial<GuardianClient>): GuardianClient {
  return {
    request: vi.fn(),
    claim: vi.fn(),
    execute: vi.fn(),
    receipts: vi.fn(),
    ...overrides,
  } as unknown as GuardianClient;
}

function refundTool() {
  return tool(
    async ({ orderId }: { orderId: string }) => `refunded ${orderId}`,
    {
      name: "refund_order",
      description: "Refund an order",
      schema: z.object({ orderId: z.string() }),
    },
  );
}

const allow = (requestId = "req_1", capabilityToken = "cap_1") => ({
  ok: true as const,
  decision: "ALLOW" as const,
  requestId,
  capabilityToken,
});

describe("guardianTool remote mode (default)", () => {
  it("preserves name, description, and schema", () => {
    const inner = refundTool();
    const wrapped = guardianTool(inner, {
      client: stubClient({}),
      connectionId: "con_1",
    });
    expect(wrapped.name).toBe("refund_order");
    expect(wrapped.description).toBe("Refund an order");
    expect(wrapped.schema).toBe(inner.schema);
  });

  it("executes on Guardian and returns the receipt — impl never runs", async () => {
    const run = vi.fn().mockResolvedValue("must not run");
    const inner = tool(run, {
      name: "refund_order",
      description: "Refund an order",
      schema: z.object({ orderId: z.string() }),
    });
    const request = vi.fn().mockResolvedValue(allow());
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      receipt: { id: "rcpt_1", status: "sent-verified" },
    });
    const client = stubClient({ request, execute });
    const wrapped = guardianTool(inner, { client, connectionId: "con_1" });
    const out = await wrapped.invoke({ orderId: "ord_9" });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "tool.invoke",
        connectionId: "con_1",
        toolName: "refund_order",
        arguments: { orderId: "ord_9" },
      }),
    );
    expect(execute).toHaveBeenCalledWith({
      requestId: "req_1",
      capabilityToken: "cap_1",
    });
    expect(run).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      guardian: {
        decision: "ALLOW",
        requestId: "req_1",
        receipt: { id: "rcpt_1" },
      },
    });
  });

  it("ASK throws GuardianApprovalPending and never runs the tool", async () => {
    const run = vi.fn().mockResolvedValue("should not run");
    const inner = tool(run, {
      name: "send_wire",
      description: "Wire money",
      schema: z.object({ amount: z.number() }),
    });
    const request = vi
      .fn()
      .mockResolvedValue({ ok: true, decision: "ASK", requestId: "req_7" });
    const client = stubClient({ request });
    const wrapped = guardianTool(inner, { client, connectionId: "con_1" });
    const err = await wrapped.invoke({ amount: 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardianApprovalPending);
    expect(err).toMatchObject({
      decision: "ASK",
      requestId: "req_7",
      toolName: "send_wire",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("pending.resume() claims and executes remotely", async () => {
    const inner = refundTool();
    const request = vi
      .fn()
      .mockResolvedValue({ ok: true, decision: "ASK", requestId: "req_7" });
    const claim = vi.fn().mockResolvedValue(allow("req_7", "cap_7"));
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      receipt: { id: "rcpt_7", status: "sent-verified" },
    });
    const client = stubClient({ request, claim, execute });
    const wrapped = guardianTool(inner, { client, connectionId: "con_1" });
    const err = await wrapped
      .invoke({ orderId: "ord_1" })
      .catch((e: unknown) => e);
    const settled = await (err as GuardianApprovalPending).resume();
    expect(claim).toHaveBeenCalledWith("req_7");
    expect(execute).toHaveBeenCalledWith({
      requestId: "req_7",
      capabilityToken: "cap_7",
    });
    expect(settled).toMatchObject({
      requestId: "req_7",
      receipt: { id: "rcpt_7" },
    });
  });

  it("DENY throws GuardianDenied with the reason code", async () => {
    const inner = refundTool();
    const request = vi.fn().mockResolvedValue({
      ok: true,
      decision: "DENY",
      requestId: "req_2",
      reasonCode: "POLICY_DENY",
    });
    const execute = vi.fn();
    const client = stubClient({ request, execute });
    const wrapped = guardianTool(inner, { client, connectionId: "con_1" });
    const err = await wrapped
      .invoke({ orderId: "ord_1" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardianDenied);
    expect(err).toMatchObject({
      decision: "DENY",
      reasonCode: "POLICY_DENY",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("never executes when ALLOW arrives without a capability", async () => {
    const run = vi.fn().mockResolvedValue("should not run");
    const inner = tool(run, {
      name: "bare",
      description: "bare",
      schema: z.object({}),
    });
    const request = vi
      .fn()
      .mockResolvedValue({ ok: true, decision: "ALLOW", requestId: "req_x" });
    const execute = vi.fn();
    const client = stubClient({ request, execute });
    const wrapped = guardianTool(inner, { client, connectionId: "con_1" });
    await expect(wrapped.invoke({})).rejects.toBeInstanceOf(GuardianDenied);
    expect(run).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("surfaces a failed redemption as GuardianExecutionFailed", async () => {
    const inner = refundTool();
    const request = vi.fn().mockResolvedValue(allow("req_3", "cap_3"));
    const execute = vi
      .fn()
      .mockResolvedValue({ ok: false, reasonCode: "CAPABILITY_EXPIRED" });
    const client = stubClient({ request, execute });
    const wrapped = guardianTool(inner, { client, connectionId: "con_1" });
    const err = await wrapped
      .invoke({ orderId: "ord_1" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardianExecutionFailed);
    expect(err).toMatchObject({ reasonCode: "CAPABILITY_EXPIRED" });
  });

  it("guardianTools wraps a list preserving order", () => {
    const list = guardianTools([refundTool(), refundTool()], {
      client: stubClient({}),
      connectionId: "con_1",
    });
    expect(list).toHaveLength(2);
    expect(list.map((t) => t.name)).toEqual(["refund_order", "refund_order"]);
  });

  it("guardianTools keeps each tool's returnDirect flag, like guardianTool", () => {
    const direct = refundTool();
    direct.returnDirect = true;
    const plain = refundTool();
    const options = { client: stubClient({}), connectionId: "con_1" };
    const list = guardianTools([direct, plain], options);
    expect(list.map((t) => t.returnDirect)).toEqual([true, false]);
    expect(guardianTool(direct, options).returnDirect).toBe(true);
  });
});

describe("guardianTool inProcess mode", () => {
  const inProc = { mode: "inProcess" as const, connectionId: "con_1" };

  it("runs the inner tool on the approved arguments even if the object changes while Guardian decides", async () => {
    const run = vi.fn().mockResolvedValue("ok");
    const inner = tool(run, {
      name: "refund_order",
      description: "Refund an order",
      schema: z.object({ orderId: z.string(), amount: z.number() }),
    });
    const input = { orderId: "ord_9", amount: 1250 };
    const request = vi.fn().mockImplementation(async () => {
      input.amount = 999_999; // other code edits the object meanwhile
      return allow();
    });
    const client = stubClient({
      request,
      execute: vi.fn().mockResolvedValue({ ok: true, receipt: { id: "r" } }),
    });
    const wrapped = guardianTool(inner, { client, ...inProc });
    // The wrapper's own call, as LangChain makes it after parsing.
    const func = (
      wrapped as unknown as {
        func: (i: unknown, m?: unknown, c?: unknown) => Promise<unknown>;
      }
    ).func;
    await expect(func(input, undefined, {})).resolves.toBe("ok");
    expect(request.mock.calls[0]![0].arguments).toEqual({
      orderId: "ord_9",
      amount: 1250,
    });
    expect(run.mock.calls[0]![0]).toEqual({ orderId: "ord_9", amount: 1250 });
  });
  // Auto-install is opt-in and only works for a tool with no entry yet.
  const autoInstall = { ...inProc, installRecordTransport: true };

  it("opted in, auto-installs record transport, runs impl, then records", async () => {
    const order: string[] = [];
    const run = vi.fn().mockImplementation(async () => {
      order.push("impl");
      return "did work";
    });
    const inner = tool(run, {
      name: "refund_order",
      description: "Refund an order",
      schema: z.object({ orderId: z.string() }),
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce(allow("req_install", "cap_install"))
      .mockResolvedValueOnce(allow("req_enable", "cap_enable"))
      .mockResolvedValueOnce(allow("req_1", "cap_1"));
    const execute = vi.fn().mockImplementation(async () => {
      order.push("execute");
      return { ok: true, receipt: { id: "rcpt" } };
    });
    const client = stubClient({ request, execute });
    const wrapped = guardianTool(inner, { client, ...autoInstall });
    const out = await wrapped.invoke({ orderId: "ord_9" });
    expect(request.mock.calls[0]![0]).toMatchObject({
      action: "mcp.install",
      tool: expect.objectContaining({
        name: "refund_order",
        transport: "record",
      }),
    });
    expect(request.mock.calls[1]![0]).toMatchObject({
      action: "mcp.enable",
      toolName: "refund_order",
    });
    expect(request.mock.calls[2]![0]).toMatchObject({
      action: "tool.invoke",
      toolName: "refund_order",
    });
    expect(order).toEqual(["execute", "execute", "impl", "execute"]);
    expect(out).toBe("did work");
  });

  it("TOOL_ALREADY_INSTALLED is refused before anything runs (the entry may be an HTTP tool)", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: false,
      reasonCode: "TOOL_ALREADY_INSTALLED",
    });
    const execute = vi.fn();
    const client = stubClient({ request, execute });
    const run = vi.fn().mockResolvedValue("ok");
    const inner = tool(run, {
      name: "refund_order",
      description: "d",
      schema: z.object({}),
    });
    const wrapped = guardianTool(inner, { client, ...autoInstall });
    const err = (await wrapped
      .invoke({})
      .catch((e: unknown) => e)) as GuardianDenied;
    expect(err).toBeInstanceOf(GuardianDenied);
    expect(err.reasonCode).toBe("RECORD_TRANSPORT_UNVERIFIED");
    expect(err.hint).toContain("installRecordTransport: false");
    expect(err.hint).toContain(
      "Automatic registration only works while no entry with that name exists",
    );
    expect(request.mock.calls.map((c) => c[0].action)).toEqual(["mcp.install"]);
    expect(run).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("by default a tool registered in the console runs without proposing mcp.install", async () => {
    const request = vi.fn().mockResolvedValue(allow());
    const execute = vi
      .fn()
      .mockResolvedValue({ ok: true, receipt: { id: "r" } });
    const client = stubClient({ request, execute });
    const run = vi.fn().mockResolvedValue("ok");
    const inner = tool(run, {
      name: "refund_order",
      description: "d",
      schema: z.object({}),
    });
    const wrapped = guardianTool(inner, { client, ...inProc });
    await wrapped.invoke({});
    await wrapped.invoke({});
    expect(request.mock.calls.map((c) => c[0].action)).toEqual([
      "tool.invoke",
      "tool.invoke",
    ]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("install DENY gates the call", async () => {
    const run = vi.fn();
    const inner = tool(run, {
      name: "refund_order",
      description: "d",
      schema: z.object({}),
    });
    const request = vi.fn().mockResolvedValue({
      ok: true,
      decision: "DENY",
      requestId: "req_i",
      reasonCode: "NO_INSTALL_GRANT",
    });
    const client = stubClient({ request });
    const wrapped = guardianTool(inner, { client, ...autoInstall });
    const err = await wrapped.invoke({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardianDenied);
    expect(run).not.toHaveBeenCalled();
  });

  it("a client without record transport throws GuardianRecordTransportRequired", async () => {
    const zodLike = new Error("invalid");
    (zodLike as any).issues = [{ code: "unrecognized_keys" }];
    const request = vi.fn().mockRejectedValue(zodLike);
    const client = stubClient({ request });
    const wrapped = guardianTool(refundTool(), { client, ...autoInstall });
    await expect(wrapped.invoke({ orderId: "o" })).rejects.toBeInstanceOf(
      GuardianRecordTransportRequired,
    );
  });

  it("impl errors propagate", async () => {
    const inner = tool(
      async () => {
        throw new Error("tool exploded");
      },
      { name: "boom", description: "boom", schema: z.object({}) },
    );
    const request = vi
      .fn()
      .mockResolvedValueOnce(allow("req_install", "cap_install"))
      .mockResolvedValueOnce(allow("req_enable", "cap_enable"))
      .mockResolvedValueOnce(allow("req_4", "cap_4"));
    const execute = vi
      .fn()
      .mockResolvedValue({ ok: true, receipt: { id: "r" } });
    const client = stubClient({ request, execute });
    const wrapped = guardianTool(inner, { client, ...inProc });
    await expect(wrapped.invoke({})).rejects.toThrow("tool exploded");
  });
});

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const verified = () =>
  vi.fn().mockResolvedValue({ ok: true, receipt: { status: "sent-verified" } });

describe("the input is parsed once", () => {
  it("a transforming schema runs the tool with the approved value", async () => {
    const charged: number[] = [];
    const inner = tool(
      async ({ amount }: { amount: number }) => {
        charged.push(amount);
        return `charged ${amount} cents`;
      },
      {
        name: "charge_card",
        description: "Charge the card; amount in dollars",
        schema: z.object({
          amount: z.number().transform((d) => Math.round(d * 100)),
        }),
      },
    );
    const request = vi.fn().mockResolvedValue(allow());
    const execute = verified();
    const wrapped = guardianTool(inner, {
      client: stubClient({ request, execute }),
      connectionId: "con_1",
      mode: "inProcess",
    });
    const out = await wrapped.invoke({ amount: 50 });
    expect(request.mock.calls[0]![0].arguments).toEqual({ amount: 5000 });
    expect(charged).toEqual([5000]);
    expect(out).toBe("charged 5000 cents");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("an idempotent schema still sends and runs the same value", async () => {
    const seen: unknown[] = [];
    const request = vi.fn().mockResolvedValue(allow());
    const wrapped = guardianTool(
      tool(
        async (a: unknown) => {
          seen.push(a);
          return "ok";
        },
        {
          name: "t",
          description: "t",
          schema: z.object({ s: z.string().trim(), n: z.number().default(3) }),
        },
      ),
      {
        client: stubClient({ request, execute: verified() }),
        connectionId: "c",
        mode: "inProcess",
      },
    );
    await wrapped.invoke({ s: "  x " } as never);
    expect(request.mock.calls[0]![0].arguments).toEqual({ s: "x", n: 3 });
    expect(seen).toEqual([{ s: "x", n: 3 }]);
  });

  it("a streaming tool runs to completion before the evidence is recorded", async () => {
    const steps: string[] = [];
    const execute = vi.fn().mockImplementation(async () => {
      steps.push("execute");
      return { ok: true, receipt: { status: "sent-verified" } };
    });
    const inner = tool(
      async function* () {
        steps.push("start");
        yield "chunk";
        steps.push("end");
        return "done";
      },
      { name: "stream_it", description: "s", schema: z.object({}) },
    );
    const wrapped = guardianTool(inner, {
      client: stubClient({
        request: vi.fn().mockResolvedValue(allow()),
        execute,
      }),
      connectionId: "c",
      mode: "inProcess",
    });
    expect(await wrapped.invoke({})).toBe("done");
    expect(steps).toEqual(["start", "end", "execute"]);
  });
});

describe("config.signal", () => {
  it("remote: an abort while Guardian decides rejects, and a late ALLOW performs nothing", async () => {
    const decided = deferred<ReturnType<typeof allow>>();
    const request = vi.fn().mockReturnValue(decided.promise);
    const execute = verified();
    const wrapped = guardianTool(
      tool(async () => "x", {
        name: "send_wire",
        description: "Send a wire",
        schema: z.object({ to: z.string() }),
      }),
      { client: stubClient({ request, execute }), connectionId: "con_1" },
    );
    const ac = new AbortController();
    const seen = wrapped.invoke({ to: "acct_9" }, { signal: ac.signal }).then(
      () => "resolved",
      () => "rejected",
    );
    await tick();
    ac.abort();
    expect(await seen).toBe("rejected");
    decided.resolve(allow());
    await tick();
    expect(execute).not.toHaveBeenCalled();
  });

  it("inProcess: an abort while Guardian decides rejects, and a late ALLOW runs nothing", async () => {
    const decided = deferred<ReturnType<typeof allow>>();
    const request = vi.fn().mockReturnValue(decided.promise);
    const execute = verified();
    const effects: string[] = [];
    const wrapped = guardianTool(
      tool(
        async ({ to }: { to: string }) => {
          effects.push(to);
          return "sent";
        },
        {
          name: "send_wire",
          description: "Send a wire",
          schema: z.object({ to: z.string() }),
        },
      ),
      {
        client: stubClient({ request, execute }),
        connectionId: "con_1",
        mode: "inProcess",
      },
    );
    const ac = new AbortController();
    const seen = wrapped.invoke({ to: "acct_9" }, { signal: ac.signal }).then(
      () => "resolved",
      () => "rejected",
    );
    await tick();
    ac.abort();
    decided.resolve(allow());
    await tick(100);
    expect(await seen).toBe("rejected");
    expect(effects).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("an already aborted signal asks Guardian nothing", async () => {
    const request = vi.fn();
    const wrapped = guardianTool(refundTool(), {
      client: stubClient({ request }),
      connectionId: "con_1",
    });
    const ac = new AbortController();
    ac.abort();
    await expect(
      wrapped.invoke({ orderId: "o" }, { signal: ac.signal }),
    ).rejects.toBeTruthy();
    expect(request).not.toHaveBeenCalled();
  });

  it("inProcess: an abort after the tool started waits for its real outcome and records it", async () => {
    const effects: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const execute = verified();
    const wrapped = guardianTool(
      tool(
        async ({ to }: { to: string }) => {
          await gate;
          effects.push(to);
          return "sent";
        },
        {
          name: "send_wire",
          description: "w",
          schema: z.object({ to: z.string() }),
        },
      ),
      {
        client: stubClient({
          request: vi.fn().mockResolvedValue(allow()),
          execute,
        }),
        connectionId: "con_1",
        mode: "inProcess",
      },
    );
    const ac = new AbortController();
    let settled = "pending";
    const seen = wrapped.invoke({ to: "acct_9" }, { signal: ac.signal }).then(
      (v) => (settled = `resolved: ${String(v)}`),
      (e: Error) => (settled = `rejected: ${e.message}`),
    );
    await tick();
    ac.abort();
    await tick();
    expect(settled).toBe("pending"); // not reported as aborted while it runs
    release();
    await seen;
    expect(settled).toBe("resolved: sent");
    expect(effects).toEqual(["acct_9"]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("remote: an abort after Guardian was asked to perform the call waits for the receipt", async () => {
    const executed = deferred<{ ok: true; receipt: { status: string } }>();
    const execute = vi.fn().mockReturnValue(executed.promise);
    const wrapped = guardianTool(refundTool(), {
      client: stubClient({
        request: vi.fn().mockResolvedValue(allow()),
        execute,
      }),
      connectionId: "con_1",
    });
    const ac = new AbortController();
    let settled = "pending";
    const seen = wrapped.invoke({ orderId: "o" }, { signal: ac.signal }).then(
      () => (settled = "resolved"),
      () => (settled = "rejected"),
    );
    await tick();
    expect(execute).toHaveBeenCalledTimes(1);
    ac.abort();
    await tick();
    expect(settled).toBe("pending");
    executed.resolve({ ok: true, receipt: { status: "sent-verified" } });
    await seen;
    expect(settled).toBe("resolved");
  });
});
