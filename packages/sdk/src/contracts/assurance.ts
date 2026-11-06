// Generated file — do not edit.
import { z } from "zod";

/**
 * guardian.assurance.v1 — enforcement assurance level contract.
 *
 * The assurance level states how strongly Guardian can enforce a decision
 * for one action, computed deterministically from recorded surface
 * evidence. It is honest by construction: G0/G1 describe mediation that
 * does not physically prevent bypass, and the level never rises on
 * evidence that was not recorded.
 *
 * The ladder, precedence strongest-evidence G4 > G3 > G2 > G1 > G0:
 *
 *   G4 COUNTERPARTY_INTERLOCKED — the destination/provider itself
 *      requires valid Guardian authority proof (recorded tool-server
 *      catalog bound on the connection).
 *   G3 RUNTIME_CONTAINED        — execution is constrained inside a
 *      Guardian-controlled or Guardian-recognized environment (recorded
 *      attestation marks the execution environment recognized).
 *   G2 CREDENTIAL_MEDIATED      — the underlying reusable credential is
 *      Guardian-mediated (a bound connection record backed the action).
 *   G1 POLICY_MEDIATED          — the agent voluntarily called Guardian;
 *      alternate execution may exist.
 *   G0 OBSERVED                 — Guardian saw the action but could not
 *      prevent bypass.
 */

export const ASSURANCE_CONTRACT_SCHEMA = "guardian.assurance.v1";

/** Ordered enforcement-assurance ladder (lowest → highest). */
export const EnforcementAssuranceLevelSchema = z.enum([
  "G0_OBSERVED",
  "G1_POLICY_MEDIATED",
  "G2_CREDENTIAL_MEDIATED",
  "G3_RUNTIME_CONTAINED",
  "G4_COUNTERPARTY_INTERLOCKED",
]);
export type EnforcementAssuranceLevel = z.infer<
  typeof EnforcementAssuranceLevelSchema
>;

export const ENFORCEMENT_ASSURANCE_RANK: Record<
  EnforcementAssuranceLevel,
  number
> = {
  G0_OBSERVED: 0,
  G1_POLICY_MEDIATED: 1,
  G2_CREDENTIAL_MEDIATED: 2,
  G3_RUNTIME_CONTAINED: 3,
  G4_COUNTERPARTY_INTERLOCKED: 4,
};

/** Human-readable level names for display surfaces. */
export const ENFORCEMENT_ASSURANCE_LABEL: Record<
  EnforcementAssuranceLevel,
  string
> = {
  G0_OBSERVED: "observed",
  G1_POLICY_MEDIATED: "policy mediated",
  G2_CREDENTIAL_MEDIATED: "credential mediated",
  G3_RUNTIME_CONTAINED: "runtime contained",
  G4_COUNTERPARTY_INTERLOCKED: "counterparty interlocked",
};

/**
 * Recorded surface evidence the gateway derived for one action. Absent or
 * false entries never raise the level.
 */
export const EnforcementAssuranceFactsSchema = z
  .object({
    /** The agent voluntarily submitted this action to Guardian. */
    voluntaryCall: z.boolean(),
    /** A bound Guardian-mediated credential/connection backed the action. */
    guardianMediatedCredential: z.boolean().optional(),
    /** Recorded attestation marks a Guardian-recognized environment. */
    guardianContainedEnvironment: z.boolean().optional(),
    /** The destination itself requires valid Guardian authority proof. */
    counterpartyRequiresAuthorityProof: z.boolean().optional(),
  })
  .strict();
export type EnforcementAssuranceFacts = z.infer<
  typeof EnforcementAssuranceFactsSchema
>;

export interface EnforcementAssuranceComputation {
  level: EnforcementAssuranceLevel;
  /** The recorded evidence names the level was computed from. */
  evidence: readonly string[];
}

/**
 * Pure, deterministic level computation over recorded evidence. Strongest
 * evidence wins; missing evidence never raises the level.
 */
export function computeEnforcementAssurance(
  facts: EnforcementAssuranceFacts | null | undefined,
): EnforcementAssuranceComputation {
  if (facts === null || facts === undefined) {
    return { level: "G0_OBSERVED", evidence: [] };
  }
  if (facts.counterpartyRequiresAuthorityProof === true) {
    return {
      level: "G4_COUNTERPARTY_INTERLOCKED",
      evidence: ["counterpartyRequiresAuthorityProof"],
    };
  }
  if (facts.guardianContainedEnvironment === true) {
    return {
      level: "G3_RUNTIME_CONTAINED",
      evidence: ["guardianContainedEnvironment"],
    };
  }
  if (facts.guardianMediatedCredential === true) {
    return {
      level: "G2_CREDENTIAL_MEDIATED",
      evidence: ["guardianMediatedCredential"],
    };
  }
  if (facts.voluntaryCall === true) {
    return { level: "G1_POLICY_MEDIATED", evidence: ["voluntaryCall"] };
  }
  return { level: "G0_OBSERVED", evidence: [] };
}
