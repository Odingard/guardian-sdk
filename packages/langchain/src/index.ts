import {
  DynamicStructuredTool,
  type StructuredToolInterface,
} from "@langchain/core/tools";

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
 *   the capability, and `execute` redeems + records the evidence afterwards
 *   (auto-installs a `transport: "record"` catalog entry via `mcp.install`).
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
  const ctx = createGuardianContext(options);
  const wrapped = new DynamicStructuredTool({
    name: inner.name,
    description: inner.description,
    schema: inner.schema,
    func: async (input: unknown, _runManager, config) =>
      runThroughGuardian(ctx, inner.name, input, () =>
        inner.invoke(input as never, config),
      ),
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
  return tools.map(
    (inner) =>
      new DynamicStructuredTool({
        name: inner.name,
        description: inner.description,
        schema: inner.schema,
        func: async (input: unknown, _runManager, config) =>
          runThroughGuardian(ctx, inner.name, input, () =>
            inner.invoke(input as never, config),
          ),
      }),
  );
}
