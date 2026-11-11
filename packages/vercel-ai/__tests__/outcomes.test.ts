import { describe, expect, it, vi } from "vitest";
import { generateText, stepCountIs, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import type { GuardianClient } from "@odingard/guardian-sdk";
import { GuardianExecutionFailed, withGuardian } from "../src/index.js";

function stubClient(overrides: Partial<GuardianClient>): GuardianClient {
  return {
    request: vi.fn(),
    claim: vi.fn(),
    execute: vi.fn(),
    receipts: vi.fn(),
    ...overrides,
  } as unknown as GuardianClient;
}

let n = 0;
const allow = () => ({
  ok: true as const,
  decision: "ALLOW" as const,
  requestId: `req_${++n}`,
  capabilityToken: `cap_${n}`,
});

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** A model that calls `toolName` with `input` on every step until told to stop. */
function toolCallingModel(
  toolName: string,
  input: unknown,
  callsBeforeStop = 1,
) {
  let step = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      step += 1;
      if (step <= callsBeforeStop) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: `call_${step}`,
              toolName,
              input: JSON.stringify(input),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage,
          warnings: [],
        };
      }
      return {
        content: [{ type: "text", text: "done" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      };
    },
  });
}

/**
 * How a governed call's outcome reaches the model: a streaming tool, a lost
 * execute answer, and an onReceipt callback that throws.
 */
describe("streaming (async generator) execute in inProcess mode", () => {
  it("runs the generator to completion before Guardian records it; the model gets the last value", async () => {
    const order: string[] = [];
    const request = vi.fn().mockImplementation(async () => allow());
    const execute = vi.fn().mockImplementation(async () => {
      order.push("recorded");
      return { ok: true, receipt: { status: "sent-verified" } };
    });
    const tools = withGuardian(
      {
        deploy: tool({
          description: "Deploy a build, streaming progress",
          inputSchema: z.object({ build: z.string() }),
          async *execute({ build }) {
            yield { status: "starting" };
            order.push(`deployed:${build}`);
            yield { status: "deployed", build };
          },
        }),
      },
      {
        client: stubClient({ request, execute }),
        connectionId: "con_1",
        mode: "inProcess",
        installRecordTransport: false,
      },
    );
    const result = await generateText({
      model: toolCallingModel("deploy", { build: "b42" }),
      tools,
      prompt: "deploy b42",
      stopWhen: stepCountIs(2),
    });
    const part = result.steps[0]!.content.find(
      (p) => p.type === "tool-result" || p.type === "tool-error",
    ) as { type: string; output?: unknown };
    expect(order).toEqual(["deployed:b42", "recorded"]);
    expect(part.type).toBe("tool-result");
    expect(part.output).toEqual({ status: "deployed", build: "b42" });
  });
});

describe("a lost execute answer is reported as an unknown outcome", () => {
  it("remote mode: the model is told the action may have happened and not to retry", async () => {
    const request = vi.fn().mockImplementation(async () => allow());
    const execute = vi
      .fn()
      .mockResolvedValue({ ok: false, reasonCode: "SERVICE_UNAVAILABLE" });
    const receipts = vi
      .fn()
      .mockResolvedValue({ ok: false, reasonCode: "NOT_FOUND" });
    const tools = withGuardian(
      {
        send_payout: tool({
          description: "Send a payout",
          inputSchema: z.object({ to: z.string(), cents: z.number() }),
          execute: async () => "remote mode: never runs",
        }),
      },
      {
        client: stubClient({ request, execute, receipts }),
        connectionId: "con_1",
      },
    );
    const result = await generateText({
      model: toolCallingModel("send_payout", { to: "acct_9", cents: 100000 }),
      tools,
      prompt: "pay acct_9 $1000",
      stopWhen: stepCountIs(2),
    });
    const err = result.steps[0]!.content.find(
      (p) => p.type === "tool-error",
    ) as { error: GuardianExecutionFailed } | undefined;
    expect(err?.error).toBeInstanceOf(GuardianExecutionFailed);
    expect(err?.error.reasonCode).toBe("EXECUTION_OUTCOME_UNKNOWN");
    expect(err?.error.outcomeUnknown).toBe(true);
    expect(err?.error.message).toMatch(/may have happened; do not retry/);
    // Guardian was asked about the request before the model was answered.
    expect(receipts).toHaveBeenCalledWith(err?.error.requestId);
  });

  it("inProcess: the impl ran and the record answer was lost: unknown, localEffectRan", async () => {
    const effects: string[] = [];
    const request = vi.fn().mockImplementation(async () => allow());
    const execute = vi
      .fn()
      .mockResolvedValue({ ok: false, reasonCode: "SERVICE_UNAVAILABLE" });
    const tools = withGuardian(
      {
        send_email: tool({
          description: "Send an email",
          inputSchema: z.object({ to: z.string() }),
          execute: async ({ to }) => {
            effects.push(to);
            return "sent";
          },
        }),
      },
      {
        client: stubClient({ request, execute }),
        connectionId: "con_1",
        mode: "inProcess",
        installRecordTransport: false,
      },
    );
    const result = await generateText({
      model: toolCallingModel("send_email", { to: "ceo@example.com" }),
      tools,
      prompt: "email the ceo",
      stopWhen: stepCountIs(2),
    });
    const err = result.steps[0]!.content.find(
      (p) => p.type === "tool-error",
    ) as { error: GuardianExecutionFailed } | undefined;
    expect(effects).toEqual(["ceo@example.com"]);
    expect(err?.error.outcomeUnknown).toBe(true);
    expect(err?.error.localEffectRan).toBe(true);
    expect(err?.error.message).toMatch(/do not retry/);
  });
});

describe("an onReceipt that throws does not turn a completed action into an error", () => {
  it("remote: the model gets the result once; the error goes to onReceiptError", async () => {
    let performed = 0;
    const request = vi.fn().mockImplementation(async () => allow());
    const execute = vi.fn().mockImplementation(async () => {
      performed += 1;
      return { ok: true, receipt: { status: "sent-verified" } };
    });
    const receiptErrors: unknown[] = [];
    const tools = withGuardian(
      {
        send_payout: tool({
          description: "Send a payout",
          inputSchema: z.object({ to: z.string() }),
          execute: async () => "never",
        }),
      },
      {
        client: stubClient({ request, execute }),
        connectionId: "con_1",
        onReceipt: async () => {
          throw new Error("log write failed");
        },
        onReceiptError: (error) => {
          receiptErrors.push(error);
        },
      },
    );
    const result = await generateText({
      model: toolCallingModel("send_payout", { to: "acct_9" }),
      tools,
      prompt: "pay",
      stopWhen: stepCountIs(2),
    });
    const first = result.steps[0]!.content.find(
      (p) => p.type === "tool-error" || p.type === "tool-result",
    ) as { type: string };
    expect(first.type).toBe("tool-result");
    expect(performed).toBe(1);
    expect(receiptErrors).toHaveLength(1);
  });
});
