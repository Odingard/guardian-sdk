import type { ToolSet } from "ai";
import type { GuardianClient } from "@odingard/guardian-sdk";

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
 * Honour the AI SDK's `abortSignal` (generateText/streamText pass it to
 * every tool execute). The Guardian client has no timeout of its own, so
 * without this an unanswered Guardian call hangs the whole generation even
 * after the caller aborted.
 *
 * Each call gets its own view of the Guardian client:
 * - Before the tool starts, an abort rejects the call at once and refuses
 *   every later step of it: a late ALLOW neither runs the local impl
 *   (inProcess) nor asks Guardian to perform the call (remote).
 * - Once the tool starts (the local impl runs, or Guardian is asked to
 *   execute the tool call), an abort no longer rejects early: the call
 *   waits for the real outcome, so the caller is never told a started
 *   action did not happen.
 * - Executing a record-transport setup step (mcp.install / mcp.enable)
 *   is not the tool starting.
 * - Once the call has settled, the gate opens, so a later
 *   `GuardianApprovalPending.resume()` (after a human approves) is
 *   unaffected.
 */
function abortable<R>(
  client: GuardianClient,
  callOptions: unknown,
  run: (client: GuardianClient, startTool: () => void) => Promise<R>,
): Promise<R> {
  const signal = (callOptions as { abortSignal?: AbortSignal } | undefined)
    ?.abortSignal;
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error("aborted"));
  }
  if (!signal) {
    return run(client, () => {});
  }
  let state: "deciding" | "started" | "settled" = "deciding";
  const refuseIfAborted = () => {
    if (state === "deciding" && signal.aborted) {
      throw signal.reason ?? new Error("aborted");
    }
  };
  const startTool = () => {
    refuseIfAborted();
    if (state === "deciding") state = "started";
  };
  const setupIds = new Set<string>();
  const noteSetup = (result: unknown): void => {
    const id = (result as { requestId?: unknown } | null)?.requestId;
    if (typeof id === "string" && id.length > 0) setupIds.add(id);
  };
  const overrides: Record<PropertyKey, unknown> = {
    request: async (input: Parameters<GuardianClient["request"]>[0]) => {
      refuseIfAborted();
      const result = await client.request(input);
      if (input.action === "mcp.install" || input.action === "mcp.enable") {
        noteSetup(result);
      }
      return result;
    },
    claim: async (requestId: string) => {
      refuseIfAborted();
      const result = await client.claim(requestId);
      if (setupIds.has(requestId)) noteSetup(result);
      return result;
    },
    execute: (input: Parameters<GuardianClient["execute"]>[0]) => {
      if (setupIds.has(input.requestId)) {
        refuseIfAborted();
      } else {
        // Guardian performing the tool call is the tool starting.
        startTool();
      }
      return client.execute(input);
    },
  };
  const gated = new Proxy(client, {
    get(target, prop, receiver) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) {
        return overrides[prop];
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const inner = run(gated, startTool).finally(() => {
    state = "settled";
  });
  return new Promise<R>((resolve, reject) => {
    const onAbort = () => {
      // A started tool is never abandoned: wait for its real outcome.
      if (state === "deciding") {
        reject(signal.reason ?? new Error("aborted"));
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    inner.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Wrap a Vercel AI SDK tool set so every tool's `execute` routes through
 * Guardian.
 *
 * - mode "remote" (default): the tool name is a registered Guardian catalog
 *   entry — `client.execute` performs the bounded HTTPS call and the local
 *   `execute` impl never runs; the call resolves to the ALLOW receipt.
 * - mode "inProcess" (opt-in, `mode`/`modes` options): the local impl IS the
 *   tool — it runs only once ALLOW issues the capability, and `execute`
 *   redeems + records the evidence afterwards. It needs a
 *   `transport: "record"` catalog entry, registered once in the Guardian
 *   console. `installRecordTransport: true` (opt-in, default off) proposes
 *   it via `mcp.install`, but only works while no entry exists.
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
              abortable(options.client, callOptions, (client, startTool) =>
                runThroughGuardian(
                  client === options.client
                    ? ctx
                    : { ...ctx, options: { ...ctx.options, client } },
                  toolName,
                  input,
                  () => {
                    startTool();
                    return execute(input as never, callOptions as never);
                  },
                ),
              ),
          }
        : definition;
  }
  return wrapped as T;
}
