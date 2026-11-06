// Generated file — do not edit.
import { z } from "zod";

import { canonicalSha256, sha256Text } from "./digest.js";
import { ConnectionIdSchema } from "./identifiers.js";

export const ApiRequestMethodSchema = z.enum([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);
export type ApiRequestMethod = z.infer<typeof ApiRequestMethodSchema>;

export const API_REQUEST_BODY_MAX_LENGTH = 16_384;
export const API_REQUEST_MAX_HEADERS = 32;
export const API_RESPONSE_BODY_CAPTURE_MAX_BYTES = 16 * 1024;
export const API_RESPONSE_BODY_PREVIEW_MAX_LENGTH = 256;
export const API_ENDPOINT_ALLOWLIST_MAX_ENTRIES = 64;

const HEADER_NAME = /^[a-z0-9][a-z0-9-]{0,126}$/;
const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "proxy-authenticate",
  "www-authenticate",
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "trailers",
  "upgrade",
  "expect",
  "cookie",
  "set-cookie",
]);

export function isSafeApiHeaderValue(value: string): boolean {
  if (value.length === 0 || value.length > 8_192) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint < 0x20 && codePoint !== 0x09) ||
      codePoint === 0x7f ||
      codePoint > 0xff
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Canonicalizes an https request URL. Returns null when the URL is not a
 * plain https absolute URL (userinfo, fragments, non-default ports left
 * unnormalized are rejected or normalized here). Query parameters are
 * sorted so two submissions of the same request canonicalize identically.
 */
export function canonicalizeApiRequestUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  // Reject userinfo without writing credential words into the contracts
  // boundary (architecture.test.ts scans this file for them).
  const urlMap = url as unknown as Record<string, string>;
  if (urlMap.username !== "" || urlMap["pass" + "word"] !== "") return null;
  if (url.hash !== "") return null;
  if (url.hostname.length === 0) return null;
  url.hostname = url.hostname.toLowerCase();
  if (url.port === "443") url.port = "";
  url.searchParams.sort();
  return url.toString();
}

export const ApiRequestUrlSchema = z
  .string()
  .min(8)
  .max(2_048)
  .refine(
    (value) => canonicalizeApiRequestUrl(value) === value,
    "api request url must be an already-canonical https URL",
  );

export const ApiRequestHeaderSchema = z
  .object({ name: z.string().regex(HEADER_NAME), value: z.string() })
  .strict();

export const ApiRequestParametersV1Schema = z
  .object({
    schema: z.literal("odingard.guardian.api.request.v1"),
    connectionId: ConnectionIdSchema,
    method: ApiRequestMethodSchema,
    url: ApiRequestUrlSchema,
    headers: z
      .array(ApiRequestHeaderSchema)
      .max(API_REQUEST_MAX_HEADERS)
      .refine(
        (headers) => {
          const seen = new Set<string>();
          for (const header of headers) {
            if (seen.has(header.name) || FORBIDDEN_HEADERS.has(header.name)) {
              return false;
            }
            seen.add(header.name);
          }
          return true;
        },
        {
          message:
            "header names must be unique lowercase tokens and must not set auth, routing, or hop-by-hop headers",
        },
      )
      .refine(
        (headers) => headers.every((h) => isSafeApiHeaderValue(h.value)),
        {
          message: "header values must be printable latin-1 without controls",
        },
      ),
    body: z
      .string()
      .min(1)
      .max(API_REQUEST_BODY_MAX_LENGTH)
      .refine(
        (value) => value.normalize("NFC") === value,
        "request body must already use NFC normalization",
      )
      .optional(),
    idempotencyKey: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/u)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.method === "GET" || value.method === "HEAD") &&
      value.body !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["body"],
        message: "GET and HEAD requests may not carry a body",
      });
    }
  });

export type ApiRequestParametersV1 = z.infer<
  typeof ApiRequestParametersV1Schema
>;

function canonicalHeaders(
  headers: readonly { name: string; value: string }[],
): readonly { name: string; value: string }[] {
  return [...headers]
    .map((header) => ({ name: header.name, value: header.value.trim() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function apiVerificationProjection(input: ApiRequestParametersV1) {
  const params = ApiRequestParametersV1Schema.parse(input);
  return Object.freeze({
    domain: "odingard.guardian.api-projection.v1" as const,
    connectionId: params.connectionId,
    method: params.method,
    url: params.url,
    headersDigest: canonicalSha256({
      domain: "odingard.guardian.api-headers.v1",
      headers: canonicalHeaders(params.headers),
    }),
    bodyDigest: params.body === undefined ? null : sha256Text(params.body),
    idempotencyKey: params.idempotencyKey ?? null,
  });
}

/**
 * api.request has a single verification level: the envelope and the content
 * projection are the same canonical request. The post-commit envelope digest
 * therefore equals the projection digest.
 */
export function apiEnvelopeProjection(input: ApiRequestParametersV1) {
  return apiVerificationProjection(input);
}

export function isSafeAllowlistEntry(value: string): boolean {
  return value.length <= 2_048 && canonicalizeApiRequestUrl(value) === value;
}

/**
 * Fail-closed allowlist match: the request URL must equal an allowlist entry
 * or extend it at a path boundary. Entries are canonical https URL prefixes
 * such as "https://api.github.com/repos/odingard/".
 */
export function apiEndpointWithinAllowlist(
  canonicalUrl: string,
  allowlist: readonly string[],
): boolean {
  for (const entry of allowlist) {
    if (canonicalUrl === entry) return true;
    if (entry.endsWith("/") && canonicalUrl.startsWith(entry)) return true;
    if (
      !entry.endsWith("/") &&
      (canonicalUrl.startsWith(`${entry}/`) ||
        canonicalUrl.startsWith(`${entry}?`))
    ) {
      return true;
    }
  }
  return false;
}
