// Generated file — do not edit.
import {
  canonicalSha256,
  EvidenceChainContextSchema,
  EvidenceEventDraftSchema,
  EvidenceRecordCoreSchema,
  EvidenceRecordSchema,
  type EvidenceEvent,
  type EvidenceEventDraft,
  type EvidenceChainContext,
  type EvidenceRecord,
  type EvidenceRecordCore,
} from "../contracts/index.js";

export type AppendEvidenceFailure =
  | "MALFORMED_CHAIN"
  | "MALFORMED_DRAFT"
  | "CHAIN_INVALID"
  | "DUPLICATE_EVIDENCE_ID"
  | "APPEND_CONTEXT_MISMATCH"
  | "NON_MONOTONIC_EVENT_TIME"
  | "CHAIN_LIMIT_EXCEEDED";

export type AppendEvidenceResult =
  | { ok: true; record: EvidenceRecord; chain: EvidenceRecord[] }
  | { ok: false; reasonCode: AppendEvidenceFailure };

export type EvidenceVerificationFailure =
  | "MALFORMED_CHAIN"
  | "INVALID_GENESIS"
  | "DUPLICATE_EVIDENCE_ID"
  | "DUPLICATE_SEQUENCE"
  | "SEQUENCE_GAP"
  | "RECORD_REORDERED"
  | "CONTEXT_MISMATCH"
  | "ACTION_DIGEST_MISMATCH"
  | "INVALID_EVENT_ORDER"
  | "PAYLOAD_DIGEST_MISMATCH"
  | "BROKEN_LINK"
  | "NON_MONOTONIC_EVENT_TIME"
  | "RECORD_HASH_MISMATCH";

export type EvidenceVerificationResult =
  | {
      valid: true;
      count: number;
      lastRecordHash: string | null;
      context: EvidenceChainContext | null;
    }
  | {
      valid: false;
      reasonCode: EvidenceVerificationFailure;
      recordIndex: number | null;
    };

const contextKeys = [
  "tenantId",
  "principalId",
  "agentId",
  "requestId",
  "correlationId",
] as const satisfies readonly (keyof EvidenceEventDraft)[];

function sameContext(
  left: Pick<EvidenceEventDraft, (typeof contextKeys)[number]>,
  right: Pick<EvidenceEventDraft, (typeof contextKeys)[number]>,
): boolean {
  return contextKeys.every((key) => left[key] === right[key]);
}

export function hashEvidencePayload(event: EvidenceEvent): string {
  return canonicalSha256({
    domain: "odingard.guardian.evidence.payload.v1",
    event,
  });
}

export function hashEvidenceRecordCore(core: EvidenceRecordCore): string {
  return canonicalSha256({
    domain: "odingard.guardian.evidence.record.v1",
    record: core,
  });
}

function invalid(
  reasonCode: EvidenceVerificationFailure,
  recordIndex: number | null,
): EvidenceVerificationResult {
  return { valid: false, reasonCode, recordIndex };
}

/** Approval lifecycle edges the evidence chain may describe, mirroring the approval state machine. */
const APPROVAL_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  pending: ["approved", "denied", "revoked", "expired", "superseded"],
  approved: ["denied", "revoked", "expired", "superseded", "consumed"],
};

/** States that only an evidenced human decision for the same version can produce. */
const HUMAN_DECISION_FOR_STATE: Readonly<Record<string, string>> = {
  approved: "approve",
  denied: "deny",
  revoked: "revoke",
};

/** States from which each human decision may be recorded. */
const DECISION_FROM_STATES: Readonly<Record<string, readonly string[]>> = {
  approve: ["pending"],
  deny: ["pending", "approved"],
  revoke: ["pending", "approved"],
};

/**
 * Tracks one chain's approval evidence. Approval evidence is delivered at least
 * once, so an identical repeat of the latest version is accepted, but a stale,
 * skipped, conflicting, or out-of-lifecycle version is never accepted.
 */
function createApprovalEvidenceTracker() {
  let approvalId: string | null = null;
  let state: string | null = null;
  let version = 0;
  const stateDigests = new Map<number, string>();
  const decisions = new Map<number, { decision: string; digest: string }>();

  return {
    get state() {
      return state;
    },
    /** True only when the latest state is approved by a human decision for that exact version. */
    humanApprovedCurrentVersion(): boolean {
      return (
        state === "approved" && decisions.get(version)?.decision === "approve"
      );
    },
    accept(event: EvidenceEvent): boolean {
      if (
        event.eventType !== "APPROVAL_STATE_REFERENCED" &&
        event.eventType !== "APPROVAL_DECISION_RECORDED" &&
        event.eventType !== "APPROVAL_PRESENTED" &&
        event.eventType !== "APPROVAL_REJECTED"
      ) {
        return true;
      }
      if (approvalId !== null && event.payload.approvalId !== approvalId) {
        return false;
      }
      approvalId = event.payload.approvalId;
      if (event.eventType === "APPROVAL_PRESENTED") return version >= 1;
      if (event.eventType === "APPROVAL_REJECTED") return true;
      const digest = hashEvidencePayload(event);
      if (event.eventType === "APPROVAL_DECISION_RECORDED") {
        const existing = decisions.get(event.payload.version);
        if (existing) {
          return (
            existing.digest === digest &&
            (event.payload.version === version ||
              event.payload.version === version + 1)
          );
        }
        if (
          version < 1 ||
          event.payload.version !== version + 1 ||
          state === null ||
          !(
            DECISION_FROM_STATES[event.payload.decision]?.includes(state) ??
            false
          )
        ) {
          return false;
        }
        decisions.set(event.payload.version, {
          decision: event.payload.decision,
          digest,
        });
        return true;
      }
      const existing = stateDigests.get(event.payload.version);
      if (existing) {
        return existing === digest && event.payload.version === version;
      }
      if (event.payload.version !== version + 1) return false;
      const lifecycleValid =
        state === null
          ? event.payload.state === "pending"
          : (APPROVAL_TRANSITIONS[state]?.includes(event.payload.state) ??
            false);
      const requiredDecision = HUMAN_DECISION_FOR_STATE[event.payload.state];
      const recordedDecision = decisions.get(event.payload.version)?.decision;
      if (
        !lifecycleValid ||
        (requiredDecision === undefined
          ? recordedDecision !== undefined
          : recordedDecision !== requiredDecision)
      ) {
        return false;
      }
      stateDigests.set(event.payload.version, digest);
      version = event.payload.version;
      state = event.payload.state;
      return true;
    },
  };
}

export function verifyEvidenceChain(
  chainInput: unknown,
  expectedContextInput?: unknown,
): EvidenceVerificationResult {
  try {
    const parsed = EvidenceRecordSchema.array()
      .max(10_000)
      .safeParse(chainInput);
    if (!parsed.success) return invalid("MALFORMED_CHAIN", null);
    const expectedContext =
      expectedContextInput === undefined
        ? null
        : EvidenceChainContextSchema.safeParse(expectedContextInput);
    if (expectedContext !== null && !expectedContext.success) {
      return invalid("MALFORMED_CHAIN", null);
    }
    const chain = parsed.data;
    if (chain.length === 0) {
      return { valid: true, count: 0, lastRecordHash: null, context: null };
    }

    const first = chain[0];
    if (!first || first.sequence !== 1 || first.previousRecordHash !== null) {
      return invalid("INVALID_GENESIS", 0);
    }
    if (expectedContext && !sameContext(first, expectedContext.data)) {
      return invalid("CONTEXT_MISMATCH", 0);
    }
    const ids = chain.map((record) => record.id);
    if (new Set(ids).size !== ids.length) {
      return invalid("DUPLICATE_EVIDENCE_ID", null);
    }
    const sequences = chain.map((record) => record.sequence);
    if (new Set(sequences).size !== sequences.length) {
      return invalid("DUPLICATE_SEQUENCE", null);
    }
    const sortedSequences = [...sequences].sort((left, right) => left - right);
    if (sortedSequences.some((sequence, index) => sequence !== index + 1)) {
      return invalid("SEQUENCE_GAP", null);
    }

    let boundActionDigest: string | null = null;
    let recordedDecision: "ALLOW" | "ASK" | "DENY" | null = null;
    let lastDecisionIndex = -1;
    const approval = createApprovalEvidenceTracker();
    const issuedCapabilities = new Set<string>();
    const authenticatedAdapters = new Set<string>();
    let capabilityUsed = false;
    let executionStart: "attempted" | "aborted" | null = null;
    let executionKey: string | null = null;
    let prepared = false;
    let preparedIndex = -1;
    let commitAuthorized = false;
    let outcomeUnknown = false;
    let unresolved = false;
    let terminal = false;

    const executionEventTypes = new Set([
      "EXECUTION_ATTEMPTED",
      "EXECUTION_ABORTED",
      "EFFECT_PREPARED",
      "EFFECT_COMMIT_AUTHORIZED",
      "EFFECT_OUTCOME_UNKNOWN",
      "EFFECT_UNRESOLVED",
      "EFFECT_VERIFIED",
      "EXECUTION_FAILED",
    ]);
    const preCommitFailureCodes = new Set([
      "SENDER_ACCOUNT_MISMATCH",
      "CREDENTIAL_UNAVAILABLE",
      "PREPARE_REJECTED",
      "PREPARE_AMBIGUOUS",
      "READBACK_UNAVAILABLE",
      "PREPARED_CONTENT_MISMATCH",
      "COMMIT_NOT_AUTHORIZED",
      "AUTHORITY_REVOKED_BEFORE_COMMIT",
      "COMMIT_DEADLINE_EXPIRED",
    ]);

    for (const [index, record] of chain.entries()) {
      if (record.sequence !== index + 1) {
        return invalid("RECORD_REORDERED", index);
      }
      if (!sameContext(first, record)) {
        return invalid("CONTEXT_MISMATCH", index);
      }
      if (
        index > 0 &&
        record.eventTimeEpochMs < (chain[index - 1]?.eventTimeEpochMs ?? 0)
      ) {
        return invalid("NON_MONOTONIC_EVENT_TIME", index);
      }
      if (hashEvidencePayload(record.event) !== record.payloadDigest) {
        return invalid("PAYLOAD_DIGEST_MISMATCH", index);
      }
      if ("actionDigest" in record.event.payload) {
        if (boundActionDigest === null) {
          boundActionDigest = record.event.payload.actionDigest;
        } else if (record.event.payload.actionDigest !== boundActionDigest) {
          return invalid("ACTION_DIGEST_MISMATCH", index);
        }
      }
      if (record.event.eventType === "DECISION_RECORDED") {
        recordedDecision = record.event.payload.decision;
        lastDecisionIndex = index;
      }
      if (!approval.accept(record.event)) {
        return invalid("INVALID_EVENT_ORDER", index);
      }
      const approvalState = approval.state;
      const approvalSatisfied =
        approvalState === "approved" || approvalState === "consumed";
      if (record.event.eventType === "CAPABILITY_STATE_REFERENCED") {
        const { capabilityId, state } = record.event.payload;
        if (state === "issued") {
          const humanApproved =
            recordedDecision === "ASK" &&
            approval.humanApprovedCurrentVersion();
          if (recordedDecision !== "ALLOW" && !humanApproved) {
            return invalid("INVALID_EVENT_ORDER", index);
          }
          issuedCapabilities.add(capabilityId);
        } else if (!issuedCapabilities.has(capabilityId)) {
          return invalid("INVALID_EVENT_ORDER", index);
        } else if (
          state === "used" &&
          recordedDecision === "ASK" &&
          approvalState !== "consumed"
        ) {
          return invalid("INVALID_EVENT_ORDER", index);
        } else if (state === "used") {
          capabilityUsed = true;
        }
      }

      if (record.event.eventType === "ADAPTER_AUTHENTICATION_RECORDED") {
        if (issuedCapabilities.size === 0) {
          return invalid("INVALID_EVENT_ORDER", index);
        }
        authenticatedAdapters.add(record.event.payload.adapterId);
      }

      if (
        executionEventTypes.has(record.event.eventType) &&
        (executionStart === "aborted" || terminal)
      ) {
        return invalid("INVALID_EVENT_ORDER", index);
      }

      if (
        record.event.eventType === "EXECUTION_ATTEMPTED" ||
        record.event.eventType === "EXECUTION_ABORTED"
      ) {
        if (
          executionStart !== null ||
          !capabilityUsed ||
          !authenticatedAdapters.has(record.event.payload.adapterId) ||
          recordedDecision === null ||
          recordedDecision === "DENY" ||
          (recordedDecision === "ASK" && !approvalSatisfied)
        ) {
          return invalid("INVALID_EVENT_ORDER", index);
        }
        executionKey = `${record.event.payload.adapterId}:${record.event.payload.attemptReference}`;
        executionStart =
          record.event.eventType === "EXECUTION_ATTEMPTED"
            ? "attempted"
            : "aborted";
      }

      if (
        executionEventTypes.has(record.event.eventType) &&
        record.event.eventType !== "EXECUTION_ATTEMPTED" &&
        record.event.eventType !== "EXECUTION_ABORTED"
      ) {
        if (
          !("adapterId" in record.event.payload) ||
          !("attemptReference" in record.event.payload)
        ) {
          return invalid("INVALID_EVENT_ORDER", index);
        }
        const attempt = `${record.event.payload.adapterId}:${record.event.payload.attemptReference}`;
        if (executionStart !== "attempted" || attempt !== executionKey) {
          return invalid("INVALID_EVENT_ORDER", index);
        }
      }

      if (record.event.eventType === "EFFECT_PREPARED") {
        if (prepared) return invalid("INVALID_EVENT_ORDER", index);
        prepared = true;
        preparedIndex = index;
      }

      if (record.event.eventType === "EFFECT_COMMIT_AUTHORIZED") {
        const decisionAllowsCommit =
          recordedDecision === "ALLOW" ||
          (recordedDecision === "ASK" && approvalState === "consumed");
        if (
          commitAuthorized ||
          !prepared ||
          lastDecisionIndex <= preparedIndex ||
          !decisionAllowsCommit
        ) {
          return invalid("INVALID_EVENT_ORDER", index);
        }
        commitAuthorized = true;
      }

      if (record.event.eventType === "EFFECT_OUTCOME_UNKNOWN") {
        if (!commitAuthorized || outcomeUnknown || unresolved) {
          return invalid("INVALID_EVENT_ORDER", index);
        }
        outcomeUnknown = true;
      }

      if (record.event.eventType === "EFFECT_UNRESOLVED") {
        if (!commitAuthorized || unresolved) {
          return invalid("INVALID_EVENT_ORDER", index);
        }
        unresolved = true;
      }

      if (record.event.eventType === "EFFECT_VERIFIED") {
        if (!commitAuthorized) return invalid("INVALID_EVENT_ORDER", index);
        terminal = true;
      }

      if (record.event.eventType === "EXECUTION_FAILED") {
        const code = record.event.payload.failureCode;
        if (
          (outcomeUnknown || unresolved) &&
          code !== "EFFECT_MISMATCH" &&
          code !== "DUPLICATE_EFFECT_DETECTED"
        ) {
          return invalid("INVALID_EVENT_ORDER", index);
        }
        if (
          (code === "COMMIT_REJECTED" || code === "COMMIT_NOT_ISSUED") &&
          (!commitAuthorized || outcomeUnknown || unresolved)
        ) {
          return invalid("INVALID_EVENT_ORDER", index);
        }
        if (commitAuthorized && preCommitFailureCodes.has(code)) {
          return invalid("INVALID_EVENT_ORDER", index);
        }
        terminal = true;
      }
      const expectedPreviousHash =
        index === 0 ? null : chain[index - 1]?.recordHash;
      if (record.previousRecordHash !== expectedPreviousHash) {
        return invalid("BROKEN_LINK", index);
      }
      const core = EvidenceRecordCoreSchema.strip().parse(record);
      if (hashEvidenceRecordCore(core) !== record.recordHash) {
        return invalid("RECORD_HASH_MISMATCH", index);
      }
    }

    return {
      valid: true,
      count: chain.length,
      lastRecordHash: chain.at(-1)?.recordHash ?? null,
      context: {
        tenantId: first.tenantId,
        principalId: first.principalId,
        agentId: first.agentId,
        requestId: first.requestId,
        correlationId: first.correlationId,
      },
    };
  } catch {
    return invalid("MALFORMED_CHAIN", null);
  }
}

export function appendEvidenceRecord(
  chainInput: unknown,
  draftInput: unknown,
): AppendEvidenceResult {
  try {
    if (Array.isArray(chainInput) && chainInput.length >= 10_000) {
      return { ok: false, reasonCode: "CHAIN_LIMIT_EXCEEDED" };
    }
    const chain = EvidenceRecordSchema.array()
      .max(10_000)
      .safeParse(chainInput);
    if (!chain.success) return { ok: false, reasonCode: "MALFORMED_CHAIN" };
    const verified = verifyEvidenceChain(chain.data);
    if (!verified.valid) return { ok: false, reasonCode: "CHAIN_INVALID" };

    const draft = EvidenceEventDraftSchema.safeParse(draftInput);
    if (!draft.success) return { ok: false, reasonCode: "MALFORMED_DRAFT" };
    if (chain.data.some((record) => record.id === draft.data.id)) {
      return { ok: false, reasonCode: "DUPLICATE_EVIDENCE_ID" };
    }
    const first = chain.data[0];
    if (first && !sameContext(first, draft.data)) {
      return { ok: false, reasonCode: "APPEND_CONTEXT_MISMATCH" };
    }

    const previous = chain.data.at(-1);
    if (previous && draft.data.eventTimeEpochMs < previous.eventTimeEpochMs) {
      return { ok: false, reasonCode: "NON_MONOTONIC_EVENT_TIME" };
    }
    const core = EvidenceRecordCoreSchema.parse({
      ...draft.data,
      sequence: (previous?.sequence ?? 0) + 1,
      previousRecordHash: previous?.recordHash ?? null,
      payloadDigest: hashEvidencePayload(draft.data.event),
    });
    const record = EvidenceRecordSchema.parse({
      ...core,
      recordHash: hashEvidenceRecordCore(core),
    });
    const nextChain = [...chain.data, record];
    if (!verifyEvidenceChain(nextChain).valid) {
      return { ok: false, reasonCode: "CHAIN_INVALID" };
    }
    return { ok: true, record, chain: nextChain };
  } catch {
    return { ok: false, reasonCode: "MALFORMED_DRAFT" };
  }
}
