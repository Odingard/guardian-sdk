// Generated file — do not edit.
import { z } from "zod";

import { ActionTypeSchema, EpochMillisecondsSchema } from "./authority.js";
import { canonicalSha256 } from "./digest.js";
import { Sha256DigestSchema } from "./evidence.js";
import {
  AgentIdSchema,
  AttemptIdSchema,
  CapabilityIdSchema,
  CorrelationIdSchema,
  PrincipalIdSchema,
  RequestIdSchema,
  TenantIdSchema,
  TransactionIdSchema,
} from "./identifiers.js";

/**
 * guardian.transaction.v1 — deterministic transaction authority.
 *
 * A transaction is the recorded lifecycle of one consequential action:
 * PROPOSE → PREPARE → AUTHORIZE → LOCK → COMMIT → VERIFY → SETTLE, entered
 * only when the action or its governing intent declares it. Every stage is
 * a recorded transition bound to the canonical action digest; a skipped or
 * out-of-order stage fails closed.
 *
 * The evaluator in this file is pure and deterministic. It never enlarges
 * authority: it records what the authority path already decided, and a
 * compensating action is a NEW governed action through the same
 * ALLOW/ASK/DENY path — compensation never bypasses ASK. A transaction
 * whose provider outcome is unconfirmed records UNKNOWN or MISMATCH; an
 * unconfirmed effect is never reported SETTLED.
 */

export const TRANSACTION_CONTRACT_SCHEMA = "guardian.transaction.v1";

/* ------------------------------------------------------------------ */
/* Transaction protocol stages                                   */
/* ------------------------------------------------------------------ */

export const TransactionStageSchema = z.enum([
  "PROPOSE",
  "PREPARE",
  "AUTHORIZE",
  "LOCK",
  "COMMIT",
  "VERIFY",
  "SETTLE",
]);
export type TransactionStage = z.infer<typeof TransactionStageSchema>;

/** The one canonical stage order. */
export const CANONICAL_TRANSACTION_STAGES: readonly TransactionStage[] =
  Object.freeze([...TransactionStageSchema.options]);

/* ------------------------------------------------------------------ */
/* Effect transaction states                                     */
/* ------------------------------------------------------------------ */

export const TransactionStateSchema = z.enum([
  // Normal progression.
  "PROPOSED",
  "PREPARED",
  "AUTHORIZED",
  "LOCKED",
  "COMMITTING",
  "COMMITTED",
  "VERIFIED",
  "SETTLED",
  // Exceptional states.
  "DENIED",
  "EXPIRED",
  "REVOKED",
  "UNKNOWN",
  "MISMATCH",
  "FAILED",
  "CANCELLED",
  "COMPENSATING",
  "COMPENSATED",
]);
export type TransactionState = z.infer<typeof TransactionStateSchema>;

/** States from which the transaction can never move again. */
export const TERMINAL_TRANSACTION_STATES: readonly TransactionState[] =
  Object.freeze([
    "SETTLED",
    "DENIED",
    "EXPIRED",
    "FAILED",
    "CANCELLED",
    "COMPENSATED",
  ]);

export function isTerminalTransactionState(state: TransactionState): boolean {
  return TERMINAL_TRANSACTION_STATES.includes(state);
}

/* ------------------------------------------------------------------ */
/* Declared lifecycle                                            */
/* ------------------------------------------------------------------ */

/**
 * The declared lifecycle of a transaction: a strictly-increasing
 * subsequence of the canonical stage order that must contain PROPOSE.
 * Declared on the action definition and/or the governing intent; the
 * effective declaration is the union in canonical order — declaration
 * only ever adds recorded obligations, it cannot remove a stage the
 * other declaration required.
 */
export const TransactionDeclarationSchema = z
  .object({
    schema: z.literal(TRANSACTION_CONTRACT_SCHEMA),
    stages: z
      .array(TransactionStageSchema)
      .min(1)
      .max(CANONICAL_TRANSACTION_STAGES.length),
    /**
     * Optional wall-clock bound on the whole transaction. When set the
     * record carries expiresAtEpochMs; commands arriving after the
     * deadline fail closed (TRANSACTION_EXPIRED) until `expire` runs.
     */
    deadlineMs: z.number().int().positive().max(86_400_000).optional(),
  })
  .strict()
  .superRefine((declaration, context) => {
    let lastIndex = -1;
    for (const stage of declaration.stages) {
      const index = CANONICAL_TRANSACTION_STAGES.indexOf(stage);
      if (index <= lastIndex) {
        context.addIssue({
          code: "custom",
          path: ["stages"],
          message:
            "stages must be unique and in canonical order " +
            "(PROPOSE→PREPARE→AUTHORIZE→LOCK→COMMIT→VERIFY→SETTLE)",
        });
        return;
      }
      lastIndex = index;
    }
    if (!declaration.stages.includes("PROPOSE")) {
      context.addIssue({
        code: "custom",
        path: ["stages"],
        message: "a transaction lifecycle must declare PROPOSE",
      });
    }
  });
export type TransactionDeclaration = z.infer<
  typeof TransactionDeclarationSchema
>;

export function transactionDeclarationDigest(
  declaration: TransactionDeclaration,
): string {
  return canonicalSha256({
    domain: "odingard.guardian.transaction-declaration.v1",
    schema: declaration.schema,
    stages: declaration.stages,
    deadlineMs: declaration.deadlineMs ?? null,
  });
}

/**
 * Union of two declared lifecycles in canonical order (declaration only
 * ever enlarges the recorded obligation set, never shrinks it). The
 * tighter deadline wins. Returns undefined when neither declares.
 */
export function effectiveTransactionDeclaration(
  declaredA: TransactionDeclaration | undefined,
  declaredB: TransactionDeclaration | undefined,
): TransactionDeclaration | undefined {
  if (declaredA === undefined && declaredB === undefined) return undefined;
  const seen = new Set<TransactionStage>();
  for (const stage of declaredA?.stages ?? []) seen.add(stage);
  for (const stage of declaredB?.stages ?? []) seen.add(stage);
  const stages = CANONICAL_TRANSACTION_STAGES.filter((stage) =>
    seen.has(stage),
  );
  const deadlines = [declaredA?.deadlineMs, declaredB?.deadlineMs].filter(
    (value): value is number => value !== undefined,
  );
  return TransactionDeclarationSchema.parse({
    schema: TRANSACTION_CONTRACT_SCHEMA,
    stages,
    ...(deadlines.length === 0 ? {} : { deadlineMs: Math.min(...deadlines) }),
  });
}

/* ------------------------------------------------------------------ */
/* Provider idempotency contract                                 */
/* ------------------------------------------------------------------ */

/**
 * Every consequential adapter declares its idempotency posture. The
 * declaration is data on the adapter record — it is required, never
 * inferred. A retry always binds to the recorded execution attempt's
 * idempotency key (the effect key); a retry can never carry a fresh key
 * that would silently produce a second effect.
 */
export const AdapterIdempotencyDeclarationSchema = z
  .object({
    /**
     * "keyed": the provider accepts an idempotency key and dedupes on it.
     * "provider-native": the provider has its own idempotency primitive.
     * "none": no provider-side dedupe — Guardian-side dedupe
     * (single-use capability + recorded effect key) is the only guard.
     */
    support: z.enum(["keyed", "provider-native", "none"]),
    /** What the provider does on a duplicate effect request. */
    duplicateEffect: z.enum(["return-existing", "reject", "unsafe"]),
    /**
     * Retry semantics. "same-attempt-key": retries MUST carry the
     * recorded attempt's idempotency key. "fresh-authority": the
     * adapter has no safe retry — a retry requires a fresh governed
     * authority decision (a new capability).
     */
    retry: z.enum(["same-attempt-key", "fresh-authority"]),
    /** How a missing/unconfirmed outcome is reconciled. */
    reconciliation: z.enum(["readback", "callback", "manual", "none"]),
  })
  .strict();
export type AdapterIdempotencyDeclaration = z.infer<
  typeof AdapterIdempotencyDeclarationSchema
>;

/* ------------------------------------------------------------------ */
/* Compensation binding (rides the canonical action digest)      */
/* ------------------------------------------------------------------ */

/**
 * Bound into the canonical action of a compensating action: which
 * recorded transaction this action compensates. The action still goes
 * through the full authority path — this binding only declares the
 * relationship.
 */
export const TransactionCompensationBindingSchema = z
  .object({
    /** The transaction record this action compensates. */
    transactionId: TransactionIdSchema,
  })
  .strict();
export type TransactionCompensationBinding = z.infer<
  typeof TransactionCompensationBindingSchema
>;

/* ------------------------------------------------------------------ */
/* Transaction record                                                  */
/* ------------------------------------------------------------------ */

export const TransactionStageRecordSchema = z
  .object({
    stage: TransactionStageSchema,
    atEpochMs: EpochMillisecondsSchema,
    /**
     * What the stage binds to: the action digest at PROPOSE, the
     * decision-record digest at AUTHORIZE, the capability id at LOCK,
     * the attempt/effect key at COMMIT/VERIFY, or null.
     */
    binding: z.string().min(1).max(512).nullable(),
  })
  .strict();
export type TransactionStageRecord = z.infer<
  typeof TransactionStageRecordSchema
>;

/** How a revocation mid-transaction resolves. */
export const TransactionResolutionSchema = z.enum([
  /** No effect landed — the transaction may safely cancel. */
  "cancel",
  /** An effect may have landed — the transaction must settle/compensate. */
  "settle",
  /** Commit was issued but unconfirmed — hold until outcome arrives. */
  "hold",
]);
export type TransactionResolution = z.infer<typeof TransactionResolutionSchema>;

export const TransactionRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    schema: z.literal(TRANSACTION_CONTRACT_SCHEMA),
    transactionId: TransactionIdSchema,
    tenantId: TenantIdSchema,
    principalId: PrincipalIdSchema,
    agentId: AgentIdSchema,
    requestId: RequestIdSchema,
    correlationId: CorrelationIdSchema,
    action: ActionTypeSchema,
    actionDigest: Sha256DigestSchema,
    declaration: TransactionDeclarationSchema,
    declarationDigest: Sha256DigestSchema,
    /** Completed declared stages, in recorded order. */
    recordedStages: z
      .array(TransactionStageRecordSchema)
      .max(CANONICAL_TRANSACTION_STAGES.length),
    state: TransactionStateSchema,
    /** Set while state === "REVOKED"; null otherwise. */
    resolution: TransactionResolutionSchema.nullable(),
    attemptId: AttemptIdSchema.nullable(),
    capabilityId: CapabilityIdSchema.nullable(),
    /** The recorded effect key a retry must reuse. */
    idempotencyKey: Sha256DigestSchema.nullable(),
    /** This transaction compensates another. */
    compensationOf: TransactionIdSchema.nullable(),
    /** Another transaction compensates this one. */
    compensationBy: TransactionIdSchema.nullable(),
    terminalReason: z.string().min(1).max(256).nullable(),
    expiresAtEpochMs: EpochMillisecondsSchema.nullable(),
    version: z.number().int().positive(),
    createdAtEpochMs: EpochMillisecondsSchema,
    updatedAtEpochMs: EpochMillisecondsSchema,
  })
  .strict();
export type TransactionRecord = z.infer<typeof TransactionRecordSchema>;

/** Deterministic transaction id: one transaction per request. */
export function transactionIdForRequest(requestId: string): string {
  return `txn_${requestId.replace(/^req_/, "")}`;
}

/**
 * Whether a transaction's effect may be compensated: a landed (or
 * possibly-landed) effect only; pre-commit states cancel instead.
 */
export function isCompensatableTransaction(record: TransactionRecord): boolean {
  switch (record.state) {
    case "COMMITTED":
    case "VERIFIED":
    case "SETTLED":
    case "MISMATCH":
    case "UNKNOWN":
    case "FAILED":
      return true;
    case "REVOKED":
      return record.resolution === "settle";
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ */
/* Commands                                                      */
/* ------------------------------------------------------------------ */

const CommandBase = {
  expectedVersion: z.number().int().positive(),
};

export const TransactionCommandSchema = z.discriminatedUnion("kind", [
  /** A declared stage completed in canonical order. */
  z
    .object({
      kind: z.literal("record-stage"),
      stage: TransactionStageSchema,
      binding: z.string().min(1).max(512).nullable(),
      ...CommandBase,
    })
    .strict(),
  /** The authority decision denied before AUTHORIZE completed. */
  z
    .object({
      kind: z.literal("deny"),
      reason: z.string().min(1).max(256),
      ...CommandBase,
    })
    .strict(),
  /** Safe cancellation — only before a confirmed commit. */
  z
    .object({
      kind: z.literal("cancel"),
      reason: z.string().min(1).max(256),
      ...CommandBase,
    })
    .strict(),
  /** Deadline reached. */
  z
    .object({
      kind: z.literal("expire"),
      reason: z.string().min(1).max(256),
      ...CommandBase,
    })
    .strict(),
  /** Human/policy revocation mid-transaction. */
  z
    .object({
      kind: z.literal("revoke"),
      reason: z.string().min(1).max(256),
      ...CommandBase,
    })
    .strict(),
  /** Non-recoverable internal failure. */
  z
    .object({
      kind: z.literal("fail"),
      reason: z.string().min(1).max(256),
      ...CommandBase,
    })
    .strict(),
  /**
   * One-time binding of the execution attempt: the attempt, the issued
   * capability, and the effect key that every retry must reuse.
   */
  z
    .object({
      kind: z.literal("bind-attempt"),
      attemptId: AttemptIdSchema,
      capabilityId: CapabilityIdSchema,
      idempotencyKey: Sha256DigestSchema,
      ...CommandBase,
    })
    .strict(),
  /** The provider confirmed the issued commit landed. */
  z
    .object({
      kind: z.literal("commit-confirmed"),
      binding: z.string().min(1).max(512).nullable(),
      ...CommandBase,
    })
    .strict(),
  /** A provider outcome arrived for an issued commit. */
  z
    .object({
      kind: z.literal("outcome"),
      outcome: z.enum([
        "verified",
        "unknown",
        "mismatch",
        "commit-rejected",
        "aborted",
      ]),
      binding: z.string().min(1).max(512).nullable(),
      ...CommandBase,
    })
    .strict(),
  /** A compensating action was authorized for this transaction. */
  z
    .object({
      kind: z.literal("compensate"),
      compensationTransactionId: TransactionIdSchema,
      ...CommandBase,
    })
    .strict(),
  /** The compensating action's own transaction verified. */
  z.object({ kind: z.literal("compensated"), ...CommandBase }).strict(),
]);
export type TransactionCommand = z.infer<typeof TransactionCommandSchema>;

/** A transaction command without its optimistic-concurrency version. */
export type TransactionCommandInput = {
  [K in TransactionCommand["kind"]]: Omit<
    Extract<TransactionCommand, { kind: K }>,
    "expectedVersion"
  >;
}[TransactionCommand["kind"]];

/* ------------------------------------------------------------------ */
/* Pure deterministic evaluator                                  */
/* ------------------------------------------------------------------ */

export type TransactionTransitionResult =
  | Readonly<{ ok: true; record: TransactionRecord }>
  | Readonly<{
      ok: false;
      reasonCode:
        | "MALFORMED_RECORD"
        | "MALFORMED_COMMAND"
        | "STALE_VERSION"
        | "TRANSACTION_EXPIRED"
        | "SKIPPED_STAGE"
        | "INVALID_TRANSITION";
    }>;

const POST_STATE: Record<TransactionStage, TransactionState> = {
  PROPOSE: "PROPOSED",
  PREPARE: "PREPARED",
  AUTHORIZE: "AUTHORIZED",
  LOCK: "LOCKED",
  COMMIT: "COMMITTING",
  VERIFY: "VERIFIED",
  SETTLE: "SETTLED",
};

/** The next declared stage not yet recorded, or null. */
export function nextDeclaredTransactionStage(
  record: TransactionRecord,
): TransactionStage | null {
  const recorded = new Set(record.recordedStages.map((s) => s.stage));
  for (const stage of record.declaration.stages) {
    if (!recorded.has(stage)) return stage;
  }
  return null;
}

/** How a revocation resolves from a given pre-revocation state. */
export function revocationResolutionForState(
  state: TransactionState,
): TransactionResolution {
  switch (state) {
    case "PROPOSED":
    case "PREPARED":
    case "AUTHORIZED":
    case "LOCKED":
      return "cancel";
    case "COMMITTING":
      return "hold";
    default:
      return "settle";
  }
}

/**
 * The state a `record-stage` command must find the record in. A stage
 * may only be recorded from the post-state of the previous declared
 * stage — VERIFY additionally requires a confirmed commit, and SETTLE a
 * recorded verification.
 */
function expectedPreState(
  record: TransactionRecord,
  stage: TransactionStage,
): TransactionState {
  if (stage === "PROPOSE") return "PROPOSED";
  const declared = record.declaration.stages;
  const index = declared.indexOf(stage);
  const previous = declared[index - 1]!;
  if (stage === "VERIFY" && declared.includes("COMMIT")) {
    return "COMMITTED";
  }
  if (stage === "SETTLE" && declared.includes("VERIFY")) {
    return "VERIFIED";
  }
  return POST_STATE[previous];
}

function invalid(
  reasonCode: Extract<TransactionTransitionResult, { ok: false }>["reasonCode"],
): TransactionTransitionResult {
  return { ok: false, reasonCode };
}

export function transitionTransaction(
  recordInput: unknown,
  commandInput: unknown,
  nowEpochMs: number,
): TransactionTransitionResult {
  const parsedRecord = TransactionRecordSchema.safeParse(recordInput);
  if (!parsedRecord.success) return invalid("MALFORMED_RECORD");
  const parsedCommand = TransactionCommandSchema.safeParse(commandInput);
  if (!parsedCommand.success) return invalid("MALFORMED_COMMAND");
  const record = parsedRecord.data;
  const command = parsedCommand.data;
  if (command.expectedVersion !== record.version) {
    return invalid("STALE_VERSION");
  }

  const terminal = isTerminalTransactionState(record.state);
  const expired =
    record.expiresAtEpochMs !== null &&
    nowEpochMs >= record.expiresAtEpochMs &&
    !terminal;

  const next = (
    patch: Partial<TransactionRecord>,
  ): TransactionTransitionResult => ({
    ok: true,
    record: TransactionRecordSchema.parse({
      ...record,
      ...patch,
      version: record.version + 1,
      updatedAtEpochMs: nowEpochMs,
    }),
  });
  const recordStage = (
    stage: TransactionStage,
    binding: string | null,
    atEpochMs: number,
    stateOverride?: TransactionState,
  ): TransactionTransitionResult =>
    next({
      recordedStages: [...record.recordedStages, { stage, atEpochMs, binding }],
      state: stateOverride ?? POST_STATE[stage],
      ...(stage === "SETTLE"
        ? { resolution: null, terminalReason: record.terminalReason }
        : {}),
    });
  const terminate = (
    state: TransactionState,
    reason: string,
  ): TransactionTransitionResult =>
    next({ state, resolution: null, terminalReason: reason });

  // Once the deadline passes, only lifecycle-closing commands may run —
  // a late stage/commit would silently skip the expiry.
  if (expired && command.kind !== "expire" && command.kind !== "fail") {
    return invalid("TRANSACTION_EXPIRED");
  }

  switch (command.kind) {
    case "record-stage": {
      if (terminal) return invalid("INVALID_TRANSITION");
      // A revoked transaction may continue VERIFY/SETTLE only when its
      // resolution requires settling a possibly-landed effect.
      if (
        record.state === "REVOKED" &&
        !(
          record.resolution === "settle" &&
          (command.stage === "VERIFY" || command.stage === "SETTLE")
        )
      ) {
        return invalid("INVALID_TRANSITION");
      }
      const expected = nextDeclaredTransactionStage(record);
      if (expected === null || command.stage !== expected) {
        return invalid("SKIPPED_STAGE");
      }
      const preState = expectedPreState(record, command.stage);
      if (record.state !== preState) {
        return invalid("INVALID_TRANSITION");
      }
      return recordStage(
        command.stage,
        command.binding,
        nowEpochMs,
        command.stage === "COMMIT" ? "COMMITTING" : undefined,
      );
    }
    case "deny": {
      if (record.state !== "PROPOSED" && record.state !== "PREPARED") {
        return invalid("INVALID_TRANSITION");
      }
      return terminate("DENIED", command.reason);
    }
    case "cancel": {
      switch (record.state) {
        case "PROPOSED":
        case "PREPARED":
        case "AUTHORIZED":
        case "LOCKED":
        case "COMMITTING":
        case "UNKNOWN":
          return terminate("CANCELLED", command.reason);
        case "REVOKED":
          return record.resolution === "settle"
            ? invalid("INVALID_TRANSITION")
            : terminate("CANCELLED", command.reason);
        default:
          return invalid("INVALID_TRANSITION");
      }
    }
    case "expire": {
      if (terminal) return invalid("INVALID_TRANSITION");
      return terminate("EXPIRED", command.reason);
    }
    case "fail": {
      if (terminal) return invalid("INVALID_TRANSITION");
      return terminate("FAILED", command.reason);
    }
    case "revoke": {
      if (terminal || record.state === "REVOKED") {
        return invalid("INVALID_TRANSITION");
      }
      return next({
        state: "REVOKED",
        resolution: revocationResolutionForState(record.state),
        terminalReason: command.reason,
      });
    }
    case "bind-attempt": {
      if (terminal) return invalid("INVALID_TRANSITION");
      if (record.attemptId !== null) {
        // Idempotent rebind only when every value matches — a different
        // attempt or key would be a silent second effect.
        if (
          record.attemptId === command.attemptId &&
          record.capabilityId === command.capabilityId &&
          record.idempotencyKey === command.idempotencyKey
        ) {
          return { ok: true, record };
        }
        return invalid("INVALID_TRANSITION");
      }
      return next({
        attemptId: command.attemptId,
        capabilityId: command.capabilityId,
        idempotencyKey: command.idempotencyKey,
      });
    }
    case "commit-confirmed": {
      if (record.state === "COMMITTING") {
        return next({ state: "COMMITTED", resolution: null });
      }
      if (record.state === "REVOKED") {
        // The commit had already been issued when the revocation landed;
        // the effect must now settle — cancellation is no longer safe.
        return next({ state: "COMMITTED", resolution: "settle" });
      }
      return invalid("INVALID_TRANSITION");
    }
    case "outcome": {
      switch (command.outcome) {
        case "verified":
          if (
            record.state === "COMMITTING" ||
            record.state === "COMMITTED" ||
            record.state === "REVOKED" ||
            record.state === "UNKNOWN"
          ) {
            return next({ state: "COMMITTED", resolution: record.resolution });
          }
          return invalid("INVALID_TRANSITION");
        case "unknown":
          if (
            record.state === "COMMITTING" ||
            record.state === "COMMITTED" ||
            record.state === "REVOKED"
          ) {
            return next({ state: "UNKNOWN" });
          }
          return invalid("INVALID_TRANSITION");
        case "mismatch":
          if (
            record.state === "COMMITTING" ||
            record.state === "COMMITTED" ||
            record.state === "VERIFIED" ||
            record.state === "REVOKED" ||
            record.state === "UNKNOWN"
          ) {
            return next({ state: "MISMATCH" });
          }
          return invalid("INVALID_TRANSITION");
        case "commit-rejected":
          if (
            record.state === "COMMITTING" ||
            record.state === "LOCKED" ||
            record.state === "REVOKED"
          ) {
            return terminate("FAILED", "commit-rejected");
          }
          return invalid("INVALID_TRANSITION");
        case "aborted":
          if (record.state === "COMMITTING") {
            // Commit was issued then aborted — effect state unconfirmed.
            return next({ state: "UNKNOWN" });
          }
          if (terminal || record.state === "SETTLED") {
            return invalid("INVALID_TRANSITION");
          }
          return terminate("CANCELLED", "aborted");
        default:
          return invalid("MALFORMED_COMMAND");
      }
    }
    case "compensate": {
      switch (record.state) {
        // Only a landed (or possibly-landed) effect may be compensated;
        // pre-commit states cancel instead.
        case "COMMITTED":
        case "VERIFIED":
        case "SETTLED":
        case "MISMATCH":
        case "UNKNOWN":
        case "FAILED":
          break;
        case "REVOKED":
          if (record.resolution !== "settle") {
            return invalid("INVALID_TRANSITION");
          }
          break;
        default:
          return invalid("INVALID_TRANSITION");
      }
      if (record.compensationBy !== null) {
        return invalid("INVALID_TRANSITION");
      }
      return next({
        state: "COMPENSATING",
        resolution: null,
        compensationBy: command.compensationTransactionId,
      });
    }
    case "compensated": {
      if (record.state !== "COMPENSATING") {
        return invalid("INVALID_TRANSITION");
      }
      return terminate("COMPENSATED", record.terminalReason ?? "compensated");
    }
    default:
      return invalid("MALFORMED_COMMAND");
  }
}

/* ------------------------------------------------------------------ */
/* Construction helpers                                                */
/* ------------------------------------------------------------------ */

/**
 * Create a transaction record in PROPOSED with PROPOSE already recorded
 * and bound to the canonical action digest.
 */
export function proposeTransaction(input: {
  tenantId: string;
  principalId: string;
  agentId: string;
  requestId: string;
  correlationId: string;
  action: string;
  actionDigest: string;
  declaration: TransactionDeclaration;
  compensationOf?: string;
  atEpochMs: number;
}): TransactionRecord {
  const declaration = TransactionDeclarationSchema.parse(input.declaration);
  return TransactionRecordSchema.parse({
    schemaVersion: 1,
    schema: TRANSACTION_CONTRACT_SCHEMA,
    transactionId: transactionIdForRequest(input.requestId),
    tenantId: input.tenantId,
    principalId: input.principalId,
    agentId: input.agentId,
    requestId: input.requestId,
    correlationId: input.correlationId,
    action: input.action,
    actionDigest: input.actionDigest,
    declaration,
    declarationDigest: transactionDeclarationDigest(declaration),
    recordedStages: [
      {
        stage: "PROPOSE",
        atEpochMs: input.atEpochMs,
        binding: input.actionDigest,
      },
    ],
    state: "PROPOSED",
    resolution: null,
    attemptId: null,
    capabilityId: null,
    idempotencyKey: null,
    compensationOf: input.compensationOf ?? null,
    compensationBy: null,
    terminalReason: null,
    expiresAtEpochMs:
      declaration.deadlineMs === undefined
        ? null
        : input.atEpochMs + declaration.deadlineMs,
    version: 1,
    createdAtEpochMs: input.atEpochMs,
    updatedAtEpochMs: input.atEpochMs,
  });
}

/**
 * The injected port the gateway and execution paths record through.
 * Implementations persist TransactionRecord rows plus a stage-transition
 * audit; the pure evaluator above is the only writer of state. Every
 * method returns null on failure — callers fail closed.
 */
export interface TransactionTracker {
  /**
   * Idempotent create keyed on the request-derived transaction id:
   * returns the record (creating it PROPOSED when absent), the existing
   * record when the same action digest is replayed, and null when a
   * record for the id exists with a different digest or the store
   * fails.
   */
  propose(input: {
    tenantId: string;
    principalId: string;
    agentId: string;
    requestId: string;
    correlationId: string;
    action: string;
    actionDigest: string;
    declaration: TransactionDeclaration;
    compensationOf?: string;
    atEpochMs: number;
  }): Promise<TransactionRecord | null>;

  /** Apply one command through the evaluator with CAS semantics. */
  transition(input: {
    tenantId: string;
    transactionId: string;
    command: TransactionCommand;
    atEpochMs: number;
  }): Promise<TransactionRecord | null>;

  get(input: {
    tenantId: string;
    transactionId: string;
  }): Promise<TransactionRecord | null>;
}
