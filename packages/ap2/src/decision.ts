// Asking Guardian: request, wait for a person on ASK, execute (redeem), and
// for decisions that need a person, read the receipt to confirm one approved
// this exact request. Every failure is a refusal; nothing here signs.
import {
  classifyRequestResult,
  verifyReceiptOffline,
  type GuardianClient,
} from "@odingard/guardian-sdk";

import { REQUEST_LIMITS } from "./constants.js";
import { isPlainObject, jcs, refused, sameData, sleep, withTimeout } from "./util.js";

export type DecisionConfig = Readonly<{
  guardian: GuardianClient;
  connectionId: string;
  requestTtlMs: number;
  pollMs: number;
  callTimeoutMs: number;
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
 * held request stays held until its TTL ends; nothing is signed meanwhile.
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
  `Guardian may have redeemed this decision (execute outcome unknown); nothing was signed. ` +
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

/**
 * Where `args` breaks a limit the Guardian SDK and Guardian put on request
 * arguments, as "<path>: <reason>", or null. Paths and reasons only, never
 * values.
 */
export function requestLimitBreach(args: Record<string, unknown>): string | null {
  const L = REQUEST_LIMITS;
  let nodes = 0;
  const walk = (v: unknown, depth: number, path: string): string | null => {
    nodes += 1;
    if (nodes > L.maxNodes) return `${path}: more than ${L.maxNodes} values`;
    if (depth > L.maxDepth) return `${path}: nested deeper than ${L.maxDepth} levels`;
    if (v === null || typeof v === "boolean") return null;
    if (typeof v === "string") {
      if (v.length > L.maxStringLength) return `${path}: a string longer than ${L.maxStringLength} characters`;
      if (v.normalize("NFC") !== v) return `${path}: a string that is not NFC-normalized`;
      return null;
    }
    if (typeof v === "number") {
      return Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER && !Object.is(v, -0)
        ? null
        : `${path}: a number that is not canonical`;
    }
    if (Array.isArray(v)) {
      if (v.length > L.maxArrayLength) return `${path}: a list longer than ${L.maxArrayLength}`;
      for (let i = 0; i < v.length; i += 1) {
        const why = walk(v[i], depth + 1, `${path}[${i}]`);
        if (why) return why;
      }
      return null;
    }
    if (!isPlainObject(v)) return `${path}: not plain JSON`;
    const keys = Object.keys(v);
    if (keys.length > L.maxObjectKeys) return `${path}: more than ${L.maxObjectKeys} fields`;
    for (const k of keys) {
      if (
        k.length === 0 ||
        k.length > L.maxKeyLength ||
        k.normalize("NFC") !== k ||
        k === "__proto__" ||
        k === "constructor" ||
        k === "prototype"
      ) {
        return `${path}: a field name Guardian does not accept`;
      }
      const why = walk(v[k], depth + 1, `${path}.${k}`);
      if (why) return why;
    }
    return null;
  };
  const why = walk(args, 1, "arguments");
  if (why) return why;
  let bytes: number;
  try {
    bytes = Buffer.byteLength(jcs(args), "utf8");
  } catch {
    return "arguments: not plain JSON";
  }
  return bytes > L.maxArgumentsBytes ? `arguments: ${bytes} bytes of canonical JSON, more than ${L.maxArgumentsBytes}` : null;
}

/** An error the Guardian SDK throws before sending: its input checks, not the network. */
function localValidationReason(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  if (error.name === "ZodError") {
    const issues = (error as { issues?: unknown }).issues;
    if (Array.isArray(issues) && issues.length > 0) {
      return issues
        .slice(0, 3)
        .map((i) => {
          const issue = isPlainObject(i) ? i : {};
          const path = Array.isArray(issue.path) && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
          return `${path}${typeof issue.message === "string" ? issue.message : "invalid"}`;
        })
        .join("; ");
    }
    return "invalid request";
  }
  if (error instanceof RangeError) return error.message;
  return null;
}

async function guardianCall<T>(
  cfg: DecisionConfig,
  fn: () => Promise<T>,
  opts: { localChecks?: boolean } = {},
): Promise<T> {
  const r = await withTimeout(Promise.resolve().then(fn), cfg.callTimeoutMs);
  if (!r.ok) {
    if (r.timedOut) throw refused("GUARDIAN_TIMEOUT", "Guardian did not answer in time.");
    const local = opts.localChecks ? localValidationReason(r.error) : null;
    if (local !== null) {
      throw refused("REQUEST_INVALID", `The Guardian SDK refused the request before sending it (${local}); nothing was sent.`);
    }
    throw refused("GUARDIAN_UNREACHABLE", "Guardian could not be reached.");
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
  const breach = requestLimitBreach(args);
  if (breach !== null) {
    throw refused("REQUEST_INVALID", `The Guardian request is outside the request limits (${breach}); nothing was sent.`);
  }
  const answer = await guardianCall(
    cfg,
    () =>
      cfg.guardian.request({
        action: "tool.invoke",
        connectionId: cfg.connectionId,
        toolName: tool,
        arguments: args,
        purpose,
        ttlMs: cfg.requestTtlMs,
      }),
    { localChecks: true },
  );
  const startedAt = cfg.now();
  if (!wellFormed(answer)) throw refused("GUARDIAN_UNREACHABLE", "Guardian's answer was malformed.");
  const decision = classifyRequestResult(answer);
  if (decision.decision === "DENY") {
    if (decision.reasonCode === "SERVICE_UNAVAILABLE") {
      throw refused("GUARDIAN_UNREACHABLE", "Guardian could not be reached.");
    }
    throw refused("GUARDIAN_DENIED", "Guardian denied this.", decision.reasonCode);
  }
  if (decision.decision === "ALLOW") {
    if (needsPerson) {
      throw refused("PERSON_APPROVAL_REQUIRED", "This needs a person's approval; a rule ALLOW is not enough.");
    }
    return { requestId: decision.requestId, capabilityToken: decision.capabilityToken, viaAsk: false };
  }
  // ASK: wait for a person before anything is signed.
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
    if (claimed.ok && claimed.requestId !== requestId) {
      throw refused("GUARDIAN_UNREACHABLE", "Guardian answered for a different request.");
    }
    if (claimed.ok && claimed.decision === "ALLOW") {
      if (typeof claimed.capabilityToken !== "string" || !claimed.capabilityToken) {
        throw refused("GUARDIAN_DENIED", "Guardian issued no capability.", "CAPABILITY_MISSING");
      }
      return { requestId, capabilityToken: claimed.capabilityToken, viaAsk: true };
    }
    const held = (claimed.ok && claimed.decision === "ASK") || (!claimed.ok && claimStillHeld(claimed.reasonCode));
    if (held) continue;
    throw refused(
      "GUARDIAN_DENIED",
      "Guardian denied this.",
      claimed.ok ? (claimed.reasonCode ?? "DENIED") : claimed.reasonCode,
    );
  }
  throw refused("APPROVAL_TIMEOUT", "No person approved this in time.");
}

/** The receipt must show a person approved this exact request. */
async function checkApprovedByPerson(
  cfg: DecisionConfig,
  requestId: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<void> {
  const fail = (why: string) =>
    refused("RECEIPT_CHECK_FAILED", `Cannot confirm a person approved this (${why}).`);
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
  if (!isPlainObject(decision) || decision.decision !== "ASK") throw fail("not an ASK");
  if (!isPlainObject(approval) || (approval.state !== "approved" && approval.state !== "consumed")) {
    throw fail("not approved");
  }
}

/**
 * Request → (ASK: claim until a person decides) → execute → (person needed:
 * receipt check). Returns only after Guardian redeemed the decision.
 * `onOutcomeUnknown` is told when execute was sent but its outcome is unknown.
 */
export async function decideAndRedeem(
  cfg: DecisionConfig,
  tool: string,
  args: Record<string, unknown>,
  purpose: string,
  needsPerson: boolean,
  hooks: { onRedeemed?: (r: { requestId: string; receiptReference: string }) => void; onOutcomeUnknown?: (requestId: string) => void } = {},
): Promise<Redeemed> {
  const { requestId, capabilityToken, viaAsk } = await ask(cfg, tool, args, purpose, needsPerson);
  const executed = await withTimeout(
    Promise.resolve().then(() => cfg.guardian.execute({ requestId, capabilityToken })),
    cfg.callTimeoutMs,
  );
  if (!executed.ok) {
    hooks.onOutcomeUnknown?.(requestId);
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
      hooks.onOutcomeUnknown?.(requestId);
      throw refused("EXECUTE_FAILED", `Guardian did not redeem the decision cleanly. ${OUTCOME_UNKNOWN_DETAIL(requestId)}`, code, {
        outcomeUnknown: true,
        requestId,
      });
    }
    throw refused("EXECUTE_FAILED", "Guardian did not redeem the decision.", code, { requestId });
  }
  const receiptReference = (ex as { receipt: { receiptReference: string } }).receipt.receiptReference;
  hooks.onRedeemed?.({ requestId, receiptReference });
  if (needsPerson) {
    if (!viaAsk) throw refused("PERSON_APPROVAL_REQUIRED", "This needs a person's approval; a rule ALLOW is not enough.");
    await checkApprovedByPerson(cfg, requestId, tool, args);
  }
  return { requestId, receiptReference, approvedByPerson: needsPerson };
}
