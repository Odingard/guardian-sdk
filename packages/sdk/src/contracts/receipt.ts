// Generated file — do not edit.
import { z } from "zod";

import { CanonicalActionSchema } from "./action.js";
import {
  AgentInterfaceSchema,
  DenyReasonCodeSchema,
  EpochMillisecondsSchema,
} from "./authority.js";
import { ApprovalRecordSchema, ApprovalStateSchema } from "./approval.js";
import { canonicalJson } from "./canonical-json.js";
import { CapabilityClaimsSchema } from "./capability.js";
import {
  EvidenceRecordSchema,
  FailureCodeSchema,
  Sha256DigestSchema,
} from "./evidence.js";
import { ExecutionRecordSchema } from "./execution.js";
import {
  AdapterIdSchema,
  AgentIdSchema,
  ApprovalIdSchema,
  CapabilityIdSchema,
  CorrelationIdSchema,
  PrincipalIdSchema,
  RequestIdSchema,
  TenantIdSchema,
} from "./identifiers.js";

/**
 * portable authority receipt.
 *
 * A receipt is a self-contained, signed projection of one governed request:
 * the canonical action the kernel evaluated, the decision, the human approval
 * (when required), the issued capability, the execution record and its
 * verified effect, and the complete evidence chain — all bound by one Ed25519
 * signature from Guardian's receipt-signing key. An independent verifier needs
 * only this document and the published verification keys; no Guardian
 * credential, database, or service access is required.
 */
export const PORTABLE_RECEIPT_FORMAT = "greceipt.v1";
export const PORTABLE_RECEIPT_DOMAIN = "odingard.guardian.receipt.v1";

export const ReceiptIdSchema = z
  .string()
  .regex(/^rcp_[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/, "rcp_-prefixed receipt id")
  .brand<"ReceiptId">();

export const ReceiptKeyIdSchema = z
  .string()
  .regex(/^rkey_[a-f0-9]{16,64}$/, "receipt key id must be rkey_<hex>");

/** RFC 8037 Ed25519 JWK (public parts only) — the published verifier key. */
export const ReceiptVerificationJwkSchema = z
  .object({
    kty: z.literal("OKP"),
    crv: z.literal("Ed25519"),
    kid: ReceiptKeyIdSchema,
    use: z.literal("sig"),
    alg: z.literal("EdDSA"),
    x: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43,44}$/, "x must be a base64url Ed25519 key"),
  })
  .strict();

export const ReceiptVerificationKeySetSchema = z
  .object({
    keys: z.array(ReceiptVerificationJwkSchema).min(1).max(8),
  })
  .strict();

export const ReceiptSubjectSchema = z
  .object({
    tenantId: TenantIdSchema,
    principalId: PrincipalIdSchema,
    agentId: AgentIdSchema,
    requestId: RequestIdSchema,
    correlationId: CorrelationIdSchema,
  })
  .strict();

/**
 * The runtime the governed request executed on. Today's authority model binds
 * the agent's declared transport interface and the requested adapter; the
 * adapter that actually executed is recorded once execution begins.
 */
export const ReceiptRuntimeSchema = z
  .object({
    interface: AgentInterfaceSchema,
    requestedAdapterId: AdapterIdSchema,
    adapterId: AdapterIdSchema.nullable(),
  })
  .strict();

/**
 * Projection of the chain's decision event: DECISION_RECORDED for kernel
 * decisions, REQUEST_DENIED for requests denied before the kernel ran
 * (its requestDeniedDigest fills actionDecisionDigest). Denies outside
 * the kernel carry gate/failure codes, so DENY admits the full failure
 * code space, not only the kernel's closed deny enum.
 */
export const ReceiptDecisionSchema = z
  .object({
    decision: z.enum(["ALLOW", "ASK", "DENY"]),
    reasonCode: z.union([
      z.literal("AUTHORIZED"),
      z.literal("APPROVAL_REQUIRED"),
      DenyReasonCodeSchema,
      FailureCodeSchema,
    ]),
    actionDecisionDigest: Sha256DigestSchema,
    decidedAtEpochMs: EpochMillisecondsSchema,
  })
  .strict();

export const ReceiptApprovalSchema = z
  .object({
    approvalId: ApprovalIdSchema,
    state: ApprovalStateSchema,
    version: z.number().int().positive().safe(),
    approvalDigest: Sha256DigestSchema,
    record: ApprovalRecordSchema,
  })
  .strict();

export const ReceiptCapabilitySchema = z
  .object({
    capabilityId: CapabilityIdSchema,
    claims: CapabilityClaimsSchema,
    claimsDigest: Sha256DigestSchema,
    state: z.enum(["issued", "used", "expired", "revoked"]),
  })
  .strict();

export const ReceiptEffectSchema = z
  .object({
    kind: z.enum(["verified", "failed", "outcome-pending", "none"]),
    /** Terminal evidence event kind, when execution reached one. */
    terminalEvent: z
      .enum(["EFFECT_VERIFIED", "EXECUTION_FAILED", "EXECUTION_ABORTED"])
      .nullable(),
    failureCode: z.string().max(128).nullable(),
    effectDigest: Sha256DigestSchema.nullable(),
    failureDigest: Sha256DigestSchema.nullable(),
  })
  .strict();

export const ReceiptEvidenceSchema = z
  .object({
    chain: z.array(EvidenceRecordSchema).min(1).max(10_000),
    recordCount: z.number().int().positive().max(10_000),
    headRecordHash: Sha256DigestSchema,
  })
  .strict();

export const ReceiptProofSchema = z
  .object({
    algorithm: z.literal("Ed25519"),
    canonicalization: z.literal("guardian-canonical-json.v1"),
    domain: z.literal(PORTABLE_RECEIPT_DOMAIN),
    keyId: ReceiptKeyIdSchema,
    signature: z
      .string()
      .regex(/^[A-Za-z0-9_-]{86}$/, "signature must be base64url Ed25519"),
  })
  .strict();

const requireDelegationUnlessDenied = (
  value: {
    decision: { decision: string };
    delegationChain: readonly unknown[];
  },
  context: z.RefinementCtx,
) => {
  // A denied request may carry no delegated grants — nothing was
  // delegated; that is exactly what the denial means. Every non-DENY
  // decision still requires a non-empty delegation chain.
  if (
    value.decision.decision !== "DENY" &&
    value.delegationChain.length === 0
  ) {
    context.addIssue({
      code: "custom",
      path: ["delegationChain"],
      message: "a decided request requires a non-empty delegation chain",
    });
  }
};

const PortableReceiptBodyObject = z
  .object({
    format: z.literal(PORTABLE_RECEIPT_FORMAT),
    schemaVersion: z.literal(1),
    receiptId: ReceiptIdSchema,
    issuedAtEpochMs: EpochMillisecondsSchema,
    subject: ReceiptSubjectSchema,
    runtime: ReceiptRuntimeSchema,
    action: CanonicalActionSchema,
    delegationChain: z
      .array(
        z
          .object({
            grantId: z.string().regex(/^grt_[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/),
            version: z.number().int().positive(),
          })
          .strict(),
      )
      .max(32),
    decision: ReceiptDecisionSchema,
    approval: ReceiptApprovalSchema.nullable(),
    capability: ReceiptCapabilitySchema.nullable(),
    execution: ExecutionRecordSchema.nullable(),
    effect: ReceiptEffectSchema,
    evidence: ReceiptEvidenceSchema,
    generatedBy: z.literal("guardian-control-plane"),
  })
  .strict();

/** Everything the signature covers; the proof is the only unsigned field. */
export const PortableReceiptBodySchema = PortableReceiptBodyObject.superRefine(
  requireDelegationUnlessDenied,
);

export const PortableAuthorityReceiptSchema = PortableReceiptBodyObject.extend({
  proof: ReceiptProofSchema,
})
  .strict()
  .superRefine(requireDelegationUnlessDenied);

/** Canonical bytes an Ed25519 verifier signs/verifies for a receipt body. */
export function portableReceiptSigningInput(
  body: z.infer<typeof PortableReceiptBodySchema>,
): Uint8Array {
  return new TextEncoder().encode(
    canonicalJson({ domain: PORTABLE_RECEIPT_DOMAIN, receipt: body }),
  );
}

export type ReceiptKeyId = z.infer<typeof ReceiptKeyIdSchema>;
export type ReceiptVerificationJwk = z.infer<
  typeof ReceiptVerificationJwkSchema
>;
export type ReceiptVerificationKeySet = z.infer<
  typeof ReceiptVerificationKeySetSchema
>;
export type PortableReceiptBody = z.infer<typeof PortableReceiptBodySchema>;
export type PortableAuthorityReceipt = z.infer<
  typeof PortableAuthorityReceiptSchema
>;
