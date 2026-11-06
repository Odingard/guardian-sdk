// Generated file — do not edit.
import { createPublicKey, verify as edVerify } from "node:crypto";

import { z } from "zod";

import {
  ActionTypeSchema,
  AgentInterfaceSchema,
  EpochMillisecondsSchema,
  ResourceRefSchema,
} from "./authority.js";

const CentsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
import { TrustedRuntimeLevelSchema, TRUSTED_RUNTIME_RANK } from "./runtime.js";
import {
  EnforcementAssuranceLevelSchema,
  ENFORCEMENT_ASSURANCE_RANK,
} from "./assurance.js";
import { canonicalSha256 } from "./digest.js";
import { TenantIdSchema } from "./identifiers.js";

/**
 * guardian.sources.v1 — authority sources and policy-source
 * precedence.
 *
 * An authority source is a registered pack of constraints contributed by a
 * party whose authority intersects with the principal's: a human, family,
 * resource owner, organization, counterparty, jurisdiction, safety policy,
 * provider, or device policy. Precedence is deterministic intersection —
 * the strongest restriction wins per dimension and the result can only
 * NARROW the principal's authority, never enlarge it. Packs from
 * mandatory kinds (jurisdiction, safety_policy, or any pack flagged
 * mandatory) require trusted provenance and versioning: an unprovenanced,
 * stale, or unsigned pack fails closed and is never applied.
 */

export const SOURCES_CONTRACT_SCHEMA = "guardian.sources.v1";

export const AuthoritySourceKindSchema = z.enum([
  "human",
  "family",
  "resource_owner",
  "organization",
  "counterparty",
  "jurisdiction",
  "safety_policy",
  "provider",
  "device_policy",
]);
export type AuthoritySourceKind = z.infer<typeof AuthoritySourceKindSchema>;

/** Source kinds whose packs are mandatory-rule packs. */
export const MANDATORY_SOURCE_KINDS: readonly AuthoritySourceKind[] = [
  "jurisdiction",
  "safety_policy",
] as const;

export const SourceProvenanceSchema = z
  .object({
    issuer: z.string().trim().min(1).max(128),
    version: z.number().int().positive().safe(),
    registeredAtEpochMs: EpochMillisecondsSchema,
  })
  .strict();
export type SourceProvenance = z.infer<typeof SourceProvenanceSchema>;

/**
 * Declarative constraints one source contributes. Every field narrows in
 * exactly one direction under intersection; absent means unconstrained on
 * that dimension.
 */
export const SourceConstraintsSchema = z
  .object({
    /** ∩ — the action set the principal may use shrinks to this set. */
    allowedActions: z.array(ActionTypeSchema).min(1).max(64).optional(),
    /** ∪ — always denied regardless of other sources. */
    deniedActions: z.array(ActionTypeSchema).min(1).max(64).optional(),
    /** ∩ — the resources the principal may touch shrink to this set. */
    allowedResources: z.array(ResourceRefSchema).min(1).max(256).optional(),
    /** ∩ — the interfaces the principal may act over shrink to this set. */
    allowedInterfaces: z.array(AgentInterfaceSchema).min(1).max(8).optional(),
    /** min — the smallest per-request value cap wins. */
    maxValueCents: CentsSchema.optional(),
    /** min — the smallest per-request use cap wins. */
    maxUses: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    /** max — the strongest required trusted-runtime level wins. */
    minRuntimeLevel: TrustedRuntimeLevelSchema.optional(),
    /** max — the strongest required enforcement-assurance level wins. */
    minAssuranceLevel: EnforcementAssuranceLevelSchema.optional(),
    /** max — the largest required approval quorum wins. */
    requiredApprovals: z.number().int().min(1).max(8).optional(),
  })
  .strict();
export type SourceConstraints = z.infer<typeof SourceConstraintsSchema>;

export const SourceSignatureSchema = z
  .object({
    algorithm: z.literal("ed25519"),
    /** Base64 signature over sourcePackSigningDigest of the signed fields. */
    value: z
      .string()
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .max(256),
  })
  .strict();
export type SourceSignature = z.infer<typeof SourceSignatureSchema>;

export const AuthoritySourcePackSchema = z
  .object({
    schema: z.literal(SOURCES_CONTRACT_SCHEMA),
    sourceId: z.string().trim().min(1).max(128),
    tenantId: TenantIdSchema,
    kind: AuthoritySourceKindSchema,
    /** True marks a mandatory-rule pack even outside the mandatory kinds. */
    mandatory: z.boolean().optional(),
    provenance: SourceProvenanceSchema,
    constraints: SourceConstraintsSchema,
    status: z.enum(["active", "revoked"]),
    version: z.number().int().positive().safe(),
    signature: SourceSignatureSchema.optional(),
    createdAtEpochMs: EpochMillisecondsSchema,
    updatedAtEpochMs: EpochMillisecondsSchema,
  })
  .strict()
  .superRefine((pack, context) => {
    if (pack.updatedAtEpochMs < pack.createdAtEpochMs) {
      context.addIssue({
        code: "custom",
        message: "updated time cannot precede created time",
        path: ["updatedAtEpochMs"],
      });
    }
  });
export type AuthoritySourcePack = z.infer<typeof AuthoritySourcePackSchema>;

/** Deployment trust policy: which issuers may contribute packs and how they sign. */
export const SourceTrustPolicySchema = z
  .object({
    trustedIssuers: z
      .array(
        z
          .object({
            issuer: z.string().trim().min(1).max(128),
            /** PEM ed25519 public key; mandatory packs from this issuer require it. */
            publicKeyPem: z.string().min(1).max(4_096).optional(),
            /** Lowest pack provenance version still accepted from this issuer. */
            minVersion: z.number().int().positive().safe().optional(),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();
export type SourceTrustPolicy = z.infer<typeof SourceTrustPolicySchema>;

export function isMandatorySource(pack: AuthoritySourcePack): boolean {
  return pack.mandatory === true || MANDATORY_SOURCE_KINDS.includes(pack.kind);
}

/** The canonical digest a pack signature covers (everything except the signature). */
export function sourcePackSigningDigest(
  pack: Pick<
    AuthoritySourcePack,
    | "schema"
    | "sourceId"
    | "tenantId"
    | "kind"
    | "mandatory"
    | "provenance"
    | "constraints"
    | "version"
  >,
): string {
  return canonicalSha256({
    domain: "odingard.guardian.source-pack.v1",
    pack: {
      schema: pack.schema,
      sourceId: pack.sourceId,
      tenantId: pack.tenantId,
      kind: pack.kind,
      mandatory: pack.mandatory ?? false,
      provenance: pack.provenance,
      constraints: pack.constraints,
      version: pack.version,
    },
  });
}

export function verifySourceSignature(
  pack: AuthoritySourcePack,
  publicKeyPem: string,
): boolean {
  if (pack.signature === undefined) return false;
  try {
    const key = createPublicKey(publicKeyPem);
    return edVerify(
      null,
      Buffer.from(sourcePackSigningDigest(pack), "utf8"),
      key,
      Buffer.from(pack.signature.value, "base64"),
    );
  } catch {
    return false;
  }
}

export type ProvenanceCheck =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "UNTRUSTED_ISSUER"
        | "STALE_VERSION"
        | "UNSIGNED_SOURCE"
        | "INVALID_SIGNATURE";
    };

/**
 * Trusted provenance + versioning. A pack is established only when its
 * issuer is trusted, its provenance version meets the issuer floor, and its
 * signature verifies against the issuer's configured key. A mandatory pack
 * with no verifiable signature (or no issuer key at all) fails closed.
 */
export function verifySourceProvenance(
  pack: AuthoritySourcePack,
  trustPolicy: SourceTrustPolicy,
): ProvenanceCheck {
  const issuer = trustPolicy.trustedIssuers.find(
    (entry) => entry.issuer === pack.provenance.issuer,
  );
  if (issuer === undefined) {
    return { ok: false, reason: "UNTRUSTED_ISSUER" };
  }
  if (
    issuer.minVersion !== undefined &&
    pack.provenance.version < issuer.minVersion
  ) {
    return { ok: false, reason: "STALE_VERSION" };
  }
  if (issuer.publicKeyPem !== undefined) {
    return verifySourceSignature(pack, issuer.publicKeyPem)
      ? { ok: true }
      : {
          ok: false,
          reason:
            pack.signature === undefined
              ? "UNSIGNED_SOURCE"
              : "INVALID_SIGNATURE",
        };
  }
  // Issuer trusted without a key: provenance-only packs pass for
  // non-mandatory kinds; mandatory packs must be signed, so they fail closed.
  if (isMandatorySource(pack)) {
    return { ok: false, reason: "UNSIGNED_SOURCE" };
  }
  return { ok: true };
}

function intersectOpt<T>(
  values: readonly (readonly T[] | undefined)[],
): T[] | undefined {
  const declared = values.filter(
    (value): value is readonly T[] => value !== undefined,
  );
  if (declared.length === 0) return undefined;
  const [first, ...rest] = declared;
  return (first as T[]).filter((entry) =>
    rest.every((set) => set.includes(entry)),
  );
}

/**
 * Deterministic intersection: the strongest restriction wins per
 * dimension. The result can never exceed what any contributing pack allows.
 */
export function intersectSourceConstraints(
  packs: readonly Pick<AuthoritySourcePack, "constraints">[],
): SourceConstraints {
  const sets = packs.map((pack) => pack.constraints);
  const deniedActions = [
    ...new Set(sets.flatMap((set) => set.deniedActions ?? [])),
  ].sort();
  const maxValue = sets
    .map((set) => set.maxValueCents)
    .filter((v): v is number => v !== undefined);
  const maxUses = sets
    .map((set) => set.maxUses)
    .filter((v): v is number => v !== undefined);
  const runtime = sets
    .map((set) => set.minRuntimeLevel)
    .filter((v): v is NonNullable<typeof v> => v !== undefined)
    .sort((a, b) => TRUSTED_RUNTIME_RANK[b] - TRUSTED_RUNTIME_RANK[a]);
  const assurance = sets
    .map((set) => set.minAssuranceLevel)
    .filter((v): v is NonNullable<typeof v> => v !== undefined)
    .sort(
      (a, b) => ENFORCEMENT_ASSURANCE_RANK[b] - ENFORCEMENT_ASSURANCE_RANK[a],
    );
  const approvals = sets
    .map((set) => set.requiredApprovals)
    .filter((v): v is number => v !== undefined);
  const allowedActions = intersectOpt(sets.map((set) => set.allowedActions));
  const allowedResources = intersectOpt(
    sets.map((set) => set.allowedResources),
  );
  const allowedInterfaces = intersectOpt(
    sets.map((set) => set.allowedInterfaces),
  );
  return {
    ...(allowedActions === undefined
      ? {}
      : { allowedActions: [...allowedActions].sort() }),
    ...(deniedActions.length === 0 ? {} : { deniedActions }),
    ...(allowedResources === undefined
      ? {}
      : { allowedResources: [...allowedResources].sort() }),
    ...(allowedInterfaces === undefined
      ? {}
      : { allowedInterfaces: [...allowedInterfaces].sort() }),
    ...(maxValue.length === 0 ? {} : { maxValueCents: Math.min(...maxValue) }),
    ...(maxUses.length === 0 ? {} : { maxUses: Math.min(...maxUses) }),
    ...(runtime.length === 0 ? {} : { minRuntimeLevel: runtime[0] }),
    ...(assurance.length === 0 ? {} : { minAssuranceLevel: assurance[0] }),
    ...(approvals.length === 0
      ? {}
      : { requiredApprovals: Math.max(...approvals) }),
  };
}

export type AppliedAuthoritySources = Readonly<{
  applied: readonly string[];
  rejected: readonly Readonly<{ sourceId: string; reason: string }>[];
  constraints: SourceConstraints;
}>;

export type AuthoritySourcesOutcome =
  | { ok: true; sources: AppliedAuthoritySources }
  | { ok: false; reasonCode: string };

/**
 * Establish and apply declared source packs. Tenant-mismatched, revoked,
 * malformed, or unprovenanced packs are never applied; a mandatory pack that
 * cannot be established fails the whole evaluation closed.
 */
export function applyAuthoritySources(input: {
  packs: readonly AuthoritySourcePack[];
  trustPolicy: SourceTrustPolicy;
  tenantId: string;
}): AuthoritySourcesOutcome {
  const applied: string[] = [];
  const rejected: { sourceId: string; reason: string }[] = [];
  const usable: AuthoritySourcePack[] = [];
  for (const pack of input.packs) {
    const rejectedReason = (() => {
      if (pack.tenantId !== input.tenantId) return "TENANT_MISMATCH";
      if (pack.status !== "active") return "SOURCE_REVOKED";
      const provenance = verifySourceProvenance(pack, input.trustPolicy);
      return provenance.ok ? null : provenance.reason;
    })();
    if (rejectedReason !== null) {
      rejected.push({ sourceId: pack.sourceId, reason: rejectedReason });
      if (isMandatorySource(pack)) {
        return {
          ok: false,
          reasonCode: `SOURCE_MANDATORY_UNTRUSTED:${rejectedReason}`,
        };
      }
      continue;
    }
    applied.push(pack.sourceId);
    usable.push(pack);
  }
  applied.sort();
  return {
    ok: true,
    sources: {
      applied,
      rejected,
      constraints: intersectSourceConstraints(usable),
    },
  };
}
