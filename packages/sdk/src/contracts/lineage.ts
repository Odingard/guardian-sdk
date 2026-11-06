// Generated file — do not edit.
import { z } from "zod";

import { canonicalJson } from "./canonical-json.js";
import { sha256Text } from "./digest.js";
import {
  DataObjectIdSchema,
  LineageEventIdSchema,
  PrincipalIdSchema,
  RequestIdSchema,
} from "./identifiers.js";

/**
 * guardian.lineage.v1 — derived-data lineage contract.
 *
 * Every data object records a human/policy-declared classification plus the
 * lineage that produced it (sources, derivations, declared transformation
 * records). Propagation is pure and deterministic:
 *
 *   effectiveClassification(object) =
 *     the recorded resultClassification of the object's declared
 *     transformation, when one exists;
 *     otherwise the maximum of its own declared classification and the
 *     effective classification of every recorded source.
 *
 * A model/agent assertion NEVER changes classification — the only path to a
 * narrower result is a declared transformation record bound into the stored
 * object (and into the material digest of the action that registered it).
 * Missing lineage for a classified source fails closed.
 */

export const LINEAGE_CONTRACT_SCHEMA = "guardian.lineage.v1";

/** Ordered data classification lattice (lowest → highest). */
export const DataClassificationSchema = z.enum([
  "public",
  "internal",
  "pii",
  "phi",
  "financial",
  "credential",
  "confidential",
]);
export type DataClassification = z.infer<typeof DataClassificationSchema>;

export const CLASSIFICATION_RANK: Record<DataClassification, number> = {
  public: 0,
  internal: 1,
  pii: 2,
  phi: 3,
  financial: 4,
  credential: 5,
  confidential: 6,
};

export function maxClassification(
  a: DataClassification,
  b: DataClassification,
): DataClassification {
  return CLASSIFICATION_RANK[a] >= CLASSIFICATION_RANK[b] ? a : b;
}

export function classificationExceeds(
  value: DataClassification,
  ceiling: DataClassification,
): boolean {
  return CLASSIFICATION_RANK[value] > CLASSIFICATION_RANK[ceiling];
}

export const DataSensitivitySchema = z.enum(["low", "moderate", "high"]);
export type DataSensitivity = z.infer<typeof DataSensitivitySchema>;

/** A declared, policy-defined transformation record. */
export const DataTransformationSchema = z
  .object({
    /** Declared transform type, e.g. "redact", "last4", "tokenize". */
    type: z.string().trim().min(1).max(64),
    /** Recorded classification the transform maps the data to. */
    resultClassification: DataClassificationSchema,
  })
  .strict();
export type DataTransformation = z.infer<typeof DataTransformationSchema>;

/** Upstream reference: another data object or the action that produced it. */
export const DataSourceRefSchema = z.union([
  DataObjectIdSchema,
  RequestIdSchema,
]);
export type DataSourceRef = z.infer<typeof DataSourceRefSchema>;

export const DataObjectSchema = z
  .object({
    schema: z.literal(LINEAGE_CONTRACT_SCHEMA),
    dataObjectId: DataObjectIdSchema,
    owner: PrincipalIdSchema,
    classification: DataClassificationSchema,
    sources: z.array(DataSourceRefSchema).max(64).default([]),
    derivations: z.array(DataObjectIdSchema).max(64).default([]),
    transformations: z.array(DataTransformationSchema).max(16).default([]),
    sensitivity: DataSensitivitySchema,
    authorizedUses: z
      .array(z.string().trim().min(1).max(64))
      .max(64)
      .default([]),
    authorizedDisclosures: z
      .array(z.string().trim().min(1).max(64))
      .max(64)
      .default([]),
    retentionSeconds: z.number().int().positive().optional(),
    expiryEpochMs: z.number().int().positive().optional(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type DataObject = z.infer<typeof DataObjectSchema>;

/** Lineage policy declared on guardian.intent.v1 (`lineage` field). */
export const LineagePolicySchema = z
  .object({
    /** Deny when the effective classification of a referenced object exceeds this. */
    maxClassification: DataClassificationSchema.optional(),
    /** Force approval when the effective classification exceeds this. */
    requireApprovalAbove: DataClassificationSchema.optional(),
  })
  .strict();
export type LineagePolicy = z.infer<typeof LineagePolicySchema>;

export const LineageEventKindSchema = z.enum([
  "derive",
  "transform",
  "export",
  "share",
  "violation",
]);
export type LineageEventKind = z.infer<typeof LineageEventKindSchema>;

export const LineageEventSchema = z
  .object({
    lineageEventId: LineageEventIdSchema,
    dataObjectId: DataObjectIdSchema,
    kind: LineageEventKindSchema,
    payload: z.record(z.string(), z.unknown()),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type LineageEvent = z.infer<typeof LineageEventSchema>;

export type LineageResolution =
  | {
      ok: true;
      effectiveClassification: DataClassification;
      sourceRefs: readonly DataSourceRef[];
      expired: boolean;
    }
  | { ok: false; reason: "missing"; dataObjectId: string }
  | { ok: false; reason: "cycle"; dataObjectId: string };

const MAX_LINEAGE_DEPTH = 16;

/**
 * Resolve the effective classification of a data object over its recorded
 * lineage. `resolve` is the read-only data-object port; it must return null
 * for unrecorded ids so missing lineage fails closed.
 */
export function effectiveClassification(
  object: DataObject,
  resolve: (dataObjectId: string) => DataObject | null | undefined,
  nowEpochMs: number,
): LineageResolution {
  const resolved = new Map<string, LineageResolution>();
  const resolveId = (
    id: string,
    depth: number,
    trail: ReadonlySet<string>,
  ): LineageResolution => {
    if (trail.has(id)) {
      return { ok: false, reason: "cycle", dataObjectId: id };
    }
    const cached = resolved.get(id);
    if (cached !== undefined && depth > 0) return cached;
    const current = resolve(id);
    if (current === null || current === undefined) {
      const missing: LineageResolution = {
        ok: false,
        reason: "missing",
        dataObjectId: id,
      };
      resolved.set(id, missing);
      return missing;
    }
    if (depth >= MAX_LINEAGE_DEPTH) {
      return { ok: false, reason: "cycle", dataObjectId: id };
    }
    let effective: DataClassification = current.classification;
    const sourceRefs: DataSourceRef[] = [];
    for (const ref of current.sources) {
      sourceRefs.push(ref);
      if (!ref.startsWith("dobj_")) continue;
      const child = resolveId(ref, depth + 1, new Set([...trail, id]));
      if (!child.ok) return child;
      effective = maxClassification(effective, child.effectiveClassification);
    }
    const declaredTransform = current.transformations.at(-1);
    if (declaredTransform !== undefined) {
      effective = declaredTransform.resultClassification;
    }
    const expired =
      current.expiryEpochMs !== undefined &&
      current.expiryEpochMs <= nowEpochMs;
    const result: LineageResolution = {
      ok: true,
      effectiveClassification: effective,
      sourceRefs,
      expired,
    };
    resolved.set(id, result);
    return result;
  };
  return resolveId(object.dataObjectId, 0, new Set());
}

/**
 * Async variant of `effectiveClassification` for the gateway: resolves the
 * root object through the injected read-only port, then walks upstream.
 * Missing lineage for a classified source fails closed ("missing").
 */
export async function resolveDataObjectLineage(
  dataObjectId: string,
  get: (id: string) => Promise<DataObject | null | undefined>,
  nowEpochMs: number,
): Promise<LineageResolution> {
  const root = await get(dataObjectId).catch(() => null);
  if (root === null || root === undefined) {
    return { ok: false, reason: "missing", dataObjectId };
  }
  const cache = new Map<string, DataObject>([[dataObjectId, root]]);
  const missing = new Set<string>();
  for (let round = 0; round <= MAX_LINEAGE_DEPTH; round += 1) {
    let fetched = false;
    const resolution = effectiveClassification(
      root,
      (id) => (missing.has(id) ? null : (cache.get(id) ?? null)),
      nowEpochMs,
    );
    if (resolution.ok || resolution.reason !== "missing") {
      return resolution;
    }
    const wanted = resolution.dataObjectId;
    if (!missing.has(wanted) && !cache.has(wanted)) {
      const object = await get(wanted).catch(() => null);
      if (object === null || object === undefined) {
        missing.add(wanted);
      } else {
        cache.set(wanted, object);
      }
      fetched = true;
    }
    if (!fetched) return resolution;
  }
  return { ok: false, reason: "cycle", dataObjectId };
}

export const LineageMatchOutcomeSchema = z
  .object({
    dataObjectId: DataObjectIdSchema,
    effectiveClassification: DataClassificationSchema,
    effect: z.enum(["allowed", "require_approval", "deny"]),
    expired: z.boolean(),
  })
  .strict();
export type LineageMatchOutcome = z.infer<typeof LineageMatchOutcomeSchema>;

/**
 * Evaluate a declared lineage policy over resolved objects. Pure: reports
 * deny | require_approval | allowed with deterministic rule refs and never
 * mutates authority.
 */
export function evaluateLineagePolicy(
  policy: LineagePolicy | undefined,
  resolved: readonly {
    dataObjectId: string;
    resolution: LineageResolution;
  }[],
):
  | { verdict: "deny"; ruleId: string; outcomes: LineageMatchOutcome[] }
  | {
      verdict: "require_approval";
      ruleId: string;
      outcomes: LineageMatchOutcome[];
    }
  | { verdict: "allowed"; outcomes: LineageMatchOutcome[] } {
  const outcomes: LineageMatchOutcome[] = [];
  let denyRule: string | null = null;
  let approvalRule: string | null = null;
  for (const { dataObjectId, resolution } of resolved) {
    const id = DataObjectIdSchema.parse(dataObjectId);
    if (!resolution.ok) {
      outcomes.push({
        dataObjectId: id,
        effectiveClassification: "confidential",
        effect: "deny",
        expired: false,
      });
      denyRule ??= `LINEAGE_MISSING:${id}`;
      continue;
    }
    let effect: LineageMatchOutcome["effect"] = "allowed";
    if (resolution.expired) {
      effect = "deny";
      denyRule ??= `LINEAGE_EXPIRED:${id}`;
    } else if (
      policy?.maxClassification !== undefined &&
      classificationExceeds(
        resolution.effectiveClassification,
        policy.maxClassification,
      )
    ) {
      effect = "deny";
      denyRule ??= `LINEAGE_DENIED:${id}`;
    } else if (
      policy?.requireApprovalAbove !== undefined &&
      classificationExceeds(
        resolution.effectiveClassification,
        policy.requireApprovalAbove,
      )
    ) {
      effect = "require_approval";
      approvalRule ??= `LINEAGE_APPROVAL:${id}`;
    }
    outcomes.push({
      dataObjectId: id,
      effectiveClassification: resolution.effectiveClassification,
      effect,
      expired: resolution.expired,
    });
  }
  if (denyRule !== null) {
    return { verdict: "deny", ruleId: denyRule, outcomes };
  }
  if (approvalRule !== null) {
    return { verdict: "require_approval", ruleId: approvalRule, outcomes };
  }
  return { verdict: "allowed", outcomes };
}

/** Deterministic id for a data object registered by a derive/transform action. */
export function derivedDataObjectId(input: {
  tenantId: string;
  actionRef: string;
}): string {
  return `dobj_${sha256Text(
    canonicalJson({ kind: "data-object", ...input }),
  ).slice(0, 48)}`;
}

/** Deterministic id for a recorded lineage event row. */
export function lineageEventId(input: {
  tenantId: string;
  actionRef: string;
  dataObjectId: string;
  kind: LineageEventKind;
}): string {
  return `lev_${sha256Text(
    canonicalJson({ eventType: "lineage-event", ...input }),
  ).slice(0, 48)}`;
}
