/**
 * The test action of `guardian init`: one governed call of the tool
 * `guardian_setup_test`, which does nothing. It goes through Guardian like
 * any other action: allowed and recorded, held for the person and then
 * recorded once they approve, or refused. Nothing else is sent.
 */
import type { GuardianClient } from "@odingard/guardian-sdk";

export const SETUP_TEST_TOOL = "guardian_setup_test";

export type SetupTestOutcome =
  | { kind: "allowed"; requestId: string }
  | { kind: "approved"; requestId: string }
  | { kind: "denied"; requestId?: string; reasonCode: string }
  | { kind: "refused"; requestId?: string; reasonCode: string }
  | { kind: "expired"; requestId: string; reasonCode: string };

const HELD = new Set(["APPROVAL_REQUIRED", "APPROVAL_PENDING"]);

export async function runSetupTest(input: {
  client: GuardianClient;
  connectionId: string;
  onWaiting(requestId: string): void;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  waitMs?: number;
  now?: () => number;
}): Promise<SetupTestOutcome> {
  const sleep =
    input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = input.now ?? Date.now;
  const pollMs = input.pollMs ?? 3_000;
  const waitMs = input.waitMs ?? 300_000;
  const requested = await input.client.request({
    action: "tool.invoke",
    connectionId: input.connectionId,
    toolName: SETUP_TEST_TOOL,
    arguments: {},
    purpose: "Guardian setup test",
    ttlMs: 300_000,
  });
  const record = async (
    requestId: string,
    capabilityToken: string,
    kind: "allowed" | "approved",
  ): Promise<SetupTestOutcome> => {
    const executed = await input.client.execute({ requestId, capabilityToken });
    return executed.ok
      ? { kind, requestId }
      : { kind: "refused", requestId, reasonCode: executed.reasonCode };
  };
  if (requested.ok && requested.decision === "ALLOW") {
    return requested.capabilityToken
      ? record(requested.requestId, requested.capabilityToken, "allowed")
      : {
          kind: "refused",
          requestId: requested.requestId,
          reasonCode: "MISSING_CAPABILITY",
        };
  }
  if (requested.ok && requested.decision === "DENY") {
    return {
      kind: "denied",
      requestId: requested.requestId,
      reasonCode: requested.reasonCode ?? "DENIED",
    };
  }
  const heldId =
    requested.ok && requested.decision === "ASK"
      ? requested.requestId
      : !requested.ok && HELD.has(requested.reasonCode)
        ? requested.requestId
        : undefined;
  if (heldId === undefined) {
    return {
      kind: "refused",
      ...(requested.ok || requested.requestId === undefined
        ? {}
        : { requestId: requested.requestId }),
      reasonCode: requested.ok
        ? (requested.reasonCode ?? "MALFORMED_RESPONSE")
        : requested.reasonCode,
    };
  }
  input.onWaiting(heldId);
  const deadline = now() + waitMs;
  while (now() < deadline) {
    await sleep(pollMs);
    const claimed = await input.client.claim(heldId);
    if (claimed.ok && claimed.decision === "ALLOW" && claimed.capabilityToken) {
      return record(heldId, claimed.capabilityToken, "approved");
    }
    if (claimed.ok && claimed.decision === "DENY") {
      return {
        kind: "denied",
        requestId: heldId,
        reasonCode: claimed.reasonCode ?? "DENIED",
      };
    }
    if (claimed.ok && claimed.decision === "ASK") continue;
    if (!claimed.ok && HELD.has(claimed.reasonCode)) continue;
    if (!claimed.ok && claimed.reasonCode === "SERVICE_UNAVAILABLE") continue;
    return {
      kind: "denied",
      requestId: heldId,
      reasonCode: claimed.ok
        ? (claimed.reasonCode ?? "MALFORMED_RESPONSE")
        : claimed.reasonCode,
    };
  }
  return { kind: "expired", requestId: heldId, reasonCode: "APPROVAL_PENDING" };
}
