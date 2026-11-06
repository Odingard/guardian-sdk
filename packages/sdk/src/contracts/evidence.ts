// Generated file — do not edit.
import { z } from "zod";

import {
  AgentInterfaceSchema,
  DenyReasonCodeSchema,
  EpochMillisecondsSchema,
} from "./authority.js";
import {
  AdapterIdSchema,
  AgentIdSchema,
  ApprovalIdSchema,
  CapabilityIdSchema,
  CorrelationIdSchema,
  EvidenceIdSchema,
  GrantIdSchema,
  PrincipalIdSchema,
  RequestIdSchema,
  TenantIdSchema,
} from "./identifiers.js";

export const Sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

const AttemptReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const FailureCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Z][A-Z0-9_]*$/);

const payload = <T extends string, Shape extends z.ZodRawShape>(
  eventType: T,
  shape: Shape,
) =>
  z
    .object({
      eventType: z.literal(eventType),
      payload: z.object(shape).strict(),
    })
    .strict();

export const EvidenceEventSchema = z.discriminatedUnion("eventType", [
  payload("AUTHENTICATION_RECORDED", {
    interface: AgentInterfaceSchema,
    outcome: z.enum(["authenticated", "rejected"]),
    credentialReference: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  }),
  payload("ADAPTER_AUTHENTICATION_RECORDED", {
    adapterId: AdapterIdSchema,
    outcome: z.literal("authenticated"),
    credentialReference: AttemptReferenceSchema,
  }),
  payload("REQUEST_RECEIVED", { actionDigest: Sha256DigestSchema }),
  payload("ACTION_NORMALIZED", { actionDigest: Sha256DigestSchema }),
  z
    .object({
      eventType: z.literal("DECISION_RECORDED"),
      payload: z.discriminatedUnion("decision", [
        z
          .object({
            actionDigest: Sha256DigestSchema,
            actionDecisionDigest: Sha256DigestSchema,
            decision: z.literal("ALLOW"),
            reasonCode: z.literal("AUTHORIZED"),
          })
          .strict(),
        z
          .object({
            actionDigest: Sha256DigestSchema,
            actionDecisionDigest: Sha256DigestSchema,
            decision: z.literal("ASK"),
            reasonCode: z.literal("APPROVAL_REQUIRED"),
          })
          .strict(),
        z
          .object({
            actionDigest: Sha256DigestSchema,
            actionDecisionDigest: Sha256DigestSchema,
            decision: z.literal("DENY"),
            reasonCode: DenyReasonCodeSchema,
          })
          .strict(),
      ]),
    })
    .strict(),
  /**
   * A denied request that never reached the kernel's DECISION_RECORDED:
   * pre-gate rule denies, intent-budget denies, and request rejects that
   * carried enough verified identity to evidence. `decision` is always
   * DENY so History and Receipts render it exactly like an allowed one.
   * `actionDigest` is null when the deny ran before canonical action
   * creation; `requestDeniedDigest` is the digest of the
   * guardian.request_denial.v1 record — the decision artifact.
   */
  payload("REQUEST_DENIED", {
    decision: z.literal("DENY"),
    actionDigest: Sha256DigestSchema.nullable(),
    requestDeniedDigest: Sha256DigestSchema,
    reasonCode: FailureCodeSchema,
    decidedAtEpochMs: EpochMillisecondsSchema,
  }),
  payload("APPROVAL_STATE_REFERENCED", {
    approvalId: ApprovalIdSchema,
    /** Approval record version this state evidence describes; versions are contiguous per chain. */
    version: z.number().int().positive().safe(),
    state: z.enum([
      "pending",
      "approved",
      "denied",
      "expired",
      "revoked",
      "superseded",
      "consumed",
    ]),
    approvalDigest: Sha256DigestSchema,
  }),
  payload("APPROVAL_PRESENTED", {
    approvalId: ApprovalIdSchema,
    presentationDigest: Sha256DigestSchema,
    viewerReference: AttemptReferenceSchema,
  }),
  payload("APPROVAL_DECISION_RECORDED", {
    approvalId: ApprovalIdSchema,
    /** Approval record version the human decision produced. */
    version: z.number().int().positive().safe(),
    decision: z.enum([
      "approve",
      "deny",
      "revoke",
      "endorse",
      "veto",
      "dissent",
      "mature",
    ]),
    actorPrincipalId: PrincipalIdSchema,
    actorReference: AttemptReferenceSchema,
    presentationDigest: Sha256DigestSchema,
  }),
  payload("APPROVAL_REJECTED", {
    approvalId: ApprovalIdSchema,
    reasonCode: FailureCodeSchema,
  }),
  payload("CAPABILITY_STATE_REFERENCED", {
    actionDigest: Sha256DigestSchema,
    capabilityId: CapabilityIdSchema,
    state: z.enum(["issued", "used", "expired", "revoked"]),
    capabilityDigest: Sha256DigestSchema,
  }),
  payload("CAPABILITY_REJECTED", {
    actionDigest: Sha256DigestSchema,
    reasonCode: FailureCodeSchema,
  }),
  payload("EXECUTION_ATTEMPTED", {
    actionDigest: Sha256DigestSchema,
    adapterId: AdapterIdSchema,
    attemptReference: AttemptReferenceSchema,
    idempotencyDigest: Sha256DigestSchema,
  }),
  payload("EXECUTION_ABORTED", {
    actionDigest: Sha256DigestSchema,
    adapterId: AdapterIdSchema,
    attemptReference: AttemptReferenceSchema,
    reasonCode: FailureCodeSchema,
  }),
  payload("EFFECT_PREPARED", {
    actionDigest: Sha256DigestSchema,
    adapterId: AdapterIdSchema,
    attemptReference: AttemptReferenceSchema,
    preparedDigest: Sha256DigestSchema,
  }),
  payload("EFFECT_COMMIT_AUTHORIZED", {
    actionDigest: Sha256DigestSchema,
    adapterId: AdapterIdSchema,
    attemptReference: AttemptReferenceSchema,
    actionDecisionDigest: Sha256DigestSchema,
  }),
  payload("EFFECT_OUTCOME_UNKNOWN", {
    actionDigest: Sha256DigestSchema,
    adapterId: AdapterIdSchema,
    attemptReference: AttemptReferenceSchema,
    reasonCode: FailureCodeSchema,
  }),
  payload("EFFECT_UNRESOLVED", {
    actionDigest: Sha256DigestSchema,
    adapterId: AdapterIdSchema,
    attemptReference: AttemptReferenceSchema,
  }),
  payload("EFFECT_VERIFIED", {
    actionDigest: Sha256DigestSchema,
    adapterId: AdapterIdSchema,
    attemptReference: AttemptReferenceSchema,
    effectDigest: Sha256DigestSchema,
  }),
  payload("EXECUTION_FAILED", {
    actionDigest: Sha256DigestSchema,
    adapterId: AdapterIdSchema,
    attemptReference: AttemptReferenceSchema,
    failureCode: FailureCodeSchema,
    failureDigest: Sha256DigestSchema.optional(),
  }),
  payload("AUTHORITY_REVOKED", {
    grantId: GrantIdSchema,
    grantVersion: z.number().int().positive(),
    revocationDigest: Sha256DigestSchema,
  }),
]);

const EvidenceContextShape = {
  schemaVersion: z.literal(1),
  id: EvidenceIdSchema,
  tenantId: TenantIdSchema,
  principalId: PrincipalIdSchema,
  agentId: AgentIdSchema,
  requestId: RequestIdSchema,
  correlationId: CorrelationIdSchema,
  eventTimeEpochMs: EpochMillisecondsSchema,
};

export const EvidenceChainContextSchema = z
  .object({
    tenantId: TenantIdSchema,
    principalId: PrincipalIdSchema,
    agentId: AgentIdSchema,
    requestId: RequestIdSchema,
    correlationId: CorrelationIdSchema,
  })
  .strict();

export const EvidenceEventDraftSchema = z
  .object({ ...EvidenceContextShape, event: EvidenceEventSchema })
  .strict();

export const EvidenceRecordCoreSchema = z
  .object({
    ...EvidenceContextShape,
    event: EvidenceEventSchema,
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    previousRecordHash: Sha256DigestSchema.nullable(),
    payloadDigest: Sha256DigestSchema,
  })
  .strict();

export const EvidenceRecordSchema = z
  .object({
    ...EvidenceRecordCoreSchema.shape,
    recordHash: Sha256DigestSchema,
  })
  .strict();

/** Why a presented human approval session was refused before any approval operation. */
export const HumanSessionRejectionSchema = z.enum([
  "UNAUTHENTICATED",
  "NOT_HUMAN",
  "UNSAFE_SESSION_REFERENCE",
]);

/**
 * Security events recorded before any identity is trusted. They never carry a
 * tenant, principal, agent, credential, or session reference.
 */
export const PreIdentitySecurityEventSchema = z.discriminatedUnion(
  "eventType",
  [
    z
      .object({
        eventType: z.literal("AUTHENTICATION_REJECTED"),
        payload: z
          .object({
            interface: z.enum(["mcp", "rest"]),
            reasonCode: z.literal("UNAUTHENTICATED"),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        eventType: z.literal("HUMAN_AUTHENTICATION_REJECTED"),
        payload: z
          .object({
            surface: z.literal("approval-service"),
            reasonCode: HumanSessionRejectionSchema,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        eventType: z.literal("ADAPTER_AUTHENTICATION_REJECTED"),
        payload: z
          .object({
            surface: z.literal("redemption"),
            reasonCode: z.literal("UNAUTHENTICATED"),
          })
          .strict(),
      })
      .strict(),
  ],
);

export const PreIdentitySecurityRecordCoreSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: EvidenceIdSchema,
    eventTimeEpochMs: EpochMillisecondsSchema,
    event: PreIdentitySecurityEventSchema,
  })
  .strict();

export const PreIdentitySecurityRecordSchema =
  PreIdentitySecurityRecordCoreSchema.extend({
    recordHash: Sha256DigestSchema,
  }).strict();

export type EvidenceEvent = z.infer<typeof EvidenceEventSchema>;
export type EvidenceEventType = EvidenceEvent["eventType"];
export type EvidenceEventDraft = z.infer<typeof EvidenceEventDraftSchema>;
export type EvidenceChainContext = z.infer<typeof EvidenceChainContextSchema>;
export type EvidenceRecordCore = z.infer<typeof EvidenceRecordCoreSchema>;
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;
export type HumanSessionRejection = z.infer<typeof HumanSessionRejectionSchema>;
export type PreIdentitySecurityEvent = z.infer<
  typeof PreIdentitySecurityEventSchema
>;
export type PreIdentitySecurityRecord = z.infer<
  typeof PreIdentitySecurityRecordSchema
>;
