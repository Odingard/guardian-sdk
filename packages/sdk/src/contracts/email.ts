// Generated file — do not edit.
import { z } from "zod";

import { sha256Text } from "./digest.js";
import { ConnectionIdSchema } from "./identifiers.js";

const LOCAL_ATEXT = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isNoncharacter(codePoint: number): boolean {
  return (
    (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
    (codePoint & 0xffff) === 0xfffe ||
    (codePoint & 0xffff) === 0xffff
  );
}

function hasNoncharacter(value: string): boolean {
  return [...value].some((character) =>
    isNoncharacter(character.codePointAt(0) ?? 0),
  );
}

function isCanonicalEmailAddress(value: string): boolean {
  if (
    ![...value].every((character) => (character.codePointAt(0) ?? 128) < 128) ||
    value.length > 254 ||
    value.normalize("NFC") !== value
  ) {
    return false;
  }
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (
    local.length > 64 ||
    !LOCAL_ATEXT.test(local) ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    domain.length > 253 ||
    domain !== domain.toLowerCase()
  ) {
    return false;
  }
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) => !DOMAIN_LABEL.test(label))) {
    return false;
  }
  const topLevel = labels.at(-1) ?? "";
  return (
    /^[a-z]{2,63}$/.test(topLevel) ||
    /^xn--[a-z0-9](?:[a-z0-9-]{0,57}[a-z0-9])?$/.test(topLevel)
  );
}

function isSafeSubject(value: string): boolean {
  return (
    value === value.trim() &&
    value.normalize("NFC") === value &&
    [...value].length >= 1 &&
    [...value].length <= 200 &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}\p{Cn}]/u.test(value) &&
    !hasNoncharacter(value)
  );
}

function isSafeBody(value: string): boolean {
  if (
    value.length < 1 ||
    value.length > 8_000 ||
    value.normalize("NFC") !== value ||
    !/\S/u.test(value) ||
    /\r/u.test(value) ||
    /[\p{Co}\p{Cs}\p{Cn}]/u.test(value) ||
    hasNoncharacter(value)
  ) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a) ||
      codePoint === 0x7f ||
      codePoint === 0x061c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2060 && codePoint <= 0x2064) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069) ||
      codePoint === 0x200b ||
      codePoint === 0xfeff ||
      (codePoint >= 0xe0000 && codePoint <= 0xe007f)
    ) {
      return false;
    }
  }
  return true;
}

export const EmailAddressSchema = z
  .string()
  .refine(isCanonicalEmailAddress, "email address must be canonical ASCII");

export const EmailSubjectSchema = z
  .string()
  .refine(isSafeSubject, "email subject contains unsafe or noncanonical text");

export const EmailBodyTextSchema = z
  .string()
  .refine(isSafeBody, "email body contains unsafe or noncanonical text");

export const EmailSendParametersV1Schema = z
  .object({
    schema: z.literal("odingard.guardian.email.send.v1"),
    connectionId: ConnectionIdSchema,
    from: EmailAddressSchema,
    to: z.array(EmailAddressSchema).min(1).max(20),
    cc: z.array(EmailAddressSchema).max(20),
    bcc: z.array(EmailAddressSchema).max(20),
    replyTo: z.array(z.never()).max(0),
    subject: EmailSubjectSchema,
    body: z
      .object({ format: z.literal("text/plain"), text: EmailBodyTextSchema })
      .strict(),
    attachments: z.array(z.never()).max(0),
    inReplyTo: z.null(),
  })
  .strict()
  .superRefine((value, context) => {
    const recipients = [...value.to, ...value.cc, ...value.bcc].map((address) =>
      address.toLowerCase(),
    );
    if (recipients.length > 20) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "at most 20 total recipients are allowed",
      });
    }
    if (new Set(recipients).size !== recipients.length) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "recipient addresses must be unique across all lists",
      });
    }
  });

export type EmailSendParametersV1 = z.infer<typeof EmailSendParametersV1Schema>;

export function canonicalBodyForComparison(text: string): string {
  return text.replace(/\r\n?/gu, "\n").replace(/[ \t\n]*$/u, "");
}

function canonicalRecipients(addresses: readonly string[]): readonly string[] {
  return [...new Set(addresses.map((address) => address.toLowerCase()))].sort();
}

export function emailVerificationProjection(input: EmailSendParametersV1) {
  const params = EmailSendParametersV1Schema.parse(input);
  return Object.freeze({
    domain: "odingard.guardian.email-projection.v1" as const,
    sender: params.from.toLowerCase(),
    to: canonicalRecipients(params.to),
    cc: canonicalRecipients(params.cc),
    bcc: canonicalRecipients(params.bcc),
    replyTo: [] as readonly string[],
    subject: params.subject,
    bodyDigest: sha256Text(canonicalBodyForComparison(params.body.text)),
    attachmentCount: 0 as const,
    inReplyTo: null,
  });
}

export function emailEnvelopeProjection(input: EmailSendParametersV1) {
  const projection = emailVerificationProjection(input);
  return Object.freeze({
    domain: projection.domain,
    sender: projection.sender,
    to: projection.to,
    cc: projection.cc,
    bcc: projection.bcc,
    replyTo: projection.replyTo,
    subject: projection.subject,
    attachmentCount: projection.attachmentCount,
    inReplyTo: projection.inReplyTo,
  });
}
