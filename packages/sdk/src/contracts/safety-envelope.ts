// Generated file — do not edit.
import { z } from "zod";

import { EpochMillisecondsSchema } from "./authority.js";
import { canonicalSha256 } from "./digest.js";
import { Sha256DigestSchema } from "./evidence.js";
import { PrincipalIdSchema, TenantIdSchema } from "./identifiers.js";

/**
 * guardian.safety_envelope.v1 — generic physical safety envelope.
 *
 * Physical actions keep the SAME kernel and gain declarative constraint
 * facts on the canonical action envelope: zone, speed, payload,
 * force, hours, human distance. Nothing robotics-specific enters the
 * kernel — these are generic policy facts evaluated deterministically.
 *
 * A generic safety-envelope structure evaluated by the pure
 * evaluator below. A violation denies or narrows (supervision_required
 * narrows to ASK); the evaluator never warns-and-allows and never
 * enlarges authority.
 *
 * Offline authority may narrow, it may never expand. When fresh
 * authority cannot be obtained for a safety-critical physical operation,
 * the system defaults to the previously recorded safe state; it never
 * invents ALLOW. Edge enforcement is bounded by the freshest recorded
 * authority: a local evaluator may only enforce a decision
 * equal-to-or-narrower than the recorded snapshot, and a stale snapshot
 * fails closed.
 */

export const SAFETY_ENVELOPE_CONTRACT_SCHEMA = "guardian.safety_envelope.v1";

/* ------------------------------------------------------------------ */
/* Physical action facts on the canonical envelope               */
/* ------------------------------------------------------------------ */

/**
 * Declarative constraint facts a physical action carries on its
 * material envelope. All values are generic numbers in whatever unit
 * the governing envelope declares — the kernel never interprets units.
 * Absent facts are simply not checked against the matching cap.
 */
export const PhysicalActionFactsSchema = z
  .object({
    /** Declared operating zone (e.g. "warehouse-A"). */
    zone: z.string().trim().min(1).max(128).optional(),
    speed: z
      .number()
      .finite()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    force: z
      .number()
      .finite()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    payload: z
      .number()
      .finite()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    /** Declared instant the physical operation starts (for time_window). */
    atEpochMs: EpochMillisecondsSchema.optional(),
    /** Declared minimum distance to humans. */
    humanDistance: z
      .number()
      .finite()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    /** Declared environment facts matched against environment_conditions. */
    environment: z
      .record(z.string().trim().min(1).max(64), z.string().trim().max(256))
      .optional(),
    /** Declared human supervision of the operation. */
    supervised: z.boolean().optional(),
  })
  .strict();
export type PhysicalActionFacts = z.infer<typeof PhysicalActionFactsSchema>;

/* ------------------------------------------------------------------ */
/* Generic safety envelope                                       */
/* ------------------------------------------------------------------ */

/**
 * A wall-clock window in minutes-of-day, e.g. 06:00–18:00 is
 * { startMinutesOfDay: 360, endMinutesOfDay: 1080 }. An end earlier
 * than the start wraps midnight (22:00–06:00).
 */
export const SafetyTimeWindowSchema = z
  .object({
    startMinutesOfDay: z.number().int().min(0).max(1439),
    endMinutesOfDay: z.number().int().min(0).max(1439),
  })
  .strict();
export type SafetyTimeWindow = z.infer<typeof SafetyTimeWindowSchema>;

/**
 * The generic safety-envelope structure. Every field is a generic
 * policy fact — nothing hardware- or robotics-specific. Declared on the
 * governing intent (and persisted as a safety_envelope record); the
 * evaluator checks the action's material facts against it.
 */
export const SafetyEnvelopeSchema = z
  .object({
    schema: z.literal(SAFETY_ENVELOPE_CONTRACT_SCHEMA),
    /** Zones the action's zone must be inside (absent = unconstrained). */
    allowedZone: z.array(z.string().trim().min(1).max(128)).max(64).optional(),
    /**
     * Zones the action's zone must NOT be inside. A forbidden zone
     * denies even inside an allowed zone — it always wins.
     */
    forbiddenZone: z
      .array(z.string().trim().min(1).max(128))
      .max(64)
      .optional(),
    maxSpeed: z
      .number()
      .finite()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    maxForce: z
      .number()
      .finite()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    maxPayload: z
      .number()
      .finite()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    timeWindow: SafetyTimeWindowSchema.optional(),
    /** Distance-to-humans floor the action must satisfy. */
    proximityConstraints: z
      .object({
        minHumanDistance: z
          .number()
          .finite()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .optional(),
    /**
     * Required environment facts: every declared key must exist on the
     * action's environment and equal the declared value.
     */
    environmentConditions: z
      .record(z.string().trim().min(1).max(64), z.string().trim().max(256))
      .optional(),
    /**
     * A human supervisor must be declared on the action. A violation
     * NARROWS to ASK (the existing approval machinery) rather than a
     * hard deny — a supervisor is exactly what approval provides.
     */
    supervisionRequired: z.boolean().optional(),
    /**
     * The recorded safe posture the system defaults to when fresh
     * authority cannot be obtained. Names the recorded safe state
     * (e.g. "hold", "retract"); it is presentation/evidence only — the
     * deterministic outcome of missing fresh authority is always deny.
     */
    failSafeAction: z.string().trim().min(1).max(64).optional(),
    /**
     * Whether an engaged emergency stop gates this envelope. Descriptive
     * only: emergency-stop enforcement is ALWAYS applied when an engaged
     * state exists — the field documents that the resource is estop-
     * governed; it can never disable the check.
     */
    emergencyStop: z.boolean().optional(),
  })
  .strict();
export type SafetyEnvelope = z.infer<typeof SafetyEnvelopeSchema>;

export function safetyEnvelopeDigest(envelope: SafetyEnvelope): string {
  return canonicalSha256({
    domain: "odingard.guardian.safety-envelope.v1",
    envelope,
  });
}

/* ------------------------------------------------------------------ */
/* Deterministic evaluation                                            */
/* ------------------------------------------------------------------ */

export const SafetyViolationSchema = z.enum([
  "OUT_OF_ZONE",
  "FORBIDDEN_ZONE",
  "OVER_SPEED",
  "OVER_FORCE",
  "OVER_PAYLOAD",
  "OUTSIDE_TIME_WINDOW",
  "PROXIMITY_VIOLATION",
  "ENVIRONMENT_VIOLATION",
  "SUPERVISION_REQUIRED",
]);
export type SafetyViolation = z.infer<typeof SafetyViolationSchema>;

/** Deterministic outcome of evaluating an envelope against action facts. */
export const SafetyEnvelopeOutcomeSchema = z
  .object({
    /** Digest of the envelope evaluated (the decision's binding). */
    envelopeDigest: Sha256DigestSchema,
    satisfied: z.boolean(),
    violations: z.array(SafetyViolationSchema).max(16),
    /** When true, emergency-stop state overrode every other field. */
    emergencyStopped: z.boolean(),
    /**
     * When true, fresh authority could not be obtained and the recorded
     * safe state was applied — never an invented ALLOW.
     */
    failSafeApplied: z.boolean(),
  })
  .strict();
export type SafetyEnvelopeOutcome = z.infer<typeof SafetyEnvelopeOutcomeSchema>;

export type SafetyEnvelopeEvaluation = Readonly<{
  satisfied: boolean;
  violations: readonly SafetyViolation[];
  /**
   * Violations that NARROW to ASK instead of denying. Only
   * supervision_required narrows; every other violation is a hard deny.
   */
  narrowsToApproval: boolean;
}>;

function minutesOfDay(epochMs: number): number {
  const ms = ((epochMs % 86_400_000) + 86_400_000) % 86_400_000;
  return Math.floor(ms / 60_000);
}

function insideTimeWindow(window: SafetyTimeWindow, epochMs: number): boolean {
  const minute = minutesOfDay(epochMs);
  const { startMinutesOfDay: start, endMinutesOfDay: end } = window;
  return start <= end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
}

/**
 * Pure deterministic evaluator: checks a declared safety envelope
 * against the action's material facts — inside allowed zone AND outside
 * forbidden zone (forbidden wins even inside allowed), within max
 * speed/force/payload, inside the time window, proximity/environment/
 * supervision satisfied. A violation never warns-and-allows.
 */
export function evaluateSafetyEnvelope(
  envelope: SafetyEnvelope,
  facts: PhysicalActionFacts,
  nowEpochMs: number,
): SafetyEnvelopeEvaluation {
  const violations: SafetyViolation[] = [];
  if (envelope.allowedZone !== undefined) {
    if (
      facts.zone === undefined ||
      !envelope.allowedZone.includes(facts.zone)
    ) {
      violations.push("OUT_OF_ZONE");
    }
  }
  if (envelope.forbiddenZone !== undefined && facts.zone !== undefined) {
    if (envelope.forbiddenZone.includes(facts.zone)) {
      violations.push("FORBIDDEN_ZONE");
    }
  }
  if (
    envelope.maxSpeed !== undefined &&
    facts.speed !== undefined &&
    facts.speed > envelope.maxSpeed
  ) {
    violations.push("OVER_SPEED");
  }
  if (
    envelope.maxForce !== undefined &&
    facts.force !== undefined &&
    facts.force > envelope.maxForce
  ) {
    violations.push("OVER_FORCE");
  }
  if (
    envelope.maxPayload !== undefined &&
    facts.payload !== undefined &&
    facts.payload > envelope.maxPayload
  ) {
    violations.push("OVER_PAYLOAD");
  }
  if (envelope.timeWindow !== undefined) {
    const at = facts.atEpochMs ?? nowEpochMs;
    if (!insideTimeWindow(envelope.timeWindow, at)) {
      violations.push("OUTSIDE_TIME_WINDOW");
    }
  }
  if (envelope.proximityConstraints !== undefined) {
    const floor = envelope.proximityConstraints.minHumanDistance;
    if (facts.humanDistance === undefined || facts.humanDistance < floor) {
      violations.push("PROXIMITY_VIOLATION");
    }
  }
  if (envelope.environmentConditions !== undefined) {
    for (const [key, required] of Object.entries(
      envelope.environmentConditions,
    )) {
      if (facts.environment?.[key] !== required) {
        violations.push("ENVIRONMENT_VIOLATION");
        break;
      }
    }
  }
  let narrowsToApproval = false;
  if (envelope.supervisionRequired === true && facts.supervised !== true) {
    violations.push("SUPERVISION_REQUIRED");
    narrowsToApproval = true;
  }
  const hard = violations.filter(
    (violation) => violation !== "SUPERVISION_REQUIRED",
  );
  return {
    satisfied: hard.length === 0 && violations.length === 0,
    violations,
    narrowsToApproval: narrowsToApproval && hard.length === 0,
  };
}

/* ------------------------------------------------------------------ */
/* Emergency stop — always enforced                                    */
/* ------------------------------------------------------------------ */

/**
 * The recorded emergency-stop state for one resource ("always
 * enforce"). An engaged state takes precedence over every other envelope
 * field and is invocable independent of any pending action. Once
 * engaged, all governed physical actions for that resource deny until
 * explicitly cleared by authority.
 */
export const EmergencyStopStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    tenantId: TenantIdSchema,
    /** The governed resource this stop applies to. */
    resource: z.string().trim().min(1).max(512),
    engaged: z.boolean(),
    engagedAtEpochMs: EpochMillisecondsSchema.nullable(),
    engagedBy: PrincipalIdSchema.nullable(),
    reason: z.string().min(1).max(256).nullable(),
    clearedAtEpochMs: EpochMillisecondsSchema.nullable(),
    clearedBy: PrincipalIdSchema.nullable(),
    version: z.number().int().positive(),
  })
  .strict();
export type EmergencyStopState = z.infer<typeof EmergencyStopStateSchema>;

export const EmergencyStopCommandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("engage"),
      reason: z.string().min(1).max(256),
      actor: PrincipalIdSchema,
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("clear"),
      reason: z.string().min(1).max(256),
      actor: PrincipalIdSchema,
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
]);
export type EmergencyStopCommand = z.infer<typeof EmergencyStopCommandSchema>;

export type EmergencyStopTransitionResult =
  | Readonly<{ ok: true; record: EmergencyStopState }>
  | Readonly<{
      ok: false;
      reasonCode:
        | "MALFORMED_RECORD"
        | "MALFORMED_COMMAND"
        | "STALE_VERSION"
        | "INVALID_TRANSITION";
    }>;

/**
 * Pure transition for the emergency-stop state machine (CAS-driven like
 * the transaction evaluator). Engage is idempotent — an already-engaged
 * stop stays engaged; only an explicit `clear` releases it.
 */
export function transitionEmergencyStop(
  recordInput: unknown,
  commandInput: unknown,
  nowEpochMs: number,
): EmergencyStopTransitionResult {
  const parsedRecord = EmergencyStopStateSchema.safeParse(recordInput);
  if (!parsedRecord.success) {
    return { ok: false, reasonCode: "MALFORMED_RECORD" };
  }
  const parsedCommand = EmergencyStopCommandSchema.safeParse(commandInput);
  if (!parsedCommand.success) {
    return { ok: false, reasonCode: "MALFORMED_COMMAND" };
  }
  const record = parsedRecord.data;
  const command = parsedCommand.data;
  if (command.expectedVersion !== record.version) {
    return { ok: false, reasonCode: "STALE_VERSION" };
  }
  switch (command.kind) {
    case "engage": {
      if (record.engaged) {
        return { ok: false, reasonCode: "INVALID_TRANSITION" };
      }
      return {
        ok: true,
        record: EmergencyStopStateSchema.parse({
          ...record,
          engaged: true,
          engagedAtEpochMs: nowEpochMs,
          engagedBy: command.actor,
          reason: command.reason,
          clearedAtEpochMs: null,
          clearedBy: null,
          version: record.version + 1,
        }),
      };
    }
    case "clear": {
      if (!record.engaged) {
        return { ok: false, reasonCode: "INVALID_TRANSITION" };
      }
      return {
        ok: true,
        record: EmergencyStopStateSchema.parse({
          ...record,
          engaged: false,
          clearedAtEpochMs: nowEpochMs,
          clearedBy: command.actor,
          reason: command.reason,
          version: record.version + 1,
        }),
      };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Offline narrowing + edge enforcement                          */
/* ------------------------------------------------------------------ */

/**
 * The freshest recorded authority snapshot an edge evaluator is bounded
 * by: the last recorded envelope + emergency-stop state plus
 * freshness facts. The edge may only enforce a decision
 * equal-to-or-narrower than this snapshot — and only while it is fresh.
 */
export const EdgeAuthoritySnapshotSchema = z
  .object({
    tenantId: TenantIdSchema,
    resource: z.string().trim().min(1).max(512),
    /** Freshest recorded envelope; null = no envelope recorded. */
    envelope: SafetyEnvelopeSchema.nullable(),
    /** Freshest recorded emergency-stop state; null = never recorded. */
    emergencyStop: EmergencyStopStateSchema.nullable(),
    /** When this snapshot was recorded by the authority. */
    freshnessEpochMs: EpochMillisecondsSchema,
    /** Freshness bound: older than this and the snapshot is stale. */
    maxAgeMs: z.number().int().positive().max(86_400_000),
  })
  .strict();
export type EdgeAuthoritySnapshot = z.infer<typeof EdgeAuthoritySnapshotSchema>;

export const EdgeDecisionSchema = z.enum([
  /** The action satisfies the recorded envelope — edge may allow. */
  "allow",
  /** A recorded constraint denies. */
  "deny",
  /**
   * Fresh authority could not be obtained or the snapshot is stale —
   * the recorded safe state applies; never an invented ALLOW.
   */
  "fail_safe",
]);
export type EdgeDecision = z.infer<typeof EdgeDecisionSchema>;

export type EdgeEvaluationResult = Readonly<{
  decision: EdgeDecision;
  violations: readonly SafetyViolation[];
  /** True when the emergency-stop state overrode every other field. */
  emergencyStopped: boolean;
  /** True when the snapshot was too stale to allow anything but fail-safe. */
  staleAuthority: boolean;
}>;

/**
 * Edge enforcement contract: a local evaluator may only enforce a
 * decision equal-to-or-narrower than the freshest recorded authority,
 * bounded by envelope freshness facts. A stale snapshot or an engaged
 * emergency stop fails closed — the edge can never invent ALLOW.
 */
export function evaluateEdgeDecision(
  snapshot: EdgeAuthoritySnapshot,
  facts: PhysicalActionFacts,
  nowEpochMs: number,
): EdgeEvaluationResult {
  const emergencyStopped = snapshot.emergencyStop?.engaged === true;
  const staleAuthority =
    nowEpochMs - snapshot.freshnessEpochMs > snapshot.maxAgeMs;
  if (emergencyStopped || staleAuthority) {
    return {
      decision: emergencyStopped ? "deny" : "fail_safe",
      violations: [],
      emergencyStopped,
      staleAuthority,
    };
  }
  if (snapshot.envelope === null) {
    // No recorded envelope: the recorded authority is the safe state —
    // offline narrowing never expands what was never recorded.
    return {
      decision: "fail_safe",
      violations: [],
      emergencyStopped: false,
      staleAuthority: false,
    };
  }
  const evaluation = evaluateSafetyEnvelope(
    snapshot.envelope,
    facts,
    nowEpochMs,
  );
  if (evaluation.satisfied) {
    return {
      decision: "allow",
      violations: [],
      emergencyStopped: false,
      staleAuthority: false,
    };
  }
  return {
    decision: evaluation.narrowsToApproval ? "fail_safe" : "deny",
    violations: evaluation.violations,
    emergencyStopped: false,
    staleAuthority: false,
  };
}

export type OfflineAuthorityResolution = Readonly<{
  /** The envelope the offline path enforces (recorded, never invented). */
  envelope: SafetyEnvelope | null;
  /** True when fresh authority could not be obtained → recorded safe state. */
  degraded: boolean;
  /** The recorded fail-safe posture name, when declared. */
  failSafeAction: string | null;
}>;

/**
 * Offline narrowing: offline authority may narrow, it may never
 * expand. When fresh authority cannot be obtained the system defaults to
 * the previously recorded safe state; it never invents ALLOW. A fresh
 * envelope simply returns itself (it can still only narrow through
 * evaluation); a missing one degrades to the recorded envelope's
 * fail-safe posture.
 */
export function resolveOfflineAuthority(input: {
  fresh: SafetyEnvelope | null;
  recorded: SafetyEnvelope | null;
}): OfflineAuthorityResolution {
  if (input.fresh !== null) {
    return {
      envelope: input.fresh,
      degraded: false,
      failSafeAction: input.fresh.failSafeAction ?? null,
    };
  }
  return {
    envelope: input.recorded,
    degraded: true,
    failSafeAction: input.recorded?.failSafeAction ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Persistence record (migration 0024)                                 */
/* ------------------------------------------------------------------ */

/** A recorded safety envelope for one governed resource. */
export const SafetyEnvelopeRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    tenantId: TenantIdSchema,
    resource: z.string().trim().min(1).max(512),
    envelope: SafetyEnvelopeSchema,
    envelopeDigest: Sha256DigestSchema,
    version: z.number().int().positive(),
    updatedBy: PrincipalIdSchema.nullable(),
    createdAtEpochMs: EpochMillisecondsSchema,
    updatedAtEpochMs: EpochMillisecondsSchema,
  })
  .strict();
export type SafetyEnvelopeRecord = z.infer<typeof SafetyEnvelopeRecordSchema>;
