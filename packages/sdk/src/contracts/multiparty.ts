// Generated file — do not edit.
import { z } from "zod";

import { EpochMillisecondsSchema } from "./authority.js";
import { canonicalSha256 } from "./digest.js";
import { PrincipalIdSchema } from "./identifiers.js";

/**
 * guardian.multiparty.v1 — declarative multi-party approval
 * structures.
 *
 * An approval structure declares WHICH human approvals must be recorded
 * before consent can resolve: a single approver, an n-of-m quorum, a
 * unanimous set, a role quorum, composable required members, vetoes,
 * separation of duties, and temporary / delegated / emergency approvers.
 * It is a pure declarative input: the approval service freezes the
 * resolved structure into the approval binding at creation (consent can
 * never widen), records each member's decision, and evaluates the
 * structure deterministically. Nothing here enlarges authority — an
 * unsatisfiable structure fails closed, a veto terminates as denied, and
 * a declared cooling period keeps authority pending for its window.
 */

export const MULTIPARTY_CONTRACT_SCHEMA = "guardian.multiparty.v1";

const MemberIdList = z.array(PrincipalIdSchema).min(1).max(16);
const MemberIdSet = z.array(PrincipalIdSchema).max(16);

/** One roster entry: a member plus the role labels they hold under this structure. */
export const StructureMemberSchema = z
  .object({
    memberId: PrincipalIdSchema,
    roles: z
      .array(z.string().trim().min(1).max(64))
      .max(8)
      .refine(
        (roles) => new Set(roles).size === roles.length,
        "member roles must be unique",
      )
      .optional(),
  })
  .strict();
export type StructureMember = z.infer<typeof StructureMemberSchema>;

/** The primary approval requirement — exactly one of four shapes. */
export const StructureRequirementSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("single"),
        memberId: PrincipalIdSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("nOfM"),
        n: z.number().int().min(1).max(16),
        members: MemberIdList,
      })
      .strict(),
    z
      .object({
        kind: z.literal("unanimous"),
        members: MemberIdList,
      })
      .strict(),
    z
      .object({
        kind: z.literal("roleQuorum"),
        role: z.string().trim().min(1).max(64),
        n: z.number().int().min(1).max(16),
        m: z.number().int().min(1).max(16),
      })
      .strict(),
  ])
  .superRefine((requirement, context) => {
    if (
      requirement.kind === "nOfM" &&
      requirement.n > requirement.members.length
    ) {
      context.addIssue({
        code: "custom",
        message: "nOfM requires n <= members.length",
        path: ["n"],
      });
    }
    if (requirement.kind === "roleQuorum" && requirement.n > requirement.m) {
      context.addIssue({
        code: "custom",
        message: "roleQuorum requires n <= m",
        path: ["n"],
      });
    }
  });
export type StructureRequirement = z.infer<typeof StructureRequirementSchema>;

/** A declared delay between satisfaction and resolved consent. */
export const CoolingPeriodSchema = z
  .object({
    /** Seconds the authority must stay pending after requirements are met. */
    seconds: z.number().int().min(1).max(2_592_000),
  })
  .strict();
export type CoolingPeriod = z.infer<typeof CoolingPeriodSchema>;

/** A member whose recorded approvals count only while unexpired. */
export const TemporaryApproverSchema = z
  .object({
    memberId: PrincipalIdSchema,
    expiresAtEpochMs: EpochMillisecondsSchema,
  })
  .strict();
export type TemporaryApprover = z.infer<typeof TemporaryApproverSchema>;

/**
 * A member who may act on behalf of a delegator. The delegate's authority can
 * only narrow the delegator's — the delegator must itself be a structure
 * member, so a delegate can never act for an authority the delegator lacks.
 */
export const DelegatedApproverSchema = z
  .object({
    memberId: PrincipalIdSchema,
    delegatedBy: PrincipalIdSchema,
  })
  .strict();
export type DelegatedApprover = z.infer<typeof DelegatedApproverSchema>;

/**
 * One declarative approval structure. `members` is the roster of
 * principals the structure recognizes and the roles each holds (frozen into
 * the binding, so a later roster edit cannot retroactively alter consent).
 */
export const ApprovalStructureSchema = z
  .object({
    schema: z.literal(MULTIPARTY_CONTRACT_SCHEMA),
    structureId: z.string().trim().min(1).max(64),
    members: z
      .array(StructureMemberSchema)
      .min(1)
      .max(16)
      .refine(
        (members) =>
          new Set(members.map((entry) => entry.memberId)).size ===
          members.length,
        "structure members must be unique",
      ),
    requirement: StructureRequirementSchema,
    /** Every listed member must record an approval in addition to the requirement. */
    specificRequired: MemberIdSet.optional(),
    /** A recorded veto by any listed member terminates the approval as denied. */
    veto: MemberIdSet.optional(),
    /**
     * Groups of roles/memberIds a single principal may satisfy at most one
     * slot of — a recorded approval that would fill two exclusive slots is a
     * separation-of-duties violation and makes the structure impossible.
     */
    separationOfDuties: z
      .object({
        mutuallyExclusive: z
          .array(z.array(z.string().trim().min(1).max(64)).min(2).max(8))
          .min(1)
          .max(8),
      })
      .strict()
      .optional(),
    temporaryApprovers: z.array(TemporaryApproverSchema).max(8).optional(),
    delegatedApprovers: z.array(DelegatedApproverSchema).max(8).optional(),
    /** Members whose recorded emergency approval satisfies the requirement when the decision context declares an emergency. */
    emergencyApprovers: MemberIdSet.optional(),
    coolingPeriod: CoolingPeriodSchema.optional(),
  })
  .strict()
  .superRefine((structure, context) => {
    const roster = new Set<string>(
      structure.members.map((entry) => entry.memberId),
    );
    const delegates = new Set<string>(
      (structure.delegatedApprovers ?? []).map((entry) => entry.memberId),
    );
    const universe = (memberId: string) =>
      roster.has(memberId) || delegates.has(memberId);
    const requirementMembers =
      structure.requirement.kind === "single"
        ? [structure.requirement.memberId]
        : structure.requirement.kind === "nOfM" ||
            structure.requirement.kind === "unanimous"
          ? structure.requirement.members
          : [];
    for (const memberId of requirementMembers) {
      if (!roster.has(memberId)) {
        context.addIssue({
          code: "custom",
          message: "requirement members must be roster members",
          path: ["requirement"],
        });
        break;
      }
    }
    for (const memberId of structure.specificRequired ?? []) {
      if (!roster.has(memberId)) {
        context.addIssue({
          code: "custom",
          message: "specificRequired members must be roster members",
          path: ["specificRequired"],
        });
        break;
      }
    }
    for (const memberId of structure.veto ?? []) {
      if (!universe(memberId)) {
        context.addIssue({
          code: "custom",
          message: "veto members must be roster or delegated members",
          path: ["veto"],
        });
        break;
      }
    }
    for (const memberId of structure.emergencyApprovers ?? []) {
      if (!universe(memberId)) {
        context.addIssue({
          code: "custom",
          message: "emergency approvers must be roster or delegated members",
          path: ["emergencyApprovers"],
        });
        break;
      }
    }
    for (const entry of structure.temporaryApprovers ?? []) {
      if (!universe(entry.memberId)) {
        context.addIssue({
          code: "custom",
          message: "temporary approvers must be roster or delegated members",
          path: ["temporaryApprovers"],
        });
        break;
      }
    }
    for (const entry of structure.delegatedApprovers ?? []) {
      if (!roster.has(entry.delegatedBy)) {
        context.addIssue({
          code: "custom",
          message:
            "a delegated approver's delegator must be a roster member — delegation can only narrow the delegator's authority",
          path: ["delegatedApprovers"],
        });
        break;
      }
      if (entry.memberId === entry.delegatedBy) {
        context.addIssue({
          code: "custom",
          message: "a member cannot delegate to itself",
          path: ["delegatedApprovers"],
        });
        break;
      }
    }
    if (
      structure.requirement.kind === "roleQuorum" &&
      !structure.members.some((entry) =>
        (entry.roles ?? []).includes(
          structure.requirement.kind === "roleQuorum"
            ? structure.requirement.role
            : "",
        ),
      )
    ) {
      // A role nobody holds can never be satisfied — declared, not discovered.
      context.addIssue({
        code: "custom",
        message: "roleQuorum role must be held by at least one roster member",
        path: ["requirement", "role"],
      });
    }
  });
export type ApprovalStructure = z.infer<typeof ApprovalStructureSchema>;

/** Every principal a structure recognizes as a potential decision actor. */
export function structureMemberIds(
  structure: ApprovalStructure,
): readonly string[] {
  const ids = new Set<string>([
    ...structure.members.map((entry) => entry.memberId),
    ...(structure.delegatedApprovers ?? []).map((entry) => entry.memberId),
    ...(structure.veto ?? []),
    ...(structure.emergencyApprovers ?? []),
    ...(structure.temporaryApprovers ?? []).map((entry) => entry.memberId),
  ]);
  return [...ids].sort();
}

/** The approvals a structure's primary requirement calls for (for display). */
export function structureRequiredCount(structure: ApprovalStructure): number {
  const requirement = structure.requirement;
  const base =
    requirement.kind === "single"
      ? 1
      : requirement.kind === "unanimous"
        ? requirement.members.length
        : requirement.n;
  return base + (structure.specificRequired?.length ?? 0);
}

/** One member's recorded decision under a structure (append-only). */
export const RecordedStructureApprovalSchema = z
  .object({
    memberId: PrincipalIdSchema,
    decision: z.enum(["approve", "deny", "veto"]),
    atEpochMs: EpochMillisecondsSchema,
    /** The delegator this member acted under (must match delegatedApprovers). */
    via: PrincipalIdSchema.optional(),
    /** Set when the decision invoked declared emergency authority. */
    emergency: z.literal(true).optional(),
  })
  .strict();
export type RecordedStructureApproval = z.infer<
  typeof RecordedStructureApprovalSchema
>;

export const CoolingWindowSchema = z
  .object({
    startedAtEpochMs: EpochMillisecondsSchema,
    endsAtEpochMs: EpochMillisecondsSchema,
  })
  .strict();
export type CoolingWindow = z.infer<typeof CoolingWindowSchema>;

export type ApprovalStructureEvaluation =
  | Readonly<{ status: "satisfied"; approvedBy: readonly string[] }>
  | Readonly<{
      status: "pending";
      recordedCount: number;
      requiredCount: number;
      missing: readonly string[];
      cooling?: Readonly<{
        startedAtEpochMs: number;
        endsAtEpochMs: number;
        remainingMs: number;
      }>;
    }>
  | Readonly<{ status: "vetoed"; by: string }>
  | Readonly<{ status: "impossible"; reason: string }>;

/**
 * Pure evaluator: every recorded decision is replayed against the
 * declared structure. First-recorded decision per member wins (append-only);
 * a recorded veto by a veto-listed member terminates as vetoed; a recorded
 * deny removes that member's ability to approve and can make the structure
 * impossible; temporary approvals void once expired; delegated approvals count
 * only under a declared delegation whose delegator is a roster member; a
 * separation-of-duties violation is impossible; an emergency approval
 * satisfies the requirement only when the context declares the emergency.
 * The result only ever holds authority pending or closes it — never widens it.
 */
export function evaluateApprovalStructure(
  structure: ApprovalStructure,
  recorded: readonly RecordedStructureApproval[],
  ctx: {
    nowEpochMs: number;
    emergency?: boolean;
    /** When the requirements were first satisfied (recorded by the caller). */
    satisfiedAtEpochMs?: number;
  },
): ApprovalStructureEvaluation {
  const roster = new Map(
    structure.members.map((entry) => [entry.memberId, entry.roles ?? []]),
  );
  const delegates = new Map(
    (structure.delegatedApprovers ?? []).map((entry) => [
      entry.memberId,
      entry.delegatedBy,
    ]),
  );
  const temporary = new Map(
    (structure.temporaryApprovers ?? []).map((entry) => [
      entry.memberId,
      entry.expiresAtEpochMs,
    ]),
  );
  const vetoMembers = new Set(structure.veto ?? []);
  const emergencyMembers = new Set(structure.emergencyApprovers ?? []);
  const universe = new Set(structureMemberIds(structure));

  // First-recorded decision per member wins; a later veto from a veto member
  // still terminates (append-only record never rewrites history).
  const firstByMember = new Map<string, RecordedStructureApproval>();
  let vetoedBy: string | null = null;
  for (const entry of recorded) {
    if (!universe.has(entry.memberId)) continue;
    if (
      entry.decision === "veto" &&
      vetoMembers.has(entry.memberId) &&
      vetoedBy === null
    ) {
      vetoedBy = entry.memberId;
    }
    if (!firstByMember.has(entry.memberId)) {
      firstByMember.set(entry.memberId, entry);
    }
  }
  if (vetoedBy !== null) return { status: "vetoed", by: vetoedBy };

  // Which recorded approvals count: unexpired temporary, declared delegation,
  // and emergency only under an emergency context.
  const denied = new Set<string>();
  const approves: { memberId: string; roles: readonly string[] }[] = [];
  for (const entry of firstByMember.values()) {
    if (entry.decision !== "approve") {
      denied.add(entry.memberId);
      continue;
    }
    if (
      entry.via !== undefined &&
      delegates.get(entry.memberId) !== entry.via
    ) {
      continue;
    }
    if (entry.emergency === true) {
      if (ctx.emergency !== true || !emergencyMembers.has(entry.memberId)) {
        continue;
      }
      approves.push({
        memberId: entry.memberId,
        roles: roster.get(entry.memberId) ?? [],
      });
      continue;
    }
    const expiry = temporary.get(entry.memberId);
    if (
      expiry !== undefined &&
      (entry.atEpochMs >= expiry || ctx.nowEpochMs >= expiry)
    ) {
      continue;
    }
    approves.push({
      memberId: entry.memberId,
      roles: roster.get(entry.memberId) ?? [],
    });
  }
  const approvedSet = new Set(approves.map((entry) => entry.memberId));

  // Separation of duties: a single member's approval matching two exclusive
  // slots is a violation and makes the structure impossible.
  for (const group of structure.separationOfDuties?.mutuallyExclusive ?? []) {
    for (const approval of approves) {
      const matches = group.filter(
        (slot) => slot === approval.memberId || approval.roles.includes(slot),
      );
      if (matches.length >= 2) {
        return {
          status: "impossible",
          reason: `SEPARATION_OF_DUTIES:${approval.memberId}`,
        };
      }
    }
  }

  const requirement = structure.requirement;
  const approvedBy = [...approvedSet].sort();
  let requirementMet = false;
  let missing: string[] = [];
  if (requirement.kind === "single") {
    requirementMet = approvedSet.has(requirement.memberId);
    missing = requirementMet ? [] : [requirement.memberId];
  } else if (requirement.kind === "nOfM") {
    const counted = requirement.members.filter((id) => approvedSet.has(id));
    requirementMet = counted.length >= requirement.n;
    missing =
      requirement.n - counted.length > 0
        ? [`${requirement.n - counted.length} more approvals`]
        : [];
    const available = requirement.members.filter((id) => !denied.has(id));
    if (available.length < requirement.n) {
      return {
        status: "impossible",
        reason: `QUORUM_UNREACHABLE:${requirement.kind}`,
      };
    }
  } else if (requirement.kind === "unanimous") {
    const missingMembers = requirement.members.filter(
      (id) => !approvedSet.has(id),
    );
    requirementMet = missingMembers.length === 0;
    missing = missingMembers;
    if (requirement.members.some((id) => denied.has(id))) {
      return {
        status: "impossible",
        reason: "UNANIMOUS_MEMBER_DENIED",
      };
    }
  } else {
    const holders = structure.members
      .filter((entry) => (entry.roles ?? []).includes(requirement.role))
      .map((entry) => entry.memberId);
    const counted = holders.filter((id) => approvedSet.has(id));
    requirementMet = counted.length >= requirement.n;
    missing =
      requirement.n - counted.length > 0
        ? [
            `${requirement.n - counted.length} more ${requirement.role} approvals`,
          ]
        : [];
    const available = holders.filter((id) => !denied.has(id));
    if (Math.min(available.length, requirement.m) < requirement.n) {
      return {
        status: "impossible",
        reason: `QUORUM_UNREACHABLE:${requirement.kind}`,
      };
    }
  }

  const missingSpecific = (structure.specificRequired ?? []).filter(
    (id) => !approvedSet.has(id),
  );
  if (missingSpecific.some((id) => denied.has(id))) {
    return {
      status: "impossible",
      reason: "REQUIRED_MEMBER_DENIED",
    };
  }
  // A member whose decision is denied/expired can never approve; a member
  // outside every remaining path makes specificRequired impossible.
  for (const id of missingSpecific) {
    if (!universe.has(id)) {
      return { status: "impossible", reason: `REQUIRED_MEMBER_UNKNOWN:${id}` };
    }
  }
  if (requirement.kind === "single" && denied.has(requirement.memberId)) {
    return { status: "impossible", reason: "REQUIRED_MEMBER_DENIED" };
  }

  missing = [...missing, ...missingSpecific];
  if (!requirementMet || missingSpecific.length > 0) {
    return {
      status: "pending",
      recordedCount: approvedSet.size,
      requiredCount: structureRequiredCount(structure),
      missing,
    };
  }

  if (structure.coolingPeriod !== undefined) {
    const startedAtEpochMs = ctx.satisfiedAtEpochMs ?? ctx.nowEpochMs;
    const endsAtEpochMs =
      startedAtEpochMs + structure.coolingPeriod.seconds * 1_000;
    if (ctx.nowEpochMs < endsAtEpochMs) {
      return {
        status: "pending",
        recordedCount: approvedSet.size,
        requiredCount: structureRequiredCount(structure),
        missing: [],
        cooling: {
          startedAtEpochMs,
          endsAtEpochMs,
          remainingMs: endsAtEpochMs - ctx.nowEpochMs,
        },
      };
    }
  }
  return { status: "satisfied", approvedBy };
}

export function approvalStructureDigest(structure: ApprovalStructure): string {
  return canonicalSha256({
    domain: "odingard.guardian.multiparty.v1",
    structure,
  });
}
