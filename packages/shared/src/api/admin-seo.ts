import { z } from 'zod';

import { AdminNoteSchema, AdminWindowSchema } from './admin-panel';
import { PageQuerySchema, paginatedResponseSchema } from './common';

/**
 * Search console read contracts (AECI-818), behind `requireAdmin()`:
 *
 *   GET /api/admin/seo/queue — Panel 1, "Do this now": every lane's count and
 *                              one page of one lane's absolute URLs.
 *   GET /api/admin/seo/trend — Panel 2, "Am I keeping up": week over week.
 *
 * Source of truth: `docs/ADMIN_PANEL_SPEC.md` §5.24, `docs/API_CONTRACTS.md`
 * §6.10 "Search console". Handlers: `apps/api/src/routes/admin-seo.ts`.
 *
 * Both are reads. They write no `audit_log` row (ADR 0022) and carry no
 * `rateLimit()` (ADR 0026). They use the console envelope (`generated_at` and
 * `notes`), because a crawl count can be wrong in the ways §5.24.4 lists. That
 * is the opposite of `/api/admin/reindex`, whose queue depth cannot be
 * qualified.
 */

/** The two engines. Present in every shape from the start (§5.24). */
export const SeoEngineSchema = z.enum(['google', 'bing']);
export type SeoEngine = z.infer<typeof SeoEngineSchema>;

/**
 * Every lane Panel 1 lists, in the order `lanes` lists them.
 *
 * Pair pages with no reviews are NOT a lane. Chris ruled on 2026-11-24 that they
 * are a count only, shown week over week on Panel 2 (`SeoTrendLanes`). An
 * operator cannot clear such a row: it clears only when a reviewer writes a
 * review, so it is a trend and not a work list.
 */
export const SeoLaneSchema = z.enum(['reindex', 'uncrawled']);
export type SeoLane = z.infer<typeof SeoLaneSchema>;

/** The lanes whose URLs this endpoint lists. `reindex` is not one: its rows
 *  live on `/api/admin/reindex`. */
export const SeoListLaneSchema = z.enum(['uncrawled']);
export type SeoListLane = z.infer<typeof SeoListLaneSchema>;

/** Rows per page on Panel 1 (§5.24.5, "25 a page"). */
export const SEO_QUEUE_PAGE_SIZE = 25;

/** `SEO_TREND_WEEKS_DEFAULT` (§5.24.12): a quarter of weeks. */
export const SEO_TREND_WEEKS_DEFAULT = 12;
/** The `?weeks=` ceiling (§5.24.12). */
export const SEO_TREND_WEEKS_MAX = 26;

/** `?lane=&engine=` plus the page. `uncrawled` is the only listable lane today.
 *  The parameter stays so a later URL lane is additive. */
export const SeoQueueQuerySchema = PageQuerySchema.extend({
  perPage: z.coerce.number().int().min(1).max(100).default(SEO_QUEUE_PAGE_SIZE),
  lane: SeoListLaneSchema.default('uncrawled'),
  engine: SeoEngineSchema.default('google'),
});
export type SeoQueueQuery = z.infer<typeof SeoQueueQuerySchema>;

/** One lane's summary. `oldest_tier12_age_days` is set on the re-index lane only,
 *  and is null there when no tier-1 or tier-2 row exists. `href` is the admin
 *  route for a lane whose rows live elsewhere. */
export const SeoQueueLaneSchema = z.object({
  lane: SeoLaneSchema,
  engine: SeoEngineSchema,
  count: z.number().int().nonnegative(),
  oldest_tier12_age_days: z.number().nonnegative().nullable(),
  href: z.string().nullable(),
});
export type SeoQueueLane = z.infer<typeof SeoQueueLaneSchema>;

/** One URL in a lane. `page_type` is an open string, like `reindex.reason`. */
export const SeoQueueItemSchema = z.object({
  url: z.string().url(),
  page_type: z.string().min(1),
  /** The publish anchor (§5.24.5), or null for a taxonomy page. */
  published_at: z.string().datetime().nullable(),
  /** Whole days since `published_at`, or null. */
  age_days: z.number().int().nonnegative().nullable(),
  /** The newest verified fetch by the lane's engine since `CONCRETE_PATH_SINCE`,
   *  or null when it was never fetched in the record. */
  last_fetch_at: z.string().datetime().nullable(),
});
export type SeoQueueItem = z.infer<typeof SeoQueueItemSchema>;

export const SeoQueueItemsSchema = paginatedResponseSchema(SeoQueueItemSchema).extend({
  lane: SeoListLaneSchema,
  engine: SeoEngineSchema,
});
export type SeoQueueItems = z.infer<typeof SeoQueueItemsSchema>;

export const SeoQueueResponseSchema = z.object({
  generated_at: z.string().datetime(),
  /** The crawl lookback, clamped to `CONCRETE_PATH_SINCE` when it would start earlier. */
  window: AdminWindowSchema,
  lanes: z.array(SeoQueueLaneSchema),
  items: SeoQueueItemsSchema,
  notes: z.array(AdminNoteSchema),
});
export type SeoQueueResponse = z.infer<typeof SeoQueueResponseSchema>;

/** `?weeks=`, 1 to 26, default 12. */
export const SeoTrendQuerySchema = z.object({
  weeks: z.coerce.number().int().min(1).max(SEO_TREND_WEEKS_MAX).default(SEO_TREND_WEEKS_DEFAULT),
});
export type SeoTrendQuery = z.infer<typeof SeoTrendQuerySchema>;

/** Each lane's stored depth on the week's last snapshot day. Null means no row
 *  that week: not recorded, never zero (§5.24.6). */
export const SeoTrendLanesSchema = z.object({
  reindex_pending: z.number().nonnegative().nullable(),
  reindex_oldest_tier12_age_days: z.number().nonnegative().nullable(),
  uncrawled_google: z.number().nonnegative().nullable(),
  uncrawled_bing: z.number().nonnegative().nullable(),
  /** Catalog pair pages where neither endpoint has a review. A count only, never
   *  a Panel 1 lane (Chris, 2026-11-24). */
  pairs_without_reviews: z.number().nonnegative().nullable(),
});
export type SeoTrendLanes = z.infer<typeof SeoTrendLanesSchema>;

export const SeoCohortEngineSchema = z.object({
  crawled: z.number().int().nonnegative(),
  /** `crawled ÷ published`, four decimals, or null when `published` is 0. */
  rate: z.number().min(0).max(1).nullable(),
});

export const SeoTrendCohortSchema = z.object({
  published: z.number().int().nonnegative(),
  crawled_within_days: z.number().int().positive(),
  /** True while the cohort's fetch window is still open. */
  open: z.boolean(),
  google: SeoCohortEngineSchema,
  bing: SeoCohortEngineSchema,
});
export type SeoTrendCohort = z.infer<typeof SeoTrendCohortSchema>;

export const SeoTrendWeekSchema = z.object({
  /** The Monday, `YYYY-MM-DD`, UTC. */
  week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lanes: SeoTrendLanesSchema,
  cohort: SeoTrendCohortSchema,
  /** The operator's own Done-dialog answers, not a measurement. */
  requests_self_reported: z.number().int().nonnegative(),
});
export type SeoTrendWeek = z.infer<typeof SeoTrendWeekSchema>;

export const SeoTrendResponseSchema = z.object({
  generated_at: z.string().datetime(),
  /** Complete ISO weeks, newest first. The current week is never included. */
  weeks: z.array(SeoTrendWeekSchema),
  notes: z.array(AdminNoteSchema),
});
export type SeoTrendResponse = z.infer<typeof SeoTrendResponseSchema>;
