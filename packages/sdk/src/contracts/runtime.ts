// Generated file — do not edit.
import { z } from "zod";

/**
 * guardian.runtime.v1 — runtime attestation facts contract.
 *
 * Attestation facts are recorded surface evidence supplied by platforms
 * that support them. Guardian never invents them: a field that is absent
 * simply does not exist, and the computed level never rises on missing
 * facts. A model/agent assertion is never evidence — only facts recorded
 * through the injected attestation port feed the ladder.
 *
 * The trusted-runtime ladder is deterministic:
 *
 *   T4 HARDWARE-BACKED — secureHardwareEvidence recorded
 *   T3 ATTESTED        — attestation evidence from an issuer
 *                        (attestationIssuer + attestedAt, or recorded
 *                        cloudWorkloadEvidence)
 *   T2 VERIFIED        — signed/verified workload or binary identity
 *                        (workloadIdentity, binaryIdentity,
 *                        packageIdentity, or containerIdentity recorded)
 *   T1 IDENTIFIED      — a stable runtime identity is recorded
 *                        (runtimeIdentity or deviceIdentity)
 *   T0 UNKNOWN         — nothing else recorded
 *
 * Precedence is strongest-evidence: the highest level any recorded fact
 * supports wins; lower facts never pull the level down.
 */

export const RUNTIME_CONTRACT_SCHEMA = "guardian.runtime.v1";

/** Ordered trusted-runtime ladder (lowest → highest). */
export const TrustedRuntimeLevelSchema = z.enum([
  "T0_UNKNOWN",
  "T1_IDENTIFIED",
  "T2_VERIFIED",
  "T3_ATTESTED",
  "T4_HARDWARE_BACKED",
]);
export type TrustedRuntimeLevel = z.infer<typeof TrustedRuntimeLevelSchema>;

export const TRUSTED_RUNTIME_RANK: Record<TrustedRuntimeLevel, number> = {
  T0_UNKNOWN: 0,
  T1_IDENTIFIED: 1,
  T2_VERIFIED: 2,
  T3_ATTESTED: 3,
  T4_HARDWARE_BACKED: 4,
};

/** Human-readable level names for display surfaces. */
export const TRUSTED_RUNTIME_LABEL: Record<TrustedRuntimeLevel, string> = {
  T0_UNKNOWN: "unknown",
  T1_IDENTIFIED: "identified",
  T2_VERIFIED: "verified",
  T3_ATTESTED: "attested",
  T4_HARDWARE_BACKED: "hardware-backed",
};

export function trustedRuntimeExceeds(
  value: TrustedRuntimeLevel,
  floor: TrustedRuntimeLevel,
): boolean {
  return TRUSTED_RUNTIME_RANK[value] > TRUSTED_RUNTIME_RANK[floor];
}

export function trustedRuntimeBelow(
  value: TrustedRuntimeLevel,
  floor: TrustedRuntimeLevel,
): boolean {
  return TRUSTED_RUNTIME_RANK[value] < TRUSTED_RUNTIME_RANK[floor];
}

const AttestationFactString = z.string().trim().min(1).max(1_024);

/**
 * Recorded attestation facts for an invoking runtime. Every field is
 * optional: platforms that cannot supply a fact leave it absent and the
 * ladder lowers accordingly — facts are never fabricated.
 */
export const RuntimeAttestationFactsSchema = z
  .object({
    /** Stable runtime identity asserted by the host (e.g. boundRuntime). */
    runtimeIdentity: AttestationFactString.optional(),
    /** Device/platform identity the host reports. */
    deviceIdentity: AttestationFactString.optional(),
    /** Verified workload identity (e.g. workload/spiffe id). */
    workloadIdentity: AttestationFactString.optional(),
    /** Signed/verified binary identity (digest, signer). */
    binaryIdentity: AttestationFactString.optional(),
    /** Signed/verified package identity. */
    packageIdentity: AttestationFactString.optional(),
    /** Verified container image identity/digest. */
    containerIdentity: AttestationFactString.optional(),
    /** Declared model identity recorded by the platform. */
    modelIdentity: AttestationFactString.optional(),
    /** Recorded agent version string. */
    agentVersion: AttestationFactString.optional(),
    /** Trusted-hardware evidence (TEE/TPM-style attestation token ref). */
    secureHardwareEvidence: AttestationFactString.optional(),
    /** Cloud-issued workload attestation evidence. */
    cloudWorkloadEvidence: AttestationFactString.optional(),
    /** Execution environment label (e.g. "guardian-local"). */
    executionEnvironment: AttestationFactString.optional(),
    /** Recorded network context label. */
    networkContext: AttestationFactString.optional(),
    /** Recorded region label. */
    region: AttestationFactString.optional(),
    /** Attestation timestamp — epoch milliseconds when attested. */
    attestedAt: z.number().int().nonnegative().optional(),
    /** Issuer identity of the attestation evidence. */
    attestationIssuer: AttestationFactString.optional(),
  })
  .strict();
export type RuntimeAttestationFacts = z.infer<
  typeof RuntimeAttestationFactsSchema
>;

export interface RuntimeTrustComputation {
  level: TrustedRuntimeLevel;
  /** The recorded fact names the level was computed from. */
  evidence: readonly string[];
}

/**
 * Pure, deterministic level computation over recorded facts. Missing or
 * empty facts never raise the level; an absent facts object yields T0.
 */
export function computeRuntimeTrustLevel(
  facts: RuntimeAttestationFacts | null | undefined,
): RuntimeTrustComputation {
  if (facts === null || facts === undefined) {
    return { level: "T0_UNKNOWN", evidence: [] };
  }
  const has = (value: string | number | undefined): value is string | number =>
    value !== undefined;
  if (has(facts.secureHardwareEvidence)) {
    return {
      level: "T4_HARDWARE_BACKED",
      evidence: ["secureHardwareEvidence"],
    };
  }
  const attested =
    (has(facts.attestationIssuer) && has(facts.attestedAt)) ||
    has(facts.cloudWorkloadEvidence);
  if (attested) {
    const evidence = [
      ...(has(facts.attestationIssuer) ? ["attestationIssuer"] : []),
      ...(has(facts.attestedAt) ? ["attestedAt"] : []),
      ...(has(facts.cloudWorkloadEvidence) ? ["cloudWorkloadEvidence"] : []),
    ];
    return { level: "T3_ATTESTED", evidence };
  }
  const verified = [
    ...(has(facts.workloadIdentity) ? ["workloadIdentity"] : []),
    ...(has(facts.binaryIdentity) ? ["binaryIdentity"] : []),
    ...(has(facts.packageIdentity) ? ["packageIdentity"] : []),
    ...(has(facts.containerIdentity) ? ["containerIdentity"] : []),
  ];
  if (verified.length > 0) {
    return { level: "T2_VERIFIED", evidence: verified };
  }
  const identified = [
    ...(has(facts.runtimeIdentity) ? ["runtimeIdentity"] : []),
    ...(has(facts.deviceIdentity) ? ["deviceIdentity"] : []),
  ];
  if (identified.length > 0) {
    return { level: "T1_IDENTIFIED", evidence: identified };
  }
  return { level: "T0_UNKNOWN", evidence: [] };
}

/**
 * Runtime policy declared on guardian.intent.v1 (`runtime` field) —
 * narrows, denies, or forces approval over the computed trusted-runtime
 * level; never enlarges authority.
 */
export const RuntimePolicySchema = z
  .object({
    /** Deny when the computed level is below this. */
    minLevel: TrustedRuntimeLevelSchema.optional(),
    /** Force approval when the computed level is below this. */
    requireApprovalBelow: TrustedRuntimeLevelSchema.optional(),
  })
  .strict();
export type RuntimePolicy = z.infer<typeof RuntimePolicySchema>;

/**
 * Evaluate a declared runtime policy over the computed level. Pure:
 * reports deny | require_approval | allowed with a deterministic rule ref
 * and never mutates authority.
 */
export function evaluateRuntimePolicy(
  policy: RuntimePolicy | undefined,
  level: TrustedRuntimeLevel,
):
  | { verdict: "deny"; ruleId: string }
  | { verdict: "require_approval"; ruleId: string }
  | { verdict: "allowed" } {
  if (
    policy?.minLevel !== undefined &&
    trustedRuntimeBelow(level, policy.minLevel)
  ) {
    return { verdict: "deny", ruleId: `RUNTIME_BELOW_MIN:${level}` };
  }
  if (
    policy?.requireApprovalBelow !== undefined &&
    trustedRuntimeBelow(level, policy.requireApprovalBelow)
  ) {
    return {
      verdict: "require_approval",
      ruleId: `RUNTIME_APPROVAL:${level}`,
    };
  }
  return { verdict: "allowed" };
}
