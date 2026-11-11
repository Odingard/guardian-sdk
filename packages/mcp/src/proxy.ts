/**
 * Governed MCP proxy.
 *
 * Sits in front of any existing MCP server (WhatsApp, Stripe, Shopify, a
 * filesystem server …). The downstream MCP client sees the upstream tools
 * unchanged; every call is first decided by Guardian:
 *
 * - ALLOW → the call is forwarded to the upstream server, then the
 *   capability is redeemed and the evidence recorded (in-process mode).
 * - ASK   → nothing is forwarded. The exact tool name + arguments are held
 *   under the requestId; `guardian_claim` forwards exactly that call once a
 *   human has approved it.
 * - DENY  → nothing is forwarded, ever.
 *
 * This module is transport-free so it can be tested without spawning
 * processes; `index.ts` wires it to stdio on both sides.
 */
import {
  CONTENT_PIN_KEY,
  CONTENT_PIN_REMOTE_UPSTREAM,
  createGuardianContext,
  runThroughGuardian,
  settle,
  GuardianApprovalPending,
  GuardianDenied,
  GuardianExecutionFailed,
  GuardianRecordTransportRequired,
  type GuardianClient,
  type GuardianContext,
  type GuardianDecisionResult,
  type GuardianRequestResult,
  type FileArgsSpec,
} from "@odingard/guardian-sdk";

export type UpstreamTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  [key: string]: unknown;
};

export type UpstreamCallResult = {
  content?: unknown[];
  isError?: boolean;
  [key: string]: unknown;
};

/** Per-call options passed from the MCP request to the upstream. */
export type UpstreamCallOptions = Readonly<{
  /**
   * The agent's request was cancelled (or timed out). Checked right before
   * the call is sent; once it has been sent it runs to its real outcome.
   */
  signal?: AbortSignal;
}>;

/** The two upstream operations the proxy needs (an MCP Client satisfies this). */
export type Upstream = {
  listTools(): Promise<UpstreamTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: UpstreamCallOptions,
  ): Promise<UpstreamCallResult>;
};

export type GovernedProxyOptions = Readonly<{
  client: GuardianClient;
  connectionId: string;
  upstream: Upstream;
  adapterId?: string;
  agentName?: string;
  /**
   * Propose an `mcp.install` record-transport registration for each upstream
   * tool on first use (default false). Production denies it unless the
   * agent's grant pins mcp.install; register the tools in the console instead.
   * It only works for a tool with no entry yet: after a restart the proxy
   * cannot tell an entry it registered earlier from any other, so the call
   * is refused (RECORD_TRANSPORT_UNVERIFIED) and nothing is forwarded.
   */
  autoRegister?: boolean;
  /** Diagnostics sink (stderr in the CLI). Never receives credentials. */
  log?: (message: string) => void;
  /**
   * Declared file arguments, tool name → top-level argument names (CLI
   * `--pin-file <tool>:<arg>`). For each, the SDK reads the file the path
   * names, puts its SHA-256 in the proposed arguments (so the approval
   * binds it), and checks it again just before the call is forwarded; a
   * changed file is refused (`CONTENT_CHANGED_SINCE_APPROVAL`) and nothing
   * is forwarded. Mode is always "recheck": the upstream server opens the
   * path itself, so a short window remains between the check and its open.
   * Paths must be absolute. Allowed only for a stdio upstream (same machine,
   * same files).
   */
  pinFiles?: Readonly<Record<string, readonly string[]>>;
  /**
   * Where the upstream runs: "stdio" (a local process, the default) or
   * "remote" (Streamable HTTP / SSE). With "remote", `pinFiles` is refused
   * (`CONTENT_PIN_REMOTE_UPSTREAM`): the path names a file on another
   * machine.
   */
  upstreamTransport?: "stdio" | "remote";
}>;

/** A declared pin for a remote upstream: a configuration error at start. */
export class ContentPinConfigError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
  ) {
    super(message);
    this.name = "ContentPinConfigError";
  }
}

/** `pinFiles` as the SDK's `fileArgs`, every argument in "recheck" mode. */
export function pinFilesToFileArgs(
  pinFiles: GovernedProxyOptions["pinFiles"],
): Record<string, FileArgsSpec> {
  const fileArgs: Record<string, FileArgsSpec> = {};
  for (const [toolName, args] of Object.entries(pinFiles ?? {})) {
    if (args.length === 0) continue;
    fileArgs[toolName] = Object.fromEntries(
      args.map((arg) => [arg, "recheck" as const]),
    );
  }
  return fileArgs;
}

type ToolResult = {
  isError?: boolean;
  content: { type: string; text: string }[];
};

const CLAIM_TOOL = "guardian_claim";
const RECEIPT_TOOL = "guardian_receipt";

/**
 * `_meta` key under which an allowed call's result carries Guardian's
 * requestId (`{ requestId }`), so the client can fetch the receipt with
 * `guardian_receipt`. The upstream's `content` is left untouched.
 */
export const GUARDIAN_RESULT_META = "com.odingard/guardian";

/**
 * Guardian did not answer (network failure, outage). Fail closed, but never
 * word it as a decision: nothing was decided, so the agent may try later.
 */
const UNAVAILABLE = "SERVICE_UNAVAILABLE";

function unreachableResult(toolName: string, requestId?: string): ToolResult {
  return jsonResult(
    {
      decision: "DENY",
      toolName,
      reasonCode: UNAVAILABLE,
      ...(requestId ? { requestId } : {}),
      message: `Guardian could not be reached, so ${toolName} was not checked and nothing was forwarded. Try again later.`,
    },
    true,
  );
}

export const PROXY_GOVERNANCE_TOOLS: UpstreamTool[] = [
  {
    name: CLAIM_TOOL,
    description:
      "After a human approves a held (ASK) tool call, pass its requestId " +
      "here. Guardian issues the capability and the proxy forwards exactly " +
      "the held call — same tool, same arguments — then returns its result.",
    inputSchema: {
      type: "object",
      properties: { requestId: { type: "string" } },
      required: ["requestId"],
    },
  },
  {
    name: RECEIPT_TOOL,
    description:
      "Fetch the machine-readable evidence receipts for a request id.",
    inputSchema: {
      type: "object",
      properties: { requestId: { type: "string" } },
      required: ["requestId"],
    },
  },
];

function jsonResult(payload: unknown, isError = false): ToolResult {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

/** The upstream result, unchanged, plus Guardian's requestId in `_meta`. */
function withRequestId(
  result: UpstreamCallResult,
  requestId: string | undefined,
): UpstreamCallResult {
  if (!requestId) return result;
  const meta =
    typeof result._meta === "object" && result._meta !== null
      ? (result._meta as Record<string, unknown>)
      : {};
  return {
    ...result,
    _meta: { ...meta, [GUARDIAN_RESULT_META]: { requestId } },
  };
}

function isDecisionResult(value: unknown): value is GuardianDecisionResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "guardian" in value &&
    typeof (value as { guardian?: unknown }).guardian === "object"
  );
}

/**
 * The upstream call itself failed after Guardian allowed it (for a
 * remote upstream: a network error, a timeout, a dropped session). The
 * request may or may not have reached the server, so it is never reported as
 * "not forwarded"; the capability is not redeemed.
 */
export class UpstreamCallFailed extends Error {
  constructor(readonly toolName: string) {
    super("upstream call failed");
    this.name = "UpstreamCallFailed";
  }
}

/**
 * An upstream result is boxed under a private symbol before it goes
 * back through the SDK, so the proxy can tell "the upstream ran and returned
 * this" from "Guardian decided ASK/DENY". The symbol cannot be produced by an
 * upstream server (it does not survive JSON), so an upstream result that
 * carries a `guardian: {decision, requestId}` field is passed to the agent as
 * plain upstream output and is never read as a Guardian decision.
 */
const UPSTREAM_RESULT: unique symbol = Symbol("guardian-mcp.upstreamResult");
type UpstreamRan = { readonly [UPSTREAM_RESULT]: UpstreamCallResult };

function upstreamRan(value: unknown): value is UpstreamRan {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.prototype.hasOwnProperty.call(value, UPSTREAM_RESULT)
  );
}

/**
 * The agent's request was cancelled before the call was sent upstream.
 * Nothing was forwarded and the capability is not redeemed.
 */
export class UpstreamCallCancelled extends Error {
  constructor(readonly toolName: string) {
    super("the call was cancelled before it was forwarded");
    this.name = "UpstreamCallCancelled";
  }
}

/** Tools/list failed upstream; the message never carries upstream text. */
export class UpstreamListFailed extends Error {
  constructor() {
    super(
      "guardian-mcp: the upstream MCP server's tool list is unavailable; no tools are served.",
    );
    this.name = "UpstreamListFailed";
  }
}

/** Whether a call was handed to the upstream (set just before it is sent). */
type Forwarding = { sent: boolean };

/**
 * The approved copy the SDK hands `runTool`, without the reserved
 * content-pin key: what goes upstream is always what was approved, and
 * upstream servers never see the pins.
 */
function forwardable(approved: unknown): Record<string, unknown> {
  const record =
    approved !== null &&
    typeof approved === "object" &&
    !Array.isArray(approved)
      ? { ...(approved as Record<string, unknown>) }
      : {};
  delete record[CONTENT_PIN_KEY];
  return record;
}

function callUpstream(
  upstream: Upstream,
  name: string,
  signal: AbortSignal | undefined,
  forwarding: Forwarding,
): (approved: unknown) => Promise<UpstreamRan> {
  return async (approved) => {
    const args = forwardable(approved);
    if (signal?.aborted) {
      throw new UpstreamCallCancelled(name);
    }
    forwarding.sent = true;
    try {
      return {
        [UPSTREAM_RESULT]: await upstream.callTool(
          name,
          args,
          signal ? { signal } : undefined,
        ),
      };
    } catch (err) {
      if (err instanceof UpstreamCallCancelled) {
        forwarding.sent = false;
        throw err;
      }
      // The error text is dropped on purpose: transport errors can quote
      // the upstream URL or response.
      throw new UpstreamCallFailed(name);
    }
  };
}

function cancelledResult(toolName: string, requestId?: string): ToolResult {
  return jsonResult(
    {
      toolName,
      ...(requestId ? { requestId } : {}),
      cancelled: true,
      message: requestId
        ? `The request was cancelled before ${toolName} was forwarded. Nothing was forwarded; the approved call is still held, so call ${CLAIM_TOOL} with this requestId to forward it.`
        : `The request was cancelled before ${toolName} was forwarded. Nothing was forwarded.`,
    },
    true,
  );
}

function failure(
  err: unknown,
  toolName: string,
  forwarding: Forwarding,
): ToolResult {
  if (err instanceof UpstreamCallCancelled) {
    return cancelledResult(toolName);
  }
  if (err instanceof UpstreamCallFailed) {
    return jsonResult(
      {
        decision: "ALLOW",
        toolName,
        error:
          "Guardian allowed the call but the upstream MCP server did not return a result. It may or may not have run; check before retrying. The capability was not redeemed.",
      },
      true,
    );
  }
  if (
    err instanceof GuardianExecutionFailed &&
    !err.localEffectRan &&
    (err.reasonCode === "CONTENT_CHANGED_SINCE_APPROVAL" ||
      err.reasonCode.startsWith("CONTENT_PIN_"))
  ) {
    return jsonResult(
      {
        decision: "ALLOW",
        toolName,
        requestId: err.requestId,
        executionFailed: err.reasonCode,
        localEffectRan: false,
        message:
          err.reasonCode === "CONTENT_CHANGED_SINCE_APPROVAL"
            ? "A file named in the approved call changed since it was approved. Nothing was forwarded and the capability was not redeemed. Propose the call again; it needs a new approval."
            : "A file named in the approved call could not be checked against its approval. Nothing was forwarded and the capability was not redeemed.",
      },
      true,
    );
  }
  if (err instanceof GuardianExecutionFailed) {
    return jsonResult(
      {
        decision: "ALLOW",
        toolName,
        requestId: err.requestId,
        executionFailed: err.reasonCode,
        localEffectRan: err.localEffectRan,
        ...(err.outcomeUnknown ? { outcomeUnknown: true } : {}),
        message: err.outcomeUnknown
          ? err.localEffectRan
            ? `The upstream call ran, but Guardian could not confirm that it was recorded. Do not call it again; check this requestId with ${RECEIPT_TOOL}.`
            : `Guardian could not confirm whether the call completed. It may have run. Do not call it again; check this requestId with ${RECEIPT_TOOL}.`
          : err.localEffectRan
            ? "The upstream call ran but Guardian refused to redeem the capability. Do not call it again. Treat this as an incident, not a success."
            : "Guardian could not redeem the capability; the call was not completed.",
      },
      true,
    );
  }
  if (err instanceof GuardianDenied) {
    if (err.reasonCode === UNAVAILABLE) {
      return unreachableResult(toolName, err.requestId);
    }
    return jsonResult(
      {
        decision: "DENY",
        toolName,
        reasonCode: err.reasonCode,
        ...(err.requestId ? { requestId: err.requestId } : {}),
      },
      true,
    );
  }
  if (err instanceof GuardianRecordTransportRequired) {
    return jsonResult({ toolName, error: err.message }, true);
  }
  if (err instanceof GuardianApprovalPending) {
    return jsonResult({
      decision: "ASK",
      toolName,
      requestId: err.requestId,
      message: `Held for human approval. Call ${CLAIM_TOOL} with this requestId after approval.`,
    });
  }
  // An unexpected error after the call was handed to the upstream (for
  // example while its evidence was being recorded) must not say it was not
  // forwarded.
  return jsonResult(
    {
      toolName,
      error: forwarding.sent
        ? "Guardian proxy error after the call was forwarded. It may have run; check before retrying."
        : "Guardian proxy error; the call was not forwarded.",
    },
    true,
  );
}

export type GovernedProxy = {
  listTools(): Promise<UpstreamTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: UpstreamCallOptions,
  ): Promise<UpstreamCallResult | ToolResult>;
};

/** How many claimed requestIds the proxy remembers (oldest are forgotten). */
export const CLAIMED_REQUESTS_LIMIT = 1000;

export function createGovernedProxy(
  options: GovernedProxyOptions,
): GovernedProxy {
  const { upstream, log = () => {} } = options;
  const fileArgs = pinFilesToFileArgs(options.pinFiles);
  if (
    Object.keys(fileArgs).length > 0 &&
    options.upstreamTransport === "remote"
  ) {
    throw new ContentPinConfigError(
      CONTENT_PIN_REMOTE_UPSTREAM,
      "guardian-mcp proxy: --pin-file is supported only for a stdio upstream. " +
        "A remote (HTTP/SSE) MCP server opens paths on another machine, so the " +
        "proxy cannot check the file it will read.",
    );
  }

  // Track which requestIds belong to tool.invoke proposals vs the one-time
  // record-transport registration (mcp.install), so a claim can only ever
  // resume the call it was approved for.
  const toolInvokeRequestIds = new Set<string>();
  /**
   * Held ASK calls: the caller's arguments (for messages) and the input
   * that was proposed, with any content pins, which is what a claim settles.
   */
  const pendingCalls = new Map<
    string,
    { name: string; args: Record<string, unknown>; proposed: unknown }
  >();
  const pendingInstalls = new Map<string, string>();
  /**
   * Held calls whose capability was claimed, with the claim's result, kept
   * while the call is put back after a cancel before forwarding: the
   * approval was already used, so the next claim reuses it.
   */
  const claimedCapabilities = new Map<string, GuardianRequestResult>();
  /**
   * Claimed requestIds (bounded): "forwarding" while the call runs, then
   * "done" with the result returned. A second claim of the same id is told
   * the call was already forwarded (and gets that result again) instead of
   * "nothing was forwarded", which would invite proposing it again.
   */
  const claimedRequests = new Map<
    string,
    {
      toolName: string;
      state: "forwarding" | "done";
      result?: UpstreamCallResult | ToolResult;
    }
  >();
  const rememberClaim = (
    requestId: string,
    entry: {
      toolName: string;
      state: "forwarding" | "done";
      result?: UpstreamCallResult | ToolResult;
    },
  ) => {
    claimedRequests.delete(requestId);
    claimedRequests.set(requestId, entry);
    while (claimedRequests.size > CLAIMED_REQUESTS_LIMIT) {
      const oldest = claimedRequests.keys().next().value as string;
      claimedRequests.delete(oldest);
    }
  };

  const recordingClient: GuardianClient = {
    ...options.client,
    async request(invocation) {
      const result = await options.client.request(invocation);
      const requestId = (result as { requestId?: unknown }).requestId;
      if (
        invocation.action === "tool.invoke" &&
        typeof requestId === "string"
      ) {
        toolInvokeRequestIds.add(requestId);
      }
      return result;
    },
  };

  const ctx = createGuardianContext({
    client: recordingClient,
    connectionId: options.connectionId,
    mode: "inProcess",
    onAsk: "result",
    onDeny: "result",
    installRecordTransport: options.autoRegister ?? false,
    ...(options.adapterId ? { adapterId: options.adapterId } : {}),
    ...(options.agentName ? { agentName: options.agentName } : {}),
    ...(Object.keys(fileArgs).length > 0 ? { fileArgs } : {}),
  });
  // Shared by the per-call contexts below.
  ctx.installed ??= new Set();
  // The proposed (pinned) input of each held tool call, by requestId, so a
  // claim settles exactly what was proposed.
  ctx.proposedInputs = new Map();

  /** The registration step the SDK holds under this requestId, if any. */
  function heldSetupStep(
    toolName: string,
    requestId: string,
  ): "install" | "enable" | undefined {
    const held = ctx.heldSetup?.get(`${options.connectionId}:${toolName}`);
    return held?.requestId === requestId ? held.step : undefined;
  }

  /** A context for one call that remembers the requestId Guardian allowed. */
  function tracked(): {
    ctx: GuardianContext;
    allowedRequestId: () => string | undefined;
  } {
    let allowed: string | undefined;
    return {
      ctx: {
        ...ctx,
        options: {
          ...ctx.options,
          onReceipt: (event) => {
            allowed = event.requestId;
          },
        },
      },
      allowedRequestId: () => allowed,
    };
  }

  let upstreamTools: Map<string, UpstreamTool> | null = null;

  async function loadTools(): Promise<Map<string, UpstreamTool>> {
    if (upstreamTools) return upstreamTools;
    const tools = new Map<string, UpstreamTool>();
    for (const tool of await upstream.listTools()) {
      if (tool.name === CLAIM_TOOL || tool.name === RECEIPT_TOOL) {
        log(
          `guardian-mcp proxy: upstream tool "${tool.name}" collides with a Guardian tool name and is hidden`,
        );
        continue;
      }
      tools.set(tool.name, tool);
    }
    upstreamTools = tools;
    return tools;
  }

  function toCallResult(
    toolName: string,
    args: Record<string, unknown>,
    output: UpstreamRan | GuardianDecisionResult,
    allowedRequestId?: string,
  ): UpstreamCallResult | ToolResult {
    // The upstream ran: its content is returned verbatim, whatever it
    // contains; only Guardian's requestId is added under `_meta`.
    if (upstreamRan(output)) {
      return withRequestId(output[UPSTREAM_RESULT], allowedRequestId);
    }
    // Anything else must be the SDK's own decision; if not, fail closed.
    if (!isDecisionResult(output)) {
      return jsonResult(
        {
          toolName,
          error: "Guardian proxy error; the call was not forwarded.",
        },
        true,
      );
    }
    const g = output.guardian;
    if (g.decision === "ASK") {
      if (toolInvokeRequestIds.has(g.requestId)) {
        // Without a stored proposed input the pin-free args are settled,
        // and a tool with declared pins is then refused
        // (CONTENT_PIN_MISSING), never forwarded unpinned.
        const proposed = ctx.proposedInputs?.get(g.requestId) ?? args;
        ctx.proposedInputs?.delete(g.requestId);
        pendingCalls.set(g.requestId, { name: toolName, args, proposed });
        return jsonResult({
          decision: "ASK",
          toolName,
          requestId: g.requestId,
          message: `Held for human approval. Nothing was sent. After approval call ${CLAIM_TOOL} with this requestId.`,
        });
      }
      pendingInstalls.set(g.requestId, toolName);
      const step = heldSetupStep(toolName, g.requestId);
      return jsonResult({
        decision: "ASK",
        toolName,
        requestId: g.requestId,
        message:
          step === "enable"
            ? `Switching on ${toolName} for this agent needs a human to approve it in Guardian. After approval call ${CLAIM_TOOL} with this requestId (or retry the original call).`
            : `First use of ${toolName} needs a human to approve registering it with Guardian. After approval call ${CLAIM_TOOL} with this requestId, then retry the original call.`,
      });
    }
    if (g.decision === "DENY") {
      if (g.reasonCode === UNAVAILABLE) {
        return unreachableResult(toolName, g.requestId);
      }
      // A refusal is reported as a tool error (MCP `isError`), so the
      // client and the model see that the call did not happen.
      return jsonResult(
        {
          decision: "DENY",
          toolName,
          reasonCode: g.reasonCode,
          ...(g.requestId ? { requestId: g.requestId } : {}),
          message: g.message,
        },
        true,
      );
    }
    return jsonResult({ decision: "ALLOW", toolName, requestId: g.requestId });
  }

  function alreadyClaimed(
    requestId: string,
  ): ToolResult | UpstreamCallResult | undefined {
    const seen = claimedRequests.get(requestId);
    if (!seen) return undefined;
    if (seen.state === "forwarding" || !seen.result) {
      return jsonResult(
        {
          toolName: seen.toolName,
          requestId,
          alreadyClaimed: true,
          message: `This approved call is already being forwarded by an earlier ${CLAIM_TOOL}. Do not propose ${seen.toolName} again; wait, then call ${RECEIPT_TOOL} with this requestId to see what happened.`,
        },
        true,
      );
    }
    // Hand back the result the earlier claim returned, with a notice first.
    const notice = {
      type: "text",
      text: `This requestId was already claimed and ${seen.toolName} was already forwarded. Do not propose it again. The earlier result follows.`,
    };
    const earlier = seen.result as UpstreamCallResult;
    // isError: this claim did nothing; the earlier claim did the work.
    return {
      ...earlier,
      isError: true,
      content: [
        notice,
        ...(Array.isArray(earlier.content) ? earlier.content : []),
      ],
    };
  }

  async function claim(
    requestId: string,
    signal?: AbortSignal,
  ): Promise<UpstreamCallResult | ToolResult> {
    const repeat = alreadyClaimed(requestId);
    if (repeat) return repeat;
    const held = pendingCalls.get(requestId);
    if (held) {
      if (signal?.aborted) {
        return cancelledResult(held.name, requestId);
      }
      // Taken out before the await, so two concurrent claims for one
      // requestId cannot both forward the call; put back only while it is
      // still held.
      pendingCalls.delete(requestId);
      const putBack = () => {
        claimedRequests.delete(requestId);
        pendingCalls.set(requestId, held);
      };
      rememberClaim(requestId, { toolName: held.name, state: "forwarding" });
      let claimed: GuardianRequestResult;
      const reused = claimedCapabilities.get(requestId);
      if (reused) {
        // An earlier claim got the capability but was cancelled before
        // forwarding: use that approval, do not claim it again.
        claimedCapabilities.delete(requestId);
        claimed = reused;
      } else {
        try {
          claimed = await options.client.claim(requestId);
        } catch {
          putBack();
          return unreachableResult(held.name, requestId);
        }
      }
      // Guardian did not answer: keep the call held so the claim can be
      // retried, forward nothing.
      if (!claimed.ok && claimed.reasonCode === UNAVAILABLE) {
        putBack();
        return unreachableResult(held.name, requestId);
      }
      // Still waiting for the human: keep it held, forward nothing.
      if (
        (claimed.ok && claimed.decision === "ASK") ||
        (!claimed.ok &&
          (claimed.reasonCode === "APPROVAL_PENDING" ||
            claimed.reasonCode === "APPROVAL_REQUIRED"))
      ) {
        putBack();
        return jsonResult({
          decision: "ASK",
          toolName: held.name,
          requestId,
          message: "Still awaiting human approval. Nothing was sent.",
        });
      }
      let result: UpstreamCallResult | ToolResult;
      const forwarding: Forwarding = { sent: false };
      try {
        const call = tracked();
        // The proposed input: the content pins are checked again here.
        const output = await settle<UpstreamRan>(
          call.ctx,
          held.name,
          held.proposed,
          claimed,
          callUpstream(upstream, held.name, signal, forwarding),
        );
        result = toCallResult(
          held.name,
          held.args,
          output,
          call.allowedRequestId(),
        );
      } catch (err) {
        if (err instanceof UpstreamCallCancelled) {
          // Cancelled before forwarding: nothing was sent and nothing was
          // redeemed. Keep the call held, with the approval already claimed.
          putBack();
          if (claimed.ok && claimed.decision === "ALLOW") {
            claimedCapabilities.set(requestId, claimed);
          }
          return cancelledResult(held.name, requestId);
        }
        result = failure(err, held.name, forwarding);
      }
      if (
        !claimed.ok ||
        claimed.decision !== "ALLOW" ||
        !claimed.capabilityToken
      ) {
        // Refused: nothing was forwarded, so a later claim is not told
        // it was.
        claimedRequests.delete(requestId);
      } else {
        rememberClaim(requestId, {
          toolName: held.name,
          state: "done",
          result,
        });
      }
      return result;
    }
    const installFor = pendingInstalls.get(requestId);
    if (installFor) {
      if (signal?.aborted) {
        return jsonResult(
          {
            toolName: installFor,
            requestId,
            cancelled: true,
            message: `The request was cancelled. Nothing was claimed; call ${CLAIM_TOOL} with this requestId again.`,
          },
          true,
        );
      }
      const key = `${options.connectionId}:${installFor}`;
      // Which registration step this is (mcp.install or mcp.enable). A
      // request the SDK no longer holds is treated as an install, so the
      // retry runs the enable step again rather than skipping it.
      const step = heldSetupStep(installFor, requestId) ?? "install";
      // This claim uses the approval; a retry must not claim it again.
      const forgetHeld = () => {
        if (ctx.heldSetup?.get(key)?.requestId === requestId) {
          ctx.heldSetup.delete(key);
        }
      };
      let claimed: GuardianRequestResult;
      try {
        claimed = await options.client.claim(requestId);
      } catch {
        return unreachableResult(installFor, requestId);
      }
      if (!claimed.ok && claimed.reasonCode === UNAVAILABLE) {
        return unreachableResult(installFor, requestId);
      }
      if (
        claimed.ok &&
        claimed.decision === "ALLOW" &&
        claimed.capabilityToken
      ) {
        forgetHeld();
        pendingInstalls.delete(requestId);
        const executed = await options.client.execute({
          requestId: claimed.requestId,
          capabilityToken: claimed.capabilityToken,
        });
        // Only a done mcp.enable completes setup. After an install, the
        // retry still proposes mcp.enable: a fresh entry is not yet on for
        // this agent. The entry this proxy installed is record-only, so the
        // retry goes straight to mcp.enable (a second mcp.install would be
        // answered "already installed" and refused).
        if (executed.ok && step === "enable") {
          ctx.ensured.add(key);
        } else if (executed.ok) {
          ctx.installed?.add(key);
        }
        return jsonResult(
          executed.ok
            ? {
                decision: "ALLOW",
                toolName: installFor,
                message:
                  step === "enable"
                    ? `${installFor} is switched on for this agent. Retry the original call.`
                    : `${installFor} is registered with Guardian. Retry the original call; switching it on for this agent may need one more approval.`,
              }
            : { toolName: installFor, executionFailed: executed.reasonCode },
          !executed.ok,
        );
      }
      if (
        (claimed.ok && claimed.decision === "ASK") ||
        (!claimed.ok &&
          (claimed.reasonCode === "APPROVAL_PENDING" ||
            claimed.reasonCode === "APPROVAL_REQUIRED"))
      ) {
        return jsonResult({
          decision: "ASK",
          toolName: installFor,
          requestId,
          message: "Still awaiting human approval.",
        });
      }
      forgetHeld();
      pendingInstalls.delete(requestId);
      return jsonResult(
        {
          decision: "DENY",
          toolName: installFor,
          reasonCode: claimed.ok
            ? (claimed.reasonCode ?? "MISSING_CAPABILITY")
            : claimed.reasonCode,
        },
        true,
      );
    }
    return jsonResult(
      {
        requestId,
        error:
          "This proxy holds no call with this requestId, so this claim forwarded nothing. " +
          `If it was claimed before (in this or an earlier proxy session), the call may already have been forwarded: call ${RECEIPT_TOOL} with this requestId before proposing it again.`,
      },
      true,
    );
  }

  return {
    async listTools() {
      let tools: Map<string, UpstreamTool>;
      try {
        tools = await loadTools();
      } catch {
        // The upstream's error can quote its URL, response body or headers
        // (API keys); none of it reaches the agent or the log.
        log(
          "guardian-mcp proxy: the upstream MCP server's tool list is unavailable",
        );
        throw new UpstreamListFailed();
      }
      return [
        ...[...tools.values()].map((tool) => ({
          ...tool,
          description:
            `[Guardian-governed: every call is decided ALLOW/ASK/DENY before it runs] ` +
            (tool.description ?? ""),
        })),
        ...PROXY_GOVERNANCE_TOOLS,
      ];
    },

    async callTool(name, args, callOptions) {
      const signal = callOptions?.signal;
      if (name === CLAIM_TOOL) {
        const requestId = args.requestId;
        if (typeof requestId !== "string" || requestId.length === 0) {
          return jsonResult({ error: "requestId is required" }, true);
        }
        return claim(requestId, signal);
      }
      if (name === RECEIPT_TOOL) {
        const requestId = args.requestId;
        if (typeof requestId !== "string" || requestId.length === 0) {
          return jsonResult({ error: "requestId is required" }, true);
        }
        const result = await options.client.receipts(requestId);
        return jsonResult(
          result.ok
            ? { requestId, receipts: result.receipts }
            : { ok: false, reasonCode: result.reasonCode },
          !result.ok,
        );
      }
      let tools: Map<string, UpstreamTool>;
      try {
        tools = await loadTools();
      } catch {
        return jsonResult(
          {
            toolName: name,
            error:
              "The upstream MCP server's tool list is unavailable; nothing was forwarded.",
          },
          true,
        );
      }
      if (!tools.has(name)) {
        return jsonResult({ error: `unknown tool: ${name}` }, true);
      }
      if (signal?.aborted) {
        return cancelledResult(name);
      }
      const forwarding: Forwarding = { sent: false };
      try {
        const call = tracked();
        const output = await runThroughGuardian<UpstreamRan>(
          call.ctx,
          name,
          args,
          callUpstream(upstream, name, signal, forwarding),
        );
        return toCallResult(name, args, output, call.allowedRequestId());
      } catch (err) {
        return failure(err, name, forwarding);
      }
    },
  };
}
