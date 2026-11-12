// ES256 JWS, JWK thumbprints and the SD-JWT subset AP2 v0.2 uses
// (RFC 7515, RFC 7638, RFC 9901, and the AP2 Delegate SD-JWT chain).
// Node built-ins only. Nothing here holds a private key.
import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";

import { MAX_TOKEN_LENGTH, SD_ALG } from "./constants.js";
import { b64urlDecode, b64urlEncode, isPlainObject, sha256b64url } from "./util.js";

/** An EC P-256 public key as a JWK. Private parts (`d`) are refused. */
export type PublicJwk = Readonly<{
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  kid?: string;
  alg?: string;
  use?: string;
}>;

const COORD_RE = /^[A-Za-z0-9_-]{43}$/;

/** A copy of `jwk` with only public members, or null if it is not a P-256 public key. */
export function publicJwkOf(jwk: unknown): PublicJwk | null {
  if (!isPlainObject(jwk)) return null;
  if ("d" in jwk) return null;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") return null;
  if (typeof jwk.x !== "string" || !COORD_RE.test(jwk.x)) return null;
  if (typeof jwk.y !== "string" || !COORD_RE.test(jwk.y)) return null;
  if (jwk.alg !== undefined && jwk.alg !== "ES256") return null;
  const out: { kty: "EC"; crv: "P-256"; x: string; y: string; kid?: string } = {
    kty: "EC",
    crv: "P-256",
    x: jwk.x,
    y: jwk.y,
  };
  if (typeof jwk.kid === "string") out.kid = jwk.kid;
  return Object.freeze(out);
}

/** RFC 7638 JWK thumbprint (SHA-256, base64url) of a P-256 key. */
export function jwkThumbprint(jwk: PublicJwk): string {
  const json = `{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`;
  return createHash("sha256").update(json, "utf8").digest("base64url");
}

const keyCache = new WeakMap<PublicJwk, KeyObject>();
function keyObjectOf(jwk: PublicJwk): KeyObject {
  let key = keyCache.get(jwk);
  if (!key) {
    key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" });
    keyCache.set(jwk, key);
  }
  return key;
}

/** Verifies a raw (r||s, 64 bytes) ES256 signature over `signingInput`. */
export function verifyEs256(jwk: PublicJwk, signingInput: string, signature: Uint8Array): boolean {
  if (signature.length !== 64) return false;
  try {
    return cryptoVerify(
      "sha256",
      Buffer.from(signingInput, "ascii"),
      { key: keyObjectOf(jwk), dsaEncoding: "ieee-p1363" },
      signature,
    );
  } catch {
    return false;
  }
}

export type CompactJws = Readonly<{
  raw: string;
  signingInput: string;
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: Buffer;
}>;

/** Parses a compact JWS whose header and payload are JSON objects. Throws on anything else. */
export function parseCompactJws(raw: unknown): CompactJws {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_TOKEN_LENGTH) {
    throw new TypeError("not a compact JWS");
  }
  const parts = raw.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) throw new TypeError("not a compact JWS");
  const header = JSON.parse(b64urlDecode(parts[0]!).toString("utf8")) as unknown;
  const payload = JSON.parse(b64urlDecode(parts[1]!).toString("utf8")) as unknown;
  if (!isPlainObject(header) || !isPlainObject(payload)) throw new TypeError("not JSON objects");
  return {
    raw,
    signingInput: `${parts[0]}.${parts[1]}`,
    header,
    payload,
    signature: b64urlDecode(parts[2]!),
  };
}

/**
 * Verifies an ES256 compact JWS against any of `keys`. When the header names
 * a `kid`, only keys with that `kid` (or no `kid`) are tried. Returns the
 * key that verified, or null.
 */
export function verifyJwsWithAny(jws: CompactJws, keys: readonly PublicJwk[]): PublicJwk | null {
  if (jws.header.alg !== "ES256") return null;
  if ("crit" in jws.header || "jku" in jws.header || "jwk" in jws.header || "x5u" in jws.header) {
    return null;
  }
  const kid = typeof jws.header.kid === "string" ? jws.header.kid : undefined;
  for (const key of keys) {
    if (kid !== undefined && key.kid !== undefined && key.kid !== kid) continue;
    if (verifyEs256(key, jws.signingInput, jws.signature)) return key;
  }
  return null;
}

// ------------------------------------------------------------------ SD-JWT

export type SdJwt = Readonly<{
  /** The issuer-signed JWT. */
  jws: CompactJws;
  disclosures: readonly string[];
  /** `<jwt>~<d1>~…~`, the form `sd_hash` is computed over. */
  sdJwt: string;
  /** base64url(SHA-256(sdJwt)): what the next hop binds to. */
  sdHash: string;
}>;

/**
 * Parses one SD-JWT with no key-binding JWT (`<jwt>~<d>~…~`). A single
 * mandate only: a `~~`-joined chain is refused.
 */
export function parseSdJwt(raw: unknown): SdJwt {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_TOKEN_LENGTH) {
    throw new TypeError("not an SD-JWT");
  }
  if (raw.includes("~~")) throw new RangeError("chain");
  if (!raw.endsWith("~")) throw new TypeError("an SD-JWT without a trailing ~ (or with a KB-JWT)");
  const parts = raw.split("~");
  const jwt = parts[0]!;
  const disclosures = parts.slice(1, -1);
  if (disclosures.some((d) => d.length === 0)) throw new TypeError("empty disclosure");
  const jws = parseCompactJws(jwt);
  const sdJwt = disclosures.length > 0 ? `${jwt}~${disclosures.join("~")}~` : `${jwt}~`;
  return { jws, disclosures, sdJwt, sdHash: sha256b64url(sdJwt) };
}

type Disclosure = { digest: string; name?: string; value: unknown; used: boolean };

function readDisclosures(disclosures: readonly string[]): Map<string, Disclosure> {
  const out = new Map<string, Disclosure>();
  for (const d of disclosures) {
    const arr = JSON.parse(b64urlDecode(d).toString("utf8")) as unknown;
    if (!Array.isArray(arr) || typeof arr[0] !== "string") throw new TypeError("bad disclosure");
    const digest = sha256b64url(d);
    if (out.has(digest)) throw new TypeError("duplicate disclosure");
    if (arr.length === 2) {
      out.set(digest, { digest, value: arr[1], used: false });
    } else if (arr.length === 3) {
      const name = arr[1];
      if (typeof name !== "string" || name === "_sd" || name === "...") {
        throw new TypeError("bad disclosure name");
      }
      out.set(digest, { digest, name, value: arr[2], used: false });
    } else {
      throw new TypeError("bad disclosure");
    }
  }
  return out;
}

function resolveValue(value: unknown, disc: Map<string, Disclosure>, depth: number): unknown {
  if (depth > 32) throw new TypeError("too deep");
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const el of value) {
      if (isPlainObject(el) && Object.keys(el).length === 1 && "..." in el) {
        const digest = el["..."];
        if (typeof digest !== "string") throw new TypeError("bad array digest");
        const d = disc.get(digest);
        if (!d) continue; // undisclosed element or a decoy (RFC 9901 §4.2.5)
        if (d.used || d.name !== undefined) throw new TypeError("disclosure misuse");
        d.used = true;
        out.push(resolveValue(d.value, disc, depth + 1));
      } else {
        out.push(resolveValue(el, disc, depth + 1));
      }
    }
    return out;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "_sd") continue;
      if (k === "...") throw new TypeError("stray ... key");
      out[k] = resolveValue(v, disc, depth + 1);
    }
    const sd = value._sd;
    if (sd !== undefined) {
      if (!Array.isArray(sd)) throw new TypeError("bad _sd");
      for (const digest of sd) {
        if (typeof digest !== "string") throw new TypeError("bad _sd digest");
        const d = disc.get(digest);
        if (!d) continue; // undisclosed claim or a decoy
        if (d.used || d.name === undefined) throw new TypeError("disclosure misuse");
        if (Object.prototype.hasOwnProperty.call(out, d.name)) throw new TypeError("claim disclosed twice");
        d.used = true;
        out[d.name] = resolveValue(d.value, disc, depth + 1);
      }
    }
    return out;
  }
  return value;
}

/**
 * Resolves the issuer JWT payload of an SD-JWT against its disclosures:
 * every disclosure must be referenced exactly once, digests with no
 * disclosure are dropped (undisclosed or decoys), `_sd_alg` must be
 * sha-256 when present. Returns the resolved payload without `_sd_alg`.
 */
export function resolveSdJwtPayload(token: SdJwt): Record<string, unknown> {
  const alg = token.jws.payload._sd_alg;
  if (alg !== undefined && alg !== SD_ALG) throw new TypeError("unsupported _sd_alg");
  const disc = readDisclosures(token.disclosures);
  const { _sd_alg: _ignored, ...rest } = token.jws.payload;
  void _ignored;
  const resolved = resolveValue(rest, disc, 0) as Record<string, unknown>;
  for (const d of disc.values()) if (!d.used) throw new TypeError("unreferenced disclosure");
  return resolved;
}

/**
 * The single delegate item of a resolved AP2 mandate payload
 * (`delegate_payload: [ {...} ]`). Anything else throws.
 */
export function delegateItemOf(payload: Record<string, unknown>): Record<string, unknown> {
  const dp = payload.delegate_payload;
  if (!Array.isArray(dp) || dp.length !== 1 || !isPlainObject(dp[0])) {
    throw new TypeError("delegate_payload must hold exactly one disclosed object");
  }
  return dp[0];
}

/** A disclosure for an array element: base64url(JSON [salt, value]). */
export function arrayElementDisclosure(salt: string, value: unknown): string {
  return b64urlEncode(JSON.stringify([salt, value]));
}

/** base64url of a JSON object (a JWS header or payload segment). */
export function jsonSegment(value: Record<string, unknown>): string {
  return b64urlEncode(JSON.stringify(value));
}
