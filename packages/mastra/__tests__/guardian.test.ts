import { describe, expect, it, vi } from "vitest";
import { createTool, isValidationError, Tool } from "@mastra/core/tools";
import { RequestContext } from "@mastra/core/request-context";
import { z } from "zod";

import {
  GuardianApprovalPending,
  GuardianDenied,
  guardianTool,
  guardianTools,
} from "../src/index.js";
import { allow, stubClient } from "./helpers.js";

const receipt = { id: "rcpt_1", status: "sent-verified" };

function refundTool(run: (input: unknown, context: unknown) => unknown) {
  return createTool({
    id: "refund_order",
    description: "Refund an order",
    inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
    outputSchema: z.object({ refunded: z.string() }),
    execute: async (input, context) => run(input, context) as never,
  });
}

const call = (tool: unknown, input: unknown, context?: unknown) =>
  (
    tool as { execute: (i: unknown, c?: unknown) => Promise<unknown> }
  ).execute(input, context);

describe("guardianTool: the returned tool", () => {
  it("is a Mastra tool with the same id, description, schemas and flags", () => {
    const inner = createTool({
      id: "refund_order",
      description: "Refund an order",
      inputSchema: z.object({ orderId: z.string() }),
      outputSchema: z.object({ refunded: z.string() }),
      requireApproval: true,
      execute: async () => ({ refunded: "x" }),
    });
    const wrapped = guardianTool(inner, {
      client: stubClient({}),
      connectionId: "con_1",
    });
    expect(wrapped).not.toBe(inner);
    expect(wrapped).toBeInstanceOf(Tool);
    expect(wrapped.id).toBe("refund_order");
    expect(wrapped.description).toBe("Refund an order");
    expect(wrapped.inputSchema).toBe(inner.inputSchema);
    expect(wrapped.outputSchema).toBe(inner.outputSchema);
    expect(wrapped.requireApproval).toBe(true);
    expect(wrapped.execute).not.toBe(inner.execute);
  });

  it("returns a tool without execute, and a render-only tool, unchanged", () => {
    const options = { client: stubClient({}), connectionId: "con_1" };
    const clientSide = createTool({ id: "pick_color", description: "d" });
    const renderOnly = createTool({
      id: "show_card",
      description: "d",
      renderOnly: true,
    });
    expect(guardianTool(clientSide, options)).toBe(clientSide);
    expect(guardianTool(renderOnly, options)).toBe(renderOnly);
  });

  it("refuses a value that is not a Mastra tool", () => {
    expect(() =>
      guardianTool({ execute: async () => 1 } as never, {
        client: stubClient({}),
        connectionId: "con_1",
      }),
    ).toThrow(TypeError);
  });

  it("guardianTools keeps the keys and decides by tool id", async () => {
    const request = vi.fn().mockResolvedValue(allow());
    const execute = vi.fn().mockResolvedValue({ ok: true, receipt });
    const tools = guardianTools(
      { refund: refundTool(() => ({ refunded: "o" })) },
      { client: stubClient({ request, execute }), connectionId: "con_1" },
    );
    expect(Object.keys(tools)).toEqual(["refund"]);
    await call(tools.refund, { orderId: "o", amount: 1 });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "refund_order" }),
    );
  });
});

describe("guardianTool remote mode (default)", () => {
  it("ALLOW: Guardian performs the call, the local execute never runs", async () => {
    const run = vi.fn();
    const request = vi.fn().mockResolvedValue(allow());
    const execute = vi.fn().mockResolvedValue({ ok: true, receipt });
    const wrapped = guardianTool(refundTool(run), {
      client: stubClient({ request, execute }),
      connectionId: "con_1",
    });
    const out = await call(wrapped, { orderId: "ord_9", amount: 25 });
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
    expect(out).toEqual({
      guardian: {
        decision: "ALLOW",
        requestId: "req_1",
        toolName: "refund_order",
        receipt,
      },
    });
  });

  it("modes: one tool remote, the others in-process", async () => {
    const remoteRun = vi.fn();
    const localRun = vi.fn().mockReturnValue({ refunded: "o" });
    const request = vi.fn().mockResolvedValue(allow());
    const execute = vi.fn().mockResolvedValue({ ok: true, receipt });
    const lookup = createTool({
      id: "lookup_order",
      description: "d",
      inputSchema: z.object({ orderId: z.string() }),
      execute: async (input) => remoteRun(input) as never,
    });
    const tools = guardianTools(
      { refund: refundTool(localRun), lookup },
      {
        client: stubClient({ request, execute }),
        connectionId: "con_1",
        mode: "inProcess",
        modes: { lookup_order: "remote" },
      },
    );
    await call(tools.lookup, { orderId: "o" });
    await call(tools.refund, { orderId: "o", amount: 1 });
    expect(remoteRun).not.toHaveBeenCalled();
    expect(localRun).toHaveBeenCalledTimes(1);
  });

  it("a tool's toModelOutput is not applied to Guardian's answer", async () => {
    const toModelOutput = vi.fn((output: unknown) => ({ mapped: output }));
    const inner = createTool({
      id: "refund_order",
      description: "d",
      inputSchema: z.object({ orderId: z.string() }),
      toModelOutput,
      execute: async () => ({ refunded: "o" }),
    });
    const wrapped = guardianTool(inner, {
      client: stubClient({
        request: vi.fn().mockResolvedValue(allow()),
        execute: vi.fn().mockResolvedValue({ ok: true, receipt }),
      }),
      connectionId: "con_1",
    });
    const out = await call(wrapped, { orderId: "o" });
    expect(wrapped.toModelOutput!(out as never)).toEqual({
      type: "json",
      value: out,
    });
    expect(toModelOutput).not.toHaveBeenCalled();
    expect(wrapped.toModelOutput!({ refunded: "o" } as never)).toEqual({
      mapped: { refunded: "o" },
    });
  });
});

describe("guardianTool amountArgs (passed to the SDK unchanged, keyed by tool id)", () => {
  it("each call of a declared tool carries the declaration and the amount", async () => {
    const cents = {
      argument: "amount",
      unit: "minor" as const,
      currency: "usd" as const,
    };
    const run = vi.fn();
    const request = vi.fn().mockResolvedValue(allow());
    const tools = guardianTools(
      { refund: refundTool(run) },
      {
        client: stubClient({
          request,
          execute: vi.fn().mockResolvedValue({ ok: true, receipt }),
        }),
        connectionId: "con_1",
        amountArgs: { refund_order: cents },
      },
    );
    await call(tools.refund, { orderId: "o", amount: 2000 });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ amountArgument: cents, valueCents: 2000 }),
    );
    expect(run).not.toHaveBeenCalled();
  });
});

describe("guardianTool inProcess mode", () => {
  const options = (client: ReturnType<typeof stubClient>) => ({
    client,
    connectionId: "con_1",
    mode: "inProcess" as const,
  });

  it("ALLOW: runs once on the decided arguments, then redeems", async () => {
    const order: string[] = [];
    const run = vi.fn((input: unknown) => {
      order.push("run");
      return { refunded: (input as { orderId: string }).orderId };
    });
    const request = vi.fn().mockResolvedValue(allow());
    const execute = vi.fn(async () => {
      order.push("redeem");
      return { ok: true, receipt };
    });
    const onReceipt = vi.fn();
    const wrapped = guardianTool(refundTool(run), {
      ...options(stubClient({ request, execute: execute as never })),
      onReceipt,
    });
    const context = { requestContext: undefined };
    const out = await call(wrapped, { orderId: "ord_9", amount: 25 }, context);
    expect(out).toEqual({ refunded: "ord_9" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toEqual({ orderId: "ord_9", amount: 25 });
    expect(order).toEqual(["run", "redeem"]);
    expect(execute).toHaveBeenCalledWith({
      requestId: "req_1",
      capabilityToken: "cap_1",
    });
    expect(onReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "refund_order", requestId: "req_1" }),
    );
  });

  it("ASK: does not run and carries the requestId; the same call after approval claims it and runs once", async () => {
    const run = vi.fn().mockReturnValue({ refunded: "ord_9" });
    const request = vi
      .fn()
      .mockResolvedValue({ ok: true, decision: "ASK", requestId: "req_7" });
    const claim = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        requestId: "req_7",
        reasonCode: "APPROVAL_PENDING",
      })
      .mockResolvedValue(allow("req_7", "cap_7"));
    const execute = vi.fn().mockResolvedValue({ ok: true, receipt });
    const wrapped = guardianTool(
      refundTool(run),
      options(stubClient({ request, claim, execute })),
    );
    const input = { orderId: "ord_9", amount: 25 };

    const held = await call(wrapped, input).catch((e: unknown) => e);
    expect(held).toBeInstanceOf(GuardianApprovalPending);
    expect(held).toMatchObject({ requestId: "req_7", toolName: "refund_order" });
    expect(run).not.toHaveBeenCalled();

    // Before the person approves: still held, still not run.
    const again = await call(wrapped, input).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(GuardianApprovalPending);
    expect(run).not.toHaveBeenCalled();

    // After approval the same call claims the approved request.
    expect(await call(wrapped, input)).toEqual({ refunded: "ord_9" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith("req_7");
    expect(run).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({
      requestId: "req_7",
      capabilityToken: "cap_7",
    });
  });

  it("ASK with onAsk result: returns the held request to the caller", async () => {
    const run = vi.fn();
    const wrapped = guardianTool(refundTool(run), {
      ...options(
        stubClient({
          request: vi
            .fn()
            .mockResolvedValue({ ok: true, decision: "ASK", requestId: "req_7" }),
        }),
      ),
      onAsk: "result",
    });
    const out = await call(wrapped, { orderId: "o", amount: 1 });
    expect(out).toMatchObject({
      guardian: { decision: "ASK", requestId: "req_7", toolName: "refund_order" },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("DENY: throws GuardianDenied and does not run", async () => {
    const run = vi.fn();
    const execute = vi.fn();
    const wrapped = guardianTool(
      refundTool(run),
      options(
        stubClient({
          request: vi.fn().mockResolvedValue({
            ok: false,
            requestId: "req_2",
            reasonCode: "POLICY_DENY",
          }),
          execute,
        }),
      ),
    );
    const err = await call(wrapped, { orderId: "o", amount: 1 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GuardianDenied);
    expect(err).toMatchObject({ reasonCode: "POLICY_DENY" });
    expect(run).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("DENY with onDeny result: returns the denial", async () => {
    const run = vi.fn();
    const wrapped = guardianTool(refundTool(run), {
      ...options(
        stubClient({
          request: vi
            .fn()
            .mockResolvedValue({ ok: false, reasonCode: "POLICY_DENY" }),
        }),
      ),
      onDeny: "result",
    });
    expect(await call(wrapped, { orderId: "o", amount: 1 })).toMatchObject({
      guardian: { decision: "DENY", reasonCode: "POLICY_DENY" },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("Guardian unreachable: fails closed, nothing runs", async () => {
    const run = vi.fn();
    const execute = vi.fn();
    const thrown = guardianTool(
      refundTool(run),
      options(
        stubClient({
          request: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
          execute,
        }),
      ),
    );
    await expect(call(thrown, { orderId: "o", amount: 1 })).rejects.toThrow(
      "ECONNREFUSED",
    );
    const answered = guardianTool(
      refundTool(run),
      options(
        stubClient({
          request: vi
            .fn()
            .mockResolvedValue({ ok: false, reasonCode: "SERVICE_UNAVAILABLE" }),
          execute,
        }),
      ),
    );
    await expect(
      call(answered, { orderId: "o", amount: 1 }),
    ).rejects.toBeInstanceOf(GuardianDenied);
    expect(run).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("argument integrity: the tool runs on what Guardian decided, not on a later change", async () => {
    const run = vi.fn().mockReturnValue({ refunded: "ord_9" });
    let release!: (value: unknown) => void;
    const request = vi.fn(
      () => new Promise((resolve) => (release = resolve)),
    );
    const execute = vi.fn().mockResolvedValue({ ok: true, receipt });
    const wrapped = guardianTool(
      refundTool(run),
      options(stubClient({ request: request as never, execute })),
    );
    const input = { orderId: "ord_9", amount: 25 };
    const pending = call(wrapped, input);
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    // Changed while Guardian is deciding.
    input.amount = 9_999;
    input.orderId = "ord_other";
    release(allow());
    await pending;
    const decided = (request.mock.calls[0] as unknown[])[0] as {
      arguments: unknown;
    };
    expect(decided.arguments).toEqual({ orderId: "ord_9", amount: 25 });
    expect(run.mock.calls[0]![0]).toEqual({ orderId: "ord_9", amount: 25 });
    expect(run.mock.calls[0]![0]).not.toBe(input);
  });

  it("a direct call the tool's schema refuses: the body does not run and nothing is redeemed", async () => {
    const run = vi.fn();
    const execute = vi.fn();
    const wrapped = guardianTool(
      refundTool(run),
      options(
        stubClient({ request: vi.fn().mockResolvedValue(allow()), execute }),
      ),
    );
    const out = await call(wrapped, { orderId: 7 });
    expect(isValidationError(out)).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("a request context the tool's schema refuses: Guardian is not asked, the body does not run, nothing is recorded", async () => {
    const run = vi.fn();
    const request = vi.fn().mockResolvedValue(allow());
    const execute = vi.fn().mockResolvedValue({ ok: true, receipt });
    const onReceipt = vi.fn();
    const inner = createTool({
      id: "refund_order",
      description: "Refund an order",
      inputSchema: z.object({ orderId: z.string() }),
      requestContextSchema: z.object({ tenantId: z.string() }),
      execute: async (input) => run(input) as never,
    });
    const wrapped = guardianTool(inner, {
      ...options(stubClient({ request, execute })),
      onReceipt,
    });
    const out = await call(wrapped, { orderId: "ord_9" });
    expect(isValidationError(out)).toBe(true);
    // The same answer the unwrapped tool gives.
    expect(out).toEqual(await call(inner, { orderId: "ord_9" }));
    expect(run).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(onReceipt).not.toHaveBeenCalled();
  });

  it("a request context that stops passing while Guardian decides: the body does not run and nothing is recorded", async () => {
    const run = vi.fn();
    const requestContext = new RequestContext<{ tenantId?: string }>();
    requestContext.set("tenantId", "t_1");
    const request = vi.fn(async () => {
      requestContext.delete("tenantId");
      return allow();
    });
    const execute = vi.fn().mockResolvedValue({ ok: true, receipt });
    const onReceipt = vi.fn();
    const wrapped = guardianTool(
      createTool({
        id: "refund_order",
        description: "Refund an order",
        inputSchema: z.object({ orderId: z.string() }),
        requestContextSchema: z.object({ tenantId: z.string() }),
        execute: async (input) => run(input) as never,
      }),
      {
        ...options(stubClient({ request: request as never, execute })),
        onReceipt,
      },
    );
    const out = await call(wrapped, { orderId: "ord_9" }, { requestContext });
    expect(isValidationError(out)).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(onReceipt).not.toHaveBeenCalled();
  });

  it("resume data the tool's resumeSchema refuses: Guardian is not asked, the body does not run, nothing is recorded", async () => {
    const run = vi.fn();
    const request = vi.fn().mockResolvedValue(allow());
    const execute = vi.fn().mockResolvedValue({ ok: true, receipt });
    const wrapped = guardianTool(
      createTool({
        id: "refund_order",
        description: "Refund an order",
        inputSchema: z.object({ orderId: z.string() }),
        resumeSchema: z.object({ confirmed: z.boolean() }),
        execute: async (input) => run(input) as never,
      }),
      options(stubClient({ request, execute })),
    );
    const out = await call(
      wrapped,
      { orderId: "ord_9" },
      { resumeData: { confirmed: "yes" } },
    );
    expect(isValidationError(out)).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("an output the tool's outputSchema refuses: the body ran, so the call is recorded", async () => {
    const run = vi.fn().mockReturnValue({ refunded: 7 });
    const execute = vi.fn().mockResolvedValue({ ok: true, receipt });
    const wrapped = guardianTool(
      refundTool(run),
      options(
        stubClient({ request: vi.fn().mockResolvedValue(allow()), execute }),
      ),
    );
    const out = await call(wrapped, { orderId: "o", amount: 1 });
    expect(isValidationError(out)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("the tool's own error propagates and nothing is redeemed", async () => {
    const execute = vi.fn();
    const wrapped = guardianTool(
      refundTool(() => {
        throw new Error("payment provider down");
      }),
      options(
        stubClient({ request: vi.fn().mockResolvedValue(allow()), execute }),
      ),
    );
    await expect(call(wrapped, { orderId: "o", amount: 1 })).rejects.toThrow(
      "payment provider down",
    );
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("guardianTool abort (context.abortSignal)", () => {
  const options = (client: ReturnType<typeof stubClient>, mode: "inProcess" | "remote") => ({
    client,
    connectionId: "con_1",
    mode,
  });

  it("already aborted: Guardian is not asked and nothing runs", async () => {
    const run = vi.fn();
    const request = vi.fn();
    const wrapped = guardianTool(
      refundTool(run),
      options(stubClient({ request }), "inProcess"),
    );
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(
      call(wrapped, { orderId: "o", amount: 1 }, { abortSignal: controller.signal }),
    ).rejects.toThrow("stopped");
    expect(request).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["inProcess", "remote"] as const)(
    "aborted while Guardian decides (%s): rejects at once and a late ALLOW runs nothing",
    async (mode) => {
      const run = vi.fn();
      let release!: (value: unknown) => void;
      const request = vi.fn(
        () => new Promise((resolve) => (release = resolve)),
      );
      const execute = vi.fn().mockResolvedValue({ ok: true, receipt });
      const wrapped = guardianTool(
        refundTool(run),
        options(stubClient({ request: request as never, execute }), mode),
      );
      const controller = new AbortController();
      const pending = call(
        wrapped,
        { orderId: "o", amount: 1 },
        { abortSignal: controller.signal },
      );
      await vi.waitFor(() => expect(request).toHaveBeenCalled());
      controller.abort(new Error("stopped"));
      await expect(pending).rejects.toThrow("stopped");
      release(allow());
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(run).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("aborted after the tool started: waits for the real outcome", async () => {
    let finish!: (value: unknown) => void;
    const run = vi.fn(() => new Promise((resolve) => (finish = resolve)));
    const execute = vi.fn().mockResolvedValue({ ok: true, receipt });
    const wrapped = guardianTool(
      refundTool(run),
      options(
        stubClient({ request: vi.fn().mockResolvedValue(allow()), execute }),
        "inProcess",
      ),
    );
    const controller = new AbortController();
    const pending = call(
      wrapped,
      { orderId: "o", amount: 1 },
      { abortSignal: controller.signal },
    );
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    controller.abort(new Error("stopped"));
    finish({ refunded: "o" });
    expect(await pending).toEqual({ refunded: "o" });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('guardianTool onAsk: "suspend"', () => {
  const held = () =>
    stubClient({
      request: vi
        .fn()
        .mockResolvedValue({ ok: true, decision: "ASK", requestId: "req_7" }),
    });

  it("suspends through the context's suspend with the requestId", async () => {
    const run = vi.fn();
    const suspend = vi.fn().mockResolvedValue(undefined);
    const wrapped = guardianTool(refundTool(run), {
      client: held(),
      connectionId: "con_1",
      mode: "inProcess",
      onAsk: "suspend",
    });
    const out = await call(
      wrapped,
      { orderId: "o", amount: 1 },
      { agent: { suspend } },
    );
    expect(out).toBeUndefined();
    expect(suspend).toHaveBeenCalledWith({
      guardian: expect.objectContaining({
        decision: "ASK",
        requestId: "req_7",
        toolName: "refund_order",
      }),
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("throws GuardianApprovalPending when the call cannot suspend", async () => {
    const wrapped = guardianTool(refundTool(vi.fn()), {
      client: held(),
      connectionId: "con_1",
      onAsk: "suspend",
    });
    await expect(
      call(wrapped, { orderId: "o", amount: 1 }),
    ).rejects.toBeInstanceOf(GuardianApprovalPending);
  });

  it("the arguments kept for a suspended call are dropped after 24 hours when the run is never resumed", async () => {
    vi.useFakeTimers();
    try {
      let generated = 0;
      let seq = 0;
      const request = vi.fn(async () => ({
        ok: true,
        decision: "ASK",
        requestId: `req_${++seq}`,
      }));
      const claim = vi.fn(async (requestId: string) => ({
        ok: false,
        requestId,
        reasonCode: "APPROVAL_PENDING",
      }));
      const wrapped = guardianTool(
        createTool({
          id: "refund_order",
          description: "Refund an order",
          inputSchema: z.object({
            orderId: z.string(),
            reference: z.string().default(() => `ref_${++generated}`),
          }),
          execute: async () => ({ refunded: "o" }),
        }),
        {
          client: stubClient({ request: request as never, claim: claim as never }),
          connectionId: "con_1",
          mode: "inProcess",
          onAsk: "suspend",
        },
      );
      const suspend = vi.fn().mockResolvedValue(undefined);
      const first = (runId: string) =>
        call(
          wrapped,
          { orderId: "o", reference: `first_${runId}` },
          { runId, agent: { toolCallId: "call_1", suspend } },
        );
      const resume = (runId: string, requestId: string) =>
        call(
          wrapped,
          { orderId: "o" },
          {
            runId,
            agent: {
              toolCallId: "call_1",
              suspend,
              resumeData: {},
              suspendPayload: { guardian: { requestId } },
            },
          },
        );

      await first("run_a"); // req_1, never resumed in time
      vi.advanceTimersByTime(23 * 60 * 60 * 1000);
      await first("run_b"); // req_2: run_a is 23 hours old and is kept
      await resume("run_a", "req_1");
      // Kept: the resumed call claims req_1 on the first call's arguments.
      expect(claim).toHaveBeenLastCalledWith("req_1");
      expect(request).toHaveBeenCalledTimes(2);

      // run_a was suspended again by that resume; now it is abandoned.
      vi.advanceTimersByTime(25 * 60 * 60 * 1000);
      await first("run_c"); // req_3: everything older than 24 hours goes
      claim.mockClear();
      await resume("run_a", "req_1");
      // Dropped: the stored arguments are parsed again, a new reference is
      // generated, and the call is proposed as a new request.
      expect(claim).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(4);
      expect(
        (request.mock.calls[3] as unknown as [{ arguments: unknown }])[0]
          .arguments,
      ).toEqual({ orderId: "o", reference: "ref_1" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a tool that declares its own suspend or resume schema", () => {
    const inner = createTool({
      id: "ask_user",
      description: "d",
      suspendSchema: z.object({ question: z.string() }),
      resumeSchema: z.object({ answer: z.string() }),
      execute: async () => ({}),
    });
    const options = { client: held(), connectionId: "con_1" };
    expect(() => guardianTool(inner, { ...options, onAsk: "suspend" })).toThrow(
      TypeError,
    );
    expect(() => guardianTool(inner, options)).not.toThrow();
  });
});

describe("guardianTool abort after a setup step held by an earlier call", () => {
  it("an abort while Guardian decides the tool call rejects, and a late ALLOW runs nothing and redeems nothing", async () => {
    // `mcp.install` is held until approved, `mcp.enable` is already done,
    // and the tool call's own decision waits for `decide`.
    let approved = false;
    let decide!: (value: unknown) => void;
    const decision = new Promise((resolve) => (decide = resolve));
    const request = vi.fn(async (input: { action: string }) => {
      if (input.action === "mcp.install") {
        return { ok: true, requestId: "req_setup", decision: "ASK" };
      }
      if (input.action === "mcp.enable") {
        return { ok: false, reasonCode: "TOOL_ALREADY_ENABLED" };
      }
      return decision;
    });
    const claim = vi.fn(async (requestId: string) =>
      approved
        ? allow(requestId, "cap_setup")
        : { ok: false, requestId, reasonCode: "APPROVAL_PENDING" },
    );
    const execute = vi.fn().mockResolvedValue({ ok: true, receipt });
    const run = vi.fn();
    const wrapped = guardianTool(refundTool(run), {
      client: stubClient({
        request: request as never,
        claim: claim as never,
        execute,
      }),
      connectionId: "con_1",
      mode: "inProcess",
      installRecordTransport: true,
    });
    const input = { orderId: "o", amount: 1 };
    // Call 1: the registration step is held for approval.
    await expect(call(wrapped, input)).rejects.toBeInstanceOf(
      GuardianApprovalPending,
    );
    approved = true;
    // Call 2 claims and executes the approved step, then asks for the tool.
    const controller = new AbortController();
    const second = call(wrapped, input, {
      abortSignal: controller.signal,
    }).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({ action: "tool.invoke" }),
      ),
    );
    controller.abort(new Error("cancelled by caller"));
    expect(await second).toBe("cancelled by caller");
    decide(allow("req_tool", "cap_tool"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(run).not.toHaveBeenCalled();
    // Only the setup step was executed.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({
      requestId: "req_setup",
      capabilityToken: "cap_setup",
    });
  });
});
