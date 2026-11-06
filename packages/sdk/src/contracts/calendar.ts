// Generated file — do not edit.
import { z } from "zod";

import { ConnectionIdSchema } from "./identifiers.js";

/**
 * calendar + commitments: canonical parameter schemas and the
 * verification/envelope projections for calendar.create, calendar.update,
 * calendar.cancel and calendar.invite.
 *
 * Posture mapping (enforced by grant emission, not the kernel):
 *   - calendar.create is the routine-scheduling surface and rides the
 *     grant's allow posture; it cannot name attendees — inviting people is
 *     always a material commitment.
 *   - calendar.update, calendar.cancel and calendar.invite are material
 *     external commitments (a committed time can change, a commitment can be
 *     destroyed, external invitees can be added) and ride an
 *     approval-required posture.
 *
 * Design note: an event's start/end time is part of the commitment, so
 * `calendar.update` can carry start/end and is emitted under the
 * approval-required posture alongside cancel/invite. Approval binding is
 * exact: eventId, calendarId, times, and attendee sets all live inside the
 * material parameters whose digest the approval binds.
 */

const CalendarIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.@%+-]*$/, "invalid calendar id");

const EventIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/, "invalid event id");

const EventTimeSchema = z
  .object({
    // RFC 3339 timestamp (what the Google Calendar API accepts).
    dateTime: z
      .string()
      .regex(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
        "dateTime must be an RFC 3339 timestamp",
      ),
    timeZone: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

const SendUpdatesSchema = z.enum(["all", "externalOnly", "none"]).optional();

const AttendeeSchema = z
  .object({
    email: z
      .string()
      .trim()
      .min(3)
      .max(320)
      .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "invalid attendee email"),
    optional: z.boolean().optional(),
  })
  .strict();

const CalendarBaseSchema = z.object({
  connectionId: ConnectionIdSchema,
  calendarId: CalendarIdSchema,
});

export const CalendarCreateParametersV1Schema = CalendarBaseSchema.extend({
  schema: z.literal("odingard.guardian.calendar.create.v1"),
  summary: z.string().trim().min(1).max(1024),
  description: z.string().max(8192).optional(),
  location: z.string().max(1024).optional(),
  start: EventTimeSchema,
  end: EventTimeSchema,
  idempotencyKey: z.string().min(8).max(128).optional(),
}).strict();

export const CalendarUpdateParametersV1Schema = CalendarBaseSchema.extend({
  schema: z.literal("odingard.guardian.calendar.update.v1"),
  eventId: EventIdSchema,
  summary: z.string().trim().min(1).max(1024).optional(),
  description: z.string().max(8192).optional(),
  location: z.string().max(1024).optional(),
  start: EventTimeSchema.optional(),
  end: EventTimeSchema.optional(),
  sendUpdates: SendUpdatesSchema,
})
  .strict()
  .refine(
    (params) =>
      params.summary !== undefined ||
      params.description !== undefined ||
      params.location !== undefined ||
      params.start !== undefined ||
      params.end !== undefined,
    "calendar.update must carry at least one changed field",
  );

export const CalendarCancelParametersV1Schema = CalendarBaseSchema.extend({
  schema: z.literal("odingard.guardian.calendar.cancel.v1"),
  eventId: EventIdSchema,
  sendUpdates: SendUpdatesSchema,
}).strict();

export const CalendarInviteParametersV1Schema = CalendarBaseSchema.extend({
  schema: z.literal("odingard.guardian.calendar.invite.v1"),
  eventId: EventIdSchema,
  attendees: z.array(AttendeeSchema).min(1).max(50),
  sendUpdates: SendUpdatesSchema,
}).strict();

export const CalendarParametersV1Schema = z.discriminatedUnion("schema", [
  CalendarCreateParametersV1Schema,
  CalendarUpdateParametersV1Schema,
  CalendarCancelParametersV1Schema,
  CalendarInviteParametersV1Schema,
]);

export type CalendarCreateParametersV1 = z.infer<
  typeof CalendarCreateParametersV1Schema
>;
export type CalendarUpdateParametersV1 = z.infer<
  typeof CalendarUpdateParametersV1Schema
>;
export type CalendarCancelParametersV1 = z.infer<
  typeof CalendarCancelParametersV1Schema
>;
export type CalendarInviteParametersV1 = z.infer<
  typeof CalendarInviteParametersV1Schema
>;
export type CalendarParametersV1 = z.infer<typeof CalendarParametersV1Schema>;

function attendeeEmails(
  attendees: readonly { email: string }[],
): readonly string[] {
  return [...new Set(attendees.map((a) => a.email.toLowerCase()))].sort();
}

/**
 * The verification projection is the semantic external effect the commit must
 * produce — the same shape the adapter rebuilds from the provider's
 * post-commit state so digests compare equal only when the observed effect
 * matches what authority approved.
 */
export function calendarVerificationProjection(
  params: CalendarParametersV1,
): Readonly<Record<string, unknown>> {
  switch (params.schema) {
    case "odingard.guardian.calendar.create.v1":
      return {
        kind: "calendar.create",
        calendarId: params.calendarId,
        summary: params.summary,
        ...(params.description === undefined
          ? {}
          : { description: params.description }),
        ...(params.location === undefined ? {} : { location: params.location }),
        start: params.start,
        end: params.end,
      };
    case "odingard.guardian.calendar.update.v1":
      return {
        kind: "calendar.update",
        calendarId: params.calendarId,
        eventId: params.eventId,
        ...(params.summary === undefined ? {} : { summary: params.summary }),
        ...(params.description === undefined
          ? {}
          : { description: params.description }),
        ...(params.location === undefined ? {} : { location: params.location }),
        ...(params.start === undefined ? {} : { start: params.start }),
        ...(params.end === undefined ? {} : { end: params.end }),
        sendUpdates: params.sendUpdates ?? "none",
      };
    case "odingard.guardian.calendar.cancel.v1":
      return {
        kind: "calendar.cancel",
        calendarId: params.calendarId,
        eventId: params.eventId,
        outcome: "cancelled",
        sendUpdates: params.sendUpdates ?? "none",
      };
    case "odingard.guardian.calendar.invite.v1":
      return {
        kind: "calendar.invite",
        calendarId: params.calendarId,
        eventId: params.eventId,
        attendees: attendeeEmails(params.attendees),
        sendUpdates: params.sendUpdates ?? "none",
      };
  }
}

/**
 * The envelope projection is the lower-fidelity view: which calendar action on
 * which calendar/event, without event content (summary/description/attendee
 * detail).
 */
export function calendarEnvelopeProjection(
  params: CalendarParametersV1,
): Readonly<Record<string, unknown>> {
  const base = {
    calendarId: params.calendarId,
    ...("eventId" in params && params.eventId !== undefined
      ? { eventId: params.eventId }
      : {}),
  };
  switch (params.schema) {
    case "odingard.guardian.calendar.create.v1":
      return { kind: "calendar.create", ...base };
    case "odingard.guardian.calendar.update.v1":
      return { kind: "calendar.update", ...base };
    case "odingard.guardian.calendar.cancel.v1":
      return { kind: "calendar.cancel", ...base };
    case "odingard.guardian.calendar.invite.v1":
      return { kind: "calendar.invite", ...base };
  }
}
