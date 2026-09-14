import { z } from 'zod';

import { PageQuerySchema, paginatedResponseSchema } from './common';

/**
 * Admin re-index worklist contracts (AECI-946 / §20.2), behind `requireAdmin()`:
 *
 *   GET    /api/admin/reindex      — the worklist, most important first.
 *   DELETE /api/admin/reindex/:id  — mark one URL done and drop it.
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
 * `DELETE /api/admin/reindex/:id` takes no body and returns `204`.
 *
 * There is deliberately no "mark done" flag and no `requested_at` column — Done
 * deletes. That is what makes an empty screen mean "genuinely nothing pending"
 * rather than "nothing pending that I have not already dismissed", which is the
 * property that makes the nav badge trustworthy at a glance. A later edit to the
 * same page inserts a fresh row, so nothing is lost.
 */
