// Reading the spend terms. Everything is checked and copied once; the copy
// is frozen and is what Guardian decides on, what Link is asked to create,
// and what every later read of the spend request is compared with.
import type { LinkSpendRequestView } from "./adapter.js";
import {
  LINK_MAX_AMOUNT,
  LINK_MIN_CONTEXT,
  MAX_CONTEXT,
  MAX_LINE_ITEMS,
  MAX_TEXT,
  MAX_TOTALS,
  SUPPORTED_CURRENCIES,
  TOTAL_TYPES,
  type SupportedCurrency,
  type TotalType,
} from "./constants.js";
import { deepFreeze, isPlainObject, refused } from "./util.js";

/** What the agent asks to buy. Amounts are integer minor units (cents). */
export type LinkSpendTerms = Readonly<{
  merchantName: string;
  merchantUrl: string;
  amount: number;
  currency: string;
  lineItems: readonly Readonly<{ name: string; quantity: number; unitAmount: number }>[];
  totals: readonly Readonly<{ type: TotalType; displayText: string; amount: number }>[];
  /** What the person reads in Link when approving. At least 100 characters. */
  context: string;
}>;

/** The terms Guardian decides on, exactly as the guard will act on them. */
export type CanonicalTerms = Readonly<{
  merchantName: string;
  merchantUrl: string;
  /** Host of `merchantUrl`, for the approval slip. */
  merchantHost: string;
  amount: number;
  currency: SupportedCurrency;
  /** For example "35.00 USD". */
  amountDisplay: string;
  lineItems: readonly Readonly<{ name: string; quantity: number; unitAmount: number }>[];
  totals: readonly Readonly<{ type: TotalType; displayText: string; amount: number }>[];
  context: string;
  credentialType: "card";
  /** The guard creates test-mode spend requests only. */
  linkMode: "test";
  /**
   * Link's card works at any merchant: the merchant name and URL are what
   * the agent declared, not a lock Link enforces.
   */
  payeeEnforcedByLink: false;
}>;

const TERMS_KEYS = [
  "merchantName",
  "merchantUrl",
  "amount",
  "currency",
  "lineItems",
  "totals",
  "context",
] as const;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/;

function invalid(detail: string) {
  return refused("INVALID_TERMS", detail);
}

function exactKeys(obj: Record<string, unknown>, allowed: readonly string[], what: string) {
  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key !== "string" || !allowed.includes(key)) {
      throw invalid(`${what} has an unknown field ${String(key)}.`);
    }
  }
}

/**
 * Plain text the CLI passes through unchanged: no control or invisible
 * characters, no surrounding space, not starting with "-" (it could read
 * as a flag), and, for `key:value` fields, no comma (Link splits on it).
 */
function text(value: unknown, what: string, opts: { max: number; min?: number; kv?: boolean }) {
  if (typeof value !== "string") throw invalid(`${what} must be text.`);
  if (value.length < (opts.min ?? 1) || value.length > opts.max) {
    throw invalid(`${what} must be ${opts.min ?? 1} to ${opts.max} characters.`);
  }
  if (CONTROL.test(value)) throw invalid(`${what} has control or invisible characters.`);
  if (value.trim() !== value) throw invalid(`${what} starts or ends with a space.`);
  if (value.startsWith("-")) throw invalid(`${what} must not start with "-".`);
  if (opts.kv && value.includes(",")) throw invalid(`${what} must not contain a comma.`);
  return value;
}

function whole(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw invalid(`${what} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

/** Totals that add to the items, and totals that are taken off them. */
const ADDED: readonly TotalType[] = ["tax", "fulfillment", "shipping", "fee", "gift_wrap", "tip"];
const TAKEN_OFF: readonly TotalType[] = ["discount", "store_credit"];

/**
 * The line items and totals must add up, so the person is not shown a $3
 * item for a $199.99 total. With `items` the sum of quantity x unit amount:
 * - `items_base_amount`, if given (once), equals `items`;
 * - `subtotal`, if given (once), equals `items` minus `items_discount`;
 * - `total` equals `items` minus `items_discount`, `discount` and
 *   `store_credit`, plus `tax`, `fulfillment`, `shipping`, `fee`,
 *   `gift_wrap` and `tip`.
 * Amounts are given as positive numbers. Anything else is refused.
 */
function checkArithmetic(
  lineItems: readonly { quantity: number; unitAmount: number }[],
  totals: readonly { type: TotalType; amount: number }[],
): void {
  const items = lineItems.reduce((sum, it) => sum + it.quantity * it.unitAmount, 0);
  const sumOf = (types: readonly TotalType[]) =>
    totals.filter((t) => types.includes(t.type)).reduce((sum, t) => sum + t.amount, 0);
  const once = (type: TotalType) => {
    const found = totals.filter((t) => t.type === type);
    if (found.length > 1) throw refused("TOTAL_MISMATCH", `totals may list ${type} only once.`);
    return found[0]?.amount;
  };
  const itemsDiscount = sumOf(["items_discount"]);
  const base = once("items_base_amount");
  if (base !== undefined && base !== items) {
    throw refused("TOTAL_MISMATCH", "items_base_amount must equal the line items (quantity x unit amount).");
  }
  const subtotal = once("subtotal");
  if (subtotal !== undefined && subtotal !== items - itemsDiscount) {
    throw refused("TOTAL_MISMATCH", "subtotal must equal the line items less items_discount.");
  }
  const expected = items - itemsDiscount - sumOf(TAKEN_OFF) + sumOf(ADDED);
  if (once("total") !== expected) {
    throw refused(
      "TOTAL_MISMATCH",
      "total must equal the line items less discounts plus tax, shipping, fees and tip.",
    );
  }
}

export function amountDisplay(amount: number, currency: string): string {
  const whole = Math.floor(amount / 100);
  const cents = String(amount % 100).padStart(2, "0");
  return `${whole}.${cents} ${currency.toUpperCase()}`;
}

/**
 * Reads the agent's terms into the canonical terms. Throws `INVALID_TERMS`
 * (or a narrower code) on anything it cannot read exactly.
 */
export function readTerms(
  raw: unknown,
  enabledCurrencies: readonly SupportedCurrency[],
): CanonicalTerms {
  if (!isPlainObject(raw)) throw invalid("The terms must be an object.");
  exactKeys(raw, TERMS_KEYS, "The terms");

  const merchantName = text(raw.merchantName, "merchantName", { max: MAX_TEXT });
  const merchantUrl = text(raw.merchantUrl, "merchantUrl", { max: 2_048 });
  let parsed: URL;
  try {
    parsed = new URL(merchantUrl);
  } catch {
    throw invalid("merchantUrl is not a URL.");
  }
  if (parsed.protocol !== "https:") throw invalid("merchantUrl must be https.");
  if (parsed.username || parsed.password) throw invalid("merchantUrl must not carry credentials.");
  if (/\s/.test(merchantUrl)) throw invalid("merchantUrl must not contain spaces.");

  const amount = whole(raw.amount, "amount", 1, Number.MAX_SAFE_INTEGER);
  if (amount > LINK_MAX_AMOUNT) {
    throw refused("ABOVE_LINK_LIMIT", `amount ${amount} is above Link's limit of ${LINK_MAX_AMOUNT}.`);
  }

  if (typeof raw.currency !== "string" || !/^[A-Za-z]{3}$/.test(raw.currency)) {
    throw invalid("currency must be a 3-letter code.");
  }
  const currency = raw.currency.toLowerCase();
  if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(currency)) {
    throw refused("CURRENCY_NOT_ENABLED", `currency ${currency} is not supported.`);
  }
  if (!(enabledCurrencies as readonly string[]).includes(currency)) {
    throw refused("CURRENCY_NOT_ENABLED", `currency ${currency} is not enabled on this guard.`);
  }

  if (!Array.isArray(raw.lineItems) || raw.lineItems.length < 1 || raw.lineItems.length > MAX_LINE_ITEMS) {
    throw invalid(`lineItems must list 1 to ${MAX_LINE_ITEMS} items.`);
  }
  const lineItems = raw.lineItems.map((item: unknown, i: number) => {
    if (!isPlainObject(item)) throw invalid(`lineItems[${i}] must be an object.`);
    exactKeys(item, ["name", "quantity", "unitAmount"], `lineItems[${i}]`);
    return {
      name: text(item.name, `lineItems[${i}].name`, { max: MAX_TEXT, kv: true }),
      quantity: whole(item.quantity, `lineItems[${i}].quantity`, 1, 10_000),
      unitAmount: whole(item.unitAmount, `lineItems[${i}].unitAmount`, 0, LINK_MAX_AMOUNT),
    };
  });

  if (!Array.isArray(raw.totals) || raw.totals.length < 1 || raw.totals.length > MAX_TOTALS) {
    throw invalid(`totals must list 1 to ${MAX_TOTALS} entries.`);
  }
  const totals = raw.totals.map((t: unknown, i: number) => {
    if (!isPlainObject(t)) throw invalid(`totals[${i}] must be an object.`);
    exactKeys(t, ["type", "displayText", "amount"], `totals[${i}]`);
    if (typeof t.type !== "string" || !(TOTAL_TYPES as readonly string[]).includes(t.type)) {
      throw invalid(`totals[${i}].type is not a Link total type.`);
    }
    return {
      type: t.type as TotalType,
      displayText: text(t.displayText, `totals[${i}].displayText`, { max: MAX_TEXT, kv: true }),
      amount: whole(t.amount, `totals[${i}].amount`, 0, LINK_MAX_AMOUNT),
    };
  });
  const grand = totals.filter((t) => t.type === "total");
  if (grand.length !== 1 || grand[0]!.amount !== amount) {
    throw refused("TOTAL_MISMATCH", "totals must have exactly one total entry, equal to amount.");
  }
  checkArithmetic(lineItems, totals);

  const context = text(raw.context, "context", { min: LINK_MIN_CONTEXT, max: MAX_CONTEXT });

  return deepFreeze({
    merchantName,
    merchantUrl,
    merchantHost: parsed.hostname,
    amount,
    currency: currency as SupportedCurrency,
    amountDisplay: amountDisplay(amount, currency),
    lineItems,
    totals,
    context,
    credentialType: "card",
    linkMode: "test",
    payeeEnforcedByLink: false,
  });
}

/**
 * Compares a spend request as Link returned it with the decided terms.
 * Returns the fields that differ (empty: it matches). A field Link must
 * return and did not counts as different.
 */
export function differences(
  terms: CanonicalTerms,
  view: LinkSpendRequestView,
  spendRequestId?: string,
): string[] {
  const out: string[] = [];
  if (view === null || typeof view !== "object") return ["request"];
  if (spendRequestId !== undefined && view.id !== spendRequestId) out.push("id");
  if (view.merchantName !== terms.merchantName) out.push("merchantName");
  if (view.merchantUrl !== terms.merchantUrl) out.push("merchantUrl");
  if (view.amount !== terms.amount) out.push("amount");
  if (typeof view.currency !== "string" || view.currency.toLowerCase() !== terms.currency) {
    out.push("currency");
  }
  if (view.credentialType !== "card") out.push("credentialType");
  if (view.context !== terms.context) out.push("context");
  // Fields Link returned that the guard never sets and cannot accept, such
  // as a recurring schedule or metadata (the adapter names them).
  if (!Array.isArray(view.unexpectedFields)) out.push("unexpectedFields");
  else {
    for (const name of view.unexpectedFields) {
      out.push(typeof name === "string" && /^[a-z0-9_.[\]]{1,64}$/.test(name) ? name : "unexpectedFields");
    }
  }
  const items = view.lineItems;
  if (
    !Array.isArray(items) ||
    items.length !== terms.lineItems.length ||
    items.some((it, i) => {
      const want = terms.lineItems[i]!;
      // Link's quantity defaults to 1 when it is not returned.
      const quantity = it.quantity === undefined ? 1 : it.quantity;
      return it.name !== want.name || quantity !== want.quantity || it.unitAmount !== want.unitAmount;
    })
  ) {
    out.push("lineItems");
  }
  const totals = view.totals;
  if (
    !Array.isArray(totals) ||
    totals.length !== terms.totals.length ||
    totals.some((t, i) => {
      const want = terms.totals[i]!;
      return t.type !== want.type || t.displayText !== want.displayText || t.amount !== want.amount;
    })
  ) {
    out.push("totals");
  }
  return out;
}

/** The fields an update may change. Link cannot update the merchant name or context. */
export function updateDifferences(from: CanonicalTerms, to: CanonicalTerms): string[] {
  const out: string[] = [];
  if (from.merchantName !== to.merchantName) out.push("merchantName");
  if (from.context !== to.context) out.push("context");
  return out;
}
