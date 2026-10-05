import { z } from 'zod';

import { PageQuerySchema, paginatedResponseSchema } from './common';
import {
  RecrawlSubmissionChannelSchema,
  RecrawlSubmissionOutcomeSchema,
} from './vendor-recrawl-submissions';

/**
 * Admin re-index worklist contracts (AECI-946 / §20.2), behind `requireAdmin()`:
 *
 *   GET    /api/admin/reindex      — the worklist, most important first.
 *   DELETE /api/admin/reindex/:id  — mark one URL done and drop it, with
 *                                    `?outcome=requested|not_requested` (AECI-1185).
 *   GET    /api/admin/reindex/submissions — the search-engine submission
 *                                    history, with each submission's causes
 *                                    (AECI-1188).
 *
 * Source of truth: `ADMIN_PANEL_SPEC.md` §5.11, `API_CONTRACTS.md` §6.10,
 * `STAGE_1_SPEC.md` §20.2. The row shape mirrors `gsc_recrawl_queue`
 * (`DATABASE_SCHEMA.md` §9.8).
 *
 * ─── What this surface is for ─────────────────────────────────────────────────
 *
 * Google has no API that accepts our content types — its Indexing API is
 * documented for `JobPosting` and `BroadcastEvent` only, which is why AECI-747
 * deleted the ping we used to make. The only way to ask Google to re-fetch a
 * changed page *now* is Search Console → URL Inspection → Request Indexing, run
 * by hand, one URL at a time, against a daily quota Google does not publish.
 *
 * So this is a worklist, not a dashboard. Its entire job is: show the operator
 * the next most important URL, let them copy it in one action, let them mark it
 * done, repeat until Google stops accepting requests. Everything else is
 * decoration.
 *
 * ─── Envelope choice ──────────────────────────────────────────────────────────
 *
 * Uses the **bare** `paginatedResponseSchema` rather than `admin-panel.ts`'s
 * `.extend({ generated_at, source, notes })` console shape, per
 * `ADMIN_PANEL_SPEC.md` §6's rule for surfaces added outside the panel epic. The
 * `notes` array exists to qualify a number that might be wrong (a bot-classified
 * count, an absent credential). A queue depth cannot be qualified: the rows are
 * either there or they are not.
 */

/**
 * The lowest (least important) tier a row can carry, and the ceiling both schemas
 * validate against. Mirrors `GSC_RECRAWL_MAX_PRIORITY` in
 * `apps/api/src/lib/gsc-recrawl-priority.ts`, which is where a re-tune happens —
 * this package cannot import from the API Worker, so the two are kept in step by
 * hand and a widened tier map has to widen this too.
 */
export const REINDEX_QUEUE_MAX_PRIORITY = 4;

/** Worklist filter. Ordering is fixed — priority, then oldest first — so there
 *  is no `sort` parameter: a worklist whose order the operator can change is a
 *  worklist whose top row is no longer the right next action. */
export const ListReindexQueueQuerySchema = PageQuerySchema.extend({
  /** Show only this tier. The operator's use for it is "clear the tier-1 backlog
   *  first on a day when the quota is tight", which the default ordering already
   *  serves — so this is a convenience, not the mechanism. */
  priority: z.coerce.number().int().min(1).max(REINDEX_QUEUE_MAX_PRIORITY).optional(),
});
export type ListReindexQueueQuery = z.infer<typeof ListReindexQueueQuerySchema>;

/**
 * One URL awaiting a manual Request Indexing.
 *
 * `url` is **absolute**, deliberately. Search Console's URL Inspection bar
 * rejects a relative URL — a Domain property spans several hosts and will not
 * guess one — so the value the operator copies has to be paste-ready as-is.
 *
 * `reason` is an open string rather than a `z.enum`, matching `audit_log.action`
 * and for the same reason: nothing prunes this table on a schedule, so a row can
 * outlive the code that wrote its reason. A closed enum would make the reader
 * fail on a row it should merely render. The web client maps known values to
 * labels and falls back to humanizing the slug.
 */
export const ReindexQueueRowSchema = z.object({
  id: z.number().int().positive(),
  url: z.string().url(),
  priority: z.number().int().min(1).max(REINDEX_QUEUE_MAX_PRIORITY),
  reason: z.string().min(1),
  source: z.string().min(1),
  queued_at: z.string().datetime(),
});
export type ReindexQueueRow = z.infer<typeof ReindexQueueRowSchema>;

export const ListReindexQueueResponseSchema = paginatedResponseSchema(ReindexQueueRowSchema);
export type ListReindexQueueResponse = z.infer<typeof ListReindexQueueResponseSchema>;

/**
 * `DELETE /api/admin/reindex/:id?outcome=…` takes no body and returns `204`.
 *
 * There is deliberately no "mark done" flag and no `requested_at` column — Done
 * deletes. That is what makes an empty screen mean "genuinely nothing pending"
 * rather than "nothing pending that I have not already dismissed", which is the
 * property that makes the nav badge trustworthy at a glance. A later edit to the
 * same page inserts a fresh row, so nothing is lost.
 *
 * Since AECI-1185 the operator says what they did, and the query parameter is
 * required:
 *
 *   - `requested`: they asked Google for indexing in Search Console. The clear
 *     writes one `gsc_manual` row to `recrawl_submissions`, carrying the row's
 *     causes. This records a request, not that Google accepted or acted on it.
 *   - `not_requested`: they cleared the row without asking (the quota ran out,
 *     the page is gone, the edit was trivial). No submission row is written.
 *
 * Both outcomes write the `reindex.cleared` audit row with `metadata.outcome`.
 */
export const REINDEX_CLEAR_OUTCOMES = ['requested', 'not_requested'] as const;
export type ReindexClearOutcome = (typeof REINDEX_CLEAR_OUTCOMES)[number];

export const ClearReindexRowQuerySchema = z.object({
  outcome: z.enum(REINDEX_CLEAR_OUTCOMES),
});
export type ClearReindexRowQuery = z.infer<typeof ClearReindexRowQuerySchema>;

// ─── Submission history (AECI-1188) ───────────────────────────────────────────

/**
 * `GET /api/admin/reindex/submissions`: every URL we sent to a search engine, or
 * asked Google to re-crawl by hand, newest first, with the edits that caused it.
 * Source of truth: `ADMIN_PANEL_SPEC.md` §5.11, `API_CONTRACTS.md` §6.10,
 * `DATABASE_SCHEMA.md` §9.6a and §9.6b.
 *
 * Read-only. The backing tables are append-only evidence logs (ADR 0022), so
 * nothing on this surface writes. Wording rule as for the vendor read: these are
 * submissions and requests, never "indexed".
 */

/**
 * A real UTC calendar day. The regex checks the shape only, so `2026-13-01` and
 * `2026-02-30` pass it. The refine round-trips the label through `Date` and
 * requires it back unchanged: month 13 is an invalid date and Feb 30 rolls to
 * March, so both fail here as a 400 instead of reaching the route's day
 * arithmetic (a thrown `RangeError`, or a silently shifted window). Same check
 * as `parseUtcDay` in `apps/api/src/lib/admin-analytics.ts`, which throws an
 * `ApiError` and so cannot be reused inside a schema.
 */
const utcDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine(
    (v) => {
      const ms = Date.parse(`${v}T00:00:00.000Z`);
      return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === v;
    },
    { message: 'Not a real calendar date' },
  );

const fromNotAfterTo = (v: { from?: string; to?: string }) => !v.from || !v.to || v.from <= v.to;

/**
 * Every filter is optional and they AND together.
 *
 * - `vendorId` keeps a submission when ANY of its causes names that vendor. The
 *   row still carries all its causes, so an operator sees the other vendor on a
 *   shared pair page too.
 * - `from` / `to` are inclusive UTC days on `submitted_at`. `from` after `to` is
 *   a 400.
 *
 * Ordering is fixed newest-first, so there is no `sort` parameter.
 */
export const ListReindexSubmissionsQuerySchema = PageQuerySchema.extend({
  vendorId: z.string().min(1).max(64).optional(),
  channel: RecrawlSubmissionChannelSchema.optional(),
  outcome: RecrawlSubmissionOutcomeSchema.optional(),
  from: utcDate.optional(),
  to: utcDate.optional(),
}).refine(fromNotAfterTo, { message: '`from` must not be after `to`', path: ['from'] });
export type ListReindexSubmissionsQuery = z.infer<typeof ListReindexSubmissionsQuerySchema>;

/** A named entity a cause points at. `slug` and `name` are null when the row no
 *  longer exists: the log keeps the id and outlives the vendor or product. */
export const ReindexSubmissionEntitySchema = z.object({
  id: z.string().min(1),
  slug: z.string().nullable(),
  name: z.string().nullable(),
});
export type ReindexSubmissionEntity = z.infer<typeof ReindexSubmissionEntitySchema>;

/**
 * One edit behind a submission. `source` is `vendor` (a vendor-portal write),
 * `admin` (an admin write through the vendor seam) or `promote` (the review-app
 * promote). It is an open string, like
 * `audit_log.action`, so a row can outlive the code that wrote it; the web
 * client labels the known values. `audit_log_id` and `action` are null for a
 * promote cause, which carries `promote_job_id` instead. `vendor` is null for a
 * promote or admin cause; `product` is null when the edit touched no product.
 */
export const ReindexSubmissionCauseSchema = z.object({
  source: z.string().min(1),
  audit_log_id: z.string().nullable(),
  action: z.string().nullable(),
  vendor: ReindexSubmissionEntitySchema.nullable(),
  product: ReindexSubmissionEntitySchema.nullable(),
  promote_job_id: z.string().nullable(),
  queued_at: z.string(),
});
export type ReindexSubmissionCause = z.infer<typeof ReindexSubmissionCauseSchema>;

/**
 * One submission, with every cause it carries. `causes` is empty for a
 * submission queued before AECI-1184 shipped, or whose cause write failed.
 * `http_status` is null for a transport failure and for `gsc_manual`.
 * `priority` is the queue tier the URL was sent at, null where none was recorded.
 */
export const ReindexSubmissionRowSchema = z.object({
  id: z.number().int().positive(),
  url: z.string(),
  channel: RecrawlSubmissionChannelSchema,
  outcome: RecrawlSubmissionOutcomeSchema,
  http_status: z.number().int().nullable(),
  priority: z.number().int().nullable(),
  submitted_at: z.string(),
  causes: z.array(ReindexSubmissionCauseSchema),
});
export type ReindexSubmissionRow = z.infer<typeof ReindexSubmissionRowSchema>;

export const ListReindexSubmissionsResponseSchema = paginatedResponseSchema(
  ReindexSubmissionRowSchema,
);
export type ListReindexSubmissionsResponse = z.infer<typeof ListReindexSubmissionsResponseSchema>;
