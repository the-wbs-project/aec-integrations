import { z } from 'zod';

/**
 * The copyright notice log (AECI-1665, counsel Q38). Source of truth:
 * `ADMIN_PANEL_SPEC.md` §5.23, `API_CONTRACTS.md` §6.10 "Copyright notices",
 * `DATABASE_SCHEMA.md` §8.14 (`dmca_notices`).
 *
 *   GET   /api/admin/dmca-notices       behind `requireAdmin()`. A read: never rate-limited.
 *   POST  /api/admin/dmca-notices       behind `requireAdmin()` then `rateLimit('write')`.
 *   PATCH /api/admin/dmca-notices/:id   the same guard and limiter.
 *
 * One row is one DMCA notice or one counter-notice. A counter-notice answers one notice
 * (`notice_id`). The API computes a counter-notice's restore clock from `received_at`
 * with the business-day rules of `apps/api/src/lib/business-days.ts`, so the browser does
 * no holiday math. The log is never public.
 */

export const DMCA_NOTICE_KINDS = ['notice', 'counter_notice'] as const;
export const DmcaNoticeKindSchema = z.enum(DMCA_NOTICE_KINDS);
export type DmcaNoticeKind = z.infer<typeof DmcaNoticeKindSchema>;

/**
 * What we did with the material. `no_action`: the notice was incomplete or the material is
 * not ours. Only `removed` and `disabled` count as a takedown.
 */
export const DMCA_ACTIONS = ['pending', 'removed', 'disabled', 'no_action'] as const;
export const DmcaActionSchema = z.enum(DMCA_ACTIONS);
export type DmcaAction = z.infer<typeof DmcaActionSchema>;

/** The actions that take the material down, and so count toward repeat infringement. */
export const DMCA_TAKEDOWN_ACTIONS = [
  'removed',
  'disabled',
] as const satisfies readonly DmcaAction[];

/**
 * The one completeness rule. Every notice is logged on receipt, complete or not, so the
 * submitter's name and contact and the material may all be missing. But we cannot take
 * down material nobody identified: a `removed` or `disabled` row needs
 * `content_identified`. The create schema applies it to the body. The PATCH handler
 * applies it to the row as the edit would leave it.
 */
export function dmcaTakedownLacksContent(v: {
  action?: DmcaAction | null;
  content_identified?: string | null;
}): boolean {
  return (
    (DMCA_TAKEDOWN_ACTIONS as readonly string[]).includes(v.action ?? '') && !v.content_identified
  );
}

/** The message of {@link dmcaTakedownLacksContent}, shared by the schema and the handler. */
export const DMCA_TAKEDOWN_NEEDS_CONTENT_MESSAGE =
  'A removed or disabled notice names the material it took down';

/** How a counter-notice ended. NULL while it is open. */
export const DMCA_RESTORE_OUTCOMES = ['restored', 'not_restored'] as const;
export const DmcaRestoreOutcomeSchema = z.enum(DMCA_RESTORE_OUTCOMES);
export type DmcaRestoreOutcome = z.infer<typeof DmcaRestoreOutcomeSchema>;

/** The restore window opens at the start of this business day after receipt. */
export const DMCA_RESTORE_EARLIEST_BUSINESS_DAYS = 10;
/** The material is restored by the end of this business day after receipt. */
export const DMCA_RESTORE_LATEST_BUSINESS_DAYS = 14;

/**
 * Where a counter-notice's restore clock stands.
 *
 *   - `awaiting_forward`: not yet sent on to the complainant.
 *   - `waiting`: forwarded, and business day 10 has not started.
 *   - `restore_window_open`: business day 10 has started and business day 14 has not ended.
 *   - `overdue`: business day 14 has ended and no outcome is recorded.
 *   - `court_action`: the complainant reported a court action. Do not restore.
 *   - `restored` / `not_restored`: the outcome is recorded.
 */
export const DMCA_RESTORE_CLOCK_STATES = [
  'awaiting_forward',
  'waiting',
  'restore_window_open',
  'overdue',
  'court_action',
  'restored',
  'not_restored',
] as const;
export const DmcaRestoreClockStateSchema = z.enum(DMCA_RESTORE_CLOCK_STATES);
export type DmcaRestoreClockState = z.infer<typeof DmcaRestoreClockStateSchema>;

/** A counter-notice's restore clock, computed by the API. */
export const DmcaRestoreClockSchema = z.object({
  /** ISO instant. The start of business day 10 in New York, never early. */
  earliest: z.string(),
  /** ISO instant. The end of business day 14 in New York (`businessWindowEnd`), never early. */
  latest: z.string(),
  /** `YYYY-MM-DD`, the New York date of business day 10. For display. */
  opens_on: z.string(),
  /** `YYYY-MM-DD`, the New York date of business day 14. For display. */
  due_on: z.string(),
  state: DmcaRestoreClockStateSchema,
});
export type DmcaRestoreClock = z.infer<typeof DmcaRestoreClockSchema>;

export const DMCA_NAME_MAX = 200;
export const DMCA_CONTACT_MAX = 2000;
export const DMCA_CONTENT_MAX = 5000;
export const DMCA_WORK_MAX = 2000;
export const DMCA_NOTES_MAX = 5000;

const IsoInstant = z.string().datetime();
const Id = z.string().trim().min(1).max(100);
const Text = (max: number) => z.string().trim().min(1).max(max);

/** The fields a counter-notice may not carry on create. */
const NOTICE_ONLY = ['work_claimed'] as const;
/** The fields a notice may not carry. */
export const DMCA_COUNTER_NOTICE_ONLY_FIELDS = [
  'court_action_at',
  'restore_outcome',
  'restore_outcome_at',
] as const;

/**
 * `POST /api/admin/dmca-notices`. Strict. `notice_id` is required on a counter-notice and
 * refused on a notice. A counter-notice carries no `work_claimed`, and a notice none of
 * the counter-notice fields. The submitter's name and contact and the material are
 * optional, so an incomplete notice is still logged, except that a `removed` or
 * `disabled` action needs `content_identified` ({@link dmcaTakedownLacksContent}).
 */
export const CreateDmcaNoticeRequestSchema = z
  .object({
    kind: DmcaNoticeKindSchema,
    notice_id: Id.nullable().optional(),
    received_at: IsoInstant,
    submitter_name: Text(DMCA_NAME_MAX).nullable().optional(),
    submitter_contact: Text(DMCA_CONTACT_MAX).nullable().optional(),
    content_identified: Text(DMCA_CONTENT_MAX).nullable().optional(),
    work_claimed: Text(DMCA_WORK_MAX).nullable().optional(),
    account_id: Id.nullable().optional(),
    vendor_id: Id.nullable().optional(),
    action: DmcaActionSchema.optional(),
    action_at: IsoInstant.nullable().optional(),
    forwarded_at: IsoInstant.nullable().optional(),
    court_action_at: IsoInstant.nullable().optional(),
    restore_outcome: DmcaRestoreOutcomeSchema.nullable().optional(),
    restore_outcome_at: IsoInstant.nullable().optional(),
    closed_at: IsoInstant.nullable().optional(),
    notes: Text(DMCA_NOTES_MAX).nullable().optional(),
  })
  .strict()
  .refine((v) => v.kind !== 'counter_notice' || !!v.notice_id, {
    message: 'A counter-notice names the notice it answers',
    path: ['notice_id'],
  })
  .refine((v) => v.kind !== 'notice' || !v.notice_id, {
    message: 'A notice does not answer another notice',
    path: ['notice_id'],
  })
  .refine((v) => !dmcaTakedownLacksContent(v), {
    message: DMCA_TAKEDOWN_NEEDS_CONTENT_MESSAGE,
    path: ['content_identified'],
  })
  .superRefine((v, ctx) => {
    const banned: readonly string[] =
      v.kind === 'notice' ? DMCA_COUNTER_NOTICE_ONLY_FIELDS : NOTICE_ONLY;
    for (const field of banned) {
      if ((v as Record<string, unknown>)[field] != null) {
        ctx.addIssue({
          code: 'custom',
          message: `A ${v.kind === 'notice' ? 'notice' : 'counter-notice'} has no ${field}`,
          path: [field],
        });
      }
    }
  });
export type CreateDmcaNoticeRequest = z.infer<typeof CreateDmcaNoticeRequestSchema>;

/**
 * `PATCH /api/admin/dmca-notices/:id`. Strict. Every field is optional, `null` clears a
 * nullable one, and `expected_updated_at` is the row's `updated_at` as the page read it: a
 * mismatch is `409 DMCA_NOTICE_CHANGED`. `kind` and `notice_id` never change. The handler
 * refuses a field the row's kind does not carry (400), and a row the edit would leave
 * `removed` or `disabled` with no `content_identified` (400, {@link dmcaTakedownLacksContent}).
 */
export const UpdateDmcaNoticeRequestSchema = z
  .object({
    expected_updated_at: z.string().min(1),
    received_at: IsoInstant.optional(),
    submitter_name: Text(DMCA_NAME_MAX).nullable().optional(),
    submitter_contact: Text(DMCA_CONTACT_MAX).nullable().optional(),
    content_identified: Text(DMCA_CONTENT_MAX).nullable().optional(),
    work_claimed: Text(DMCA_WORK_MAX).nullable().optional(),
    account_id: Id.nullable().optional(),
    vendor_id: Id.nullable().optional(),
    action: DmcaActionSchema.optional(),
    action_at: IsoInstant.nullable().optional(),
    forwarded_at: IsoInstant.nullable().optional(),
    court_action_at: IsoInstant.nullable().optional(),
    restore_outcome: DmcaRestoreOutcomeSchema.nullable().optional(),
    restore_outcome_at: IsoInstant.nullable().optional(),
    closed_at: IsoInstant.nullable().optional(),
    notes: Text(DMCA_NOTES_MAX).nullable().optional(),
  })
  .strict();
export type UpdateDmcaNoticeRequest = z.infer<typeof UpdateDmcaNoticeRequestSchema>;

/** One `dmca_notices` row as the API returns it. */
export const DmcaNoticeSchema = z.object({
  id: z.string(),
  kind: DmcaNoticeKindSchema,
  notice_id: z.string().nullable(),
  received_at: z.string(),
  /** NULL when the notice did not give it. */
  submitter_name: z.string().nullable(),
  /** NULL when the notice did not give it. */
  submitter_contact: z.string().nullable(),
  /** NULL when the notice did not identify it. Never NULL on a `removed` or `disabled` row. */
  content_identified: z.string().nullable(),
  work_claimed: z.string().nullable(),
  account_id: z.string().nullable(),
  /** The account's display name, when the account exists and has one. */
  account_name: z.string().nullable(),
  vendor_id: z.string().nullable(),
  /** The vendor's company name, when the vendor exists. */
  vendor_name: z.string().nullable(),
  action: DmcaActionSchema,
  action_at: z.string().nullable(),
  forwarded_at: z.string().nullable(),
  court_action_at: z.string().nullable(),
  restore_outcome: DmcaRestoreOutcomeSchema.nullable(),
  restore_outcome_at: z.string().nullable(),
  closed_at: z.string().nullable(),
  notes: z.string().nullable(),
  created_by: z.string(),
  created_at: z.string(),
  updated_by: z.string(),
  updated_at: z.string(),
  /** On a counter-notice: the computed clock. Always null on a notice. */
  restore_clock: DmcaRestoreClockSchema.nullable(),
});
export type DmcaNotice = z.infer<typeof DmcaNoticeSchema>;

/** `GET /api/admin/dmca-notices` query. `open=true` keeps rows with no `closed_at`. */
export const DmcaNoticesQuerySchema = z.object({
  account_id: Id.optional(),
  kind: DmcaNoticeKindSchema.optional(),
  open: z.enum(['true', 'false']).optional(),
});
export type DmcaNoticesQuery = z.infer<typeof DmcaNoticesQuerySchema>;

/**
 * The per-account counts, the same numbers `/admin/users/:id` shows
 * (`AdminUserCounts.dmca_takedowns` and `dmca_counter_notices`). One predicate in
 * `apps/api/src/lib/dmca-notices.ts` computes both surfaces.
 */
export const DmcaAccountCountsSchema = z.object({
  /** Notices against the account whose material we removed or disabled, less any we
   *  restored after a counter-notice. */
  dmca_takedowns: z.number().int().min(0),
  /** Counter-notices the account filed. */
  dmca_counter_notices: z.number().int().min(0),
});
export type DmcaAccountCounts = z.infer<typeof DmcaAccountCountsSchema>;

export const DmcaNoticesResponseSchema = z.object({
  generated_at: z.string(),
  /** Most urgent restore clock first, then `received_at` newest first, then `id`. */
  notices: z.array(DmcaNoticeSchema),
  /** Present when the list is filtered by `account_id`, else null. */
  account_counts: DmcaAccountCountsSchema.nullable(),
});
export type DmcaNoticesResponse = z.infer<typeof DmcaNoticesResponseSchema>;

export const CreateDmcaNoticeResponseSchema = z.object({ notice: DmcaNoticeSchema });
export type CreateDmcaNoticeResponse = z.infer<typeof CreateDmcaNoticeResponseSchema>;

export const UpdateDmcaNoticeResponseSchema = z.object({
  notice: DmcaNoticeSchema,
  /** False when the body named the values already stored. Nothing was written then. */
  changed: z.boolean(),
});
export type UpdateDmcaNoticeResponse = z.infer<typeof UpdateDmcaNoticeResponseSchema>;
