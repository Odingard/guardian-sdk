// Generated file — do not edit.
import { z } from "zod";

/**
 * guardian.prerequisite.v1 — declarative prerequisites.
 *
 * A prerequisite is a human-authored pre-condition declared on an intent
 * contract: it must settle — in declared order — before the action reaches
 * the kernel. Prerequisites are declarative inputs to the
 * ONE authority kernel. No prerequisite may create, widen, or
 * restore authority: this evaluator is pure and read-only — it can only
 * report satisfied | pending | failed, and a failure denies with the failed
 * rule named on the rejection evidence. Unknown or unwired types evaluate
 * `failed` (PREREQUISITE_VERIFIER_UNAVAILABLE) and deny — fail closed.
 */

export const PREREQUISITE_CONTRACT_SCHEMA = "guardian.prerequisite.v1";

/** Prerequisite types wired in this build. Unknown types deny (fail closed). */
export const PrerequisiteTypeSchema = z.enum([
  "merchant_verified",
  "counterparty_verified",
  "budget_available",
  "capability_present",
  "address_authority",
  "human_approval",
]);
export type PrerequisiteType = z.infer<typeof PrerequisiteTypeSchema>;

const PrerequisiteParamValue = z.union([
  z.string().trim().min(1).max(512),
  z.number().int().safe(),
  z.boolean(),
  z.array(z.string().trim().min(1).max(256)).max(64),
]);

export const PrerequisiteParamsSchema = z
  .record(z.string().trim().min(1).max(64), PrerequisiteParamValue)
  .refine((value) => Object.keys(value).length <= 16, {
    message: "prerequisite params may carry at most 16 keys",
  });
export type PrerequisiteParams = z.infer<typeof PrerequisiteParamsSchema>;

export const PrerequisiteSchema = z
  .object({
    /** Human-chosen identifier, unique within the intent's prerequisite list. */
    id: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    type: PrerequisiteTypeSchema,
    params: PrerequisiteParamsSchema.optional(),
  })
  .strict();
export type Prerequisite = z.infer<typeof PrerequisiteSchema>;

export const PrerequisiteStateValueSchema = z.enum([
  "satisfied",
  "pending",
  "failed",
  "not_applicable",
]);
export type PrerequisiteStateValue = z.infer<
  typeof PrerequisiteStateValueSchema
>;

export const PrerequisiteRuleSchema = z.enum([
  "PREREQUISITE_SATISFIED",
  "PENDING_HUMAN",
  "MERCHANT_UNVERIFIED",
  "BUDGET_NOT_DECLARED",
  "BUDGET_EXCEEDED",
  "CAPABILITY_NOT_COVERED",
  "ADDRESS_NOT_AUTHORIZED",
  "PREREQUISITE_PARAMS_INVALID",
  "PREREQUISITE_VERIFIER_UNAVAILABLE",
]);
export type PrerequisiteRule = z.infer<typeof PrerequisiteRuleSchema>;

export const PrerequisiteStateSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    prerequisiteType: z.string().trim().min(1).max(64),
    state: PrerequisiteStateValueSchema,
    rule: PrerequisiteRuleSchema,
    detail: z.string().trim().min(1).max(512).optional(),
  })
  .strict();
export type PrerequisiteState = z.infer<typeof PrerequisiteStateSchema>;

/** Read-only facts the evaluator may consult. It cannot mutate or mint. */
export type PrerequisiteContext = Readonly<{
  /** The action's declared counterparty (merchant) label, if any. */
  merchantId?: string | undefined;
  /** The action's resource ref. */
  resource: string;
  /** The action's declared value in cents, if any. */
  valueCents?: number | undefined;
  /** The action's material parameters (read-only). */
  materialParameters?: Readonly<Record<string, unknown>> | undefined;
  /** Counterparties declared on the enclosing intent (absent = none). */
  intentCounterparties?: readonly string[] | undefined;
  /** Resources declared on the enclosing intent (absent = unconstrained). */
  intentResources?: readonly string[] | undefined;
  /** Total issued-capability value cap declared on the intent. */
  moneyBudgetCents?: number | undefined;
  /** True when the narrowed authority chain still covers this action. */
  chainCoversAction: boolean;
}>;

function result(
  entry: Prerequisite,
  value: PrerequisiteStateValue,
  rule: PrerequisiteRule,
  detail?: string,
): PrerequisiteState {
  return {
    id: entry.id,
    prerequisiteType: entry.type,
    state: value,
    rule,
    ...(detail === undefined ? {} : { detail }),
  };
}

/**
 * Pure prerequisite evaluation for one declared entry. Deterministic and
 * read-only: the evaluator issues no authority and cannot enlarge a chain.
 */
export function evaluatePrerequisite(
  entry: Prerequisite,
  context: PrerequisiteContext,
): PrerequisiteState {
  switch (entry.type) {
    case "merchant_verified":
    case "counterparty_verified": {
      const allowed = context.intentCounterparties ?? [];
      if (
        context.merchantId !== undefined &&
        allowed.includes(context.merchantId)
      ) {
        return result(entry, "satisfied", "PREREQUISITE_SATISFIED");
      }
      return result(
        entry,
        "failed",
        "MERCHANT_UNVERIFIED",
        context.merchantId === undefined
          ? "action declares no counterparty to verify"
          : `counterparty ${context.merchantId} is not declared on the intent`,
      );
    }
    case "budget_available": {
      if (context.moneyBudgetCents === undefined) {
        return result(
          entry,
          "failed",
          "BUDGET_NOT_DECLARED",
          "the intent declares no moneyBudgetCents to check availability against",
        );
      }
      if ((context.valueCents ?? 0) <= context.moneyBudgetCents) {
        return result(entry, "satisfied", "PREREQUISITE_SATISFIED");
      }
      return result(
        entry,
        "failed",
        "BUDGET_EXCEEDED",
        `action value ${context.valueCents ?? 0} exceeds declared budget ${context.moneyBudgetCents}`,
      );
    }
    case "capability_present": {
      if (context.chainCoversAction) {
        return result(entry, "satisfied", "PREREQUISITE_SATISFIED");
      }
      return result(
        entry,
        "failed",
        "CAPABILITY_NOT_COVERED",
        "the narrowed authority chain does not cover this action",
      );
    }
    case "address_authority": {
      const field =
        typeof entry.params?.["field"] === "string"
          ? entry.params["field"]
          : "address";
      const materialParameters = context.materialParameters ?? {};
      const value = materialParameters[field];
      if (typeof value !== "string" || value.trim().length === 0) {
        return result(
          entry,
          "failed",
          "ADDRESS_NOT_AUTHORIZED",
          `material parameter ${field} is absent`,
        );
      }
      if (
        context.intentResources === undefined ||
        context.intentResources.includes(value)
      ) {
        return result(entry, "satisfied", "PREREQUISITE_SATISFIED");
      }
      return result(
        entry,
        "failed",
        "ADDRESS_NOT_AUTHORIZED",
        `address is not within the intent's declared resources`,
      );
    }
    case "human_approval": {
      // Settles through the existing ASK machinery: it raises
      // approvalRequired on the narrowed chain — never bypassed.
      return result(entry, "pending", "PENDING_HUMAN");
    }
    default: {
      return result(
        entry,
        "failed",
        "PREREQUISITE_VERIFIER_UNAVAILABLE",
        `no verifier is wired for prerequisite type ${entry.type}; fail closed`,
      );
    }
  }
}

export type PrerequisiteEvaluation = Readonly<{
  /** Results recorded in declared order; evaluation halts at first failure. */
  results: readonly PrerequisiteState[];
  /** The first failed entry, when evaluation halted. */
  firstFailure: PrerequisiteState | null;
  /** True when any settled/pending entry requires human approval (ASK). */
  forcesApproval: boolean;
}>;

/**
 * Evaluate prerequisites strictly in declared order. Evaluation halts at the
 * first failure — entries after it are never evaluated and a reevaluation
 * only happens after all prerequisites settle.
 */
export function evaluatePrerequisitesInOrder(
  prerequisites: readonly Prerequisite[],
  context: PrerequisiteContext,
): PrerequisiteEvaluation {
  const results: PrerequisiteState[] = [];
  let firstFailure: PrerequisiteState | null = null;
  let forcesApproval = false;
  for (const entry of prerequisites) {
    const state = evaluatePrerequisite(entry, context);
    results.push(state);
    if (state.state === "failed") {
      firstFailure = state;
      break;
    }
    if (entry.type === "human_approval" && state.state === "pending") {
      forcesApproval = true;
    }
  }
  return { results, firstFailure, forcesApproval };
}

/**
 * Durable per-row shape for the obligation/prerequisite state table
 * (packages/store-postgres `obligation_states`): one row per evaluated
 * item, keyed by the action that carried it.
 */
export const ObligationStateRecordSchema = z
  .object({
    tenantId: z.string().trim().min(1).max(128),
    /** Request reference of the action the item was evaluated for. */
    actionRef: z.string().trim().min(1).max(128),
    intentId: z.string().trim().min(1).max(128).optional(),
    kind: z.enum(["obligation", "prerequisite"]),
    obligation: z.record(z.string(), z.unknown()),
    state: z.enum([
      "satisfied",
      "pending",
      "failed",
      "overdue",
      "not_applicable",
    ]),
    rule: z.string().trim().min(1).max(128),
    detail: z.string().trim().max(512).optional(),
    dueEpochMs: z.number().int().nonnegative().safe().optional(),
    completedAtEpochMs: z.number().int().nonnegative().safe().optional(),
    createdAtEpochMs: z.number().int().nonnegative().safe(),
  })
  .strict();
export type ObligationStateRecord = z.infer<typeof ObligationStateRecordSchema>;
