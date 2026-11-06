import { describe, expect, it, vi } from "vitest";
import { jsonSchema, tool } from "ai";
import type { GuardianClient } from "@odingard/guardian-sdk";
import {
  GuardianApprovalPending,
  GuardianDenied,
  GuardianExecutionFailed,
  GuardianRecordTransportRequired,
  withGuardian,
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

const callOptions = { toolCallId: "tc_1", messages: [], context: {} };

const call = (wrapped: unknown, input: unknown): Promise<unknown> =>
  (
    wrapped as { execute: (i: unknown, o: unknown) => Promise<unknown> }
  ).execute(input, callOptions);

const fakeTool = (run: (...args: any[]) => unknown) =>
  tool({ inputSchema: jsonSchema({ type: "object" }), execute: run as any });

function refundTool() {
  return tool({
    description: "Refund an order",
    inputSchema: jsonSchema<{ orderId: string; amount: number }>({
      type: "object",
      properties: { orderId: { type: "string" }, amount: { type: "number" } },
      required: ["orderId", "amount"],
    }),
    execute: async ({ orderId, amount }) => `refunded ${orderId} $${amount}`,
  });
}

const allow = (requestId = "req_1", capabilityToken = "cap_1") => ({
  ok: true as const,
  decision: "ALLOW" as const,
  requestId,
  capabilityToken,
});

describe("withGuardian remote mode (default)", () => {
  it("executes on Guardian and returns the receipt — local impl never runs", async () => {
    const run = vi.fn().mockResolvedValue("must not run");
    const request = vi.fn().mockResolvedValue(allow());
    const execute = vi
      .fn()
      .mockResolvedValue({ ok: true, receipt: { id: "rcpt_1" } });
    const client = stubClient({ request, execute });
    const tools = withGuardian(
      { refund_order: fakeTool(run) },
      { client, connectionId: "con_1" },
    );
    const out = await call(tools.refund_order, {
      orderId: "ord_9",
      amount: 25,
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "tool.invoke",
        connectionId: "con_1",
        toolName: "refund_order",
        arguments: { orderId: "ord_9", amount: 25 },
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

  it("emits the receipt via onReceipt", async () => {
    const onReceipt = vi.fn();
    const client = stubClient({
      request: vi.fn().mockResolvedValue(allow()),
      execute: vi
        .fn()
        .mockResolvedValue({ ok: true, receipt: { id: "rcpt_1" } }),
    });
    const tools = withGuardian(
      { refund_order: refundTool() },
      { client, connectionId: "con_1", onReceipt },
    );
    await call(tools.refund_order, { orderId: "o", amount: 1 });
    expect(onReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "refund_order",
        requestId: "req_1",
      }),
    );
  });

  it("ASK throws GuardianApprovalPending carrying the requestId", async () => {
    const run = vi.fn();
    const request = vi
      .fn()
      .mockResolvedValue({ ok: true, decision: "ASK", requestId: "req_7" });
    const client = stubClient({ request });
    const tools = withGuardian(
      { send_wire: fakeTool(run) },
      { client, connectionId: "con_1" },
    );
    const err = await call(tools.send_wire, { amount: 10 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GuardianApprovalPending);
    expect(err).toMatchObject({
      decision: "ASK",
      requestId: "req_7",
      toolName: "send_wire",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("pending.resume() claims and executes remotely", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ ok: true, decision: "ASK", requestId: "req_7" });
    const claim = vi.fn().mockResolvedValue(allow("req_7", "cap_7"));
    const execute = vi
      .fn()
      .mockResolvedValue({ ok: true, receipt: { id: "rcpt_7" } });
    const client = stubClient({ request, claim, execute });
    const tools = withGuardian(
      { send_wire: fakeTool(vi.fn()) },
      { client, connectionId: "con_1" },
    );
    const err = await call(tools.send_wire, { amount: 10 }).catch(
      (e: unknown) => e,
    );
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
    const run = vi.fn();
    const request = vi.fn().mockResolvedValue({
      ok: true,
      decision: "DENY",
      requestId: "req_2",
      reasonCode: "POLICY_DENY",
    });
    const execute = vi.fn();
    const client = stubClient({ request, execute });
    const tools = withGuardian(
      { rm_rf: fakeTool(run) },
      { client, connectionId: "con_1" },
    );
    const err = await call(tools.rm_rf, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardianDenied);
    expect(err).toMatchObject({
      decision: "DENY",
      requestId: "req_2",
      reasonCode: "POLICY_DENY",
    });
    expect(run).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("treats a failed request as DENY with the upstream reason code", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ ok: false, reasonCode: "RATE_LIMITED" });
    const client = stubClient({ request });
    const tools = withGuardian(
      { anything: fakeTool(vi.fn()) },
      { client, connectionId: "con_1" },
    );
    await expect(call(tools.anything, {})).rejects.toMatchObject({
      decision: "DENY",
      reasonCode: "RATE_LIMITED",
    });
  });

  it("never executes when ALLOW arrives without a capability", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ ok: true, decision: "ALLOW", requestId: "req_x" });
    const execute = vi.fn();
    const client = stubClient({ request, execute });
    const tools = withGuardian(
      { bare: fakeTool(vi.fn()) },
      { client, connectionId: "con_1" },
    );
    await expect(call(tools.bare, "input")).rejects.toBeInstanceOf(
      GuardianDenied,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("surfaces a failed capability redemption as GuardianExecutionFailed", async () => {
    const request = vi.fn().mockResolvedValue(allow("req_3", "cap_3"));
    const execute = vi
      .fn()
      .mockResolvedValue({ ok: false, reasonCode: "CAPABILITY_EXPIRED" });
    const client = stubClient({ request, execute });
    const tools = withGuardian(
      { refund_order: fakeTool(vi.fn()) },
      { client, connectionId: "con_1" },
    );
    const err = await call(tools.refund_order, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardianExecutionFailed);
    expect(err).toMatchObject({
      requestId: "req_3",
      reasonCode: "CAPABILITY_EXPIRED",
    });
  });

  it("mode 'result' returns serializable ASK/DENY instead of throwing", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, decision: "ASK", requestId: "req_5" })
      .mockResolvedValueOnce({
        ok: true,
        decision: "DENY",
        requestId: "req_6",
        reasonCode: "SCOPE",
      });
    const client = stubClient({ request });
    const tools = withGuardian(
      { t: fakeTool(vi.fn()) },
      { client, connectionId: "con_1", onAsk: "result", onDeny: "result" },
    );
    await expect(call(tools.t, {})).resolves.toMatchObject({
      guardian: { decision: "ASK", requestId: "req_5" },
    });
    await expect(call(tools.t, {})).resolves.toMatchObject({
      guardian: { decision: "DENY", reasonCode: "SCOPE" },
    });
  });

  it("passes tools without execute through untouched", () => {
    const client = stubClient({});
    const providerTool = { description: "server-side", inputSchema: {} } as any;
    const tools = withGuardian(
      { provider_side: providerTool },
      { client, connectionId: "con_1" },
    );
    expect(tools.provider_side).toBe(providerTool);
  });
});

describe("withGuardian inProcess mode", () => {
  const inProc = {
    mode: "inProcess" as const,
    connectionId: "con_1",
  };

  it("auto-installs a record-transport entry, runs impl, then records", async () => {
    const order: string[] = [];
    const run = vi.fn().mockImplementation(async () => {
      order.push("impl");
      return "did work";
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
    const tools = withGuardian(
      { refund_order: fakeTool(run) },
      { client, ...inProc },
    );
    const out = await call(tools.refund_order, { orderId: "ord_9" });
    expect(request.mock.calls[0]![0]).toMatchObject({
      action: "mcp.install",
      connectionId: "con_1",
      tool: expect.objectContaining({
        name: "refund_order",
        transport: "record",
      }),
    });
    expect(request.mock.calls[1]![0]).toMatchObject({
      action: "tool.invoke",
      toolName: "refund_order",
    });
    // impl ran only after ALLOW, then execute redeemed + recorded
    expect(order).toEqual(["execute", "impl", "execute"]);
    expect(out).toBe("did work");
  });

  it("skips install on TOOL_ALREADY_INSTALLED and caches it", async () => {
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
    const tools = withGuardian(
      { refund_order: fakeTool(run) },
      { client, ...inProc },
    );
    await call(tools.refund_order, {});
    await call(tools.refund_order, {});
    expect(request.mock.calls).toHaveLength(3); // install once + 2 invokes
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("install DENY gates the tool call", async () => {
    const run = vi.fn();
    const request = vi.fn().mockResolvedValue({
      ok: true,
      decision: "DENY",
      requestId: "req_i",
      reasonCode: "NO_INSTALL_GRANT",
    });
    const client = stubClient({ request });
    const tools = withGuardian(
      { refund_order: fakeTool(run) },
      { client, ...inProc },
    );
    const err = await call(tools.refund_order, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardianDenied);
    expect(err).toMatchObject({ reasonCode: "NO_INSTALL_GRANT" });
    expect(run).not.toHaveBeenCalled();
    expect(request.mock.calls).toHaveLength(1);
  });

  it("a client without record transport throws GuardianRecordTransportRequired", async () => {
    const zodLike = new Error("invalid");
    (zodLike as any).issues = [{ code: "unrecognized_keys" }];
    const request = vi.fn().mockRejectedValue(zodLike);
    const client = stubClient({ request });
    const tools = withGuardian(
      { refund_order: fakeTool(vi.fn()) },
      { client, ...inProc },
    );
    await expect(call(tools.refund_order, {})).rejects.toBeInstanceOf(
      GuardianRecordTransportRequired,
    );
  });

  it("execute failure after impl ran throws GuardianExecutionFailed", async () => {
    const run = vi.fn().mockResolvedValue("did work");
    const request = vi
      .fn()
      .mockResolvedValueOnce(allow("req_install", "cap_install"))
      .mockResolvedValueOnce(allow("req_1", "cap_1"));
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, receipt: { id: "r0" } })
      .mockResolvedValueOnce({ ok: false, reasonCode: "EXEC_FAILED" });
    const client = stubClient({ request, execute });
    const tools = withGuardian(
      { refund_order: fakeTool(run) },
      { client, ...inProc },
    );
    const err = await call(tools.refund_order, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardianExecutionFailed);
    expect(run).toHaveBeenCalledOnce();
  });

  it("impl errors propagate (capability left unredeemed)", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(allow("req_install", "cap_install"))
      .mockResolvedValueOnce(allow("req_4", "cap_4"));
    const execute = vi
      .fn()
      .mockResolvedValue({ ok: true, receipt: { id: "r" } });
    const client = stubClient({ request, execute });
    const tools = withGuardian(
      {
        boom: fakeTool(vi.fn().mockRejectedValue(new Error("tool exploded"))),
      },
      { client, ...inProc },
    );
    await expect(call(tools.boom, {})).rejects.toThrow("tool exploded");
  });

  it("per-tool modes override mixes remote and inProcess", async () => {
    const request = vi.fn().mockResolvedValue(allow());
    const execute = vi
      .fn()
      .mockResolvedValue({ ok: true, receipt: { id: "r" } });
    const client = stubClient({ request, execute });
    const remoteImpl = vi.fn();
    const tools = withGuardian(
      {
        remote_tool: fakeTool(remoteImpl),
        local_tool: fakeTool(vi.fn().mockResolvedValue("local out")),
      },
      {
        client,
        connectionId: "con_1",
        modes: { local_tool: "inProcess" },
      },
    );
    const remoteOut = await call(tools.remote_tool, {});
    expect(remoteImpl).not.toHaveBeenCalled();
    expect(remoteOut).toMatchObject({ guardian: { decision: "ALLOW" } });
    const localOut = await call(tools.local_tool, {});
    expect(localOut).toBe("local out");
    // install + invoke requests for local_tool only
    expect(request.mock.calls.map((c) => c[0].action)).toEqual([
      "tool.invoke",
      "mcp.install",
      "tool.invoke",
    ]);
  });

  it("install ASK blocks until approved, then resume completes the call", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, decision: "ASK", requestId: "req_i" })
      .mockResolvedValueOnce(allow("req_2", "cap_2"));
    const claim = vi.fn().mockResolvedValue(allow("req_i", "cap_i"));
    const execute = vi
      .fn()
      .mockResolvedValue({ ok: true, receipt: { id: "r" } });
    const run = vi.fn().mockResolvedValue("done after approval");
    const client = stubClient({ request, claim, execute });
    const tools = withGuardian(
      { refund_order: fakeTool(run) },
      { client, ...inProc },
    );
    const err = await call(tools.refund_order, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardianApprovalPending);
    expect(run).not.toHaveBeenCalled();
    const settled = await (err as GuardianApprovalPending).resume();
    expect(run).toHaveBeenCalledOnce();
    expect(settled.output).toBe("done after approval");
  });

  it("a held ASK (403 APPROVAL_REQUIRED + requestId) raises GuardianApprovalPending", async () => {
    const run = vi.fn();
    const client = stubClient({
      request: vi.fn().mockResolvedValue({
        ok: false,
        reasonCode: "APPROVAL_REQUIRED",
        requestId: "req_held",
      }),
    });
    const tools = withGuardian(
      { refund_order: refundTool() },
      { client, connectionId: "con_1" },
    );
    const err = await call(tools.refund_order, {
      orderId: "o",
      amount: 1,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardianApprovalPending);
    expect((err as GuardianApprovalPending).requestId).toBe("req_held");
    expect(run).not.toHaveBeenCalled();
  });
});
