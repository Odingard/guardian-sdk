// Generated file — do not edit.
import { z } from "zod";

import { PolicyReferenceSchema } from "./authority.js";
import {
  AdapterIdSchema,
  AgentIdSchema,
  CapabilityIdSchema,
  GrantIdSchema,
  NonceSchema,
  PrincipalIdSchema,
  RequestIdSchema,
  TenantIdSchema,
} from "./identifiers.js";

export const CapabilityKeyIdSchema = z
  .string()
  .regex(/^key_[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/)
  .brand<"CapabilityKeyId">();

export const CapabilityClaimsSchema = z
  .object({
    schemaVersion: z.literal(1),
    capabilityId: CapabilityIdSchema,
    tenantId: TenantIdSchema,
    principalId: PrincipalIdSchema,
    agentId: AgentIdSchema,
    requestId: RequestIdSchema,
    actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    actionNonce: NonceSchema,
    audience: AdapterIdSchema,
    policy: PolicyReferenceSchema,
    evaluatedGrants: z
      .array(
        z
          .object({
            id: GrantIdSchema,
            version: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    issuedAtEpochMs: z.number().int().nonnegative(),
    expiresAtEpochMs: z.number().int().positive(),
    maxUses: z.literal(1),
    keyId: CapabilityKeyIdSchema,
    algorithm: z.literal("HS256"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.issuedAtEpochMs >= value.expiresAtEpochMs) {
      context.addIssue({
        code: "custom",
        path: ["expiresAtEpochMs"],
        message: "capability expiry must be later than issuance",
      });
    }
    if (
      new Set(value.evaluatedGrants.map(({ id }) => id)).size !==
      value.evaluatedGrants.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["evaluatedGrants"],
        message: "evaluated grant identifiers must be unique",
      });
    }
  });

export type CapabilityKeyId = z.infer<typeof CapabilityKeyIdSchema>;
export type CapabilityClaims = z.infer<typeof CapabilityClaimsSchema>;
