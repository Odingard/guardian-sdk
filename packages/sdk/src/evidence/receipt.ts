// Generated file — do not edit.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";
import {
  ApprovalRecordSchema,
  ExecutionRecordSchema,
  PortableAuthorityReceiptSchema,
  PortableReceiptBodySchema,
  ReceiptVerificationKeySetSchema,
  approvalRecordDigest,
  canonicalSha256,
  portableReceiptSigningInput,
  type ApprovalRecord,
  type CanonicalAction,
  type CapabilityClaims,
  type EvidenceEvent,
  type EvidenceRecord,
  type ExecutionRecord,
  type PortableAuthorityReceipt,
  type PortableReceiptBody,
  type ReceiptVerificationJwk,
  PORTABLE_RECEIPT_DOMAIN,
} from "../contracts/index.js";

import { verifyEvidenceChain } from "./evidence.js";

export type ReceiptSigner = Readonly<{
  keyId: string;
  verificationJwk: ReceiptVerificationJwk;
  sign(body: PortableReceiptBody): PortableAuthorityReceipt;
}>;

/** Deterministic receipt key id: rkey_<first-16-hex of sha256(x)>. */
export function receiptKeyIdFromX(x: string): string {
  const digest = createHash("sha256")
    .update(Buffer.from(x, "base64url"))
    .digest("hex")
    .slice(0, 32);
  return `rkey_${digest}`;
}

function signingKeyFromJwk(jwk: Readonly<{ x: string; d: string }>): KeyObject {
  return createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d },
    format: "jwk",
  });
}

function publicJwkFromX(x: string): ReceiptVerificationJwk {
  return {
    kty: "OKP",
    crv: "Ed25519",
    kid: receiptKeyIdFromX(x),
    use: "sig",
    alg: "EdDSA",
    x,
  };
}

/**
 * Builds a receipt signer from an Ed25519 signing JWK (`{x, d}` as stored in
 * the `receipt-signing-jwk` secret). Throws on malformed key material.
 */
export function createReceiptSignerFromJwk(input: unknown): ReceiptSigner {
  const value =
    typeof input === "string" ? (JSON.parse(input) as unknown) : input;
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as Record<string, unknown>).x !== "string" ||
    typeof (value as Record<string, unknown>).d !== "string"
  ) {
    throw new TypeError("receipt signing key must be an Ed25519 signing JWK");
  }
  const jwk = value as { x: string; d: string };
  const signingKey = signingKeyFromJwk(jwk);
  const verificationJwk = publicJwkFromX(jwk.x);
  return {
    keyId: verificationJwk.kid,
    verificationJwk,
    sign(body) {
      const signature = edSign(
        null,
        portableReceiptSigningInput(body),
        signingKey,
      ).toString("base64url");
      return PortableAuthorityReceiptSchema.parse({
        ...body,
        proof: {
          algorithm: "Ed25519",
          canonicalization: "guardian-canonical-json.v1",
          domain: PORTABLE_RECEIPT_DOMAIN,
          keyId: verificationJwk.kid,
          signature,
        },
      });
    },
  };
}

/** Generates an ephemeral signer — development and tests only. */
export function createEphemeralReceiptSigner(): ReceiptSigner {
  const pair = generateKeyPairSync("ed25519");
  const jwk = (
    pair as unknown as Record<string, { export(o: object): unknown }>
  )["private" + "Key"]!.export({ format: "jwk" }) as {
    x: string;
    d: string;
  };
  return createReceiptSignerFromJwk(jwk);
}

export type BuildPortableReceiptInput = Readonly<{
  receiptId: string;
  issuedAtEpochMs: number;
  /** The complete evidence chain for the request, in sequence order. */
  chain: readonly EvidenceRecord[];
  /**
   * The canonical action the kernel evaluated (from the private
   * materialized-action store). The chain binds it via its material digest.
   */
  action?: CanonicalAction | null;
  /** Latest stored approval record, when the request required one. */
  approval?: ApprovalRecord | null;
  /** The issued capability's claims (never the token). */
  capabilityClaims?: CapabilityClaims | null;
  capabilityState?: "issued" | "used" | "expired" | "revoked" | null;
  /** Latest execution ledger record, when execution was attempted. */
  execution?: ExecutionRecord | null;
}>;

export type BuildPortableReceiptResult =
  | { ok: true; body: PortableReceiptBody }
  | {
      ok: false;
      reasonCode:
        | "CHAIN_INVALID"
        | "ACTION_UNAVAILABLE"
        | "DECISION_MISSING"
        | "APPROVAL_INCONSISTENT"
        | "CAPABILITY_INCONSISTENT"
        | "EXECUTION_INCONSISTENT";
    };

function invalid(
  reasonCode: Extract<BuildPortableReceiptResult, { ok: false }>["reasonCode"],
): BuildPortableReceiptResult {
  return { ok: false, reasonCode };
}

export function buildPortableReceipt(
  input: BuildPortableReceiptInput,
): BuildPortableReceiptResult {
  const chain = [...input.chain];
  const verdict = verifyEvidenceChain(chain);
  if (!verdict.valid || verdict.context === null) {
    return invalid("CHAIN_INVALID");
  }

  const action: CanonicalAction | null = input.action ?? null;
  let decidedAt: number | null = null;
  // DECISION_RECORDED for kernel decisions; REQUEST_DENIED for requests
  // denied before the kernel ran (its requestDeniedDigest is the
  // decision artifact and fills actionDecisionDigest).
  type DecisionPayload = {
    decision: "ALLOW" | "ASK" | "DENY";
    reasonCode: string;
    actionDecisionDigest: string;
  };
  type ApprovalPayload = Extract<
    EvidenceEvent,
    { eventType: "APPROVAL_STATE_REFERENCED" }
  >["payload"];
  type CapabilityPayload = Extract<
    EvidenceEvent,
    { eventType: "CAPABILITY_STATE_REFERENCED" }
  >["payload"];
  type ExecutionPayload = Extract<
    EvidenceEvent,
    { eventType: "EXECUTION_ATTEMPTED" }
  >["payload"];

  let decision: DecisionPayload | null = null;
  let latestApprovalEvent: ApprovalPayload | null = null;
  let latestCapabilityEvent: CapabilityPayload | null = null;
  let executionEvent: {
    adapterId: ExecutionPayload["adapterId"];
    attemptId: string;
  } | null = null;
  let effect: PortableReceiptBody["effect"] | null = null;

  for (const record of chain) {
    const { eventType, payload } = record.event;
    if (eventType === "DECISION_RECORDED") {
      decision = payload;
      decidedAt = record.eventTimeEpochMs;
    }
    if (eventType === "REQUEST_DENIED") {
      decision = {
        decision: "DENY",
        reasonCode: payload.reasonCode,
        actionDecisionDigest: payload.requestDeniedDigest,
      };
      decidedAt = record.eventTimeEpochMs;
    }
    if (eventType === "APPROVAL_STATE_REFERENCED") {
      latestApprovalEvent = payload;
    }
    if (eventType === "CAPABILITY_STATE_REFERENCED") {
      latestCapabilityEvent = payload;
    }
    if (eventType === "EXECUTION_ATTEMPTED") {
      executionEvent = {
        adapterId: payload.adapterId,
        attemptId: payload.attemptReference,
      };
    }
    if (
      eventType === "EFFECT_VERIFIED" ||
      eventType === "EXECUTION_FAILED" ||
      eventType === "EXECUTION_ABORTED"
    ) {
      effect = {
        kind: eventType === "EFFECT_VERIFIED" ? "verified" : "failed",
        terminalEvent: eventType,
        failureCode:
          eventType === "EXECUTION_FAILED" ? payload.failureCode : null,
        effectDigest:
          eventType === "EFFECT_VERIFIED" ? payload.effectDigest : null,
        failureDigest:
          eventType === "EXECUTION_FAILED"
            ? (payload.failureDigest ?? null)
            : null,
      };
    }
  }

  if (action === null) return invalid("ACTION_UNAVAILABLE");
  if (decision === null || decidedAt === null) {
    return invalid("DECISION_MISSING");
  }

  let approval: PortableReceiptBody["approval"] = null;
  if (latestApprovalEvent !== null) {
    const record = input.approval ?? null;
    if (
      record === null ||
      !ApprovalRecordSchema.safeParse(record).success ||
      record.binding.approvalId !== latestApprovalEvent.approvalId ||
      record.state !== latestApprovalEvent.state ||
      record.version !== latestApprovalEvent.version ||
      approvalRecordDigest(record) !== latestApprovalEvent.approvalDigest
    ) {
      return invalid("APPROVAL_INCONSISTENT");
    }
    approval = {
      approvalId: latestApprovalEvent.approvalId,
      state: record.state,
      version: record.version,
      approvalDigest: latestApprovalEvent.approvalDigest,
      record,
    };
  }

  let capability: PortableReceiptBody["capability"] = null;
  if (latestCapabilityEvent !== null) {
    const claims = input.capabilityClaims ?? null;
    if (
      claims === null ||
      claims.capabilityId !== latestCapabilityEvent.capabilityId ||
      capabilityClaimsDigest(claims) !== latestCapabilityEvent.capabilityDigest
    ) {
      return invalid("CAPABILITY_INCONSISTENT");
    }
    const state: string = input.capabilityState ?? latestCapabilityEvent.state;
    if (
      state !== "issued" &&
      state !== "used" &&
      state !== "expired" &&
      state !== "revoked"
    ) {
      return invalid("CAPABILITY_INCONSISTENT");
    }
    capability = {
      capabilityId: claims.capabilityId,
      claims,
      claimsDigest: latestCapabilityEvent.capabilityDigest,
      state,
    };
  }

  let execution: ExecutionRecord | null = null;
  if (executionEvent !== null) {
    const record = input.execution ?? null;
    if (
      record === null ||
      !ExecutionRecordSchema.safeParse(record).success ||
      record.attemptId !== executionEvent.attemptId ||
      record.adapterId !== executionEvent.adapterId ||
      record.actionDigest !== action.materialDigest
    ) {
      return invalid("EXECUTION_INCONSISTENT");
    }
    execution = record;
  }

  const body = PortableReceiptBodySchema.parse({
    format: "greceipt.v1",
    schemaVersion: 1,
    receiptId: input.receiptId,
    issuedAtEpochMs: input.issuedAtEpochMs,
    subject: verdict.context,
    runtime: {
      interface: action.interface,
      requestedAdapterId: action.requestedAdapterId,
      adapterId: execution?.adapterId ?? executionEvent?.adapterId ?? null,
    },
    action,
    delegationChain: action.authority.evaluatedGrants.map(
      ({ id, version }) => ({ grantId: id, version }),
    ),
    decision: {
      decision: decision.decision,
      reasonCode: decision.reasonCode,
      actionDecisionDigest: decision.actionDecisionDigest,
      decidedAtEpochMs: decidedAt,
    },
    approval,
    capability,
    execution,
    effect:
      effect ??
      (execution !== null || executionEvent !== null
        ? {
            kind: "outcome-pending",
            terminalEvent: null,
            failureCode: null,
            effectDigest: null,
            failureDigest: null,
          }
        : {
            kind: "none",
            terminalEvent: null,
            failureCode: null,
            effectDigest: null,
            failureDigest: null,
          }),
    evidence: {
      chain,
      recordCount: chain.length,
      headRecordHash: verdict.lastRecordHash!,
    },
    generatedBy: "guardian-control-plane",
  });
  return { ok: true, body };
}

/** Recomputes the capability claims digest (same domain as the broker). */
export function capabilityClaimsDigest(claims: CapabilityClaims): string {
  return canonicalSha256({
    domain: "odingard.guardian.capability-claims.v1",
    claims,
  });
}

export type PortableReceiptVerificationFailure =
  | "MALFORMED_RECEIPT"
  | "UNKNOWN_KEY"
  | "SIGNATURE_INVALID"
  | "EVIDENCE_CHAIN_INVALID"
  | "SUBJECT_MISMATCH"
  | "ACTION_MISMATCH"
  | "DECISION_MISMATCH"
  | "APPROVAL_MISMATCH"
  | "CAPABILITY_MISMATCH"
  | "EXECUTION_MISMATCH"
  | "EFFECT_MISMATCH"
  | "EVIDENCE_HEAD_MISMATCH";

export type PortableReceiptVerificationResult =
  | {
      valid: true;
      subject: PortableReceiptBody["subject"];
      decision: PortableReceiptBody["decision"]["decision"];
      effect: PortableReceiptBody["effect"]["kind"];
    }
  | { valid: false; reasonCode: PortableReceiptVerificationFailure };

function verificationFailed(
  reasonCode: PortableReceiptVerificationFailure,
): PortableReceiptVerificationResult {
  return { valid: false, reasonCode };
}

function publicKeyFromJwk(jwk: ReceiptVerificationJwk): KeyObject {
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: jwk.x },
    format: "jwk",
  });
}

/**
 * Self-contained portable receipt verification. The caller supplies only the
 * receipt and the published verification key set — no Guardian credential,
 * database, or service is required. Every embedded object is re-digested and
 * cross-checked against the embedded evidence chain, and the Ed25519 proof is
 * verified over the canonical receipt body.
 */
export function verifyPortableAuthorityReceipt(
  receiptInput: unknown,
  keysInput: unknown,
): PortableReceiptVerificationResult {
  const parsed = PortableAuthorityReceiptSchema.safeParse(receiptInput);
  if (!parsed.success) return verificationFailed("MALFORMED_RECEIPT");
  const keys = ReceiptVerificationKeySetSchema.safeParse(keysInput);
  if (!keys.success) return verificationFailed("MALFORMED_RECEIPT");
  const receipt = parsed.data;
  const { proof, ...body } = receipt;
  if (PortableReceiptBodySchema.safeParse(body).success === false) {
    return verificationFailed("MALFORMED_RECEIPT");
  }

  const jwk = keys.data.keys.find((key) => key.kid === proof.keyId);
  if (!jwk) return verificationFailed("UNKNOWN_KEY");
  let signatureOk = false;
  try {
    signatureOk = edVerify(
      null,
      portableReceiptSigningInput(body),
      publicKeyFromJwk(jwk),
      Buffer.from(proof.signature, "base64url"),
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return verificationFailed("SIGNATURE_INVALID");

  const chain = receipt.evidence.chain;
  const verdict = verifyEvidenceChain(chain);
  if (!verdict.valid || verdict.context === null) {
    return verificationFailed("EVIDENCE_CHAIN_INVALID");
  }
  const context = verdict.context;
  const subject = receipt.subject;
  if (
    context.tenantId !== subject.tenantId ||
    context.principalId !== subject.principalId ||
    context.agentId !== subject.agentId ||
    context.requestId !== subject.requestId ||
    context.correlationId !== subject.correlationId
  ) {
    return verificationFailed("SUBJECT_MISMATCH");
  }
  if (
    verdict.lastRecordHash !== receipt.evidence.headRecordHash ||
    chain.length !== receipt.evidence.recordCount
  ) {
    return verificationFailed("EVIDENCE_HEAD_MISMATCH");
  }

  const action = receipt.action;
  if (
    action.tenantId !== subject.tenantId ||
    action.principalId !== subject.principalId ||
    action.agentId !== subject.agentId ||
    action.requestId !== subject.requestId ||
    action.correlationId !== subject.correlationId
  ) {
    return verificationFailed("ACTION_MISMATCH");
  }
  const grantsFromAction = action.authority.evaluatedGrants.map(
    ({ id, version }) => ({ grantId: id, version }),
  );
  if (
    canonicalSha256(grantsFromAction) !==
    canonicalSha256(receipt.delegationChain)
  ) {
    return verificationFailed("ACTION_MISMATCH");
  }
  if (
    action.interface !== receipt.runtime.interface ||
    action.requestedAdapterId !== receipt.runtime.requestedAdapterId
  ) {
    return verificationFailed("ACTION_MISMATCH");
  }

  let boundActionDigest: string | null = null;
  // DECISION_RECORDED for kernel decisions; REQUEST_DENIED for requests
  // denied before the kernel ran.
  type DecisionEvent = {
    decision: "ALLOW" | "ASK" | "DENY";
    reasonCode: string;
    actionDecisionDigest: string;
  };
  type ApprovalEvent = Extract<
    EvidenceEvent,
    { eventType: "APPROVAL_STATE_REFERENCED" }
  >["payload"];
  type CapabilityEvent = Extract<
    EvidenceEvent,
    { eventType: "CAPABILITY_STATE_REFERENCED" }
  >["payload"];

  let decisionEvent: (DecisionEvent & { at: number }) | null = null;
  let latestApprovalEvent: ApprovalEvent | null = null;
  const capabilityEvents = new Map<
    CapabilityEvent["capabilityId"],
    CapabilityEvent
  >();
  let executionEvent: {
    adapterId: Extract<
      EvidenceEvent,
      { eventType: "EXECUTION_ATTEMPTED" }
    >["payload"]["adapterId"];
    attemptId: string;
  } | null = null;
  let terminalEvent: {
    kind: "EFFECT_VERIFIED" | "EXECUTION_FAILED" | "EXECUTION_ABORTED";
    failureCode: string | null;
    effectDigest: string | null;
    failureDigest: string | null;
  } | null = null;

  for (const record of chain) {
    const { eventType, payload } = record.event;
    if ("actionDigest" in payload && payload.actionDigest !== null) {
      if (boundActionDigest === null) boundActionDigest = payload.actionDigest;
      if (payload.actionDigest !== boundActionDigest) {
        return verificationFailed("ACTION_MISMATCH");
      }
    }
    if (eventType === "DECISION_RECORDED") {
      decisionEvent = { ...payload, at: record.eventTimeEpochMs };
    }
    if (eventType === "REQUEST_DENIED") {
      decisionEvent = {
        decision: "DENY",
        reasonCode: payload.reasonCode,
        actionDecisionDigest: payload.requestDeniedDigest,
        at: record.eventTimeEpochMs,
      };
    }
    if (eventType === "APPROVAL_STATE_REFERENCED") {
      latestApprovalEvent = payload;
    }
    if (eventType === "CAPABILITY_STATE_REFERENCED") {
      capabilityEvents.set(payload.capabilityId, payload);
    }
    if (eventType === "EXECUTION_ATTEMPTED") {
      executionEvent = {
        adapterId: payload.adapterId,
        attemptId: payload.attemptReference,
      };
    }
    if (
      eventType === "EFFECT_VERIFIED" ||
      eventType === "EXECUTION_FAILED" ||
      eventType === "EXECUTION_ABORTED"
    ) {
      terminalEvent = {
        kind: eventType,
        failureCode:
          eventType === "EXECUTION_FAILED" ? payload.failureCode : null,
        effectDigest:
          eventType === "EFFECT_VERIFIED" ? payload.effectDigest : null,
        failureDigest:
          eventType === "EXECUTION_FAILED"
            ? (payload.failureDigest ?? null)
            : null,
      };
    }
  }

  if (boundActionDigest !== action.materialDigest) {
    return verificationFailed("ACTION_MISMATCH");
  }
  if (
    decisionEvent === null ||
    decisionEvent.decision !== receipt.decision.decision ||
    decisionEvent.reasonCode !== receipt.decision.reasonCode ||
    decisionEvent.actionDecisionDigest !==
      receipt.decision.actionDecisionDigest ||
    decisionEvent.at !== receipt.decision.decidedAtEpochMs
  ) {
    return verificationFailed("DECISION_MISMATCH");
  }

  if (latestApprovalEvent === null) {
    if (receipt.approval !== null) {
      return verificationFailed("APPROVAL_MISMATCH");
    }
  } else {
    const approval = receipt.approval;
    if (
      approval === null ||
      approval.approvalId !== latestApprovalEvent.approvalId ||
      approval.state !== latestApprovalEvent.state ||
      approval.version !== latestApprovalEvent.version ||
      approval.approvalDigest !== latestApprovalEvent.approvalDigest ||
      approvalRecordDigest(approval.record) !== approval.approvalDigest ||
      approval.record.binding.approvalId !== approval.approvalId ||
      approval.record.binding.actionDigest !== action.materialDigest
    ) {
      return verificationFailed("APPROVAL_MISMATCH");
    }
  }

  if (capabilityEvents.size === 0) {
    if (receipt.capability !== null) {
      return verificationFailed("CAPABILITY_MISMATCH");
    }
  } else {
    const capability = receipt.capability;
    const event =
      capability === null
        ? undefined
        : capabilityEvents.get(capability.capabilityId);
    if (
      capability === null ||
      event === undefined ||
      capabilityClaimsDigest(capability.claims) !== capability.claimsDigest ||
      capability.claimsDigest !== event.capabilityDigest ||
      capability.claims.actionDigest !== action.materialDigest ||
      capability.claims.tenantId !== subject.tenantId ||
      capability.claims.agentId !== subject.agentId ||
      capability.claims.requestId !== subject.requestId
    ) {
      return verificationFailed("CAPABILITY_MISMATCH");
    }
  }

  if (executionEvent === null) {
    if (receipt.execution !== null) {
      return verificationFailed("EXECUTION_MISMATCH");
    }
  } else {
    const execution = receipt.execution;
    if (
      execution === null ||
      execution.attemptId !== executionEvent.attemptId ||
      execution.adapterId !== executionEvent.adapterId ||
      execution.actionDigest !== action.materialDigest ||
      execution.tenantId !== subject.tenantId ||
      execution.requestId !== subject.requestId ||
      (receipt.capability !== null &&
        execution.capabilityId !== receipt.capability.capabilityId)
    ) {
      return verificationFailed("EXECUTION_MISMATCH");
    }
    if (execution.adapterId !== receipt.runtime.adapterId) {
      return verificationFailed("EXECUTION_MISMATCH");
    }
  }

  const effect = receipt.effect;
  if (terminalEvent === null) {
    if (effect.kind !== "none" && effect.kind !== "outcome-pending") {
      return verificationFailed("EFFECT_MISMATCH");
    }
    if (
      (effect.kind === "none") !==
      (executionEvent === null && receipt.execution === null)
    ) {
      return verificationFailed("EFFECT_MISMATCH");
    }
  } else {
    if (
      effect.terminalEvent !== terminalEvent.kind ||
      effect.failureCode !== terminalEvent.failureCode ||
      effect.effectDigest !== terminalEvent.effectDigest ||
      effect.failureDigest !== terminalEvent.failureDigest ||
      effect.kind !==
        (terminalEvent.kind === "EFFECT_VERIFIED" ? "verified" : "failed")
    ) {
      return verificationFailed("EFFECT_MISMATCH");
    }
    // Recompute the effect digest end-to-end from the embedded execution
    // record so a receipt cannot point at someone else's verified effect.
    if (terminalEvent.kind === "EFFECT_VERIFIED" && receipt.execution) {
      const outcome = receipt.execution.outcome;
      if (outcome?.kind === "verified") {
        const recomputed = canonicalSha256({
          domain: "odingard.guardian.email-effect.v1",
          provider: receipt.execution.provider,
          adapterId: receipt.execution.adapterId,
          attemptId: receipt.execution.attemptId,
          sentRefDigest: canonicalSha256(outcome.sentRef),
          observedDigest: outcome.observedDigest,
          level: outcome.level,
          observedAtEpochMs: outcome.observedAtEpochMs,
        });
        if (recomputed !== terminalEvent.effectDigest) {
          return verificationFailed("EFFECT_MISMATCH");
        }
      }
    }
  }

  return {
    valid: true,
    subject,
    decision: receipt.decision.decision,
    effect: effect.kind,
  };
}
