import type { ToolSet } from "ai";
import {
  abortable,
  resolveHeldScope,
  scopeHeldRequests,
  type SCOPE_UNKNOWN,
} from "@odingard/guardian-sdk";

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

export type GuardianVercelAIOptions = GuardianAdapterOptions &
  Readonly<{
    /**
     * Held requests are scoped per session. The scope of one call: the
     * conversation or user it belongs to, from the options the AI SDK
     * passes the tool's `execute` (for example a user id you put in
     * `experimental_context`). A held call is claimed only by the same call
     * in the same scope; an identical call in another scope is its own
     * request.
     *
     * The AI SDK's tool call options name no conversation, so there is no
     * default: without this option held calls are shared by every call of
     * the wrapped tools, which must then serve one principal.
     *
     * With this option, return a non-empty string. Anything else means the
     * session is not known, and a held call is then never claimed by a
     * later call: `SCOPE_UNKNOWN` (from `@odingard/guardian-sdk`),
     * `undefined`, `null`, an empty string, any other value, or the
     * function throwing. The scope stays in this process.
     */
    scope?: (
      callOptions: Record<string, unknown> | undefined,
    ) => string | typeof SCOPE_UNKNOWN | null | undefined;
  }>;

type AnyExecute = (input: never, options: never) => unknown;

function abortSignalOf(callOptions: unknown): AbortSignal | undefined {
  return (callOptions as { abortSignal?: AbortSignal } | undefined)
    ?.abortSignal;
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
 *
 * `fileArgs` (in-process tools only) pins the bytes behind declared
 * file-path arguments: the SDK reads each declared file, puts its SHA-256
 * in the approved arguments, and checks it again just before `execute`
 * runs; a changed file is refused with `CONTENT_CHANGED_SINCE_APPROVAL` and
 * nothing runs. `execute(approved, callOptions)` receives the substituted
 * value: a `PinnedFile` (`"bytes"`), a private copy's path (`"copy"`) or
 * the original path (`"recheck"`). The default mode is `"remote"`, where
 * Guardian runs the tool and cannot read your files, so `fileArgs` needs
 * `mode: "inProcess"` (or a `modes` entry).
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
            // The AI SDK's `abortSignal` (generateText/streamText pass it
            // to every tool execute): an abort before the tool starts
            // rejects at once, so an unanswered Guardian call does not hang
            // the generation, and refuses every later step; a started tool
            // runs to its real outcome (`abortable` in
            // @odingard/guardian-sdk).
            execute: (input: unknown, callOptions: unknown) => {
              // Held requests are scoped per session: this call sees only
              // the held calls of its own scope.
              const readScope = options.scope;
              const scoped =
                readScope === undefined
                  ? ctx
                  : scopeHeldRequests(
                      ctx,
                      resolveHeldScope(() =>
                        readScope(
                          callOptions as Record<string, unknown> | undefined,
                        ),
                      ),
                    );
              return abortable(options.client, abortSignalOf(callOptions), (client, startTool) =>
                runThroughGuardian(
                  client === options.client
                    ? scoped
                    : { ...scoped, options: { ...scoped.options, client } },
                  toolName,
                  input,
                  (approved) => {
                    startTool();
                    // The copy Guardian decided on, not the caller's
                    // object, which other code may have changed meanwhile.
                    return execute(approved as never, callOptions as never);
                  },
                ),
                // So a setup step held by an earlier call is not taken for
                // the tool. The scoped context shares the wrapper's held
                // setup steps (only held tool calls are scoped).
                scoped,
              );
            },
          }
        : definition;
  }
  return wrapped as T;
}
