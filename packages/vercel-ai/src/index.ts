import type { ToolSet } from "ai";

import {
  createGuardianContext,
  runThroughGuardian,
  type GuardianAdapterOptions,
} from "./core.js";

export {
  GuardianApprovalPending,
  GuardianDenied,
  GuardianExecutionFailed,
  GuardianRecordTransportRequired,
  toArgumentsRecord,
  type GuardianAdapterOptions,
  type GuardianDecisionResult,
  type GuardianMode,
  type GuardianToolMode,
} from "./core.js";

export type GuardianVercelAIOptions = GuardianAdapterOptions;

type AnyExecute = (input: never, options: never) => unknown;

/**
 * Wrap a Vercel AI SDK tool set so every tool's `execute` routes through
 * Guardian.
 *
 * - mode "remote" (default): the tool name is a registered Guardian catalog
 *   entry — `client.execute` performs the bounded HTTPS call and the local
 *   `execute` impl never runs; the call resolves to the ALLOW receipt.
 * - mode "inProcess" (opt-in, `mode`/`modes` options): the local impl IS the
 *   tool — it runs only once ALLOW issues the capability, and `execute`
 *   redeems + records the evidence afterwards (auto-installs a
 *   `transport: "record"` catalog entry via `mcp.install`).
 *
 * ASK throws `GuardianApprovalPending` (or a result object with
 * onAsk: "result"); DENY throws `GuardianDenied` (or a result object with
 * onDeny: "result"). Tools without an `execute` pass through unchanged.
 */
export function withGuardian<T extends ToolSet>(
  tools: T,
  options: GuardianVercelAIOptions,
): T {
  const ctx = createGuardianContext(options);
  const wrapped: Record<string, unknown> = {};
  for (const [toolName, definition] of Object.entries(tools)) {
    const execute = (definition as { execute?: AnyExecute }).execute;
    wrapped[toolName] =
      typeof execute === "function"
        ? {
            ...definition,
            execute: (input: unknown, callOptions: unknown) =>
              runThroughGuardian(ctx, toolName, input, () =>
                execute(input as never, callOptions as never),
              ),
          }
        : definition;
  }
  return wrapped as T;
}
