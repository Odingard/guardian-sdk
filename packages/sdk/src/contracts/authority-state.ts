// Generated file — do not edit.
import { z } from "zod";

import {
  AgentIdentitySchema,
  AuthorityGrantSchema,
  AuthorityPauseSchema,
  BudgetStateSchema,
  EpochMillisecondsSchema,
  PolicyReferenceSchema,
  PrincipalSchema,
  RevocationSchema,
} from "./authority.js";
import {
  RecordedAuthorityEvaluationInputSchema,
  toAuthorityRequest,
  type CanonicalAction,
  type RecordedAuthorityEvaluationInput,
} from "./action.js";
import { AdapterIdSchema } from "./identifiers.js";

export const AuthorityStateSnapshotSchema = z
  .object({
    principal: PrincipalSchema,
    agent: AgentIdentitySchema,
    policy: PolicyReferenceSchema,
    authorityChain: z.array(AuthorityGrantSchema).max(32),
    revocations: z.array(RevocationSchema).max(256),
    pauses: z.array(AuthorityPauseSchema).max(256).default([]),
    allowedAdapterIds: z.array(AdapterIdSchema).max(64),
    budgets: z.array(BudgetStateSchema).max(64).default([]),
  })
  .strict();

export type AuthorityStateSnapshot = z.infer<
  typeof AuthorityStateSnapshotSchema
>;

export function buildRecordedEvaluationInput(
  actionInput: CanonicalAction,
  stateInput: AuthorityStateSnapshot,
  nowEpochMs: number,
): RecordedAuthorityEvaluationInput {
  const state = AuthorityStateSnapshotSchema.parse(stateInput);
  const now = EpochMillisecondsSchema.parse(nowEpochMs);
  if (
    state.principal.id !== actionInput.principalId ||
    state.principal.tenantId !== actionInput.tenantId ||
    state.agent.id !== actionInput.agentId ||
    state.agent.tenantId !== actionInput.tenantId ||
    state.agent.ownerPrincipalId !== actionInput.principalId
  ) {
    throw new TypeError("authority state identity does not match the action");
  }
  return RecordedAuthorityEvaluationInputSchema.parse({
    nowEpochMs: now,
    principal: state.principal,
    agent: state.agent,
    request: toAuthorityRequest(actionInput),
    policy: state.policy,
    authorityChain: state.authorityChain,
    revocations: state.revocations,
    pauses: state.pauses,
    budgets: state.budgets,
  });
}
