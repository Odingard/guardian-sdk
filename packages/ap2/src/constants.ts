/** Guardian tool names the guard proposes (`tool.invoke`, record transport). */
export const PAY_TOOL = "ap2.pay";
export const PAY_ABOVE_CAP_TOOL = "ap2.pay.above_cap";
export const DELEGATE_TOOL = "ap2.delegate";
export const DELEGATE_RECURRING_TOOL = "ap2.delegate.recurring";

/** The AP2 version this guard reads. Nothing else is accepted. */
export const AP2_VERSION = "0.2";

/** AP2 v0.2 `vct` values, matched exactly (version suffix included). */
export const VCT = Object.freeze({
  checkout: "mandate.checkout.1",
  checkoutOpen: "mandate.checkout.open.1",
  payment: "mandate.payment.1",
  paymentOpen: "mandate.payment.open.1",
});

/** Header `typ` of the terminal (closed) KB-SD-JWT hop the guard signs. */
export const KB_TERMINAL_TYP = "kb+sd-jwt";

/** The only selective-disclosure hash algorithm accepted. */
export const SD_ALG = "sha-256";

/**
 * ISO 4217 minor-unit exponents the guard knows. The guard's own pins, not
 * read from any mandate or checkout. A currency missing here is refused.
 */
export const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  AUD: 2,
  NZD: 2,
  CHF: 2,
  SEK: 2,
  NOK: 2,
  DKK: 2,
  SGD: 2,
  HKD: 2,
  INR: 2,
  BRL: 2,
  MXN: 2,
  JPY: 0,
  KRW: 0,
  KWD: 3,
  BHD: 3,
  OMR: 3,
  JOD: 3,
});

export const RECURRENCE_FREQUENCIES = Object.freeze([
  "ON_DEMAND",
  "DAILY",
  "WEEKLY",
  "BIWEEKLY",
  "MONTHLY",
  "QUARTERLY",
  "ANNUALLY",
] as const);
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

export const DEFAULT_SIGNING_WINDOW_MS = 30_000;
export const DEFAULT_CLAIM_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_GUARDIAN_CALL_TIMEOUT_MS = 15_000;
export const MAX_SIGNING_WINDOW_MS = 120_000;
export const MAX_CLAIM_POLL_INTERVAL_MS = 60_000;
export const MAX_GUARDIAN_CALL_TIMEOUT_MS = 60_000;
/** Longest open-mandate lifetime the guard asks a Trusted Surface to sign, by default. */
export const DEFAULT_MAX_OPEN_MANDATE_LIFETIME_SECONDS = 7 * 24 * 3600;
/** Clock skew allowed on `iat` and `exp`. */
export const CLOCK_SKEW_SECONDS = 60;
/** Upper bounds that keep reading bounded. */
export const MAX_TOKEN_LENGTH = 256 * 1024;
export const MAX_LINE_ITEMS = 200;
export const MAX_CONSTRAINTS = 64;
