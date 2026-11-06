// Generated file — do not edit.
import type {
  GuardianClient,
  GuardianMcpInvocation,
  GuardianRequestResult,
} from "./client.js";

/**
 * The catalog shape: a record-transport entry has no endpoint —
 * `execute` commits evidence instead of making an HTTP call. Adapters send
 * it through `mcp.install`; an older SDK build without record transport fails local validation
 * first, which the adapter reports as `GuardianRecordTransportRequired`.
 */
type RecordTransportToolDescriptor = Readonly<{
  name: string;
  description?: string;
  transport: "record";
}>;

/**
 * The governed-execution triad, canonical in the core SDK. Every
 * framework adapter (LangChain, Vercel AI, the MCP proxy) and the plain
 * `createGuard` helper share this one implementation: a tool never runs
 * unless Guardian issued a capability for this exact request.
 *
 * Two execution modes:
 *
 * - `remote` (default): the tool is a registered catalog entry — a bounded
 *   HTTPS call Guardian executes itself. `client.execute` IS the execution;
 *   the local `execute`/`func` implementation is never run.
 * - `inProcess` (opt-in): the local implementation is the tool. After ALLOW
 *   the impl runs first, then `client.execute` redeems the capability and
 *   records the evidence — which requires a `transport: "record"` catalog
 *   entry on the connection (auto-installed via `mcp.install`; needs a
 *   control plane with record-transport support).
 */

/** Thrown (or returned) when Guardian refuses an action before execution. */
export class GuardianDenied extends Error {
  readonly decision = "DENY" as const;
  readonly toolName: string;
  readonly reasonCode: string;
  readonly requestId: string | undefined;
  /** What the developer can do next. Never changes the decision. */
  readonly hint: string | undefined;

  constructor(args: {
    toolName: string;
    reasonCode: string;
    requestId?: string;
    hint?: string;
  }) {
    super(
      `Guardian denied "${args.toolName}"` +
        ` (reasonCode=${args.reasonCode})` +
        (args.requestId ? ` requestId=${args.requestId}` : "") +
        (args.hint ? `. ${args.hint}` : ""),
    );
    this.name = "GuardianDenied";
    this.toolName = args.toolName;
    this.reasonCode = args.reasonCode;
    this.requestId = args.requestId;
    this.hint = args.hint;
  }
}

/**
 * Actionable next steps for the denials developers hit first.
 * Display only: the decision and reason code are unchanged.
 */
export function denialHint(
  toolName: string,
  reasonCode: string,
  stage: "register" | "invoke",
): string | undefined {
  if (reasonCode === "PLAN_LIMIT_EXCEEDED") {
    return "Your Guardian plan's monthly protected-action limit is reached; upgrade in Settings → Billing or wait for the next period.";
  }
  if (stage === "register") {
    return (
      `Guardian did not allow registering "${toolName}" automatically. ` +
      `Register it once in the Guardian console (Connections → tool server → ` +
      `"My own code (record-only)"), allow it for this agent, and pass ` +
      `installRecordTransport: false.`
    );
  }
  if (reasonCode === "INVALID_REQUEST") {
    return (
      `Check that "${toolName}" is registered on this connection and allowed ` +
      `for this agent (Guardian console → Agents → the agent → Tools).`
    );
  }
  return undefined;
}

/** ALLOW was decided but redeeming the capability failed. */
export class GuardianExecutionFailed extends Error {
  readonly toolName: string;
  readonly requestId: string;
  readonly reasonCode: string;
  /**
   * inProcess only: the local tool already ran before Guardian's final
   * redemption refused it. The effect happened without a recorded receipt;
   * treat it as an incident, never as a successful governed action.
   */
  readonly localEffectRan: boolean;

  constructor(args: {
    toolName: string;
    requestId: string;
    reasonCode: string;
    localEffectRan?: boolean;
  }) {
    super(
      `Guardian execution of "${args.toolName}" failed` +
        ` (requestId=${args.requestId}, reasonCode=${args.reasonCode}` +
        `${args.localEffectRan ? ", localEffectRan=true" : ""})`,
    );
    this.name = "GuardianExecutionFailed";
    this.toolName = args.toolName;
    this.requestId = args.requestId;
    this.reasonCode = args.reasonCode;
    this.localEffectRan = args.localEffectRan ?? false;
  }
}

/**
 * `inProcess` mode needs a record-transport catalog entry on the tool
 * connection so `execute` commits evidence without an HTTP call. Thrown when
 * the auto-install proposal could not even be formed — the SDK/control
 * plane in use predates the `transport: "record"` tool kind.
 */
export class GuardianRecordTransportRequired extends Error {
  readonly toolName: string;

  constructor(args: { toolName: string }) {
    super(
      `Guardian in-process mode for "${args.toolName}" requires a ` +
        `record-transport catalog entry (transport: "record"), which needs ` +
        `the updated Guardian control plane — auto-install was rejected by ` +
        `the client before it reached the network`,
    );
    this.name = "GuardianRecordTransportRequired";
    this.toolName = args.toolName;
  }
}

export type GuardianResume<Output> = () => Promise<{
  requestId: string;
  receipt: unknown;
  output: Output | GuardianDecisionResult;
}>;

/**
 * Guardian held the action for human approval (`ASK`). Carries the requestId
 * the app needs to surface to the approver; `resume()` claims the approved
 * capability, executes it, and finishes the call — never before approval.
 */
export class GuardianApprovalPending<Output = unknown> extends Error {
  readonly decision = "ASK" as const;
  readonly requestId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly #resume: GuardianResume<Output>;

  constructor(
    args: {
      requestId: string;
      toolName: string;
      input: unknown;
    },
    resume: GuardianResume<Output>,
  ) {
    super(
      `Guardian held "${args.toolName}" for human approval` +
        ` (requestId=${args.requestId})`,
    );
    this.name = "GuardianApprovalPending";
    this.requestId = args.requestId;
    this.toolName = args.toolName;
    this.input = args.input;
    this.#resume = resume;
  }

  /** Claim + execute + finish after the human approves. */
  resume() {
    return this.#resume();
  }
}

/**
 * Serializable decision handed back to the model: ASK/DENY when mode is
 * "result", plus the ALLOW receipt a remote-mode call resolves to.
 */
export type GuardianDecisionResult =
  | {
      guardian: {
        decision: "ALLOW";
        requestId: string;
        toolName: string;
        receipt: unknown;
      };
    }
  | {
      guardian: {
        decision: "ASK";
        requestId: string;
        toolName: string;
        message: string;
      };
    }
  | {
      guardian: {
        decision: "DENY";
        toolName: string;
        reasonCode: string;
        requestId?: string;
        message: string;
      };
    };

export type GuardianMode = "throw" | "result";

/**
 * `remote`: the tool name is a registered Guardian catalog entry and the
 * server performs the bounded HTTPS call — the local impl never runs.
 * `inProcess`: the local impl IS the tool; it runs only after the capability
 * is issued and its evidence is recorded via execute afterwards.
 */
export type GuardianToolMode = "remote" | "inProcess";

export type GuardianAdapterOptions = Readonly<{
  client: GuardianClient;
  /** Tool connection id the proposals are authorized against. */
  connectionId: string;
  /** Adapter audience for executes; defaults to the tool adapter. */
  adapterId?: string;
  /** Human label for the agent in audit + default purpose strings. */
  agentName?: string;
  /** Static purpose or per-call purpose shown to approvers. */
  purpose?: string | ((toolName: string, input: unknown) => string);
  /**
   * Execution mode applied to every wrapped tool: "remote" (default) defers
   * execution to the Guardian catalog entry; "inProcess" runs the local
   * implementation and records the evidence. See `modes` for per-tool
   * overrides.
   */
  mode?: GuardianToolMode;
  /** Per-tool-name mode overrides, e.g. `{ refund_order: "remote" }`. */
  modes?: Readonly<Record<string, GuardianToolMode>>;
  /**
   * inProcess only: auto-propose `mcp.install` of a `transport: "record"`
   * catalog entry for each wrapped tool that lacks one. Default true;
   * requires a control plane with record-transport support — an older SDK raises
   * `GuardianRecordTransportRequired` before any network call.
   */
  installRecordTransport?: boolean;
  /** What ASK does inside the wrapped call. Default "throw". */
  onAsk?: GuardianMode;
  /** What DENY does inside the wrapped call. Default "throw". */
  onDeny?: GuardianMode;
  /** Called with the execution receipt after every ALLOW. */
  onReceipt?: (event: {
    toolName: string;
    requestId: string;
    receipt: unknown;
  }) => void | PromiseLike<void>;
}>;

/** Per-wrapper state: which record-transport entries were already ensured. */
export type GuardianContext = {
  options: GuardianAdapterOptions;
  ensured: Set<string>;
};

export function createGuardianContext(
  options: GuardianAdapterOptions,
): GuardianContext {
  return { options, ensured: new Set() };
}

export function toolModeFor(
  options: GuardianAdapterOptions,
  toolName: string,
): GuardianToolMode {
  return options.modes?.[toolName] ?? options.mode ?? "remote";
}

export function toArgumentsRecord(input: unknown): Record<string, unknown> {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return input === undefined ? {} : { input };
}

function resolvePurpose(
  options: GuardianAdapterOptions,
  toolName: string,
  input: unknown,
): string {
  if (typeof options.purpose === "function") {
    return options.purpose(toolName, input);
  }
  if (typeof options.purpose === "string") {
    return options.purpose;
  }
  const agent = options.agentName ?? "agent";
  return `${agent} invoked ${toolName}`;
}

function deny(
  options: GuardianAdapterOptions,
  toolName: string,
  reasonCode: string,
  requestId: string | undefined,
  stage: "register" | "invoke" = "invoke",
): GuardianDecisionResult {
  const hint = denialHint(toolName, reasonCode, stage);
  if (options.onDeny === "result") {
    return {
      guardian: {
        decision: "DENY",
        toolName,
        reasonCode,
        ...(requestId ? { requestId } : {}),
        message:
          `Guardian denied ${toolName} (${reasonCode}). Do not retry the same call.` +
          (hint ? ` ${hint}` : ""),
      },
    };
  }
  throw new GuardianDenied({
    toolName,
    reasonCode,
    ...(requestId ? { requestId } : {}),
    ...(hint ? { hint } : {}),
  });
}

function isLocalValidationError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}

/**
 * Ensure a `transport: "record"` catalog entry exists for an in-process tool
 * so a later `execute` commits evidence instead of an HTTP call. Idempotent
 * per connection+tool; a TOOL_ALREADY_INSTALLED denial counts as ensured.
 */
async function ensureRecordTransport<Output>(
  ctx: GuardianContext,
  toolName: string,
  input: unknown,
  runTool: () => Output | PromiseLike<Output>,
): Promise<GuardianDecisionResult | void> {
  const { options } = ctx;
  if (options.installRecordTransport === false) {
    return;
  }
  const key = `${options.connectionId}:${toolName}`;
  if (ctx.ensured.has(key)) {
    return;
  }
  let result: GuardianRequestResult;
  try {
    result = await options.client.request({
      action: "mcp.install",
      connectionId: options.connectionId,
      tool: {
        name: toolName,
        description:
          `In-process tool "${toolName}" — evidence record only ` +
          `(registered by a Guardian framework adapter)`,
        transport: "record",
      } satisfies RecordTransportToolDescriptor as unknown as Extract<
        GuardianMcpInvocation,
        { action: "mcp.install" }
      >["tool"],
      ...(options.adapterId ? { adapterId: options.adapterId } : {}),
      purpose: `Register in-process tool ${toolName} for evidence recording`,
    });
  } catch (err) {
    if (isLocalValidationError(err)) {
      throw new GuardianRecordTransportRequired({ toolName });
    }
    throw err;
  }
  if (!result.ok) {
    if (result.reasonCode === "TOOL_ALREADY_INSTALLED") {
      ctx.ensured.add(key);
      return;
    }
    // The gateway reports a held registration as APPROVAL_REQUIRED
    // carrying its requestId — that is an ASK, not a denial.
    const held = result.requestId;
    if (
      result.reasonCode === "APPROVAL_REQUIRED" &&
      typeof held === "string" &&
      held.length > 0
    ) {
      result = {
        ok: true,
        requestId: held,
        decision: "ASK",
        reasonCode: result.reasonCode,
      };
    } else {
      return deny(options, toolName, result.reasonCode, undefined, "register");
    }
  }
  if (result.decision === "ALLOW" && result.capabilityToken) {
    const executed = await options.client.execute({
      requestId: result.requestId,
      capabilityToken: result.capabilityToken,
    });
    if (!executed.ok) {
      throw new GuardianExecutionFailed({
        toolName,
        requestId: result.requestId,
        reasonCode: executed.reasonCode,
      });
    }
    ctx.ensured.add(key);
    return;
  }
  if (result.decision === "ASK") {
    const requestId = result.requestId;
    if (options.onAsk === "result") {
      return {
        guardian: {
          decision: "ASK",
          requestId,
          toolName,
          message:
            `Installing the record-transport catalog entry for ` +
            `${toolName} needs human approval (requestId ${requestId}). ` +
            `Retry the tool call after approval.`,
        },
      };
    }
    // resume() claims the install, executes it, then continues the original
    // tool call end to end (propose → triad → impl/receipt).
    const resumeInstall = async (): Promise<{
      requestId: string;
      receipt: unknown;
      output: Output | GuardianDecisionResult;
    }> => {
      const claimed = await options.client.claim(requestId);
      if (
        claimed.ok &&
        claimed.decision === "ALLOW" &&
        claimed.capabilityToken
      ) {
        const executed = await options.client.execute({
          requestId: claimed.requestId,
          capabilityToken: claimed.capabilityToken,
        });
        if (!executed.ok) {
          throw new GuardianExecutionFailed({
            toolName,
            requestId: claimed.requestId,
            reasonCode: executed.reasonCode,
          });
        }
        ctx.ensured.add(key);
        const output = await runThroughGuardian(ctx, toolName, input, runTool);
        return {
          requestId: claimed.requestId,
          receipt: executed.receipt,
          output,
        };
      }
      if (claimed.ok && claimed.decision === "ASK") {
        throw new GuardianApprovalPending(
          { requestId: claimed.requestId, toolName, input },
          resumeInstall,
        );
      }
      // Claimed before the human decided — still held, not denied.
      if (
        !claimed.ok &&
        (claimed.reasonCode === "APPROVAL_PENDING" ||
          claimed.reasonCode === "APPROVAL_REQUIRED")
      ) {
        throw new GuardianApprovalPending(
          { requestId, toolName, input },
          resumeInstall,
        );
      }
      throw new GuardianDenied({
        toolName,
        reasonCode: claimed.ok
          ? (claimed.reasonCode ?? "MISSING_CAPABILITY")
          : claimed.reasonCode,
        ...(claimed.ok ? { requestId: claimed.requestId } : {}),
      });
    };
    throw new GuardianApprovalPending(
      { requestId, toolName, input },
      resumeInstall,
    );
  }
  return deny(
    options,
    toolName,
    result.reasonCode ?? "MISSING_CAPABILITY",
    result.requestId,
    "register",
  );
}

/**
 * The triad applied to an already-answered request (request or claim).
 * remote: ALLOW → execute (Guardian performs the call) → receipt is the
 * output; the local impl never runs.
 * inProcess: ALLOW → run the impl → execute redeems + records → impl output.
 * ASK → pending handle; DENY → typed denial.
 */
export async function settle<Output>(
  ctx: GuardianContext,
  toolName: string,
  input: unknown,
  result: GuardianRequestResult,
  runTool: () => Output | PromiseLike<Output>,
): Promise<Output | GuardianDecisionResult> {
  const { options } = ctx;
  const mode = toolModeFor(options, toolName);
  if (!result.ok) {
    // A held ASK arrives as 403 APPROVAL_REQUIRED carrying its requestId
    // (guardian-sdk >= 0.2.0); a claim made before the human decided comes
    // back APPROVAL_PENDING — still held, never a denial. Without a
    // requestId it cannot be resumed, so it fails closed as a denial.
    const heldRequestId = (result as { requestId?: unknown }).requestId;
    if (
      (result.reasonCode === "APPROVAL_REQUIRED" ||
        result.reasonCode === "APPROVAL_PENDING") &&
      typeof heldRequestId === "string" &&
      heldRequestId.length > 0
    ) {
      return settle(
        ctx,
        toolName,
        input,
        {
          ok: true,
          requestId: heldRequestId,
          decision: "ASK",
          reasonCode: result.reasonCode,
        },
        runTool,
      );
    }
    return deny(options, toolName, result.reasonCode, undefined);
  }
  if (result.decision === "ALLOW" && result.capabilityToken) {
    const requestId = result.requestId;
    if (mode === "remote") {
      const executed = await options.client.execute({
        requestId,
        capabilityToken: result.capabilityToken,
      });
      if (!executed.ok) {
        throw new GuardianExecutionFailed({
          toolName,
          requestId,
          reasonCode: executed.reasonCode,
        });
      }
      await options.onReceipt?.({
        toolName,
        requestId,
        receipt: executed.receipt,
      });
      return {
        guardian: {
          decision: "ALLOW",
          requestId,
          toolName,
          receipt: executed.receipt,
        },
      };
    }
    // inProcess: the local impl runs only after an ALLOW
    // decision, but BEFORE the capability is redeemed. Redemption-time
    // checks (revocation, expiry, single use) therefore land after the
    // effect. This is decision-gated, not pre-execution enforcement; use
    // `remote` mode where Guardian must hold the effect itself.
    const output = await runTool();
    const executed = await options.client.execute({
      requestId,
      capabilityToken: result.capabilityToken,
    });
    if (!executed.ok) {
      throw new GuardianExecutionFailed({
        toolName,
        requestId,
        reasonCode: executed.reasonCode,
        localEffectRan: true,
      });
    }
    await options.onReceipt?.({
      toolName,
      requestId,
      receipt: executed.receipt,
    });
    return output;
  }
  if (result.decision === "ASK") {
    const resume = async () => {
      const claimed = await options.client.claim(result.requestId);
      let receipt: unknown;
      const output = await settle(
        {
          ...ctx,
          options: {
            ...options,
            onReceipt: async (event) => {
              receipt = event.receipt;
              await options.onReceipt?.(event);
            },
          },
        },
        toolName,
        input,
        claimed,
        runTool,
      );
      return { requestId: result.requestId, receipt, output };
    };
    if (options.onAsk === "result") {
      return {
        guardian: {
          decision: "ASK",
          requestId: result.requestId,
          toolName,
          message:
            `Held for human approval. After approval, claim requestId ` +
            `${result.requestId} and re-run the tool.`,
        },
      };
    }
    throw new GuardianApprovalPending(
      { requestId: result.requestId, toolName, input },
      resume,
    );
  }
  // DENY, or ALLOW with no capability — never run the tool either way.
  return deny(
    options,
    toolName,
    result.reasonCode ?? "MISSING_CAPABILITY",
    result.requestId,
  );
}

/** Ensure the record-transport entry (inProcess), propose, settle. */
export async function runThroughGuardian<Output>(
  ctx: GuardianContext,
  toolName: string,
  input: unknown,
  runTool: () => Output | PromiseLike<Output>,
): Promise<Output | GuardianDecisionResult> {
  const { options } = ctx;
  if (toolModeFor(options, toolName) === "inProcess") {
    const gate = await ensureRecordTransport(ctx, toolName, input, runTool);
    if (gate !== undefined) {
      return gate;
    }
  }
  const result = await options.client.request({
    action: "tool.invoke",
    connectionId: options.connectionId,
    toolName,
    arguments: toArgumentsRecord(input),
    ...(options.adapterId ? { adapterId: options.adapterId } : {}),
    purpose: resolvePurpose(options, toolName, input),
  });
  return settle(ctx, toolName, input, result, runTool);
}

/**
 * Options for `createGuard`. Same as the adapter options except the
 * default mode is `inProcess`: a guarded function is the developer's own
 * action code, so it runs only after ALLOW and its evidence is recorded.
 */
export type GuardOptions = GuardianAdapterOptions;

/** A guarded function: same input, resolves to the impl output (or a decision result in "result" mode). */
export type GuardedFunction<Input, Output> = (
  input: Input,
) => Promise<Output | GuardianDecisionResult>;

export type Guard = <Input, Output>(
  toolName: string,
  impl: (input: Input) => Output | PromiseLike<Output>,
) => GuardedFunction<Input, Output>;

/**
 * Put Guardian in front of any action code, from any agent
 * framework.
 *
 * ```ts
 * const guard = createGuard({ client, connectionId: "con_…" });
 * const payInvoice = guard("pay_invoice", async (inv: Invoice) => stripe.paymentIntents.create(…));
 * await payInvoice({ invoiceId: "inv_42", amountCents: 1_240_000, payee: "acme" });
 * // ALLOW → your code runs, receipt recorded. ASK → GuardianApprovalPending (resume() after approval).
 * // DENY → GuardianDenied; your code never runs.
 * ```
 *
 * In-process mode is decision-gated: your code runs after ALLOW and before
 * the capability is redeemed, so redemption-time revocation lands after the
 * effect (reported as `GuardianExecutionFailed` with `localEffectRan`). Use
 * `mode: "remote"` with a registered catalog tool where Guardian itself must
 * hold the effect.
 */
export function createGuard(options: GuardOptions): Guard {
  // Production denies first-use auto-registration unless the grant
  // pins mcp.install, so createGuard expects the tool to be registered once
  // in the console (record-only). Pass installRecordTransport: true to opt
  // back in.
  const ctx = createGuardianContext({
    ...options,
    mode: options.mode ?? "inProcess",
    installRecordTransport: options.installRecordTransport ?? false,
  });
  return <Input, Output>(
      toolName: string,
      impl: (input: Input) => Output | PromiseLike<Output>,
    ): GuardedFunction<Input, Output> =>
    (input: Input) =>
      runThroughGuardian<Output>(ctx, toolName, input, () => impl(input));
}

/** One-off form of `createGuard(options)(toolName, impl)`. */
export function guard<Input, Output>(
  options: GuardOptions,
  toolName: string,
  impl: (input: Input) => Output | PromiseLike<Output>,
): GuardedFunction<Input, Output> {
  return createGuard(options)(toolName, impl);
}
