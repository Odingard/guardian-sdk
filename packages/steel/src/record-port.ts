// Generated file — do not edit.
import type { ToolRecordPort } from "./tool-record-port.js";
import {
  canonicalJson,
  sha256Text,
  type ToolServerCatalog,
} from "@odingard/guardian-sdk/contracts";

import {
  SteelCheckoutArgumentsSchema,
  type SteelCheckoutExecutor,
  type SteelCheckoutResult,
} from "./executor.js";

export const STEEL_CHECKOUT_TOOL = "steel.checkout.submit";

/** The human-installed catalog entry for a Guardian–Steel tool connection. */
export const STEEL_TOOL_CATALOG: ToolServerCatalog = {
  serverName: "guardian-steel",
  serverVersion: "1",
  tools: [
    {
      name: STEEL_CHECKOUT_TOOL,
      description:
        "Submit an order on a bound merchant through a Guardian-owned Steel browser session.",
      transport: "record",
    },
  ],
};

/**
 * Execution evidence recorded by the protected boundary itself, separately
 * from Guardian's authorization evidence. `resultDigest` equals the tool
 * adapter's `sentRef.resultDigest`, so each entry links to its receipt.
 */
export type SteelExecutionEvidence = Readonly<{
  schema: "guardian.steel.execution-evidence.v1";
  attemptId: string;
  connectionId: string;
  toolName: string;
  argumentsDigest: string;
  startedAtEpochMs: number;
  finishedAtEpochMs: number;
  outcome: "executed" | "refused";
  reason: string | null;
  reachedSubmit: boolean;
  result: SteelCheckoutResult | null;
  resultDigest: string | null;
}>;

export type SteelToolRecordPort = ToolRecordPort & {
  executions(): readonly SteelExecutionEvidence[];
};

export function createSteelToolRecordPort(input: {
  executor: SteelCheckoutExecutor;
  /** Tool connections this host serves; anything else is refused. */
  connectionIds: readonly string[];
  clock?: { nowEpochMs(): number };
}): SteelToolRecordPort {
  const clock = input.clock ?? { nowEpochMs: () => Date.now() };
  const connections = new Set(input.connectionIds);
  const attempts = new Set<string>();
  const evidence: SteelExecutionEvidence[] = [];

  return {
    async invoke(call) {
      if (call.toolName !== STEEL_CHECKOUT_TOOL) return null;
      const startedAtEpochMs = clock.nowEpochMs();
      const refuse = (reason: string, reachedSubmit = false) => {
        evidence.push({
          schema: "guardian.steel.execution-evidence.v1",
          attemptId: call.attemptId,
          connectionId: call.connectionId,
          toolName: call.toolName,
          argumentsDigest: sha256Text(canonicalJson(call.arguments)),
          startedAtEpochMs,
          finishedAtEpochMs: clock.nowEpochMs(),
          outcome: "refused",
          reason,
          reachedSubmit,
          result: null,
          resultDigest: null,
        });
        return { ok: false as const, reason };
      };
      if (!connections.has(call.connectionId)) {
        return refuse("CONNECTION_NOT_BOUND");
      }
      if (attempts.has(call.attemptId)) {
        return refuse("ATTEMPT_ALREADY_EXECUTED");
      }
      attempts.add(call.attemptId);
      const parsed = SteelCheckoutArgumentsSchema.safeParse(call.arguments);
      if (!parsed.success) return refuse("ARGUMENTS_INVALID");
      const outcome = await input.executor.execute(parsed.data);
      if (!outcome.ok) return refuse(outcome.reason, outcome.reachedSubmit);
      const resultDigest = sha256Text(canonicalJson(outcome.result));
      evidence.push({
        schema: "guardian.steel.execution-evidence.v1",
        attemptId: call.attemptId,
        connectionId: call.connectionId,
        toolName: call.toolName,
        argumentsDigest: sha256Text(canonicalJson(call.arguments)),
        startedAtEpochMs,
        finishedAtEpochMs: clock.nowEpochMs(),
        outcome: "executed",
        reason: null,
        reachedSubmit: true,
        result: outcome.result,
        resultDigest,
      });
      return { ok: true, result: outcome.result };
    },
    executions: () => [...evidence],
  };
}
