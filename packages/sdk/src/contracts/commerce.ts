// Generated file — do not edit.
import { z } from "zod";

import { sha256Text } from "./digest.js";
import { ConnectionIdSchema, TaskIdSchema } from "./identifiers.js";
import type { TaskId } from "./identifiers.js";

/**
 * Sandboxed commerce action parameters.
 *
 * Parameters describe the purchase intent only. They NEVER carry a reusable
 * payment credential (no card numbers, payment-method ids, tokens, or
 * account secrets): the schema is strict, so any credential-shaped key fails
 * validation. Charging happens inside the payment adapter, which alone holds
 * the leased gateway credential.
 */
const FactLabelSchema = z.string().trim().min(1).max(256);

const CentsSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const IdempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

const NfcText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => value.normalize("NFC") === value);

export const CommercePurchaseParametersV1Schema = z
  .object({
    schema: z.literal("commerce.purchase.v1"),
    connectionId: ConnectionIdSchema,
    merchantId: FactLabelSchema,
    merchantCategory: FactLabelSchema,
    amountCents: CentsSchema,
    currency: z.literal("USD"),
    orderDescription: NfcText(512),
    idempotencyKey: IdempotencyKeySchema,
    taskId: TaskIdSchema.optional(),
  })
  .strict();

export const CommerceRefundParametersV1Schema = z
  .object({
    schema: z.literal("commerce.refund.v1"),
    connectionId: ConnectionIdSchema,
    chargeId: z.string().trim().min(1).max(128),
    amountCents: CentsSchema.optional(),
    reason: NfcText(256),
  })
  .strict();

export const CommerceReturnParametersV1Schema = z
  .object({
    schema: z.literal("commerce.return.v1"),
    connectionId: ConnectionIdSchema,
    chargeId: z.string().trim().min(1).max(128),
    reason: NfcText(256),
  })
  .strict();

export const SubscriptionCreateParametersV1Schema = z
  .object({
    schema: z.literal("subscription.create.v1"),
    connectionId: ConnectionIdSchema,
    merchantId: FactLabelSchema,
    planId: z.string().trim().min(1).max(128),
    amountCents: CentsSchema,
    currency: z.literal("USD"),
    interval: z.enum(["week", "month", "year"]),
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();

export type CommercePurchaseParametersV1 = z.infer<
  typeof CommercePurchaseParametersV1Schema
>;
export type CommerceRefundParametersV1 = z.infer<
  typeof CommerceRefundParametersV1Schema
>;
export type CommerceReturnParametersV1 = z.infer<
  typeof CommerceReturnParametersV1Schema
>;
export type SubscriptionCreateParametersV1 = z.infer<
  typeof SubscriptionCreateParametersV1Schema
>;

/**
 * Generic monetary-authority facts a registered action derives from its
 * validated parameters. The envelope's declared facts must equal these —
 * an agent cannot understate an amount or smuggle a category, because the
 * kernel re-derives the facts from the digested material parameters.
 */
export type ActionAuthorityFacts = Readonly<{
  valueCents?: number;
  merchantId?: string;
  merchantCategory?: string;
  recurring?: boolean;
  taskId?: TaskId;
}>;

export function commercePurchaseVerificationProjection(
  input: CommercePurchaseParametersV1,
) {
  const params = CommercePurchaseParametersV1Schema.parse(input);
  return Object.freeze({
    domain: "odingard.guardian.commerce-projection.v1" as const,
    action: "commerce.purchase" as const,
    connectionId: params.connectionId,
    merchantId: params.merchantId,
    merchantCategory: params.merchantCategory,
    amountCents: params.amountCents,
    currency: params.currency,
    descriptionDigest: sha256Text(params.orderDescription),
    idempotencyKey: params.idempotencyKey,
    taskId: params.taskId ?? null,
  });
}

export function commercePurchaseEnvelopeProjection(
  input: CommercePurchaseParametersV1,
) {
  return commercePurchaseVerificationProjection(input);
}

export function commerceRefundVerificationProjection(
  input: CommerceRefundParametersV1,
) {
  const params = CommerceRefundParametersV1Schema.parse(input);
  return Object.freeze({
    domain: "odingard.guardian.commerce-projection.v1" as const,
    action: "commerce.refund" as const,
    connectionId: params.connectionId,
    chargeId: params.chargeId,
    amountCents: params.amountCents ?? null,
    reasonDigest: sha256Text(params.reason),
  });
}

export function commerceRefundEnvelopeProjection(
  input: CommerceRefundParametersV1,
) {
  return commerceRefundVerificationProjection(input);
}

export function commerceReturnVerificationProjection(
  input: CommerceReturnParametersV1,
) {
  const params = CommerceReturnParametersV1Schema.parse(input);
  return Object.freeze({
    domain: "odingard.guardian.commerce-projection.v1" as const,
    action: "commerce.return" as const,
    connectionId: params.connectionId,
    chargeId: params.chargeId,
    reasonDigest: sha256Text(params.reason),
  });
}

export function commerceReturnEnvelopeProjection(
  input: CommerceReturnParametersV1,
) {
  return commerceReturnVerificationProjection(input);
}

export function subscriptionCreateVerificationProjection(
  input: SubscriptionCreateParametersV1,
) {
  const params = SubscriptionCreateParametersV1Schema.parse(input);
  return Object.freeze({
    domain: "odingard.guardian.commerce-projection.v1" as const,
    action: "subscription.create" as const,
    connectionId: params.connectionId,
    merchantId: params.merchantId,
    planId: params.planId,
    amountCents: params.amountCents,
    currency: params.currency,
    interval: params.interval,
    idempotencyKey: params.idempotencyKey,
  });
}

export function subscriptionCreateEnvelopeProjection(
  input: SubscriptionCreateParametersV1,
) {
  return subscriptionCreateVerificationProjection(input);
}
