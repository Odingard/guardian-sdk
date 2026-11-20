import {
  createTool,
  isValidationError,
  validateToolInput,
  type Tool,
} from "@mastra/core/tools";
import {
  abortable,
  resolveHeldScope,
  scopeHeldRequests,
  SCOPE_UNKNOWN,
  type HeldScope,
} from "@odingard/guardian-sdk";

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
  /**
   * Held requests are scoped per session. The scope of one call: the
   * conversation or user it belongs to, from the context Mastra passes the
   * tool's `execute`. That context is the caller's (your agent run), not
   * part of the model's tool call; never read the scope from the tool's
   * input. A held call is claimed only by the same call in the same scope;
   * an identical call in another scope is its own request.
   *
   * Without this option the scope is the run's Mastra thread and resource
   * (`memory: { thread, resource }` on `generate` / `stream`, which the
   * tool sees as `context.agent.threadId` and `context.agent.resourceId`).
   * Only when the run has neither are held calls shared by every call of
   * the wrapped tools, which must then serve one principal. An id that is
   * present but is not a non-empty string is an unknown session, as below.
   *
   * With this option, it alone names the scope (thread and resource are
   * not used). Return a non-empty string. Anything else means the session
   * is not known, and a held call is then never claimed by a later call:
   * `SCOPE_UNKNOWN` (from `@odingard/guardian-sdk`), `undefined`, `null`,
   * an empty string, any other value, or the function throwing. The scope
   * stays in this process.
   */
  scope?: (
    context: unknown,
  ) => string | typeof SCOPE_UNKNOWN | null | undefined;
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
  runId?: unknown;
  threadId?: unknown;
  resourceId?: unknown;
  suspend?: Suspend;
  resumeData?: unknown;
  suspendPayload?: unknown;
  agent?: {
    suspend?: Suspend;
    resumeData?: unknown;
    suspendPayload?: unknown;
    toolCallId?: unknown;
    threadId?: unknown;
    resourceId?: unknown;
  };
  workflow?: { suspend?: Suspend; resumeData?: unknown };
};
type Suspend = (payload: unknown, options?: unknown) => Promise<unknown>;
type Execute = (input: unknown, context?: unknown) => Promise<unknown>;

/**
 * The wrapped tool refused the call with a check Mastra makes before the
 * tool's `execute` body (its input, request context or resume data), so the
 * body did not run. Thrown inside the triad's runner so the capability is
 * not redeemed and no record says the tool ran.
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

/**
 * The default scope of a call: the Mastra thread and resource of its run.
 * The application sets them (`memory: { thread, resource }`); Mastra puts
 * them in the context it builds for the tool (`context.agent` in an agent
 * run, the top level otherwise), which the model's tool call cannot write.
 * A thread belongs to a resource, so both are part of the scope. Without
 * either, held calls are shared. An id that is present but names nothing
 * (an empty string, a non-string) is an unknown session.
 */
function threadScope(context: ToolContext | undefined): HeldScope {
  const threadId = context?.agent?.threadId ?? context?.threadId;
  const resourceId = context?.agent?.resourceId ?? context?.resourceId;
  const absent = (id: unknown) => id === undefined || id === null;
  if (absent(threadId) && absent(resourceId)) {
    return undefined;
  }
  const named = (id: unknown) => typeof id === "string" && id.length > 0;
  if (
    (!absent(threadId) && !named(threadId)) ||
    (!absent(resourceId) && !named(resourceId))
  ) {
    return SCOPE_UNKNOWN;
  }
  return JSON.stringify([resourceId ?? null, threadId ?? null]);
}

/**
 * How long the arguments of a suspended call are kept for its resume. A
 * request Guardian holds stays open for at most 5 minutes
 * (`GUARDIAN_MAX_REQUEST_TTL_MS`), so a run resumed a day later has no held
 * request left to claim with them.
 */
const SUSPENDED_KEPT_MS = 24 * 60 * 60 * 1000;

/**
 * One suspended tool call of one agent run, in its scope. Mastra gives both
 * ids to the first call and to the resumed one; without them, and for a
 * call whose session is not known, nothing is remembered.
 */
function suspensionKey(
  context: ToolContext | undefined,
  scope: HeldScope,
): string | undefined {
  if (scope === SCOPE_UNKNOWN) {
    return undefined;
  }
  const runId = context?.runId;
  const toolCallId = context?.agent?.toolCallId;
  return typeof runId === "string" &&
    runId.length > 0 &&
    typeof toolCallId === "string" &&
    toolCallId.length > 0
    ? JSON.stringify([scope ?? null, runId, toolCallId])
    : undefined;
}

/** The request id in the suspend payload Mastra hands a resumed call. */
function suspendedRequestId(context: ToolContext | undefined): unknown {
  const payload = (context?.agent?.suspendPayload ?? context?.suspendPayload) as
    | { guardian?: { requestId?: unknown } }
    | null
    | undefined;
  return payload?.guardian?.requestId;
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
  options: GuardianMastraOptions,
): T {
  const onAsk = options.onAsk;
  const readScope = options.scope;
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

  // The checks Mastra makes before a tool's body, other than its input:
  // the request context against `requestContextSchema`, and resume data
  // against `resumeSchema`. A tool with the same id and those two schemas,
  // and no body of its own, answers whether the wrapped tool would refuse a
  // call with this context before its body runs. It gets a copy of the
  // context, so the original keeps Mastra's "input already parsed" mark.
  const contextSchemas = inner as unknown as {
    requestContextSchema?: unknown;
    resumeSchema?: unknown;
  };
  const probe =
    contextSchemas.requestContextSchema === undefined &&
    contextSchemas.resumeSchema === undefined
      ? undefined
      : (createTool({
          id: toolName,
          description: "",
          requestContextSchema: contextSchemas.requestContextSchema as never,
          resumeSchema: contextSchemas.resumeSchema as never,
          execute: async () => undefined,
        }) as unknown as { execute: Execute });
  const refusedBeforeBody = async (context: unknown): Promise<unknown> => {
    if (probe === undefined) return undefined;
    const answer = await probe.execute(
      undefined,
      context === undefined || context === null
        ? undefined
        : { ...(context as object) },
    );
    return isValidationError(answer) ? answer : undefined;
  };

  // Calls this wrapper suspended for a held request (onAsk "suspend"): the
  // arguments Guardian was asked about, kept until the run resumes.
  // A run that is never resumed (the request was denied or expired) would
  // keep its entry for the life of the process, so each new entry removes
  // the ones older than SUSPENDED_KEPT_MS. The map is in insertion order,
  // oldest first.
  const suspended = new Map<
    string,
    { requestId: string; input: unknown; at: number }
  >();
  const keepSuspended = (key: string, requestId: string, input: unknown) => {
    const now = Date.now();
    for (const [oldKey, entry] of suspended) {
      if (now - entry.at <= SUSPENDED_KEPT_MS) break;
      suspended.delete(oldKey);
    }
    suspended.delete(key);
    suspended.set(key, { requestId, input, at: now });
  };

  const execute: Execute = async (received, context) => {
    const toolContext = context as ToolContext | undefined;
    // A call the tool would refuse for its request context or resume data
    // is answered as the tool answers it: Guardian is not asked.
    const refusedContext = await refusedBeforeBody(context);
    if (refusedContext !== undefined) {
      return refusedContext;
    }
    // Held requests are scoped per session: this call sees only the held
    // calls of its own scope. The app's `scope` option replaces the
    // thread-and-resource default, and whatever it gives that is not a
    // session is an unknown one; only without the option, and without a
    // thread or resource, are held calls shared as before.
    const scope: HeldScope =
      readScope === undefined
        ? threadScope(toolContext)
        : resolveHeldScope(() => readScope(context));
    const scoped = scopeHeldRequests(ctx, scope);
    let input = received;
    const key = suspensionKey(toolContext, scope);
    if (isResuming(toolContext)) {
      const kept = key === undefined ? undefined : suspended.get(key);
      if (
        kept !== undefined &&
        kept.requestId === suspendedRequestId(toolContext)
      ) {
        // The run this wrapper suspended: the arguments Guardian was asked
        // about, so the held request is claimed. A schema that generates a
        // value (a default made at parse time) would give other arguments
        // on a second parse, and the approved request would never be used.
        input = kept.input;
      } else {
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
    }
    if (key !== undefined) {
      // Kept only while the call is suspended: set again below if it is.
      suspended.delete(key);
    }
    try {
      // Honour Mastra's `context.abortSignal` (the run's abort signal): an
      // abort before the tool starts rejects at once, so an unanswered
      // Guardian call does not hang the run, and refuses every later step;
      // a started tool runs to its real outcome (`abortable` in
      // @odingard/guardian-sdk).
      return await abortable(
        ctx.options.client,
        toolContext?.abortSignal,
        (client, startTool) =>
          runThroughGuardian(
            client === ctx.options.client
              ? scoped
              : { ...scoped, options: { ...scoped.options, client } },
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
                // Refused before the body (input, request context or resume
                // data), or after it (its output)? Only the first means the
                // tool did not run: those checks give the same answer again.
                const inputRefusal = validateToolInput(
                  source.inputSchema as never,
                  approved,
                  toolName,
                ).error;
                const contextRefusal = (await refusedBeforeBody(context)) as
                  | { message?: unknown }
                  | undefined;
                if (
                  inputRefusal?.message === output.message ||
                  contextRefusal?.message === output.message
                ) {
                  throw new InputRefusedByTool(output);
                }
              }
              return output;
            },
          ),
        // So a setup step held by an earlier call is not taken for the tool.
        // The scoped context shares the wrapper's held setup steps (only
        // held tool calls are scoped).
        scoped,
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
          if (key !== undefined) {
            keepSuspended(key, err.requestId, err.input);
          }
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
  const { onAsk, scope: _scope, ...rest } = options;
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
  return wrapWithContext(tool, contextFor(options), options);
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
    wrapped[key] = wrapWithContext(tool, ctx, options);
  }
  return wrapped as T;
}
