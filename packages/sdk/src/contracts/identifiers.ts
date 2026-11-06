// Generated file — do not edit.
import { z } from "zod";

function identifier<const T extends string>(prefix: string, brand: T) {
  return z
    .string()
    .regex(
      new RegExp(`^${prefix}_[A-Za-z0-9][A-Za-z0-9_-]{7,119}$`),
      `${brand} must use the ${prefix}_ prefix and contain 8-120 safe characters`,
    )
    .brand<T>();
}

export const TenantIdSchema = identifier("ten", "TenantId");
export const PrincipalIdSchema = identifier("pri", "PrincipalId");
export const AgentIdSchema = identifier("agt", "AgentId");
export const GrantIdSchema = identifier("grt", "GrantId");
export const PolicyIdSchema = identifier("pol", "PolicyId");
export const RequestIdSchema = identifier("req", "RequestId");
export const ApprovalIdSchema = identifier("apr", "ApprovalId");
export const CapabilityIdSchema = identifier("cap", "CapabilityId");
export const CorrelationIdSchema = identifier("cor", "CorrelationId");
export const EvidenceIdSchema = identifier("evd", "EvidenceId");
export const AdapterIdSchema = identifier("adp", "AdapterId");
export const ConnectionIdSchema = identifier("pcn", "ConnectionId");
export const AttemptIdSchema = identifier("att", "AttemptId");
export const BudgetIdSchema = identifier("bdg", "BudgetId");
export const TaskIdSchema = identifier("tsk", "TaskId");
export const PauseIdSchema = identifier("pse", "PauseId");
export const ScopeIdSchema = identifier("scp", "ScopeId");
export const MembershipIdSchema = identifier("mem", "MembershipId");
export const IntentIdSchema = identifier("int", "IntentId");
export const PlanIdSchema = identifier("pln", "PlanId");
export const DataObjectIdSchema = identifier("dobj", "DataObjectId");
export const LineageEventIdSchema = identifier("lev", "LineageEventId");
export const TransactionIdSchema = identifier("txn", "TransactionId");
export const NonceSchema = z
  .string()
  .regex(
    /^nce_[A-Za-z0-9_-]{22,116}$/,
    "Nonce must use the nce_ prefix and contain 22-116 base64url-safe characters",
  )
  .brand<"Nonce">();

export type TenantId = z.infer<typeof TenantIdSchema>;
export type PrincipalId = z.infer<typeof PrincipalIdSchema>;
export type AgentId = z.infer<typeof AgentIdSchema>;
export type GrantId = z.infer<typeof GrantIdSchema>;
export type PolicyId = z.infer<typeof PolicyIdSchema>;
export type RequestId = z.infer<typeof RequestIdSchema>;
export type ApprovalId = z.infer<typeof ApprovalIdSchema>;
export type CapabilityId = z.infer<typeof CapabilityIdSchema>;
export type CorrelationId = z.infer<typeof CorrelationIdSchema>;
export type EvidenceId = z.infer<typeof EvidenceIdSchema>;
export type AdapterId = z.infer<typeof AdapterIdSchema>;
export type ConnectionId = z.infer<typeof ConnectionIdSchema>;
export type AttemptId = z.infer<typeof AttemptIdSchema>;
export type BudgetId = z.infer<typeof BudgetIdSchema>;
export type TaskId = z.infer<typeof TaskIdSchema>;
export type PauseId = z.infer<typeof PauseIdSchema>;
export type ScopeId = z.infer<typeof ScopeIdSchema>;
export type MembershipId = z.infer<typeof MembershipIdSchema>;
export type IntentId = z.infer<typeof IntentIdSchema>;
export type PlanId = z.infer<typeof PlanIdSchema>;
export type DataObjectId = z.infer<typeof DataObjectIdSchema>;
export type LineageEventId = z.infer<typeof LineageEventIdSchema>;
export type TransactionId = z.infer<typeof TransactionIdSchema>;
export type Nonce = z.infer<typeof NonceSchema>;
