// Generated file — do not edit.
import {
  canonicalJson,
  PortableAuthorityReceiptSchema,
} from "./contracts/index.js";

import { verifyReceiptOffline } from "./receipts.js";

/**
 * "verify, don't trust": the check a receiver runs before it
 * acts on a request an agent sends it (a bank moving money, a merchant
 * taking a payment, another agent accepting a task).
 *
 * An allowlist trusts the sender. This checks the request. It returns OK
 * only when every one of these holds:
 *
 * 1. the receipt is a genuine Guardian `greceipt.v1`, valid offline;
 * 2. the request in front of the receiver is exactly the action Guardian
 *    authorized: its parameters equal the receipt's, field for field
 *    (the receipt's `materialDigest` covers them, and step 1 proves it);
 * 3. Guardian allowed it, or a human approved it;
 * 4. it was not revoked, has not expired, and was not already executed;
 * 5. amount, destination and currency equal what the receiver expects;
 * 6. the receipt is fresh, within the receiver's window;
 * 7. the receiver has not already acted on this request (optional
 *    `seenRequestIds`), so one authorization moves money once.
 *
 * Pure and offline, unless `status` is given: then it also asks Guardian
 * whether the authorization is still in force right now (revocation can
 * happen after the receipt was issued). Any failure refuses; nothing is
 * resolved in the agent's favor.
 */
export type ExpectedAction = Readonly<{
  /** The action kind the receiver expects, e.g. "api.request". */
  action?: string;
  /**
   * The exact request the receiver received, in the action's material
   * parameter form (for `api.request`: schema, connectionId, method, url,
   * headers, body). Compared field for field; any difference refuses.
   */
  materialParameters: Readonly<Record<string, unknown>>;
  /** Minor units (cents) the receiver is about to move. */
  valueCents?: number;
  /**
   * Where the authorized amount is in the request (e.g. "amount" for
   * Stripe). The amount is read from the signed request itself, which the
   * receipt binds by digest; it must equal `valueCents`, and the action's
   * declared value when it has one (Guardian derives an `api.request`'s
   * value from the same body and refuses a mismatch). Without a declared
   * value (e.g. a receipt from a Guardian deployment that did not yet
   * derive `api.request` amounts) Guardian applied no cap to the amount, so it is
   * accepted only when a person approved the request (ASK approved).
   */
  amountField?: string;
  /** Destination merchant id the receiver expects. */
  merchantId?: string;
  /**
   * Currency the receiver expects (lower case, e.g. "usd"), read from the
   * request: the `currencyField` of an `api.request` body (JSON or form),
   * or of the material parameters for other actions.
   */
  currency?: string;
  /** Default "currency". */
  currencyField?: string;
}>;

export type ReceiptStatus =
  | "active"
  | "pending"
  | "revoked"
  | "expired"
  | "used"
  | "paused"
  | "unknown";

export type VerifyBeforeActingOptions = Readonly<{
  nowEpochMs?: number;
  /** Oldest receipt accepted, in ms since it was issued. Default 300000. */
  maxAgeMs?: number;
  /** Requests this receiver already acted on (replay refusal). */
  seenRequestIds?: Readonly<{ has(requestId: string): boolean }>;
  /**
   * Online revocation check, e.g. `(r) => fetchReceiptStatus(baseUrl, r)`.
   * Anything but "active" refuses, and so does a failed check.
   */
  status?: (
    receipt: unknown,
  ) => Promise<
    { ok: true; status: ReceiptStatus } | { ok: false; reasonCode: string }
  >;
}>;

export type VerifyBeforeActingRefusal =
  | "RECEIPT_INVALID"
  | "ACTION_MISMATCH"
  | "REQUEST_MISMATCH"
  | "NOT_AUTHORIZED"
  | "NOT_APPROVED"
  | "NOT_ISSUED"
  | "REVOKED"
  | "EXPIRED"
  | "ALREADY_USED"
  | "REPLAYED"
  | "STALE"
  | "NOT_YET_VALID"
  | "AMOUNT_NOT_AUTHORIZED"
  | "AMOUNT_MISMATCH"
  | "DESTINATION_MISMATCH"
  | "CURRENCY_MISSING"
  | "CURRENCY_MISMATCH"
  | "STATUS_UNAVAILABLE"
  | "STATUS_NOT_ACTIVE";

export type VerifyBeforeActingResult =
  | Readonly<{
      ok: true;
      requestId: string;
      receiptId: string;
      materialDigest: string;
      decision: "ALLOW" | "ASK";
      approvedByHuman: boolean;
      valueCents: number | null;
      merchantId: string | null;
      currency: string | null;
    }>
  | Readonly<{
      ok: false;
      reasonCode: VerifyBeforeActingRefusal;
      /** Plain words for logs and the person on the receiving side. */
      detail: string;
    }>;

export const DEFAULT_RECEIPT_MAX_AGE_MS = 300_000;
const CLOCK_SKEW_MS = 60_000;

type Body = {
  receiptId: string;
  issuedAtEpochMs: number;
  subject: { requestId: string };
  action: {
    action: string;
    materialDigest: string;
    materialParameters: unknown;
    expiresAtEpochMs: number;
    valueCents?: number;
    merchantId?: string;
  };
  decision: { decision: "ALLOW" | "ASK" | "DENY" };
  approval: { state: string } | null;
  capability: { state: string; claims: { expiresAtEpochMs: number } } | null;
  effect: { kind: string };
};

const sameCanonical = (a: unknown, b: unknown): boolean => {
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
  }
};

/** How many times `key` appears as a key of the root JSON object. */
function rootKeyCount(json: string, key: string): number {
  let depth = 0;
  let count = 0;
  for (let i = 0; i < json.length; i += 1) {
    const ch = json[i];
    if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;
    else if (ch === '"') {
      let end = i + 1;
      while (end < json.length && json[end] !== '"') {
        end += json[end] === "\\" ? 2 : 1;
      }
      if (depth === 1) {
        let next = end + 1;
        while (/\s/.test(json[next] ?? "")) next += 1;
        if (json[next] === ":") {
          let name: unknown = null;
          try {
            name = JSON.parse(json.slice(i, end + 1));
          } catch {
            name = null;
          }
          if (name === key) count += 1;
        }
      }
      i = end;
    }
  }
  return count;
}

/** Reads one field; null if absent, undefined if ambiguous or unreadable. */
function readField(
  action: string,
  parameters: Readonly<Record<string, unknown>>,
  field: string,
  /** Accept a JSON integer (amounts); currencies must be strings. */
  allowInteger = false,
): string | null | undefined {
  const asText = (value: unknown): string | undefined =>
    typeof value === "string"
      ? value
      : allowInteger &&
          typeof value === "number" &&
          Number.isSafeInteger(value) &&
          value >= 0
        ? String(value)
        : undefined;
  // Own keys only: an inherited name such as "constructor" is not a field.
  const own = (object: object, key: string) =>
    Object.prototype.hasOwnProperty.call(object, key);
  if (action !== "api.request") {
    if (!own(parameters, field)) return null;
    const value = parameters[field];
    if (value === undefined) return null;
    return asText(value);
  }
  const body = typeof parameters.body === "string" ? parameters.body : "";
  const headers: unknown[] = Array.isArray(parameters.headers)
    ? parameters.headers
    : [];
  const typeValues: string[] = [];
  for (const header of headers) {
    const { name, value } = (header ?? {}) as {
      name?: unknown;
      value?: unknown;
    };
    // A header that is not a plain name and value cannot be read safely.
    if (typeof name !== "string" || typeof value !== "string") {
      return undefined;
    }
    if (name.toLowerCase() === "content-type") typeValues.push(value);
  }
  // Missing or repeated content-type: unreadable.
  if (typeValues.length !== 1) return undefined;
  const [rawType, ...typeParams] = typeValues[0]!
    .trim()
    .toLowerCase()
    .split(";");
  const mediaType = rawType!.trim();
  const isJson =
    mediaType === "application/json" ||
    mediaType === "text/json" ||
    mediaType.endsWith("+json");
  // Read the body only for a known JSON or form type; anything else is
  // unreadable, so the receiver cannot parse it differently.
  if (!isJson && mediaType !== "application/x-www-form-urlencoded") {
    return undefined;
  }
  // The body is decoded as UTF-8. A receiver honouring another charset could
  // decode different keys and values, so only no parameter or
  // charset=utf-8 is read.
  const params = typeParams.map((p) => p.trim()).filter((p) => p !== "");
  if (
    params.length > 1 ||
    (params.length === 1 && !/^charset="?utf-8"?$/.test(params[0]!))
  ) {
    return undefined;
  }
  if (isJson) {
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      return undefined;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    // JSON.parse keeps the last of duplicate keys; a field repeated in the
    // root object is ambiguous and refused. Nested keys do not count.
    if (rootKeyCount(body, field) > 1) return undefined;
    if (!own(value, field)) return null;
    const found = (value as Record<string, unknown>)[field];
    if (found === undefined) return null;
    return asText(found);
  }
  const values: string[] = [];
  for (const [key, value] of new URLSearchParams(body)) {
    if (key === field) values.push(value);
    // Some servers (Rack) also strip spaces around keys, so " amount" may be
    // a second amount to them: ambiguous.
    else if (key.trim() === field) return undefined;
  }
  if (values.length === 0) return null;
  return values.length === 1 ? values[0]! : undefined;
}

export async function verifyBeforeActing(
  receipt: unknown,
  keys: unknown,
  expected: ExpectedAction,
  options: VerifyBeforeActingOptions = {},
): Promise<VerifyBeforeActingResult> {
  const refuse = (
    reasonCode: VerifyBeforeActingRefusal,
    detail: string,
  ): VerifyBeforeActingResult => ({ ok: false, reasonCode, detail });

  const verified = verifyReceiptOffline(receipt, keys);
  if (!verified.valid) {
    return refuse(
      "RECEIPT_INVALID",
      `The receipt is not a valid Guardian receipt (${String(
        (verified as { reasonCode?: unknown }).reasonCode ?? "invalid",
      )}).`,
    );
  }
  // Read the fields from the parsed receipt, the same value the verifier
  // checked (never from the raw input).
  const parsed = PortableAuthorityReceiptSchema.safeParse(receipt);
  if (!parsed.success) {
    return refuse(
      "RECEIPT_INVALID",
      "The receipt is not a valid Guardian receipt.",
    );
  }
  const body = parsed.data as unknown as Body;
  const action = body.action;

  if (expected.action !== undefined && action.action !== expected.action) {
    return refuse(
      "ACTION_MISMATCH",
      `The receipt authorizes ${action.action}, not ${expected.action}.`,
    );
  }
  if (!sameCanonical(action.materialParameters, expected.materialParameters)) {
    return refuse(
      "REQUEST_MISMATCH",
      "The request received is not the request Guardian authorized.",
    );
  }

  const decision = body.decision.decision;
  if (decision === "DENY") {
    return refuse("NOT_AUTHORIZED", "Guardian denied this request.");
  }
  const approvedByHuman = body.approval?.state === "approved";
  if (decision === "ASK" && !approvedByHuman) {
    return refuse("NOT_APPROVED", "No person has approved this request.");
  }
  if (body.approval !== null && body.approval.state === "revoked") {
    return refuse("REVOKED", "The approval was revoked.");
  }

  // Guardian issues a single-use capability for every ALLOW and every
  // approved ASK. A receipt without one authorizes nothing yet.
  if (body.capability === null) {
    return refuse(
      "NOT_ISSUED",
      "Guardian has not issued an authorization for this request.",
    );
  }
  const capabilityState = body.capability.state;
  if (capabilityState === "revoked") {
    return refuse("REVOKED", "The authorization was revoked.");
  }
  if (capabilityState === "expired") {
    return refuse("EXPIRED", "The authorization expired.");
  }
  if (capabilityState === "used" || body.effect.kind !== "none") {
    return refuse("ALREADY_USED", "This authorization was already used.");
  }

  const now = options.nowEpochMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_RECEIPT_MAX_AGE_MS;
  if (body.issuedAtEpochMs > now + CLOCK_SKEW_MS) {
    return refuse("NOT_YET_VALID", "The receipt is dated in the future.");
  }
  if (now - body.issuedAtEpochMs > maxAgeMs) {
    return refuse("STALE", "The receipt is older than this receiver accepts.");
  }
  if (action.expiresAtEpochMs <= now) {
    return refuse("EXPIRED", "The authorized request window has closed.");
  }
  if (body.capability.claims.expiresAtEpochMs <= now) {
    return refuse("EXPIRED", "The authorization expired.");
  }

  let valueCents = action.valueCents ?? null;
  if (expected.amountField !== undefined) {
    const read = readField(
      action.action,
      expected.materialParameters,
      expected.amountField,
      true,
    );
    const amount =
      typeof read === "string" && /^(0|[1-9][0-9]{0,15})$/.test(read.trim())
        ? Number(read.trim())
        : null;
    if (amount === null || !Number.isSafeInteger(amount)) {
      return refuse(
        "AMOUNT_NOT_AUTHORIZED",
        "The authorized request states no single, readable amount.",
      );
    }
    if (valueCents !== null && valueCents !== amount) {
      return refuse(
        "AMOUNT_MISMATCH",
        "The request's amount is not the amount Guardian authorized.",
      );
    }
    // With no declared value, Guardian never checked this amount against a
    // cap or an ask threshold. Only a person who approved this exact
    // request (the approval shows its body) authorized the amount.
    if (valueCents === null && !approvedByHuman) {
      return refuse(
        "AMOUNT_NOT_AUTHORIZED",
        "No person approved this amount, and Guardian checked it against no cap.",
      );
    }
    valueCents = amount;
  }
  if (expected.valueCents !== undefined) {
    if (valueCents === null) {
      return refuse(
        "AMOUNT_NOT_AUTHORIZED",
        "Guardian authorized no amount for this request.",
      );
    }
    if (valueCents !== expected.valueCents) {
      return refuse(
        "AMOUNT_MISMATCH",
        `Guardian authorized ${valueCents} cents, not ${expected.valueCents}.`,
      );
    }
  }
  const merchantId = action.merchantId ?? null;
  if (expected.merchantId !== undefined && merchantId !== expected.merchantId) {
    return refuse(
      "DESTINATION_MISMATCH",
      "Guardian authorized a different destination.",
    );
  }
  let currency: string | null = null;
  if (expected.currency !== undefined) {
    const read = readField(
      action.action,
      expected.materialParameters,
      expected.currencyField ?? "currency",
    );
    if (read === null) {
      return refuse("CURRENCY_MISSING", "The request names no currency.");
    }
    if (
      read === undefined ||
      read.trim().toLowerCase() !== expected.currency.trim().toLowerCase()
    ) {
      return refuse(
        "CURRENCY_MISMATCH",
        "The request's currency is not the one expected.",
      );
    }
    currency = read.trim().toLowerCase();
  }

  const requestId = body.subject.requestId;
  if (options.seenRequestIds?.has(requestId)) {
    return refuse("REPLAYED", "This receiver already acted on this request.");
  }

  if (options.status) {
    let status: Awaited<ReturnType<NonNullable<typeof options.status>>>;
    try {
      status = await options.status(receipt);
    } catch {
      status = { ok: false, reasonCode: "SERVICE_UNAVAILABLE" };
    }
    if (!status.ok) {
      return refuse(
        "STATUS_UNAVAILABLE",
        "Guardian could not confirm the authorization is still in force.",
      );
    }
    if (status.status !== "active") {
      return refuse(
        "STATUS_NOT_ACTIVE",
        `Guardian reports this authorization as ${status.status}.`,
      );
    }
  }

  return {
    ok: true,
    requestId,
    receiptId: body.receiptId,
    materialDigest: action.materialDigest,
    decision,
    approvedByHuman,
    valueCents,
    merchantId,
    currency,
  };
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Ask Guardian whether the authorization behind a receipt is still in force
 * (public; the receipt itself is the credential). Returns only a status,
 * never identities.
 */
export async function fetchReceiptStatus(
  baseUrl: string,
  receipt: unknown,
  options: { fetch?: FetchLike } = {},
): Promise<
  { ok: true; status: ReceiptStatus } | { ok: false; reasonCode: string }
> {
  const transport = options.fetch ?? fetch;
  try {
    const response = await transport(
      `${baseUrl.replace(/\/+$/, "")}/v1/receipts/status`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ receipt }),
      },
    );
    const data = (await response.json().catch(() => null)) as {
      ok?: unknown;
      status?: unknown;
      reasonCode?: unknown;
    } | null;
    const known: readonly string[] = [
      "active",
      "pending",
      "revoked",
      "expired",
      "used",
      "paused",
      "unknown",
    ];
    if (
      response.ok &&
      data?.ok === true &&
      typeof data.status === "string" &&
      known.includes(data.status)
    ) {
      return { ok: true, status: data.status as ReceiptStatus };
    }
    return {
      ok: false,
      reasonCode:
        typeof data?.reasonCode === "string"
          ? data.reasonCode
          : `HTTP_${response.status}`,
    };
  } catch {
    return { ok: false, reasonCode: "SERVICE_UNAVAILABLE" };
  }
}
