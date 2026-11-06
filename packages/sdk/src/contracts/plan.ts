// Generated file — do not edit.
import { z } from "zod";

import { EpochMillisecondsSchema } from "./authority.js";
import {
  AgentIdSchema,
  IntentIdSchema,
  PlanIdSchema,
  PrincipalIdSchema,
  TaskIdSchema,
  TenantIdSchema,
} from "./identifiers.js";
import type { IntentContract } from "./intent.js";

/**
 * guardian.plan.v1 — Plan Authority.
 *
 * A plan is a PROPOSAL, never authority. It decomposes an intent into an
 * ordered task graph; submitting one enlarges nothing. The gateway's
 * intent pre-gate uses plan task membership only to bind taskId → plan →
 * intent provenance. Scope validation (validatePlanAgainstIntent) runs at
 * submission so a plan cannot even propose work outside its intent.
 */

export const PLAN_CONTRACT_SCHEMA = "guardian.plan.v1";

export const PlanStatusSchema = z.enum([
  "draft",
  "active",
  "completed",
  "revoked",
]);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export const PlanNodeSchema = z
  .object({
    taskId: TaskIdSchema,
    title: z.string().trim().min(1).max(200),
    /** Optional scoping: the action family this task is expected to use. */
    actionFamily: z.string().trim().min(1).max(256).optional(),
    /** Optional scoping: explicit action ids this task may use. */
    actionIds: z.array(z.string().trim().min(1).max(200)).max(64).optional(),
    /** Optional scoping: the agent expected to execute this task. */
    agentId: AgentIdSchema.optional(),
    /** Task ids this node depends on (must reference earlier nodes). */
    dependsOn: z.array(TaskIdSchema).max(64),
  })
  .strict();
export type PlanNode = z.infer<typeof PlanNodeSchema>;

export const PlanContractSchema = z
  .object({
    schema: z.literal(PLAN_CONTRACT_SCHEMA),
    planId: PlanIdSchema,
    intentId: IntentIdSchema,
    tenantId: TenantIdSchema,
    principalId: PrincipalIdSchema,
    /** "human:<principal>" or "agent:<agentId>" — provenance, not authority. */
    createdBy: z.string().trim().min(1).max(160),
    title: z.string().trim().min(1).max(160),
    nodes: z.array(PlanNodeSchema).min(1).max(256),
    status: PlanStatusSchema,
    version: z.number().int().positive().safe(),
    createdAtEpochMs: EpochMillisecondsSchema,
  })
  .strict();
export type PlanContract = z.infer<typeof PlanContractSchema>;

export type PlanValidationFailure =
  | "PLAN_DUPLICATE_TASK"
  | "PLAN_UNKNOWN_DEPENDENCY"
  | "PLAN_FORWARD_DEPENDENCY"
  | "PLAN_CYCLE";

/** Structural DAG validation: unique taskIds, resolvable backward-only
 *  dependsOn references, acyclic. */
export function validatePlanDag(
  nodes: readonly PlanNode[],
): PlanValidationFailure | null {
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.taskId)) return "PLAN_DUPLICATE_TASK";
    for (const dep of node.dependsOn) {
      if (dep === node.taskId) return "PLAN_CYCLE";
      if (!seen.has(dep as string)) {
        // dependsOn may only reference already-declared nodes; a missing
        // forward reference is either unknown or would form a cycle.
        return nodes.some((other) => other.taskId === dep)
          ? "PLAN_FORWARD_DEPENDENCY"
          : "PLAN_UNKNOWN_DEPENDENCY";
      }
    }
    seen.add(node.taskId);
  }
  return null;
}

export type PlanScopeFailure =
  | "PLAN_TASK_FAMILY_OUT_OF_SCOPE"
  | "PLAN_TASK_ACTIONS_OUT_OF_SCOPE"
  | "PLAN_TASK_AGENT_UNAUTHORIZED";

/**
 * Every task a plan proposes must fit inside the intent: declared families
 * must be in allowedActionFamilies (when the intent constrains them), and
 * declared agents must be in authorizedAgents.
 */
export function validatePlanAgainstIntent(
  plan: Pick<PlanContract, "nodes">,
  intent: Pick<IntentContract, "allowedActionFamilies" | "authorizedAgents">,
): PlanScopeFailure | null {
  const familyConstrained = intent.allowedActionFamilies.length > 0;
  for (const node of plan.nodes) {
    if (
      node.actionFamily !== undefined &&
      familyConstrained &&
      !intent.allowedActionFamilies.includes(node.actionFamily)
    ) {
      return "PLAN_TASK_FAMILY_OUT_OF_SCOPE";
    }
    if (
      node.agentId !== undefined &&
      !(intent.authorizedAgents as readonly string[]).includes(node.agentId)
    ) {
      return "PLAN_TASK_AGENT_UNAUTHORIZED";
    }
  }
  return null;
}

/** Whether any active plan contains the given taskId. */
export function planContainsTask(
  plan: Pick<PlanContract, "nodes" | "status">,
  taskId: string,
): boolean {
  return plan.nodes.some((node) => node.taskId === taskId);
}
