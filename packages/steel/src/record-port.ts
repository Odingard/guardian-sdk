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

/**
 * The result digest Guardian records when a Steel checkout
 * redemption reaches the standard hosted record transport (the control
 * plane's hosted tool record port). That transport runs nothing: it records
 * that the agent's own code would perform the effect. For the Steel tool no
 * agent code exists, so this digest means "authorized and recorded, but no
 * protected Steel executor ran and no order was placed". A real protected
 * executor's result (order id, Steel session ref) never hashes to it.
 */
export const HOSTED_RECORD_ONLY_RESULT_DIGEST = sha256Text(
  canonicalJson({
    schema: "odingard.guardian.tool.record.v1",
    toolName: STEEL_CHECKOUT_TOOL,
    executedBy: "agent",
    note: "The agent's own code performed this effect after ALLOW; Guardian recorded the authorization and single-use redemption, not the external effect.",
  }),
);

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
  /**
   * "unknown" means the submit click was reached but its result was
   * never confirmed; the order may exist at the merchant.
   */
  outcome: "executed" | "refused" | "unknown";
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
          outcome: reachedSubmit ? "unknown" : "refused",
          reason,
          reachedSubmit,
          result: null,
          resultDigest: null,
        });
        // A submit that was reached but never confirmed may have placed
        // the order: report it as unknown, so the receipt is never
        // `not-sent` and the agent is never told to retry.
        return reachedSubmit
          ? { ok: false as const, reason, unknown: true }
          : { ok: false as const, reason };
      };
      if (!connections.has(call.connectionId)) {
        return refuse("CONNECTION_NOT_BOUND");
      }
      if (attempts.has(call.attemptId)) {
        // This attempt already reached the executor once (a fresh plan for
        // the same attempt, after a re-prepare or eviction). Nothing runs
        // now, but the first run may have placed the order: unknown, never
        // a definite not-sent.
        refuse("ATTEMPT_ALREADY_EXECUTED");
        return {
          ok: false as const,
          reason: "ATTEMPT_ALREADY_EXECUTED",
          unknown: true,
        };
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
