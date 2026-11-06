// Generated file — do not edit.
import { z } from "zod";

import { ObligationSchema, ObligationStateSchema } from "./obligation.js";
import { PrerequisiteStateSchema } from "./prerequisite.js";
import { LineageMatchOutcomeSchema } from "./lineage.js";
import { TrustedRuntimeLevelSchema } from "./runtime.js";
import { EnforcementAssuranceLevelSchema } from "./assurance.js";
import { SequenceMatchOutcomeSchema } from "./sequence.js";
import { ApprovalStructureSchema } from "./multiparty.js";
import { SourceConstraintsSchema } from "./sources.js";
import {
  TransactionCompensationBindingSchema,
  TransactionDeclarationSchema,
} from "./transaction.js";
import {
  PhysicalActionFactsSchema,
  SafetyEnvelopeOutcomeSchema,
} from "./safety-envelope.js";

import {
  ActionTypeSchema,
  AgentIdentitySchema,
  AuthorityGrantSchema,
  AuthorityPauseSchema,
  AgentInterfaceSchema,
  AuthorityDecisionSchema,
  AuthorityRequestSchema,
  BudgetStateSchema,
  EpochMillisecondsSchema,
  PolicyReferenceSchema,
  PrincipalSchema,
  ResourceRefSchema,
  RevocationSchema,
} from "./authority.js";
import type { CanonicalJsonValue } from "./canonical-json.js";
import { canonicalJson } from "./canonical-json.js";
import { canonicalSha256 } from "./digest.js";
import {
  AdapterIdSchema,
  AgentIdSchema,
  AttemptIdSchema,
  CorrelationIdSchema,
  GrantIdSchema,
  NonceSchema,
  PrincipalIdSchema,
  RequestIdSchema,
  IntentIdSchema,
  PlanIdSchema,
  TaskIdSchema,
  TenantIdSchema,
} from "./identifiers.js";

const SHA256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_MATERIAL_BYTES = 32_768;
const MAX_MATERIAL_NODES = 4_096;

type NormalizationBudget = { remainingNodes: number };

function normalizeCanonicalJson(
  value: unknown,
  depth = 0,
  ancestors = new WeakSet<object>(),
  budget: NormalizationBudget = { remainingNodes: MAX_MATERIAL_NODES },
): CanonicalJsonValue {
  budget.remainingNodes -= 1;
  if (budget.remainingNodes < 0) {
    throw new TypeError("material parameters exceed maximum node count");
  }
  if (depth > 8)
    throw new TypeError("material parameters exceed maximum depth");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > 8_192 || value.normalize("NFC") !== value) {
      throw new TypeError("material string is too long or not NFC-normalized");
    }
    return value;
  }
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      Math.abs(value) > Number.MAX_SAFE_INTEGER ||
      Object.is(value, -0)
    ) {
      throw new TypeError("material number is not canonical");
    }
    return value;
  }
  if (
    typeof value !== "object" ||
    value === undefined ||
    ancestors.has(value)
  ) {
    throw new TypeError(
      "material parameters contain an unsupported value or cycle",
    );
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 256)
        throw new TypeError("material array is too large");
      const keys = Reflect.ownKeys(value);
      const expectedKeys = new Set([
        "length",
        ...Array.from({ length: value.length }, (_, index) => String(index)),
      ]);
      if (
        keys.some((key) => typeof key !== "string" || !expectedKeys.has(key)) ||
        keys.length !== expectedKeys.size
      ) {
        throw new TypeError(
          "material arrays must be dense and have no extra properties",
        );
      }
      const normalized = Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new TypeError(
            "material arrays may contain only enumerable data values",
          );
        }
        return normalizeCanonicalJson(
          descriptor.value,
          depth + 1,
          ancestors,
          budget,
        );
      });
      Object.freeze(normalized);
      return normalized;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        "material parameters accept only plain objects and arrays",
      );
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > 128 || keys.some((key) => typeof key !== "string")) {
      throw new TypeError(
        "material objects are too large or contain symbol keys",
      );
    }
    const normalized: Record<string, CanonicalJsonValue> = Object.create(
      null,
    ) as Record<string, CanonicalJsonValue>;
    for (const key of keys as string[]) {
      if (
        key.length === 0 ||
        key.length > 128 ||
        key.normalize("NFC") !== key ||
        ["__proto__", "constructor", "prototype"].includes(key)
      ) {
        throw new TypeError("material object key is invalid");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError(
          "material objects may contain only enumerable data properties",
        );
      }
      Object.defineProperty(normalized, key, {
        value: normalizeCanonicalJson(
          descriptor.value,
          depth + 1,
          ancestors,
          budget,
        ),
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(normalized);
  } finally {
    ancestors.delete(value);
  }
}

function normalizeMaterialParameters(
  value: unknown,
): Readonly<Record<string, CanonicalJsonValue>> {
  const normalized = normalizeCanonicalJson(value);
  if (
    normalized === null ||
    Array.isArray(normalized) ||
    typeof normalized !== "object"
  ) {
    throw new TypeError("material parameters must be an object");
  }
  if (
    new TextEncoder().encode(canonicalJson(normalized)).length >
    MAX_MATERIAL_BYTES
  ) {
    throw new TypeError("material parameters exceed maximum encoded size");
  }
  return normalized;
}

export const MaterialParametersSchema = z
  .unknown()
  .transform((value, context) => {
    try {
      return normalizeMaterialParameters(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "material parameters must be a bounded canonical JSON object",
      });
      return z.NEVER;
    }
  });

export const AuthorityReferenceSchema = z
  .object({
    policy: PolicyReferenceSchema,
    evaluatedGrants: z
      .array(
        z
          .object({
            id: GrantIdSchema,
            version: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(32)
      .refine(
        (grants) =>
          new Set(grants.map((grant) => grant.id)).size === grants.length,
        "evaluated grant identifiers must be unique",
      ),
  })
  .strict();

export const AppliedAuthoritySourcesSchema = z
  .object({
    /** Source pack ids whose constraints were established and applied. */
    applied: z.array(z.string().trim().min(1).max(128)).max(16),
    /** The deterministic intersection of the applied packs. */
    constraints: SourceConstraintsSchema,
  })
  .strict();
export type AppliedAuthoritySourcesBinding = z.infer<
  typeof AppliedAuthoritySourcesSchema
>;

export const MaterialActionSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: RequestIdSchema,
    correlationId: CorrelationIdSchema,
    tenantId: TenantIdSchema,
    principalId: PrincipalIdSchema,
    agentId: AgentIdSchema,
    action: ActionTypeSchema,
    resource: ResourceRefSchema,
    interface: AgentInterfaceSchema,
    valueCents: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    merchantId: z.string().trim().min(1).max(256).optional(),
    merchantCategory: z.string().trim().min(1).max(256).optional(),
    recurring: z.boolean().optional(),
    taskId: TaskIdSchema.optional(),
    // Intent/plan provenance rides the material digest so the
    // capability and receipt answer effect→action→task→plan→intent.
    intentId: IntentIdSchema.optional(),
    planId: PlanIdSchema.optional(),
    // The intent's declared obligations, their evaluated states, and
    // the ordered prerequisite settlement ride the material digest so the
    // capability, decision record, approval presentation, and receipt all
    // bind "ALLOW, provided these conditions" without touching the kernel
    // digest semantics (RecordedAuthorityEvaluationInput is unchanged).
    obligations: z.array(ObligationSchema).max(64).optional(),
    obligationStates: z.array(ObligationStateSchema).max(64).optional(),
    prerequisiteResults: z.array(PrerequisiteStateSchema).max(64).optional(),
    // Causal provenance — the recorded action and effect this
    // action was caused by, declared by the agent and validated
    // fail-closed against recorded evidence at the pre-gate; bound into
    // the material digest so capabilities, decision records, and receipts
    // carry the chain without kernel-input changes.
    parentActionId: RequestIdSchema.optional(),
    sourceEffectId: AttemptIdSchema.optional(),
    // Declarative sequence-rule matches ride the material digest
    // like obligation states — the decision record and portable
    // receipt inherit them from the embedded action.
    sequenceMatches: z.array(SequenceMatchOutcomeSchema).max(64).optional(),
    // Lineage evaluation outcomes ride the material digest the same
    // way — decision record and portable receipt inherit them from the
    // embedded action.
    lineageMatches: z.array(LineageMatchOutcomeSchema).max(64).optional(),
    // The trusted-runtime level (guardian.runtime.v1) and the
    // enforcement-assurance level (guardian.assurance.v1) computed at
    // decision time ride the material digest so every decision record and
    // receipt answers "how trusted was the runtime" and "how strongly can
    // Guardian enforce this" without kernel-input changes.
    runtimeTrustLevel: TrustedRuntimeLevelSchema.optional(),
    enforcementAssurance: EnforcementAssuranceLevelSchema.optional(),
    // The intent-declared guardian.multiparty.v1 approval
    // structures the gateway bound for the approval path, and
    // the guardian.sources.v1 intersection result applied to
    // the narrowed chain. Both ride the material digest so consent is
    // opened against exactly the structures and source constraints the
    // decision was made under.
    approvalStructures: z.array(ApprovalStructureSchema).max(4).optional(),
    appliedAuthoritySources: AppliedAuthoritySourcesSchema.optional(),
    // When the action or its governing intent declares a
    // transaction lifecycle (guardian.transaction.v1), the
    // effective declaration rides the material digest so the recorded
    // transaction is bound to exactly the lifecycle the decision was
    // made under. `compensates` marks this action as the governed
    // compensation of a recorded transaction — it never bypasses
    // the authority path.
    transaction: TransactionDeclarationSchema.optional(),
    compensates: TransactionCompensationBindingSchema.optional(),
    // Physical actions carry declarative constraint facts
    // (guardian.safety_envelope.v1) — zone/speed/force/payload/
    // hours/human-distance — and the evaluated envelope outcome binds
    // into the digest so the decision record and receipt answer "under
    // which envelope was this governed". Generic policy facts;
    // nothing robotics-specific.
    physicalFacts: PhysicalActionFactsSchema.optional(),
    safetyEnvelopeOutcome: SafetyEnvelopeOutcomeSchema.optional(),
    uses: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    materialParameters: MaterialParametersSchema,
    initiatingContext: z.enum(["user", "scheduled", "agent", "external-event"]),
    authority: AuthorityReferenceSchema,
    issuedAtEpochMs: EpochMillisecondsSchema,
    expiresAtEpochMs: EpochMillisecondsSchema,
    nonce: NonceSchema,
    requestedAdapterId: AdapterIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (!Object.prototype.hasOwnProperty.call(value, "materialParameters")) {
      context.addIssue({
        code: "custom",
        path: ["materialParameters"],
        message: "materialParameters must be explicitly present",
      });
    }
    if (value.issuedAtEpochMs >= value.expiresAtEpochMs) {
      context.addIssue({
        code: "custom",
        path: ["expiresAtEpochMs"],
        message: "expiresAtEpochMs must be later than issuedAtEpochMs",
      });
    }
  });

export const CanonicalActionEnvelopeSchema = MaterialActionSchema.extend({
  purpose: z
    .string()
    .trim()
    .min(1)
    .max(1_024)
    .refine((value) => value.normalize("NFC") === value),
}).strict();

export const CanonicalActionSchema = CanonicalActionEnvelopeSchema.extend({
  materialDigest: SHA256Schema,
})
  .strict()
  .superRefine((value, context) => {
    try {
      const material = MaterialActionSchema.strip().parse(value);
      if (materialActionDigest(material) === value.materialDigest) return;
      context.addIssue({
        code: "custom",
        path: ["materialDigest"],
        message: "materialDigest does not match the canonical action",
      });
    } catch {
      context.addIssue({
        code: "custom",
        path: ["materialDigest"],
        message: "canonical action cannot be safely digested",
      });
    }
  });

export const RecordedAuthorityEvaluationInputSchema = z
  .object({
    nowEpochMs: EpochMillisecondsSchema,
    principal: PrincipalSchema,
    agent: AgentIdentitySchema,
    request: AuthorityRequestSchema,
    policy: PolicyReferenceSchema,
    authorityChain: z.array(AuthorityGrantSchema).max(32),
    revocations: z
      .array(RevocationSchema)
      .max(256)
      .transform((values) =>
        [...values].sort((left, right) =>
          left.grantId < right.grantId
            ? -1
            : left.grantId > right.grantId
              ? 1
              : left.revokedAtEpochMs - right.revokedAtEpochMs,
        ),
      ),
    budgets: z
      .array(BudgetStateSchema)
      .max(64)
      .default([])
      .transform((values) =>
        [...values].sort((left, right) => (left.id < right.id ? -1 : 1)),
      ),
    pauses: z
      .array(AuthorityPauseSchema)
      .max(256)
      .default([])
      .transform((values) =>
        [...values].sort((left, right) => (left.id < right.id ? -1 : 1)),
      ),
  })
  .strict();

export const ActionDecisionRecordCoreSchema = z
  .object({
    schemaVersion: z.literal(1),
    tenantId: TenantIdSchema,
    principalId: PrincipalIdSchema,
    agentId: AgentIdSchema,
    requestId: RequestIdSchema,
    correlationId: CorrelationIdSchema,
    actionDigest: SHA256Schema,
    policy: PolicyReferenceSchema,
    evaluatedGrants: AuthorityReferenceSchema.shape.evaluatedGrants,
    action: CanonicalActionSchema,
    authorityRequest: AuthorityRequestSchema,
    authorityEvaluationInput: RecordedAuthorityEvaluationInputSchema,
    authorityDecision: AuthorityDecisionSchema,
    decidedAtEpochMs: EpochMillisecondsSchema,
  })
  .strict();

export const ActionDecisionRecordSchema = ActionDecisionRecordCoreSchema.extend(
  {
    recordDigest: SHA256Schema,
  },
)
  .strict()
  .superRefine((value, context) => {
    try {
      const binding = value.authorityDecision.binding;
      const expectedRequest = toAuthorityRequest(value.action);
      if (
        value.tenantId !== value.action.tenantId ||
        value.principalId !== value.action.principalId ||
        value.agentId !== value.action.agentId ||
        value.requestId !== value.action.requestId ||
        value.correlationId !== value.action.correlationId ||
        value.actionDigest !== value.action.materialDigest
      ) {
        context.addIssue({
          code: "custom",
          path: ["actionDigest"],
          message:
            "action decision context does not match the canonical action",
        });
      }
      if (
        value.policy.id !== value.action.authority.policy.id ||
        value.policy.version !== value.action.authority.policy.version ||
        canonicalSha256(value.evaluatedGrants) !==
          canonicalSha256(value.action.authority.evaluatedGrants)
      ) {
        context.addIssue({
          code: "custom",
          path: ["policy"],
          message:
            "action decision authority references do not match the action",
        });
      }
      if (
        canonicalSha256(value.authorityRequest) !==
        canonicalSha256(expectedRequest)
      ) {
        context.addIssue({
          code: "custom",
          path: ["authorityRequest"],
          message: "authority request does not match the canonical action",
        });
      }
      if (
        canonicalSha256(value.authorityEvaluationInput.request) !==
          canonicalSha256(expectedRequest) ||
        canonicalSha256(value.authorityEvaluationInput.policy) !==
          canonicalSha256(value.action.authority.policy) ||
        value.authorityEvaluationInput.principal.id !==
          value.action.principalId ||
        value.authorityEvaluationInput.principal.tenantId !==
          value.action.tenantId ||
        value.authorityEvaluationInput.agent.id !== value.action.agentId ||
        value.authorityEvaluationInput.agent.tenantId !==
          value.action.tenantId ||
        value.authorityEvaluationInput.agent.ownerPrincipalId !==
          value.action.principalId ||
        value.authorityEvaluationInput.principal.status !== "active" ||
        value.authorityEvaluationInput.agent.status !== "active" ||
        !value.authorityEvaluationInput.agent.allowedInterfaces.includes(
          value.action.interface,
        ) ||
        value.authorityEvaluationInput.authorityChain.some(
          (grant) =>
            grant.tenantId !== value.action.tenantId ||
            grant.principalId !== value.action.principalId ||
            grant.agentId !== value.action.agentId ||
            grant.status !== "active",
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["authorityEvaluationInput"],
          message:
            "evaluated authority input does not match the canonical action",
        });
      }
      if (binding.requestId !== value.action.requestId) {
        context.addIssue({
          code: "custom",
          path: ["authorityDecision", "binding", "requestId"],
          message: "decision request binding does not match the action",
        });
      }
      if (
        binding.policy === null ||
        binding.policy.id !== value.action.authority.policy.id ||
        binding.policy.version !== value.action.authority.policy.version
      ) {
        context.addIssue({
          code: "custom",
          path: ["authorityDecision", "binding", "policy"],
          message: "decision policy binding does not match the action",
        });
      }
      if (
        canonicalSha256(binding.evaluatedGrants) !==
        canonicalSha256(value.action.authority.evaluatedGrants)
      ) {
        context.addIssue({
          code: "custom",
          path: ["authorityDecision", "binding", "evaluatedGrants"],
          message: "decision grant bindings do not match the action",
        });
      }
      if (
        binding.inputDigest === null ||
        binding.inputDigest !== canonicalSha256(value.authorityEvaluationInput)
      ) {
        context.addIssue({
          code: "custom",
          path: ["authorityDecision", "binding", "inputDigest"],
          message:
            "decision input digest does not match the evaluated authority input",
        });
      }
      const grantNotBeforeEpochMs = Math.max(
        0,
        ...value.authorityEvaluationInput.authorityChain.map(
          (grant) => grant.constraints.notBeforeEpochMs ?? 0,
        ),
      );
      const grantExpiresAtEpochMs = Math.min(
        ...value.authorityEvaluationInput.authorityChain.map(
          (grant) => grant.constraints.expiresAtEpochMs,
        ),
      );
      if (
        value.authorityEvaluationInput.nowEpochMs !== value.decidedAtEpochMs ||
        value.decidedAtEpochMs < value.action.issuedAtEpochMs ||
        value.decidedAtEpochMs >= value.action.expiresAtEpochMs
      ) {
        context.addIssue({
          code: "custom",
          path: ["decidedAtEpochMs"],
          message: "decision time must fall within the action validity window",
        });
      }
      if (
        value.authorityEvaluationInput.authorityChain.length === 0 ||
        value.action.issuedAtEpochMs < grantNotBeforeEpochMs ||
        value.action.expiresAtEpochMs > grantExpiresAtEpochMs
      ) {
        context.addIssue({
          code: "custom",
          path: ["action", "expiresAtEpochMs"],
          message:
            "action validity window must be contained by evaluated grants",
        });
      }
      const evaluatedGrantReferences =
        value.authorityEvaluationInput.authorityChain.map(
          ({ id, version }) => ({
            id,
            version,
          }),
        );
      if (
        canonicalSha256(evaluatedGrantReferences) !==
        canonicalSha256(value.action.authority.evaluatedGrants)
      ) {
        context.addIssue({
          code: "custom",
          path: ["authorityEvaluationInput", "authorityChain"],
          message: "evaluated authority chain does not match declared grants",
        });
      }
      const core = ActionDecisionRecordCoreSchema.strip().parse(value);
      if (actionDecisionRecordDigest(core) !== value.recordDigest) {
        context.addIssue({
          code: "custom",
          path: ["recordDigest"],
          message: "recordDigest does not match the action decision record",
        });
      }
    } catch {
      context.addIssue({
        code: "custom",
        path: ["recordDigest"],
        message: "action decision record cannot be safely verified",
      });
    }
  });

export type MaterialParameters = z.infer<typeof MaterialParametersSchema>;
export type AuthorityReference = z.infer<typeof AuthorityReferenceSchema>;
export type MaterialAction = z.infer<typeof MaterialActionSchema>;
export type CanonicalActionEnvelope = z.infer<
  typeof CanonicalActionEnvelopeSchema
>;
export type CanonicalAction = z.infer<typeof CanonicalActionSchema>;
export type RecordedAuthorityEvaluationInput = z.infer<
  typeof RecordedAuthorityEvaluationInputSchema
>;
export type ActionDecisionRecordCore = z.infer<
  typeof ActionDecisionRecordCoreSchema
>;
export type ActionDecisionRecord = z.infer<typeof ActionDecisionRecordSchema>;

export const MATERIAL_ACTION_KEYS = Object.keys(
  MaterialActionSchema.shape,
) as (keyof MaterialAction)[];

export function materialActionDigest(material: MaterialAction): string {
  return canonicalSha256({
    domain: "odingard.guardian.action.v1",
    materialAction: material,
  });
}

export function actionDecisionRecordDigest(
  record: ActionDecisionRecordCore,
): string {
  return canonicalSha256({
    domain: "odingard.guardian.action-decision.v1",
    record,
  });
}

export function toAuthorityRequest(action: CanonicalAction) {
  return AuthorityRequestSchema.parse({
    id: action.requestId,
    tenantId: action.tenantId,
    principalId: action.principalId,
    agentId: action.agentId,
    action: action.action,
    resource: action.resource,
    interface: action.interface,
    requestedAdapterId: action.requestedAdapterId,
    ...(action.valueCents === undefined
      ? {}
      : { valueCents: action.valueCents }),
    uses: action.uses,
    materialActionDigest: action.materialDigest,
    descriptiveContext: action.purpose,
    ...(action.merchantId === undefined
      ? {}
      : { merchantId: action.merchantId }),
    ...(action.merchantCategory === undefined
      ? {}
      : { merchantCategory: action.merchantCategory }),
    ...(action.recurring === undefined ? {} : { recurring: action.recurring }),
    ...(action.taskId === undefined ? {} : { taskId: action.taskId }),
    ...(action.intentId === undefined ? {} : { intentId: action.intentId }),
    ...(action.planId === undefined ? {} : { planId: action.planId }),
  });
}

export type CreateCanonicalActionResult =
  | { ok: true; action: CanonicalAction }
  | { ok: false; reasonCode: "MALFORMED_ACTION" };

export function createCanonicalAction(
  input: unknown,
): CreateCanonicalActionResult {
  try {
    const parsed = CanonicalActionEnvelopeSchema.safeParse(input);
    if (!parsed.success) return { ok: false, reasonCode: "MALFORMED_ACTION" };
    const material = MaterialActionSchema.strip().parse(parsed.data);
    return {
      ok: true,
      action: CanonicalActionSchema.parse({
        ...parsed.data,
        materialDigest: materialActionDigest(material),
      }),
    };
  } catch {
    return { ok: false, reasonCode: "MALFORMED_ACTION" };
  }
}

export type CreateActionDecisionResult =
  | { ok: true; record: ActionDecisionRecord }
  | { ok: false; reasonCode: "ACTION_DECISION_BINDING_INVALID" };

export function createActionDecisionRecord(
  actionInput: unknown,
  authorityEvaluationInput: unknown,
  decisionInput: unknown,
  decidedAtEpochMs: unknown,
): CreateActionDecisionResult {
  try {
    const action = CanonicalActionSchema.safeParse(actionInput);
    const evaluatedInput = RecordedAuthorityEvaluationInputSchema.safeParse(
      authorityEvaluationInput,
    );
    const decision = AuthorityDecisionSchema.safeParse(decisionInput);
    const decidedAt = EpochMillisecondsSchema.safeParse(decidedAtEpochMs);
    if (
      !action.success ||
      !evaluatedInput.success ||
      !decision.success ||
      !decidedAt.success
    ) {
      return { ok: false, reasonCode: "ACTION_DECISION_BINDING_INVALID" };
    }
    const record = ActionDecisionRecordSchema.safeParse({
      schemaVersion: 1,
      tenantId: action.data.tenantId,
      principalId: action.data.principalId,
      agentId: action.data.agentId,
      requestId: action.data.requestId,
      correlationId: action.data.correlationId,
      actionDigest: action.data.materialDigest,
      policy: action.data.authority.policy,
      evaluatedGrants: action.data.authority.evaluatedGrants,
      action: action.data,
      authorityRequest: toAuthorityRequest(action.data),
      authorityEvaluationInput: evaluatedInput.data,
      authorityDecision: decision.data,
      decidedAtEpochMs: decidedAt.data,
      recordDigest: actionDecisionRecordDigest({
        schemaVersion: 1,
        tenantId: action.data.tenantId,
        principalId: action.data.principalId,
        agentId: action.data.agentId,
        requestId: action.data.requestId,
        correlationId: action.data.correlationId,
        actionDigest: action.data.materialDigest,
        policy: action.data.authority.policy,
        evaluatedGrants: action.data.authority.evaluatedGrants,
        action: action.data,
        authorityRequest: toAuthorityRequest(action.data),
        authorityEvaluationInput: evaluatedInput.data,
        authorityDecision: decision.data,
        decidedAtEpochMs: decidedAt.data,
      }),
    });
    return record.success
      ? { ok: true, record: record.data }
      : { ok: false, reasonCode: "ACTION_DECISION_BINDING_INVALID" };
  } catch {
    return { ok: false, reasonCode: "ACTION_DECISION_BINDING_INVALID" };
  }
}
