// Generated file — do not edit.
import { z } from "zod";

import { ObligationSchema } from "./obligation.js";
import { TrustedRuntimeLevelSchema } from "./runtime.js";
import { EnforcementAssuranceLevelSchema } from "./assurance.js";

import {
  AuthorityReferenceSchema,
  MaterialParametersSchema,
} from "./action.js";
import {
  ActionTypeSchema,
  AgentInterfaceSchema,
  EpochMillisecondsSchema,
  PolicyReferenceSchema,
  ResourceRefSchema,
} from "./authority.js";
import { canonicalSha256 } from "./digest.js";
import { Sha256DigestSchema } from "./evidence.js";
import {
  AdapterIdSchema,
  AgentIdSchema,
  ApprovalIdSchema,
  CorrelationIdSchema,
  GrantIdSchema,
  PrincipalIdSchema,
  RequestIdSchema,
  ScopeIdSchema,
  TenantIdSchema,
} from "./identifiers.js";
import {
  ApprovalEndorsementSchema,
  ApprovalFactorSchema,
  StepUpLevelSchema,
} from "./multi-principal.js";
import {
  ApprovalStructureSchema,
  CoolingWindowSchema,
  RecordedStructureApprovalSchema,
} from "./multiparty.js";

const GrantVersionReferenceSchema = z
  .object({ id: GrantIdSchema, version: z.number().int().positive() })
  .strict();

/**
 * Agent-written prose is carried only as a labelled, explicitly non-authoritative
 * statement. It never participates in authority evaluation or approval binding
 * beyond being shown verbatim (and safely rendered) to the human.
 */
export const AgentStatementSchema = z
  .object({
    source: z.literal("agent"),
    authoritative: z.literal(false),
    text: z.string().trim().min(1).max(1_024),
  })
  .strict();

/**
 * Guardian's own reason for asking the human. It is derived only from the
 * server-held authority the deterministic kernel evaluated for the ASK decision
 * and never contains agent input.
 */
export const ApprovalReasonSchema = z
  .object({
    source: z.literal("guardian"),
    code: z.literal("APPROVAL_REQUIRED"),
    authority: AuthorityReferenceSchema,
  })
  .strict();

/**
 * Server-generated description of the exact canonical action a human is asked to
 * decide. Every field is copied from server-held canonical action state; values
 * the agent chose (parameters, purpose, initiating context, request identifier)
 * remain agent assertions and must be presented with agent provenance.
 */
export const ApprovalPresentationSchema = z
  .object({
    schemaVersion: z.literal(1),
    approvalId: ApprovalIdSchema,
    tenantId: TenantIdSchema,
    principalId: PrincipalIdSchema,
    agentId: AgentIdSchema,
    requestId: RequestIdSchema,
    correlationId: CorrelationIdSchema,
    action: ActionTypeSchema,
    resource: ResourceRefSchema,
    adapterId: AdapterIdSchema,
    interface: AgentInterfaceSchema,
    initiatingContext: z.enum(["user", "scheduled", "agent", "external-event"]),
    materialParameters: MaterialParametersSchema,
    valueCents: z.number().int().nonnegative().safe().optional(),
    uses: z.number().int().positive().safe(),
    agentStatement: AgentStatementSchema,
    reason: ApprovalReasonSchema,
    /**
     * The obligations the human approves under ("approved,
     * provided these conditions are satisfied"). Derived from the bound
     * action's declared obligations; the presentation digest covers it.
     */
    providedObligations: z.array(ObligationSchema).max(64).optional(),
    /**
     * The runtime trust + enforcement assurance levels the human
     * is approving under. Derived from the bound action's computed
     * levels; the presentation digest covers them.
     */
    runtimeTrustLevel: TrustedRuntimeLevelSchema.optional(),
    enforcementAssurance: EnforcementAssuranceLevelSchema.optional(),
    /**
     * The guardian.multiparty.v1 structures the human is
     * approving under. Derived from the bound action; the
     * presentation digest covers them.
     */
    approvalStructures: z.array(ApprovalStructureSchema).max(4).optional(),
    actionDigest: Sha256DigestSchema,
    expiresAtEpochMs: EpochMillisecondsSchema,
  })
  .strict();

export const ApprovalBindingSchema = z
  .object({
    schemaVersion: z.literal(1),
    approvalId: ApprovalIdSchema,
    tenantId: TenantIdSchema,
    principalId: PrincipalIdSchema,
    agentId: AgentIdSchema,
    requestId: RequestIdSchema,
    correlationId: CorrelationIdSchema,
    actionDigest: Sha256DigestSchema,
    /**
     * Evidence link to the exact ASK decision record that created the approval.
     * It covers evaluation time, so it is never re-derived; askDecisionDigest is
     * the decision binding that issuance and redemption verify.
     */
    actionDecisionRecordDigest: Sha256DigestSchema,
    /**
     * Digest of the time-independent projection of that ASK decision: the exact
     * canonical action, the ASK outcome, and the principal, agent, and complete
     * grant chain it was evaluated under. Every later use recomputes it from the
     * fresh decision or the current trusted authority and requires it to match.
     */
    askDecisionDigest: Sha256DigestSchema,
    adapterId: AdapterIdSchema,
    policy: PolicyReferenceSchema,
    evaluatedGrants: z.array(GrantVersionReferenceSchema).min(1).max(32),
    presentationDigest: Sha256DigestSchema,
    requestedAtEpochMs: EpochMillisecondsSchema,
    expiresAtEpochMs: EpochMillisecondsSchema,
    /**
     * When the approval was opened on a scope-linked agent, the
     * approver set resolved at creation. It can only ever narrow: a member
     * added later cannot decide a consent opened before they joined, and a
     * removed member is rejected again at decision time. Absent means only
     * the bound principal may decide (single-principal approval).
     */
    eligiblePrincipalIds: z.array(PrincipalIdSchema).min(1).max(16).optional(),
    requiredFactor: StepUpLevelSchema.optional(),
    requiredApprovals: z.number().int().min(1).max(8).optional(),
    scopeId: ScopeIdSchema.optional(),
    /**
     * The resolved guardian.multiparty.v1 structures frozen at
     * creation (intent-declared plus scope-policy-declared). Every listed
     * structure must evaluate satisfied before consent resolves; veto
     * terminates, separation-of-duties violation is impossible, and a
     * declared cooling period keeps the record pending for its window.
     */
    structures: z.array(ApprovalStructureSchema).max(4).optional(),
  })
  .strict()
  .superRefine((binding, context) => {
    if (binding.requestedAtEpochMs >= binding.expiresAtEpochMs) {
      context.addIssue({
        code: "custom",
        message: "approval expiry must follow request time",
        path: ["expiresAtEpochMs"],
      });
    }
    if (
      binding.eligiblePrincipalIds !== undefined &&
      !binding.eligiblePrincipalIds.includes(binding.principalId)
    ) {
      context.addIssue({
        code: "custom",
        message: "the bound principal is always an eligible approver",
        path: ["eligiblePrincipalIds"],
      });
    }
    if (
      binding.requiredFactor === "multi-approver" &&
      (binding.requiredApprovals ?? 1) < 2
    ) {
      context.addIssue({
        code: "custom",
        message: "multi-approver requires at least two approvers",
        path: ["requiredApprovals"],
      });
    }
  });

export const ApprovalStateSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "expired",
  "revoked",
  "superseded",
  "consumed",
]);

export const ApprovalRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    binding: ApprovalBindingSchema,
    state: ApprovalStateSchema,
    version: z.number().int().positive(),
    updatedAtEpochMs: EpochMillisecondsSchema,
    decidedByPrincipalId: PrincipalIdSchema.nullable(),
    /**
     * Recorded assents toward a multi-approver quorum. Each entry is
     * one eligible approver's presented factor; the final approver's decision
     * moves the state to approved, so a satisfied record has
     * endorsements.length + 1 >= binding.requiredApprovals.
     */
    endorsements: z.array(ApprovalEndorsementSchema).max(8).optional(),
    /**
     * The per-member decisions recorded under each bound
     * approval structure (append-only; the first decision per member
     * wins). Satisfies binding.structures only through the deterministic
     * guardian.multiparty.v1 evaluator.
     */
    structureApprovals: z
      .array(RecordedStructureApprovalSchema)
      .max(32)
      .optional(),
    /**
     * The stamped cooling window: set when the structure
     * requirements were all met; the record matures only at/after
     * endsAtEpochMs.
     */
    cooling: CoolingWindowSchema.optional(),
  })
  .strict()
  .superRefine((record, context) => {
    const humanDecision = ["approved", "denied", "revoked"].includes(
      record.state,
    );
    if (humanDecision !== (record.decidedByPrincipalId !== null)) {
      context.addIssue({
        code: "custom",
        message: "human decisions require the deciding principal",
        path: ["decidedByPrincipalId"],
      });
    }
    if (
      record.updatedAtEpochMs < record.binding.requestedAtEpochMs ||
      record.updatedAtEpochMs > record.binding.expiresAtEpochMs
    ) {
      context.addIssue({
        code: "custom",
        message: "approval update time must stay inside its validity window",
        path: ["updatedAtEpochMs"],
      });
    }
  });

/** Human-facing REST body for an explicit approve or deny decision. */
export const ApprovalDecisionRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    decision: z.enum(["approve", "deny", "veto"]),
    expectedVersion: z.number().int().positive().safe(),
    presentationDigest: Sha256DigestSchema,
    /**
     * For a delegated approver: the roster delegator this
     * decision is recorded under (must match the bound structure's
     * delegatedApprovers entry; it can only narrow the delegator's slot).
     */
    via: PrincipalIdSchema.optional(),
    /** Declares this decision invokes the structure's emergency approver path. */
    emergency: z.literal(true).optional(),
    /**
     * The step-up factor the human presents with this decision.
     * Absent is equivalent to "tap". It must meet the binding's requiredFactor
     * or the decision is refused with STEP_UP_REQUIRED.
     */
    factor: ApprovalFactorSchema.optional(),
  })
  .strict();

/** Human-facing REST body for revoking a pending or approved decision. */
export const ApprovalRevocationRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    expectedVersion: z.number().int().positive().safe(),
  })
  .strict();

/** The exact values a human must echo back to decide; protects against stale tabs. */
export const ApprovalChallengeSchema = z
  .object({
    approvalId: ApprovalIdSchema,
    version: z.number().int().positive().safe(),
    presentationDigest: Sha256DigestSchema,
    expiresAtEpochMs: EpochMillisecondsSchema,
  })
  .strict();

export const ApprovalReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    approvalId: ApprovalIdSchema,
    state: ApprovalStateSchema,
    version: z.number().int().positive().safe(),
    updatedAtEpochMs: EpochMillisecondsSchema,
    approvalDigest: Sha256DigestSchema,
  })
  .strict();

export function approvalPresentationDigest(
  presentation: z.infer<typeof ApprovalPresentationSchema>,
): string {
  return canonicalSha256({
    domain: "odingard.guardian.approval-presentation.v1",
    presentation,
  });
}

export function approvalBindingDigest(
  binding: z.infer<typeof ApprovalBindingSchema>,
): string {
  return canonicalSha256({
    domain: "odingard.guardian.approval-binding.v1",
    binding,
  });
}

export function approvalRecordDigest(
  record: z.infer<typeof ApprovalRecordSchema>,
): string {
  return canonicalSha256({
    domain: "odingard.guardian.approval-record.v1",
    record,
  });
}

export type AgentStatement = z.infer<typeof AgentStatementSchema>;
export type ApprovalReason = z.infer<typeof ApprovalReasonSchema>;
export type ApprovalPresentation = z.infer<typeof ApprovalPresentationSchema>;
export type ApprovalBinding = z.infer<typeof ApprovalBindingSchema>;
export type ApprovalState = z.infer<typeof ApprovalStateSchema>;
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;
export type ApprovalDecisionRequest = z.infer<
  typeof ApprovalDecisionRequestSchema
>;
export type ApprovalRevocationRequest = z.infer<
  typeof ApprovalRevocationRequestSchema
>;
export type ApprovalChallenge = z.infer<typeof ApprovalChallengeSchema>;
export type ApprovalReceipt = z.infer<typeof ApprovalReceiptSchema>;
