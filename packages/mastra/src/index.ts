import {
  isValidationError,
  validateToolInput,
  type Tool,
} from "@mastra/core/tools";
import type { GuardianClient } from "@odingard/guardian-sdk";

import {
  createGuardianContext,
  GuardianApprovalPending,
  runThroughGuardian,
  type GuardianAdapterOptions,
  type GuardianContext,
  type GuardianMode,
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

/**
 * The shared adapter options, plus one more answer to a held call:
 * `onAsk: "suspend"` suspends the Mastra run (see `guardianTool`).
 */
export type GuardianMastraOptions = Omit<GuardianAdapterOptions, "onAsk"> & {
  onAsk?: GuardianMode | "suspend";
};

/** What a run suspended by `onAsk: "suspend"` carries as its suspend payload. */
export type GuardianSuspendPayload = {
  guardian: {
    decision: "ASK";
    requestId: string;
    toolName: string;
    message: string;
  };
};

/** Any tool made with `createTool` from `@mastra/core/tools`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MastraTool = Tool<any, any, any, any, any, any, any>;

type ToolContext = {
  abortSignal?: AbortSignal;
  suspend?: Suspend;
  resumeData?: unknown;
  agent?: { suspend?: Suspend; resumeData?: unknown };
  workflow?: { suspend?: Suspend; resumeData?: unknown };
};
type Suspend = (payload: unknown, options?: unknown) => Promise<unknown>;
type Execute = (input: unknown, context?: unknown) => Promise<unknown>;

/**
 * Honour Mastra's `context.abortSignal` (the run's abort signal). The
 * Guardian client has no timeout of its own, so without this an unanswered
 * Guardian call hangs the run even after the caller aborted.
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
  signal: AbortSignal | undefined,
  run: (client: GuardianClient, startTool: () => void) => Promise<R>,
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
 * The wrapped tool refused the approved input with its own input
 * validation, so its `execute` body did not run. Thrown inside the triad's
 * runner so the capability is not redeemed and no record says the tool ran.
 */
class InputRefusedByTool extends Error {
  constructor(readonly result: unknown) {
    super("the tool refused its input");
  }
}

function isResuming(context: ToolContext | undefined): boolean {
  return (
    (context?.resumeData ??
      context?.agent?.resumeData ??
      context?.workflow?.resumeData) != null
  );
}

function suspendOf(context: ToolContext | undefined): Suspend | undefined {
  const suspend =
    context?.agent?.suspend ?? context?.workflow?.suspend ?? context?.suspend;
  return typeof suspend === "function" ? suspend : undefined;
}

function isGuardianResult(value: unknown, toolName: string): boolean {
  const guardian = (value as { guardian?: unknown } | null | undefined)
    ?.guardian as { decision?: unknown; toolName?: unknown } | undefined;
  return (
    typeof guardian === "object" &&
    guardian !== null &&
    guardian.toolName === toolName &&
    (guardian.decision === "ALLOW" ||
      guardian.decision === "ASK" ||
      guardian.decision === "DENY")
  );
}

function wrapWithContext<T extends MastraTool>(
  inner: T,
  ctx: GuardianContext,
  onAsk: GuardianMastraOptions["onAsk"],
): T {
  const source = inner as unknown as {
    id?: unknown;
    execute?: Execute;
    renderOnly?: boolean;
    inputSchema?: unknown;
    suspendSchema?: unknown;
    resumeSchema?: unknown;
    toModelOutput?: (output: unknown) => unknown;
  };
  if (typeof source.id !== "string" || source.id.length === 0) {
    throw new TypeError(
      "guardianTool wraps a Mastra tool made with createTool from " +
        "@mastra/core/tools (it has an `id`). This value has none.",
    );
  }
  const toolName = source.id;
  const innerExecute = source.execute;
  // A tool Mastra never executes on the server (no `execute`, or a
  // render-only tool the client displays) has nothing to gate here.
  if (typeof innerExecute !== "function" || source.renderOnly === true) {
    return inner;
  }
  if (
    onAsk === "suspend" &&
    (source.suspendSchema !== undefined || source.resumeSchema !== undefined)
  ) {
    throw new TypeError(
      `onAsk: "suspend" cannot wrap "${toolName}": the tool declares its own ` +
        `suspendSchema or resumeSchema, and Mastra would validate Guardian's ` +
        `suspend payload against it. Use onAsk "throw" or "result" for this ` +
        `tool.`,
    );
  }

  const execute: Execute = async (received, context) => {
    const toolContext = context as ToolContext | undefined;
    let input = received;
    if (isResuming(toolContext)) {
      // A resumed Mastra run hands the tool the model's stored arguments
      // without parsing them again. Parse them here, as the first call's
      // were, so Guardian sees the same arguments both times and the held
      // request is claimed instead of a new one being opened.
      const parsed = validateToolInput(
        source.inputSchema as never,
        received,
        toolName,
      );
      if (parsed.error) {
        return parsed.error;
      }
      input = parsed.data;
    }
    try {
      return await abortable(
        ctx.options.client,
        toolContext?.abortSignal,
        (client, startTool) =>
          runThroughGuardian(
            client === ctx.options.client
              ? ctx
              : { ...ctx, options: { ...ctx.options, client } },
            toolName,
            input,
            async (approved) => {
              startTool();
              // The copy Guardian decided on, not the caller's object, which
              // other code may have changed while the call waited. `context`
              // is passed on as the same object: Mastra marks it when its
              // agent or workflow runtime has already parsed the input, and
              // the wrapped tool then runs on `approved` as it is.
              const output = await innerExecute.call(inner, approved, context);
              if (isValidationError(output)) {
                const refused = validateToolInput(
                  source.inputSchema as never,
                  approved,
                  toolName,
                ).error;
                if (refused !== undefined && refused.message === output.message) {
                  throw new InputRefusedByTool(output);
                }
              }
              return output;
            },
          ),
      );
    } catch (err) {
      if (err instanceof InputRefusedByTool) {
        return err.result;
      }
      if (onAsk === "suspend" && err instanceof GuardianApprovalPending) {
        const suspend = suspendOf(toolContext);
        if (suspend !== undefined) {
          const payload: GuardianSuspendPayload = {
            guardian: {
              decision: "ASK",
              requestId: err.requestId,
              toolName,
              message:
                `Held for human approval (requestId ${err.requestId}). ` +
                `Resume the run once a person has approved it in Guardian; ` +
                `Guardian decides again whether the call may run.`,
            },
          };
          await suspend(payload);
          return undefined;
        }
      }
      throw err;
    }
  };

  // Same class, id, description, schemas and flags as the wrapped tool, so
  // Mastra treats it the same way; only `execute` goes through Guardian.
  const wrapped = Object.assign(
    Object.create(Object.getPrototypeOf(inner) as object | null) as object,
    inner,
    { execute },
  ) as unknown as typeof source;
  const toModelOutput = source.toModelOutput;
  if (typeof toModelOutput === "function") {
    // A Guardian answer (the remote-mode receipt, or a held or denied call
    // with "result") is not the tool's output: the model sees it as it is,
    // as JSON.
    wrapped.toModelOutput = (output) =>
      isGuardianResult(output, toolName)
        ? { type: "json", value: output }
        : toModelOutput.call(inner, output);
  }
  return wrapped as unknown as T;
}

function contextFor(options: GuardianMastraOptions): GuardianContext {
  const { onAsk, ...rest } = options;
  return createGuardianContext({
    ...rest,
    ...(onAsk === undefined
      ? {}
      : { onAsk: onAsk === "suspend" ? "throw" : onAsk }),
  });
}

/**
 * Wrap a Mastra tool (`createTool` from `@mastra/core/tools`) so its
 * `execute` routes through Guardian before it can run. The returned tool
 * has the same id, description, schemas and flags, so it drops into an
 * `Agent`'s `tools` unchanged. Guardian knows the tool by its `id`.
 *
 * - mode "remote" (default): the tool id is a registered Guardian catalog
 *   entry — `client.execute` performs the bounded HTTPS call and the wrapped
 *   tool's `execute` never runs; the call resolves to the ALLOW receipt.
 * - mode "inProcess" (opt-in, `mode`/`modes` options): the wrapped `execute`
 *   IS the tool — it runs only once ALLOW issues the capability, and
 *   `client.execute` redeems + records the evidence afterwards. It needs a
 *   `transport: "record"` catalog entry, registered once in the Guardian
 *   console. `installRecordTransport: true` (opt-in, default off) proposes
 *   it via `mcp.install`, but only works while no entry exists.
 *
 * ASK throws `GuardianApprovalPending` carrying the requestId (the Mastra
 * agent loop hands the model its message as the tool's error), returns a
 * result object with `onAsk: "result"`, or suspends the Mastra run with
 * `onAsk: "suspend"`. A resumed run calls the tool again and Guardian is
 * asked again: the call runs only if a person approved that request in
 * Guardian. What the app passes to Mastra's resume is not read.
 * DENY throws `GuardianDenied` (or returns a result object with
 * `onDeny: "result"`).
 *
 * Arguments: inside an agent or workflow run Mastra parses the model's
 * arguments with the tool's `inputSchema` once, before `execute`. Guardian
 * decides on that parsed value and the wrapped `execute` receives a copy of
 * exactly what Guardian decided. When `execute` is called directly, Guardian
 * decides on the value passed in, and the tool's own schema parses it when
 * the tool runs.
 *
 * A tool without `execute`, and a render-only tool, is returned unchanged.
 */
export function guardianTool<T extends MastraTool>(
  tool: T,
  options: GuardianMastraOptions,
): T {
  return wrapWithContext(tool, contextFor(options), options.onAsk);
}

/**
 * `guardianTool` mapped over a tool record (the shape an `Agent`'s `tools`
 * takes), keeping the keys. All tools share one Guardian context, so a held
 * call is found again whichever wrapped tool the retry comes through, and an
 * in-process tool's record-transport entry is installed at most once per
 * connection.
 */
export function guardianTools<T extends Record<string, MastraTool>>(
  tools: T,
  options: GuardianMastraOptions,
): T {
  const ctx = contextFor(options);
  const wrapped: Record<string, MastraTool> = {};
  for (const [key, tool] of Object.entries(tools)) {
    wrapped[key] = wrapWithContext(tool, ctx, options.onAsk);
  }
  return wrapped as T;
}
