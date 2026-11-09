import {
  tool,
  type FunctionTool,
  type RunContext,
  type ToolInputParameters,
  type ToolOptions,
  type ToolOutputSchema,
  type UnknownContext,
} from "@openai/agents";

import {
  GuardianApprovalPending,
  GuardianDenied,
  GuardianExecutionFailed,
  GuardianRecordTransportRequired,
  runThroughGuardian,
  type GuardianAdapterOptions,
  type GuardianContext,
} from "./core.js";
import { CallGate, GuardianUnavailable } from "./gate.js";

export {
  GuardianApprovalPending,
  GuardianDenied,
  GuardianExecutionFailed,
  GuardianRecordTransportRequired,
  toArgumentsRecord,
  type GuardianAdapterOptions,
  type GuardianDecisionResult,
  type GuardianMode,
  type GuardianResume,
  type GuardianToolMode,
} from "./core.js";
export { GuardianUnavailable } from "./gate.js";

/** Default time to wait for Guardian's decision before failing closed. */
export const DEFAULT_DECISION_TIMEOUT_MS = 30_000;

export type GuardianOpenAIAgentsOptions = GuardianAdapterOptions &
  Readonly<{
    /**
     * How long to wait for Guardian's decision, in milliseconds. Past it the
     * call fails closed: the tool does not run, and a late answer is ignored.
     * Default 30000. Waiting for a person is not part of this: an ASK comes
     * back from Guardian at once.
     */
    decisionTimeoutMs?: number;
    /**
     * Called with the pending approval whenever Guardian answers ASK, before
     * the call throws (onAsk "throw") or returns its message (onAsk
     * "result"). Show `pending.requestId` to a person; after they approve in
     * Guardian, `pending.resume()` claims the approval and runs the tool.
     */
    onApprovalPending?: (
      pending: GuardianApprovalPending,
    ) => void | PromiseLike<void>;
    /**
     * Called when Guardian could not be reached, failed, or did not answer
     * in time. The tool did not run. For logging only.
     */
    onGuardianError?: (event: {
      toolName: string;
      error: unknown;
    }) => void | PromiseLike<void>;
  }>;

const DEFAULT_TOOL_ERROR_MESSAGE =
  "An error occurred while running the tool. Please try again.";

type ToolDetails = Parameters<FunctionTool["invoke"]>[2];
type AnyExecute = (
  input: unknown,
  context?: RunContext<any>,
  details?: ToolDetails,
) => unknown;
type AnyErrorFunction = (
  context: RunContext<any>,
  error: unknown,
  details?: ToolDetails,
) => unknown;

type Shared = {
  options: GuardianOpenAIAgentsOptions;
  ensured: Set<string>;
};

function askMessage(toolName: string, requestId: string): string {
  return (
    `Guardian is holding ${toolName} for a person to approve ` +
    `(requestId ${requestId}). It has not run. Do not call it again; ` +
    `tell the user it is waiting for approval.`
  );
}

function denyMessage(err: GuardianDenied): string {
  return (
    `Guardian denied ${err.toolName} (${err.reasonCode}). It did not run. ` +
    `Do not retry the same call.`
  );
}

function unavailableMessage(toolName: string): string {
  return `Guardian could not check ${toolName}, so it did not run.`;
}

function buildTool(
  shared: Shared,
  toolOptions: ToolOptions<any, any, any>,
): FunctionTool<any, any, any> {
  const { options } = shared;
  const userExecute = toolOptions.execute as AnyExecute;
  const userErrorFunction = toolOptions.errorFunction as
    | AnyErrorFunction
    | null
    | undefined;
  const hasOutputSchema = typeof toolOptions.outputSchema !== "undefined";
  const timeoutMs = options.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
  // Every call is checked with the triad's own throw mode; this wrapper
  // decides what the model sees. DENY returns a refusal by default.
  const coreOptions: GuardianAdapterOptions = {
    ...options,
    mode: options.mode ?? "inProcess",
    installRecordTransport: options.installRecordTransport ?? false,
    onAsk: "throw",
    onDeny: "throw",
  };
  const onDeny = options.onDeny ?? "result";
  const onAsk = options.onAsk ?? "throw";

  let toolName = "";

  const execute = async (
    input: unknown,
    runContext?: RunContext<any>,
    details?: ToolDetails,
  ): Promise<unknown> => {
    const gate = new CallGate({
      client: options.client,
      toolName,
      timeoutMs,
      ...(details?.signal ? { signal: details.signal } : {}),
    });
    const ctx: GuardianContext = {
      options: { ...coreOptions, client: gate.client },
      ensured: shared.ensured,
    };
    try {
      // `input` is the call's own arguments, parsed by the Agents SDK from
      // the tool call. The same value goes to Guardian and to the tool.
      const output = await runThroughGuardian(ctx, toolName, input, () => {
        gate.commit();
        return userExecute(input, runContext, details);
      });
      gate.settle();
      return output;
    } catch (err) {
      const startedBeforeError = gate.committed;
      gate.settle();
      if (err instanceof GuardianApprovalPending) {
        await options.onApprovalPending?.(err);
        if (onAsk === "result" && !hasOutputSchema) {
          return askMessage(toolName, err.requestId);
        }
        throw err;
      }
      if (err instanceof GuardianDenied) {
        if (onDeny === "result" && !hasOutputSchema) {
          return denyMessage(err);
        }
        throw err;
      }
      if (
        err instanceof GuardianExecutionFailed ||
        err instanceof GuardianRecordTransportRequired ||
        startedBeforeError
      ) {
        throw err;
      }
      // Guardian failed, timed out or was cancelled before the tool started.
      await options.onGuardianError?.({ toolName, error: err });
      const unavailable =
        err instanceof GuardianUnavailable
          ? err
          : new GuardianUnavailable({ toolName, reason: "error" });
      if (hasOutputSchema) {
        throw unavailable;
      }
      return unavailableMessage(toolName);
    }
  };

  // A pending approval must reach the app, so it is never turned into a
  // model-visible error. Everything else keeps the tool's own handling.
  const errorFunction = async (
    context: RunContext<any>,
    error: unknown,
    details?: ToolDetails,
  ): Promise<unknown> => {
    if (error instanceof GuardianApprovalPending) {
      throw error;
    }
    if (typeof userErrorFunction === "function") {
      return userErrorFunction(context, error, details);
    }
    if (userErrorFunction === null || hasOutputSchema) {
      throw error;
    }
    return DEFAULT_TOOL_ERROR_MESSAGE;
  };

  const name = toolOptions.name ?? userExecute.name;
  const built = tool({
    ...toolOptions,
    ...(name ? { name } : {}),
    execute,
    errorFunction,
  } as ToolOptions<any, any, any>) as FunctionTool<any, any, any>;
  toolName = built.name;
  return built;
}

type GuardedTool<
  TParameters extends ToolInputParameters,
  Context,
  Result,
  TOutputSchema extends ToolOutputSchema | undefined,
> = ReturnType<typeof tool<TParameters, Context, Result, TOutputSchema>>;

/**
 * A drop-in for the Agents SDK's `tool()`: same options, but every call
 * goes through Guardian before `execute` runs.
 *
 * - ALLOW: `execute` runs once (in-process mode, the default) and the
 *   capability is redeemed to record a receipt. In remote mode Guardian
 *   performs the registered call itself and `execute` never runs.
 * - ASK: `execute` does not run. By default the call throws
 *   `GuardianApprovalPending` out of `run()`; after a person approves,
 *   `pending.resume()` claims the approval and runs the tool. With
 *   `onAsk: "result"` the model is told the call is waiting instead.
 * - DENY: `execute` never runs; the model gets a plain refusal
 *   (`onDeny: "throw"` throws `GuardianDenied` instead).
 * - Guardian error, network failure, timeout or cancellation: `execute`
 *   never runs; the model is told Guardian could not check the call.
 *
 * In-process mode is decision-gated: `execute` runs after ALLOW and before
 * the capability is redeemed, so a revocation at redemption lands after
 * the effect (reported as `GuardianExecutionFailed` with
 * `localEffectRan`). Use `mode: "remote"` where Guardian must hold the
 * effect itself.
 */
export function guardianTool<
  TParameters extends ToolInputParameters = undefined,
  Context = UnknownContext,
  Result = string,
  TOutputSchema extends ToolOutputSchema | undefined = undefined,
>(
  toolOptions: ToolOptions<TParameters, Context, TOutputSchema>,
  options: GuardianOpenAIAgentsOptions,
): GuardedTool<TParameters, Context, Result, TOutputSchema> {
  return buildTool(
    { options, ensured: new Set() },
    toolOptions as ToolOptions<any, any, any>,
  ) as GuardedTool<TParameters, Context, Result, TOutputSchema>;
}

/**
 * `guardianTool` with the Guardian options bound once. Tools made by one
 * factory share the record-transport cache.
 *
 * ```ts
 * const governed = createGuardianTool({ client, connectionId: "con_…" });
 * const refund = governed({ name: "refund_order", description, parameters, execute });
 * ```
 */
export function createGuardianTool(options: GuardianOpenAIAgentsOptions) {
  const shared: Shared = { options, ensured: new Set() };
  return <
    TParameters extends ToolInputParameters = undefined,
    Context = UnknownContext,
    Result = string,
    TOutputSchema extends ToolOutputSchema | undefined = undefined,
  >(
    toolOptions: ToolOptions<TParameters, Context, TOutputSchema>,
  ): GuardedTool<TParameters, Context, Result, TOutputSchema> =>
    buildTool(shared, toolOptions as ToolOptions<any, any, any>) as GuardedTool<
      TParameters,
      Context,
      Result,
      TOutputSchema
    >;
}

/**
 * Find the pending approval behind an error thrown by `run()`. The Agents
 * SDK may hand the tool's error back as is or wrapped (for example in
 * `ToolCallError.error`); this looks through both.
 */
export function findApprovalPending(
  err: unknown,
): GuardianApprovalPending | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof GuardianApprovalPending) {
      return current;
    }
    const next =
      (current as { error?: unknown }).error ??
      (current as { cause?: unknown }).cause;
    current = next;
  }
  return undefined;
}
