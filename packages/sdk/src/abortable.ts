import type { GuardianClient } from "./client.js";
import type { GuardianContext } from "./guard.js";

/**
 * Honour a caller's `AbortSignal` around one guarded tool call
 * (`runThroughGuardian`), without ever abandoning an action that started.
 * The framework adapters use it for the signal their framework hands every
 * tool call (LangChain's `config.signal`, the AI SDK's `abortSignal`):
 *
 * ```ts
 * abortable(options.client, signal, (client, startTool) =>
 *   runThroughGuardian(
 *     client === options.client
 *       ? ctx
 *       : { ...ctx, options: { ...ctx.options, client } },
 *     toolName,
 *     input,
 *     (approved) => {
 *       startTool();
 *       return runTheTool(approved);
 *     },
 *   ),
 *   ctx,
 * );
 * ```
 *
 * `run` gets the client to use for this call and `startTool`, which it must
 * call just before the local tool runs. Without a signal, `run` gets the
 * client itself and nothing else changes. With one, each call gets its own
 * view of the Guardian client:
 * - A signal that is already aborted rejects with its reason; `run` is not
 *   called and Guardian is asked nothing.
 * - Before the tool starts, an abort rejects the call at once and refuses
 *   every later step of it: a late ALLOW neither runs the local impl
 *   (inProcess) nor asks Guardian to perform the call (remote).
 * - Once the tool starts (the local impl runs, or Guardian is asked to
 *   execute the tool call), an abort no longer rejects early: the call
 *   waits for the real outcome, so the caller is never told a started
 *   action did not happen.
 * - Executing a record-transport setup step (mcp.install / mcp.enable)
 *   is not the tool starting. Pass the Guardian context as `held` so this
 *   also holds for a setup step an earlier call left held for approval:
 *   this call claims and executes it, and without the context its id
 *   cannot be told from the tool call's.
 * - Once the call has settled, the gate opens, so a later
 *   `GuardianApprovalPending.resume()` (after a human approves) is
 *   unaffected.
 *
 * It does not end a Guardian HTTP call that is already in flight; the
 * caller is answered at once and the call's late answer is refused. To
 * bound the HTTP calls themselves, see `withRequestTimeout`.
 */
export function abortable<R>(
  client: GuardianClient,
  signal: AbortSignal | undefined,
  run: (client: GuardianClient, startTool: () => void) => Promise<R>,
  held?: Pick<GuardianContext, "heldSetup">,
): Promise<R> {
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
      // A setup step held by an earlier call: read before the claim, which
      // forgets it once the answer is definitive.
      for (const step of held?.heldSetup?.values() ?? []) {
        if (step.requestId === requestId) setupIds.add(requestId);
      }
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
