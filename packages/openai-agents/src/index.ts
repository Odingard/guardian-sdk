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
  createGuardianContext,
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
  /** Setup state kept across calls (see the SDK's GuardianContext). */
  ensured: Set<string>;
  installed: NonNullable<GuardianContext["installed"]>;
  heldSetup: NonNullable<GuardianContext["heldSetup"]>;
  /**
   * Held ASK calls by invocation key, so a retry of the same call (same
   * arguments, same content pins) claims the approval the person gave
   * instead of proposing a new request.
   */
  heldInvocations: NonNullable<GuardianContext["heldInvocations"]>;
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
  return `Guardian could not check ${toolName}, so it did not run. Try again later.`;
}

/** Content-pin refusals after ALLOW: the tool did not run. */
function contentPinRefused(err: GuardianExecutionFailed): boolean {
  return (
    !err.localEffectRan &&
    !err.outcomeUnknown &&
    (err.reasonCode === "CONTENT_CHANGED_SINCE_APPROVAL" ||
      err.reasonCode.startsWith("CONTENT_PIN_"))
  );
}

function executionFailedMessage(err: GuardianExecutionFailed): string {
  if (contentPinRefused(err)) {
    return (
      `${err.toolName} did not run: a file it was approved with ` +
      (err.reasonCode === "CONTENT_CHANGED_SINCE_APPROVAL"
        ? "changed since the approval"
        : "could not be checked") +
      ` (${err.reasonCode}). Tell the user; a changed file needs a new ` +
      `approval.`
    );
  }
  if (err.localEffectRan) {
    return (
      `${err.toolName} ran, but Guardian could not record it ` +
      `(${err.reasonCode}). Do not call it again; tell the user it ran ` +
      `without a receipt.`
    );
  }
  if (err.outcomeUnknown) {
    return (
      `Guardian could not confirm that ${err.toolName} completed ` +
      `(${err.reasonCode}, requestId ${err.requestId}). It may have run. ` +
      `Do not call it again; tell the user so they can check.`
    );
  }
  return (
    `Guardian could not complete ${err.toolName} (${err.reasonCode}). ` +
    `Do not call it again; tell the user so they can check.`
  );
}

/**
 * The Agents SDK renames tools: every character that is not a letter or a
 * digit becomes "_" (its `toFunctionToolName`). Guardian sees that new
 * name. A `modes` entry keyed by the name the developer wrote is moved to
 * the new name so it still applies. Two entries that disagree are refused.
 */
function remapModes(
  modes: GuardianAdapterOptions["modes"],
  writtenName: string | undefined,
  builtName: string,
): GuardianAdapterOptions["modes"] {
  if (!modes || !writtenName || writtenName === builtName) {
    return modes;
  }
  if (!Object.prototype.hasOwnProperty.call(modes, writtenName)) {
    return modes;
  }
  const written = modes[writtenName];
  const hasBuilt = Object.prototype.hasOwnProperty.call(modes, builtName);
  if (hasBuilt && modes[builtName] !== written) {
    throw new Error(
      `Guardian modes disagree for tool "${writtenName}" (the Agents SDK ` +
        `names it "${builtName}"): set one entry`,
    );
  }
  return { ...modes, [builtName]: written };
}

/**
 * The same rename for `fileArgs`: an entry keyed by the name the developer
 * wrote is moved to the built name, so a declared file argument is never
 * left unpinned because the Agents SDK renamed the tool. Two entries that
 * disagree are refused.
 */
function remapFileArgs(
  fileArgs: GuardianAdapterOptions["fileArgs"],
  writtenName: string | undefined,
  builtName: string,
): GuardianAdapterOptions["fileArgs"] {
  if (!fileArgs || !writtenName || writtenName === builtName) {
    return fileArgs;
  }
  if (!Object.prototype.hasOwnProperty.call(fileArgs, writtenName)) {
    return fileArgs;
  }
  const written = fileArgs[writtenName]!;
  if (Object.prototype.hasOwnProperty.call(fileArgs, builtName)) {
    const built = fileArgs[builtName]!;
    const same =
      written !== null &&
      built !== null &&
      typeof written === "object" &&
      typeof built === "object" &&
      Object.keys(written).length === Object.keys(built).length &&
      Object.entries(written).every(
        ([arg, mode]) =>
          Object.prototype.hasOwnProperty.call(built, arg) &&
          built[arg] === mode,
      );
    if (!same) {
      throw new Error(
        `Guardian fileArgs disagree for tool "${writtenName}" (the Agents ` +
          `SDK names it "${builtName}"): set one entry`,
      );
    }
  }
  return { ...fileArgs, [builtName]: written };
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
  let coreOptions: GuardianAdapterOptions = {
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
      installed: shared.installed,
      heldSetup: shared.heldSetup,
      heldInvocations: shared.heldInvocations,
    };
    try {
      // `input` is the call's own arguments, parsed by the Agents SDK from
      // the tool call. The tool gets the copy Guardian decided on, not the
      // caller's object, which other code may have changed meanwhile.
      const output = await runThroughGuardian(
        ctx,
        toolName,
        input,
        (approved) => {
          gate.commit();
          return userExecute(approved as typeof input, runContext, details);
        },
      );
      gate.settle();
      return output;
    } catch (err) {
      const startedBeforeError = gate.committed;
      gate.settle();
      if (err instanceof GuardianApprovalPending) {
        // Hooks only observe. A failing hook must not lose the pending
        // approval or change what the model is told.
        try {
          await options.onApprovalPending?.(err);
        } catch {
          // ignored on purpose
        }
        if (onAsk === "result" && !hasOutputSchema) {
          return askMessage(toolName, err.requestId);
        }
        throw err;
      }
      // The Guardian client reports a network failure as ok:false
      // SERVICE_UNAVAILABLE (it never throws), which the triad turns into
      // GuardianDenied. That is Guardian not answering, not a decision: the
      // model must be told Guardian could not check the call, and
      // onGuardianError must fire.
      const guardianDidNotAnswer =
        err instanceof GuardianDenied &&
        err.reasonCode === "SERVICE_UNAVAILABLE" &&
        !startedBeforeError;
      if (err instanceof GuardianDenied && !guardianDidNotAnswer) {
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
      try {
        await options.onGuardianError?.({ toolName, error: err });
      } catch {
        // ignored on purpose: the model is still told the call did not run
      }
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
    // Never tell the model to try again after Guardian was asked to run or
    // record the call: the action may already have happened.
    if (error instanceof GuardianExecutionFailed) {
      return executionFailedMessage(error);
    }
    // A denial is never a reason to retry; an unavailable Guardian is, later.
    if (error instanceof GuardianDenied) {
      return denyMessage(error);
    }
    if (error instanceof GuardianUnavailable) {
      return unavailableMessage(error.toolName);
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
  const modes = remapModes(options.modes, name, built.name);
  if (modes !== options.modes) {
    coreOptions = { ...coreOptions, ...(modes ? { modes } : {}) };
  }
  const fileArgs = remapFileArgs(options.fileArgs, name, built.name);
  if (fileArgs !== options.fileArgs) {
    coreOptions = { ...coreOptions, ...(fileArgs ? { fileArgs } : {}) };
  }
  // Wrap time: a bad fileArgs declaration (or fileArgs in remote mode) is a
  // configuration error here, not on the first call.
  createGuardianContext(coreOptions);
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
    {
      options,
      ensured: new Set(),
      installed: new Set(),
      heldSetup: new Map(),
      heldInvocations: new Map(),
    },
    toolOptions as ToolOptions<any, any, any>,
  ) as GuardedTool<TParameters, Context, Result, TOutputSchema>;
}

/**
 * `guardianTool` with the Guardian options bound once. Tools made by one
 * factory share the record-transport cache.
 *
 * ```ts
 * const governed = createGuardianTool({ client, connectionId: "pcn_…" });
 * const refund = governed({ name: "refund_order", description, parameters, execute });
 * ```
 */
export function createGuardianTool(options: GuardianOpenAIAgentsOptions) {
  const shared: Shared = {
    options,
    ensured: new Set(),
    installed: new Set(),
    heldSetup: new Map(),
    heldInvocations: new Map(),
  };
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
