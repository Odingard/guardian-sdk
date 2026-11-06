// Generated file — do not edit.
import { z } from "zod";

import { sha256Text } from "./digest.js";
import { ConnectionIdSchema, DataObjectIdSchema } from "./identifiers.js";
import {
  DataClassificationSchema,
  DataTransformationSchema,
} from "./lineage.js";
import {
  CounterpartyTokenSchema,
  FilePathSchema,
  filePathWithinAllowlist,
  isCanonicalFilePath,
} from "./files.js";

/**
 * Protected data broker. The adapter injects protected values at
 * execution time; the agent never receives reusable plaintext. The catalog
 * below is declarative (which fields are protected, per connection /
 * principal) — it is not a DLP or classification engine.
 */

export const PROTECTED_FIELD_REF_MAX_LENGTH = 64;
export const PROTECTED_VALUE_MAX_LENGTH = 4_096;
export const PROTECTED_CATALOG_MAX_ENTRIES = 128;
export const PROTECTED_USE_SINKS_MAX_ENTRIES = 16;
export const PROTECTED_DISCLOSE_TARGETS_MAX_ENTRIES = 32;

export const ProtectedFieldRefSchema = z
  .string()
  .min(1)
  .max(PROTECTED_FIELD_REF_MAX_LENGTH)
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/u,
    "field refs are lowercase tokens (no traversal, no globs)",
  );

export const ProtectedUseSinkSchema = z
  .object({
    /** The file connection whose store receives the injected value. */
    connectionId: ConnectionIdSchema,
    /** Canonical path prefix the agent's sink path must sit under. */
    pathPrefix: z
      .string()
      .min(1)
      .max(512)
      .refine(
        (value) =>
          isCanonicalFilePath(value) ||
          (value.startsWith("/") &&
            !value.endsWith("/") &&
            value.length > 1 &&
            isCanonicalFilePath(value.slice(0, -1))),
        "useSink pathPrefix must be a canonical path or directory prefix",
      ),
  })
  .strict();
export type ProtectedUseSink = z.infer<typeof ProtectedUseSinkSchema>;

/** A declared protected field on one connection (per principal). */
export const ProtectedCatalogEntrySchema = z
  .object({
    fieldRef: ProtectedFieldRefSchema,
    label: z.string().min(1).max(200),
    /** Safe preview for slips/receipts — never the plaintext. */
    maskedPreview: z.string().max(120),
    allowUse: z.boolean(),
    allowView: z.boolean(),
    allowPersist: z.boolean(),
    /** Declared sinks `protected_data.use` may inject into. */
    useSinks: z
      .array(ProtectedUseSinkSchema)
      .max(PROTECTED_USE_SINKS_MAX_ENTRIES),
    /** Declared counterparties `protected_data.disclose` may send to. */
    discloseTargets: z
      .array(CounterpartyTokenSchema)
      .max(PROTECTED_DISCLOSE_TARGETS_MAX_ENTRIES),
  })
  .strict();
export type ProtectedCatalogEntry = z.infer<typeof ProtectedCatalogEntrySchema>;

export const ProtectedCatalogSchema = z
  .array(ProtectedCatalogEntrySchema)
  .max(PROTECTED_CATALOG_MAX_ENTRIES)
  .refine(
    (entries) =>
      new Set(entries.map((entry) => entry.fieldRef)).size === entries.length,
    "catalog field refs must be unique",
  );
export type ProtectedCatalog = readonly ProtectedCatalogEntry[];

export const PROTECTED_USE_SCHEMA = "odingard.guardian.protected-data.use.v1";
export const PROTECTED_VIEW_SCHEMA = "odingard.guardian.protected-data.view.v1";
export const PROTECTED_DISCLOSE_SCHEMA =
  "odingard.guardian.protected-data.disclose.v1";
export const PROTECTED_PERSIST_SCHEMA =
  "odingard.guardian.protected-data.persist.v1";

export const ProtectedUseParametersV1Schema = z
  .object({
    schema: z.literal(PROTECTED_USE_SCHEMA),
    connectionId: ConnectionIdSchema,
    fieldRef: ProtectedFieldRefSchema,
    /** Where the adapter injects the resolved value. Agent sees no plaintext. */
    sink: z
      .object({
        connectionId: ConnectionIdSchema,
        path: FilePathSchema,
      })
      .strict(),
  })
  .strict();
export type ProtectedUseParametersV1 = z.infer<
  typeof ProtectedUseParametersV1Schema
>;

export const ProtectedViewParametersV1Schema = z
  .object({
    schema: z.literal(PROTECTED_VIEW_SCHEMA),
    connectionId: ConnectionIdSchema,
    fieldRef: ProtectedFieldRefSchema,
  })
  .strict();
export type ProtectedViewParametersV1 = z.infer<
  typeof ProtectedViewParametersV1Schema
>;

export const ProtectedDiscloseParametersV1Schema = z
  .object({
    schema: z.literal(PROTECTED_DISCLOSE_SCHEMA),
    connectionId: ConnectionIdSchema,
    fieldRef: ProtectedFieldRefSchema,
    counterparty: CounterpartyTokenSchema,
  })
  .strict();
export type ProtectedDiscloseParametersV1 = z.infer<
  typeof ProtectedDiscloseParametersV1Schema
>;

export const ProtectedPersistParametersV1Schema = z
  .object({
    schema: z.literal(PROTECTED_PERSIST_SCHEMA),
    connectionId: ConnectionIdSchema,
    fieldRef: ProtectedFieldRefSchema,
    value: z
      .string()
      .min(1)
      .max(PROTECTED_VALUE_MAX_LENGTH)
      .refine(
        (value) => value.normalize("NFC") === value,
        "protected value must already use NFC normalization",
      ),
  })
  .strict();
export type ProtectedPersistParametersV1 = z.infer<
  typeof ProtectedPersistParametersV1Schema
>;

/* Derived-data operations (guardian.lineage.v1). Each carries
 * the recorded source data objects; derive/transform register the NEW
 * derived object with sources recorded, export discloses under the resolved
 * effective classification. resultClassification/transformation are
 * declared records bound into the material digest — they can only apply a
 * declared transformation mapping, never a bare model assertion. */

export const PROTECTED_DERIVE_SCHEMA =
  "odingard.guardian.protected-data.derive.v1";
export const PROTECTED_TRANSFORM_SCHEMA =
  "odingard.guardian.protected-data.transform.v1";
export const PROTECTED_EXPORT_SCHEMA =
  "odingard.guardian.protected-data.export.v1";

export const ProtectedDeriveParametersV1Schema = z
  .object({
    schema: z.literal(PROTECTED_DERIVE_SCHEMA),
    connectionId: ConnectionIdSchema,
    dataObjectIds: z.array(DataObjectIdSchema).min(1).max(16),
    resultClassification: DataClassificationSchema.optional(),
    transformation: DataTransformationSchema.optional(),
  })
  .strict();
export type ProtectedDeriveParametersV1 = z.infer<
  typeof ProtectedDeriveParametersV1Schema
>;

export const ProtectedTransformParametersV1Schema = z
  .object({
    schema: z.literal(PROTECTED_TRANSFORM_SCHEMA),
    connectionId: ConnectionIdSchema,
    dataObjectIds: z.array(DataObjectIdSchema).min(1).max(16),
    resultClassification: DataClassificationSchema.optional(),
    transformation: DataTransformationSchema.optional(),
  })
  .strict();
export type ProtectedTransformParametersV1 = z.infer<
  typeof ProtectedTransformParametersV1Schema
>;

export const ProtectedExportParametersV1Schema = z
  .object({
    schema: z.literal(PROTECTED_EXPORT_SCHEMA),
    connectionId: ConnectionIdSchema,
    dataObjectIds: z.array(DataObjectIdSchema).min(1).max(16),
    counterparty: CounterpartyTokenSchema.optional(),
  })
  .strict();
export type ProtectedExportParametersV1 = z.infer<
  typeof ProtectedExportParametersV1Schema
>;

export function protectedDeriveVerificationProjection(
  input: ProtectedDeriveParametersV1,
): unknown {
  const params = ProtectedDeriveParametersV1Schema.parse(input);
  return Object.freeze({
    domain: "odingard.guardian.protected-derive-projection.v1" as const,
    connectionId: params.connectionId,
    dataObjectIds: params.dataObjectIds,
    resultClassification: params.resultClassification ?? null,
    transformation: params.transformation ?? null,
  });
}

export function protectedTransformVerificationProjection(
  input: ProtectedTransformParametersV1,
): unknown {
  const params = ProtectedTransformParametersV1Schema.parse(input);
  return Object.freeze({
    domain: "odingard.guardian.protected-transform-projection.v1" as const,
    connectionId: params.connectionId,
    dataObjectIds: params.dataObjectIds,
    resultClassification: params.resultClassification ?? null,
    transformation: params.transformation ?? null,
  });
}

export function protectedExportVerificationProjection(
  input: ProtectedExportParametersV1,
): unknown {
  const params = ProtectedExportParametersV1Schema.parse(input);
  return Object.freeze({
    domain: "odingard.guardian.protected-export-projection.v1" as const,
    connectionId: params.connectionId,
    dataObjectIds: params.dataObjectIds,
    counterparty: params.counterparty ?? null,
  });
}

export function protectedCatalogField(
  catalog: readonly ProtectedCatalogEntry[] | undefined,
  fieldRef: string,
): ProtectedCatalogEntry | null {
  return catalog?.find((entry) => entry.fieldRef === fieldRef) ?? null;
}

/** use sink is authorized only by an exact declared sink binding. */
export function protectedSinkWithinUseSinks(
  sink: { connectionId: string; path: string },
  useSinks: readonly ProtectedUseSink[],
): boolean {
  for (const entry of useSinks) {
    if (entry.connectionId !== sink.connectionId) continue;
    if (entry.pathPrefix.endsWith("/")) {
      if (sink.path.startsWith(entry.pathPrefix)) return true;
    } else if (
      sink.path === entry.pathPrefix ||
      sink.path.startsWith(`${entry.pathPrefix}/`)
    ) {
      return true;
    }
  }
  return false;
}

export function protectedUseVerificationProjection(
  input: ProtectedUseParametersV1,
): unknown {
  const params = ProtectedUseParametersV1Schema.parse(input);
  return Object.freeze({
    domain: "odingard.guardian.protected-use-projection.v1" as const,
    connectionId: params.connectionId,
    fieldRef: params.fieldRef,
    sinkConnectionId: params.sink.connectionId,
    sinkPath: params.sink.path,
  });
}

export function protectedViewVerificationProjection(
  input: ProtectedViewParametersV1,
): unknown {
  const params = ProtectedViewParametersV1Schema.parse(input);
  return Object.freeze({
    domain: "odingard.guardian.protected-view-projection.v1" as const,
    connectionId: params.connectionId,
    fieldRef: params.fieldRef,
  });
}

export function protectedDiscloseVerificationProjection(
  input: ProtectedDiscloseParametersV1,
): unknown {
  const params = ProtectedDiscloseParametersV1Schema.parse(input);
  return Object.freeze({
    domain: "odingard.guardian.protected-disclose-projection.v1" as const,
    connectionId: params.connectionId,
    fieldRef: params.fieldRef,
    counterparty: params.counterparty,
  });
}

export function protectedPersistVerificationProjection(
  input: ProtectedPersistParametersV1,
): unknown {
  const params = ProtectedPersistParametersV1Schema.parse(input);
  return Object.freeze({
    domain: "odingard.guardian.protected-persist-projection.v1" as const,
    connectionId: params.connectionId,
    fieldRef: params.fieldRef,
    valueDigest: sha256Text(params.value),
  });
}

// filePathWithinAllowlist re-exported for adapter/binding callers.
export { filePathWithinAllowlist };
