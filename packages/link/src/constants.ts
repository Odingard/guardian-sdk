/** Guardian tool names the guard proposes (`tool.invoke`, record transport). */
export const SPEND_TOOL = "link.spend";
export const SPEND_ABOVE_CAP_TOOL = "link.spend.above_cap";

/**
 * Link's own limit on one spend request: 50,000 minor units (USD cents
 * equivalent). The guard refuses anything above it before asking Guardian.
 */
export const LINK_MAX_AMOUNT = 50_000;

/** Link requires a `context` of at least 100 characters. */
export const LINK_MIN_CONTEXT = 100;
export const MAX_CONTEXT = 2_000;
export const MAX_TEXT = 500;
export const MAX_LINE_ITEMS = 50;
export const MAX_TOTALS = 20;

/** Currencies the guard can read amounts in: exponent 2 (cents) only. */
export const SUPPORTED_CURRENCIES = Object.freeze(["usd", "cad", "eur", "gbp"] as const);
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

/** Link's `--total` types. */
export const TOTAL_TYPES = Object.freeze([
  "subtotal",
  "tax",
  "total",
  "items_base_amount",
  "items_discount",
  "discount",
  "fulfillment",
  "shipping",
  "fee",
  "gift_wrap",
  "tip",
  "store_credit",
] as const);
export type TotalType = (typeof TOTAL_TYPES)[number];

/** A Link spend request id, as the CLI prints it. */
export const SPEND_REQUEST_ID_RE = /^lsrq_[A-Za-z0-9_]{1,128}$/;

export const DEFAULT_GUARDIAN_CALL_TIMEOUT_MS = 15_000;
export const MAX_GUARDIAN_CALL_TIMEOUT_MS = 60_000;
export const DEFAULT_CLAIM_POLL_INTERVAL_MS = 2_000;
export const MAX_CLAIM_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_LINK_POLL_INTERVAL_MS = 2_000;
/** Link gives a person 30 minutes to approve after approval is requested. */
export const MAX_LINK_APPROVAL_WAIT_MS = 30 * 60_000;
