// Generated file — do not edit.
import { z } from "zod";

import { EpochMillisecondsSchema, ResourceRefSchema } from "./authority.js";
import { ApprovalStructureSchema } from "./multiparty.js";
import { TransactionDeclarationSchema } from "./transaction.js";
import { ObligationSchema, ObligationTypeSchema } from "./obligation.js";
import { PrerequisiteSchema } from "./prerequisite.js";
import { LineagePolicySchema } from "./lineage.js";
import { RuntimePolicySchema } from "./runtime.js";
import { SafetyEnvelopeSchema } from "./safety-envelope.js";
import { SequenceRuleSchema } from "./sequence.js";
import {
  AgentIdSchema,
  IntentIdSchema,
  PrincipalIdSchema,
  TenantIdSchema,
} from "./identifiers.js";

/**
 * guardian.intent.v1 — first-class Intent Authority.
 *
 * An intent is a human-authored container that NARROWS what an agent may do
 * for a bounded objective: which agents may act, which action families,
 * which resources and counterparties, and how much value/activity the
 * container may commit. Intents never enlarge authority — the gateway
 * pre-gate intersects the intent's allowlists with the agent's existing
 * authority chain, so an empty intersection denies. An intent is a
 * declarative input to the one authority kernel;
 * it grants no authority of its own.
 *
 * `obligations` and `prerequisites` are declarative inputs
 * (guardian.obligation.v1 / guardian.prerequisite.v1): they are evaluated
 * deterministically at the gateway pre-gate — a failed or unsettleable
 * entry denies, human-facing entries route through the existing ASK
 * machinery, and nothing here ever enlarges authority.
 * `dataBudget`/`networkBudget` are tracked-only counters — they are
 * recorded at capability issue but do not deny.
 */

export const INTENT_CONTRACT_SCHEMA = "guardian.intent.v1";

export const IntentStatusSchema = z.enum([
  "draft",
  "active",
  "paused",
  "completed",
  "expired",
  "revoked",
]);
export type IntentStatus = z.infer<typeof IntentStatusSchema>;

/** Lifecycle: draft→active|revoked; active→paused|completed|revoked;
 *  paused→active|revoked; completed/expired/revoked are terminal. */
const INTENT_TRANSITIONS: Readonly<
  Record<IntentStatus, readonly IntentStatus[]>
> = {
  draft: ["active", "revoked"],
  active: ["paused", "completed", "revoked"],
  paused: ["active", "revoked"],
  completed: [],
  expired: [],
  revoked: [],
};

export function canTransitionIntent(
  from: IntentStatus,
  to: IntentStatus,
): boolean {
  return INTENT_TRANSITIONS[from].includes(to);
}

const BoundedValue = z.number().int().nonnegative().safe();
const BoundedCount = z.number().int().positive().safe();

const FactList = (max = 256) =>
  z.array(z.string().trim().min(1).max(256)).max(max);

/** Absolute denials match an action id exactly or `family:<name>`. */
export const AbsoluteDenialSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

/** Per-kind protected_data caps inside an intent (subset of protected_data_rules). */
export const IntentProtectedDataRuleSchema = z
  .object({
    /** e.g. "protected_data.use" or a bare kind suffix "use". */
    kind: z.enum(["use", "view", "disclose", "persist"]),
    /** Optional cap on issued capabilities of this kind within the intent. */
    maxCount: BoundedCount.optional(),
  })
  .strict();
export type IntentProtectedDataRule = z.infer<
  typeof IntentProtectedDataRuleSchema
>;

export const IntentContractSchema = z
  .object({
    schema: z.literal(INTENT_CONTRACT_SCHEMA),
    intentId: IntentIdSchema,
    tenantId: TenantIdSchema,
    /** The principal (human) whose authority the intent narrows. */
    principal: PrincipalIdSchema,
    title: z.string().trim().min(1).max(160),
    purpose: z.string().trim().min(1).max(2_000),
    desiredOutcome: z.string().trim().min(1).max(2_000),
    /** Contract validity window (epoch ms, inclusive start, exclusive end). */
    start: EpochMillisecondsSchema,
    expires: EpochMillisecondsSchema,
    /** Agents authorized to act inside this intent — required non-empty. */
    authorizedAgents: z.array(AgentIdSchema).min(1).max(64),
    /** Action families the intent permits; empty means unconstrained. */
    allowedActionFamilies: FactList(128),
    /** Resource refs the intent permits; absent means unconstrained. */
    allowedResources: z.array(ResourceRefSchema).max(512).optional(),
    /** Counterparties (merchant/partner labels) the intent permits. */
    counterparties: FactList(256).optional(),
    /** Enforced: total issued capability value may not exceed this (cents). */
    moneyBudgetCents: BoundedValue.optional(),
    /** Enforced: total issued capability count may not exceed this. */
    toolBudget: BoundedCount.optional(),
    /** Enforced as a validity window: now must be < start + timeBudgetMs. */
    timeBudgetMs: BoundedCount.optional(),
    /** Tracked-only: recorded at issue, never denies. */
    dataBudget: BoundedValue.optional(),
    /** Tracked-only: recorded at issue, never denies. */
    networkBudget: BoundedValue.optional(),
    /** Per-kind protected_data caps evaluated at the pre-gate. */
    protectedDataRules: z
      .array(IntentProtectedDataRuleSchema)
      .max(32)
      .optional(),
    /** Max delegation depth allowed for the acting agent (parentAgentId chain). */
    delegationDepth: z.number().int().nonnegative().max(16).optional(),
    /**
     * obligations: typed conditions the decision must satisfy
     * ("ALLOW, provided ..."). A bare obligation type name is accepted and
     * normalized to `{type}` for authoring convenience.
     */
    obligations: z
      .array(
        z.union([
          ObligationSchema,
          ObligationTypeSchema.transform((type) => ({ type })),
        ]),
      )
      .max(64),
    /**
     * prerequisites: pre-conditions that settle in declared order
     * before the action reaches the kernel.
     */
    prerequisites: z.array(PrerequisiteSchema).max(64).optional(),
    /**
     * sequences: declarative guardian.sequence.v1 rules evaluated
     * read-only over recorded action history for the same principal/agent
     * lineage — deny | require_approval only, never enlarge.
     */
    sequences: z.array(SequenceRuleSchema).max(64).optional(),
    /**
     * lineage policy (guardian.lineage.v1): narrows, denies, or
     * forces approval over the effective classification of referenced data
     * objects, resolved deterministically over recorded lineage.
     * Missing lineage for a classified source fails closed.
     */
    lineage: LineagePolicySchema.optional(),
    /**
     * runtime policy (guardian.runtime.v1): narrows, denies, or
     * forces approval over the trusted-runtime level computed
     * deterministically from recorded attestation facts.
     * Missing/unconfigured attestation lowers the level — never raises it.
     */
    runtime: RuntimePolicySchema.optional(),
    /**
     * Declarative guardian.multiparty.v1 approval
     * structure — which human approvals must be recorded before consent
     * resolves (quorum, required members, veto, separation of duties,
     * temporary/delegated/emergency approvers, cooling period). Frozen
     * into the approval binding at creation; only narrows.
     */
    approvalStructure: ApprovalStructureSchema.optional(),
    /**
     * guardian.sources.v1 pack identifiers whose
     * registered constraints intersect with the principal's authority —
     * deterministic strongest-restriction-wins narrowing; a mandatory
     * pack that cannot be established fails closed.
     */
    authoritySources: z
      .array(z.string().trim().min(1).max(128))
      .max(16)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "authoritySources must be unique",
      )
      .optional(),
    /**
     * An optional guardian.transaction.v1 lifecycle
     * declaration for actions taken under this intent. Unioned with the
     * action definition's own declaration (canonical order; declaration
     * only ever adds recorded stages, never removes one); the effective
     * lifecycle binds into the canonical action digest.
     */
    transaction: TransactionDeclarationSchema.optional(),
    /**
     * An optional guardian.safety_envelope.v1 envelope
     * declared for physical actions under this intent. Evaluated
     * deterministically against the action's declared physical facts —
     * a violation denies or narrows (supervision narrows to ASK), never
     * warns-and-allows, never enlarges authority.
     */
    safetyEnvelope: SafetyEnvelopeSchema.optional(),
    /** Absolute denials: action id or `family:<name>` — always denied. */
    absoluteDenials: z.array(AbsoluteDenialSchema).max(256),
    /** "always_ask" forces approvalRequired on every surviving grant. */
    approvalPolicy: z.enum(["default", "always_ask"]),
    /** Authority contract version this intent was authored against. */
    authorityVersion: z.number().int().positive().safe(),
    status: IntentStatusSchema,
    version: z.number().int().positive().safe(),
    createdAtEpochMs: EpochMillisecondsSchema,
    updatedAtEpochMs: EpochMillisecondsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.start >= value.expires) {
      context.addIssue({
        code: "custom",
        path: ["expires"],
        message: "intent expiry must be later than its start",
      });
    }
    const agents = new Set(value.authorizedAgents);
    if (agents.size !== value.authorizedAgents.length) {
      context.addIssue({
        code: "custom",
        path: ["authorizedAgents"],
        message: "authorizedAgents must be unique",
      });
    }
    if (value.prerequisites !== undefined) {
      const ids = new Set(value.prerequisites.map((entry) => entry.id));
      if (ids.size !== value.prerequisites.length) {
        context.addIssue({
          code: "custom",
          path: ["prerequisites"],
          message: "prerequisite ids must be unique",
        });
      }
    }
    if (value.sequences !== undefined) {
      const ids = new Set(value.sequences.map((entry) => entry.id));
      if (ids.size !== value.sequences.length) {
        context.addIssue({
          code: "custom",
          path: ["sequences"],
          message: "sequence rule ids must be unique",
        });
      }
    }
  });

export type IntentContract = z.infer<typeof IntentContractSchema>;

export const IntentTransitionRequestSchema = z
  .object({
    to: IntentStatusSchema,
  })
  .strict();
export type IntentTransitionRequest = z.infer<
  typeof IntentTransitionRequestSchema
>;

/** Pure transition: returns the next contract or a reason code. */
export function transitionIntent(
  intent: IntentContract,
  to: IntentStatus,
  nowEpochMs: number,
): { ok: true; intent: IntentContract } | { ok: false; reasonCode: string } {
  if (!canTransitionIntent(intent.status, to)) {
    return {
      ok: false,
      reasonCode: `INTENT_TRANSITION_INVALID:${intent.status}->${to}`,
    };
  }
  return {
    ok: true,
    intent: {
      ...intent,
      status: to,
      version: intent.version + 1,
      updatedAtEpochMs: nowEpochMs,
    },
  };
}

/** Deterministic expiry: an active/paused intent past its expiry reads as expired. */
export function effectiveIntentStatus(
  intent: IntentContract,
  nowEpochMs: number,
): IntentStatus {
  if (
    (intent.status === "active" || intent.status === "paused") &&
    nowEpochMs >= intent.expires
  ) {
    return "expired";
  }
  return intent.status;
}

export type IntentPreGateFailure =
  | "INTENT_NOT_FOUND"
  | "INTENT_TENANT_MISMATCH"
  | "INTENT_PRINCIPAL_MISMATCH"
  | "INTENT_NOT_ACTIVE"
  | "INTENT_NOT_YET_STARTED"
  | "INTENT_EXPIRED"
  | "INTENT_TIME_BUDGET_EXCEEDED"
  | "INTENT_AGENT_NOT_AUTHORIZED"
  | "INTENT_ACTION_DENIED"
  | "INTENT_DELEGATION_DEPTH_EXCEEDED"
  | "INTENT_TASK_NOT_IN_PLAN"
  | "INTENT_PROTECTED_DATA_DENIED"
  | "INTENT_BUDGET_EXCEEDED";

export interface IntentPreGateInput {
  readonly intent: IntentContract | null;
  readonly tenantId: string;
  readonly principalId: string;
  readonly agentId: string;
  readonly actionId: string;
  readonly actionFamily: string | null;
  readonly nowEpochMs: number;
  /** Delegation depth of the acting agent (0 = no parent chain). */
  readonly agentDelegationDepth: number;
  /** Plan task membership: when the action carries taskId, whether a plan
   *  under this intent contains that task; undefined = no plans exist. */
  readonly taskInPlan: boolean | undefined;
  /** For protected_data.* actions: the kind suffix (use|view|disclose|persist). */
  readonly protectedDataKind: IntentProtectedDataRule["kind"] | null;
}

/** Pure pre-gate evaluator. Returns the failed rule name or null (pass). */
export function evaluateIntentPreGate(
  input: IntentPreGateInput,
): IntentPreGateFailure | null {
  const { intent } = input;
  if (!intent) return "INTENT_NOT_FOUND";
  if (intent.tenantId !== input.tenantId) return "INTENT_TENANT_MISMATCH";
  if (intent.principal !== input.principalId) {
    return "INTENT_PRINCIPAL_MISMATCH";
  }
  const effectiveStatus = effectiveIntentStatus(intent, input.nowEpochMs);
  if (effectiveStatus === "expired") return "INTENT_EXPIRED";
  if (effectiveStatus !== "active") return "INTENT_NOT_ACTIVE";
  if (input.nowEpochMs < intent.start) return "INTENT_NOT_YET_STARTED";
  if (
    intent.timeBudgetMs !== undefined &&
    input.nowEpochMs >= intent.start + intent.timeBudgetMs
  ) {
    return "INTENT_TIME_BUDGET_EXCEEDED";
  }
  if (!(intent.authorizedAgents as readonly string[]).includes(input.agentId)) {
    return "INTENT_AGENT_NOT_AUTHORIZED";
  }
  const denied = intent.absoluteDenials.some(
    (denial) =>
      denial === input.actionId ||
      (input.actionFamily !== null &&
        denial === `family:${input.actionFamily}`),
  );
  if (denied) return "INTENT_ACTION_DENIED";
  if (
    intent.delegationDepth !== undefined &&
    input.agentDelegationDepth > intent.delegationDepth
  ) {
    return "INTENT_DELEGATION_DEPTH_EXCEEDED";
  }
  if (input.taskInPlan === false) return "INTENT_TASK_NOT_IN_PLAN";
  if (
    input.protectedDataKind !== null &&
    intent.protectedDataRules !== undefined
  ) {
    const rule = intent.protectedDataRules.find(
      (entry) => entry.kind === input.protectedDataKind,
    );
    if (!rule || rule.maxCount === 0) {
      return "INTENT_PROTECTED_DATA_DENIED";
    }
  }
  return null;
}
