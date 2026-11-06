// Generated file — do not edit.
import { z } from "zod";

import {
  ActionTypeSchema,
  AdapterIdSchema,
  AttemptIdSchema,
  CorrelationIdSchema,
  IntentIdSchema,
  MaterialParametersSchema,
  PhysicalActionFactsSchema,
  PlanIdSchema,
  RequestIdSchema,
  ResourceRefSchema,
  TaskIdSchema,
  TransactionIdSchema,
} from "./contracts/index.js";

export const AgentActionProposalSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: RequestIdSchema,
    correlationId: CorrelationIdSchema,
    action: ActionTypeSchema,
    resource: ResourceRefSchema,
    valueCents: z.number().int().nonnegative().safe().optional(),
    merchantId: z.string().trim().min(1).max(256).optional(),
    merchantCategory: z.string().trim().min(1).max(256).optional(),
    recurring: z.boolean().optional(),
    taskId: TaskIdSchema.optional(),
    // Optional intent/plan provenance — when present the intent
    // pre-gate runs fail-closed and narrows the authority chain.
    intentId: IntentIdSchema.optional(),
    planId: PlanIdSchema.optional(),
    // Optional causal provenance — the recorded action (request)
    // and execution effect this action was caused by. When declared the
    // pre-gate validates them fail-closed against recorded evidence.
    parentActionId: RequestIdSchema.optional(),
    sourceEffectId: AttemptIdSchema.optional(),
    // Declares this action as the governed compensation
    // of a recorded transaction. The gateway validates the link
    // fail-closed; the action still runs the full authority path.
    compensatesTransactionId: TransactionIdSchema.optional(),
    // Declarative physical constraint facts on the action
    // envelope (guardian.safety_envelope.v1) — zone/speed/force/payload/
    // hours/human-distance/environment/supervision. Generic policy
    // facts; the safety-envelope evaluator checks them deterministically.
    physicalFacts: PhysicalActionFactsSchema.optional(),
    uses: z.literal(1),
    materialParameters: MaterialParametersSchema,
    purpose: z.string().trim().min(1).max(1_024),
    initiatingContext: z.enum(["user", "scheduled", "agent", "external-event"]),
    requestedAdapterId: AdapterIdSchema,
    requestedTtlMs: z.number().int().positive().max(300_000),
    /**
     * The runtime the agent self-declares. Compared against the
     * bound runtime recorded in the authority state when the agent was
     * registered or spawned; a mismatch is runtime substitution.
     */
    runtime: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

export type AgentActionProposal = z.infer<typeof AgentActionProposalSchema>;
