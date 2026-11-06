// Generated file — do not edit.
import { z } from "zod";

import {
  ActionTypeSchema,
  AuthorityConstraintsSchema,
  EpochMillisecondsSchema,
  RecurrencePolicySchema,
  ResourceRefSchema,
} from "./authority.js";
import {
  AdapterIdSchema,
  AgentIdSchema,
  ConnectionIdSchema,
  GrantIdSchema,
  PauseIdSchema,
  PrincipalIdSchema,
  TaskIdSchema,
  TenantIdSchema,
} from "./identifiers.js";

/**
 * The authority graph: principal → agent → task → tool/resource
 * nodes with bounded delegated edges. This is a read model over the same
 * authority state the kernel evaluates; it never carries a second policy
 * path.
 */

export const AuthorityGraphNodeKindSchema = z.enum([
  "principal",
  "agent",
  "task",
  "tool",
  "resource",
  "connection",
]);

export const AuthorityGraphNodeSchema = z
  .object({
    id: z.string().min(1).max(256),
    kind: AuthorityGraphNodeKindSchema,
    label: z.string().min(1).max(256),
    status: z.enum(["active", "paused", "revoked", "expired"]).optional(),
  })
  .strict();

/**
 * A writ edge: one emitted version of a grant, dated and bounded. The edge's
 * ceiling is the grant's constraints at that version — a delegated edge may
 * only carry a ceiling equal to or narrower than its parent edge's.
 */
export const AuthorityWritSchema = z
  .object({
    grantId: GrantIdSchema,
    version: z.number().int().positive(),
    issuedAtEpochMs: EpochMillisecondsSchema,
    change: z.enum(["issued", "amended", "revoked", "paused", "resumed"]),
    ceiling: AuthorityConstraintsSchema,
  })
  .strict();

export const AuthorityGraphEdgeSchema = z
  .object({
    id: z.string().min(1).max(256),
    kind: z.enum(["contains", "writ", "coverage"]),
    from: z.string().min(1).max(256),
    to: z.string().min(1).max(256),
    /** Present on writ edges; absent on structural/coverage edges. */
    writ: AuthorityWritSchema.optional(),
    /** Delegated edges link to the parent writ edge they narrow. */
    parentEdgeId: z.string().min(1).max(256).optional(),
    status: z.enum(["active", "revoked", "paused"]).optional(),
  })
  .strict();

/**
 * The kernel's effective constraints: the restrictive intersection of a
 * chain's ceilings. Unlike the issuance schema, computed intersections may
 * leave a set empty — an empty actions/resources/adapterIds set means the
 * chain can satisfy nothing, which is itself a truthful answer.
 */
export const EffectiveConstraintsSchema = z
  .object({
    actions: z.array(ActionTypeSchema).max(64),
    resources: z.array(ResourceRefSchema).max(256),
    adapterIds: z.array(AdapterIdSchema).max(64),
    maxValueCents: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    maxUsesPerRequest: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    notBeforeEpochMs: EpochMillisecondsSchema.optional(),
    expiresAtEpochMs: EpochMillisecondsSchema,
    approvalRequired: z.boolean(),
    askAboveValueCents: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    merchantAllowlist: z.array(z.string().min(1).max(256)).max(256).optional(),
    categoryAllowlist: z.array(z.string().min(1).max(256)).max(256).optional(),
    recurrence: RecurrencePolicySchema.optional(),
    budgetIds: z.array(z.string().min(1).max(128)).max(64).optional(),
  })
  .strict();

/**
 * Effective authority for one agent: the per-chain result of the kernel's
 * own chain evaluation — the same computation the decision path runs, so the
 * Authority Map can never drift from what the kernel enforces.
 */
export const EffectiveAuthoritySchema = z
  .object({
    agentId: AgentIdSchema,
    suspended: z.boolean(),
    chains: z.array(
      z
        .object({
          grantIds: z.array(GrantIdSchema).min(1),
          outcome: z.enum(["effective", "denied"]),
          reasonCode: z.string().min(1).max(128).optional(),
          effective: EffectiveConstraintsSchema.optional(),
        })
        .strict(),
    ),
  })
  .strict();

export const AuthorityGraphSchema = z
  .object({
    tenantId: TenantIdSchema,
    principalId: PrincipalIdSchema,
    computedAtEpochMs: EpochMillisecondsSchema,
    nodes: z.array(AuthorityGraphNodeSchema).max(512),
    edges: z.array(AuthorityGraphEdgeSchema).max(1024),
    effectiveAuthority: z.array(EffectiveAuthoritySchema).max(64),
    activePauses: z
      .array(
        z
          .object({
            id: PauseIdSchema,
            scope: z.enum(["principal", "agent", "grant", "connection"]),
            agentId: AgentIdSchema.optional(),
            grantId: GrantIdSchema.optional(),
            connectionId: ConnectionIdSchema.optional(),
            adapterId: AdapterIdSchema.optional(),
            taskId: TaskIdSchema.optional(),
            createdAtEpochMs: EpochMillisecondsSchema,
          })
          .strict(),
      )
      .max(256),
  })
  .strict();

export type EffectiveConstraints = z.infer<typeof EffectiveConstraintsSchema>;
export type AuthorityGraphNodeKind = z.infer<
  typeof AuthorityGraphNodeKindSchema
>;
export type AuthorityGraphNode = z.infer<typeof AuthorityGraphNodeSchema>;
export type AuthorityWrit = z.infer<typeof AuthorityWritSchema>;
export type AuthorityGraphEdge = z.infer<typeof AuthorityGraphEdgeSchema>;
export type EffectiveAuthority = z.infer<typeof EffectiveAuthoritySchema>;
export type AuthorityGraph = z.infer<typeof AuthorityGraphSchema>;
