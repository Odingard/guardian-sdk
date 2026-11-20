/**
 * The wrapper inside Mastra's real agent loop: an `Agent` (registered on a
 * `Mastra` instance with in-memory storage, which suspend/resume needs)
 * driven by a scripted model. No network, no API key.
 */
import { describe, expect, it, vi } from "vitest";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import {
  guardianTools,
  type GuardianMastraOptions,
  type GuardianSuspendPayload,
} from "../src/index.js";
import {
  fakeGuardian,
  say,
  scriptedModel,
  toolCall,
  toolResultsSeen,
  type ScriptedPart,
} from "./helpers.js";

type Guardian = ReturnType<typeof fakeGuardian>;

/**
 * `amount` arrives as a string and the schema turns it into a number, so a
 * second parse of the parsed value would fail: the tests see whether the
 * tool body got exactly the value Guardian decided on.
 */
function refundTool(run: (input: unknown, context: unknown) => unknown) {
  return createTool({
    id: "refund_order",
    description: "Refund an order",
    inputSchema: z.object({
      orderId: z.string(),
      amount: z.string().transform((value) => Number(value)),
    }),
    execute: async (input, context) => run(input, context) as never,
  });
}

function setup(
  guardian: Guardian,
  script: ScriptedPart[][],
  options: Partial<GuardianMastraOptions> = {},
  run: (input: unknown, context: unknown) => unknown = () => ({
    refunded: true,
  }),
  tool: (
    run: (input: unknown, context: unknown) => unknown,
  ) => ReturnType<typeof createTool> = refundTool as never,
) {
  const body = vi.fn(run);
  const { model, prompts } = scriptedModel(script);
  const tools = guardianTools(
    { refund: tool(body) },
    {
      client: guardian.client,
      connectionId: "con_1",
      mode: "inProcess",
      ...options,
    },
  );
  const mastra = new Mastra({
    agents: {
      billing: new Agent({
        id: "billing",
        name: "billing",
        instructions: "Refund orders when asked.",
        model,
        tools,
      }),
    },
    storage: new InMemoryStore(),
    logger: false,
  });
  return { agent: mastra.getAgent("billing"), body, prompts };
}

const refundCall = (id = "call_1") =>
  toolCall(id, "refund", { orderId: "ord_9", amount: "25" });

describe("a Mastra Agent with Guardian-wrapped tools", () => {
  it("ALLOW: the tool runs once on the arguments Guardian decided, then the capability is redeemed", async () => {
    const guardian = fakeGuardian(() => "ALLOW");
    const { agent, body, prompts } = setup(guardian, [
      [refundCall()],
      [say("Refunded.")],
    ]);
    const result = await agent.generate("Refund order ord_9, $25");
    expect(result.text).toBe("Refunded.");
    expect(guardian.requests).toEqual([
      {
        requestId: "req_1",
        toolName: "refund_order",
        arguments: { orderId: "ord_9", amount: 25 },
        decision: "ALLOW",
      },
    ]);
    expect(body).toHaveBeenCalledTimes(1);
    expect(body.mock.calls[0]![0]).toEqual({ orderId: "ord_9", amount: 25 });
    expect(guardian.redeemed).toEqual(["req_1"]);
    expect(toolResultsSeen(prompts)[0]!.output).toEqual({
      type: "json",
      value: { refunded: true },
    });
  });

  it("ALLOW with stream(): same path", async () => {
    const guardian = fakeGuardian(() => "ALLOW");
    const { agent, body } = setup(guardian, [[refundCall()], [say("Refunded.")]]);
    const stream = await agent.stream("Refund order ord_9, $25");
    expect(await stream.text).toBe("Refunded.");
    expect(body).toHaveBeenCalledTimes(1);
    expect(body.mock.calls[0]![0]).toEqual({ orderId: "ord_9", amount: 25 });
    expect(guardian.redeemed).toEqual(["req_1"]);
  });

  it("ASK: the tool does not run and the model is told the requestId; after approval the same call claims the request and runs once", async () => {
    const guardian = fakeGuardian(() => "ASK");
    const { agent, body, prompts } = setup(guardian, [
      [refundCall("call_1")],
      [say("Waiting for approval.")],
      [refundCall("call_2")],
      [say("Refunded.")],
    ]);
    const first = await agent.generate("Refund order ord_9, $25");
    expect(first.text).toBe("Waiting for approval.");
    expect(body).not.toHaveBeenCalled();
    expect(guardian.execute).not.toHaveBeenCalled();
    const held = toolResultsSeen(prompts)[0]!.output;
    expect(held.type).toBe("error-text");
    expect(held.value).toContain("req_1");

    guardian.approve("req_1");
    const second = await agent.generate("It is approved, go ahead");
    expect(second.text).toBe("Refunded.");
    expect(guardian.request).toHaveBeenCalledTimes(1);
    expect(guardian.claim).toHaveBeenCalledWith("req_1");
    expect(body).toHaveBeenCalledTimes(1);
    expect(body.mock.calls[0]![0]).toEqual({ orderId: "ord_9", amount: 25 });
    expect(guardian.redeemed).toEqual(["req_1"]);
  });

  it('ASK with onAsk "result": the held request is the tool result the model sees', async () => {
    const guardian = fakeGuardian(() => "ASK");
    const { agent, body, prompts } = setup(
      guardian,
      [[refundCall()], [say("Waiting for approval.")]],
      { onAsk: "result" },
    );
    await agent.generate("Refund order ord_9, $25");
    expect(body).not.toHaveBeenCalled();
    expect(toolResultsSeen(prompts)[0]!.output).toMatchObject({
      type: "json",
      value: {
        guardian: {
          decision: "ASK",
          requestId: "req_1",
          toolName: "refund_order",
        },
      },
    });
  });

  it("DENY: the tool does not run and the model is told why", async () => {
    const guardian = fakeGuardian(() => "DENY");
    const { agent, body, prompts } = setup(guardian, [
      [refundCall()],
      [say("I cannot refund that.")],
    ]);
    const result = await agent.generate("Refund order ord_9, $25");
    expect(result.text).toBe("I cannot refund that.");
    expect(body).not.toHaveBeenCalled();
    expect(guardian.execute).not.toHaveBeenCalled();
    const output = toolResultsSeen(prompts)[0]!.output;
    expect(output.type).toBe("error-text");
    expect(output.value).toContain("POLICY_DENY");
  });

  it("Guardian unreachable: fails closed, the tool does not run", async () => {
    const guardian = fakeGuardian(() => "ALLOW");
    guardian.request.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const { agent, body, prompts } = setup(guardian, [
      [refundCall()],
      [say("Guardian is down.")],
    ]);
    await agent.generate("Refund order ord_9, $25");
    expect(body).not.toHaveBeenCalled();
    expect(guardian.execute).not.toHaveBeenCalled();
    expect(toolResultsSeen(prompts)[0]!.output.type).toBe("error-text");
  });

  it("arguments the tool's schema refuses never reach Guardian or the tool", async () => {
    const guardian = fakeGuardian(() => "ALLOW");
    const { agent, body } = setup(guardian, [
      [toolCall("call_1", "refund", { orderId: 7 })],
      [say("Bad arguments.")],
    ]);
    await agent.generate("Refund something");
    expect(guardian.request).not.toHaveBeenCalled();
    expect(body).not.toHaveBeenCalled();
  });

  it("remote mode: Guardian performs the call, the local tool body never runs, the model gets Guardian's result", async () => {
    const guardian = fakeGuardian(() => "ALLOW");
    const { agent, body, prompts } = setup(
      guardian,
      [[refundCall()], [say("Refunded.")]],
      { mode: "remote" },
    );
    await agent.generate("Refund order ord_9, $25");
    expect(body).not.toHaveBeenCalled();
    expect(guardian.redeemed).toEqual(["req_1"]);
    expect(toolResultsSeen(prompts)[0]!.output).toMatchObject({
      type: "json",
      value: {
        guardian: {
          decision: "ALLOW",
          requestId: "req_1",
          toolName: "refund_order",
          receipt: { id: "rcpt_req_1", status: "sent-verified" },
        },
      },
    });
  });

  it("remote mode: the tool's outputSchema and toModelOutput are not applied to Guardian's result", async () => {
    const guardian = fakeGuardian(() => "ALLOW");
    const toModelOutput = vi.fn(() => "mapped");
    const { agent, body, prompts } = setup(
      guardian,
      [[refundCall()], [say("Refunded.")]],
      { mode: "remote" },
      undefined,
      ((run: (input: unknown, context: unknown) => unknown) =>
        createTool({
          id: "refund_order",
          description: "Refund an order",
          inputSchema: z.object({ orderId: z.string(), amount: z.string() }),
          outputSchema: z.object({ refunded: z.literal(true) }),
          toModelOutput,
          execute: async (input, context) => run(input, context) as never,
        })) as never,
    );
    await agent.generate("Refund order ord_9, $25");
    expect(body).not.toHaveBeenCalled();
    expect(toModelOutput).not.toHaveBeenCalled();
    expect(toolResultsSeen(prompts)[0]!.output).toMatchObject({
      type: "json",
      value: { guardian: { decision: "ALLOW", requestId: "req_1" } },
    });
  });

  it("a tool that suspends itself is decided again when its run resumes", async () => {
    const guardian = fakeGuardian(() => "ALLOW");
    const { agent, body } = setup(
      guardian,
      [[refundCall()], [say("Refunded.")]],
      {},
      async (input, context) => {
        const agentContext = (
          context as {
            agent: {
              resumeData?: { confirmed: boolean };
              suspend: (payload: unknown) => Promise<void>;
            };
          }
        ).agent;
        if (agentContext.resumeData === undefined) {
          await agentContext.suspend({ question: "Really?" });
          return undefined;
        }
        return { refunded: agentContext.resumeData.confirmed, input };
      },
      ((run: (input: unknown, context: unknown) => unknown) =>
        createTool({
          id: "refund_order",
          description: "Refund an order",
          inputSchema: z.object({
            orderId: z.string(),
            amount: z.string().transform((value) => Number(value)),
          }),
          suspendSchema: z.object({ question: z.string() }),
          resumeSchema: z.object({ confirmed: z.boolean() }),
          execute: async (input, context) => run(input, context) as never,
        })) as never,
    );
    const first = await agent.generate("Refund order ord_9, $25");
    expect(first.finishReason).toBe("suspended");
    expect(guardian.redeemed).toEqual(["req_1"]);
    const done = await agent.resumeGenerate(
      { confirmed: true },
      { runId: first.runId!, toolCallId: "call_1" },
    );
    expect(done.text).toBe("Refunded.");
    expect(body).toHaveBeenCalledTimes(2);
    // Both runs of the body were decided, on the same parsed arguments.
    expect(guardian.requests.map((request) => request.arguments)).toEqual([
      { orderId: "ord_9", amount: 25 },
      { orderId: "ord_9", amount: 25 },
    ]);
    expect(body.mock.calls[1]![0]).toEqual({ orderId: "ord_9", amount: 25 });
    expect(guardian.redeemed).toEqual(["req_1", "req_2"]);
  });

  it("abort while Guardian decides: the tool does not run, even when ALLOW arrives later", async () => {
    const guardian = fakeGuardian(() => "ALLOW");
    let release!: (value: unknown) => void;
    guardian.request.mockImplementation(
      () => new Promise((resolve) => (release = resolve)) as never,
    );
    const { agent, body } = setup(guardian, [[refundCall()], [say("Done.")]]);
    const controller = new AbortController();
    const running = agent
      .generate("Refund order ord_9, $25", { abortSignal: controller.signal })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(guardian.request).toHaveBeenCalled());
    controller.abort();
    await running;
    release({
      ok: true,
      decision: "ALLOW",
      requestId: "req_late",
      capabilityToken: "cap_req_late",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(body).not.toHaveBeenCalled();
    expect(guardian.execute).not.toHaveBeenCalled();
  });

  it("Mastra's own tool approval does not stand in for Guardian's decision", async () => {
    const guardian = fakeGuardian(() => "DENY");
    const { agent, body } = setup(
      guardian,
      [[refundCall()], [say("I cannot refund that.")]],
      {},
      undefined,
      ((run: (input: unknown, context: unknown) => unknown) =>
        createTool({
          id: "refund_order",
          description: "Refund an order",
          inputSchema: z.object({ orderId: z.string(), amount: z.string() }),
          requireApproval: true,
          execute: async (input, context) => run(input, context) as never,
        })) as never,
    );
    const first = await agent.generate("Refund order ord_9, $25");
    expect(first.finishReason).toBe("suspended");
    // Mastra holds the call for its own approval; Guardian is not asked yet.
    expect(guardian.request).not.toHaveBeenCalled();
    const approved = await agent.approveToolCallGenerate({
      runId: first.runId!,
      toolCallId: "call_1",
    });
    expect(approved.text).toBe("I cannot refund that.");
    expect(guardian.request).toHaveBeenCalledTimes(1);
    expect(body).not.toHaveBeenCalled();
  });
});

describe('onAsk: "suspend" in a Mastra Agent', () => {
  const script = [[refundCall()], [say("Refunded.")]];

  it("suspends the run with the requestId; resuming before approval suspends again; after approval the resumed run claims the request and runs the tool once", async () => {
    const guardian = fakeGuardian(() => "ASK");
    const { agent, body } = setup(guardian, script, { onAsk: "suspend" });

    const first = await agent.generate("Refund order ord_9, $25");
    expect(first.finishReason).toBe("suspended");
    const payload = (
      first.suspendPayload as { suspendPayload: GuardianSuspendPayload }
    ).suspendPayload;
    expect(payload.guardian).toMatchObject({
      decision: "ASK",
      requestId: "req_1",
      toolName: "refund_order",
    });
    expect(body).not.toHaveBeenCalled();

    // Resuming is not approving: Guardian still holds the request.
    const early = await agent.resumeGenerate(
      { approved: true },
      { runId: first.runId!, toolCallId: "call_1" },
    );
    expect(early.finishReason).toBe("suspended");
    expect(guardian.claim).toHaveBeenCalledWith("req_1");
    expect(body).not.toHaveBeenCalled();
    expect(guardian.execute).not.toHaveBeenCalled();

    guardian.approve("req_1");
    const done = await agent.resumeGenerate(
      {},
      { runId: first.runId!, toolCallId: "call_1" },
    );
    expect(done.text).toBe("Refunded.");
    // One request, claimed after approval; the tool got the parsed
    // arguments Guardian decided on.
    expect(guardian.request).toHaveBeenCalledTimes(1);
    expect(guardian.requests[0]!.arguments).toEqual({
      orderId: "ord_9",
      amount: 25,
    });
    expect(body).toHaveBeenCalledTimes(1);
    expect(body.mock.calls[0]![0]).toEqual({ orderId: "ord_9", amount: 25 });
    expect(guardian.redeemed).toEqual(["req_1"]);
  });

  it("a request the person denied does not run on resume", async () => {
    const guardian = fakeGuardian(() => "ASK");
    const { agent, body } = setup(
      guardian,
      [[refundCall()], [say("It was denied.")]],
      { onAsk: "suspend" },
    );
    const first = await agent.generate("Refund order ord_9, $25");
    expect(first.finishReason).toBe("suspended");
    guardian.deny("req_1");
    const done = await agent.resumeGenerate(
      { approved: true },
      { runId: first.runId!, toolCallId: "call_1" },
    );
    expect(done.text).toBe("It was denied.");
    expect(body).not.toHaveBeenCalled();
    expect(guardian.execute).not.toHaveBeenCalled();
  });
});
