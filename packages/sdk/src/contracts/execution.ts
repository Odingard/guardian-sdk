// Generated file — do not edit.
import { z } from "zod";

import { CanonicalActionSchema } from "./action.js";
import { EpochMillisecondsSchema } from "./authority.js";
import { canonicalSha256 } from "./digest.js";
import { Sha256DigestSchema } from "./evidence.js";
import {
  AdapterIdSchema,
  AgentIdSchema,
  AttemptIdSchema,
  CapabilityIdSchema,
  ConnectionIdSchema,
  CorrelationIdSchema,
  PrincipalIdSchema,
  RequestIdSchema,
  TenantIdSchema,
} from "./identifiers.js";

export const ProviderSchema = z.enum([
  "gmail",
  "graph",
  "api",
  "tool",
  "gcalendar",
  "payment-sandbox",
  "file",
  "protected_data",
  "local",
  "guardian",
  "clawlink",
]);
export const ConnectionProfileSchema = z.enum([
  "gmail-split-compose-metadata",
  "gmail-compose-readonly",
  "graph-readwrite-send",
  "api-bearer-request",
  "tool-mcp-server",
  "gcalendar-events-v1",
  "payment-sandbox-charge",
  "file-local-store",
  "protected-data-store",
  "local-agent-runtime",
  "guardian-agent-v1",
  "clawlink-executions",
]);
export const VerificationLevelSchema = z.enum([
  "post-commit-content",
  "pre-commit-content+post-commit-envelope",
]);
export const LeasePurposeSchema = z.enum([
  "account",
  "prepare",
  "readback",
  "commit",
  "observe",
  "cleanup",
]);
export const ExecutionStateSchema = z.enum([
  "reserved",
  "redeemed",
  "preparing",
  "prepared",
  "committing",
  "unknown",
  "unresolved",
  "verified",
  "mismatch",
  "commit-rejected",
  "aborted",
]);
export const ExecutionFailureCodeSchema = z.enum([
  "SENDER_ACCOUNT_MISMATCH",
  "CREDENTIAL_UNAVAILABLE",
  "PREPARE_REJECTED",
  "PREPARE_AMBIGUOUS",
  "READBACK_UNAVAILABLE",
  "PREPARED_CONTENT_MISMATCH",
  "COMMIT_NOT_AUTHORIZED",
  "AUTHORITY_REVOKED_BEFORE_COMMIT",
  "COMMIT_DEADLINE_EXPIRED",
  "ABORTED_BEFORE_COMMIT",
  "COMMIT_NOT_ISSUED",
  "COMMIT_REJECTED",
  "EFFECT_MISMATCH",
  "DUPLICATE_EFFECT_DETECTED",
]);
export const ExecutionAbortReasonSchema = z.literal(
  "INTERRUPTED_BEFORE_ATTEMPT",
);
export const ExecutionUnknownReasonSchema = z.enum([
  "COMMIT_RESPONSE_LOST",
  "COMMIT_TIMEOUT",
  "COMMIT_SERVER_ERROR",
  "COMMIT_RESPONSE_INVALID",
  "COMMIT_REDIRECT_REFUSED",
  "COMMIT_TARGET_NOT_FOUND",
  "REJECTION_UNCONFIRMED",
  "AWAITING_PROVIDER_RECORD",
  "VERIFICATION_UNAVAILABLE",
]);

export const ProviderIdSchema = z.string().regex(/^[A-Za-z0-9_=+/-]{1,512}$/);
export const InternetMessageIdSchema = z
  .string()
  .regex(/^<[\x21-\x3b\x3d\x3f-\x7e]{1,995}>$/);

export const ProviderObjectRefSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("gmail-draft"),
      draftId: ProviderIdSchema,
      messageId: ProviderIdSchema,
      threadId: ProviderIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("graph-message"),
      immutableId: ProviderIdSchema,
      internetMessageId: InternetMessageIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("api-request"),
      requestDigest: ProviderIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("tool-call"),
      callDigest: Sha256DigestSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("gcalendar-plan"),
      requestDigest: ProviderIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("payment-order"),
      orderId: ProviderIdSchema,
      intentId: ProviderIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("file-request"),
      requestDigest: ProviderIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("protected_data-op"),
      operationDigest: ProviderIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("guardian-call"),
      callDigest: Sha256DigestSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("clawlink-execution"),
      requestDigest: Sha256DigestSchema,
    })
    .strict(),
]);

export const ProviderSentRefSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("gmail-message"),
      messageId: ProviderIdSchema,
      threadId: ProviderIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("graph-message"),
      immutableId: ProviderIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("api-response"),
      status: z.number().int().min(0).max(999),
      bodyBytes: z.number().int().min(0),
      headersDigest: Sha256DigestSchema,
      bodyDigest: Sha256DigestSchema,
      bodyPreview: z.string().max(512),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tool-response"),
      operation: z.enum(["invoke", "install", "enable"]),
      toolName: z.string().min(1).max(64),
      status: z.number().int().min(0).max(999).nullable(),
      resultDigest: Sha256DigestSchema,
      detail: z.string().max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal("gcalendar-event"),
      eventId: ProviderIdSchema,
      status: z.enum(["confirmed", "cancelled"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("payment-charge"),
      chargeId: ProviderIdSchema,
      amountCents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      currency: z.string().trim().min(3).max(3),
      status: z.enum(["succeeded", "refunded", "returned", "voided"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file-effect"),
      operation: z.enum(["read", "write", "share", "delete"]),
      path: z.string().min(1).max(512),
      contentDigest: Sha256DigestSchema.nullable(),
      bytes: z.number().int().min(0),
      shareId: ProviderIdSchema.nullable(),
      grantee: z.string().max(256).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("protected_data-effect"),
      operation: z.enum(["use", "view", "disclose", "persist"]),
      fieldRef: z.string().min(1).max(64),
      valueDigest: Sha256DigestSchema,
      counterparty: z.string().max(256).nullable(),
      maskedPreview: z.string().max(120).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("guardian-effect"),
      operation: z.string().min(1).max(64),
      subject: z.string().min(1).max(256).nullable(),
      status: z.string().min(1).max(64),
      resultDigest: Sha256DigestSchema,
      detail: z.string().max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal("clawlink-execution"),
      executionId: ProviderIdSchema,
      executionStatus: z.literal("succeeded"),
      resultDigest: Sha256DigestSchema,
      detail: z.string().max(256),
    })
    .strict(),
]);

export const VerifiedOutcomeSchema = z
  .object({
    kind: z.literal("verified"),
    sentRef: ProviderSentRefSchema,
    observedDigest: Sha256DigestSchema,
    effectDigest: Sha256DigestSchema,
    level: VerificationLevelSchema,
    observedAtEpochMs: EpochMillisecondsSchema,
  })
  .strict();
export const MismatchOutcomeSchema = z
  .object({
    kind: z.literal("mismatch"),
    code: z.enum(["EFFECT_MISMATCH", "DUPLICATE_EFFECT_DETECTED"]),
    observedDigest: Sha256DigestSchema.nullable(),
  })
  .strict();
export const CommitRejectedOutcomeSchema = z
  .object({
    kind: z.literal("commit-rejected"),
    providerStatus: z.union([
      z.literal(0),
      z.literal(400),
      z.literal(401),
      z.literal(403),
      z.literal(404),
      z.literal(409),
      z.literal(413),
      z.literal(422),
      z.literal(429),
    ]),
    confirmedAtEpochMs: EpochMillisecondsSchema,
  })
  .strict();
export const UnknownOutcomeSchema = z
  .object({
    kind: z.literal("unknown"),
    reason: ExecutionUnknownReasonSchema,
  })
  .strict();
export const AbortedOutcomeSchema = z
  .object({
    kind: z.literal("aborted"),
    code: ExecutionFailureCodeSchema,
    orphanDraftPossible: z.boolean(),
  })
  .strict();
export const UnresolvedOutcomeSchema = z
  .object({
    kind: z.literal("unresolved"),
    reason: ExecutionUnknownReasonSchema,
  })
  .strict();

export const OutcomeSchema = z.discriminatedUnion("kind", [
  VerifiedOutcomeSchema,
  MismatchOutcomeSchema,
  CommitRejectedOutcomeSchema,
  UnknownOutcomeSchema,
  AbortedOutcomeSchema,
  UnresolvedOutcomeSchema,
]);
export const PendingOutcomeSchema = OutcomeSchema;

export const ExecutionRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    attemptId: AttemptIdSchema,
    tenantId: TenantIdSchema,
    principalId: PrincipalIdSchema,
    agentId: AgentIdSchema,
    requestId: RequestIdSchema,
    correlationId: CorrelationIdSchema,
    capabilityId: CapabilityIdSchema,
    actionDigest: Sha256DigestSchema,
    adapterId: AdapterIdSchema,
    connectionId: ConnectionIdSchema,
    provider: ProviderSchema,
    profile: ConnectionProfileSchema,
    effectKey: Sha256DigestSchema,
    expectedProjectionDigest: Sha256DigestSchema,
    expectedEnvelopeDigest: Sha256DigestSchema,
    state: ExecutionStateSchema,
    version: z.number().int().positive().safe(),
    reservedAtEpochMs: EpochMillisecondsSchema,
    updatedAtEpochMs: EpochMillisecondsSchema,
    commitDeadlineEpochMs: EpochMillisecondsSchema,
    commitLeaseDeadlineEpochMs: EpochMillisecondsSchema.nullable(),
    reconcileDeadlineEpochMs: EpochMillisecondsSchema.nullable(),
    lateReconcileDeadlineEpochMs: EpochMillisecondsSchema.nullable(),
    commitLeaseIssued: z.boolean(),
    providerObjectRef: ProviderObjectRefSchema.nullable(),
    sentRef: ProviderSentRefSchema.nullable(),
    orphanDraftPossible: z.boolean(),
    pendingOutcome: PendingOutcomeSchema.nullable(),
    outcome: OutcomeSchema.nullable(),
  })
  .strict();

export const AdapterRedemptionRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    capabilityToken: z.string().min(1).max(512),
    requestId: RequestIdSchema,
    presentedBy: z
      .object({
        tenantId: TenantIdSchema,
        principalId: PrincipalIdSchema,
        agentId: AgentIdSchema,
      })
      .strict(),
  })
  .strict();

export const ExecutionGrantSchema = z
  .object({
    schemaVersion: z.literal(1),
    attemptId: AttemptIdSchema,
    version: z.number().int().positive().safe(),
    connectionId: ConnectionIdSchema,
    provider: ProviderSchema,
    profile: ConnectionProfileSchema,
    action: CanonicalActionSchema,
    expectedProjectionDigest: Sha256DigestSchema,
    expectedEnvelopeDigest: Sha256DigestSchema,
    commitDeadlineEpochMs: EpochMillisecondsSchema,
  })
  .strict();

const expectedVersion = z.number().int().positive().safe();
const CommandOutcomeSchema = z.discriminatedUnion("kind", [
  VerifiedOutcomeSchema.omit({ effectDigest: true }),
  MismatchOutcomeSchema,
  CommitRejectedOutcomeSchema,
  UnknownOutcomeSchema,
]);

export const ExecutionStageCommandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("begin-prepare"), expectedVersion }).strict(),
  z
    .object({
      command: z.literal("prepared"),
      expectedVersion,
      providerObjectRef: ProviderObjectRefSchema,
      preparedProjectionDigest: Sha256DigestSchema,
    })
    .strict(),
  z.object({ command: z.literal("commit-request"), expectedVersion }).strict(),
  z
    .object({
      command: z.literal("outcome"),
      expectedVersion,
      outcome: CommandOutcomeSchema,
    })
    .strict(),
  z
    .object({
      command: z.literal("abort"),
      expectedVersion,
      code: ExecutionFailureCodeSchema,
      orphanDraftPossible: z.boolean(),
    })
    .strict(),
]);

export const AgentExecutionRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: RequestIdSchema,
    capabilityToken: z.string().min(1).max(512),
  })
  .strict();
export const AgentExecutionReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: RequestIdSchema,
    receiptReference: AttemptIdSchema,
    status: z.enum([
      "sent-verified",
      "not-sent",
      "outcome-pending",
      "outcome-unconfirmed",
    ]),
    /**
     * Inline-only delivery channel. Carries the value the action was
     * authorized to hand the agent — a file's content for `file.read` or the
     * field value for `protected_data.view` — digest-correlated with the
     * sentRef. Never written to the ledger; only `protected_data.view` and
     * `file.read` produce it and only on a `sent-verified` receipt.
     */
    delivered: z
      .object({
        kind: z.enum(["file-content", "protected-value", "agent-secret"]),
        fieldRef: z.string().min(1).max(64).nullable(),
        path: z.string().min(1).max(512).nullable(),
        value: z.string().max(64_000),
        valueDigest: Sha256DigestSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

export function effectKey(input: {
  tenantId: string;
  capabilityId: string;
  actionDigest: string;
  attemptId: string;
}): string {
  return canonicalSha256({
    domain: "odingard.guardian.effect-key.v1",
    ...input,
  });
}

export function effectDigest(input: {
  provider: z.infer<typeof ProviderSchema>;
  adapterId: string;
  attemptId: string;
  sentRefDigest: string;
  observedDigest: string;
  level: z.infer<typeof VerificationLevelSchema>;
  observedAtEpochMs: number;
}): string {
  return canonicalSha256({
    domain: "odingard.guardian.email-effect.v1",
    ...input,
  });
}

export interface ProviderAuthorization {
  readonly provider: z.infer<typeof ProviderSchema>;
  readonly purpose: z.infer<typeof LeasePurposeSchema>;
  readonly expiresAtEpochMs: number;
  authorizeRequest(input: {
    origin: string;
    endpointClass: "commit" | "read" | "write" | "delete";
    nowEpochMs: number;
  }): Readonly<Record<string, string>> | null;
  toJSON(): "[redacted]";
  toString(): "[redacted]";
}

export type Provider = z.infer<typeof ProviderSchema>;
export type ConnectionProfile = z.infer<typeof ConnectionProfileSchema>;
export type VerificationLevel = z.infer<typeof VerificationLevelSchema>;
export type LeasePurpose = z.infer<typeof LeasePurposeSchema>;
export type ExecutionState = z.infer<typeof ExecutionStateSchema>;
export type ExecutionFailureCode = z.infer<typeof ExecutionFailureCodeSchema>;
export type ExecutionUnknownReason = z.infer<
  typeof ExecutionUnknownReasonSchema
>;
export type ProviderObjectRef = z.infer<typeof ProviderObjectRefSchema>;
export type ProviderSentRef = z.infer<typeof ProviderSentRefSchema>;
export type ExecutionOutcome = z.infer<typeof OutcomeSchema>;
export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;
export type AdapterRedemptionRequest = z.infer<
  typeof AdapterRedemptionRequestSchema
>;
export type ExecutionGrant = z.infer<typeof ExecutionGrantSchema>;
export type ExecutionStageCommand = z.infer<typeof ExecutionStageCommandSchema>;
export type AgentExecutionRequest = z.infer<typeof AgentExecutionRequestSchema>;
export type AgentExecutionReceipt = z.infer<typeof AgentExecutionReceiptSchema>;
