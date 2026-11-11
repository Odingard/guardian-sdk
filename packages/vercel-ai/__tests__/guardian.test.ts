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
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      receipt: { id: "rcpt_1", status: "sent-verified" },
    });
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
      execute: vi.fn().mockResolvedValue({
        ok: true,
        receipt: { id: "rcpt_1", status: "sent-verified" },
      }),
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
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      receipt: { id: "rcpt_7", status: "sent-verified" },
    });
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
    await expect(call(tools.t, { n: 1 })).resolves.toMatchObject({
      guardian: { decision: "ASK", requestId: "req_5" },
    });
    // Different arguments: a new request, not a claim of the held one.
    await expect(call(tools.t, { n: 2 })).resolves.toMatchObject({
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
  // Auto-install is opt-in (default off) and only works for a tool with no
  // entry yet; these tests opt in.
  const inProc = {
    mode: "inProcess" as const,
    connectionId: "con_1",
    installRecordTransport: true,
  };

  it("by default proposes no mcp.install: the tool is registered in the console", async () => {
    const run = vi.fn().mockResolvedValue("ok");
    const request = vi.fn().mockResolvedValue(allow());
    const client = stubClient({
      request,
      execute: vi.fn().mockResolvedValue({ ok: true, receipt: { id: "r" } }),
    });
    const tools = withGuardian(
      { refund_order: fakeTool(run) },
      { client, connectionId: "con_1", mode: "inProcess" },
    );
    await expect(call(tools.refund_order, {})).resolves.toBe("ok");
    await expect(call(tools.refund_order, {})).resolves.toBe("ok");
    expect(request.mock.calls.map((c) => c[0].action)).toEqual([
      "tool.invoke",
      "tool.invoke",
    ]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("auto-installs a record-transport entry, runs impl, then records", async () => {
    const order: string[] = [];
    const run = vi.fn().mockImplementation(async () => {
      order.push("impl");
      return "did work";
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
      action: "mcp.enable",
      toolName: "refund_order",
    });
    expect(request.mock.calls[2]![0]).toMatchObject({
      action: "tool.invoke",
      toolName: "refund_order",
    });
    // impl ran only after ALLOW, then execute redeemed + recorded
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
    const tools = withGuardian(
      { refund_order: fakeTool(run) },
      { client, ...inProc },
    );
    const err = await call(tools.refund_order, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardianDenied);
    expect(err).toMatchObject({ reasonCode: "RECORD_TRANSPORT_UNVERIFIED" });
    expect(request.mock.calls.map((c) => c[0].action)).toEqual(["mcp.install"]);
    expect(run).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
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
      .mockResolvedValueOnce(allow("req_enable", "cap_enable"))
      .mockResolvedValueOnce(allow("req_1", "cap_1"));
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, receipt: { id: "r0" } })
      .mockResolvedValueOnce({ ok: true, receipt: { id: "r1" } })
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
      .mockResolvedValueOnce(allow("req_enable", "cap_enable"))
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
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      receipt: { id: "r", status: "sent-verified" },
    });
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
        installRecordTransport: true,
      },
    );
    const remoteOut = await call(tools.remote_tool, {});
    expect(remoteImpl).not.toHaveBeenCalled();
    expect(remoteOut).toMatchObject({ guardian: { decision: "ALLOW" } });
    const localOut = await call(tools.local_tool, {});
    expect(localOut).toBe("local out");
    // install + enable + invoke requests for local_tool only
    expect(request.mock.calls.map((c) => c[0].action)).toEqual([
      "tool.invoke",
      "mcp.install",
      "mcp.enable",
      "tool.invoke",
    ]);
  });

  it("install ASK blocks until approved, then resume completes the call", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, decision: "ASK", requestId: "req_i" })
      .mockResolvedValueOnce(allow("req_e", "cap_e"))
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

describe("withGuardian honours the AI SDK abort signal", () => {
  const inProc = { mode: "inProcess" as const, connectionId: "con_1" };

  it("an abort while Guardian has not answered rejects at once and never runs the tool", async () => {
    const run = vi.fn();
    let answer: (value: unknown) => void = () => {};
    const request = vi.fn(() => new Promise((resolve) => (answer = resolve)));
    const client = stubClient({ request } as never);
    const tools = withGuardian(
      { refund_order: fakeTool(run) },
      { ...inProc, client, installRecordTransport: false },
    );
    const controller = new AbortController();
    const pending = (
      tools.refund_order as unknown as {
        execute: (i: unknown, o: unknown) => Promise<unknown>;
      }
    ).execute({}, { ...callOptions, abortSignal: controller.signal });
    controller.abort(new Error("cancelled by caller"));
    await expect(pending).rejects.toThrow("cancelled by caller");
    // Guardian answers ALLOW after the abort: the tool still does not run.
    answer(allow());
    await new Promise((r) => setTimeout(r, 0));
    expect(run).not.toHaveBeenCalled();
  });

  it("remote mode: an abort before Guardian answers means Guardian never performs the call", async () => {
    const run = vi.fn();
    let answer: (value: unknown) => void = () => {};
    const request = vi.fn(() => new Promise((resolve) => (answer = resolve)));
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      receipt: { id: "rcpt_1", status: "sent-verified" },
    });
    const client = stubClient({ request, execute } as never);
    const tools = withGuardian(
      { refund_order: fakeTool(run) },
      { client, connectionId: "con_1" },
    );
    const controller = new AbortController();
    const pending = (
      tools.refund_order as unknown as {
        execute: (i: unknown, o: unknown) => Promise<unknown>;
      }
    ).execute({}, { ...callOptions, abortSignal: controller.signal });
    controller.abort(new Error("cancelled by caller"));
    await expect(pending).rejects.toThrow("cancelled by caller");
    answer(allow());
    await new Promise((r) => setTimeout(r, 0));
    expect(execute).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("remote mode: an abort after Guardian started the call waits for the real outcome", async () => {
    const run = vi.fn();
    let finish: (value: unknown) => void = () => {};
    const execute = vi.fn(() => new Promise((resolve) => (finish = resolve)));
    const client = stubClient({
      request: vi.fn().mockResolvedValue(allow()),
      execute,
    } as never);
    const tools = withGuardian(
      { refund_order: fakeTool(run) },
      { client, connectionId: "con_1" },
    );
    const controller = new AbortController();
    const pending = (
      tools.refund_order as unknown as {
        execute: (i: unknown, o: unknown) => Promise<unknown>;
      }
    ).execute({}, { ...callOptions, abortSignal: controller.signal });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    controller.abort(new Error("cancelled by caller"));
    finish({ ok: true, receipt: { id: "rcpt_1", status: "sent-verified" } });
    await expect(pending).resolves.toMatchObject({
      guardian: { decision: "ALLOW", requestId: "req_1" },
    });
  });

  it("inProcess: a record-transport setup step does not count as the tool starting", async () => {
    const run = vi.fn();
    let answer: (value: unknown) => void = () => {};
    const request = vi.fn(async (inv: { action: string }) => {
      if (inv.action === "mcp.install") {
        return {
          ok: true,
          decision: "ALLOW",
          requestId: "req_i",
          capabilityToken: "ci",
        };
      }
      if (inv.action === "mcp.enable") {
        return {
          ok: true,
          decision: "ALLOW",
          requestId: "req_e",
          capabilityToken: "ce",
        };
      }
      return new Promise((resolve) => (answer = resolve));
    });
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      receipt: { id: "r", status: "sent-verified" },
    });
    const client = stubClient({ request, execute } as never);
    const tools = withGuardian(
      { refund_order: fakeTool(run) },
      { ...inProc, client, installRecordTransport: true },
    );
    const controller = new AbortController();
    const pending = (
      tools.refund_order as unknown as {
        execute: (i: unknown, o: unknown) => Promise<unknown>;
      }
    ).execute({}, { ...callOptions, abortSignal: controller.signal });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    controller.abort(new Error("cancelled by caller"));
    await expect(pending).rejects.toThrow("cancelled by caller");
    answer(allow());
    await new Promise((r) => setTimeout(r, 0));
    expect(run).not.toHaveBeenCalled();
    expect(execute.mock.calls.map((c) => c[0].requestId)).toEqual([
      "req_i",
      "req_e",
    ]);
  });

  it("an already-aborted signal never reaches Guardian", async () => {
    const run = vi.fn();
    const request = vi.fn();
    const client = stubClient({ request });
    const tools = withGuardian(
      { refund_order: fakeTool(run) },
      { ...inProc, client, installRecordTransport: false },
    );
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    await expect(
      (
        tools.refund_order as unknown as {
          execute: (i: unknown, o: unknown) => Promise<unknown>;
        }
      ).execute({}, { ...callOptions, abortSignal: controller.signal }),
    ).rejects.toThrow("already cancelled");
    expect(request).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});

describe("withGuardian against the hosted gateway's replies", () => {
  it("remote mode: an upstream failure is a GuardianExecutionFailed, never an ALLOW result", async () => {
    const run = vi.fn();
    const onReceipt = vi.fn();
    const client = stubClient({
      request: vi.fn().mockResolvedValue(allow("req_r", "cap_r")),
      execute: vi.fn().mockResolvedValue({
        ok: true,
        receipt: { id: "rcpt_r", status: "outcome-unconfirmed" },
      }),
    });
    const tools = withGuardian(
      { refund_order: fakeTool(run) },
      { client, connectionId: "con_1", onReceipt },
    );
    const err = await call(tools.refund_order, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardianExecutionFailed);
    expect(err).toMatchObject({
      requestId: "req_r",
      reasonCode: "EXECUTION_OUTCOME_UNKNOWN",
      outcomeUnknown: true,
      detail: "outcome-unconfirmed",
      localEffectRan: false,
    });
    expect(onReceipt).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("inProcess: an mcp.install INVALID_REQUEST (maybe already registered) is refused before anything runs", async () => {
    const run = vi.fn().mockResolvedValue("ok");
    const request = vi
      .fn()
      .mockResolvedValue({ ok: false, reasonCode: "INVALID_REQUEST" });
    const execute = vi.fn();
    const client = stubClient({ request, execute });
    const tools = withGuardian(
      { refund_order: fakeTool(run) },
      {
        client,
        connectionId: "con_1",
        mode: "inProcess",
        installRecordTransport: true,
      },
    );
    const err = await call(tools.refund_order, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardianDenied);
    expect(err).toMatchObject({
      reasonCode: "RECORD_TRANSPORT_UNVERIFIED",
      hint: expect.stringContaining("installRecordTransport: false"),
    });
    expect((err as GuardianDenied).hint).toContain(
      "Automatic registration only works while no entry with that name exists",
    );
    // Not enabled, not proposed, not redeemed: the existing entry could be
    // an HTTP tool, and running the impl too would act twice.
    expect(request.mock.calls.map((c) => c[0].action)).toEqual(["mcp.install"]);
    expect(execute).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("inProcess: a tool registered in the console runs with installRecordTransport off (the default)", async () => {
    const run = vi.fn().mockResolvedValue("ok");
    const request = vi.fn().mockResolvedValue(allow());
    const client = stubClient({
      request,
      execute: vi.fn().mockResolvedValue({ ok: true, receipt: { id: "r" } }),
    });
    const tools = withGuardian(
      { refund_order: fakeTool(run) },
      {
        client,
        connectionId: "con_1",
        mode: "inProcess",
        installRecordTransport: false,
      },
    );
    await expect(call(tools.refund_order, {})).resolves.toBe("ok");
    expect(request.mock.calls.map((c) => c[0].action)).toEqual(["tool.invoke"]);
    expect(run).toHaveBeenCalledOnce();
  });

  it("inProcess: a fresh install is enabled through Guardian before the call", async () => {
    const run = vi.fn().mockResolvedValue("ok");
    const request = vi
      .fn()
      .mockResolvedValueOnce(allow("req_install", "cap_install"))
      .mockResolvedValueOnce({ ok: false, reasonCode: "TOOL_ALREADY_ENABLED" })
      .mockResolvedValueOnce(allow());
    const client = stubClient({
      request,
      execute: vi.fn().mockResolvedValue({ ok: true, receipt: { id: "r" } }),
    });
    const tools = withGuardian(
      { refund_order: fakeTool(run) },
      {
        client,
        connectionId: "con_1",
        mode: "inProcess",
        installRecordTransport: true,
      },
    );
    await expect(call(tools.refund_order, {})).resolves.toBe("ok");
    expect(request.mock.calls.map((c) => c[0].action)).toEqual([
      "mcp.install",
      "mcp.enable",
      "tool.invoke",
    ]);
  });
});
