/**
 * The Guardian round-trip for one governed tool call.
 *
 *   ALLOW → redeem the single-use capability (revocation/expiry checked now,
 *           receipt recorded) → tell the agent to run the call.
 *   ASK   → wait for the human's decision (phone or console) → on approval,
 *           claim + redeem → run. Never auto-approved.
 *   DENY  → the agent is told no, with the reason. Nothing runs.
 *
 * Anything Guardian does not confirm — unreachable service, bad config,
 * timeout, failed redemption — is a deny (fail closed).
 *
 * Decision-gated: the agent performs the effect after redemption, so the
 * receipt proves Guardian's authorization of that exact call, not the
 * command's own outcome.
 */
import type { GuardianClient } from "@odingard/guardian-sdk";

import type { GovernedCall } from "./classify.js";

export type HookVerdict = Readonly<{
  decision: "allow" | "deny";
  /** Shown to the agent (and the developer). Plain words. */
  reason: string;
  requestId?: string;
  guardianDecision?: "ALLOW" | "ASK" | "DENY";
  approvedByHuman?: boolean;
}>;

export type DecideOptions = Readonly<{
  client: Pick<GuardianClient, "request" | "claim" | "execute">;
  connectionId: string;
  agentName: string;
  approvalTimeoutMs: number;
  /**
   * How long Guardian keeps the request open (SDK `ttlMs`). An ASK that is
   * not approved within it expires, so waiting longer than this is pointless.
   */
  requestTtlMs?: number;
  /** First wait between claim checks; grows ×1.5 up to `maxPollIntervalMs`. */
  pollIntervalMs: number;
  /**
   * Cap for the backoff (default 10 s). Every claim made while the approval
   * is still pending is recorded on the request's evidence chain, so a
   * fixed short interval floods it during a long wait.
   */
  maxPollIntervalMs?: number;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Progress lines (stderr) — e.g. "waiting for approval". */
  log?: (line: string) => void;
}>;

type RequestResult = Awaited<ReturnType<GuardianClient["request"]>>;

const PLAIN: Record<string, string> = {
  NOT_AUTHORIZED: "this agent is not authorized for it",
  APPROVAL_DENIED: "the approver declined it",
  APPROVAL_NOT_SATISFIED: "the approver declined it",
  APPROVAL_EXPIRED: "the approval expired",
  UNAUTHENTICATED: "the Guardian agent credential was rejected",
  INVALID_REQUEST:
    'this tool is not allowed for the agent yet. In the Guardian console: Agents → this agent → the connection\'s card → "Allow a tool by name"',
  SERVICE_UNAVAILABLE: "Guardian could not be reached",
  REQUEST_CONFLICT: "Guardian saw a conflicting request",
};

function plain(code: string): string {
  return PLAIN[code] ?? code;
}

function denied(
  call: GovernedCall,
  code: string,
  extra: Partial<HookVerdict> = {},
): HookVerdict {
  return {
    decision: "deny",
    reason:
      `Guardian blocked ${call.toolName} (${code}): ${plain(code)}. ` +
      `Do not retry or work around this; ask the developer to review it in the Guardian console.`,
    ...extra,
  };
}

/** How long before the window closes the hook makes its final check. */
export const FINAL_CHECK_LEAD_MS = 1_500;

const isPending = (r: RequestResult) =>
  (!r.ok &&
    (r.reasonCode === "APPROVAL_REQUIRED" ||
      r.reasonCode === "APPROVAL_PENDING")) ||
  (r.ok && r.decision === "ASK");

export async function decide(
  call: GovernedCall,
  options: DecideOptions,
): Promise<HookVerdict> {
  const wait =
    options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});

  let result: RequestResult;
  try {
    result = await options.client.request({
      action: "tool.invoke",
      connectionId: options.connectionId,
      toolName: call.toolName,
      arguments: call.arguments,
      purpose: `${options.agentName}: ${call.summary}`,
      ...(options.requestTtlMs !== undefined
        ? { ttlMs: options.requestTtlMs }
        : {}),
    });
  } catch {
    return denied(call, "SERVICE_UNAVAILABLE");
  }
  // Guardian's window starts when it creates the request, somewhere inside
  // that call. Timing from the reply errs late, never early: a check that
  // lands after the window is refused by Guardian, so nothing runs.
  const answeredAt = now();
  const requestId = result.requestId;
  let approvedByHuman = false;

  if (isPending(result)) {
    if (!requestId) return denied(call, "MISSING_REQUEST_ID");
    log(
      `Guardian: "${call.summary}" is held for approval (request ${requestId}). Approve it on your phone or in the console.`,
    );
    // Stop waiting at our own timeout or when Guardian's window closes,
    // whichever is first. The last check runs just before that moment, so an
    // approval in the final seconds is still picked up (polls back off to
    // 10 s, which could otherwise skip past the end of the window).
    const window = Math.min(
      options.approvalTimeoutMs,
      options.requestTtlMs ?? options.approvalTimeoutMs,
    );
    // A short window keeps most of its time: the lead is at most a quarter.
    const lead = Math.min(FINAL_CHECK_LEAD_MS, Math.floor(window / 4));
    const lastCheckAt = answeredAt + window - lead;
    const maxInterval = Math.max(
      options.maxPollIntervalMs ?? 10_000,
      options.pollIntervalMs,
    );
    let interval = options.pollIntervalMs;
    for (;;) {
      await wait(Math.max(0, Math.min(interval, lastCheckAt - now())));
      interval = Math.min(Math.ceil(interval * 1.5), maxInterval);
      let claimed: RequestResult;
      try {
        claimed = await options.client.claim(requestId);
      } catch {
        claimed = { ok: false, reasonCode: "APPROVAL_REQUIRED", requestId };
      }
      if (!isPending(claimed)) {
        result = claimed;
        approvedByHuman = claimed.ok && claimed.decision === "ALLOW";
        break;
      }
      if (now() >= lastCheckAt) {
        return {
          decision: "deny",
          reason:
            `Guardian is still waiting for a human to approve ${call.toolName} (request ${requestId}). ` +
            `Nothing ran. Tell the developer it needs approval in the Guardian app, then try again.`,
          requestId,
          guardianDecision: "ASK",
        };
      }
    }
  }

  if (!result.ok || result.decision !== "ALLOW" || !result.capabilityToken) {
    const code = result.ok
      ? (result.reasonCode ??
        (result.decision === "DENY" ? "DENIED" : "MISSING_CAPABILITY"))
      : result.reasonCode;
    return denied(call, code, {
      ...(requestId ? { requestId } : {}),
      guardianDecision: "DENY",
    });
  }

  let executed: Awaited<ReturnType<GuardianClient["execute"]>>;
  try {
    executed = await options.client.execute({
      requestId: result.requestId,
      capabilityToken: result.capabilityToken,
    });
  } catch {
    executed = { ok: false, reasonCode: "SERVICE_UNAVAILABLE" };
  }
  if (!executed.ok) {
    return denied(call, executed.reasonCode, {
      requestId: result.requestId,
      guardianDecision: approvedByHuman ? "ASK" : "ALLOW",
      approvedByHuman,
    });
  }
  return {
    decision: "allow",
    reason: approvedByHuman
      ? `Approved by a human in Guardian (request ${result.requestId}).`
      : `Allowed by Guardian policy (request ${result.requestId}).`,
    requestId: result.requestId,
    guardianDecision: approvedByHuman ? "ASK" : "ALLOW",
    approvedByHuman,
  };
}
