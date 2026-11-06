// Generated file — do not edit.
import { z } from "zod";

import {
  AdapterIdSchema,
  AgentIdSchema,
  BudgetIdSchema,
  GrantIdSchema,
  IntentIdSchema,
  PauseIdSchema,
  PlanIdSchema,
  PolicyIdSchema,
  PrincipalIdSchema,
  RequestIdSchema,
  TaskIdSchema,
  TenantIdSchema,
} from "./identifiers.js";

const uniqueStrings = (values: string[]) =>
  new Set(values).size === values.length;

const sorted = <T extends string>(values: T[]): T[] =>
  [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

const CentsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const FactLabelSchema = z.string().trim().min(1).max(256);

export const RecurrencePolicySchema = z.enum(["never", "allowed"]);

export const BudgetConsumptionSchema = z
  .object({
    budgetId: BudgetIdSchema,
    amountCents: CentsSchema,
    transactions: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const ActionTypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/)
  .brand<"ActionType">();

export const ResourceRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    (value) => value.normalize("NFC") === value,
    "resource references must already use NFC normalization",
  )
  .brand<"ResourceRef">();

export const EpochMillisecondsSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const AgentInterfaceSchema = z.enum(["internal", "mcp", "rest"]);

export const PrincipalSchema = z
  .object({
    id: PrincipalIdSchema,
    tenantId: TenantIdSchema,
    status: z.enum(["active", "disabled"]),
  })
  .strict();

export const BudgetStateSchema = z
  .object({
    id: BudgetIdSchema,
    scope: z.enum(["agent", "task"]),
    taskId: TaskIdSchema.optional(),
    limitCents: CentsSchema,
    consumedCents: CentsSchema,
    transactionLimit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    consumedTransactions: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    expiresAtEpochMs: EpochMillisecondsSchema.optional(),
    status: z.enum(["active", "exhausted", "revoked"]),
  })
  .strict()
  .superRefine((budget, context) => {
    if (budget.scope === "task" && budget.taskId === undefined) {
      context.addIssue({
        code: "custom",
        message: "task-scoped budgets must carry a taskId",
        path: ["taskId"],
      });
    }
  });

export const AgentIdentitySchema = z
  .object({
    id: AgentIdSchema,
    tenantId: TenantIdSchema,
    ownerPrincipalId: PrincipalIdSchema,
    status: z.enum(["active", "disabled", "revoked"]),
    allowedInterfaces: z
      .array(AgentInterfaceSchema)
      .min(1)
      .refine(uniqueStrings, "allowedInterfaces must not contain duplicates")
      .transform(sorted),
    /**
     * The runtime descriptor this agent is bound to. A proposal
     * presenting a different runtime suspends the agent (substitution
     * detection). Absent means unbound — no runtime check applies.
     */
    boundRuntime: z.string().trim().min(1).max(160).optional(),
    boundModel: z.string().trim().min(1).max(160).optional(),
    /** Present on sub-agents: the agent this one is bonded under. */
    parentAgentId: AgentIdSchema.optional(),
  })
  .strict();

export const AuthorityConstraintsSchema = z
  .object({
    actions: z
      .array(ActionTypeSchema)
      .min(1)
      .max(64)
      .refine(uniqueStrings, "actions must not contain duplicates")
      .transform(sorted),
    resources: z
      .array(ResourceRefSchema)
      .min(1)
      .max(256)
      .refine(uniqueStrings, "resources must not contain duplicates")
      .transform(sorted),
    adapterIds: z
      .array(AdapterIdSchema)
      .min(1)
      .max(64)
      .refine(uniqueStrings, "adapterIds must not contain duplicates")
      .transform(sorted),
    maxValueCents: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    maxUsesPerRequest: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    notBeforeEpochMs: EpochMillisecondsSchema.optional(),
    expiresAtEpochMs: EpochMillisecondsSchema,
    approvalRequired: z.boolean(),
    askAboveValueCents: CentsSchema.optional(),
    merchantAllowlist: z
      .array(FactLabelSchema)
      .min(1)
      .max(256)
      .refine(uniqueStrings, "merchantAllowlist must not contain duplicates")
      .transform(sorted)
      .optional(),
    categoryAllowlist: z
      .array(FactLabelSchema)
      .min(1)
      .max(256)
      .refine(uniqueStrings, "categoryAllowlist must not contain duplicates")
      .transform(sorted)
      .optional(),
    recurrence: RecurrencePolicySchema.optional(),
    budgetIds: z
      .array(BudgetIdSchema)
      .min(1)
      .max(64)
      .refine(uniqueStrings, "budgetIds must not contain duplicates")
      .transform(sorted)
      .optional(),
  })
  .strict()
  .superRefine((constraints, context) => {
    if (
      constraints.askAboveValueCents !== undefined &&
      constraints.maxValueCents !== undefined &&
      constraints.askAboveValueCents >= constraints.maxValueCents
    ) {
      context.addIssue({
        code: "custom",
        message: "askAboveValueCents must be below maxValueCents",
        path: ["askAboveValueCents"],
      });
    }
  })
  .superRefine((constraints, context) => {
    if (
      constraints.notBeforeEpochMs !== undefined &&
      constraints.expiresAtEpochMs !== undefined &&
      constraints.notBeforeEpochMs >= constraints.expiresAtEpochMs
    ) {
      context.addIssue({
        code: "custom",
        message: "notBeforeEpochMs must be earlier than expiresAtEpochMs",
        path: ["expiresAtEpochMs"],
      });
    }
  });

export const AuthorityGrantSchema = z
  .object({
    id: GrantIdSchema,
    tenantId: TenantIdSchema,
    principalId: PrincipalIdSchema,
    agentId: AgentIdSchema,
    parentGrantId: GrantIdSchema.optional(),
    issuedBy: z
      .object({
        type: z.literal("principal"),
        principalId: PrincipalIdSchema,
      })
      .strict(),
    status: z.enum(["active", "revoked", "disabled"]),
    version: z.number().int().positive(),
    delegable: z.boolean().default(false),
    constraints: AuthorityConstraintsSchema,
  })
  .strict()
  .superRefine((grant, context) => {
    if (grant.issuedBy.principalId !== grant.principalId) {
      context.addIssue({
        code: "custom",
        message: "issuedBy principal must match the grant principal",
        path: ["issuedBy", "principalId"],
      });
    }
    if (grant.parentGrantId === grant.id) {
      context.addIssue({
        code: "custom",
        message: "a grant cannot be its own parent",
        path: ["parentGrantId"],
      });
    }
  });

export const AuthorityRequestSchema = z
  .object({
    id: RequestIdSchema,
    tenantId: TenantIdSchema,
    principalId: PrincipalIdSchema,
    agentId: AgentIdSchema,
    action: ActionTypeSchema,
    resource: ResourceRefSchema,
    interface: AgentInterfaceSchema,
    requestedAdapterId: AdapterIdSchema,
    valueCents: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    uses: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    materialActionDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    descriptiveContext: z.string().max(8_192).optional(),
    merchantId: FactLabelSchema.optional(),
    merchantCategory: FactLabelSchema.optional(),
    recurring: z.boolean().optional(),
    taskId: TaskIdSchema.optional(),
    // Intent/plan provenance recorded on the request for receipts.
    intentId: IntentIdSchema.optional(),
    planId: PlanIdSchema.optional(),
  })
  .strict();

export const DenyReasonCodeSchema = z.enum([
  "MALFORMED_INPUT",
  "TENANT_MISMATCH",
  "PRINCIPAL_MISMATCH",
  "PRINCIPAL_NOT_ACTIVE",
  "AGENT_TENANT_MISMATCH",
  "AGENT_OWNER_MISMATCH",
  "AGENT_MISMATCH",
  "AGENT_NOT_ACTIVE",
  "INTERFACE_NOT_ALLOWED",
  "AUTHORITY_PAUSED",
  "AUTHORITY_CHAIN_MISSING",
  "DUPLICATE_GRANT_ID",
  "GRANT_TENANT_MISMATCH",
  "GRANT_PRINCIPAL_MISMATCH",
  "GRANT_AGENT_MISMATCH",
  "GRANT_NOT_ACTIVE",
  "GRANT_REVOKED",
  "GRANT_NOT_YET_VALID",
  "GRANT_EXPIRED",
  "INVALID_PARENT_LINK",
  "DELEGATION_NOT_ALLOWED",
  "AUTHORITY_AMPLIFICATION",
  "ACTION_NOT_ALLOWED",
  "RESOURCE_NOT_ALLOWED",
  "ADAPTER_NOT_ALLOWED",
  "VALUE_LIMIT_EXCEEDED",
  "USE_LIMIT_EXCEEDED",
  "MERCHANT_NOT_ALLOWED",
  "CATEGORY_NOT_ALLOWED",
  "RECURRENCE_NOT_ALLOWED",
  "BUDGET_NOT_FOUND",
  "BUDGET_SCOPE_MISMATCH",
  "BUDGET_NOT_ACTIVE",
  "BUDGET_EXPIRED",
  "BUDGET_EXCEEDED",
  "TRANSACTION_LIMIT_EXCEEDED",
]);

export const DENY_PRECEDENCE = [
  "MALFORMED_INPUT",
  "TENANT_MISMATCH",
  "PRINCIPAL_MISMATCH",
  "PRINCIPAL_NOT_ACTIVE",
  "AGENT_TENANT_MISMATCH",
  "AGENT_OWNER_MISMATCH",
  "AGENT_MISMATCH",
  "AGENT_NOT_ACTIVE",
  "INTERFACE_NOT_ALLOWED",
  "AUTHORITY_PAUSED",
  "AUTHORITY_CHAIN_MISSING",
  "DUPLICATE_GRANT_ID",
  "GRANT_TENANT_MISMATCH",
  "GRANT_PRINCIPAL_MISMATCH",
  "GRANT_AGENT_MISMATCH",
  "GRANT_REVOKED",
  "GRANT_NOT_ACTIVE",
  "GRANT_NOT_YET_VALID",
  "GRANT_EXPIRED",
  "INVALID_PARENT_LINK",
  "DELEGATION_NOT_ALLOWED",
  "AUTHORITY_AMPLIFICATION",
  "ACTION_NOT_ALLOWED",
  "RESOURCE_NOT_ALLOWED",
  "ADAPTER_NOT_ALLOWED",
  "VALUE_LIMIT_EXCEEDED",
  "USE_LIMIT_EXCEEDED",
  "MERCHANT_NOT_ALLOWED",
  "CATEGORY_NOT_ALLOWED",
  "RECURRENCE_NOT_ALLOWED",
  "BUDGET_NOT_FOUND",
  "BUDGET_SCOPE_MISMATCH",
  "BUDGET_NOT_ACTIVE",
  "BUDGET_EXPIRED",
  "BUDGET_EXCEEDED",
  "TRANSACTION_LIMIT_EXCEEDED",
] as const satisfies readonly z.infer<typeof DenyReasonCodeSchema>[];

export const PolicyReferenceSchema = z
  .object({
    id: PolicyIdSchema,
    version: z.number().int().positive(),
  })
  .strict();

export const DecisionBindingSchema = z
  .object({
    requestId: RequestIdSchema.nullable(),
    policy: PolicyReferenceSchema.nullable(),
    evaluatedGrants: z
      .array(
        z
          .object({
            id: GrantIdSchema,
            version: z.number().int().positive(),
          })
          .strict(),
      )
      .max(32),
    inputDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    budgetConsumption: z.array(BudgetConsumptionSchema).max(64).optional(),
  })
  .strict();

export const AuthorityDecisionSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("ALLOW"),
      reasonCode: z.literal("AUTHORIZED"),
      binding: DecisionBindingSchema,
    })
    .strict(),
  z
    .object({
      decision: z.literal("ASK"),
      reasonCode: z.literal("APPROVAL_REQUIRED"),
      binding: DecisionBindingSchema,
    })
    .strict(),
  z
    .object({
      decision: z.literal("DENY"),
      reasonCode: DenyReasonCodeSchema,
      binding: DecisionBindingSchema,
    })
    .strict(),
]);

export const RevocationSchema = z
  .object({
    grantId: GrantIdSchema,
    revokedAtEpochMs: EpochMillisecondsSchema,
    reasonCode: z.string().trim().min(1).max(128),
  })
  .strict();

/**
 * A scoped authority suspension recorded in authority state. The
 * control plane resolves each pause into the identifiers the kernel checks
 * (grant ids as emitted on the chain, adapter ids for connection scope), so
 * the kernel needs no persistence knowledge to fail closed.
 */
export const AuthorityPauseSchema = z
  .object({
    id: PauseIdSchema,
    scope: z.enum(["principal", "agent", "grant", "connection"]),
    agentId: AgentIdSchema.optional(),
    grantIds: z
      .array(GrantIdSchema)
      .max(64)
      .refine(uniqueStrings, "paused grant ids must not contain duplicates")
      .transform(sorted)
      .optional(),
    adapterIds: z
      .array(AdapterIdSchema)
      .max(64)
      .refine(uniqueStrings, "paused adapter ids must not contain duplicates")
      .transform(sorted)
      .optional(),
  })
  .strict()
  .superRefine((pause, context) => {
    if (pause.scope === "agent" && pause.agentId === undefined) {
      context.addIssue({
        code: "custom",
        message: "agent-scoped pauses must carry agentId",
        path: ["agentId"],
      });
    }
    if (
      pause.scope === "grant" &&
      (pause.grantIds === undefined || pause.grantIds.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "grant-scoped pauses must carry at least one grantId",
        path: ["grantIds"],
      });
    }
    if (
      pause.scope === "connection" &&
      (pause.adapterIds === undefined || pause.adapterIds.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "connection-scoped pauses must carry at least one adapterId",
        path: ["adapterIds"],
      });
    }
  });

export type ActionType = z.infer<typeof ActionTypeSchema>;
export type ResourceRef = z.infer<typeof ResourceRefSchema>;
export type Principal = z.infer<typeof PrincipalSchema>;
export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;
export type AgentInterface = z.infer<typeof AgentInterfaceSchema>;
export type AuthorityConstraints = z.infer<typeof AuthorityConstraintsSchema>;
export type AuthorityGrant = z.infer<typeof AuthorityGrantSchema>;
export type AuthorityRequest = z.infer<typeof AuthorityRequestSchema>;
export type AuthorityDecision = z.infer<typeof AuthorityDecisionSchema>;
export type DenyReasonCode = z.infer<typeof DenyReasonCodeSchema>;
export type Revocation = z.infer<typeof RevocationSchema>;
export type AuthorityPause = z.infer<typeof AuthorityPauseSchema>;
export type PolicyReference = z.infer<typeof PolicyReferenceSchema>;
export type DecisionBinding = z.infer<typeof DecisionBindingSchema>;
export type RecurrencePolicy = z.infer<typeof RecurrencePolicySchema>;
export type BudgetConsumption = z.infer<typeof BudgetConsumptionSchema>;
export type BudgetState = z.infer<typeof BudgetStateSchema>;

export const AUTHORITY_CONSTRAINT_KEYS = [
  "actions",
  "resources",
  "adapterIds",
  "maxValueCents",
  "maxUsesPerRequest",
  "notBeforeEpochMs",
  "expiresAtEpochMs",
  "approvalRequired",
  "askAboveValueCents",
  "merchantAllowlist",
  "categoryAllowlist",
  "recurrence",
  "budgetIds",
] as const satisfies readonly (keyof AuthorityConstraints)[];

type MissingConstraintKey = Exclude<
  keyof AuthorityConstraints,
  (typeof AUTHORITY_CONSTRAINT_KEYS)[number]
>;
const constraintKeyExhaustiveness: Record<MissingConstraintKey, never> = {};
void constraintKeyExhaustiveness;
