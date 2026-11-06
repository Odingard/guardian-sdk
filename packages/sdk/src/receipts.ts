// Generated file — do not edit.
import { verifyPortableAuthorityReceipt } from "./evidence/receipt.js";

/**
 * Portable receipt verification for developers and auditors.
 *
 * Offline verification needs only the receipt and Guardian's published
 * Ed25519 verification keys: no agent credential, account, plan or Guardian
 * service is involved once the keys are in hand. It checks the
 * `guardian-canonical-json.v1` signature over the receipt body and
 * re-derives every embedded record against the receipt's evidence chain.
 * Verification is never billable.
 */
export type ReceiptVerification = ReturnType<
  typeof verifyPortableAuthorityReceipt
>;

export type ReceiptKeySetResult =
  | { ok: true; keys: unknown }
  | { ok: false; reasonCode: string };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function baseOf(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

const KEY_ID = /^rkey_[A-Za-z0-9_-]{1,128}$/;

/**
 * Fetch the published verification key set (public; no credential).
 *
 * The published set holds Guardian's newest keys (at most 8). To verify a
 * receipt signed by an older key, pass `forReceipt: receipt` (or `kid`):
 * the set returned then contains that receipt's signing key.
 */
export async function fetchReceiptVerificationKeys(
  baseUrl: string,
  options: { fetch?: FetchLike; kid?: string; forReceipt?: unknown } = {},
): Promise<ReceiptKeySetResult> {
  const transport = options.fetch ?? fetch;
  const kid =
    options.kid ??
    (options.forReceipt as { proof?: { keyId?: unknown } } | null | undefined)
      ?.proof?.keyId;
  const query =
    typeof kid === "string" && KEY_ID.test(kid)
      ? `?kid=${encodeURIComponent(kid)}`
      : "";
  try {
    const response = await transport(
      `${baseOf(baseUrl)}/v1/receipts/verification-keys${query}`,
      { method: "GET" },
    );
    const body = (await response.json().catch(() => null)) as {
      keys?: unknown;
    } | null;
    if (!response.ok || !body || !Array.isArray(body.keys)) {
      return { ok: false, reasonCode: `HTTP_${response.status}` };
    }
    return { ok: true, keys: body };
  } catch {
    return { ok: false, reasonCode: "SERVICE_UNAVAILABLE" };
  }
}

/**
 * Verify a receipt locally against a key set. Pure; no network.
 *
 * `keys` may be the published key set (`{ keys: [...] }`) or the result of
 * `fetchReceiptVerificationKeys()` as returned (`{ ok: true, keys }`). A
 * failed fetch result (`{ ok: false }`) never verifies.
 */
export function verifyReceiptOffline(
  receipt: unknown,
  keys: unknown,
): ReceiptVerification {
  return verifyPortableAuthorityReceipt(receipt, keySetFrom(keys));
}

function keySetFrom(keys: unknown): unknown {
  if (keys !== null && typeof keys === "object" && "ok" in keys) {
    const result = keys as { ok: unknown; keys?: unknown };
    return result.ok === true ? result.keys : null;
  }
  return keys;
}

/** Ask a Guardian deployment to verify a receipt (public endpoint). */
export async function verifyReceiptOnline(
  baseUrl: string,
  receipt: unknown,
  options: { fetch?: FetchLike } = {},
): Promise<
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; reasonCode: string }
> {
  const transport = options.fetch ?? fetch;
  try {
    const response = await transport(`${baseOf(baseUrl)}/v1/receipts/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ receipt }),
    });
    const body = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) return { ok: false, reasonCode: `HTTP_${response.status}` };
    return { ok: true, result: body };
  } catch {
    return { ok: false, reasonCode: "SERVICE_UNAVAILABLE" };
  }
}
