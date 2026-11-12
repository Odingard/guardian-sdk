// Reading AP2 v0.2 mandates and the merchant-signed checkout, strictly.
// Unknown vct values, constraint types and fields are refused, not ignored.
import {
  CLOCK_SKEW_SECONDS,
  CURRENCY_EXPONENTS,
  MAX_CONSTRAINTS,
  MAX_LINE_ITEMS,
  RECURRENCE_FREQUENCIES,
  VCT,
  type RecurrenceFrequency,
} from "./constants.js";
import {
  delegateItemOf,
  jwkThumbprint,
  parseCompactJws,
  parseSdJwt,
  publicJwkOf,
  resolveSdJwtPayload,
  verifyJwsWithAny,
  type PublicJwk,
  type SdJwt,
} from "./jose.js";
import {
  isPlainObject,
  refused,
  sameData,
  sha256b64url,
  unknownKeys,
  type Ap2GuardRefused,
} from "./util.js";

// ------------------------------------------------------------------ types

export type Merchant = Readonly<{ id: string; name: string; website?: string }>;
export type PaymentInstrument = Readonly<{ id: string; type: string; description?: string }>;
export type Pisp = Readonly<{ legal_name: string; brand_name: string; domain_name: string }>;
export type Amount = Readonly<{ amount: number; currency: string }>;

export type CheckoutConstraint =
  | Readonly<{ type: "checkout.allowed_merchants"; allowed: readonly Merchant[] }>
  | Readonly<{
      type: "checkout.line_items";
      items: readonly Readonly<{
        id: string;
        acceptable_items: readonly Readonly<{ id: string; title: string }>[];
        quantity: number;
      }>[];
    }>;

export type PaymentConstraint =
  | Readonly<{ type: "payment.amount_range"; currency: string; max: number; min?: number }>
  | Readonly<{ type: "payment.budget"; currency: string; max: number }>
  | Readonly<{
      type: "payment.agent_recurrence";
      frequency: RecurrenceFrequency;
      max_occurrences?: number;
    }>
  | Readonly<{ type: "payment.allowed_payees"; allowed: readonly Merchant[] }>
  | Readonly<{ type: "payment.allowed_payment_instruments"; allowed: readonly PaymentInstrument[] }>
  | Readonly<{ type: "payment.allowed_pisps"; allowed: readonly Pisp[] }>
  | Readonly<{ type: "payment.execution_date"; not_before?: string; not_after?: string }>
  | Readonly<{ type: "payment.reference"; conditional_transaction_id: string }>;

export type OpenCheckoutContent = Readonly<{
  vct: typeof VCT.checkoutOpen;
  constraints: readonly CheckoutConstraint[];
  cnf: Readonly<{ jwk: PublicJwk }>;
  iat?: number;
  exp: number;
}>;

export type OpenPaymentContent = Readonly<{
  vct: typeof VCT.paymentOpen;
  constraints: readonly PaymentConstraint[];
  cnf: Readonly<{ jwk: PublicJwk }>;
  payee?: Merchant;
  payment_amount?: Amount;
  payment_instrument?: PaymentInstrument;
  pisp?: Pisp;
  execution_date?: string;
  risk_data?: Readonly<Record<string, unknown>>;
  iat?: number;
  exp: number;
}>;

export type OpenMandate<C> = Readonly<{ token: SdJwt; content: C; issuerKey: PublicJwk }>;

export type Total = Readonly<{ type: string; amount: number; display_text?: string }>;
export type LineItem = Readonly<{
  id: string;
  item: Readonly<{ id: string; title: string; price: number; image_url?: string }>;
  quantity: number;
  totals: readonly Total[];
  parent_id?: string;
}>;

export type Checkout = Readonly<{
  id: string;
  merchant: Merchant;
  line_items: readonly LineItem[];
  status: string;
  currency: string;
  totals: readonly Total[];
  links: readonly Readonly<{ type: string; url: string; title?: string }>[];
  buyer?: Readonly<Record<string, unknown>>;
  messages?: readonly Readonly<Record<string, unknown>>[];
  expires_at?: string;
  continue_url?: string;
  /** Other top-level fields the merchant sent (UCP allows them). */
  otherFieldNames: readonly string[];
}>;

export type ReadCheckout = Readonly<{
  checkoutJwt: string;
  checkoutHash: string;
  checkout: Checkout;
  total: number;
}>;

// ----------------------------------------------------------------- amounts

export function exponentOf(currency: unknown): number | undefined {
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return undefined;
  return Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENTS, currency)
    ? CURRENCY_EXPONENTS[currency]
    : undefined;
}

/** Integer minor units for people, from the guard's pinned ISO 4217 exponent: "19.99 USD". */
export function formatMinor(amount: number, currency: string): string {
  const e = exponentOf(currency);
  if (e === undefined || !Number.isSafeInteger(amount)) throw new TypeError("cannot format");
  const sign = amount < 0 ? "-" : "";
  const digits = String(Math.abs(amount));
  if (e === 0) return `${sign}${digits} ${currency}`;
  const padded = digits.padStart(e + 1, "0");
  return `${sign}${padded.slice(0, -e)}.${padded.slice(-e)} ${currency}`;
}

function minorAmount(v: unknown, field: string, allowNegative = false): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || (!allowNegative && v < 0)) {
    throw refused(
      "INVALID_AMOUNT",
      `${field} must be a whole number of minor units${allowNegative ? "" : ", zero or more"} (no floats, strings or values above 2^53).`,
    );
  }
  return v;
}

function currencyCode(v: unknown, field: string): string {
  if (exponentOf(v) === undefined) {
    throw refused("CURRENCY_NOT_SUPPORTED", `${field} ${JSON.stringify(v)} is not a currency the guard knows.`);
  }
  return v as string;
}

/**
 * `payment.budget.max` is a JSON number whose unit AP2 does not define. The
 * guard reads it only as major units with at most two decimals, and only for
 * a currency whose ISO exponent is 2; anything else is ambiguous and refused.
 */
export function budgetMinor(max: unknown, currency: string): number {
  if (exponentOf(currency) !== 2) {
    throw refused("BUDGET_UNIT_AMBIGUOUS", `payment.budget in ${currency} is ambiguous (its unit is not defined).`);
  }
  if (typeof max !== "number" || !Number.isFinite(max) || max < 0) {
    throw refused("BUDGET_UNIT_AMBIGUOUS", "payment.budget.max is not a usable number.");
  }
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(max));
  if (!m) {
    throw refused("BUDGET_UNIT_AMBIGUOUS", "payment.budget.max is not an exact amount in cents.");
  }
  const minor = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) {
    throw refused("BUDGET_UNIT_AMBIGUOUS", "payment.budget.max is too large.");
  }
  return minor;
}

// --------------------------------------------------------- shape readers

const str = (v: unknown, field: string, code: "MALFORMED_MANDATE" | "MALFORMED_CHECKOUT" = "MALFORMED_MANDATE"): string => {
  if (typeof v !== "string" || v.length === 0 || v.length > 4096) {
    throw refused(code, `${field} must be a non-empty string.`);
  }
  return v;
};

function noUnknown(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const extra = unknownKeys(obj, allowed);
  if (extra.length > 0) {
    throw refused("UNKNOWN_FIELD", `${where} has fields the guard does not know: ${extra.join(", ")}.`);
  }
}

export function readMerchant(v: unknown, where: string, code: "MALFORMED_MANDATE" | "MALFORMED_CHECKOUT" = "MALFORMED_MANDATE"): Merchant {
  if (!isPlainObject(v)) throw refused(code, `${where} must be an object.`);
  noUnknown(v, ["id", "name", "website"], where);
  const out: { id: string; name: string; website?: string } = {
    id: str(v.id, `${where}.id`, code),
    name: str(v.name, `${where}.name`, code),
  };
  if (v.website !== undefined) out.website = str(v.website, `${where}.website`, code);
  return out;
}

export function readInstrument(v: unknown, where: string): PaymentInstrument {
  if (!isPlainObject(v)) throw refused("MALFORMED_MANDATE", `${where} must be an object.`);
  noUnknown(v, ["id", "type", "description"], where);
  const out: { id: string; type: string; description?: string } = {
    id: str(v.id, `${where}.id`),
    type: str(v.type, `${where}.type`),
  };
  if (v.description !== undefined) out.description = str(v.description, `${where}.description`);
  return out;
}

export function readPisp(v: unknown, where: string): Pisp {
  if (!isPlainObject(v)) throw refused("MALFORMED_MANDATE", `${where} must be an object.`);
  noUnknown(v, ["legal_name", "brand_name", "domain_name"], where);
  return {
    legal_name: str(v.legal_name, `${where}.legal_name`),
    brand_name: str(v.brand_name, `${where}.brand_name`),
    domain_name: str(v.domain_name, `${where}.domain_name`),
  };
}

export function readAmount(v: unknown, where: string): Amount {
  if (!isPlainObject(v)) throw refused("MALFORMED_MANDATE", `${where} must be an object.`);
  noUnknown(v, ["amount", "currency"], where);
  return { amount: minorAmount(v.amount, `${where}.amount`), currency: currencyCode(v.currency, `${where}.currency`) };
}

function readDate(v: unknown, where: string): string {
  const s = str(v, where);
  if (!/^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(s) || Number.isNaN(Date.parse(s))) {
    throw refused("MALFORMED_MANDATE", `${where} must be an ISO 8601 date.`);
  }
  return s;
}

function list<T>(v: unknown, where: string, read: (x: unknown, w: string) => T, min = 1): T[] {
  if (!Array.isArray(v) || v.length < min || v.length > MAX_LINE_ITEMS) {
    throw refused("MALFORMED_MANDATE", `${where} must be a list of ${min} to ${MAX_LINE_ITEMS} entries.`);
  }
  return v.map((x, i) => read(x, `${where}[${i}]`));
}

function epoch(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw refused("MALFORMED_MANDATE", `${where} must be a Unix time in whole seconds.`);
  }
  return v;
}

export function readCheckoutConstraint(c: unknown, where: string): CheckoutConstraint {
  if (!isPlainObject(c)) throw refused("MALFORMED_MANDATE", `${where} must be an object.`);
  switch (c.type) {
    case "checkout.allowed_merchants":
      noUnknown(c, ["type", "allowed"], where);
      return { type: c.type, allowed: list(c.allowed, `${where}.allowed`, (x, w) => readMerchant(x, w)) };
    case "checkout.line_items":
      noUnknown(c, ["type", "items"], where);
      return {
        type: c.type,
        items: list(c.items, `${where}.items`, (x, w) => {
          if (!isPlainObject(x)) throw refused("MALFORMED_MANDATE", `${w} must be an object.`);
          noUnknown(x, ["id", "acceptable_items", "quantity"], w);
          const quantity = x.quantity;
          if (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity <= 0) {
            throw refused("MALFORMED_MANDATE", `${w}.quantity must be a whole number above zero.`);
          }
          return {
            id: str(x.id, `${w}.id`),
            acceptable_items: list(
              x.acceptable_items,
              `${w}.acceptable_items`,
              (y, wy) => {
                if (!isPlainObject(y)) throw refused("MALFORMED_MANDATE", `${wy} must be an object.`);
                noUnknown(y, ["id", "title"], wy);
                return { id: str(y.id, `${wy}.id`), title: str(y.title, `${wy}.title`) };
              },
              0,
            ),
            quantity,
          };
        }),
      };
    default:
      throw refused("UNKNOWN_CONSTRAINT", `${where} has a constraint type the guard does not know: ${JSON.stringify(c.type)}.`);
  }
}

export function readPaymentConstraint(c: unknown, where: string): PaymentConstraint {
  if (!isPlainObject(c)) throw refused("MALFORMED_MANDATE", `${where} must be an object.`);
  switch (c.type) {
    case "payment.amount_range": {
      noUnknown(c, ["type", "currency", "max", "min"], where);
      const out: { type: typeof c.type; currency: string; max: number; min?: number } = {
        type: c.type,
        currency: currencyCode(c.currency, `${where}.currency`),
        max: minorAmount(c.max, `${where}.max`),
      };
      if (c.min !== undefined) out.min = minorAmount(c.min, `${where}.min`);
      if (out.min !== undefined && out.min > out.max) {
        throw refused("MALFORMED_MANDATE", `${where}.min is above max.`);
      }
      return out;
    }
    case "payment.budget": {
      noUnknown(c, ["type", "max", "currency"], where);
      const currency = currencyCode(c.currency, `${where}.currency`);
      budgetMinor(c.max, currency);
      return { type: c.type, currency, max: c.max as number };
    }
    case "payment.agent_recurrence": {
      noUnknown(c, ["type", "frequency", "max_occurrences"], where);
      if (!RECURRENCE_FREQUENCIES.includes(c.frequency as RecurrenceFrequency)) {
        throw refused("MALFORMED_MANDATE", `${where}.frequency is not a known frequency.`);
      }
      const out: { type: typeof c.type; frequency: RecurrenceFrequency; max_occurrences?: number } = {
        type: c.type,
        frequency: c.frequency as RecurrenceFrequency,
      };
      if (c.max_occurrences !== undefined) {
        const n = c.max_occurrences;
        if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) {
          throw refused("MALFORMED_MANDATE", `${where}.max_occurrences must be a whole number above zero.`);
        }
        out.max_occurrences = n;
      }
      return out;
    }
    case "payment.allowed_payees":
      noUnknown(c, ["type", "allowed"], where);
      return { type: c.type, allowed: list(c.allowed, `${where}.allowed`, (x, w) => readMerchant(x, w)) };
    case "payment.allowed_payment_instruments":
      noUnknown(c, ["type", "allowed"], where);
      return { type: c.type, allowed: list(c.allowed, `${where}.allowed`, readInstrument) };
    case "payment.allowed_pisps":
      noUnknown(c, ["type", "allowed"], where);
      return { type: c.type, allowed: list(c.allowed, `${where}.allowed`, readPisp) };
    case "payment.execution_date": {
      noUnknown(c, ["type", "not_before", "not_after"], where);
      const out: { type: typeof c.type; not_before?: string; not_after?: string } = { type: c.type };
      if (c.not_before !== undefined) out.not_before = readDate(c.not_before, `${where}.not_before`);
      if (c.not_after !== undefined) out.not_after = readDate(c.not_after, `${where}.not_after`);
      return out;
    }
    case "payment.reference":
      noUnknown(c, ["type", "conditional_transaction_id"], where);
      return {
        type: c.type,
        conditional_transaction_id: str(c.conditional_transaction_id, `${where}.conditional_transaction_id`),
      };
    default:
      throw refused("UNKNOWN_CONSTRAINT", `${where} has a constraint type the guard does not know: ${JSON.stringify(c.type)}.`);
  }
}

const SINGLE_USE_TYPES = new Set(["payment.amount_range", "payment.budget", "payment.agent_recurrence", "payment.reference"]);

function readConstraints<T extends { type: string }>(
  v: unknown,
  where: string,
  read: (c: unknown, w: string) => T,
): T[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_CONSTRAINTS) {
    throw refused("MALFORMED_MANDATE", `${where} must be a list of 1 to ${MAX_CONSTRAINTS} constraints.`);
  }
  const out = v.map((c, i) => read(c, `${where}[${i}]`));
  const seen = new Set<string>();
  for (const c of out) {
    if (SINGLE_USE_TYPES.has(c.type)) {
      if (seen.has(c.type)) throw refused("MALFORMED_MANDATE", `${where} has ${c.type} twice.`);
      seen.add(c.type);
    }
  }
  return out;
}

function readCnf(v: unknown, where: string): { jwk: PublicJwk } {
  if (!isPlainObject(v)) throw refused("MISSING_FIELD", `${where}.cnf is required.`);
  noUnknown(v, ["jwk"], `${where}.cnf`);
  const jwk = publicJwkOf(v.jwk);
  if (!jwk) throw refused("MALFORMED_MANDATE", `${where}.cnf.jwk must be an EC P-256 public key.`);
  return { jwk };
}

function vctOf(item: Record<string, unknown>, expected: string, where: string): void {
  if ("intent_mandate" in item || "cart_mandate" in item || "natural_language_description" in item || "contents" in item) {
    throw refused("UNSUPPORTED_VCT", `${where} looks like an AP2 v0.1 IntentMandate or CartMandate; only v0.2 is supported.`);
  }
  if (item.vct !== expected) {
    throw refused("UNSUPPORTED_VCT", `${where} vct is ${JSON.stringify(item.vct)}; expected exactly ${expected}.`);
  }
}

export function readOpenCheckoutContent(item: unknown, where = "open checkout mandate"): OpenCheckoutContent {
  if (!isPlainObject(item)) throw refused("MALFORMED_MANDATE", `${where} must be an object.`);
  vctOf(item, VCT.checkoutOpen, where);
  noUnknown(item, ["vct", "constraints", "cnf", "iat", "exp"], where);
  const constraints = readConstraints(item.constraints, `${where}.constraints`, readCheckoutConstraint);
  if (!constraints.some((c) => c.type === "checkout.line_items")) {
    throw refused("MISSING_FIELD", `${where} must contain a checkout.line_items constraint.`);
  }
  if (item.exp === undefined) throw refused("MISSING_FIELD", `${where}.exp is required by the guard.`);
  const out: { vct: typeof VCT.checkoutOpen; constraints: CheckoutConstraint[]; cnf: { jwk: PublicJwk }; iat?: number; exp: number } = {
    vct: VCT.checkoutOpen,
    constraints,
    cnf: readCnf(item.cnf, where),
    exp: epoch(item.exp, `${where}.exp`),
  };
  if (item.iat !== undefined) out.iat = epoch(item.iat, `${where}.iat`);
  return out;
}

export function readOpenPaymentContent(item: unknown, where = "open payment mandate"): OpenPaymentContent {
  if (!isPlainObject(item)) throw refused("MALFORMED_MANDATE", `${where} must be an object.`);
  vctOf(item, VCT.paymentOpen, where);
  noUnknown(
    item,
    ["vct", "constraints", "cnf", "payee", "payment_amount", "payment_instrument", "pisp", "execution_date", "risk_data", "iat", "exp"],
    where,
  );
  const constraints = readConstraints(item.constraints, `${where}.constraints`, readPaymentConstraint);
  if (item.exp === undefined) throw refused("MISSING_FIELD", `${where}.exp is required by the guard.`);
  const out: {
    -readonly [K in keyof OpenPaymentContent]: OpenPaymentContent[K];
  } = {
    vct: VCT.paymentOpen,
    constraints,
    cnf: readCnf(item.cnf, where),
    exp: epoch(item.exp, `${where}.exp`),
  };
  if (item.iat !== undefined) out.iat = epoch(item.iat, `${where}.iat`);
  if (item.payee !== undefined) out.payee = readMerchant(item.payee, `${where}.payee`);
  if (item.payment_amount !== undefined) out.payment_amount = readAmount(item.payment_amount, `${where}.payment_amount`);
  if (item.payment_instrument !== undefined) {
    out.payment_instrument = readInstrument(item.payment_instrument, `${where}.payment_instrument`);
  }
  if (item.pisp !== undefined) out.pisp = readPisp(item.pisp, `${where}.pisp`);
  if (item.execution_date !== undefined) out.execution_date = readDate(item.execution_date, `${where}.execution_date`);
  if (item.risk_data !== undefined) {
    if (!isPlainObject(item.risk_data)) throw refused("MALFORMED_MANDATE", `${where}.risk_data must be an object.`);
    out.risk_data = item.risk_data;
  }
  return out;
}

/**
 * Reads one open mandate the Trusted Surface signed: a single SD-JWT (no
 * chain), ES256 under one of the pinned keys, disclosures resolved, the
 * exact `vct`, known fields and constraints only, `cnf` = the agent key,
 * not expired.
 */
export function readOpenMandate<C extends OpenCheckoutContent | OpenPaymentContent>(
  raw: unknown,
  kind: "checkout" | "payment",
  issuerKeys: readonly PublicJwk[],
  agentThumbprint: string,
  nowSec: number,
): OpenMandate<C> {
  const where = `open ${kind} mandate`;
  let token: SdJwt;
  try {
    token = parseSdJwt(raw);
  } catch (e) {
    if (e instanceof RangeError) {
      throw refused("UNSUPPORTED_CHAIN", `${where}: only a mandate the Trusted Surface signed directly is supported (no delegation chain).`);
    }
    throw refused("MALFORMED_MANDATE", `${where} is not a well-formed SD-JWT.`);
  }
  if (issuerKeys.length === 0) {
    throw refused("MANDATE_KEY_NOT_PINNED", "No Trusted Surface key is pinned; open mandates cannot be verified.");
  }
  const typ = token.jws.header.typ;
  if (typeof typ === "string" && typ.startsWith("kb")) {
    throw refused("UNSUPPORTED_CHAIN", `${where} is a key-binding hop, not a mandate the Trusted Surface signed.`);
  }
  const issuerKey = verifyJwsWithAny(token.jws, issuerKeys);
  if (!issuerKey) throw refused("MANDATE_SIGNATURE_INVALID", `${where} is not signed by a pinned Trusted Surface key.`);
  let item: Record<string, unknown>;
  try {
    item = delegateItemOf(resolveSdJwtPayload(token));
  } catch {
    throw refused("MALFORMED_MANDATE", `${where} disclosures do not resolve to one mandate.`);
  }
  const content = (kind === "checkout" ? readOpenCheckoutContent(item, where) : readOpenPaymentContent(item, where)) as C;
  if (jwkThumbprint(content.cnf.jwk) !== agentThumbprint) {
    throw refused("CNF_NOT_AGENT_KEY", `${where} delegates to another key (cnf), not this guard's agent key.`);
  }
  if (nowSec > content.exp) throw refused("OPEN_MANDATE_EXPIRED", `${where} expired.`);
  if (content.iat !== undefined && content.iat > nowSec + CLOCK_SKEW_SECONDS) {
    throw refused("MALFORMED_MANDATE", `${where} is issued in the future.`);
  }
  return { token, content, issuerKey };
}

// ---------------------------------------------------------------- checkout

const CHECKOUT_FIELDS = [
  "id",
  "merchant",
  "line_items",
  "status",
  "currency",
  "totals",
  "links",
  "buyer",
  "messages",
  "expires_at",
  "continue_url",
];

function readTotals(v: unknown, where: string): Total[] {
  if (!Array.isArray(v) || v.length > 32) throw refused("MALFORMED_CHECKOUT", `${where} must be a list.`);
  return v.map((t, i) => {
    const w = `${where}[${i}]`;
    if (!isPlainObject(t)) throw refused("MALFORMED_CHECKOUT", `${w} must be an object.`);
    const out: { type: string; amount: number; display_text?: string } = {
      type: str(t.type, `${w}.type`, "MALFORMED_CHECKOUT"),
      amount: minorAmount(t.amount, `${w}.amount`, true),
    };
    if (t.display_text !== undefined) out.display_text = str(t.display_text, `${w}.display_text`, "MALFORMED_CHECKOUT");
    return out;
  });
}

/**
 * Verifies the merchant-signed `checkout_jwt` against the developer-pinned
 * keys for the merchant it names, and reads the UCP checkout strictly.
 */
export function readCheckoutJwt(
  checkoutJwt: unknown,
  merchantKeys: Readonly<Record<string, readonly PublicJwk[]>>,
  nowMs: number,
): ReadCheckout {
  let jws;
  try {
    jws = parseCompactJws(checkoutJwt);
  } catch {
    throw refused("MALFORMED_CHECKOUT", "checkout_jwt is not a compact JWS with JSON header and payload.");
  }
  const p = jws.payload;
  if (p.merchant === undefined) {
    throw refused("MERCHANT_MISSING", "The checkout names no merchant; the guard cannot pick the merchant's key or check the payee.");
  }
  const merchant = readMerchant(p.merchant, "checkout.merchant", "MALFORMED_CHECKOUT");
  const keys = Object.prototype.hasOwnProperty.call(merchantKeys, merchant.id) ? merchantKeys[merchant.id]! : [];
  if (keys.length === 0) {
    throw refused("MERCHANT_KEY_NOT_PINNED", `No key is pinned for merchant ${merchant.id}; the checkout cannot be verified.`);
  }
  if (!verifyJwsWithAny(jws, keys)) {
    throw refused("CHECKOUT_SIGNATURE_INVALID", `checkout_jwt is not signed by a pinned key of merchant ${merchant.id}.`);
  }
  const currency = currencyCode(p.currency, "checkout.currency");
  if (!Array.isArray(p.line_items) || p.line_items.length === 0 || p.line_items.length > MAX_LINE_ITEMS) {
    throw refused("MALFORMED_CHECKOUT", `checkout.line_items must list 1 to ${MAX_LINE_ITEMS} items.`);
  }
  const lineItems: LineItem[] = p.line_items.map((li, i) => {
    const w = `checkout.line_items[${i}]`;
    if (!isPlainObject(li) || !isPlainObject(li.item)) throw refused("MALFORMED_CHECKOUT", `${w} must have an item.`);
    const q = li.quantity;
    if (typeof q !== "number" || !Number.isSafeInteger(q) || q < 1) {
      throw refused("MALFORMED_CHECKOUT", `${w}.quantity must be a whole number of 1 or more.`);
    }
    const item: { id: string; title: string; price: number; image_url?: string } = {
      id: str(li.item.id, `${w}.item.id`, "MALFORMED_CHECKOUT"),
      title: str(li.item.title, `${w}.item.title`, "MALFORMED_CHECKOUT"),
      price: minorAmount(li.item.price, `${w}.item.price`),
    };
    if (li.item.image_url !== undefined) item.image_url = str(li.item.image_url, `${w}.item.image_url`, "MALFORMED_CHECKOUT");
    const out: { id: string; item: typeof item; quantity: number; totals: Total[]; parent_id?: string } = {
      id: str(li.id, `${w}.id`, "MALFORMED_CHECKOUT"),
      item,
      quantity: q,
      totals: readTotals(li.totals, `${w}.totals`),
    };
    if (li.parent_id !== undefined) out.parent_id = str(li.parent_id, `${w}.parent_id`, "MALFORMED_CHECKOUT");
    return out;
  });
  const totals = readTotals(p.totals, "checkout.totals");
  const totalEntries = totals.filter((t) => t.type === "total");
  if (totalEntries.length !== 1) {
    throw refused("MALFORMED_CHECKOUT", "checkout.totals must contain exactly one total.");
  }
  const total = totalEntries[0]!.amount;
  if (total <= 0) throw refused("INVALID_AMOUNT", "The checkout total must be above zero.");
  if (!Array.isArray(p.links)) throw refused("MALFORMED_CHECKOUT", "checkout.links must be a list.");
  const links = p.links.map((l, i) => {
    const w = `checkout.links[${i}]`;
    if (!isPlainObject(l)) throw refused("MALFORMED_CHECKOUT", `${w} must be an object.`);
    const out: { type: string; url: string; title?: string } = {
      type: str(l.type, `${w}.type`, "MALFORMED_CHECKOUT"),
      url: str(l.url, `${w}.url`, "MALFORMED_CHECKOUT"),
    };
    if (l.title !== undefined) out.title = str(l.title, `${w}.title`, "MALFORMED_CHECKOUT");
    return out;
  });
  const status = str(p.status, "checkout.status", "MALFORMED_CHECKOUT");
  if (status !== "ready_for_complete") {
    throw refused("CHECKOUT_NOT_PAYABLE", `The checkout status is ${status}; only ready_for_complete is paid.`);
  }
  const checkout: { -readonly [K in keyof Checkout]: Checkout[K] } = {
    id: str(p.id, "checkout.id", "MALFORMED_CHECKOUT"),
    merchant,
    line_items: lineItems,
    status,
    currency,
    totals,
    links,
    otherFieldNames: unknownKeys(p, CHECKOUT_FIELDS).sort(),
  };
  if (p.buyer !== undefined) {
    if (!isPlainObject(p.buyer)) throw refused("MALFORMED_CHECKOUT", "checkout.buyer must be an object.");
    checkout.buyer = p.buyer;
  }
  if (p.messages !== undefined) {
    if (!Array.isArray(p.messages) || !p.messages.every(isPlainObject)) {
      throw refused("MALFORMED_CHECKOUT", "checkout.messages must be a list of objects.");
    }
    checkout.messages = p.messages as Record<string, unknown>[];
  }
  if (p.continue_url !== undefined) checkout.continue_url = str(p.continue_url, "checkout.continue_url", "MALFORMED_CHECKOUT");
  if (p.expires_at !== undefined) {
    const at = Date.parse(str(p.expires_at, "checkout.expires_at", "MALFORMED_CHECKOUT"));
    if (Number.isNaN(at)) throw refused("MALFORMED_CHECKOUT", "checkout.expires_at is not a date-time.");
    if (nowMs >= at) throw refused("CHECKOUT_EXPIRED", "The checkout has expired.");
    checkout.expires_at = p.expires_at as string;
  }
  return { checkoutJwt: checkoutJwt as string, checkoutHash: sha256b64url(checkoutJwt as string), checkout, total };
}

// ------------------------------------------------------------- evaluation

export function merchantMatches(candidate: Merchant, target: Merchant): boolean {
  if (candidate.id && target.id) return candidate.id === target.id;
  return (
    !!candidate.name &&
    candidate.name === target.name &&
    !!candidate.website &&
    candidate.website === target.website
  );
}

/**
 * Line items fit the requirements: every cart unit is assigned to a
 * requirement that accepts its item id, within each requirement's quantity
 * (max flow, as the AP2 reference evaluator does).
 */
export function lineItemsFit(
  items: readonly LineItem[],
  reqs: Extract<CheckoutConstraint, { type: "checkout.line_items" }>["items"],
): string | null {
  const qty = new Map<string, number>();
  for (const li of items) qty.set(li.item.id, (qty.get(li.item.id) ?? 0) + li.quantity);
  const skus = [...qty.keys()];
  const accepts = (r: (typeof reqs)[number], sku: string) =>
    r.acceptable_items.length === 0 || r.acceptable_items.some((a) => a.id === sku);
  for (const sku of skus) {
    if (!reqs.some((r) => accepts(r, sku))) return `Item ${sku} is not acceptable under the open checkout mandate.`;
  }
  // Nodes: 0 source, 1..S skus, S+1..S+R requirements, S+R+1 sink.
  const S = skus.length;
  const R = reqs.length;
  const n = S + R + 2;
  const sink = n - 1;
  const cap: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  skus.forEach((sku, i) => {
    cap[0]![i + 1] = qty.get(sku)!;
    reqs.forEach((r, j) => {
      if (accepts(r, sku)) cap[i + 1]![S + 1 + j] = Number.MAX_SAFE_INTEGER;
    });
  });
  reqs.forEach((r, j) => {
    cap[S + 1 + j]![sink] = r.quantity;
  });
  let flow = 0;
  for (;;) {
    const parent = new Array<number>(n).fill(-1);
    parent[0] = 0;
    const queue = [0];
    while (queue.length > 0 && parent[sink] === -1) {
      const u = queue.shift()!;
      for (let v = 0; v < n; v += 1) {
        if (parent[v] === -1 && cap[u]![v]! > 0) {
          parent[v] = u;
          queue.push(v);
        }
      }
    }
    if (parent[sink] === -1) break;
    let push = Number.MAX_SAFE_INTEGER;
    for (let v = sink; v !== 0; v = parent[v]!) push = Math.min(push, cap[parent[v]!]![v]!);
    for (let v = sink; v !== 0; v = parent[v]!) {
      cap[parent[v]!]![v]! -= push;
      cap[v]![parent[v]!]! += push;
    }
    flow += push;
  }
  const total = [...qty.values()].reduce((a, b) => a + b, 0);
  return flow < total ? "The cart has more items than the open checkout mandate allows." : null;
}

export function checkCheckoutConstraints(open: OpenCheckoutContent, checkout: Checkout): string | null {
  for (const c of open.constraints) {
    if (c.type === "checkout.allowed_merchants") {
      if (!c.allowed.some((m) => merchantMatches(m, checkout.merchant))) {
        return `Merchant ${checkout.merchant.id} is not allowed by the open checkout mandate.`;
      }
    } else {
      const why = lineItemsFit(checkout.line_items, c.items);
      if (why) return why;
    }
  }
  return null;
}

export type ClosedPaymentContent = Readonly<{
  vct: typeof VCT.payment;
  transaction_id: string;
  payee: Merchant;
  payment_amount: Amount;
  payment_instrument: PaymentInstrument;
  pisp?: Pisp;
  execution_date?: string;
  risk_data?: Readonly<Record<string, unknown>>;
}>;

export type ClosedCheckoutContent = Readonly<{
  vct: typeof VCT.checkout;
  checkout_jwt: string;
  checkout_hash: string;
}>;

/** Checks the open payment mandate's own constraints and presets. Budget and recurrence are the ledger's. */
export function checkPaymentConstraints(
  open: OpenPaymentContent,
  closed: ClosedPaymentContent,
  openCheckoutSdHash: string,
): { code: "CONSTRAINT_VIOLATED" | "PRESET_MISMATCH" | "PAYMENT_REFERENCE_MISMATCH" | "MISSING_FIELD"; detail: string } | null {
  const v = (detail: string) => ({ code: "CONSTRAINT_VIOLATED" as const, detail });
  if (open.payee !== undefined && !merchantMatches(open.payee, closed.payee)) {
    return { code: "PRESET_MISMATCH", detail: "The payee differs from the one preset in the open payment mandate." };
  }
  for (const [field, a, b] of [
    ["payment_amount", open.payment_amount, closed.payment_amount],
    ["payment_instrument", open.payment_instrument, closed.payment_instrument],
    ["pisp", open.pisp, closed.pisp],
    ["execution_date", open.execution_date, closed.execution_date],
  ] as const) {
    if (a !== undefined && !sameData(a, b)) {
      return { code: "PRESET_MISMATCH", detail: `${field} differs from the one preset in the open payment mandate.` };
    }
  }
  const types = new Set(open.constraints.map((c) => c.type));
  if (!types.has("payment.reference")) {
    return { code: "MISSING_FIELD", detail: "The open payment mandate has no payment.reference constraint." };
  }
  if (!types.has("payment.amount_range")) {
    return { code: "MISSING_FIELD", detail: "The open payment mandate has no payment.amount_range constraint." };
  }
  if (types.has("payment.agent_recurrence") && !types.has("payment.budget")) {
    return { code: "MISSING_FIELD", detail: "payment.agent_recurrence needs payment.budget." };
  }
  const amount = closed.payment_amount;
  for (const c of open.constraints) {
    switch (c.type) {
      case "payment.amount_range":
        if (amount.currency !== c.currency) return v(`Currency ${amount.currency} is not the mandate's ${c.currency}.`);
        if (c.min !== undefined && amount.amount < c.min) return v("The amount is below the mandate's minimum.");
        if (amount.amount > c.max) return v("The amount is above the mandate's maximum.");
        break;
      case "payment.budget":
        if (amount.currency !== c.currency) return v(`Currency ${amount.currency} is not the budget's ${c.currency}.`);
        break;
      case "payment.allowed_payees":
        if (!c.allowed.some((m) => merchantMatches(m, closed.payee))) return v(`Payee ${closed.payee.id} is not allowed.`);
        break;
      case "payment.allowed_payment_instruments":
        if (!c.allowed.some((i) => i.id === closed.payment_instrument.id)) {
          return v(`Payment instrument ${closed.payment_instrument.id} is not allowed.`);
        }
        break;
      case "payment.allowed_pisps":
        if (
          !closed.pisp ||
          !c.allowed.some(
            (p) =>
              p.legal_name === closed.pisp!.legal_name &&
              p.brand_name === closed.pisp!.brand_name &&
              p.domain_name === closed.pisp!.domain_name,
          )
        ) {
          return v("The PISP is missing or not allowed.");
        }
        break;
      case "payment.execution_date":
        if (closed.execution_date !== undefined) {
          const at = Date.parse(closed.execution_date);
          if (c.not_before !== undefined && at < Date.parse(c.not_before)) return v("The execution date is before the allowed window.");
          if (c.not_after !== undefined && at > Date.parse(c.not_after)) return v("The execution date is after the allowed window.");
        }
        break;
      case "payment.reference":
        if (c.conditional_transaction_id !== openCheckoutSdHash) {
          return { code: "PAYMENT_REFERENCE_MISMATCH", detail: "The open payment mandate references another open checkout mandate." };
        }
        break;
      case "payment.agent_recurrence":
        break; // the ledger enforces frequency and max_occurrences
    }
  }
  return null;
}

/** Throws the refusal for a failed constraint check. */
export function throwIf(r: { code: Ap2GuardRefused["code"]; detail: string } | null): void {
  if (r) throw refused(r.code, r.detail);
}
