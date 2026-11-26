import { z } from 'zod';

import { AdminNoteSchema, AdminWindowSchema } from './admin-panel';
import { PageQuerySchema, paginatedResponseSchema } from './common';

/**
 * Search console read contracts (AECI-818), behind `requireAdmin()`:
 *
 *   GET /api/admin/seo/queue — Panel 1, "Do this now": every lane's count and
 *                              one page of one lane's absolute URLs.
 *   GET /api/admin/seo/trend — Panel 2, "Am I keeping up": week over week.
 *   GET /api/admin/seo/funnel — Panel 3, "Is it working": the per-engine funnel
 *                               (AECI-823).
 *
 * Source of truth: `docs/ADMIN_PANEL_SPEC.md` §5.24, `docs/API_CONTRACTS.md`
 * §6.10 "Search console". Handlers: `apps/api/src/routes/admin-seo.ts`.
 *
 * All three are reads. They write no `audit_log` row (ADR 0022) and carry no
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
  /**
   * The age in days on the week's last sampled day. `'none'` means that day was
   * sampled and the queue held no tier-1 or tier-2 row: the snapshot writes no
   * age row then, by design. Null means the week was not recorded at all. This key
   * never falls back to an earlier day in the week, because a missing row is a
   * value ("none"), not a gap.
   */
  reindex_oldest_tier12_age_days: z.union([z.number().nonnegative(), z.literal('none')]).nullable(),
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

// ─── Panel 3: the funnel (AECI-823, §5.24.7) ─────────────────────────────────

/** The funnel's stages, in order. Google never has `indexed`: Google has no
 *  bulk index API, so its index signal is `impressed`, labelled "Indexed (lower
 *  bound)". Bing never has `impressed`: the ingest stores no Bing count of pages
 *  with an impression (§5.24.10). */
export const SeoFunnelStageNameSchema = z.enum([
  'catalog',
  'crawled',
  'indexed',
  'impressed',
  'clicked',
]);
export type SeoFunnelStageName = z.infer<typeof SeoFunnelStageNameSchema>;

/** `engine_reported` is a figure the engine reports without defining it. */
export const SeoFunnelMeasureSchema = z.enum(['measured', 'lower_bound', 'engine_reported']);
export type SeoFunnelMeasure = z.infer<typeof SeoFunnelMeasureSchema>;

export const SeoFunnelSourceSchema = z.enum(['d1', 'search_console', 'bing_webmaster']);
export type SeoFunnelSource = z.infer<typeof SeoFunnelSourceSchema>;

/** A Pacific-date window over ingested days, both ends inclusive. Google and Bing
 *  report by Pacific Time day, so these are Pacific dates, not UTC. */
export const SeoPacificWindowSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.literal('America/Los_Angeles'),
  days: z.number().int().positive(),
  /** How many of the `days` hold both a daily clicks row and a daily
   *  impressions row. The click totals cover these dates only. Fewer than
   *  `days` means the ingest has not written the whole window, for example in
   *  its first weeks, or the engine left one field out on some dates. */
  days_recorded: z.number().int().nonnegative(),
});
export type SeoPacificWindow = z.infer<typeof SeoPacificWindowSchema>;

/**
 * One stage. A stage with no data is omitted from `stages`, never zeroed.
 *
 * `count` is the stage's count. For `clicked` it is clicks. `rate` is four
 * decimals: `crawled`, `indexed` and `impressed` divide by `catalog`, and
 * `clicked` is CTR, summed clicks over summed impressions. `rate` is null on
 * `catalog`, and on any stage whose denominator is 0.
 */
export const SeoFunnelStageSchema = z.object({
  stage: SeoFunnelStageNameSchema,
  count: z.number().int().nonnegative(),
  rate: z.number().min(0).nullable(),
  measure: SeoFunnelMeasureSchema,
  source: SeoFunnelSourceSchema,
  /** `clicked` only: the summed impressions CTR divides by. */
  impressions: z.number().int().nonnegative().optional(),
  /** Google `clicked` only: impression-weighted average position over the
   *  window, one decimal, or null when no day carried a position. Bing's daily
   *  series has no position, so Bing never sets it. */
  position_avg: z.number().nonnegative().nullable().optional(),
  /** Google `impressed` and Bing `indexed` only: the Pacific date the figure was
   *  filed under. Google's 28-day count ends on it. Bing's index figure is that
   *  day's reading, the newest in the window. */
  as_of: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export type SeoFunnelStage = z.infer<typeof SeoFunnelStageSchema>;

/** Clicks, impressions, CTR and position over one window. The baseline table's
 *  row shape. */
export const SeoSearchTotalsSchema = z.object({
  clicks: z.number().int().nonnegative(),
  impressions: z.number().int().nonnegative(),
  /** Summed clicks over summed impressions, four decimals, or null at 0. */
  ctr: z.number().min(0).nullable(),
  position_avg: z.number().nonnegative().nullable(),
});
export type SeoSearchTotals = z.infer<typeof SeoSearchTotalsSchema>;

/**
 * The always-visible table under the Google funnel (Chris, 2026-11-24). Both
 * rows are the whole Domain property with no host filter, so they can be
 * compared. They are still not like for like: `reference` covers three months
 * and `current` covers 28 days.
 */
export const SeoFunnelBaselineSchema = z.object({
  scope: z.literal('property'),
  /** The last 28 ingested Pacific days of `search.google.property.*`, or null
   *  when the ingest has written none in the window. */
  current: SeoSearchTotalsSchema.extend({ window: SeoPacificWindowSchema }).nullable(),
  /** The AECI-799 baseline (`ANALYTICS_BASELINE.md`, 2026-09-09). Static. */
  reference: SeoSearchTotalsSchema.extend({
    /** The last day of the three-month Performance window. */
    window_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    window_months: z.number().int().positive(),
    /** The day the figures were read from Search Console. */
    taken_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** True when Search Console showed the impressions rounded ("15.9K"). */
    impressions_rounded: z.boolean(),
  }),
});
export type SeoFunnelBaseline = z.infer<typeof SeoFunnelBaselineSchema>;

/**
 * One engine's funnel. `scope` names the host filter every ingested stage
 * carries: Google `www_page` (filtered to `www.` by page), Bing `www` (Bing
 * registers sites per host). The two engines are never summed.
 */
export const SeoFunnelEngineSchema = z.object({
  engine: SeoEngineSchema,
  scope: z.enum(['www_page', 'www']),
  /** The click window, anchored on the daily impressions series alone, or null
   *  when no daily impressions row is in reach. Bing's `indexed` stage is read
   *  apart from it, so it can be present when this is null. */
  search_window: SeoPacificWindowSchema.nullable(),
  stages: z.array(SeoFunnelStageSchema),
  /** Google only. Null for Bing, which has no baseline (`ANALYTICS_BASELINE.md`). */
  baseline: SeoFunnelBaselineSchema.nullable(),
});
export type SeoFunnelEngine = z.infer<typeof SeoFunnelEngineSchema>;

export const SeoFunnelResponseSchema = z.object({
  generated_at: z.string().datetime(),
  /** The last complete UTC day. The D1 stages are measured to its end. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** The crawl window of the D1 stages: 28 UTC days ending at the end of `day`,
   *  clamped to `CONCRETE_PATH_SINCE`. */
  crawl_window: AdminWindowSchema,
  /** Google, then Bing. Both always present. */
  engines: z.array(SeoFunnelEngineSchema),
  notes: z.array(AdminNoteSchema),
});
export type SeoFunnelResponse = z.infer<typeof SeoFunnelResponseSchema>;
