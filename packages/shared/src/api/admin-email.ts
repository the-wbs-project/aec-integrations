import { z } from 'zod';

import { PageQuerySchema, paginatedResponseSchema } from './common';

/**
 * Admin email screen contracts (AECI-1223), behind `requireAdmin()`:
 *
 *   GET  /api/admin/email/summary        per-template counts, 7 and 30 days
 *   GET  /api/admin/email/sends          the send ledger, newest first, filtered
 *   POST /api/admin/email/sends/search   the same list for one exact address
 *   GET  /api/admin/email/switches       the sending switches (AECI-1224)
 *   PUT  /api/admin/email/switches/:key  pause or resume one (AECI-1224)
 *
 * Source of truth: `ADMIN_PANEL_SPEC.md` §5.14 and §13 D23, `API_CONTRACTS.md` §6.10.
 * Tables: `notification_sends` (`DATABASE_SCHEMA.md` §9.9) and
 * `notification_delivery_events` (§9.9a).
 *
 * ─── The ledger is hash-only, and so is this contract ───────────────────────────
 *
 * The ledger stores an unsalted SHA-256 of each recipient and never the address (ADR 0038).
 * Nothing here carries an address or a full hash. A row carries an 8-character prefix of the
 * hash so an operator can see that two rows went to one person.
 *
 * The address search takes the address in a POST BODY. Both Workers record every request URL
 * in Workers Logs, so a `?address=` would write the address into those logs on every search.
 * `GET /sends` refuses an `address` parameter outright (`ADDRESS_NOT_ALLOWED_IN_URL`).
 */

/** Every `notification_sends.outcome` value. `sending` is a send in flight, or one whose
 *  isolate died. The summary does not count it; the list filter can still find it.
 *  `paused` (AECI-1224): an operator paused the template, or the support copy, on this tier. */
export const ADMIN_EMAIL_SEND_OUTCOMES = [
  'sending',
  'sent',
  'failed',
  'unknown',
  'skipped',
  'suppressed',
  'duplicate',
  'paused',
] as const;
export const AdminEmailSendOutcomeSchema = z.enum(ADMIN_EMAIL_SEND_OUTCOMES);
export type AdminEmailSendOutcome = z.infer<typeof AdminEmailSendOutcomeSchema>;

/** The seven outcomes the summary counts. `paused` since AECI-1224. */
export const ADMIN_EMAIL_SUMMARY_OUTCOMES = [
  'sent',
  'failed',
  'unknown',
  'skipped',
  'suppressed',
  'duplicate',
  'paused',
] as const;
export type AdminEmailSummaryOutcome = (typeof ADMIN_EMAIL_SUMMARY_OUTCOMES)[number];

/** Every `notification_delivery_events.event_type` value. */
export const ADMIN_EMAIL_DELIVERY_EVENTS = [
  'sent',
  'delivered',
  'delivery_delayed',
  'bounced',
  'complained',
] as const;
export const AdminEmailDeliveryEventSchema = z.enum(ADMIN_EMAIL_DELIVERY_EVENTS);
export type AdminEmailDeliveryEvent = z.infer<typeof AdminEmailDeliveryEventSchema>;

/** The four delivery events the summary counts. Resend's own `sent` event is left out: the
 *  ledger's `sent` already says Resend took the mail. */
export const ADMIN_EMAIL_SUMMARY_DELIVERY = [
  'delivered',
  'bounced',
  'complained',
  'delivery_delayed',
] as const;
export type AdminEmailSummaryDelivery = (typeof ADMIN_EMAIL_SUMMARY_DELIVERY)[number];

/** The delivery-status filter: a row's LATEST event type, or `none` for a row with no event. */
export const ADMIN_EMAIL_DELIVERY_FILTERS = [...ADMIN_EMAIL_DELIVERY_EVENTS, 'none'] as const;
export const AdminEmailDeliveryFilterSchema = z.enum(ADMIN_EMAIL_DELIVERY_FILTERS);
export type AdminEmailDeliveryFilter = z.infer<typeof AdminEmailDeliveryFilterSchema>;

/** The sign-in stream's events, all five. */
export const ADMIN_EMAIL_SIGN_IN_EVENTS = ADMIN_EMAIL_DELIVERY_EVENTS;

/**
 * Resend's dashboard page for one message. Resend's public docs name the Emails page
 * (`https://resend.com/emails`) but do not document the per-message path; this is the path the
 * dashboard uses as of 2026-10-02. One constant, so a change is one edit.
 */
export const RESEND_EMAIL_DASHBOARD_URL = 'https://resend.com/emails';

export function resendEmailDashboardUrl(providerMessageId: string): string {
  return `${RESEND_EMAIL_DASHBOARD_URL}/${encodeURIComponent(providerMessageId)}`;
}

// ─── Summary ──────────────────────────────────────────────────────────────────

const count = z.number().int().nonnegative();

export const AdminEmailOutcomeCountsSchema = z.object({
  sent: count,
  failed: count,
  unknown: count,
  skipped: count,
  suppressed: count,
  duplicate: count,
  paused: count,
});
export type AdminEmailOutcomeCounts = z.infer<typeof AdminEmailOutcomeCountsSchema>;

export const AdminEmailDeliveryCountsSchema = z.object({
  delivered: count,
  bounced: count,
  complained: count,
  delivery_delayed: count,
});
export type AdminEmailDeliveryCounts = z.infer<typeof AdminEmailDeliveryCountsSchema>;

export const AdminEmailWindowCountsSchema = z.object({
  outcomes: AdminEmailOutcomeCountsSchema,
  delivery: AdminEmailDeliveryCountsSchema,
});
export type AdminEmailWindowCounts = z.infer<typeof AdminEmailWindowCountsSchema>;

/** A registry email entry: what the template filter offers. `summary` is operator text from
 *  `registry.ts`, data rather than UI copy, so it is not localized. */
export const AdminEmailTemplateSchema = z.object({
  id: z.string().min(1),
  summary: z.string(),
  audience: z.enum(['external', 'operator']),
});
export type AdminEmailTemplate = z.infer<typeof AdminEmailTemplateSchema>;

/** One template with activity in the last 30 days. `registered: false` is an id the ledger
 *  holds that the registry no longer knows; its `summary` is then null. */
export const AdminEmailSummaryRowSchema = z.object({
  notification_id: z.string().min(1),
  summary: z.string().nullable(),
  audience: z.enum(['external', 'operator']).nullable(),
  registered: z.boolean(),
  d7: AdminEmailWindowCountsSchema,
  d30: AdminEmailWindowCountsSchema,
});
export type AdminEmailSummaryRow = z.infer<typeof AdminEmailSummaryRowSchema>;

export const AdminEmailSignInCountsSchema = z.object({
  sent: count,
  delivered: count,
  delivery_delayed: count,
  bounced: count,
  complained: count,
});
export type AdminEmailSignInCounts = z.infer<typeof AdminEmailSignInCountsSchema>;

export const AdminEmailSummaryResponseSchema = z.object({
  generated_at: z.string().datetime(),
  /** `tierLabel(env)`: `production`, `staging`, … */
  environment: z.string().min(1),
  templates: z.array(AdminEmailTemplateSchema),
  rows: z.array(AdminEmailSummaryRowSchema),
  /** The Supabase sign-in stream (tier `auth`). Production only; null on every other tier,
   *  which never records it. */
  sign_in: z
    .object({ d7: AdminEmailSignInCountsSchema, d30: AdminEmailSignInCountsSchema })
    .nullable(),
});
export type AdminEmailSummaryResponse = z.infer<typeof AdminEmailSummaryResponseSchema>;

// ─── The list ─────────────────────────────────────────────────────────────────

const utcDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

/** The filters both list endpoints take. Every one is optional. */
export const AdminEmailSendsFiltersSchema = PageQuerySchema.extend({
  perPage: z.coerce.number().int().min(1).max(100).default(25),
  template: z.string().min(1).max(100).optional(),
  outcome: AdminEmailSendOutcomeSchema.optional(),
  delivery: AdminEmailDeliveryFilterSchema.optional(),
  /** Inclusive UTC day, on `created_at`. */
  from: utcDate.optional(),
  /** Inclusive UTC day, on `created_at`. */
  to: utcDate.optional(),
});

const fromNotAfterTo = (v: { from?: string; to?: string }) => !v.from || !v.to || v.from <= v.to;

/** `GET /api/admin/email/sends`. An `address` key is rejected by the handler, never parsed. */
export const AdminEmailSendsQuerySchema = AdminEmailSendsFiltersSchema.refine(fromNotAfterTo, {
  message: '`from` must not be after `to`',
  path: ['from'],
});
export type AdminEmailSendsQuery = z.infer<typeof AdminEmailSendsQuerySchema>;

/** `POST /api/admin/email/sends/search` body: the filters plus one exact address. The
 *  address is matched by hash only. Validation messages never quote it. */
export const AdminEmailSearchBodySchema = AdminEmailSendsFiltersSchema.extend({
  address: z
    .string()
    .trim()
    .min(3, 'Enter a full email address')
    .max(320, 'Enter a full email address')
    .refine((v) => v.includes('@'), 'Enter a full email address'),
}).refine(fromNotAfterTo, { message: '`from` must not be after `to`', path: ['from'] });
export type AdminEmailSearchBody = z.infer<typeof AdminEmailSearchBodySchema>;

/** What a row's mail was about, with the admin page that shows it when one exists. */
export const AdminEmailEntitySchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1),
  /** An `/admin/...` path, or null when no admin page shows this type. */
  admin_path: z.string().startsWith('/admin/').nullable(),
});
export type AdminEmailEntity = z.infer<typeof AdminEmailEntitySchema>;

export const AdminEmailLatestDeliverySchema = z.object({
  event_type: AdminEmailDeliveryEventSchema,
  occurred_at: z.string(),
  bounce_type: z.string().nullable(),
  bounce_subtype: z.string().nullable(),
});
export type AdminEmailLatestDelivery = z.infer<typeof AdminEmailLatestDeliverySchema>;

export const AdminEmailSendRowSchema = z.object({
  id: z.number().int().positive(),
  notification_id: z.string().min(1),
  /** The registry summary, or null for an id the registry no longer knows. */
  summary: z.string().nullable(),
  outcome: AdminEmailSendOutcomeSchema,
  created_at: z.string(),
  provider_message_id: z.string().nullable(),
  /** The first 8 hex characters of `recipient_hash`, cut in SQL. Never the full hash. */
  recipient_hash_prefix: z.string().regex(/^[0-9a-f]{0,8}$/),
  entity: AdminEmailEntitySchema.nullable(),
  latest_delivery: AdminEmailLatestDeliverySchema.nullable(),
});
export type AdminEmailSendRow = z.infer<typeof AdminEmailSendRowSchema>;

export const AdminEmailSendsResponseSchema = paginatedResponseSchema(
  AdminEmailSendRowSchema,
).extend({
  generated_at: z.string().datetime(),
});
export type AdminEmailSendsResponse = z.infer<typeof AdminEmailSendsResponseSchema>;

/** A delivery event with no ledger row: a BCC copy, or (production) the sign-in stream. */
export const AdminEmailUnmatchedEventSchema = z.object({
  id: z.number().int().positive(),
  notification_id: z.string().min(1),
  tier: z.string().min(1),
  event_type: AdminEmailDeliveryEventSchema,
  occurred_at: z.string(),
  provider_message_id: z.string().min(1),
  bounce_type: z.string().nullable(),
  bounce_subtype: z.string().nullable(),
});
export type AdminEmailUnmatchedEvent = z.infer<typeof AdminEmailUnmatchedEventSchema>;

/** At most this many unmatched events ride a search response, newest first. */
export const ADMIN_EMAIL_UNMATCHED_EVENTS_LIMIT = 25;

export const AdminEmailSearchResponseSchema = AdminEmailSendsResponseSchema.extend({
  unmatched_events: z.array(AdminEmailUnmatchedEventSchema).max(ADMIN_EMAIL_UNMATCHED_EVENTS_LIMIT),
});
export type AdminEmailSearchResponse = z.infer<typeof AdminEmailSearchResponseSchema>;

// ─── Sending switches (AECI-1224) ─────────────────────────────────────────────
//
// `ADMIN_PANEL_SPEC.md` §5.14 "Sending switches" and §13 D24, `DATABASE_SCHEMA.md` §9.13.
// A switch pauses one email template, or the support copy, on THIS tier. No row means
// enabled. Only `pausable` entries can be paused; the server refuses the rest with
// `NOTIFICATION_NOT_PAUSABLE`.

/** The reserved key for the `EMAIL_BCC` blind copy and the operator `COPY:`. */
export const ADMIN_EMAIL_SUPPORT_COPY_KEY = 'support-copy';

export const AdminEmailSwitchKindSchema = z.enum(['notification', 'support_copy']);
export type AdminEmailSwitchKind = z.infer<typeof AdminEmailSwitchKindSchema>;

export const AdminEmailSwitchSchema = z.object({
  /** A registry id, or `support-copy`. */
  key: z.string().min(1),
  kind: AdminEmailSwitchKindSchema,
  /** The registry summary. Null for the support copy, whose copy is the UI's. */
  summary: z.string().nullable(),
  audience: z.enum(['external', 'operator']).nullable(),
  pausable: z.boolean(),
  /** False means paused on this tier. Always true for a non-pausable entry. */
  enabled: z.boolean(),
  /** When the switch last changed, or null when it never has. */
  updated_at: z.string().nullable(),
  /** The admin's profile id that changed it last, or null. */
  updated_by: z.string().nullable(),
});
export type AdminEmailSwitch = z.infer<typeof AdminEmailSwitchSchema>;

export const AdminEmailSwitchesResponseSchema = z.object({
  generated_at: z.string().datetime(),
  /** `tierLabel(env)`: a switch acts on this tier only. */
  environment: z.string().min(1),
  /** Whether `EMAIL_BCC` is set on this tier. Never its value. */
  support_copy_configured: z.boolean(),
  /** The support copy first, then every email registry entry in id order. */
  switches: z.array(AdminEmailSwitchSchema),
});
export type AdminEmailSwitchesResponse = z.infer<typeof AdminEmailSwitchesResponseSchema>;

/** `PUT /api/admin/email/switches/:key` body. Strict: nothing else is writable. */
export const SetAdminEmailSwitchBodySchema = z
  .object({
    enabled: z.boolean(),
    /** Recorded on the audit row. */
    reason: z.string().trim().max(500).optional(),
  })
  .strict();
export type SetAdminEmailSwitchBody = z.infer<typeof SetAdminEmailSwitchBodySchema>;

export const SetAdminEmailSwitchResponseSchema = z.object({
  switch: AdminEmailSwitchSchema,
  /** False when the request named the state it already had: nothing was written. */
  changed: z.boolean(),
});
export type SetAdminEmailSwitchResponse = z.infer<typeof SetAdminEmailSwitchResponseSchema>;
