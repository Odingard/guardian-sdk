import {
  DynamicStructuredTool,
  type StructuredToolInterface,
} from "@langchain/core/tools";

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

export type GuardianLangChainOptions = GuardianAdapterOptions;

/**
 * Wrap a LangChain StructuredTool / DynamicStructuredTool so its `func`
 * routes through Guardian before it can execute.
 *
 * - mode "remote" (default): the tool name is a registered Guardian catalog
 *   entry — `client.execute` performs the bounded HTTPS call and the wrapped
 *   tool's impl never runs; invoke resolves to the ALLOW receipt.
 * - mode "inProcess" (opt-in): the wrapped impl runs only once ALLOW issues
 *   the capability, and `execute` redeems + records the evidence afterwards.
 *   It needs a `transport: "record"` catalog entry, registered once in the
 *   Guardian console. `installRecordTransport: true` (opt-in, default off)
 *   proposes it via `mcp.install`, but only works while no entry exists.
 *
 * ASK raises `GuardianApprovalPending` carrying the requestId (map it onto
 * a LangGraph `interrupt`, or `resume()` after approval); DENY raises
 * `GuardianDenied`.
 *
 * The returned tool keeps the wrapped tool's name, description, schema and
 * returnDirect flag, so it drops into `bindTools` / a LangGraph node
 * unchanged.
 */
export function guardianTool(
  inner: StructuredToolInterface,
  options: GuardianLangChainOptions,
): StructuredToolInterface {
  return wrapWithContext(inner, createGuardianContext(options));
}

/**
 * Honour LangChain's `config.signal` (an abort, or `config.timeout`). Each
 * call gets its own view of the Guardian client:
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

type DirectTool = {
  _call?: (input: unknown, runManager?: unknown, config?: unknown) => unknown;
  func?: (input: unknown, runManager?: unknown, config?: unknown) => unknown;
};

function isAsyncGenerator(value: unknown): value is AsyncGenerator {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AsyncGenerator).next === "function" &&
    typeof (value as AsyncGenerator)[Symbol.asyncIterator] === "function"
  );
}

/**
 * Run the inner tool on the value the wrapper already parsed, the same
 * value Guardian decided on. `inner.invoke` would parse it a second time,
 * and a schema that transforms its input (unit scaling, defaults that
 * depend on the input) would then run the tool with different arguments.
 * The inner tool gets the config without its abort signal: once it has
 * started it runs to its real outcome (see `abortable`).
 */
async function runInner(
  inner: StructuredToolInterface,
  input: unknown,
  runManager: unknown,
  config: Record<string, unknown> | undefined,
): Promise<unknown> {
  const { signal: _signal, ...rest } = config ?? {};
  const direct = inner as unknown as DirectTool;
  let raw: unknown;
  if (typeof direct._call === "function") {
    raw = await direct._call.call(inner, input, runManager, rest);
  } else if (typeof direct.func === "function") {
    raw = await direct.func.call(inner, input, runManager, rest);
  } else {
    // Not a LangChain StructuredTool: only `invoke` is available.
    return inner.invoke(input as never, rest as never);
  }
  if (isAsyncGenerator(raw)) {
    // A streaming tool: it has only run once it is consumed.
    let step = await raw.next();
    while (!step.done) step = await raw.next();
    return step.value;
  }
  return raw;
}

function wrapWithContext(
  inner: StructuredToolInterface,
  ctx: ReturnType<typeof createGuardianContext>,
): StructuredToolInterface {
  const source = inner as unknown as {
    responseFormat?: string;
    verboseParsingErrors?: boolean;
  };
  const wrapped = new DynamicStructuredTool({
    name: inner.name,
    description: inner.description,
    schema: inner.schema,
    ...(source.responseFormat
      ? { responseFormat: source.responseFormat as never }
      : {}),
    ...(source.verboseParsingErrors !== undefined
      ? { verboseParsingErrors: source.verboseParsingErrors }
      : {}),
    // `input` is already parsed by the wrapper's schema (the inner tool's).
    // Guardian decides on it; the inner tool gets Guardian's copy of it.
    func: async (input: unknown, runManager, config) => {
      const signal = (config as { signal?: AbortSignal } | undefined)?.signal;
      return abortable(ctx.options.client, signal, (client, startTool) =>
        runThroughGuardian(
          client === ctx.options.client
            ? ctx
            : { ...ctx, options: { ...ctx.options, client } },
          inner.name,
          input,
          (approved) => {
            startTool();
            // The copy Guardian decided on, not the caller's object, which
            // other code may have changed while the call waited.
            return runInner(
              inner,
              approved,
              runManager,
              config as Record<string, unknown> | undefined,
            );
          },
        ),
      );
    },
  });
  wrapped.returnDirect = inner.returnDirect;
  return wrapped;
}

/**
 * `guardianTool` mapped over a tool list, preserving order. All tools share
 * one ensured-catalog cache, so an in-process tool's record-transport entry
 * is installed at most once per connection.
 */
export function guardianTools(
  tools: readonly StructuredToolInterface[],
  options: GuardianLangChainOptions,
): StructuredToolInterface[] {
  const ctx = createGuardianContext(options);
  return tools.map((inner) => wrapWithContext(inner, ctx));
}
