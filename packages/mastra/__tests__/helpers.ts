import { vi } from "vitest";
import {
  MastraLanguageModelV2Mock,
  simulateReadableStream,
} from "@mastra/core/test-utils/llm-mock";
import type { GuardianClient } from "@odingard/guardian-sdk";

export function stubClient(overrides: Partial<GuardianClient>): GuardianClient {
  return {
    request: vi.fn(),
    claim: vi.fn(),
    execute: vi.fn(),
    receipts: vi.fn(),
    ...overrides,
  } as unknown as GuardianClient;
}

export const allow = (requestId = "req_1", capabilityToken = "cap_1") => ({
  ok: true as const,
  decision: "ALLOW" as const,
  requestId,
  capabilityToken,
});

type Decision = "ALLOW" | "ASK" | "DENY";

/**
 * A stand-in Guardian with state, for the agent-loop tests: `decide` answers
 * each proposed call, `approve` is the person approving a held request, and
 * a capability is redeemed at most once.
 */
export function fakeGuardian(
  decide: (toolName: string, args: Record<string, unknown>) => Decision,
) {
  let seq = 0;
  const requests: {
    requestId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    decision: Decision;
  }[] = [];
  const approved = new Set<string>();
  const denied = new Set<string>();
  const redeemed: string[] = [];
  const request = vi.fn(async (invocation: unknown) => {
    const { toolName, arguments: args } = invocation as {
      toolName: string;
      arguments: Record<string, unknown>;
    };
    const requestId = `req_${++seq}`;
    const decision = decide(toolName, args);
    requests.push({ requestId, toolName, arguments: args, decision });
    if (decision === "DENY") {
      return { ok: false, requestId, reasonCode: "POLICY_DENY" };
    }
    if (decision === "ASK") {
      return { ok: true, requestId, decision: "ASK" };
    }
    return allow(requestId, `cap_${requestId}`);
  });
  const claim = vi.fn(async (requestId: string) => {
    if (denied.has(requestId)) {
      return { ok: false, requestId, reasonCode: "APPROVAL_DENIED" };
    }
    if (!approved.has(requestId)) {
      return { ok: false, requestId, reasonCode: "APPROVAL_PENDING" };
    }
    return allow(requestId, `cap_${requestId}`);
  });
  const execute = vi.fn(
    async ({
      requestId,
      capabilityToken,
    }: {
      requestId: string;
      capabilityToken: string;
    }) => {
      if (
        capabilityToken !== `cap_${requestId}` ||
        redeemed.includes(requestId)
      ) {
        return { ok: false, reasonCode: "CAPABILITY_INVALID" };
      }
      redeemed.push(requestId);
      return {
        ok: true,
        receipt: { id: `rcpt_${requestId}`, requestId, status: "sent-verified" },
      };
    },
  );
  return {
    client: stubClient({
      request: request as never,
      claim: claim as never,
      execute: execute as never,
    }),
    request,
    claim,
    execute,
    requests,
    redeemed,
    approve: (requestId: string) => approved.add(requestId),
    deny: (requestId: string) => denied.add(requestId),
  };
}

export type ScriptedPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string };

export const toolCall = (
  toolCallId: string,
  toolName: string,
  args: unknown,
): ScriptedPart => ({
  type: "tool-call",
  toolCallId,
  toolName,
  input: JSON.stringify(args),
});

export const say = (text: string): ScriptedPart => ({ type: "text", text });

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/**
 * A scripted language model: each model call answers with the next step of
 * the script (the last step repeats). `prompts` records what the model was
 * sent, so a test can read the tool results the agent loop handed back.
 */
export function scriptedModel(steps: ScriptedPart[][]) {
  let index = 0;
  const prompts: unknown[] = [];
  const next = () => steps[Math.min(index++, steps.length - 1)]!;
  const finishReason = (step: ScriptedPart[]) =>
    step.some((part) => part.type === "tool-call") ? "tool-calls" : "stop";
  const model = new MastraLanguageModelV2Mock({
    doGenerate: (async (options: { prompt: unknown }) => {
      prompts.push(options.prompt);
      const step = next();
      return {
        content: step,
        finishReason: finishReason(step),
        usage,
        warnings: [],
      };
    }) as never,
    doStream: (async (options: { prompt: unknown }) => {
      prompts.push(options.prompt);
      const step = next();
      const chunks: unknown[] = [
        { type: "stream-start", warnings: [] },
        {
          type: "response-metadata",
          id: "resp_1",
          modelId: "scripted",
          timestamp: new Date(0),
        },
      ];
      for (const part of step) {
        if (part.type === "text") {
          chunks.push(
            { type: "text-start", id: "text_1" },
            { type: "text-delta", id: "text_1", delta: part.text },
            { type: "text-end", id: "text_1" },
          );
        } else {
          chunks.push(part);
        }
      }
      chunks.push({ type: "finish", finishReason: finishReason(step), usage });
      return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
    }) as never,
  });
  return { model, prompts };
}

/** The tool results in the last prompt the scripted model received. */
export function toolResultsSeen(prompts: unknown[]): {
  toolCallId: string;
  toolName: string;
  output: { type: string; value: unknown };
}[] {
  const last = prompts.at(-1) as { role: string; content: unknown }[];
  return last
    .filter((message) => message.role === "tool")
    .flatMap((message) => message.content as never[]);
}
