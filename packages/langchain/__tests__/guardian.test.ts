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
    const execute = vi
      .fn()
      .mockResolvedValue({ ok: true, receipt: { id: "rcpt_1" } });
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
    const execute = vi
      .fn()
      .mockResolvedValue({ ok: true, receipt: { id: "rcpt_7" } });
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
});

describe("guardianTool inProcess mode", () => {
  const inProc = { mode: "inProcess" as const, connectionId: "con_1" };

  it("auto-installs record transport, runs impl, then records", async () => {
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
      .mockResolvedValueOnce(allow("req_1", "cap_1"));
    const execute = vi.fn().mockImplementation(async () => {
      order.push("execute");
      return { ok: true, receipt: { id: "rcpt" } };
    });
    const client = stubClient({ request, execute });
    const wrapped = guardianTool(inner, { client, ...inProc });
    const out = await wrapped.invoke({ orderId: "ord_9" });
    expect(request.mock.calls[0]![0]).toMatchObject({
      action: "mcp.install",
      tool: expect.objectContaining({
        name: "refund_order",
        transport: "record",
      }),
    });
    expect(request.mock.calls[1]![0]).toMatchObject({
      action: "tool.invoke",
      toolName: "refund_order",
    });
    expect(order).toEqual(["execute", "impl", "execute"]);
    expect(out).toBe("did work");
  });

  it("TOOL_ALREADY_INSTALLED proceeds and caches", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        reasonCode: "TOOL_ALREADY_INSTALLED",
      })
      .mockResolvedValue(allow());
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
    expect(request.mock.calls).toHaveLength(3);
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
    const wrapped = guardianTool(inner, { client, ...inProc });
    const err = await wrapped.invoke({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardianDenied);
    expect(run).not.toHaveBeenCalled();
  });

  it("a client without record transport throws GuardianRecordTransportRequired", async () => {
    const zodLike = new Error("invalid");
    (zodLike as any).issues = [{ code: "unrecognized_keys" }];
    const request = vi.fn().mockRejectedValue(zodLike);
    const client = stubClient({ request });
    const wrapped = guardianTool(refundTool(), { client, ...inProc });
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
      .mockResolvedValueOnce(allow("req_4", "cap_4"));
    const execute = vi
      .fn()
      .mockResolvedValue({ ok: true, receipt: { id: "r" } });
    const client = stubClient({ request, execute });
    const wrapped = guardianTool(inner, { client, ...inProc });
    await expect(wrapped.invoke({})).rejects.toThrow("tool exploded");
  });
});
