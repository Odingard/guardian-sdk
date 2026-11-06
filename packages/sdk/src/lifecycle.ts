// Generated file — do not edit.
import type { GuardianRequestResult } from "./client.js";

/**
 * The single, fail-closed reading of a Guardian request result.
 *
 *   ALLOW — a capability token was issued; `execute` redeems it.
 *   ASK   — held for a human; keep `requestId`, then `claim(requestId)`
 *           after the human decides. The gateway reports a held ASK as
 *           `{ ok: false, reasonCode: "APPROVAL_REQUIRED", requestId }`.
 *   DENY  — everything else, including ambiguity (ALLOW without a token),
 *           an unknown shape, or Guardian being unreachable.
 */
export type GuardianDecision =
  | { decision: "ALLOW"; requestId: string; capabilityToken: string }
  | { decision: "ASK"; requestId: string; reasonCode: string }
  | { decision: "DENY"; reasonCode: string; requestId?: string };

export function classifyRequestResult(
  result: GuardianRequestResult,
): GuardianDecision {
  if (result.ok) {
    if (result.decision === "ALLOW") {
      if (
        typeof result.capabilityToken === "string" &&
        result.capabilityToken
      ) {
        return {
          decision: "ALLOW",
          requestId: result.requestId,
          capabilityToken: result.capabilityToken,
        };
      }
      return {
        decision: "DENY",
        reasonCode: "CAPABILITY_MISSING",
        requestId: result.requestId,
      };
    }
    if (result.decision === "ASK" && result.requestId) {
      return {
        decision: "ASK",
        requestId: result.requestId,
        reasonCode: result.reasonCode ?? "APPROVAL_REQUIRED",
      };
    }
    return {
      decision: "DENY",
      reasonCode: result.reasonCode ?? "DENIED",
      requestId: result.requestId,
    };
  }
  if (result.reasonCode === "APPROVAL_REQUIRED" && result.requestId) {
    return {
      decision: "ASK",
      requestId: result.requestId,
      reasonCode: result.reasonCode,
    };
  }
  return {
    decision: "DENY",
    reasonCode: result.reasonCode,
    ...(result.requestId ? { requestId: result.requestId } : {}),
  };
}
