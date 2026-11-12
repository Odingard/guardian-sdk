import { createHash } from "node:crypto";

/** Refusal codes the guard uses. */
export type RefusalCode =
  // reading mandates and the checkout
  | "MALFORMED_MANDATE"
  | "UNSUPPORTED_VCT"
  | "UNSUPPORTED_CHAIN"
  | "UNKNOWN_FIELD"
  | "UNKNOWN_CONSTRAINT"
  | "MISSING_FIELD"
  | "MANDATE_KEY_NOT_PINNED"
  | "MANDATE_SIGNATURE_INVALID"
  | "CNF_NOT_AGENT_KEY"
  | "OPEN_MANDATE_EXPIRED"
  | "OPEN_MANDATE_LIFETIME_TOO_LONG"
  | "MALFORMED_CHECKOUT"
  | "MERCHANT_MISSING"
  | "MERCHANT_KEY_NOT_PINNED"
  | "CHECKOUT_SIGNATURE_INVALID"
  | "CHECKOUT_HASH_MISMATCH"
  | "CHECKOUT_EXPIRED"
  | "CHECKOUT_NOT_PAYABLE"
  | "AMOUNT_TOTAL_MISMATCH"
  | "PAYEE_MERCHANT_MISMATCH"
  | "PAYMENT_REFERENCE_MISMATCH"
  | "PRESET_MISMATCH"
  | "CONSTRAINT_VIOLATED"
  | "INVALID_AMOUNT"
  | "CURRENCY_NOT_SUPPORTED"
  | "BUDGET_UNIT_AMBIGUOUS"
  | "INVALID_AUDIENCE"
  // local caps and the ledger
  | "ABOVE_MAX"
  | "NO_CAP_FOR_CURRENCY"
  | "PAYEE_NOT_ALLOWED"
  | "BUDGET_EXCEEDED"
  | "RECURRENCE_EXCEEDED"
  | "MANDATE_ALREADY_USED"
  | "MANDATE_IN_USE"
  | "OUTSTANDING_PRESENTATION"
  | "STORE_REQUIRED"
  | "STORE_UNAVAILABLE"
  // Guardian
  | "GUARDIAN_UNREACHABLE"
  | "GUARDIAN_TIMEOUT"
  | "GUARDIAN_DENIED"
  | "APPROVAL_TIMEOUT"
  | "PERSON_APPROVAL_REQUIRED"
  | "EXECUTE_FAILED"
  | "RECEIPT_CHECK_FAILED"
  // signing and presentation
  | "NO_PAYMENT_FLOW"
  | "NO_SIGNING_TOKEN"
  | "SIGNING_TOKEN_USED"
  | "SIGNING_TOKEN_EXPIRED"
  | "TERMS_CHANGED"
  | "SIGNING_INPUT_MISMATCH"
  | "SIGNING_REFUSED"
  | "MANDATE_CONTENT_MISMATCH"
  | "ALREADY_PRESENTED"
  | "PAIR_RELEASED"
  // receipts
  | "RECEIPT_INVALID";

/** Thrown whenever the guard refuses. */
export class Ap2GuardRefused extends Error {
  readonly code: RefusalCode;
  /** Guardian's own reason code, when Guardian refused. */
  readonly guardianReasonCode?: string;
  /**
   * EXECUTE_FAILED only: `execute` was sent but its outcome is unknown, so
   * Guardian may have redeemed the decision. Nothing was signed.
   */
  readonly outcomeUnknown?: true;
  /** The Guardian request this refusal is about, when there is one. */
  readonly requestId?: string;
  constructor(
    code: RefusalCode,
    detail: string,
    guardianReasonCode?: string,
    extra?: { outcomeUnknown?: boolean; requestId?: string },
  ) {
    super(
      `[guardian-ap2 ${code}${guardianReasonCode ? `:${guardianReasonCode}` : ""}] ${detail}`,
    );
    this.name = "Ap2GuardRefused";
    this.code = code;
    if (guardianReasonCode !== undefined) this.guardianReasonCode = guardianReasonCode;
    if (extra?.outcomeUnknown === true) this.outcomeUnknown = true;
    if (extra?.requestId !== undefined) this.requestId = extra.requestId;
  }
}

export function refused(
  code: RefusalCode,
  detail: string,
  guardianReasonCode?: string,
  extra?: { outcomeUnknown?: boolean; requestId?: string },
): Ap2GuardRefused {
  return new Ap2GuardRefused(code, detail, guardianReasonCode, extra);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * JSON Canonicalization Scheme (RFC 8785) for plain JSON data: keys sorted
 * by UTF-16 code units, ECMAScript number and string serialization. Throws
 * on anything that is not plain JSON (bigint, functions, non-finite numbers,
 * class instances, cycles deeper than 64).
 */
export function jcs(value: unknown, depth = 0): string {
  if (depth > 64) throw new TypeError("too deep");
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
      throw new TypeError(`not JSON: ${typeof value}`);
  }
  if (Array.isArray(value)) return `[${value.map((v) => jcs(v, depth + 1)).join(",")}]`;
  if (!isPlainObject(value)) throw new TypeError("not a plain object");
  const keys = Object.keys(value).sort();
  return `{${keys
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${jcs(value[k], depth + 1)}`)
    .join(",")}}`;
}

export function sameData(a: unknown, b: unknown): boolean {
  try {
    return jcs(a) === jcs(b);
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
  return deepFreeze(JSON.parse(jcs(value)) as T);
}

export function b64urlEncode(data: Uint8Array | string): string {
  return Buffer.from(typeof data === "string" ? Buffer.from(data, "utf8") : data).toString(
    "base64url",
  );
}

const B64URL_RE = /^[A-Za-z0-9_-]*$/;

/** Strict base64url decode (no padding, no other characters). */
export function b64urlDecode(s: string): Buffer {
  if (typeof s !== "string" || !B64URL_RE.test(s) || s.length % 4 === 1) {
    throw new TypeError("not base64url");
  }
  return Buffer.from(s, "base64url");
}

/** base64url(SHA-256(ASCII/UTF-8 of `s`)). */
export function sha256b64url(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("base64url");
}

/** "sha256:<hex>" of the JCS form of `value`. */
export function termsDigestOf(value: unknown): string {
  return `sha256:${createHash("sha256").update(jcs(value), "utf8").digest("hex")}`;
}

export function hasExactKeys(obj: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(obj);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}

/** Own keys of `obj` that are not in `allowed`. */
export function unknownKeys(obj: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(obj).filter((k) => !allowed.includes(k));
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
