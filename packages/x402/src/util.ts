/** Refusal codes the guard uses. */
export type RefusalCode =
  | "MALFORMED_PAYMENT_REQUIRED"
  | "UNSUPPORTED_VERSION"
  | "UNSUPPORTED_SCHEME"
  | "UNSUPPORTED_NETWORK"
  | "NETWORK_NOT_ENABLED"
  | "UNSUPPORTED_ASSET"
  | "UNSUPPORTED_TRANSFER_METHOD"
  | "UNSUPPORTED_PAYMENT_FLOW"
  | "SPLITS_REFUSED"
  | "UNKNOWN_EXTRA_FIELD"
  | "DOMAIN_MISMATCH"
  | "INVALID_AMOUNT"
  | "INVALID_PAY_TO"
  | "INVALID_TIMEOUT"
  | "TIMEOUT_ABOVE_LIMIT"
  | "MISSING_RESOURCE"
  | "RESOURCE_HOST_MISMATCH"
  | "ORIGINAL_REQUEST_MISSING"
  | "V1_NOT_SUPPORTED_ON_MCP"
  | "ABOVE_MAX"
  | "PAY_TO_NOT_ALLOWED"
  | "BUDGET_EXCEEDED"
  | "STORE_UNAVAILABLE"
  | "GUARDIAN_UNREACHABLE"
  | "GUARDIAN_TIMEOUT"
  | "GUARDIAN_DENIED"
  | "APPROVAL_TIMEOUT"
  | "PERSON_APPROVAL_REQUIRED"
  | "EXECUTE_FAILED"
  | "RECEIPT_CHECK_FAILED"
  | "NO_PAYMENT_FLOW"
  | "NO_SIGNING_TOKEN"
  | "SIGNING_TOKEN_USED"
  | "SIGNING_TOKEN_EXPIRED"
  | "TERMS_CHANGED"
  | "TYPED_DATA_MISMATCH"
  | "SIGNING_REFUSED"
  | "GUARD_SEALED";

/** Thrown (or used as the abort reason) whenever the guard refuses. */
export class X402GuardRefused extends Error {
  readonly code: RefusalCode;
  /** Guardian's own reason code, when Guardian refused. */
  readonly guardianReasonCode?: string;
  /**
   * EXECUTE_FAILED only: `execute` was sent but its outcome is unknown, so
   * Guardian may have redeemed the decision. Nothing was signed. Look the
   * request up by `requestId` before retrying; a retry needs a new decision.
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
      `[guardian-x402 ${code}${guardianReasonCode ? `:${guardianReasonCode}` : ""}] ${detail}`,
    );
    this.name = "X402GuardRefused";
    this.code = code;
    if (guardianReasonCode !== undefined) {
      this.guardianReasonCode = guardianReasonCode;
    }
    if (extra?.outcomeUnknown === true) this.outcomeUnknown = true;
    if (extra?.requestId !== undefined) this.requestId = extra.requestId;
  }
}

export type Refusal = Readonly<{
  ok: false;
  code: RefusalCode;
  detail: string;
}>;

export const refusal = (code: RefusalCode, detail: string): Refusal => ({
  ok: false,
  code,
  detail,
});

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Stable JSON for comparisons. Throws on anything that is not plain JSON
 * data (functions, symbols, cycles, class instances); bigint is written as
 * a tagged string so typed-data values compare exactly.
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
    case "bigint":
      return JSON.stringify(`bigint:${value.toString()}`);
    case "object":
      break;
    default:
      throw new TypeError(`cannot compare ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonical(v, depth + 1)).join(",")}]`;
  }
  if (!isPlainObject(value)) throw new TypeError("not a plain object");
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonical(value[k], depth + 1)}`)
    .join(",")}}`;
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
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** A detached, frozen copy of plain JSON data. */
export function frozenCopy<T>(value: T): T {
  return deepFreeze(JSON.parse(JSON.stringify(value)) as T);
}

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** A positive integer with no leading zero, at most 78 digits (uint256). */
export const ATOMIC_RE = /^[1-9][0-9]{0,77}$/;

export function formatAtomic(amount: string, decimals: number): string {
  const digits = amount.padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
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

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
