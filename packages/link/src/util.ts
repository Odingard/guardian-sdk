/** Refusal codes the guard uses. */
export type RefusalCode =
  // reading the terms
  | "INVALID_TERMS"
  | "CURRENCY_NOT_ENABLED"
  | "ABOVE_LINK_LIMIT"
  | "TOTAL_MISMATCH"
  // local caps
  | "ABOVE_MAX"
  // Link
  | "LINK_APPROVAL_POLICY_PRESENT"
  | "LINK_APPROVAL_POLICY_UNKNOWN"
  | "LINK_CALL_FAILED"
  | "LINK_OUTCOME_UNKNOWN"
  | "LINK_NOT_APPROVED"
  | "LINK_APPROVAL_TIMEOUT"
  | "UNKNOWN_SPEND_REQUEST"
  | "SPEND_REQUEST_REUSED"
  | "WRONG_STATE"
  | "UPDATE_NOT_SUPPORTED"
  | "TERMS_CHANGED"
  | "CARD_ALREADY_READ"
  | "CARD_UNREADABLE"
  // the ledger
  | "DECISION_ALREADY_USED"
  | "STORE_UNAVAILABLE"
  | "LEDGER_FULL"
  // Guardian
  | "GUARDIAN_UNREACHABLE"
  | "GUARDIAN_TIMEOUT"
  | "GUARDIAN_DENIED"
  | "APPROVAL_TIMEOUT"
  | "PERSON_APPROVAL_REQUIRED"
  | "EXECUTE_FAILED"
  | "RECEIPT_CHECK_FAILED";

/** Thrown whenever the guard refuses. Never carries card details. */
export class LinkGuardRefused extends Error {
  readonly code: RefusalCode;
  /** Guardian's own reason code, when Guardian refused. */
  readonly guardianReasonCode?: string;
  /**
   * The outcome of the last call is unknown (Guardian `execute`, or a Link
   * create, update or request-approval). The decision may be spent. Look
   * the request up before retrying; a retry needs a new decision.
   */
  readonly outcomeUnknown?: true;
  /** The Guardian request this refusal is about, when there is one. */
  readonly requestId?: string;
  /** The Link spend request this refusal is about, when there is one. */
  readonly spendRequestId?: string;
  constructor(
    code: RefusalCode,
    detail: string,
    guardianReasonCode?: string,
    extra?: { outcomeUnknown?: boolean; requestId?: string; spendRequestId?: string },
  ) {
    super(
      `[guardian-link ${code}${guardianReasonCode ? `:${guardianReasonCode}` : ""}] ${detail}`,
    );
    this.name = "LinkGuardRefused";
    this.code = code;
    if (guardianReasonCode !== undefined) this.guardianReasonCode = guardianReasonCode;
    if (extra?.outcomeUnknown === true) this.outcomeUnknown = true;
    if (extra?.requestId !== undefined) this.requestId = extra.requestId;
    if (extra?.spendRequestId !== undefined) this.spendRequestId = extra.spendRequestId;
  }
}

export function refused(
  code: RefusalCode,
  detail: string,
  guardianReasonCode?: string,
  extra?: { outcomeUnknown?: boolean; requestId?: string; spendRequestId?: string },
): LinkGuardRefused {
  return new LinkGuardRefused(code, detail, guardianReasonCode, extra);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Stable JSON for comparisons. Throws on anything that is not plain JSON
 * data (functions, symbols, cycles, class instances).
 */
export function canonical(value: unknown, depth = 0): string {
  if (depth > 32) throw new TypeError("too deep");
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("non-finite number");
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`cannot compare ${typeof value}`);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v, depth + 1)).join(",")}]`;
  if (!isPlainObject(value)) throw new TypeError("not a plain object");
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k], depth + 1)}`).join(",")}}`;
}

export function sameData(a: unknown, b: unknown): boolean {
  try {
    return canonical(a) === canonical(b);
  } catch {
    return false;
  }
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/** A detached, frozen copy of plain JSON data. */
export function frozenCopy<T>(value: T): T {
  return deepFreeze(JSON.parse(JSON.stringify(value)) as T);
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ ok: true; value: T } | { ok: false; timedOut: boolean; error?: unknown }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, timedOut: true }), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve({ ok: false, timedOut: false, error });
      },
    );
  });
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
