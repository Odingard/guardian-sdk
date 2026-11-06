// Generated file — do not edit.
import { createPublicKey, verify as edVerify } from "node:crypto";

import { z } from "zod";

import {
  ApiRequestParametersV1Schema,
  apiEnvelopeProjection,
  apiVerificationProjection,
} from "./api.js";
import {
  ActionConnectionBinding,
  ActionDefinition,
} from "./action-registry.js";
import { canonicalJson } from "./canonical-json.js";
import { canonicalSha256 } from "./digest.js";
import {
  BindingRuleSchema,
  CLAIM_RULES_MAX,
  BINDING_RULES_MAX,
  ClaimRuleSchema,
  ResourceClaimSchema,
  evaluateBindingRules,
  evaluateClaimRules,
} from "./resource-claims.js";

/**
 * Action Pack v1 (`guardian.action.v1`).
 *
 * A signed, declarative package that defines one governed action: identity,
 * family, resource type, risk class, reversibility, material parameters,
 * required fields, approval display, verification method, compatibility,
 * provenance, review state, rollback metadata, integrity digest and a trusted
 * publisher's Ed25519 signature. Packs are inputs, never executables: nothing
 * a pack declares is interpreted inside the authority kernel. A pack
 * whose signature, integrity, publisher trust, review state, compatibility or
 * internal consistency fails is rejected at load time — the action it names
 * stays unregistered, so every proposal deterministically DENYs.
 */

export const ACTION_PACK_FORMAT = "guardian.action.v1";
export const ACTION_PACK_DOMAIN = "odingard.guardian.action-pack.v1";
export const ACTION_PACK_REGISTRY_COMPATIBILITY = 1;
export const ACTION_PACK_MAX_FIELDS = 32;
export const ACTION_PACK_MAX_DISPLAY_FIELDS = 16;
export const ACTION_PACK_MAX_PROVIDERS = 8;
export const ACTION_PACK_MAX_EVIDENCE = 16;
export const ACTION_PACK_MAX_ENUM = 64;

/** Transports a pack may bind its material parameters to. v1: api.request. */
export const ACTION_PACK_TRANSPORTS = ["api.request.v1"] as const;
export type ActionPackTransport = (typeof ACTION_PACK_TRANSPORTS)[number];

export const ActionPackActionIdSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(
    /^[a-z][a-z0-9]*(?:\.[a-z0-9]+)+$/,
    "pack action ids are lowercase dotted identifiers",
  );

export const ActionPackPublisherIdSchema = z
  .string()
  .regex(/^pub_[a-z0-9][a-z0-9-]{2,62}$/, "publisher ids are pub_-prefixed");

export const ActionPackKeyIdSchema = z
  .string()
  .regex(/^pkey_[a-f0-9]{16,64}$/, "pack key ids are pkey_<hex>");

/** RFC 8037 Ed25519 JWK (public parts only) for a trusted pack publisher. */
export const ActionPackPublisherKeySchema = z
  .object({
    kty: z.literal("OKP"),
    crv: z.literal("Ed25519"),
    kid: ActionPackKeyIdSchema,
    use: z.literal("sig"),
    alg: z.literal("EdDSA"),
    x: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43,44}$/, "x must be a base64url Ed25519 key"),
  })
  .strict();
export type ActionPackPublisherKey = z.infer<
  typeof ActionPackPublisherKeySchema
>;

/** The human-governed trust set: which publishers may sign installed packs. */
export type ActionPackTrustSet = Readonly<{
  publishers: readonly ActionPackPublisherKey[];
}>;

const ActionPackFieldTypeSchema = z.enum([
  "string",
  "integer",
  "number",
  "boolean",
  "object",
  "array",
]);

/**
 * Declarative constraint on one material field. Bounds are data the pipeline
 * evaluates deterministically — no pack-supplied logic executes.
 */
export const ActionPackFieldSchema = z
  .object({
    name: z.string().min(1).max(64),
    type: ActionPackFieldTypeSchema,
    required: z.boolean(),
    maxLength: z.number().int().positive().max(16_384).optional(),
    enum: z
      .array(z.union([z.string().max(256), z.number(), z.boolean()]))
      .max(ACTION_PACK_MAX_ENUM)
      .optional(),
    mustStartWith: z.string().max(512).optional(),
    min: z.number().safe().optional(),
    max: z.number().safe().optional(),
  })
  .strict();
export type ActionPackField = z.infer<typeof ActionPackFieldSchema>;

export const ActionPackContentSchema = z
  .object({
    actionId: ActionPackActionIdSchema,
    family: z.string().min(1).max(64),
    resourceType: z.string().min(1).max(128),
    humanLabel: z.string().min(1).max(128),
    description: z.string().min(1).max(512),
    risk: z.enum(["R0", "R1", "R2", "R3", "R4", "R5"]),
    reversibility: z.enum([
      "reversible",
      "limited",
      "difficult",
      "destructive",
      "safety-sensitive",
    ]),
    posture: z.enum(["allow", "ask", "deny"]),
    providers: z
      .array(z.string().min(1).max(64))
      .min(1)
      .max(ACTION_PACK_MAX_PROVIDERS),
    transport: z.enum(ACTION_PACK_TRANSPORTS),
    materialFields: z
      .array(ActionPackFieldSchema)
      .min(1)
      .max(ACTION_PACK_MAX_FIELDS)
      .refine(
        (fields) =>
          new Set(fields.map((field) => field.name)).size === fields.length,
        "material field names must be unique",
      ),
    requiredFields: z
      .array(z.string().min(1).max(64))
      .max(ACTION_PACK_MAX_FIELDS),
    approvalDisplay: z
      .array(
        z
          .object({
            field: z.string().min(1).max(64),
            label: z.string().min(1).max(128),
          })
          .strict(),
      )
      .max(ACTION_PACK_MAX_DISPLAY_FIELDS),
    verification: z
      .object({
        method: z.enum(["provider-receipt", "recorded-outcome"]),
        level: z.enum(["post-commit-content"]),
      })
      .strict(),
    counterpartyRules: z.string().max(512),
    dataEffects: z.string().max(512),
    executionContract: z.string().min(1).max(256),
    evidenceRequirements: z
      .array(z.string().min(1).max(64))
      .max(ACTION_PACK_MAX_EVIDENCE),
    capabilityUses: z.number().int().min(1).max(8),
    requiresExplicitGrant: z.boolean().optional(),
    minPrincipalClass: z.literal("adult").optional(),
    claimRules: z.array(ClaimRuleSchema).max(CLAIM_RULES_MAX),
    bindingRules: z.array(BindingRuleSchema).max(BINDING_RULES_MAX),
  })
  .strict();
export type ActionPackContent = z.infer<typeof ActionPackContentSchema>;

export const ActionPackBodySchema = z
  .object({
    pack: z.literal(ACTION_PACK_FORMAT),
    content: ActionPackContentSchema,
    version: z.number().int().positive(),
    compatibility: z
      .object({
        registry: z.literal(ACTION_PACK_REGISTRY_COMPATIBILITY),
      })
      .strict(),
    review: z
      .object({
        state: z.enum(["draft", "approved", "revoked"]),
        reviewer: z.string().min(1).max(128),
        atEpochMs: z.number().int().nonnegative().safe(),
      })
      .strict(),
    rollback: z
      .object({
        supersedes: z
          .object({
            actionId: ActionPackActionIdSchema,
            version: z.number().int().positive(),
          })
          .strict()
          .optional(),
        restores: z
          .object({
            actionId: ActionPackActionIdSchema,
            version: z.number().int().positive(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    provenance: z
      .object({
        source: z.string().min(1).max(256),
        generatedBy: z.string().min(1).max(128),
      })
      .strict(),
    publisher: z
      .object({
        id: ActionPackPublisherIdSchema,
        keyId: ActionPackKeyIdSchema,
      })
      .strict(),
  })
  .strict();
export type ActionPackBody = z.infer<typeof ActionPackBodySchema>;

export const ActionPackSchema = ActionPackBodySchema.extend({
  integrity: z
    .object({
      algorithm: z.literal("sha256"),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  signature: z
    .object({
      algorithm: z.literal("Ed25519"),
      domain: z.literal(ACTION_PACK_DOMAIN),
      canonicalization: z.literal("guardian-jcs-v1"),
      keyId: ActionPackKeyIdSchema,
      signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
    })
    .strict(),
}).strict();
export type ActionPack = z.infer<typeof ActionPackSchema>;

/** The canonical body the integrity digest covers (pack minus integrity/sig). */
export function actionPackBody(pack: ActionPack): ActionPackBody {
  const body: Record<string, unknown> = { ...pack };
  delete body.integrity;
  delete body.signature;
  return ActionPackBodySchema.parse(body);
}

/** sha256 over the canonical pack body — the declared integrity digest. */
export function actionPackIntegrity(pack: ActionPack): string {
  return canonicalSha256(actionPackBody(pack));
}

/** UTF-8 bytes of the canonical signed document (domain-separated). */
export function actionPackSigningInput(pack: ActionPack): Uint8Array {
  const signed: Record<string, unknown> = { ...pack };
  delete signed.signature;
  return new TextEncoder().encode(
    canonicalJson({ domain: ACTION_PACK_DOMAIN, pack: signed }),
  );
}

export type ActionPackRejection =
  | "PACK_SCHEMA_INVALID"
  | "PACK_INTEGRITY_MISMATCH"
  | "PACK_KEY_MISMATCH"
  | "PACK_PUBLISHER_UNTRUSTED"
  | "PACK_SIGNATURE_INVALID"
  | "PACK_NOT_APPROVED"
  | "PACK_FIELD_SCOPE_INVALID"
  | "PACK_TRANSPORT_FIELDS_INVALID"
  | "PACK_ACTION_SHADOWS_BUILTIN"
  | "PACK_VERSION_AMBIGUOUS";

const API_REQUEST_V1_FIELDS: ReadonlySet<string> = new Set(
  Object.keys(ApiRequestParametersV1Schema.shape).filter(
    (name) => name !== "schema" && name !== "connectionId",
  ),
);

/**
 * Verifies a signed Action Pack against the human-governed trust set. Every
 * rejection is deterministic: the named action never enters the registry, so
 * proposals for it resolve as unknown actions and DENY.
 */
export function verifyActionPack(
  input: unknown,
  trust: ActionPackTrustSet,
):
  | Readonly<{ ok: true; pack: ActionPack }>
  | Readonly<{ ok: false; reasonCode: ActionPackRejection }> {
  const parsed = ActionPackSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reasonCode: "PACK_SCHEMA_INVALID" };
  const pack = parsed.data;
  if (pack.integrity.digest !== actionPackIntegrity(pack)) {
    return { ok: false, reasonCode: "PACK_INTEGRITY_MISMATCH" };
  }
  if (pack.signature.keyId !== pack.publisher.keyId) {
    return { ok: false, reasonCode: "PACK_KEY_MISMATCH" };
  }
  // The trusted key IS the trust anchor: publisher.id is metadata inside the
  // signed body, so it cannot be forged without the key itself.
  const publisher = trust.publishers.find(
    (candidate) =>
      candidate.kid === pack.publisher.keyId &&
      candidate.kid === pack.signature.keyId,
  );
  if (publisher === undefined) {
    return { ok: false, reasonCode: "PACK_PUBLISHER_UNTRUSTED" };
  }
  const signature = Buffer.from(pack.signature.signature, "base64url");
  const verified = edVerify(
    null,
    actionPackSigningInput(pack),
    createPublicKey({ key: publisher, format: "jwk" }),
    signature,
  );
  if (!verified) {
    return { ok: false, reasonCode: "PACK_SIGNATURE_INVALID" };
  }
  if (pack.review.state !== "approved") {
    return { ok: false, reasonCode: "PACK_NOT_APPROVED" };
  }
  const declared = new Set(pack.content.materialFields.map((f) => f.name));
  if (
    !pack.content.requiredFields.every((name) => declared.has(name)) ||
    !pack.content.approvalDisplay.every((entry) => declared.has(entry.field))
  ) {
    return { ok: false, reasonCode: "PACK_FIELD_SCOPE_INVALID" };
  }
  if (
    pack.content.transport === "api.request.v1" &&
    ![...declared].every((name) => API_REQUEST_V1_FIELDS.has(name))
  ) {
    return { ok: false, reasonCode: "PACK_TRANSPORT_FIELDS_INVALID" };
  }
  return { ok: true, pack };
}

const fieldValueOk = (field: ActionPackField, value: unknown): boolean => {
  if (value === undefined || value === null) return !field.required;
  switch (field.type) {
    case "string":
      if (typeof value !== "string") return false;
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        return false;
      }
      if (
        field.mustStartWith !== undefined &&
        !value.startsWith(field.mustStartWith)
      ) {
        return false;
      }
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return false;
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
      break;
    case "boolean":
      if (typeof value !== "boolean") return false;
      break;
    case "array":
      if (!Array.isArray(value)) return false;
      break;
    case "object":
      if (typeof value !== "object" || Array.isArray(value)) return false;
      break;
  }
  if (
    field.enum !== undefined &&
    !field.enum.some((option) => canonicalJson(option) === canonicalJson(value))
  ) {
    return false;
  }
  if (
    typeof value === "number" &&
    ((field.min !== undefined && value < field.min) ||
      (field.max !== undefined && value > field.max))
  ) {
    return false;
  }
  return true;
};

/**
 * Derives the ActionDefinition a verified pack installs. The definition's
 * hooks are registry-side executable logic — the pack itself
 * only carries declarative data the hooks evaluate.
 */
export function actionDefinitionFromPack(
  body: ActionPackBody,
): ActionDefinition {
  const content = body.content;
  const materialParameters = Object.freeze([
    "connectionId",
    ...content.materialFields.map((field) => field.name),
  ]);
  const requiredParameters = Object.freeze([
    "connectionId",
    ...content.requiredFields,
  ]);
  return {
    actionId: content.actionId,
    schemaVersion: 1,
    actionFamily: content.family,
    humanLabel: content.humanLabel,
    description: content.description,
    parametersKind: `gpack.${content.actionId}.v${body.version}`,
    requiredParameters,
    materialParameters,
    resourceType: content.resourceType,
    providers: Object.freeze([...content.providers]),
    counterpartyRules: content.counterpartyRules,
    dataEffects: content.dataEffects,
    reversibility: content.reversibility,
    riskClass: content.risk,
    defaultDecisionPosture: content.posture,
    approvalPresentationSchema: Object.freeze(
      content.approvalDisplay.map((entry) => entry.field),
    ),
    approvalDisplayFields: Object.freeze(
      content.approvalDisplay.map((entry) => ({
        field: entry.field,
        label: entry.label,
      })),
    ),
    capabilityRequirements: { uses: content.capabilityUses },
    executionContract: content.executionContract,
    verificationContract: { level: content.verification.level },
    evidenceRequirements: Object.freeze([...content.evidenceRequirements]),
    version: 1,
    status: "active",
    ...(content.requiresExplicitGrant === undefined
      ? {}
      : { requiresExplicitGrant: content.requiresExplicitGrant }),
    ...(content.minPrincipalClass === undefined
      ? {}
      : { minPrincipalClass: content.minPrincipalClass }),
    validateParameters(material) {
      if (content.transport === "api.request.v1") {
        const parsed = ApiRequestParametersV1Schema.safeParse(material);
        if (!parsed.success) return { ok: false };
        const params = parsed.data as unknown as Record<string, unknown>;
        for (const field of content.materialFields) {
          if (!fieldValueOk(field, params[field.name])) return { ok: false };
        }
        return { ok: true, params: parsed.data };
      }
      return { ok: false };
    },
    validateBinding({
      params,
      connection,
    }: {
      params: unknown;
      connection: ActionConnectionBinding;
    }) {
      const claim =
        connection.claims === undefined
          ? undefined
          : ResourceClaimSchema.safeParse(connection.claims).data;
      if (claim === undefined) {
        return { ok: false, reasonCode: "CLAIMS_UNAVAILABLE" };
      }
      const evaluated = evaluateClaimRules(claim, content.claimRules);
      if (!evaluated.ok) {
        return { ok: false, reasonCode: evaluated.reasonCode };
      }
      const bound = evaluateBindingRules(
        claim,
        params as Record<string, unknown>,
        content.bindingRules,
      );
      if (!bound.ok) {
        return { ok: false, reasonCode: bound.reasonCode };
      }
      return { ok: true };
    },
    verificationProjection(params) {
      if (content.transport === "api.request.v1") {
        return apiVerificationProjection(
          ApiRequestParametersV1Schema.parse(params),
        );
      }
      return Object.freeze({
        domain: "odingard.guardian.gpack-projection.v1" as const,
        actionId: content.actionId,
        paramsDigest: canonicalSha256(params),
      });
    },
    envelopeProjection(params) {
      if (content.transport === "api.request.v1") {
        return apiEnvelopeProjection(
          ApiRequestParametersV1Schema.parse(params),
        );
      }
      return Object.freeze({
        domain: "odingard.guardian.gpack-projection.v1" as const,
        actionId: content.actionId,
        paramsDigest: canonicalSha256(params),
      });
    },
  };
}

/**
 * Installs verified packs into a registry composed over an optional builtin
 * base. Selection is deterministic: the highest-version approved pack per
 * actionId wins; a pack cannot shadow a builtin action; equal-version
 * ambiguity rejects every candidate. `rejected` reports each pack that did
 * not install and why — the action stays unregistered and DENYs.
 */
export function createPackBackedRegistry(input: {
  packs: readonly unknown[];
  trust: ActionPackTrustSet;
  base?: {
    get(actionId: string): unknown;
    entries(): readonly ActionDefinition[];
  };
}): {
  registry: {
    get(actionId: string): ActionDefinition | undefined;
    entries(): readonly ActionDefinition[];
  };
  installed: readonly { actionId: string; version: number }[];
  rejected: readonly { actionId?: string; reasonCode: ActionPackRejection }[];
} {
  const verified: ActionPack[] = [];
  const rejected: { actionId?: string; reasonCode: ActionPackRejection }[] = [];
  for (const candidate of input.packs) {
    const result = verifyActionPack(candidate, input.trust);
    if (!result.ok) {
      const actionId =
        typeof candidate === "object" && candidate !== null
          ? (candidate as { content?: { actionId?: unknown } }).content
              ?.actionId
          : undefined;
      rejected.push({
        reasonCode: result.reasonCode,
        ...(typeof actionId === "string" ? { actionId } : {}),
      });
      continue;
    }
    verified.push(result.pack);
  }
  const byAction = new Map<string, ActionPack[]>();
  for (const pack of verified) {
    const list = byAction.get(pack.content.actionId) ?? [];
    list.push(pack);
    byAction.set(pack.content.actionId, list);
  }
  const definitions: ActionDefinition[] = [];
  const installed: { actionId: string; version: number }[] = [];
  for (const [actionId, packs] of byAction) {
    const versions = new Map<number, ActionPack>();
    let ambiguous = false;
    for (const pack of packs) {
      if (versions.has(pack.version)) ambiguous = true;
      versions.set(pack.version, pack);
    }
    if (ambiguous) {
      rejected.push({ actionId, reasonCode: "PACK_VERSION_AMBIGUOUS" });
      continue;
    }
    const winner = [...versions.values()].reduce((left, right) =>
      left.version >= right.version ? left : right,
    );
    if (input.base !== undefined && input.base.get(actionId) !== undefined) {
      rejected.push({ actionId, reasonCode: "PACK_ACTION_SHADOWS_BUILTIN" });
      continue;
    }
    definitions.push(actionDefinitionFromPack(winner));
    installed.push({ actionId, version: winner.version });
  }
  const all = [...(input.base?.entries() ?? []), ...definitions];
  const byId = new Map(
    all.map((definition) => [definition.actionId, definition]),
  );
  return {
    registry: Object.freeze({
      get: (actionId) => byId.get(actionId),
      entries: () => Object.freeze([...all]),
    }),
    installed: Object.freeze(installed),
    rejected: Object.freeze(rejected),
  };
}
