// Generated file — do not edit.
import { z } from "zod";

import { STEP_UP_LEVEL_RANK, StepUpLevelSchema } from "./multi-principal.js";
import type { StepUpLevel } from "./multi-principal.js";

/**
 * guardian.obligation.v1 — declarative obligations.
 *
 * An obligation is a human-authored condition attached to an intent: "ALLOW,
 * provided these conditions are satisfied." Obligations are declarative
 * inputs to the ONE authority kernel: they never add a
 * verdict (the triad stays ALLOW/ASK/DENY), never widen a grant, and never
 * issue authority. This evaluator is pure and read-only — it may look at the
 * context and return a state; it cannot broaden authority, mint
 * capabilities, or bypass the existing ASK machinery.
 *
 * Evaluation phases:
 *   - "decision"  — mechanical verifiers settled deterministically at the
 *                   decision point (satisfied | failed).
 *   - "human"     — human-facing conditions that force the existing ASK
 *                   machinery (step-up / second approver / quorum compose
 *                   with the approval chain).
 *   - "post_action" — recorded as pending and transitioned by evidence or
 *                   the sweeper; unfulfilled ones surface as overdue, never
 *                   silently dropped.
 *   - "time"      — pending until a derived due instant elapses.
 *   - "unwired"   — types with no verifier in this build: they evaluate
 *                   `failed` with rule OBLIGATION_VERIFIER_UNAVAILABLE and
 *                   therefore DENY (fail-closed).
 */

export const OBLIGATION_CONTRACT_SCHEMA = "guardian.obligation.v1";

/** All 23 obligation types. */
export const ObligationTypeSchema = z.enum([
  "log",
  "retain_receipt",
  "notify",
  "delay",
  "cooling_period",
  "delete_after_use",
  "redact",
  "encrypt",
  "tokenize",
  "minimize",
  "verify_counterparty",
  "verify_resource",
  "verify_effect",
  "attest_runtime",
  "require_consent",
  "require_location",
  "require_device",
  "require_network",
  "require_contract",
  "step_up",
  "second_approver",
  "quorum",
  "authenticate",
]);
export type ObligationType = z.infer<typeof ObligationTypeSchema>;

const ObligationParamValue = z.union([
  z.string().trim().min(1).max(512),
  z.number().int().safe(),
  z.boolean(),
  z.array(z.string().trim().min(1).max(256)).max(64),
]);

/** Bounded, deterministic per-type params (fields[], seconds, quorumSize, level...). */
export const ObligationParamsSchema = z
  .record(z.string().trim().min(1).max(64), ObligationParamValue)
  .refine((value) => Object.keys(value).length <= 16, {
    message: "obligation params may carry at most 16 keys",
  });
export type ObligationParams = z.infer<typeof ObligationParamsSchema>;

export const ObligationSchema = z
  .object({
    type: ObligationTypeSchema,
    params: ObligationParamsSchema.optional(),
  })
  .strict();
export type Obligation = z.infer<typeof ObligationSchema>;

export const ObligationStateValueSchema = z.enum([
  "satisfied",
  "pending",
  "failed",
  "not_applicable",
]);
export type ObligationStateValue = z.infer<typeof ObligationStateValueSchema>;

/** Outcome rules reported on each obligation state. */
export const ObligationRuleSchema = z.enum([
  "OBLIGATION_SATISFIED",
  "PENDING_POST_ACTION",
  "PENDING_TIME",
  "PENDING_HUMAN",
  "OBLIGATION_PARAMS_INVALID",
  "COUNTERPARTY_UNVERIFIED",
  "RESOURCE_NOT_COVERED",
  "OBLIGATION_VERIFIER_UNAVAILABLE",
]);
export type ObligationRule = z.infer<typeof ObligationRuleSchema>;

export const ObligationStateSchema = z
  .object({
    obligationType: ObligationTypeSchema,
    state: ObligationStateValueSchema,
    /** The deterministic rule that produced this state. */
    rule: ObligationRuleSchema,
    detail: z.string().trim().min(1).max(512).optional(),
    /** For pending obligations with a derived deadline/due instant. */
    dueEpochMs: z.number().int().nonnegative().safe().optional(),
  })
  .strict();
export type ObligationState = z.infer<typeof ObligationStateSchema>;

/** Types wired to a deterministic verifier at decision time. */
const DECISION_OBLIGATIONS: ReadonlySet<ObligationType> = new Set([
  "log",
  "verify_counterparty",
  "verify_resource",
]);

/** Human-facing types that force the existing ASK machinery. */
const HUMAN_OBLIGATIONS: ReadonlySet<ObligationType> = new Set([
  "require_consent",
  "step_up",
  "second_approver",
  "quorum",
]);

/** Post-action types recorded pending and transitioned by evidence/sweeper. */
const POST_ACTION_OBLIGATIONS: ReadonlySet<ObligationType> = new Set([
  "retain_receipt",
  "notify",
  "verify_effect",
  "delete_after_use",
  "redact",
  "encrypt",
  "tokenize",
  "minimize",
]);

/** Time-elapsed types: pending until dueEpochMs, then auto-completed. */
const TIME_OBLIGATIONS: ReadonlySet<ObligationType> = new Set([
  "delay",
  "cooling_period",
]);

/** Transform types that execute as recorded parameter transforms. */
const TRANSFORM_OBLIGATIONS: ReadonlySet<ObligationType> = new Set([
  "delete_after_use",
  "redact",
  "encrypt",
  "tokenize",
  "minimize",
]);

/** Types with no verifier in this build — fail closed (deny), honestly. */
const UNWIRED_OBLIGATIONS: ReadonlySet<ObligationType> = new Set([
  "attest_runtime",
  "require_location",
  "require_device",
  "require_network",
  "require_contract",
  "authenticate",
]);

export type ObligationPhase =
  | "decision"
  | "human"
  | "post_action"
  | "time"
  | "unwired";

export function obligationPhase(type: ObligationType): ObligationPhase {
  if (DECISION_OBLIGATIONS.has(type)) return "decision";
  if (HUMAN_OBLIGATIONS.has(type)) return "human";
  if (TIME_OBLIGATIONS.has(type)) return "time";
  if (UNWIRED_OBLIGATIONS.has(type)) return "unwired";
  if (POST_ACTION_OBLIGATIONS.has(type)) return "post_action";
  return "unwired";
}

export function isHumanFacingObligation(type: ObligationType): boolean {
  return HUMAN_OBLIGATIONS.has(type);
}

/** True for pending obligations the sweeper completes when due time passes. */
export function isTimeElapsedObligation(type: ObligationType): boolean {
  return TIME_OBLIGATIONS.has(type);
}

/** True for obligations that run as recorded parameter transforms. */
export function isTransformObligation(type: ObligationType): boolean {
  return TRANSFORM_OBLIGATIONS.has(type);
}

/** Read-only facts the evaluator may consult. It cannot mutate or mint. */
export type ObligationContext = Readonly<{
  nowEpochMs: number;
  /** The action's declared counterparty (merchant) label, if any. */
  merchantId?: string | undefined;
  /** The action's resource ref. */
  resource: string;
  /** Counterparties declared on the enclosing intent (absent = none declared). */
  intentCounterparties?: readonly string[] | undefined;
  /** Resources declared on the enclosing intent (absent = unconstrained). */
  intentResources?: readonly string[] | undefined;
  /** True when the narrowed authority chain still covers this action. */
  chainCoversAction: boolean;
}>;

const STEP_UP_LEVELS = new Set<string>(StepUpLevelSchema.options);

export function positiveIntParam(
  params: ObligationParams | undefined,
  key: string,
): number | null {
  const value = params?.[key];
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    Number.isSafeInteger(value)
    ? value
    : null;
}

export function stringArrayParam(
  params: ObligationParams | undefined,
  key: string,
): readonly string[] | null {
  const value = params?.[key];
  return Array.isArray(value) && value.length > 0 ? value : null;
}

export function stringParam(
  params: ObligationParams | undefined,
  key: string,
): string | null {
  const value = params?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function state(
  obligationType: ObligationType,
  value: ObligationStateValue,
  rule: ObligationRule,
  extra?: { detail?: string; dueEpochMs?: number },
): ObligationState {
  return {
    obligationType,
    state: value,
    rule,
    ...(extra?.detail === undefined ? {} : { detail: extra.detail }),
    ...(extra?.dueEpochMs === undefined
      ? {}
      : { dueEpochMs: extra.dueEpochMs }),
  };
}

function invalidParams(type: ObligationType, detail: string): ObligationState {
  return state(type, "failed", "OBLIGATION_PARAMS_INVALID", { detail });
}

/**
 * Pure obligation evaluation. Deterministic and read-only: identical inputs
 * always produce identical states and the evaluator issues no authority.
 */
export function evaluateObligation(
  obligation: Obligation,
  context: ObligationContext,
): ObligationState {
  const { type, params } = obligation;
  switch (obligationPhase(type)) {
    case "decision": {
      if (type === "log") {
        // The durable evidence chain records every decision — satisfied.
        return state(type, "satisfied", "OBLIGATION_SATISFIED");
      }
      if (type === "verify_counterparty") {
        const allowed = context.intentCounterparties ?? [];
        if (
          context.merchantId !== undefined &&
          allowed.includes(context.merchantId)
        ) {
          return state(type, "satisfied", "OBLIGATION_SATISFIED");
        }
        return state(type, "failed", "COUNTERPARTY_UNVERIFIED", {
          detail:
            context.merchantId === undefined
              ? "action declares no counterparty to verify"
              : `counterparty ${context.merchantId} is not declared on the intent`,
        });
      }
      // verify_resource: covered when declared on the intent (if constrained)
      // and the narrowed chain still covers the action.
      const allowedResources = context.intentResources;
      const inIntent =
        allowedResources === undefined ||
        allowedResources.includes(context.resource);
      if (inIntent && context.chainCoversAction) {
        return state(type, "satisfied", "OBLIGATION_SATISFIED");
      }
      return state(type, "failed", "RESOURCE_NOT_COVERED");
    }
    case "human": {
      if (type === "step_up") {
        const level = stringParam(params, "level");
        if (level === null || !STEP_UP_LEVELS.has(level)) {
          return invalidParams(
            type,
            "step_up requires params.level in {tap,passkey,biometric,second-device,multi-approver}",
          );
        }
      }
      if (type === "quorum") {
        const quorumSize = positiveIntParam(params, "quorumSize");
        if (quorumSize === null || quorumSize < 2) {
          return invalidParams(type, "quorum requires params.quorumSize >= 2");
        }
      }
      return state(type, "pending", "PENDING_HUMAN");
    }
    case "time": {
      const seconds = positiveIntParam(params, "seconds");
      if (seconds === null) {
        return invalidParams(
          type,
          `${type} requires params.seconds as a positive integer`,
        );
      }
      return state(type, "pending", "PENDING_TIME", {
        dueEpochMs: context.nowEpochMs + seconds * 1_000,
      });
    }
    case "post_action": {
      if (isTransformObligation(type)) {
        if (stringArrayParam(params, "fields") === null) {
          return invalidParams(
            type,
            `${type} requires params.fields as a non-empty list`,
          );
        }
      }
      const dueSeconds = positiveIntParam(params, "dueSeconds");
      return state(type, "pending", "PENDING_POST_ACTION", {
        ...(dueSeconds === null
          ? {}
          : { dueEpochMs: context.nowEpochMs + dueSeconds * 1_000 }),
      });
    }
    case "unwired": {
      return state(type, "failed", "OBLIGATION_VERIFIER_UNAVAILABLE", {
        detail: `no verifier is wired for obligation type ${type}; fail closed`,
      });
    }
  }
}

/**
 * Deterministically evaluate every declared obligation, in declared order.
 */
export function evaluateObligations(
  obligations: readonly Obligation[],
  context: ObligationContext,
): readonly ObligationState[] {
  return obligations.map((obligation) =>
    evaluateObligation(obligation, context),
  );
}

/** First failed state, if any — a failed/unsettleable obligation denies. */
export function firstFailedObligation(
  states: readonly ObligationState[],
): ObligationState | null {
  for (const entry of states) {
    if (entry.state === "failed") return entry;
  }
  return null;
}

/**
 * Human-facing obligations raise the approval requirement. This
 * composes step_up → requiredFactor and second_approver/quorum →
 * requiredApprovals; it never lowers an existing requirement.
 */
export function obligationApprovalRequirement(
  obligations: readonly Obligation[],
): { requiredFactor?: StepUpLevel; requiredApprovals?: number } {
  let requiredFactor: StepUpLevel | undefined;
  let requiredApprovals: number | undefined;
  for (const obligation of obligations) {
    if (obligation.type === "step_up") {
      const parsed = StepUpLevelSchema.safeParse(
        stringParam(obligation.params, "level"),
      );
      if (
        parsed.success &&
        (requiredFactor === undefined ||
          STEP_UP_LEVEL_RANK[parsed.data] > STEP_UP_LEVEL_RANK[requiredFactor])
      ) {
        requiredFactor = parsed.data;
      }
    }
    if (obligation.type === "second_approver") {
      requiredApprovals = Math.max(requiredApprovals ?? 1, 2);
    }
    if (obligation.type === "quorum") {
      const quorumSize = positiveIntParam(obligation.params, "quorumSize");
      if (quorumSize !== null) {
        requiredApprovals = Math.max(requiredApprovals ?? 1, quorumSize);
      }
    }
  }
  return {
    ...(requiredFactor === undefined ? {} : { requiredFactor }),
    ...(requiredApprovals === undefined ? {} : { requiredApprovals }),
  };
}
