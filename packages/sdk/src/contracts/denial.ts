// Generated file — do not edit.
import { z } from "zod";

import { EpochMillisecondsSchema } from "./authority.js";
import { canonicalSha256 } from "./digest.js";
import {
  AgentIdSchema,
  CorrelationIdSchema,
  PrincipalIdSchema,
  RequestIdSchema,
  TenantIdSchema,
} from "./identifiers.js";
import { CanonicalActionSchema } from "./action.js";

const SHA256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const DenialReasonCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Z][A-Z0-9_]*$/);

/**
 * guardian.request_denial.v1 — the decision artifact for a request denied
 * before the authority kernel produced an ActionDecisionRecord: pre-gate
 * rule denies, budget denies, and request-shape rejects. It is a denied
 * decision, never an execution: no capability was issued and nothing ran.
 *
 * `action`/`actionDigest` are null when the deny preceded canonical action
 * creation (e.g. an adapter the state never allowed); the request is still
 * recorded as denied under its own identity.
 */
export const RequestDenialRecordCoreSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("guardian.request_denial.v1"),
    tenantId: TenantIdSchema,
    principalId: PrincipalIdSchema,
    agentId: AgentIdSchema,
    requestId: RequestIdSchema,
    correlationId: CorrelationIdSchema,
    actionDigest: SHA256Schema.nullable(),
    action: CanonicalActionSchema.nullable(),
    reasonCode: DenialReasonCodeSchema,
    decidedAtEpochMs: EpochMillisecondsSchema,
  })
  .strict();

export const RequestDenialRecordSchema = RequestDenialRecordCoreSchema.extend({
  recordDigest: SHA256Schema,
})
  .strict()
  .superRefine((value, context) => {
    if (
      (value.action === null) !== (value.actionDigest === null) ||
      (value.action !== null &&
        value.actionDigest !== value.action.materialDigest) ||
      (value.action !== null &&
        (value.tenantId !== value.action.tenantId ||
          value.principalId !== value.action.principalId ||
          value.agentId !== value.action.agentId ||
          value.requestId !== value.action.requestId ||
          value.correlationId !== value.action.correlationId))
    ) {
      context.addIssue({
        code: "custom",
        path: ["actionDigest"],
        message: "request denial context does not match the canonical action",
      });
    }
  });

export type RequestDenialRecord = z.infer<typeof RequestDenialRecordSchema>;

export type CreateRequestDenialResult =
  | { ok: true; record: RequestDenialRecord }
  | { ok: false; reasonCode: "REQUEST_DENIAL_BINDING_INVALID" };

export function createRequestDenialRecord(input: {
  tenantId: unknown;
  principalId: unknown;
  agentId: unknown;
  requestId: unknown;
  correlationId: unknown;
  action: unknown;
  reasonCode: unknown;
  decidedAtEpochMs: unknown;
}): CreateRequestDenialResult {
  const action = CanonicalActionSchema.nullable().safeParse(input.action);
  if (!action.success) {
    return { ok: false, reasonCode: "REQUEST_DENIAL_BINDING_INVALID" };
  }
  const core = {
    schemaVersion: 1 as const,
    kind: "guardian.request_denial.v1" as const,
    tenantId: input.tenantId,
    principalId: input.principalId,
    agentId: input.agentId,
    requestId: input.requestId,
    correlationId: input.correlationId,
    actionDigest: action.data === null ? null : action.data.materialDigest,
    action: action.data,
    reasonCode: input.reasonCode,
    decidedAtEpochMs: input.decidedAtEpochMs,
  };
  const record = RequestDenialRecordSchema.safeParse({
    ...core,
    recordDigest: canonicalSha256(core),
  });
  return record.success
    ? { ok: true, record: record.data }
    : { ok: false, reasonCode: "REQUEST_DENIAL_BINDING_INVALID" };
}
