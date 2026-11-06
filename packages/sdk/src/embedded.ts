// Generated file — do not edit.
/**
 * Embedded approval primitives for partner apps (extends the developer
 * SDK). A partner embeds Guardian authority by driving the human's approval
 * surface through this client; the calls hit `/v1/embedded/approvals`, which
 * runs the identical approval-service methods as the first-party route, so
 * the decision semantics, receipts and evidence are identical.
 *
 * The partner supplies the human's own Guardian session token — the partner
 * never handles agent credentials and cannot widen what the human may see or
 * decide.
 */

export type EmbeddedApprovalConfig = Readonly<{
  /** e.g. https://guardian-api-staging.odingard.com */
  baseUrl: string;
  /** The human's Guardian session token presented through the partner app. */
  sessionToken: string;
  fetch?: typeof fetch;
}>;

export type EmbeddedApprovalSummary = Readonly<{
  approvalId: string;
  state: string;
  version: number;
  headline: string;
  expiresAtEpochMs: number;
}>;

export type EmbeddedApprovalView = Readonly<{
  display: unknown;
  challenge: unknown | null;
}>;

export type EmbeddedDecisionResult = Readonly<{
  receipt: unknown;
  changed: boolean;
}>;

export type EmbeddedResult<T> =
  | { ok: true; value: T }
  | { ok: false; reasonCode: string };

/** Agent credential shapes the SDK must never present as a human session. */
const AGENT_CREDENTIAL_PREFIXES = ["gak_", "gac1.", "gcap."] as const;

export function isHumanSessionToken(token: unknown): token is string {
  if (typeof token !== "string") return false;
  const trimmed = token.trim();
  if (trimmed.length < 16 || trimmed !== token) return false;
  return !AGENT_CREDENTIAL_PREFIXES.some((prefix) =>
    trimmed.startsWith(prefix),
  );
}

async function call<T>(
  config: EmbeddedApprovalConfig,
  path: string,
  init: RequestInit,
): Promise<EmbeddedResult<T>> {
  // Embedded approval is a human act. An agent credential (or no
  // credential) is refused locally before any request leaves the SDK; the
  // server independently accepts only human sessions on these routes.
  if (!isHumanSessionToken(config.sessionToken)) {
    return { ok: false, reasonCode: "HUMAN_SESSION_REQUIRED" };
  }
  const transport = config.fetch ?? fetch;
  let response: Response;
  try {
    response = await transport(new URL(path, config.baseUrl), {
      ...init,
      headers: {
        authorization: `Bearer ${config.sessionToken}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch {
    return { ok: false, reasonCode: "SERVICE_UNAVAILABLE" };
  }
  let body: { ok?: boolean; reasonCode?: string } & Record<string, unknown>;
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return { ok: false, reasonCode: "SERVICE_UNAVAILABLE" };
  }
  if (!response.ok || body.ok !== true) {
    return { ok: false, reasonCode: body.reasonCode ?? "SERVICE_UNAVAILABLE" };
  }
  const { ok: ignored, ...value } = body;
  void ignored;
  return { ok: true, value: value as T };
}

export function createEmbeddedApprovalClient(config: EmbeddedApprovalConfig) {
  const base = config.baseUrl.replace(/\/$/, "");
  return {
    listApprovals(): Promise<
      EmbeddedResult<{ approvals: readonly EmbeddedApprovalSummary[] }>
    > {
      return call(config, `${base}/v1/embedded/approvals`, { method: "GET" });
    },
    viewApproval(
      approvalId: string,
    ): Promise<EmbeddedResult<EmbeddedApprovalView>> {
      return call(
        config,
        `${base}/v1/embedded/approvals/${encodeURIComponent(approvalId)}`,
        { method: "GET" },
      );
    },
    decideApproval(
      approvalId: string,
      input: {
        expectedVersion: number;
        decision: "approve" | "deny";
        presentationDigest: string;
        /** step-up factor: tap (default), passkey, biometric, second-device. */
        factor?: "tap" | "passkey" | "biometric" | "second-device";
      },
    ): Promise<EmbeddedResult<EmbeddedDecisionResult>> {
      return call(
        config,
        `${base}/v1/embedded/approvals/${encodeURIComponent(approvalId)}/decision`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    revokeApproval(
      approvalId: string,
      input: { expectedVersion: number },
    ): Promise<EmbeddedResult<EmbeddedDecisionResult>> {
      return call(
        config,
        `${base}/v1/embedded/approvals/${encodeURIComponent(approvalId)}/revocation`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
  };
}

export type EmbeddedApprovalClient = ReturnType<
  typeof createEmbeddedApprovalClient
>;
