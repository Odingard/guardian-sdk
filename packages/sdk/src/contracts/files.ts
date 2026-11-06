// Generated file — do not edit.
import { z } from "zod";

import { sha256Text } from "./digest.js";
import { ConnectionIdSchema } from "./identifiers.js";

/**
 * Files surface. Representative read/write/share/delete through the
 * file adapter on a deterministic local file store (lowest-burden provider).
 */

export const FILE_PATH_MAX_LENGTH = 512;
export const FILE_CONTENT_MAX_LENGTH = 64_000;
export const FILE_GRANTEE_MAX_LENGTH = 256;
export const FILE_ALLOWLIST_MAX_ENTRIES = 64;

const FILE_PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/;

/**
 * Canonical file path: `/` + non-empty segments of `[A-Za-z0-9._~-]`.
 * No `.` or `..` segments, no `//`, no trailing slash, no root `/`.
 * Canonical form is required so path/share allowlist prefix checks cannot
 * be escaped by traversal or duplicate separators.
 */
export function isCanonicalFilePath(value: string): boolean {
  if (value.length < 2 || value.length > FILE_PATH_MAX_LENGTH) return false;
  if (!value.startsWith("/") || value.endsWith("/")) return false;
  if (value.includes("//")) return false;
  for (const segment of value.slice(1).split("/")) {
    if (segment === "." || segment === "..") return false;
    if (!FILE_PATH_SEGMENT.test(segment)) return false;
  }
  return true;
}

export const FilePathSchema = z
  .string()
  .min(2)
  .max(FILE_PATH_MAX_LENGTH)
  .refine(isCanonicalFilePath, "file path must be canonical posix");

/** Grantee / counterparty token: an opaque principal label (email or id). */
export const CounterpartyTokenSchema = z
  .string()
  .min(1)
  .max(FILE_GRANTEE_MAX_LENGTH)
  .regex(/^[A-Za-z0-9._~+@-]+$/u, "counterparty token charset");

export const FILE_READ_SCHEMA = "odingard.guardian.file.read.v1";
export const FILE_WRITE_SCHEMA = "odingard.guardian.file.write.v1";
export const FILE_SHARE_SCHEMA = "odingard.guardian.file.share.v1";
export const FILE_DELETE_SCHEMA = "odingard.guardian.file.delete.v1";

export const FileReadParametersV1Schema = z
  .object({
    schema: z.literal(FILE_READ_SCHEMA),
    connectionId: ConnectionIdSchema,
    path: FilePathSchema,
  })
  .strict();
export type FileReadParametersV1 = z.infer<typeof FileReadParametersV1Schema>;

export const FileWriteParametersV1Schema = z
  .object({
    schema: z.literal(FILE_WRITE_SCHEMA),
    connectionId: ConnectionIdSchema,
    path: FilePathSchema,
    content: z
      .string()
      .max(FILE_CONTENT_MAX_LENGTH)
      .refine(
        (value) => value.normalize("NFC") === value,
        "file content must already use NFC normalization",
      ),
  })
  .strict();
export type FileWriteParametersV1 = z.infer<typeof FileWriteParametersV1Schema>;

export const FileShareParametersV1Schema = z
  .object({
    schema: z.literal(FILE_SHARE_SCHEMA),
    connectionId: ConnectionIdSchema,
    path: FilePathSchema,
    grantee: CounterpartyTokenSchema,
    expiresAtEpochMs: z.number().int().positive().safe().optional(),
  })
  .strict();
export type FileShareParametersV1 = z.infer<typeof FileShareParametersV1Schema>;

export const FileDeleteParametersV1Schema = z
  .object({
    schema: z.literal(FILE_DELETE_SCHEMA),
    connectionId: ConnectionIdSchema,
    path: FilePathSchema,
  })
  .strict();
export type FileDeleteParametersV1 = z.infer<
  typeof FileDeleteParametersV1Schema
>;

/**
 * Fail-closed prefix match over canonical paths: `path` must equal an
 * allowlist entry or sit under an entry that ends with `/`. A trailing-slash
 * prefix cannot be escaped because `..` and `//` are excluded by canonical
 * form.
 */
export function filePathWithinAllowlist(
  path: string,
  allowlist: readonly string[],
): boolean {
  for (const entry of allowlist) {
    if (!isCanonicalFilePath(entry) && !entry.endsWith("/")) continue;
    if (path === entry) return true;
    if (entry.endsWith("/") && path.startsWith(entry)) return true;
    if (path.startsWith(`${entry}/`)) return true;
  }
  return false;
}

export function fileReadVerificationProjection(
  input: FileReadParametersV1,
): unknown {
  const params = FileReadParametersV1Schema.parse(input);
  return Object.freeze({
    domain: "odingard.guardian.file-read-projection.v1" as const,
    connectionId: params.connectionId,
    path: params.path,
  });
}

export function fileWriteVerificationProjection(
  input: FileWriteParametersV1,
): unknown {
  const params = FileWriteParametersV1Schema.parse(input);
  return Object.freeze({
    domain: "odingard.guardian.file-write-projection.v1" as const,
    connectionId: params.connectionId,
    path: params.path,
    contentDigest: sha256Text(params.content),
    bytes: params.content.length,
  });
}

export function fileShareVerificationProjection(
  input: FileShareParametersV1,
): unknown {
  const params = FileShareParametersV1Schema.parse(input);
  return Object.freeze({
    domain: "odingard.guardian.file-share-projection.v1" as const,
    connectionId: params.connectionId,
    path: params.path,
    grantee: params.grantee,
    expiresAtEpochMs: params.expiresAtEpochMs ?? null,
  });
}

export function fileDeleteVerificationProjection(
  input: FileDeleteParametersV1,
): unknown {
  const params = FileDeleteParametersV1Schema.parse(input);
  return Object.freeze({
    domain: "odingard.guardian.file-delete-projection.v1" as const,
    connectionId: params.connectionId,
    path: params.path,
  });
}
