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
  createGuardianContext,
  runThroughGuardian,
  settle,
  GuardianApprovalPending,
  GuardianDenied,
  GuardianExecutionFailed,
  GuardianRecordTransportRequired,
  type GuardianClient,
  type GuardianDecisionResult,
  type GuardianRequestResult,
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

/** The two upstream operations the proxy needs (an MCP Client satisfies this). */
export type Upstream = {
  listTools(): Promise<UpstreamTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
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
   */
  autoRegister?: boolean;
  /** Diagnostics sink (stderr in the CLI). Never receives credentials. */
  log?: (message: string) => void;
}>;

type ToolResult = {
  isError?: boolean;
  content: { type: string; text: string }[];
};

const CLAIM_TOOL = "guardian_claim";
const RECEIPT_TOOL = "guardian_receipt";

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

/** Tools/list failed upstream; the message never carries upstream text. */
export class UpstreamListFailed extends Error {
  constructor() {
    super(
      "guardian-mcp: the upstream MCP server's tool list is unavailable; no tools are served.",
    );
    this.name = "UpstreamListFailed";
  }
}

function callUpstream(
  upstream: Upstream,
  name: string,
  args: Record<string, unknown>,
): () => Promise<UpstreamRan> {
  return async () => {
    try {
      return { [UPSTREAM_RESULT]: await upstream.callTool(name, args) };
    } catch {
      // The error text is dropped on purpose: transport errors can quote
      // the upstream URL or response.
      throw new UpstreamCallFailed(name);
    }
  };
}

function failure(err: unknown, toolName: string): ToolResult {
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
  if (err instanceof GuardianExecutionFailed) {
    return jsonResult(
      {
        decision: "ALLOW",
        toolName,
        requestId: err.requestId,
        executionFailed: err.reasonCode,
        localEffectRan: err.localEffectRan,
        message: err.localEffectRan
          ? "The upstream call ran but Guardian refused to redeem the capability. Treat this as an incident, not a success."
          : "Guardian could not redeem the capability; the call was not completed.",
      },
      true,
    );
  }
  if (err instanceof GuardianDenied) {
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
  return jsonResult(
    {
      toolName,
      error: "Guardian proxy error; the call was not forwarded.",
    },
    true,
  );
}

export type GovernedProxy = {
  listTools(): Promise<UpstreamTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<UpstreamCallResult | ToolResult>;
};

export function createGovernedProxy(
  options: GovernedProxyOptions,
): GovernedProxy {
  const { upstream, log = () => {} } = options;

  // Track which requestIds belong to tool.invoke proposals vs the one-time
  // record-transport registration (mcp.install), so a claim can only ever
  // resume the call it was approved for.
  const toolInvokeRequestIds = new Set<string>();
  const pendingCalls = new Map<
    string,
    { name: string; args: Record<string, unknown> }
  >();
  const pendingInstalls = new Map<string, string>();

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
  });

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
  ): UpstreamCallResult | ToolResult {
    // The upstream ran: its result is returned verbatim, whatever it contains.
    if (upstreamRan(output)) return output[UPSTREAM_RESULT];
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
        pendingCalls.set(g.requestId, { name: toolName, args });
        return jsonResult({
          decision: "ASK",
          toolName,
          requestId: g.requestId,
          message: `Held for human approval. Nothing was sent. After approval call ${CLAIM_TOOL} with this requestId.`,
        });
      }
      pendingInstalls.set(g.requestId, toolName);
      return jsonResult({
        decision: "ASK",
        toolName,
        requestId: g.requestId,
        message: `First use of ${toolName} needs a human to approve registering it with Guardian. After approval call ${CLAIM_TOOL} with this requestId, then retry the original call.`,
      });
    }
    if (g.decision === "DENY") {
      return jsonResult({
        decision: "DENY",
        toolName,
        reasonCode: g.reasonCode,
        ...(g.requestId ? { requestId: g.requestId } : {}),
        message: g.message,
      });
    }
    return jsonResult({ decision: "ALLOW", toolName, requestId: g.requestId });
  }

  async function claim(
    requestId: string,
  ): Promise<UpstreamCallResult | ToolResult> {
    const held = pendingCalls.get(requestId);
    if (held) {
      // Taken out before the await, so two concurrent claims for one
      // requestId cannot both forward the call; put back only while it is
      // still held.
      pendingCalls.delete(requestId);
      let claimed: GuardianRequestResult;
      try {
        claimed = await options.client.claim(requestId);
      } catch {
        pendingCalls.set(requestId, held);
        return jsonResult(
          { requestId, error: "Guardian unreachable; nothing was forwarded." },
          true,
        );
      }
      // Still waiting for the human: keep it held, forward nothing.
      if (
        (claimed.ok && claimed.decision === "ASK") ||
        (!claimed.ok &&
          (claimed.reasonCode === "APPROVAL_PENDING" ||
            claimed.reasonCode === "APPROVAL_REQUIRED"))
      ) {
        pendingCalls.set(requestId, held);
        return jsonResult({
          decision: "ASK",
          toolName: held.name,
          requestId,
          message: "Still awaiting human approval. Nothing was sent.",
        });
      }
      try {
        const output = await settle<UpstreamRan>(
          ctx,
          held.name,
          held.args,
          claimed,
          callUpstream(upstream, held.name, held.args),
        );
        return toCallResult(held.name, held.args, output);
      } catch (err) {
        return failure(err, held.name);
      }
    }
    const installFor = pendingInstalls.get(requestId);
    if (installFor) {
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
        pendingInstalls.delete(requestId);
        ctx.ensured.add(`${options.connectionId}:${installFor}`);
        return jsonResult(
          executed.ok
            ? {
                decision: "ALLOW",
                toolName: installFor,
                message: `${installFor} is registered with Guardian. Retry the original call.`,
              }
            : { toolName: installFor, executionFailed: executed.reasonCode },
          !executed.ok,
        );
      }
      if (claimed.ok && claimed.decision === "ASK") {
        return jsonResult({
          decision: "ASK",
          toolName: installFor,
          requestId,
          message: "Still awaiting human approval.",
        });
      }
      pendingInstalls.delete(requestId);
      return jsonResult({
        decision: "DENY",
        toolName: installFor,
        reasonCode: claimed.ok
          ? (claimed.reasonCode ?? "MISSING_CAPABILITY")
          : claimed.reasonCode,
      });
    }
    return jsonResult(
      {
        requestId,
        error:
          "No held call with this requestId in this proxy session. Nothing was forwarded.",
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

    async callTool(name, args) {
      if (name === CLAIM_TOOL) {
        const requestId = args.requestId;
        if (typeof requestId !== "string" || requestId.length === 0) {
          return jsonResult({ error: "requestId is required" }, true);
        }
        return claim(requestId);
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
      try {
        const output = await runThroughGuardian<UpstreamRan>(
          ctx,
          name,
          args,
          callUpstream(upstream, name, args),
        );
        return toCallResult(name, args, output);
      } catch (err) {
        return failure(err, name);
      }
    },
  };
}
