// Generated file — do not edit.
import { randomBytes } from "node:crypto";

import { AgentActionProposalSchema } from "./proposal.js";
import {
  AgentExecutionRequestSchema,
  AgentExecutionReceiptSchema,
  McpEnableParametersV1Schema,
  McpInstallParametersV1Schema,
  ToolInvokeParametersV1Schema,
  type AgentExecutionReceipt,
  type McpEnableParametersV1,
  type McpInstallParametersV1,
  type ToolInvokeParametersV1,
} from "./contracts/index.js";

/**
 * developer SDK — a thin typed client over the Guardian agent REST
 * surface. External agents call this instead of hand-rolling envelopes: the
 * request, claim and execute calls produce the same canonical action
 * envelopes the gateway/kernel/capability path already governs.
 *
 * Published as `@odingard/guardian-sdk` (npm, Apache-2.0). For governed
 * execution of your own action code use `createGuard` (./guard.ts).
 */

export type GuardianClientConfig = Readonly<{
  /** Production: https://guardian-api.odingard.com */
  baseUrl: string;
  /** Agent credential (gac1.…). */
  credential: string;
  /** Adapter audience for executes; defaults to the tool adapter. */
  adapterId?: string;
  fetch?: typeof fetch;
}>;

export type GuardianToolInvocation = Readonly<{
  action: "tool.invoke";
  connectionId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  adapterId?: string;
  purpose?: string;
  /** Optional intent/plan provenance bound into the action. */
  intentId?: string;
  planId?: string;
  /**
   * Optional causal provenance: the recorded parent action
   * (request id) and/or the recorded effect (attempt id) this action
   * uses. Validated fail-closed against recorded evidence.
   */
  parentActionId?: string;
  sourceEffectId?: string;
}>;

export type GuardianMcpInvocation =
  | Readonly<{
      action: "mcp.install";
      connectionId: string;
      tool: McpInstallParametersV1["tool"];
      adapterId?: string;
      purpose?: string;
      intentId?: string;
      planId?: string;
      parentActionId?: string;
      sourceEffectId?: string;
    }>
  | Readonly<{
      action: "mcp.enable";
      connectionId: string;
      toolName: string;
      adapterId?: string;
      purpose?: string;
      intentId?: string;
      planId?: string;
      parentActionId?: string;
      sourceEffectId?: string;
    }>;

/**
 * Minimal passthrough for the data-lineage + agent-communication
 * actions. Callers supply the already-formed material parameters (the
 * corresponding *V1Schema validates server-side); the SDK forwards them
 * into the canonical proposal unchanged.
 */
export type GuardianGovernedInvocation = Readonly<{
  action:
    | "api.request"
    | "protected_data.derive"
    | "protected_data.transform"
    | "protected_data.export"
    | "agent.message"
    | "agent.share_context"
    | "agent.share_memory"
    | "agent.transfer_task"
    | "agent.transfer_capability";
  connectionId: string;
  materialParameters: Record<string, unknown>;
  /**
   * Money this action moves, in minor units (cents) of the account
   * currency. Bound into the action, so caps, "ask above" and approvals
   * apply to it.
   *
   * Guardian accepts it only when the action's definition derives the
   * same value from the action's parameters. For `api.request`, Guardian
   * derives it from the exact request for known money endpoints (Stripe
   * refunds, payouts, payments, charges, transfers): a money request must
   * declare exactly the amount in a form-encoded body
   * (`application/x-www-form-urlencoded`; any other content type is
   * refused), or it is refused (INVALID_REQUEST), and so is one whose
   * amount cannot be read unambiguously. A request that moves no
   * money must not declare it. Requires a Guardian deployment that
   * derives `api.request` amounts; older deployments refuse any declared
   * value on `api.request`.
   */
  valueCents?: number;
  /**
   * Merchant and category, checked against grant allowlists.
   * Not derived for `api.request` (the request names no merchant
   * unambiguously), so declaring them on an `api.request` is refused.
   */
  merchantId?: string;
  merchantCategory?: string;
  /** Whether this is a recurring payment (grant recurrence rules). */
  recurring?: boolean;
  adapterId?: string;
  purpose?: string;
  intentId?: string;
  planId?: string;
  parentActionId?: string;
  sourceEffectId?: string;
}>;

export type GuardianInvocation = (
  | GuardianToolInvocation
  | GuardianMcpInvocation
  | GuardianGovernedInvocation
) &
  Readonly<{
    /**
     * How long the request stays open, in ms (default 120000). An ASK that
     * no one approves within it expires. Whole number from 1 to
     * GUARDIAN_MAX_REQUEST_TTL_MS (the gateway's limit); anything else is
     * refused before a request is sent.
     */
    ttlMs?: number;
  }>;

/** Longest request window the gateway accepts (5 minutes). */
export const GUARDIAN_MAX_REQUEST_TTL_MS = 300_000;
export const GUARDIAN_DEFAULT_REQUEST_TTL_MS = 120_000;

export type GuardianRequestResult =
  | {
      ok: true;
      requestId: string;
      decision: "ALLOW" | "ASK" | "DENY";
      capabilityToken?: string;
      reasonCode?: string;
    }
  | {
      ok: false;
      reasonCode: string;
      /** The proposal's request id — needed to `claim` after an ASK. */
      requestId?: string;
    };

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The execution receipt, read leniently: fields a newer Guardian adds are
 * ignored instead of making a successful execute unreadable. Every field
 * this SDK reads is still checked.
 */
const LenientExecutionReceiptSchema =
  AgentExecutionReceiptSchema.strip().extend({
    delivered: AgentExecutionReceiptSchema.shape.delivered
      .unwrap()
      .strip()
      .optional(),
  });

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function randomId(prefix: "req" | "cor"): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

export interface GuardianClient {
  /**
   * Request a capability for a tool/MCP action. ALLOW returns a
   * capabilityToken immediately; ASK returns decision "ASK" and the human
   * approves out-of-band (then call `claim`); DENY refuses.
   */
  request(invocation: GuardianInvocation): Promise<GuardianRequestResult>;
  /** Collect a capability after human approval of a prior ASK. */
  claim(requestId: string): Promise<GuardianRequestResult>;
  /**
   * Execute a held capability; resolves to the execution receipt.
   *
   * `outcomeUnknown: true` on a failure means the execute call was sent but
   * no usable answer came back (the connection failed, Guardian answered
   * 5xx, or an `ok: true` answer could not be read). Guardian may have
   * redeemed the capability and performed the action: do not retry it as a
   * new request; look it up by requestId (`receipts`) first.
   */
  execute(input: {
    requestId: string;
    capabilityToken: string;
  }): Promise<
    | { ok: true; receipt: AgentExecutionReceipt }
    | { ok: false; reasonCode: string; outcomeUnknown?: boolean }
  >;
  /**
   * The signed portable authority receipt (`greceipt.v1`) for a
   * completed request. Verify it with `verifyReceiptOffline` (no Guardian
   * credential or service needed) or `verifyReceiptOnline`.
   */
  portableReceipt(
    requestId: string,
  ): Promise<
    { ok: true; receipt: unknown } | { ok: false; reasonCode: string }
  >;
  /** Machine-readable proof for a request. */
  receipts(
    requestId: string,
  ): Promise<
    | { ok: true; requestId: string; receipts: readonly unknown[] }
    | { ok: false; reasonCode: string }
  >;
}

function materialParametersFor(
  invocation: GuardianInvocation,
): Record<string, unknown> {
  if ("materialParameters" in invocation) {
    return invocation.materialParameters;
  }
  if (invocation.action === "tool.invoke") {
    const params: ToolInvokeParametersV1 = ToolInvokeParametersV1Schema.parse({
      schema: "odingard.guardian.tool.invoke.v1",
      connectionId: invocation.connectionId,
      toolName: invocation.toolName,
      arguments: invocation.arguments,
    });
    return { ...params };
  }
  if (invocation.action === "mcp.install") {
    const params: McpInstallParametersV1 = McpInstallParametersV1Schema.parse({
      schema: "odingard.guardian.mcp.install.v1",
      connectionId: invocation.connectionId,
      tool: invocation.tool,
    });
    return { ...params };
  }
  const params: McpEnableParametersV1 = McpEnableParametersV1Schema.parse({
    schema: "odingard.guardian.mcp.enable.v1",
    connectionId: invocation.connectionId,
    toolName: invocation.toolName,
  });
  return { ...params };
}

const RESOURCE_TYPE: Record<string, string> = {
  "tool.invoke": "tool:server",
  "mcp.install": "mcp:server",
  "mcp.enable": "mcp:server",
  "api.request": "api:endpoint",
  "protected_data.derive": "protected:data",
  "protected_data.transform": "protected:data",
  "protected_data.export": "protected:data",
  "agent.message": "guardian-agent",
  "agent.share_context": "guardian-agent",
  "agent.share_memory": "guardian-agent",
  "agent.transfer_task": "guardian-agent",
  "agent.transfer_capability": "guardian-agent",
};

const DEFAULT_ADAPTER: Record<string, string> = {
  "api.request": "adp_00000002",
  "tool.invoke": "adp_00000006",
  "mcp.install": "adp_00000006",
  "mcp.enable": "adp_00000006",
  "protected_data.derive": "adp_00000005",
  "protected_data.transform": "adp_00000005",
  "protected_data.export": "adp_00000005",
  "agent.message": "adp_00000007",
  "agent.share_context": "adp_00000007",
  "agent.share_memory": "adp_00000007",
  "agent.transfer_task": "adp_00000007",
  "agent.transfer_capability": "adp_00000007",
};

export function createGuardianClient(
  config: GuardianClientConfig,
): GuardianClient {
  const transport: FetchLike = config.fetch ?? fetch;
  const base = config.baseUrl.replace(/\/+$/, "");
  const call = async (
    path: string,
    body?: unknown,
    method: "GET" | "POST" = "POST",
  ) => {
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${config.credential}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    let response: Response;
    try {
      response = await transport(`${base}${path}`, init);
    } catch {
      // Fail closed: an unreachable Guardian is a refusal, never an allow.
      return {
        status: 0,
        body: { ok: false, reasonCode: "SERVICE_UNAVAILABLE" },
      };
    }
    const parsed = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    return { status: response.status, body: parsed };
  };

  const requestCapability = async (
    path: "/v1/agent/requests" | "/v1/agent/claims",
    body: unknown,
  ): Promise<GuardianRequestResult> => {
    const response = await call(path, body);
    const data = response.body;
    const requestId = (body as { requestId?: unknown }).requestId;
    if (!data || data.ok !== true) {
      return {
        ok: false,
        reasonCode:
          typeof data?.reasonCode === "string"
            ? data.reasonCode
            : typeof data?.code === "string"
              ? data.code
              : `HTTP_${response.status}`,
        ...(typeof requestId === "string" ? { requestId } : {}),
      };
    }
    const answeredRequestId =
      typeof data.requestId === "string"
        ? data.requestId
        : ((body as { requestId?: string }).requestId ?? "");
    const reasonCode =
      typeof data.reasonCode === "string" ? data.reasonCode : undefined;
    if (data.decision === "ASK" || data.decision === "DENY") {
      return {
        ok: true,
        requestId: answeredRequestId,
        decision: data.decision,
        ...(reasonCode === undefined ? {} : { reasonCode }),
      };
    }
    // An ALLOW needs a capability token. The hosted gateway answers an ALLOW
    // with `token` and no `decision`; `capabilityToken` and
    // `decision: "ALLOW"` are accepted too. Any other decision value, or no
    // token, is a malformed answer and fails closed as a denial.
    const capabilityToken =
      nonEmptyString(data.capabilityToken) ?? nonEmptyString(data.token);
    if (
      (data.decision === undefined || data.decision === "ALLOW") &&
      capabilityToken !== undefined
    ) {
      return {
        ok: true,
        requestId: answeredRequestId,
        decision: "ALLOW",
        capabilityToken,
        ...(reasonCode === undefined ? {} : { reasonCode }),
      };
    }
    return {
      ok: true,
      requestId: answeredRequestId,
      decision: "DENY",
      reasonCode: "MALFORMED_RESPONSE",
    };
  };

  return {
    request(invocation) {
      const ttlMs = invocation.ttlMs ?? GUARDIAN_DEFAULT_REQUEST_TTL_MS;
      if (
        !Number.isSafeInteger(ttlMs) ||
        ttlMs < 1 ||
        ttlMs > GUARDIAN_MAX_REQUEST_TTL_MS
      ) {
        throw new RangeError(
          `ttlMs must be a whole number from 1 to ${GUARDIAN_MAX_REQUEST_TTL_MS}`,
        );
      }
      const requestId = randomId("req");
      const proposal = AgentActionProposalSchema.parse({
        schemaVersion: 1,
        requestId,
        correlationId: randomId("cor"),
        action: invocation.action,
        resource: `${RESOURCE_TYPE[invocation.action]}:${invocation.connectionId}`,
        uses: 1,
        materialParameters: materialParametersFor(invocation),
        purpose: invocation.purpose ?? `Guardian ${invocation.action}`,
        initiatingContext: "agent",
        requestedAdapterId:
          invocation.adapterId ??
          DEFAULT_ADAPTER[invocation.action] ??
          "adp_00000006",
        requestedTtlMs: ttlMs,
        ...("valueCents" in invocation && invocation.valueCents !== undefined
          ? { valueCents: invocation.valueCents }
          : {}),
        ...("merchantId" in invocation && invocation.merchantId !== undefined
          ? { merchantId: invocation.merchantId }
          : {}),
        ...("merchantCategory" in invocation &&
        invocation.merchantCategory !== undefined
          ? { merchantCategory: invocation.merchantCategory }
          : {}),
        ...("recurring" in invocation && invocation.recurring !== undefined
          ? { recurring: invocation.recurring }
          : {}),
        ...(invocation.intentId !== undefined
          ? { intentId: invocation.intentId }
          : {}),
        ...(invocation.planId !== undefined
          ? { planId: invocation.planId }
          : {}),
        ...(invocation.parentActionId !== undefined
          ? { parentActionId: invocation.parentActionId }
          : {}),
        ...(invocation.sourceEffectId !== undefined
          ? { sourceEffectId: invocation.sourceEffectId }
          : {}),
      });
      return requestCapability("/v1/agent/requests", proposal);
    },

    claim(requestId) {
      return requestCapability("/v1/agent/claims", {
        schemaVersion: 1,
        requestId,
      });
    },

    async execute({ requestId, capabilityToken }) {
      const request = AgentExecutionRequestSchema.parse({
        schemaVersion: 1,
        requestId,
        capabilityToken,
      });
      const response = await call("/v1/agent/execute", request);
      const data = response.body;
      const receipt = LenientExecutionReceiptSchema.safeParse(data?.receipt);
      if (data?.ok === true && receipt.success) {
        return { ok: true, receipt: receipt.data as AgentExecutionReceipt };
      }
      const reasonCode =
        typeof data?.reasonCode === "string"
          ? data.reasonCode
          : typeof data?.code === "string"
            ? data.code
            : data?.ok === true
              ? "RECEIPT_UNREADABLE"
              : `HTTP_${response.status}`;
      // The execute was sent. Unless Guardian answered with a readable
      // refusal (a 4xx, or a 2xx `ok: false`), it may have performed the
      // action: no answer, a 5xx, an unreadable body, or an `ok: true`
      // whose receipt cannot be read.
      const definitiveRefusal =
        response.status >= 200 &&
        response.status < 500 &&
        data !== null &&
        data.ok === false;
      return {
        ok: false,
        reasonCode,
        ...(definitiveRefusal ? {} : { outcomeUnknown: true }),
      };
    },

    async portableReceipt(requestId) {
      const response = await call(
        `/v1/agent/receipts/${encodeURIComponent(requestId)}/portable`,
        undefined,
        "GET",
      );
      const data = response.body;
      if (!data || data.ok !== true || typeof data.receipt !== "object") {
        return {
          ok: false,
          reasonCode:
            typeof data?.reasonCode === "string"
              ? data.reasonCode
              : typeof data?.code === "string"
                ? data.code
                : `HTTP_${response.status}`,
        };
      }
      return { ok: true, receipt: data.receipt };
    },

    async receipts(requestId) {
      const response = await call(
        `/v1/agent/receipts/${encodeURIComponent(requestId)}`,
        undefined,
        "GET",
      );
      const data = response.body;
      if (!data || data.ok !== true || !Array.isArray(data.receipts)) {
        return {
          ok: false,
          reasonCode:
            typeof data?.code === "string"
              ? data.code
              : `HTTP_${response.status}`,
        };
      }
      return {
        ok: true,
        requestId: data.requestId as string,
        receipts: data.receipts as readonly unknown[],
      };
    },
  };
}
