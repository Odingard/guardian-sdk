// Generated file — do not edit.
import { z } from "zod";

/**
 * guardian.sequence.v1 — declarative sequence rules.
 *
 * A sequence rule is a human-authored condition declared on an intent
 * contract: it composes the current action with recorded, earlier actions
 * of the same principal/agent lineage. Sequence rules
 * are declarative inputs to the ONE authority kernel: this
 * evaluator is pure and read-only over recorded action history — it can
 * only report deny | require_approval | no match, and can never create,
 * widen, or restore authority. Temporal rules combine recorded action
 * timestamps with causal references; they never infer intent from timing
 * alone.
 *
 * Six combinators wire in this build:
 *   then                  A must be recorded strictly before the current action
 *   plus                  A must be recorded inside the window (either order;
 *                         recorded history is always earlier)
 *   within_minutes        A must be recorded no more than windowMinutes earlier
 *   using_result_of       the current action declares a causal reference
 *                         (parentActionId, or a sourceEffectId the caller has
 *                         resolved to the action that produced it) to A
 *   affecting_resource_of the current action touches a resource A recorded or
 *                         produced (resource ref or material parameter overlap)
 *   after_protected_data  any protected_data.* action was recorded inside the
 *                         window (rule `a` may narrow it further)
 *
 * A matching rule applies its declared effect: `deny` fails the request
 * closed with the rule named on the rejection evidence;
 * `require_approval` raises approvalRequired so the existing ASK machinery
 * handles it. Rules are evaluated over recorded evidence only — an
 * unrecorded, forged, or cross-tenant reference simply cannot match.
 */

export const SEQUENCE_CONTRACT_SCHEMA = "guardian.sequence.v1";

export const SequenceCombinatorSchema = z.enum([
  "then",
  "plus",
  "within_minutes",
  "using_result_of",
  "affecting_resource_of",
  "after_protected_data",
]);
export type SequenceCombinator = z.infer<typeof SequenceCombinatorSchema>;

export const SequenceEffectSchema = z.enum(["deny", "require_approval"]);
export type SequenceEffect = z.infer<typeof SequenceEffectSchema>;

/**
 * One side of a sequence rule. `action` accepts an exact action id or
 * `family:<name>` (the intent-contract matching convention). Absent
 * predicates are wildcards; at least one predicate must be declared.
 */
export const SequenceMatchSchema = z
  .object({
    action: z.string().trim().min(1).max(160).optional(),
    resource: z.string().trim().min(1).max(512).optional(),
    counterparty: z.string().trim().min(1).max(256).optional(),
  })
  .strict()
  .refine(
    (match) =>
      match.action !== undefined ||
      match.resource !== undefined ||
      match.counterparty !== undefined,
    { message: "sequence match must declare at least one predicate" },
  );
export type SequenceMatch = z.infer<typeof SequenceMatchSchema>;

export const SequenceRuleSchema = z
  .object({
    /** Human-chosen identifier, unique within the intent's sequence list. */
    id: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    /**
     * The earlier (recorded) side. Optional only for after_protected_data,
     * where it defaults to "any protected_data.* action".
     */
    a: SequenceMatchSchema.optional(),
    /** The current-action side; absent means "the current action". */
    b: SequenceMatchSchema.optional(),
    combinator: SequenceCombinatorSchema,
    /** Look-back bound in minutes; required for within_minutes. */
    windowMinutes: z.number().int().positive().max(525_600).optional(),
    effect: SequenceEffectSchema,
  })
  .strict()
  .superRefine((rule, context) => {
    if (
      rule.combinator === "within_minutes" &&
      rule.windowMinutes === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["windowMinutes"],
        message: "within_minutes requires windowMinutes",
      });
    }
    if (rule.combinator !== "after_protected_data" && rule.a === undefined) {
      context.addIssue({
        code: "custom",
        path: ["a"],
        message: `combinator ${rule.combinator} requires a`,
      });
    }
  });
export type SequenceRule = z.infer<typeof SequenceRuleSchema>;

/** One matched sequence rule and the recorded actions that satisfied `a`. */
export const SequenceMatchOutcomeSchema = z
  .object({
    ruleId: z.string().trim().min(1).max(64),
    effect: SequenceEffectSchema,
    matchedActionRefs: z.array(z.string().trim().min(1).max(160)).max(64),
  })
  .strict();
export type SequenceMatchOutcome = z.infer<typeof SequenceMatchOutcomeSchema>;

/**
 * The action view the evaluator reads: the current (proposed) action or one
 * recorded earlier action. `actionFamily` is resolved by the caller's
 * registry — an entry without a resolvable family cannot satisfy a
 * `family:` predicate (fail closed). `resolvedSourceActionId` is the
 * recorded action a declared sourceEffectId resolved to (evidence lookup
 * happens in the caller, never here).
 */
export type SequenceActionView = Readonly<{
  requestId?: string | undefined;
  agentId?: string | undefined;
  action: string;
  actionFamily?: string | null | undefined;
  resource?: string | undefined;
  counterparty?: string | undefined;
  issuedAtEpochMs: number;
  parentActionId?: string | undefined;
  sourceEffectId?: string | undefined;
  resolvedSourceActionId?: string | undefined;
  materialParameters?: Readonly<Record<string, unknown>> | undefined;
}>;

export type SequenceEvaluation = Readonly<{
  /** First deny-effected matching rule, in declaration order. */
  deny: SequenceRule | undefined;
  /** First require_approval-effected matching rule, in declaration order. */
  requireApproval: SequenceRule | undefined;
  /** Every matching rule with the recorded action refs that matched `a`. */
  matches: readonly SequenceMatchOutcome[];
}>;

const MINUTE_MS = 60_000;

function matchPredicate(
  match: SequenceMatch | undefined,
  view: SequenceActionView,
): boolean {
  if (match === undefined) return true;
  if (match.action !== undefined) {
    if (match.action.startsWith("family:")) {
      const family = match.action.slice("family:".length);
      if (view.actionFamily === undefined || view.actionFamily === null) {
        return false;
      }
      if (view.actionFamily !== family) return false;
    } else if (view.action !== match.action) {
      return false;
    }
  }
  if (match.resource !== undefined && view.resource !== match.resource) {
    return false;
  }
  if (
    match.counterparty !== undefined &&
    view.counterparty !== match.counterparty
  ) {
    return false;
  }
  return true;
}

function withinWindow(
  rule: SequenceRule,
  entry: SequenceActionView,
  currentEpochMs: number,
): boolean {
  if (rule.windowMinutes === undefined) return true;
  const delta = currentEpochMs - entry.issuedAtEpochMs;
  return delta >= 0 && delta <= rule.windowMinutes * MINUTE_MS;
}

/**
 * The resource refs an earlier action produced or touched: its own
 * resource plus every string value declared at the top level of its
 * material parameters (e.g. a produced credential handle or record id).
 * Deterministic over recorded evidence only.
 */
function producedRefs(entry: SequenceActionView): ReadonlySet<string> {
  const refs = new Set<string>();
  if (entry.resource !== undefined) refs.add(entry.resource);
  if (entry.materialParameters !== undefined) {
    for (const value of Object.values(entry.materialParameters)) {
      if (typeof value === "string" && value.length > 0) refs.add(value);
    }
  }
  return refs;
}

/** The refs the current action touches: its resource plus its params. */
function touchedRefs(view: SequenceActionView): ReadonlySet<string> {
  return producedRefs(view);
}

function isProtectedDataAction(entry: SequenceActionView): boolean {
  return (
    entry.actionFamily === "protected_data" ||
    entry.action.startsWith("protected_data.")
  );
}

function matchesCombinator(
  rule: SequenceRule,
  entry: SequenceActionView,
  current: SequenceActionView,
): boolean {
  switch (rule.combinator) {
    case "then":
    case "plus":
      // Recorded history is earlier by construction; `then` additionally
      // requires the recorded timestamp to precede the current action.
      return (
        rule.combinator === "plus" ||
        entry.issuedAtEpochMs < current.issuedAtEpochMs
      );
    case "within_minutes":
      return (
        entry.issuedAtEpochMs <= current.issuedAtEpochMs &&
        current.issuedAtEpochMs - entry.issuedAtEpochMs <=
          (rule.windowMinutes ?? 0) * MINUTE_MS
      );
    case "using_result_of":
      return (
        entry.requestId !== undefined &&
        (current.parentActionId === entry.requestId ||
          (current.resolvedSourceActionId !== undefined &&
            current.resolvedSourceActionId === entry.requestId))
      );
    case "affecting_resource_of": {
      const produced = producedRefs(entry);
      if (produced.size === 0) return false;
      for (const ref of touchedRefs(current)) {
        if (produced.has(ref)) return true;
      }
      return false;
    }
    case "after_protected_data":
      return isProtectedDataAction(entry);
  }
}

/**
 * Evaluate declared sequence rules over recorded action history.
 * Pure and read-only: it can only narrow (deny / require_approval), never
 * enlarge authority. `history` must contain only recorded actions of the
 * same principal/agent lineage — the caller scopes the evidence port.
 */
export function evaluateSequenceRules(
  rules: readonly SequenceRule[],
  current: SequenceActionView,
  history: readonly SequenceActionView[],
  nowEpochMs: number,
): SequenceEvaluation {
  const matches: SequenceMatchOutcome[] = [];
  let deny: SequenceRule | undefined;
  let requireApproval: SequenceRule | undefined;
  for (const rule of rules) {
    if (!matchPredicate(rule.b, current)) continue;
    let matched = 0;
    const matchedActionRefs: string[] = [];
    for (const entry of history) {
      if (
        entry.requestId !== undefined &&
        entry.requestId === current.requestId
      ) {
        continue;
      }
      if (
        rule.combinator === "after_protected_data"
          ? rule.a !== undefined && !matchPredicate(rule.a, entry)
          : !matchPredicate(rule.a, entry)
      ) {
        continue;
      }
      if (!withinWindow(rule, entry, nowEpochMs)) continue;
      if (!matchesCombinator(rule, entry, current)) continue;
      matched += 1;
      if (entry.requestId !== undefined) {
        matchedActionRefs.push(entry.requestId);
      }
    }
    if (matched === 0) continue;
    matches.push({
      ruleId: rule.id,
      effect: rule.effect,
      matchedActionRefs: [...new Set(matchedActionRefs)].slice(0, 64),
    });
    if (rule.effect === "deny" && deny === undefined) deny = rule;
    if (rule.effect === "require_approval" && requireApproval === undefined) {
      requireApproval = rule;
    }
  }
  return { deny, requireApproval, matches };
}
