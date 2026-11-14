// Asking Guardian: request, wait for a person on ASK, execute (redeem), and
// after a person approved, read the receipt to confirm the approval is for
// this exact request and these exact arguments. Every failure is a refusal;
// nothing here calls Link.
import {
  classifyRequestResult,
  verifyReceiptOffline,
  type GuardianClient,
  type GuardianInvocation,
} from "@odingard/guardian-sdk";

import type { AmountDeclaration } from "./amount.js";
import { isPlainObject, refused, sameData, sleep, withTimeout } from "./util.js";

export type DecisionConfig = Readonly<{
  guardian: GuardianClient;
  connectionId: string;
  requestTtlMs: number;
  pollMs: number;
  callTimeoutMs: number;
  amountArgument?: AmountDeclaration;
  receiptVerificationKeys?: unknown;
  now: () => number;
}>;

export type Redeemed = Readonly<{
  requestId: string;
  receiptReference: string;
  approvedByPerson: boolean;
}>;

/**
 * Claim answers that decide nothing: Guardian could not answer for now. A
 * held request stays held until its TTL ends; nothing reaches Link meanwhile.
 */
const CLAIM_STILL_HELD = new Set([
  "APPROVAL_PENDING",
  "APPROVAL_REQUIRED",
  "SERVICE_UNAVAILABLE",
  "RATE_LIMITED",
  "DB_BUSY",
  "HTTP_429",
]);

function claimStillHeld(reasonCode: string): boolean {
  return CLAIM_STILL_HELD.has(reasonCode) || /^HTTP_5\d\d$/.test(reasonCode);
}

const OUTCOME_UNKNOWN_DETAIL = (requestId: string) =>
  `Guardian may have redeemed this decision (execute outcome unknown); nothing reached Link. ` +
  `Look up request ${requestId} before retrying; a retry needs a new decision.`;

function wellFormed(value: unknown): value is
  | { ok: true; requestId: string; decision: "ALLOW" | "ASK" | "DENY"; capabilityToken?: string; reasonCode?: string }
  | { ok: false; reasonCode: string; requestId?: string } {
  if (!isPlainObject(value)) return false;
  if (value.ok === true) {
    return (
      typeof value.requestId === "string" &&
      (value.decision === "ALLOW" || value.decision === "ASK" || value.decision === "DENY")
    );
  }
  return value.ok === false && typeof value.reasonCode === "string";
}

async function guardianCall<T>(cfg: DecisionConfig, fn: () => Promise<T>): Promise<T> {
  const r = await withTimeout(Promise.resolve().then(fn), cfg.callTimeoutMs);
  if (!r.ok) {
    throw r.timedOut
      ? refused("GUARDIAN_TIMEOUT", "Guardian did not answer in time.")
      : refused("GUARDIAN_UNREACHABLE", "Guardian could not be reached.");
  }
  return r.value;
}

async function ask(
  cfg: DecisionConfig,
  tool: string,
  args: Record<string, unknown>,
  purpose: string,
  needsPerson: boolean,
): Promise<{ requestId: string; capabilityToken: string; viaAsk: boolean }> {
  // `amountArgument` reaches Guardian only through an SDK that carries it
  // (checked when the guard is built; see amount.ts).
  const invocation = {
    action: "tool.invoke" as const,
    connectionId: cfg.connectionId,
    toolName: tool,
    arguments: args,
    ...(cfg.amountArgument ? { amountArgument: cfg.amountArgument } : {}),
    purpose,
    ttlMs: cfg.requestTtlMs,
  } as GuardianInvocation;
  const answer = await guardianCall(cfg, () => cfg.guardian.request(invocation));
  const startedAt = cfg.now();
  if (!wellFormed(answer)) throw refused("GUARDIAN_UNREACHABLE", "Guardian's answer was malformed.");
  const decision = classifyRequestResult(answer);
  if (decision.decision === "DENY") {
    if (decision.reasonCode === "SERVICE_UNAVAILABLE") {
      throw refused("GUARDIAN_UNREACHABLE", "Guardian could not be reached.");
    }
    throw refused("GUARDIAN_DENIED", "Guardian denied this spend.", decision.reasonCode);
  }
  if (decision.decision === "ALLOW") {
    if (needsPerson) {
      throw refused("PERSON_APPROVAL_REQUIRED", "This spend needs a person's approval; a rule ALLOW is not enough.");
    }
    return { requestId: decision.requestId, capabilityToken: decision.capabilityToken, viaAsk: false };
  }
  // ASK: wait for a person before anything reaches Link.
  const requestId = decision.requestId;
  const deadline = startedAt + cfg.requestTtlMs;
  while (cfg.now() < deadline) {
    await sleep(Math.max(1, Math.min(cfg.pollMs, deadline - cfg.now())));
    let claimed: unknown;
    try {
      claimed = await guardianCall(cfg, () => cfg.guardian.claim(requestId));
    } catch {
      continue; // transient; the deadline still holds
    }
    if (!wellFormed(claimed)) throw refused("GUARDIAN_UNREACHABLE", "Guardian's answer was malformed.");
    // An answer that decides must name this request; another id is a replay.
    if (claimed.ok && claimed.requestId !== requestId) {
      throw refused("GUARDIAN_UNREACHABLE", "Guardian answered for a different request.");
    }
    if (claimed.ok && claimed.decision === "ALLOW") {
      if (typeof claimed.capabilityToken !== "string" || !claimed.capabilityToken) {
        throw refused("GUARDIAN_DENIED", "Guardian issued no capability.", "CAPABILITY_MISSING");
      }
      return { requestId, capabilityToken: claimed.capabilityToken, viaAsk: true };
    }
    const held =
      (claimed.ok && claimed.decision === "ASK") || (!claimed.ok && claimStillHeld(claimed.reasonCode));
    if (held) continue;
    throw refused(
      "GUARDIAN_DENIED",
      "Guardian denied this spend.",
      claimed.ok ? (claimed.reasonCode ?? "DENIED") : claimed.reasonCode,
    );
  }
  throw refused("APPROVAL_TIMEOUT", "No person approved this spend in time.");
}

/**
 * The receipt must show a person approved this exact request, with these
 * exact arguments. A receipt for an earlier request (a replayed approval)
 * or for other terms is refused.
 */
async function checkApprovedByPerson(
  cfg: DecisionConfig,
  requestId: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<void> {
  const fail = (why: string) =>
    refused("RECEIPT_CHECK_FAILED", `Cannot confirm a person approved this spend (${why}).`, undefined, {
      requestId,
    });
  const got = await guardianCall(cfg, () => cfg.guardian.portableReceipt(requestId));
  if (!isPlainObject(got) || got.ok !== true) throw fail("no receipt");
  const receipt = got.receipt;
  if (cfg.receiptVerificationKeys !== undefined) {
    const verified = verifyReceiptOffline(receipt, cfg.receiptVerificationKeys);
    if (!verified.valid) throw fail("receipt does not verify");
  }
  if (!isPlainObject(receipt)) throw fail("malformed receipt");
  const { subject, action, decision, approval } = receipt;
  if (!isPlainObject(subject) || subject.requestId !== requestId) throw fail("other request");
  if (!isPlainObject(action) || action.requestId !== requestId) throw fail("other request");
  if (action.action !== "tool.invoke") throw fail("action");
  const params = action.materialParameters;
  if (
    !isPlainObject(params) ||
    params.toolName !== tool ||
    params.connectionId !== cfg.connectionId ||
    !sameData(params.arguments, args)
  ) {
    throw fail("terms differ");
  }
  if (cfg.amountArgument !== undefined && !sameData(params.amountArgument, cfg.amountArgument)) {
    throw fail("amount declaration differs");
  }
  if (!isPlainObject(decision) || decision.decision !== "ASK") throw fail("not an ASK");
  if (!isPlainObject(approval) || (approval.state !== "approved" && approval.state !== "consumed")) {
    throw fail("not approved");
  }
}

/**
 * Request → (ASK: claim until a person decides) → execute → (after a
 * person: receipt check). Returns only after Guardian redeemed the
 * decision; nothing reaches Link before that.
 */
export async function decideAndRedeem(
  cfg: DecisionConfig,
  tool: string,
  args: Record<string, unknown>,
  purpose: string,
  needsPerson: boolean,
): Promise<Redeemed> {
  const { requestId, capabilityToken, viaAsk } = await ask(cfg, tool, args, purpose, needsPerson);
  const executed = await withTimeout(
    Promise.resolve().then(() => cfg.guardian.execute({ requestId, capabilityToken })),
    cfg.callTimeoutMs,
  );
  if (!executed.ok) {
    throw refused(
      "EXECUTE_FAILED",
      `${executed.timedOut ? "Guardian did not answer execute in time." : "Guardian execute failed."} ${OUTCOME_UNKNOWN_DETAIL(requestId)}`,
      undefined,
      { outcomeUnknown: true, requestId },
    );
  }
  const ex = executed.value as unknown;
  const exOk =
    isPlainObject(ex) &&
    ex.ok === true &&
    isPlainObject(ex.receipt) &&
    ex.receipt.status === "sent-verified" &&
    ex.receipt.requestId === requestId &&
    typeof ex.receipt.receiptReference === "string";
  if (!exOk) {
    const code = isPlainObject(ex) && typeof ex.reasonCode === "string" ? ex.reasonCode : "EXECUTE_FAILED";
    const definitiveRefusal = isPlainObject(ex) && ex.ok === false && ex.outcomeUnknown !== true;
    if (!definitiveRefusal) {
      throw refused(
        "EXECUTE_FAILED",
        `Guardian did not redeem the decision cleanly. ${OUTCOME_UNKNOWN_DETAIL(requestId)}`,
        code,
        { outcomeUnknown: true, requestId },
      );
    }
    throw refused("EXECUTE_FAILED", "Guardian did not redeem the decision.", code, { requestId });
  }
  const receiptReference = (ex as { receipt: { receiptReference: string } }).receipt.receiptReference;
  if (needsPerson && !viaAsk) {
    throw refused("PERSON_APPROVAL_REQUIRED", "This spend needs a person's approval; a rule ALLOW is not enough.");
  }
  if (viaAsk) await checkApprovedByPerson(cfg, requestId, tool, args);
  return { requestId, receiptReference, approvedByPerson: viaAsk };
}
