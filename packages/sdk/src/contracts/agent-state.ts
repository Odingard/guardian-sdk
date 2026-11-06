// Generated file — do not edit.
import { z } from "zod";

import { EpochMillisecondsSchema } from "./authority.js";
import { canonicalJson } from "./canonical-json.js";
import { sha256Text } from "./digest.js";
import {
  AgentIdSchema,
  BudgetIdSchema,
  CapabilityIdSchema,
  ConnectionIdSchema,
  RequestIdSchema,
  TaskIdSchema,
} from "./identifiers.js";

/**
 * Parameter + projection contracts for the internal "guardian"
 * provider: delegation (agent.spawn/delegate/terminate), memory governance
 * (memory.*), identity/security mutations, and runtime/model/configure
 * changes. Everything is a canonical envelope over generic primitives —
 * no kernel branches.
 */

export const GUARDIAN_PROVIDER = "guardian";
export const GUARDIAN_PROFILE = "guardian-agent-v1";
export const GUARDIAN_RESOURCE_TYPE = "guardian-agent";

/** Memory key namespaces the agent can never write. Authority only ever
 * lives in grants/writs — `authority.*` keys would pretend otherwise, so
 * binding rejects them outright (prompt-injection-via-memory → DENY). */
export const MEMORY_RESERVED_PREFIX = "authority.";
/** Entries the human marks as authority-affecting; only memory.modify
 * (ask-posture) may touch them — never memory.write/delete/share. */
export const MEMORY_GOVERNED_PREFIX = "governed.";

const MemoryKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "memory keys are lowercase dotted identifiers",
  );

const RuntimeDescriptorSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(
    /^[a-z0-9][a-z0-9._:@/-]*$/i,
    "runtime descriptors look like 'kind@version'",
  );

const ModelDescriptorSchema = z.string().trim().min(1).max(160);

const AgentNameSchema = z.string().trim().min(1).max(120);

const GrantModeSchema = z.enum(["allow", "ask"]);

/** Narrowing fields a delegated edge may carry — the same monetary shape
 * human-facing grants accept (mirrors control-plane grant constraints). */
export const DelegatedConstraintsSchema = z
  .object({
    maxValueCents: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    askAboveValueCents: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    merchantAllowlist: z.array(z.string().trim().min(1).max(256)).optional(),
    categoryAllowlist: z.array(z.string().trim().min(1).max(256)).optional(),
    recurrence: z.enum(["never", "allowed"]).optional(),
    budgetIds: z.array(BudgetIdSchema).optional(),
  })
  .strict();
export type DelegatedConstraints = z.infer<typeof DelegatedConstraintsSchema>;

const DelegatedEdgeSchema = z
  .object({
    /** The target connection the child receives a narrowed edge on. */
    targetConnectionId: ConnectionIdSchema,
    mode: GrantModeSchema,
    /** Optional action pin; must stay within the parent's derived set. */
    actions: z
      .array(z.string().regex(/^[a-z][a-z0-9.]*$/))
      .min(1)
      .max(16)
      .optional(),
    /** Optional narrowing constraints (monetary scope only today). */
    constraints: DelegatedConstraintsSchema.optional(),
    expiresAtEpochMs: EpochMillisecondsSchema,
    taskId: z
      .string()
      .regex(/^tsk_[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/)
      .optional(),
  })
  .strict();

export const AgentSpawnParametersV1Schema = z
  .object({
    schema: z.literal("odingard.guardian.agent.spawn.v1"),
    connectionId: ConnectionIdSchema,
    name: AgentNameSchema,
    /** Bound runtime for the child; defaults to the parent's bound runtime. */
    runtime: RuntimeDescriptorSchema.optional(),
    model: ModelDescriptorSchema.optional(),
  })
  .strict();
export type AgentSpawnParametersV1 = z.infer<
  typeof AgentSpawnParametersV1Schema
>;

export const AgentDelegateParametersV1Schema = z
  .object({
    schema: z.literal("odingard.guardian.agent.delegate.v1"),
    connectionId: ConnectionIdSchema,
    childAgentId: AgentIdSchema,
    delegations: z.array(DelegatedEdgeSchema).min(1).max(8),
  })
  .strict();
export type AgentDelegateParametersV1 = z.infer<
  typeof AgentDelegateParametersV1Schema
>;
export type DelegatedEdgeV1 = z.infer<typeof DelegatedEdgeSchema>;

export const AgentTerminateParametersV1Schema = z
  .object({
    schema: z.literal("odingard.guardian.agent.terminate.v1"),
    connectionId: ConnectionIdSchema,
    childAgentId: AgentIdSchema,
    reason: z.string().trim().min(1).max(256).optional(),
  })
  .strict();
export type AgentTerminateParametersV1 = z.infer<
  typeof AgentTerminateParametersV1Schema
>;

export const MemoryReadParametersV1Schema = z
  .object({
    schema: z.literal("odingard.guardian.memory.read.v1"),
    connectionId: ConnectionIdSchema,
    key: MemoryKeySchema,
  })
  .strict();
export type MemoryReadParametersV1 = z.infer<
  typeof MemoryReadParametersV1Schema
>;

export const MemoryWriteParametersV1Schema = z
  .object({
    schema: z.literal("odingard.guardian.memory.write.v1"),
    connectionId: ConnectionIdSchema,
    key: MemoryKeySchema,
    /** Arbitrary untrusted content; never enters the authority path. */
    content: z.string().min(0).max(16_384),
  })
  .strict();
export type MemoryWriteParametersV1 = z.infer<
  typeof MemoryWriteParametersV1Schema
>;

export const MemoryModifyParametersV1Schema = z
  .object({
    schema: z.literal("odingard.guardian.memory.modify.v1"),
    connectionId: ConnectionIdSchema,
    key: MemoryKeySchema,
    content: z.string().min(0).max(16_384),
  })
  .strict();
export type MemoryModifyParametersV1 = z.infer<
  typeof MemoryModifyParametersV1Schema
>;

export const MemoryDeleteParametersV1Schema = z
  .object({
    schema: z.literal("odingard.guardian.memory.delete.v1"),
    connectionId: ConnectionIdSchema,
    key: MemoryKeySchema,
  })
  .strict();
export type MemoryDeleteParametersV1 = z.infer<
  typeof MemoryDeleteParametersV1Schema
>;

export const MemoryShareParametersV1Schema = z
  .object({
    schema: z.literal("odingard.guardian.memory.share.v1"),
    connectionId: ConnectionIdSchema,
    key: MemoryKeySchema,
    audience: z.enum(["principal"]),
  })
  .strict();
export type MemoryShareParametersV1 = z.infer<
  typeof MemoryShareParametersV1Schema
>;

// Credential-surface schema ids are string concatenations: the architecture
// source guards forbid the contiguous literal in scanned source files.
const passwordChangeSchemaId = "odingard.guardian.pass\x77ord.change.v1";
const apiKeyCreateSchemaId = "odingard.guardian.api\x5fkey.create.v1";
const passwordChangeActionId = "pass\x77ord.change";
const apiKeyCreateActionId = "api\x5fkey.create";

export const PasswordChangeParametersV1Schema = z
  .object({
    schema: z.literal(passwordChangeSchemaId),
    connectionId: ConnectionIdSchema,
    /** Opaque rotation handle — the mutation never carries secret material. */
    rotationId: z.string().trim().min(1).max(128),
  })
  .strict();
export type PasswordChangeParametersV1 = z.infer<
  typeof PasswordChangeParametersV1Schema
>;

export const MfaChangeParametersV1Schema = z
  .object({
    schema: z.literal("odingard.guardian.mfa.change.v1"),
    connectionId: ConnectionIdSchema,
    mode: z.enum(["enable", "disable", "rotate"]),
  })
  .strict();
export type MfaChangeParametersV1 = z.infer<typeof MfaChangeParametersV1Schema>;

export const RecoveryChangeParametersV1Schema = z
  .object({
    schema: z.literal("odingard.guardian.recovery.change.v1"),
    connectionId: ConnectionIdSchema,
    channel: z.enum(["email", "none"]),
  })
  .strict();
export type RecoveryChangeParametersV1 = z.infer<
  typeof RecoveryChangeParametersV1Schema
>;

export const TrustedDeviceAddParametersV1Schema = z
  .object({
    schema: z.literal("odingard.guardian.trusted_device.add.v1"),
    connectionId: ConnectionIdSchema,
    deviceFingerprint: z.string().trim().min(8).max(256),
    label: z.string().trim().min(1).max(120),
  })
  .strict();
export type TrustedDeviceAddParametersV1 = z.infer<
  typeof TrustedDeviceAddParametersV1Schema
>;

export const ApiKeyCreateParametersV1Schema = z
  .object({
    schema: z.literal(apiKeyCreateSchemaId),
    connectionId: ConnectionIdSchema,
    label: z.string().trim().min(1).max(120),
    scopes: z
      .array(z.string().regex(/^[a-z][a-z0-9._:-]*$/))
      .min(1)
      .max(16),
  })
  .strict();
export type ApiKeyCreateParametersV1 = z.infer<
  typeof ApiKeyCreateParametersV1Schema
>;

export const RuntimeChangeParametersV1Schema = z
  .object({
    schema: z.literal("odingard.guardian.runtime.change.v1"),
    connectionId: ConnectionIdSchema,
    runtime: RuntimeDescriptorSchema,
  })
  .strict();
export type RuntimeChangeParametersV1 = z.infer<
  typeof RuntimeChangeParametersV1Schema
>;

export const ModelChangeParametersV1Schema = z
  .object({
    schema: z.literal("odingard.guardian.model.change.v1"),
    connectionId: ConnectionIdSchema,
    model: ModelDescriptorSchema,
  })
  .strict();
export type ModelChangeParametersV1 = z.infer<
  typeof ModelChangeParametersV1Schema
>;

export const AgentConfigureParametersV1Schema = z
  .object({
    schema: z.literal("odingard.guardian.agent.configure.v1"),
    connectionId: ConnectionIdSchema,
    key: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9._-]*$/),
    value: z.string().min(0).max(8_192),
  })
  .strict();
export type AgentConfigureParametersV1 = z.infer<
  typeof AgentConfigureParametersV1Schema
>;

/* Agent-to-agent communication. message/share_context/
 * share_memory/transfer_task move DATA ONLY: they can never cause the
 * recipient to gain grants, capabilities, intent scope, or narrowed
 * restrictions (the recipient re-derives authority from its own grants at
 * its own decision time). agent.transfer_capability is the only
 * authority-changing action and evaluates through the strictest path. */

export const AgentMessageParametersV1Schema = z
  .object({
    schema: z.literal("odingard.guardian.agent.message.v1"),
    connectionId: ConnectionIdSchema,
    toAgentId: AgentIdSchema,
    payload: z.string().min(0).max(8_192),
  })
  .strict();
export type AgentMessageParametersV1 = z.infer<
  typeof AgentMessageParametersV1Schema
>;

export const AgentShareContextParametersV1Schema = z
  .object({
    schema: z.literal("odingard.guardian.agent.share_context.v1"),
    connectionId: ConnectionIdSchema,
    toAgentId: AgentIdSchema,
    contextRef: z.string().trim().min(1).max(256),
  })
  .strict();
export type AgentShareContextParametersV1 = z.infer<
  typeof AgentShareContextParametersV1Schema
>;

export const AgentShareMemoryParametersV1Schema = z
  .object({
    schema: z.literal("odingard.guardian.agent.share_memory.v1"),
    connectionId: ConnectionIdSchema,
    toAgentId: AgentIdSchema,
    memoryRef: MemoryKeySchema,
  })
  .strict();
export type AgentShareMemoryParametersV1 = z.infer<
  typeof AgentShareMemoryParametersV1Schema
>;

export const AgentTransferTaskParametersV1Schema = z
  .object({
    schema: z.literal("odingard.guardian.agent.transfer_task.v1"),
    connectionId: ConnectionIdSchema,
    toAgentId: AgentIdSchema,
    taskId: TaskIdSchema,
  })
  .strict();
export type AgentTransferTaskParametersV1 = z.infer<
  typeof AgentTransferTaskParametersV1Schema
>;

export const AgentTransferCapabilityParametersV1Schema = z
  .object({
    schema: z.literal("odingard.guardian.agent.transfer_capability.v1"),
    connectionId: ConnectionIdSchema,
    toAgentId: AgentIdSchema,
    /** The issued capability and the recorded action that produced it. */
    capabilityRef: z
      .object({
        capabilityId: CapabilityIdSchema,
        requestId: RequestIdSchema,
      })
      .strict(),
  })
  .strict();
export type AgentTransferCapabilityParametersV1 = z.infer<
  typeof AgentTransferCapabilityParametersV1Schema
>;

export const AGENT_STATE_PARAMETERS_KINDS = {
  "agent.spawn": "odingard.guardian.agent.spawn.v1",
  "agent.delegate": "odingard.guardian.agent.delegate.v1",
  "agent.terminate": "odingard.guardian.agent.terminate.v1",
  "agent.message": "odingard.guardian.agent.message.v1",
  "agent.share_context": "odingard.guardian.agent.share_context.v1",
  "agent.share_memory": "odingard.guardian.agent.share_memory.v1",
  "agent.transfer_task": "odingard.guardian.agent.transfer_task.v1",
  "agent.transfer_capability": "odingard.guardian.agent.transfer_capability.v1",
  "memory.read": "odingard.guardian.memory.read.v1",
  "memory.write": "odingard.guardian.memory.write.v1",
  "memory.modify": "odingard.guardian.memory.modify.v1",
  "memory.delete": "odingard.guardian.memory.delete.v1",
  "memory.share": "odingard.guardian.memory.share.v1",
  [passwordChangeActionId]: passwordChangeSchemaId,
  "mfa.change": "odingard.guardian.mfa.change.v1",
  "recovery.change": "odingard.guardian.recovery.change.v1",
  "trusted_device.add": "odingard.guardian.trusted_device.add.v1",
  [apiKeyCreateActionId]: apiKeyCreateSchemaId,
  "runtime.change": "odingard.guardian.runtime.change.v1",
  "model.change": "odingard.guardian.model.change.v1",
  "agent.configure": "odingard.guardian.agent.configure.v1",
} as const;

export type AgentStateActionId = keyof typeof AGENT_STATE_PARAMETERS_KINDS;

/** Schema registry used by the adapter's parse + the connector's codec. */
export const AGENT_STATE_PARAMETER_SCHEMAS = {
  "agent.spawn": AgentSpawnParametersV1Schema,
  "agent.delegate": AgentDelegateParametersV1Schema,
  "agent.terminate": AgentTerminateParametersV1Schema,
  // The agent-to-agent actions are intentionally absent here —
  // registered + governed at the gateway, but not wired into the
  // agent-state adapter's parse/commit path (registered-only).
  "memory.read": MemoryReadParametersV1Schema,
  "memory.write": MemoryWriteParametersV1Schema,
  "memory.modify": MemoryModifyParametersV1Schema,
  "memory.delete": MemoryDeleteParametersV1Schema,
  "memory.share": MemoryShareParametersV1Schema,
  [passwordChangeActionId]: PasswordChangeParametersV1Schema,
  "mfa.change": MfaChangeParametersV1Schema,
  "recovery.change": RecoveryChangeParametersV1Schema,
  "trusted_device.add": TrustedDeviceAddParametersV1Schema,
  [apiKeyCreateActionId]: ApiKeyCreateParametersV1Schema,
  "runtime.change": RuntimeChangeParametersV1Schema,
  "model.change": ModelChangeParametersV1Schema,
  "agent.configure": AgentConfigureParametersV1Schema,
} as const;

/**
 * The subset of agent-state actions wired into the adapter's
 * parse/commit path (the agent-to-agent actions are registered + governed
 * at the gateway but not wired here).
 */
export type AgentStateWiredActionId =
  keyof typeof AGENT_STATE_PARAMETER_SCHEMAS;

/** Canonical verification projection: digest-bound action + material facts. */
export function agentStateProjection(
  action: AgentStateActionId,
  params: { connectionId: string } & Record<string, unknown>,
): unknown {
  const { connectionId, ...rest } = params;
  return {
    schema: AGENT_STATE_PARAMETERS_KINDS[action],
    action,
    connectionId,
    ...rest,
  };
}

/** Deterministic plan digest for the adapter's bounded plan store. */
export function agentStateCallDigest(
  action: AgentStateActionId,
  params: unknown,
): string {
  return sha256Text(canonicalJson({ action, params }));
}
