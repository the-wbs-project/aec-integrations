import { z } from 'zod';

import { LinkRefSchema, PageQuerySchema, paginatedResponseSchema } from './common';

/**
 * Admin panel read contracts (AECI-574 / Phase 8.3 P1.1) — the three endpoints
 * the rest of the operator console renders from. Source of truth:
 * `docs/ADMIN_PANEL_SPEC.md` §6, `docs/API_CONTRACTS.md` §6.10.
 *
 *   GET /api/admin/overview           — the §5.1 bundle in one round trip
 *   GET /api/admin/metrics/timeseries — a single metric, day-bucketed
 *   GET /api/admin/traffic/breakdown  — grouped counts over a window
 *
 * All three are `GET`, admin-gated (`requireAdmin()`), and **read-only**: no
 * `audit_log` row, no `Cache-Tag`, no edge caching (§6 conventions, §9.2-9.3).
 *
 * ─── Two shapes carry the design ─────────────────────────────────────────────
 *
 * **1. The honesty envelope (§1.1).** Every response carries its UTC {@link
 * AdminWindow} and an array of {@link AdminNote}s naming the biases that apply to
 * *that* window. The `code` is the contract; `message` is an untranslated
 * operator fallback. The UI renders localized prose keyed off `code` + `params`
 * — which is how "machine-readable notes rather than the UI hardcoding prose"
 * coexists with CLAUDE.md's unconditional i18n rule.
 *
 * The bias flags are **derived from the window**, never from a hardcoded
 * calendar date: `bot_classification_incomplete` fires because the window
 * actually contains `is_bot IS NULL` rows, so the note self-retires the day
 * AECI-582 runs the backfill.
 *
 * **2. Both numbers, never one (§13 D10 constraint 2).** Every traffic count is
 * an {@link AdminCount} whose `total` is ALWAYS the unfiltered figure; the
 * `ANALYTICS_INTERNAL_ASNS` read-time filter only ever *adds*
 * `excluding_internal` alongside it. A filtered figure can never masquerade as
 * *the* figure. `excluding_internal` is `null` when the var is unset (the
 * shipped default) — that null is also the UI's signal to hide the toggle.
 *
 * ─── Storage-agnostic by design ──────────────────────────────────────────────
 *
 * `source` is `'live'` today because P1.1 aggregates on every request. P2.1
 * (AECI-581) adds the `metrics_daily` snapshot table and will serve the same
 * contract with `source: 'snapshot'` — an added enum member, not a reshape.
 */

// ─── Honesty envelope ────────────────────────────────────────────────────────

/**
 * The UTC window a response covers. Half-open `[from, to)` — `from` inclusive,
 * `to` exclusive — matching the digest's `gte`/`lt` range (`analytics-digest.ts`
 * `DigestWindow`) so the two can never disagree on a boundary row.
 *
 * `timezone` is a literal, not a variable: UTC is the only window this API
 * speaks (§9.5). The WIB toggle in the UI is presentational.
 */
export const AdminWindowSchema = z.object({
  /** Inclusive start, ISO 8601 UTC. */
  from: z.string().datetime(),
  /** EXCLUSIVE end, ISO 8601 UTC. */
  to: z.string().datetime(),
  timezone: z.literal('UTC'),
  /** Whole UTC days spanned by `[from, to)`. */
  days: z.number().int().positive(),
});
export type AdminWindow = z.infer<typeof AdminWindowSchema>;

/**
 * The machine-readable caveat vocabulary. Adding a code is additive for the API
 * and requires a matching UI string; removing one is a breaking change.
 *
 * | code | means |
 * |---|---|
 * | `partial_day` | the window overlaps the current UTC day, so its last bucket is incomplete |
 * | `bot_classification_incomplete` | N rows in the window have `is_bot IS NULL` and are counted as HUMAN by the digest's `is_bot IS NOT 1` predicate (§3; AECI-582 fixes the data) |
 * | `referrer_source_incomplete` | N human rows in the window have `referrer_source IS NULL` — not backfillable, the header was never stored |
 * | `direct_is_mixed_bucket` | a `Direct` bucket is present; `PageViewTracker` POSTs on every SPA navigation and the same-origin `Referer` classifies as `Direct`, so in-app hops and true direct arrivals are indistinguishable (AECI-585 separates them) |
 * | `visitor_definition_approximate` | `unique_visitors` is `DISTINCT (user_agent_hash, cf_asn)` — over-counts on browser update, under-counts behind shared NAT (§9.8) |
 * | `catalog_series_is_additions_only` | a `catalog.*` series counts `*.created` events, never net totals — rows can vanish without per-row audit (§4) |
 * | `catalog_series_starts_at` | the window starts before the earliest `audit_log` row, so the leading segment reads zero for want of data, not for want of activity |
 * | `internal_filter_unavailable` | `ANALYTICS_INTERNAL_ASNS` is unset, so `excluding_internal` is null everywhere (the shipped default) |
 * | `internal_filter_applied` | the filter ran; both numbers are present and the excluded ASNs are in `params.asns` |
 * | `requires_recompute` | an expensive status item was omitted from the default `/overview`; re-request with `?recompute=1` |
 * | `algolia_credentials_absent` | `?recompute=1` ran but `ALGOLIA_APP_ID`/`ALGOLIA_ADMIN_KEY` are unset, so drift could not be measured |
 */
export const AdminNoteCodeSchema = z.enum([
  'partial_day',
  'bot_classification_incomplete',
  'referrer_source_incomplete',
  'direct_is_mixed_bucket',
  'visitor_definition_approximate',
  'catalog_series_is_additions_only',
  'catalog_series_starts_at',
  'internal_filter_unavailable',
  'internal_filter_applied',
  'requires_recompute',
  'algolia_credentials_absent',
]);
export type AdminNoteCode = z.infer<typeof AdminNoteCodeSchema>;

/**
 * One caveat attached to a response. `code` + `params` are the contract the UI
 * localizes against; `message` is a plain-English operator fallback for curl /
 * logs and is deliberately NOT translated.
 */
export const AdminNoteSchema = z.object({
  code: AdminNoteCodeSchema,
  severity: z.enum(['info', 'warn']),
  message: z.string().min(1),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});
export type AdminNote = z.infer<typeof AdminNoteSchema>;

/**
 * State of the `ANALYTICS_INTERNAL_ASNS` read-time filter (§13 D10). `available`
 * is false when the var is unset — the UI hides the toggle rather than showing a
 * disabled one. `applied` is whether THIS response's `excluding_internal` values
 * were actually computed.
 */
export const AdminInternalFilterSchema = z.object({
  available: z.boolean(),
  applied: z.boolean(),
  /** The configured ASNs, empty when unavailable. Surfaced so the UI can label
   *  the toggle "excluding AS23700" without a second config source. */
  asns: z.array(z.number().int().positive()),
});
export type AdminInternalFilter = z.infer<typeof AdminInternalFilterSchema>;

/**
 * A count that always reports the unfiltered figure first (§13 D10 constraint
 * 2). `excluding_internal` is null when the filter is unavailable or does not
 * apply to this metric (catalog/account series have no ASN to filter on).
 */
export const AdminCountSchema = z.object({
  /** ALWAYS the unfiltered figure. Never substitute the filtered one here. */
  total: z.number().int().nonnegative(),
  excluding_internal: z.number().int().nonnegative().nullable(),
});
export type AdminCount = z.infer<typeof AdminCountSchema>;

/**
 * A period-over-period delta with the digest's exact semantics
 * (`analytics-digest.ts` `computeDelta`, which `deltaText` also calls — so the
 * screen and the 05:00 email can never disagree). `pct` is null when `prior` is
 * 0, because a percentage against zero is meaningless; the email omits it in the
 * same case. Structured rather than prose so the UI localizes it (§9.4).
 */
export const AdminDeltaSchema = z.object({
  current: z.number().int(),
  prior: z.number().int(),
  /** `current - prior`. */
  diff: z.number().int(),
  /** Rounded percentage change, or null when `prior === 0`. */
  pct: z.number().nullable(),
});
export type AdminDelta = z.infer<typeof AdminDeltaSchema>;

/** Where the numbers came from. P2.1 adds `'snapshot'`; the shape does not change. */
export const AdminMetricSourceSchema = z.enum(['live']);
export type AdminMetricSource = z.infer<typeof AdminMetricSourceSchema>;

// ─── GET /api/admin/overview ─────────────────────────────────────────────────

/**
 * `?day=YYYY-MM-DD` reports that single UTC day; omitted, the endpoint reports
 * the prior COMPLETE UTC day — the same window `dailyWindows()` gives the 05:00
 * digest, which is what makes the parity assertion meaningful by default.
 *
 * `?recompute=1` (§13 D8) runs the two expensive status items — the ten
 * data-quality checks and the Algolia drift count — which the default response
 * omits as `null` + a `requires_recompute` note. It is still a pure read: it
 * writes nothing, sends no email, and carries no `audit_log` obligation.
 */
export const AdminOverviewQuerySchema = z.object({
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
    .optional(),
  recompute: z
    .enum(['0', '1'])
    .default('0')
    .transform((v) => v === '1'),
});
export type AdminOverviewQuery = z.infer<typeof AdminOverviewQuerySchema>;

/** One day in the 30-day human/bot traffic chart. `day` is `YYYY-MM-DD` (UTC). */
export const AdminTrafficPointSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  human: z.number().int().nonnegative(),
  bot: z.number().int().nonnegative(),
});
export type AdminTrafficPoint = z.infer<typeof AdminTrafficPointSchema>;

/** A traffic source (`referrer_source`) and its human view count. `source` is
 *  null for rows captured before the referrer classifier shipped. */
export const AdminSourceCountSchema = z.object({
  source: z.string().nullable(),
  views: z.number().int().nonnegative(),
});
export type AdminSourceCount = z.infer<typeof AdminSourceCountSchema>;

/**
 * A product and its human view count. Deliberately `{ name, slug, views }` and
 * not a `LinkRef`: this is the digest's own `TopProduct` shape passed straight
 * through, and `/products/:slug` is the link target, so an `id` would buy nothing
 * and would mean widening the digest's query for the panel's benefit. The
 * `dimension=product` breakdown, which groups by id anyway, does hydrate a full
 * `LinkRef`.
 */
export const AdminProductViewsSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  views: z.number().int().nonnegative(),
});
export type AdminProductViews = z.infer<typeof AdminProductViewsSchema>;

/** SSR/API deploy identity — the API Worker's own `/api/version` values. The SSR
 *  Worker's `/_version` is read separately by the UI (they differ precisely so a
 *  stale SSR deploy is detectable — AECI-92). */
export const AdminVersionStatusSchema = z.object({
  sha: z.string(),
  deployed_at: z.string(),
  environment: z.string(),
});
export type AdminVersionStatus = z.infer<typeof AdminVersionStatusSchema>;

/** `stats_cache` freshness — the 07:00 home-stats cron's liveness signal.
 *  `computed_at` is null on an empty cache (nothing has run yet). */
export const AdminStatsFreshnessSchema = z.object({
  computed_at: z.string().datetime().nullable(),
  age_hours: z.number().nullable(),
  /** Older than the data-quality suite's 48h threshold. */
  stale: z.boolean(),
});
export type AdminStatsFreshness = z.infer<typeof AdminStatsFreshnessSchema>;

/** Queue depths an operator acts on today. */
export const AdminModerationDepthSchema = z.object({
  pending_reviews: z.number().int().nonnegative(),
  open_requests: z.number().int().nonnegative(),
});
export type AdminModerationDepth = z.infer<typeof AdminModerationDepthSchema>;

/** One data-quality check's outcome — the wire form of `DataQualityCheckResult`
 *  (`apps/api/src/lib/data-quality.ts`). `sample` is capped at 10 lines by the
 *  suite itself. */
export const AdminDataQualityCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  severity: z.enum(['error', 'warn', 'info']),
  count: z.number().int().nonnegative(),
  sample: z.array(z.string()),
  note: z.string().optional(),
  skipped: z.boolean().optional(),
  error: z.string().optional(),
});
export type AdminDataQualityCheck = z.infer<typeof AdminDataQualityCheckSchema>;

/** The ten checks, run live. `failing` counts checks with findings OR an error —
 *  a skipped check (no creds) is not a failure. */
export const AdminDataQualityStatusSchema = z.object({
  failing: z.number().int().nonnegative(),
  checks: z.array(AdminDataQualityCheckSchema),
});
export type AdminDataQualityStatus = z.infer<typeof AdminDataQualityStatusSchema>;

/** Per-index Algolia drift: `drift = database - algolia` (positive = the index
 *  is missing rows; negative = orphans). */
export const AdminAlgoliaIndexDriftSchema = z.object({
  entity: z.string(),
  index_name: z.string(),
  database: z.number().int().nonnegative(),
  algolia: z.number().int().nonnegative(),
  drift: z.number().int(),
});
export type AdminAlgoliaIndexDrift = z.infer<typeof AdminAlgoliaIndexDriftSchema>;

export const AdminAlgoliaDriftStatusSchema = z.object({
  drifted: z.number().int().nonnegative(),
  indexes: z.array(AdminAlgoliaIndexDriftSchema),
});
export type AdminAlgoliaDriftStatus = z.infer<typeof AdminAlgoliaDriftStatusSchema>;

/**
 * The §5.1 status strip. The first three are cheap D1/env reads and are always
 * present. The last two need the network (a logo probe and three Algolia
 * queries) and are `null` on the default response with a `requires_recompute`
 * note — `?recompute=1` fills them.
 */
export const AdminStatusStripSchema = z.object({
  version: AdminVersionStatusSchema,
  stats_freshness: AdminStatsFreshnessSchema,
  moderation: AdminModerationDepthSchema,
  data_quality: AdminDataQualityStatusSchema.nullable(),
  algolia_drift: AdminAlgoliaDriftStatusSchema.nullable(),
});
export type AdminStatusStrip = z.infer<typeof AdminStatusStripSchema>;

/** Traffic block. `page_views_human` / `delta_day` / `top_sources` /
 *  `top_products` are the digest's own numbers (via `collectAnalyticsMetrics`);
 *  the rest are panel-only additions. */
export const AdminOverviewTrafficSchema = z.object({
  page_views_human: AdminCountSchema,
  page_views_bot: AdminCountSchema,
  /** DISTINCT `(user_agent_hash, cf_asn)` among HUMAN rows in the window (§9.8). */
  unique_visitors: AdminCountSchema,
  /** Human page views, this day vs the prior day — the digest's delta. */
  delta_day: AdminDeltaSchema,
  /** Human page views, the 7 days ending with this one vs the 7 before that. */
  delta_7d: AdminDeltaSchema,
  /** 30 UTC days ending with the reported day, zero-filled. */
  series_30d: z.array(AdminTrafficPointSchema),
  top_sources: z.array(AdminSourceCountSchema),
  top_products: z.array(AdminProductViewsSchema),
});
export type AdminOverviewTraffic = z.infer<typeof AdminOverviewTrafficSchema>;

export const AdminOverviewAudienceSchema = z.object({
  /** New `profiles` rows — a profile is created on first sign-in. */
  new_sign_ins: AdminDeltaSchema,
  total_users: z.number().int().nonnegative(),
  /** `mailing_list` rows with `unsubscribed_at IS NULL` (a live snapshot, not
   *  windowed — `unsubscribed_at` is a soft delete, AECI-537). */
  active_subscribers: z.number().int().nonnegative(),
});
export type AdminOverviewAudience = z.infer<typeof AdminOverviewAudienceSchema>;

/** Live catalog totals — a snapshot as of the request, NOT windowed. Counts over
 *  time are §7.1's problem (P2.1); see `catalog_series_is_additions_only`. */
export const AdminOverviewCatalogSchema = z.object({
  products: z.number().int().nonnegative(),
  integrations: z.number().int().nonnegative(),
  vendors: z.number().int().nonnegative(),
  claims: z.number().int().nonnegative(),
  attestations: z.number().int().nonnegative(),
});
export type AdminOverviewCatalog = z.infer<typeof AdminOverviewCatalogSchema>;

export const AdminOverviewResponseSchema = z.object({
  window: AdminWindowSchema,
  generated_at: z.string().datetime(),
  source: AdminMetricSourceSchema,
  /** True when `?recompute=1` was passed and the expensive status items ran. */
  recomputed: z.boolean(),
  notes: z.array(AdminNoteSchema),
  internal_filter: AdminInternalFilterSchema,
  traffic: AdminOverviewTrafficSchema,
  audience: AdminOverviewAudienceSchema,
  catalog: AdminOverviewCatalogSchema,
  status: AdminStatusStripSchema,
});
export type AdminOverviewResponse = z.infer<typeof AdminOverviewResponseSchema>;

// ─── GET /api/admin/metrics/timeseries ───────────────────────────────────────

/**
 * The metric vocabulary, using §7.1's `namespace.metric` convention so P2.1's
 * `metrics_daily` keys are these strings verbatim.
 *
 * `catalog.*` are **additions**, sourced from `audit_log` `*.created` events per
 * §5.5 — deliberately not net totals, which §4 shows are unrecoverable (827
 * `integration.created` events back 496 live rows). Every `catalog.*` response
 * carries `catalog_series_is_additions_only` so the chart cannot be misread.
 */
export const AdminMetricKeySchema = z.enum([
  'traffic.page_views_human',
  'traffic.page_views_bot',
  /** HUMANS only, and note it does NOT sum: each bucket is its own
   *  `COUNT(DISTINCT …)`, so a visitor active on three days counts three times in
   *  the window total. The window-distinct figure is the overview's
   *  `unique_visitors`, which covers a single day. */
  'traffic.unique_visitors',
  'catalog.products_created',
  'catalog.integrations_created',
  'catalog.vendors_created',
  'catalog.claims_created',
  'accounts.sign_ins_new',
]);
export type AdminMetricKey = z.infer<typeof AdminMetricKeySchema>;

/** Longest window the API will aggregate, matching §7.4's 400-day `page_views`
 *  retention: asking for more than is retained can only mislead. */
export const ADMIN_METRICS_MAX_DAYS = 400;

const utcDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

/**
 * `from` / `to` are UTC calendar dates and are **both inclusive** — `from=to`
 * is a valid single-day range. The response's `window.to` reports the resulting
 * exclusive instant so the boundary is never ambiguous.
 *
 * `interval` has one value today. `metrics_daily` (P2.1) stores per-day rows, so
 * week/month roll-ups are a later additive extension, not a reshape.
 */
export const AdminTimeseriesQuerySchema = z.object({
  metric: AdminMetricKeySchema,
  from: utcDate,
  to: utcDate,
  interval: z.enum(['day']).default('day'),
  exclude_internal: z
    .enum(['0', '1'])
    .default('0')
    .transform((v) => v === '1'),
});
export type AdminTimeseriesQuery = z.infer<typeof AdminTimeseriesQuerySchema>;

/** One bucket. `value_excluding_internal` is null unless the metric is
 *  `traffic.*` AND the filter was applied. */
export const AdminTimeseriesPointSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  value: z.number().nonnegative(),
  value_excluding_internal: z.number().nonnegative().nullable(),
});
export type AdminTimeseriesPoint = z.infer<typeof AdminTimeseriesPointSchema>;

/** Every day in the window appears in `points`, zero-filled — a chart should
 *  never have to infer a gap. */
export const AdminTimeseriesResponseSchema = z.object({
  metric: AdminMetricKeySchema,
  interval: z.enum(['day']),
  window: AdminWindowSchema,
  generated_at: z.string().datetime(),
  source: AdminMetricSourceSchema,
  notes: z.array(AdminNoteSchema),
  internal_filter: AdminInternalFilterSchema,
  points: z.array(AdminTimeseriesPointSchema),
  total: AdminCountSchema,
});
export type AdminTimeseriesResponse = z.infer<typeof AdminTimeseriesResponseSchema>;

// ─── GET /api/admin/traffic/breakdown ────────────────────────────────────────

export const AdminBreakdownDimensionSchema = z.enum([
  'source',
  'country',
  'path',
  'product',
  'bot',
]);
export type AdminBreakdownDimension = z.infer<typeof AdminBreakdownDimensionSchema>;

/**
 * Which population to group. Default `human` matches §5.2's filter default.
 * `dimension=bot` forces `bot` regardless — grouping human rows by `bot_name`
 * would return one empty bucket.
 */
export const AdminTrafficPopulationSchema = z.enum(['human', 'bot', 'all']);
export type AdminTrafficPopulation = z.infer<typeof AdminTrafficPopulationSchema>;

/** Extends `PageQuerySchema` so the list shape matches `/api/admin/requests`
 *  (§6). Pagination is over GROUPS, not rows. */
export const AdminTrafficBreakdownQuerySchema = PageQuerySchema.extend({
  dimension: AdminBreakdownDimensionSchema,
  from: utcDate,
  to: utcDate,
  traffic: AdminTrafficPopulationSchema.default('human'),
  exclude_internal: z
    .enum(['0', '1'])
    .default('0')
    .transform((v) => v === '1'),
});
export type AdminTrafficBreakdownQuery = z.infer<typeof AdminTrafficBreakdownQuerySchema>;

/**
 * One group. `key` is the raw grouped column value and is **null for the
 * unattributed bucket** (a NULL `referrer_source` / `cf_country`), which is
 * surfaced rather than dropped so the page reconciles against `window_total`.
 * `ref` is hydrated only for `dimension=product`.
 */
export const AdminBreakdownRowSchema = z.object({
  key: z.string().nullable(),
  label: z.string().min(1),
  ref: LinkRefSchema.nullable(),
  views: z.number().int().nonnegative(),
  views_excluding_internal: z.number().int().nonnegative().nullable(),
});
export type AdminBreakdownRow = z.infer<typeof AdminBreakdownRowSchema>;

/**
 * `data` / `page` / `perPage` / `total` are the standard paginated envelope —
 * `total` is the number of distinct GROUPS. `window_total` is the total view
 * count in the window for the selected population, so a row's share is
 * computable without a second request.
 */
export const AdminTrafficBreakdownResponseSchema = paginatedResponseSchema(
  AdminBreakdownRowSchema,
).extend({
  dimension: AdminBreakdownDimensionSchema,
  traffic: AdminTrafficPopulationSchema,
  window: AdminWindowSchema,
  generated_at: z.string().datetime(),
  source: AdminMetricSourceSchema,
  notes: z.array(AdminNoteSchema),
  internal_filter: AdminInternalFilterSchema,
  window_total: AdminCountSchema,
});
export type AdminTrafficBreakdownResponse = z.infer<typeof AdminTrafficBreakdownResponseSchema>;
