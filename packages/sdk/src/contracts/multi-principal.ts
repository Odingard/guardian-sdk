// Generated file — do not edit.
import { z } from "zod";

import { EpochMillisecondsSchema } from "./authority.js";
import { ApprovalStructureSchema } from "./multiparty.js";
import {
  AgentIdSchema,
  MembershipIdSchema,
  PrincipalIdSchema,
  ScopeIdSchema,
  TenantIdSchema,
} from "./identifiers.js";

/**
 * Multi-principal authority relationships.
 *
 * A shared scope groups principals into a household or team. Memberships carry
 * three independent axes, never blended:
 *   - principalClass: what authority the principal may hold (a child never
 *     holds adult-scope authority);
 *   - role: what the member may DO inside the scope (approve vs only view);
 *   - relationshipKind: descriptive family/workspace label carried for display
 *     and audit; it never confers authority by itself.
 *
 * Scope kinds are deliberately limited to household/team: organization-level
 * directory management is enterprise IAM and out of scope.
 */

export const PrincipalClassSchema = z.enum(["adult", "child"]);
export const ScopeKindSchema = z.enum(["household", "team"]);
export const RelationshipKindSchema = z.enum([
  "spouse",
  "parent",
  "child",
  "caregiver",
  "workspace",
]);
export const ScopeMemberRoleSchema = z.enum(["owner", "approver", "viewer"]);

/**
 * Step-up levels a single human can present. "multi-approver" is a required
 * level only — no single human can present it; it is satisfied by a quorum of
 * distinct approvers.
 */
export const StepUpLevelSchema = z.enum([
  "tap",
  "passkey",
  "biometric",
  "second-device",
  "multi-approver",
]);

/** The factor one human actually presents with a decision. */
export const ApprovalFactorSchema = z.enum([
  "tap",
  "passkey",
  "biometric",
  "second-device",
]);

/** Ordering of the single-human step-up levels, lowest first. */
export const APPROVAL_FACTOR_RANK: Record<
  z.infer<typeof ApprovalFactorSchema>,
  number
> = {
  tap: 0,
  passkey: 1,
  biometric: 2,
  "second-device": 3,
};

/**
 * Ordering of the step-up levels an approval may require, lowest first;
 * "multi-approver" sits above every single-human factor.
 */
export const STEP_UP_LEVEL_RANK: Record<
  z.infer<typeof StepUpLevelSchema>,
  number
> = {
  tap: 0,
  passkey: 1,
  biometric: 2,
  "second-device": 3,
  "multi-approver": 4,
};

/** The stricter of two required step-up levels. */
export function strictestStepUpLevel(
  current: z.infer<typeof StepUpLevelSchema>,
  candidate: z.infer<typeof StepUpLevelSchema>,
): z.infer<typeof StepUpLevelSchema> {
  return STEP_UP_LEVEL_RANK[candidate] > STEP_UP_LEVEL_RANK[current]
    ? candidate
    : current;
}

/**
 * True when the presented factor meets the required step-up level.
 * "multi-approver" can never be met by one presented factor — it is satisfied
 * by the endorsement quorum the approval service enforces.
 */
export function approvalFactorSatisfies(
  presented: z.infer<typeof ApprovalFactorSchema>,
  required: z.infer<typeof StepUpLevelSchema>,
): boolean {
  if (required === "multi-approver") return false;
  return APPROVAL_FACTOR_RANK[presented] >= APPROVAL_FACTOR_RANK[required];
}

export const SharedScopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    scopeId: ScopeIdSchema,
    tenantId: TenantIdSchema,
    kind: ScopeKindSchema,
    label: z.string().trim().min(1).max(120),
    status: z.enum(["active", "dissolved"]),
    version: z.number().int().positive(),
    createdAtEpochMs: EpochMillisecondsSchema,
    createdByPrincipalId: PrincipalIdSchema,
  })
  .strict();

export const ScopeMembershipSchema = z
  .object({
    schemaVersion: z.literal(1),
    membershipId: MembershipIdSchema,
    scopeId: ScopeIdSchema,
    tenantId: TenantIdSchema,
    principalId: PrincipalIdSchema,
    principalClass: PrincipalClassSchema,
    role: ScopeMemberRoleSchema,
    relationshipKind: RelationshipKindSchema,
    status: z.enum(["active", "removed"]),
    version: z.number().int().positive(),
    addedAtEpochMs: EpochMillisecondsSchema,
    addedByPrincipalId: PrincipalIdSchema,
  })
  .strict();

/** Links one member's agent into the scope so co-principals can see/decide. */
export const ScopeAgentLinkSchema = z
  .object({
    schemaVersion: z.literal(1),
    scopeId: ScopeIdSchema,
    tenantId: TenantIdSchema,
    agentId: AgentIdSchema,
    ownerPrincipalId: PrincipalIdSchema,
    status: z.enum(["active", "unlinked"]),
    version: z.number().int().positive(),
    linkedAtEpochMs: EpochMillisecondsSchema,
    linkedByPrincipalId: PrincipalIdSchema,
  })
  .strict();

/**
 * Per-scope approval policy: the step-up level and approver quorum every new
 * approval on a linked agent must satisfy. factorByRiskClass can raise (never
 * lower) the level for higher-risk actions.
 */
export const ScopeApprovalPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    scopeId: ScopeIdSchema,
    tenantId: TenantIdSchema,
    requiredFactor: StepUpLevelSchema,
    requiredApprovals: z.number().int().min(1).max(8),
    factorByRiskClass: z
      .record(z.enum(["R0", "R1", "R2", "R3", "R4", "R5"]), StepUpLevelSchema)
      .optional(),
    status: z.enum(["active"]),
    version: z.number().int().positive(),
    updatedAtEpochMs: EpochMillisecondsSchema,
    updatedByPrincipalId: PrincipalIdSchema,
    /**
     * A guardian.multiparty.v1 structure every approval
     * opened on a linked agent must additionally satisfy (e.g.
     * "production delete → engineer + security approval").
     */
    approvalStructure: ApprovalStructureSchema.optional(),
  })
  .strict()
  .superRefine((policy, context) => {
    if (
      policy.requiredFactor === "multi-approver" &&
      policy.requiredApprovals < 2
    ) {
      context.addIssue({
        code: "custom",
        message: "multi-approver requires at least two approvers",
        path: ["requiredApprovals"],
      });
    }
    for (const factor of Object.values(policy.factorByRiskClass ?? {})) {
      if (factor === "multi-approver" && policy.requiredApprovals < 2) {
        context.addIssue({
          code: "custom",
          message: "multi-approver requires at least two approvers",
          path: ["factorByRiskClass"],
        });
      }
    }
  });

/**
 * The requirement resolved when an approval is opened on a scope-linked agent:
 * the bound approver set, the required step-up level, and the quorum. It is
 * frozen into the approval binding at creation so consent cannot widen later.
 */
export const ApprovalRequirementSchema = z
  .object({
    scopeId: ScopeIdSchema.optional(),
    eligiblePrincipalIds: z.array(PrincipalIdSchema).min(1).max(16),
    requiredFactor: StepUpLevelSchema,
    requiredApprovals: z.number().int().min(1).max(8),
    /**
     * An approval structure resolved from the scope's policy;
     * frozen into the binding alongside the eligible approver set.
     */
    structure: ApprovalStructureSchema.optional(),
  })
  .strict();

/** One approver's recorded assent toward a multi-approver quorum. */
export const ApprovalEndorsementSchema = z
  .object({
    principalId: PrincipalIdSchema,
    factor: ApprovalFactorSchema,
    atEpochMs: EpochMillisecondsSchema,
  })
  .strict();

export type PrincipalClass = z.infer<typeof PrincipalClassSchema>;
export type ScopeKind = z.infer<typeof ScopeKindSchema>;
export type RelationshipKind = z.infer<typeof RelationshipKindSchema>;
export type ScopeMemberRole = z.infer<typeof ScopeMemberRoleSchema>;
export type StepUpLevel = z.infer<typeof StepUpLevelSchema>;
export type ApprovalFactor = z.infer<typeof ApprovalFactorSchema>;
export type SharedScope = z.infer<typeof SharedScopeSchema>;
export type ScopeMembership = z.infer<typeof ScopeMembershipSchema>;
export type ScopeAgentLink = z.infer<typeof ScopeAgentLinkSchema>;
export type ScopeApprovalPolicy = z.infer<typeof ScopeApprovalPolicySchema>;
export type ApprovalRequirement = z.infer<typeof ApprovalRequirementSchema>;
export type ApprovalEndorsement = z.infer<typeof ApprovalEndorsementSchema>;
