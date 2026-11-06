// Generated file — do not edit.
import { z } from "zod";

import {
  RecordedAuthorityEvaluationInputSchema,
  type RecordedAuthorityEvaluationInput,
} from "./action.js";
import {
  ActionTypeSchema,
  AuthorityGrantSchema,
  EpochMillisecondsSchema,
  PolicyReferenceSchema,
  type AuthorityDecision,
  type AuthorityGrant,
} from "./authority.js";
import { canonicalSha256 } from "./digest.js";
import { Sha256DigestSchema } from "./evidence.js";
import {
  AgentIdSchema,
  CorrelationIdSchema,
  GrantIdSchema,
  PrincipalIdSchema,
  RequestIdSchema,
  TenantIdSchema,
} from "./identifiers.js";

/**
 * guardian.policy_simulation.v1 — policy simulation, authority
 * diff, blast radius, shadow authority and the declared mode lifecycle.
 *
 * The simulator answers "what would this policy allow?" over
 * recorded history, synthetic scenarios, or current agents/resources.
 * Every scenario is a recorded evaluation input; the simulator runs the
 * SAME kernel verdicts as the live path against it, deterministically.
 * Simulation never mutates live state and never fabricates an approval.
 *
 * The authority diff compares baseline and candidate outcomes: the
 * verdict-count deltas and the materialized newly-allowed and
 * newly-denied action-class lists.
 *
 * Blast radius reports, deterministically, which agents, resources,
 * action classes, counterparties, money, protected data, delegation and
 * runtime windows the candidate expands.
 *
 * OBSERVE shadow mode computes the SAME ALLOW/ASK/DENY verdict but
 * does not alter execution; the computed outcome is recorded as
 * would_allow / would_ask / would_deny. would_* is a RECORD field, never
 * a fourth verdict.
 *
 * The declared lifecycle OBSERVE → WARN → ASK-HEAVY → ENFORCE moves
 * one adjacent step per recorded transition. Transitions are
 * authority-bound, never silent, and cannot skip a stage.
 *
 * Truthfulness: this contract claims deterministic simulation, diff,
 * blast radius, shadow recording and a declared lifecycle only. It does
 * not predict real-world outcomes and never replaces human approval.
 */

export const POLICY_SIMULATION_CONTRACT_SCHEMA =
  "guardian.policy_simulation.v1";

/* ------------------------------------------------------------------ */
/* Declared mode lifecycle                                       */
/* ------------------------------------------------------------------ */

/**
 * The declared shadow/lifecycle mode for an agent. Modes are ordered:
 * a transition may only move one adjacent step and may never skip.
 */
export const AuthorityModeSchema = z.enum([
  "observe",
  "warn",
  "ask_heavy",
  "enforce",
]);
export type AuthorityMode = z.infer<typeof AuthorityModeSchema>;

/** Declared lifecycle order; index distance defines adjacency. */
export const AUTHORITY_MODE_ORDER = [
  "observe",
  "warn",
  "ask_heavy",
  "enforce",
] as const satisfies readonly AuthorityMode[];

export const AuthorityModeTransitionSchema = z
  .object({
    fromMode: AuthorityModeSchema,
    toMode: AuthorityModeSchema,
    atEpochMs: EpochMillisecondsSchema,
    actor: PrincipalIdSchema,
    reason: z.string().trim().min(1).max(512),
  })
  .strict();
export type AuthorityModeTransition = z.infer<
  typeof AuthorityModeTransitionSchema
>;

/** Recorded lifecycle state of one agent (tenant-scoped, CAS-versioned). */
export const AuthorityModeStateSchema = z
  .object({
    schema: z.literal(POLICY_SIMULATION_CONTRACT_SCHEMA),
    tenantId: TenantIdSchema,
    agentId: AgentIdSchema,
    mode: AuthorityModeSchema,
    version: z.number().int().positive(),
    updatedBy: PrincipalIdSchema.nullable(),
    updatedAtEpochMs: EpochMillisecondsSchema,
    lastTransition: AuthorityModeTransitionSchema.nullable(),
  })
  .strict();
export type AuthorityModeState = z.infer<typeof AuthorityModeStateSchema>;

export const AuthorityModeCommandSchema = z
  .object({
    kind: z.literal("set_mode"),
    mode: AuthorityModeSchema,
    actor: PrincipalIdSchema,
    expectedVersion: z.number().int().positive(),
    reason: z.string().trim().min(1).max(512),
  })
  .strict();
export type AuthorityModeCommand = z.infer<typeof AuthorityModeCommandSchema>;

/** The state a tenant's agents start in when no mode row exists. */
export function initialAuthorityModeState(input: {
  tenantId: z.infer<typeof TenantIdSchema>;
  agentId: z.infer<typeof AgentIdSchema>;
  nowEpochMs: number;
}): AuthorityModeState {
  return AuthorityModeStateSchema.parse({
    schema: POLICY_SIMULATION_CONTRACT_SCHEMA,
    tenantId: input.tenantId,
    agentId: input.agentId,
    mode: "enforce",
    version: 1,
    updatedBy: null,
    updatedAtEpochMs: input.nowEpochMs,
    lastTransition: null,
  });
}

/**
 * CAS mode transition: one adjacent step per command; a recorded
 * transition is appended to the state and never silent. Same-mode is
 * not a transition and is rejected.
 */
export function transitionAuthorityMode(
  recordInput: unknown,
  commandInput: unknown,
  nowEpochMs: number,
):
  | { ok: true; record: AuthorityModeState }
  | {
      ok: false;
      reasonCode:
        | "MALFORMED_RECORD"
        | "MALFORMED_COMMAND"
        | "STALE_VERSION"
        | "INVALID_TRANSITION";
    } {
  const record = AuthorityModeStateSchema.safeParse(recordInput);
  if (!record.success) return { ok: false, reasonCode: "MALFORMED_RECORD" };
  const command = AuthorityModeCommandSchema.safeParse(commandInput);
  if (!command.success) {
    return { ok: false, reasonCode: "MALFORMED_COMMAND" };
  }
  if (command.data.expectedVersion !== record.data.version) {
    return { ok: false, reasonCode: "STALE_VERSION" };
  }
  const fromIndex = AUTHORITY_MODE_ORDER.indexOf(record.data.mode);
  const toIndex = AUTHORITY_MODE_ORDER.indexOf(command.data.mode);
  if (toIndex === fromIndex || Math.abs(toIndex - fromIndex) !== 1) {
    return { ok: false, reasonCode: "INVALID_TRANSITION" };
  }
  const now = EpochMillisecondsSchema.parse(nowEpochMs);
  return {
    ok: true,
    record: AuthorityModeStateSchema.parse({
      schema: POLICY_SIMULATION_CONTRACT_SCHEMA,
      tenantId: record.data.tenantId,
      agentId: record.data.agentId,
      mode: command.data.mode,
      version: record.data.version + 1,
      updatedBy: command.data.actor,
      updatedAtEpochMs: now,
      lastTransition: {
        fromMode: record.data.mode,
        toMode: command.data.mode,
        atEpochMs: now,
        actor: command.data.actor,
        reason: command.data.reason,
      },
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Shadow decision records (would_allow / would_ask / would_deny) */
/* ------------------------------------------------------------------ */

/**
 * A shadow verdict is what the kernel computed under OBSERVE/WARN — a
 * record label, never a fourth AuthorityDecision.
 */
export const ShadowVerdictSchema = z.enum([
  "would_allow",
  "would_ask",
  "would_deny",
]);
export type ShadowVerdict = z.infer<typeof ShadowVerdictSchema>;

/** Maps the kernel verdict to its recorded shadow label. */
export function shadowVerdictFor(
  decision: AuthorityDecision["decision"],
): ShadowVerdict {
  if (decision === "ALLOW") return "would_allow";
  if (decision === "ASK") return "would_ask";
  return "would_deny";
}

/** Modes under which execution is unaltered and verdicts are recorded. */
export const SHADOW_MODES = ["observe", "warn"] as const;

/** Digest-bound record of what an observed request would have done. */
export const ShadowDecisionRecordSchema = z
  .object({
    schema: z.literal(POLICY_SIMULATION_CONTRACT_SCHEMA),
    tenantId: TenantIdSchema,
    principalId: PrincipalIdSchema,
    agentId: AgentIdSchema,
    requestId: RequestIdSchema,
    correlationId: CorrelationIdSchema,
    actionDigest: Sha256DigestSchema,
    mode: z.enum(["observe", "warn"]),
    verdict: ShadowVerdictSchema,
    reasonCode: z.string().trim().min(1).max(128),
    actionDecisionRecordDigest: Sha256DigestSchema.nullable(),
    decidedAtEpochMs: EpochMillisecondsSchema,
  })
  .strict();

export type ShadowDecisionRecord = z.infer<typeof ShadowDecisionRecordSchema>;

export function shadowDecisionRecordDigest(
  record: ShadowDecisionRecord,
): string {
  return canonicalSha256({
    domain: "odingard.guardian.shadow-decision.v1",
    record,
  });
}

/**
 * Builds the digest-bound shadow record for an OBSERVE/WARN issuance:
 * what the kernel computed, bound to the live action and decision-record
 * digests. The record never enters the verdict itself.
 */
export function createShadowDecisionRecord(input: {
  tenantId: z.infer<typeof TenantIdSchema>;
  principalId: z.infer<typeof PrincipalIdSchema>;
  agentId: z.infer<typeof AgentIdSchema>;
  requestId: z.infer<typeof RequestIdSchema>;
  correlationId: z.infer<typeof CorrelationIdSchema>;
  actionDigest: string;
  mode: "observe" | "warn";
  decision: AuthorityDecision;
  actionDecisionRecordDigest: string | null;
  decidedAtEpochMs: number;
}): ShadowDecisionRecord {
  const record = ShadowDecisionRecordSchema.parse({
    schema: POLICY_SIMULATION_CONTRACT_SCHEMA,
    tenantId: input.tenantId,
    principalId: input.principalId,
    agentId: input.agentId,
    requestId: input.requestId,
    correlationId: input.correlationId,
    actionDigest: input.actionDigest,
    mode: input.mode,
    verdict: shadowVerdictFor(input.decision.decision),
    reasonCode: input.decision.reasonCode,
    actionDecisionRecordDigest: input.actionDecisionRecordDigest,
    decidedAtEpochMs: input.decidedAtEpochMs,
  });
  return record;
}

/* ------------------------------------------------------------------ */
/* Simulation scenarios and the policy candidate                 */
/* ------------------------------------------------------------------ */

/**
 * One simulation scenario: the recorded evaluation input the SAME kernel
 * would evaluate live — recorded history replayed, a synthetic input, or
 * a current agent/resource pair rebuilt by the caller.
 */
export const PolicyScenarioSchema = z
  .object({
    scenarioId: z.string().trim().min(1).max(256),
    evaluationInput: RecordedAuthorityEvaluationInputSchema,
  })
  .strict();
export type PolicyScenario = z.infer<typeof PolicyScenarioSchema>;

/**
 * The policy under test: a proposed policy reference and a declarative
 * grant-set mutation applied to each scenario's authority chain. A human
 * always activates policy; applying a candidate only ever changes a
 * simulation input, never live state.
 */
export const PolicyCandidateSchema = z
  .object({
    policy: PolicyReferenceSchema.optional(),
    upsertedGrants: z.array(AuthorityGrantSchema).max(32).default([]),
    removedGrantIds: z.array(GrantIdSchema).max(32).default([]),
  })
  .strict();
export type PolicyCandidate = z.infer<typeof PolicyCandidateSchema>;

/**
 * Applies a candidate to an evaluation input: removed grant ids drop
 * out, upserts replace same-id grants, remaining grants sort by id for
 * determinism, and a proposed policy reference replaces the recorded one.
 */
export function applyPolicyCandidate(
  input: RecordedAuthorityEvaluationInput,
  candidateInput: unknown,
): RecordedAuthorityEvaluationInput {
  const candidate = PolicyCandidateSchema.parse(candidateInput);
  const removed = new Set<string>(candidate.removedGrantIds);
  const upserted = new Map<string, AuthorityGrant>();
  for (const grant of candidate.upsertedGrants) {
    upserted.set(grant.id, grant);
  }
  const chain = input.authorityChain
    .filter((grant) => !removed.has(grant.id) && !upserted.has(grant.id))
    .concat([...upserted.values()])
    .sort((a, b) => a.id.localeCompare(b.id));
  return RecordedAuthorityEvaluationInputSchema.parse({
    ...input,
    policy: candidate.policy ?? input.policy,
    authorityChain: chain,
  });
}

/**
 * ASK-HEAVY posture: the declared transform narrows every chain
 * grant to approval-required, so the SAME kernel naturally returns ASK
 * for anything satisfiable — a declarative input change, never a kernel
 * branch. The recorded evaluation input binds the transformed chain.
 */
export function applyAskHeavyPosture(
  input: RecordedAuthorityEvaluationInput,
): RecordedAuthorityEvaluationInput {
  return RecordedAuthorityEvaluationInputSchema.parse({
    ...input,
    authorityChain: input.authorityChain.map((grant) => ({
      ...grant,
      constraints: { ...grant.constraints, approvalRequired: true },
    })),
  });
}

/* ------------------------------------------------------------------ */
/* Outcomes and verdict counts                                   */
/* ------------------------------------------------------------------ */

/** A live verdict as computed by the one kernel — three values only. */
export const SimulationVerdictSchema = z.enum(["ALLOW", "ASK", "DENY"]);
export type SimulationVerdict = z.infer<typeof SimulationVerdictSchema>;

export const SimulationOutcomeSchema = z
  .object({
    scenarioId: z.string().trim().min(1).max(256),
    agentId: AgentIdSchema,
    action: ActionTypeSchema,
    resource: z.string().trim().min(1).max(1024),
    verdict: SimulationVerdictSchema,
    reasonCode: z.string().trim().min(1).max(128),
  })
  .strict();
export type SimulationOutcome = z.infer<typeof SimulationOutcomeSchema>;

export const AuthorityVerdictCountsSchema = z
  .object({
    allow: z.number().int().nonnegative(),
    ask: z.number().int().nonnegative(),
    deny: z.number().int().nonnegative(),
  })
  .strict();
export type AuthorityVerdictCounts = z.infer<
  typeof AuthorityVerdictCountsSchema
>;

export function countOutcomes(
  outcomes: readonly Pick<SimulationOutcome, "verdict">[],
): AuthorityVerdictCounts {
  let allow = 0;
  let ask = 0;
  let deny = 0;
  for (const outcome of outcomes) {
    if (outcome.verdict === "ALLOW") allow += 1;
    else if (outcome.verdict === "ASK") ask += 1;
    else deny += 1;
  }
  return { allow, ask, deny };
}

/* ------------------------------------------------------------------ */
/* Authority diff                                                */
/* ------------------------------------------------------------------ */

export const AuthorityOutcomeChangeSchema = z
  .object({
    scenarioId: z.string().trim().min(1).max(256),
    agentId: AgentIdSchema,
    action: ActionTypeSchema,
    previousVerdict: SimulationVerdictSchema,
    proposedVerdict: SimulationVerdictSchema,
  })
  .strict();
export type AuthorityOutcomeChange = z.infer<
  typeof AuthorityOutcomeChangeSchema
>;

/**
 * Authority diff: verdict-count deltas plus the materialized newly-allowed and
 * newly-denied action classes (newly-asked materialized alongside).
 */
export const AuthorityDiffSchema = z
  .object({
    verdictDelta: z
      .object({
        allow: z.number().int(),
        ask: z.number().int(),
        deny: z.number().int(),
      })
      .strict(),
    changes: z.array(AuthorityOutcomeChangeSchema).max(4096),
    newlyAllowedActionClasses: z.array(ActionTypeSchema).max(512),
    newlyDeniedActionClasses: z.array(ActionTypeSchema).max(512),
    newlyAskedActionClasses: z.array(ActionTypeSchema).max(512),
  })
  .strict();
export type AuthorityDiff = z.infer<typeof AuthorityDiffSchema>;

/**
 * Matches baseline and proposed outcomes by scenarioId; a scenario absent
 * from either side diffs against DENY-by-absence only for its own side —
 * scenarios present on one side only still appear in `changes` when the
 * present side's verdict differs from the other's.
 */
export function diffAuthorityOutcomes(
  previous: readonly SimulationOutcome[],
  proposed: readonly SimulationOutcome[],
): AuthorityDiff {
  const previousById = new Map(previous.map((o) => [o.scenarioId, o]));
  const proposedById = new Map(proposed.map((o) => [o.scenarioId, o]));
  const changes: AuthorityOutcomeChange[] = [];
  const newlyAllowed = new Set<string>();
  const newlyDenied = new Set<string>();
  const newlyAsked = new Set<string>();
  for (const [scenarioId, next] of [...proposedById.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const prior = previousById.get(scenarioId);
    if (!prior) {
      changes.push({
        scenarioId,
        agentId: next.agentId,
        action: next.action,
        previousVerdict: "DENY",
        proposedVerdict: next.verdict,
      });
      if (next.verdict === "ALLOW") newlyAllowed.add(next.action);
      else if (next.verdict === "ASK") newlyAsked.add(next.action);
      continue;
    }
    if (prior.verdict === next.verdict) continue;
    changes.push({
      scenarioId,
      agentId: next.agentId,
      action: next.action,
      previousVerdict: prior.verdict,
      proposedVerdict: next.verdict,
    });
    if (prior.verdict !== "ALLOW" && next.verdict === "ALLOW") {
      newlyAllowed.add(next.action);
    }
    if (prior.verdict !== "DENY" && next.verdict === "DENY") {
      newlyDenied.add(next.action);
    }
    if (prior.verdict !== "ASK" && next.verdict === "ASK") {
      newlyAsked.add(next.action);
    }
  }
  for (const [scenarioId, prior] of [...previousById.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    if (!proposedById.has(scenarioId)) {
      changes.push({
        scenarioId,
        agentId: prior.agentId,
        action: prior.action,
        previousVerdict: prior.verdict,
        proposedVerdict: "DENY",
      });
      if (prior.verdict !== "DENY") newlyDenied.add(prior.action);
    }
  }
  const previousCounts = countOutcomes(previous);
  const proposedCounts = countOutcomes(proposed);
  return AuthorityDiffSchema.parse({
    verdictDelta: {
      allow: proposedCounts.allow - previousCounts.allow,
      ask: proposedCounts.ask - previousCounts.ask,
      deny: proposedCounts.deny - previousCounts.deny,
    },
    changes,
    newlyAllowedActionClasses: [...newlyAllowed].sort(),
    newlyDeniedActionClasses: [...newlyDenied].sort(),
    newlyAskedActionClasses: [...newlyAsked].sort(),
  });
}

/* ------------------------------------------------------------------ */
/* Blast radius                                                  */
/* ------------------------------------------------------------------ */

/** Action classes treated as protected-data exposure in blast-radius reporting. */
export function isProtectedDataActionClass(action: string): boolean {
  return action.startsWith("protected_data.");
}

export const BlastRadiusSchema = z
  .object({
    agentsAffected: z.array(AgentIdSchema).max(1024),
    resourcesAffected: z.array(z.string().trim().min(1).max(1024)).max(4096),
    newActionClasses: z.array(ActionTypeSchema).max(512),
    newCounterparties: z.array(z.string().trim().min(1).max(256)).max(1024),
    additionalMoneyExposureCents: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    additionalProtectedDataExposure: z.array(ActionTypeSchema).max(512),
    delegationExpansion: z
      .object({
        addedDelegableGrantIds: z.array(GrantIdSchema).max(512),
      })
      .strict(),
    runtimeExpansion: z
      .object({
        widenedGrantIds: z.array(GrantIdSchema).max(512),
        addedGrantIds: z.array(GrantIdSchema).max(512),
        addedCoverageEpochMs: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
  })
  .strict();
export type BlastRadius = z.infer<typeof BlastRadiusSchema>;

/**
 * Blast radius, computed deterministically from the two outcome sets,
 * the scenario inputs and the declared candidate. `nowEpochMs` bounds the
 * coverage arithmetic for added grants without a notBefore.
 */
export function computeBlastRadius(input: {
  baselineScenarios: readonly PolicyScenario[];
  baselineOutcomes: readonly SimulationOutcome[];
  proposedOutcomes: readonly SimulationOutcome[];
  candidate: PolicyCandidate;
  nowEpochMs: number;
}): BlastRadius {
  const baselineById = new Map(
    input.baselineOutcomes.map((o) => [o.scenarioId, o]),
  );
  const proposedById = new Map(
    input.proposedOutcomes.map((o) => [o.scenarioId, o]),
  );

  const baselineChainAdapterIds = new Set<string>();
  const baselineChainMerchants = new Set<string>();
  const baselineGrantById = new Map<string, AuthorityGrant>();
  for (const scenario of input.baselineScenarios) {
    for (const grant of scenario.evaluationInput.authorityChain) {
      baselineGrantById.set(grant.id, grant);
      for (const adapterId of grant.constraints.adapterIds) {
        baselineChainAdapterIds.add(adapterId);
      }
      for (const merchant of grant.constraints.merchantAllowlist ?? []) {
        baselineChainMerchants.add(merchant);
      }
    }
  }

  const agents = new Set<string>();
  const resources = new Set<string>();
  const actions = new Set<string>();
  const protectedActions = new Set<string>();
  let additionalMoney = 0;

  for (const [scenarioId, next] of proposedById) {
    const prior = baselineById.get(scenarioId);
    if (prior && prior.verdict === next.verdict) continue;
    agents.add(next.agentId);
    resources.add(next.resource);
    if (!prior || (prior.verdict !== "ALLOW" && next.verdict === "ALLOW")) {
      if (next.verdict === "ALLOW") {
        actions.add(next.action);
        if (isProtectedDataActionClass(next.action)) {
          protectedActions.add(next.action);
        }
        const scenario = input.baselineScenarios.find(
          (s) => s.scenarioId === scenarioId,
        );
        const valueCents = scenario?.evaluationInput.request.valueCents ?? 0;
        additionalMoney += valueCents;
      }
    }
  }

  const counterparties = new Set<string>();
  const addedDelegableGrantIds: string[] = [];
  const widenedGrantIds: string[] = [];
  const addedGrantIds: string[] = [];
  let addedCoverageEpochMs = 0;
  for (const grant of input.candidate.upsertedGrants) {
    agents.add(grant.agentId);
    for (const resource of grant.constraints.resources) {
      resources.add(resource);
    }
    for (const action of grant.constraints.actions) {
      actions.add(action);
      if (isProtectedDataActionClass(action)) protectedActions.add(action);
    }
    for (const adapterId of grant.constraints.adapterIds) {
      if (!baselineChainAdapterIds.has(adapterId)) {
        counterparties.add(adapterId);
      }
    }
    for (const merchant of grant.constraints.merchantAllowlist ?? []) {
      if (!baselineChainMerchants.has(merchant)) {
        counterparties.add(merchant);
      }
    }
    const prior = baselineGrantById.get(grant.id);
    if (!prior) {
      addedGrantIds.push(grant.id);
      const start = grant.constraints.notBeforeEpochMs ?? input.nowEpochMs;
      addedCoverageEpochMs += Math.max(
        0,
        grant.constraints.expiresAtEpochMs - start,
      );
    } else {
      let widened = 0;
      widened += Math.max(
        0,
        grant.constraints.expiresAtEpochMs - prior.constraints.expiresAtEpochMs,
      );
      widened += Math.max(
        0,
        (prior.constraints.notBeforeEpochMs ?? 0) -
          (grant.constraints.notBeforeEpochMs ?? 0),
      );
      if (widened > 0) {
        widenedGrantIds.push(grant.id);
        addedCoverageEpochMs += widened;
      }
    }
    if (grant.delegable && (!prior || !prior.delegable)) {
      addedDelegableGrantIds.push(grant.id);
    }
  }

  return BlastRadiusSchema.parse({
    agentsAffected: [...agents].sort(),
    resourcesAffected: [...resources].sort(),
    newActionClasses: [...actions].sort(),
    newCounterparties: [...counterparties].sort(),
    additionalMoneyExposureCents: additionalMoney,
    additionalProtectedDataExposure: [...protectedActions].sort(),
    delegationExpansion: {
      addedDelegableGrantIds: [...new Set(addedDelegableGrantIds)].sort(),
    },
    runtimeExpansion: {
      widenedGrantIds: [...new Set(widenedGrantIds)].sort(),
      addedGrantIds: [...new Set(addedGrantIds)].sort(),
      addedCoverageEpochMs,
    },
  });
}

/* ------------------------------------------------------------------ */
/* The persisted simulation run record                           */
/* ------------------------------------------------------------------ */

export const SimulationRunIdSchema = z
  .string()
  .regex(/^sim_[0-9a-f]{16,64}$/, "simulation run ids look like sim_<hex>");
export type SimulationRunId = z.infer<typeof SimulationRunIdSchema>;

/**
 * The digest-bound run record a human reviews before activating policy:
 * both outcome sets, the authority diff and the blast radius, bound to the
 * candidate digest so consequences cannot be detached from the proposal.
 */
export const PolicySimulationRunSchema = z
  .object({
    schema: z.literal(POLICY_SIMULATION_CONTRACT_SCHEMA),
    runId: SimulationRunIdSchema,
    tenantId: TenantIdSchema,
    createdBy: PrincipalIdSchema,
    createdAtEpochMs: EpochMillisecondsSchema,
    scenarioDigests: z.array(Sha256DigestSchema).max(4096),
    candidate: PolicyCandidateSchema,
    candidateDigest: Sha256DigestSchema,
    baseline: z
      .object({
        counts: AuthorityVerdictCountsSchema,
        outcomes: z.array(SimulationOutcomeSchema).max(4096),
      })
      .strict(),
    proposed: z
      .object({
        counts: AuthorityVerdictCountsSchema,
        outcomes: z.array(SimulationOutcomeSchema).max(4096),
      })
      .strict(),
    diff: AuthorityDiffSchema,
    blastRadius: BlastRadiusSchema,
    runDigest: Sha256DigestSchema,
  })
  .strict();
export type PolicySimulationRun = z.infer<typeof PolicySimulationRunSchema>;

export function policySimulationRunDigest(
  run: Omit<PolicySimulationRun, "runDigest">,
): string {
  return canonicalSha256({
    domain: "odingard.guardian.policy-simulation-run.v1",
    run,
  });
}

export function policyCandidateDigest(candidate: PolicyCandidate): string {
  return canonicalSha256({
    domain: "odingard.guardian.policy-candidate.v1",
    candidate,
  });
}

export function policyScenarioDigest(scenario: PolicyScenario): string {
  return canonicalSha256({
    domain: "odingard.guardian.policy-scenario.v1",
    scenario,
  });
}

/** Guard: a shadow verdict label is never the live verdict type. */
type _ShadowIsNotAVerdict = ShadowVerdict extends AuthorityDecision["decision"]
  ? never
  : true;
const shadowNotAVerdict: _ShadowIsNotAVerdict = true;
void shadowNotAVerdict;
