import { z } from 'zod';

import { LinkRefSchema, PageQuerySchema, paginatedResponseSchema } from './common';

/**
 * Admin panel read contracts (AECI-574 / Phase 8.3 P1.1, extended by AECI-577 /
 * P1.3, AECI-579 / P1.5, and AECI-580 / P1.6) — the endpoints the rest of the
 * operator console renders from. Source of
 * truth: `docs/ADMIN_PANEL_SPEC.md` §6, `docs/API_CONTRACTS.md` §6.10.
 *
 *   GET /api/admin/overview           — the §5.1 bundle in one round trip
 *   GET /api/admin/metrics/timeseries — a single metric, day-bucketed
 *   GET /api/admin/traffic/breakdown  — grouped counts over a window
 *   GET /api/admin/page-views         — the §5.2 Activity feed, row by row
 *   GET /api/admin/catalog/coverage   — the §5.5 gap lists, funnel, and taxonomy usage
 *   GET /api/admin/system             — the §5.6 bundle (AECI-580)
 *
 * All are `GET`, admin-gated (`requireAdmin()`), and **read-only**: no
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
 * actually contains `is_bot IS NULL` rows, so the note self-retired the day
 * AECI-582 backfilled them (2026-08-13). It stays in the contract because a
 * future ingest gap re-opens the same hole.
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
 * | `bot_classification_incomplete` | N rows in the window have `is_bot IS NULL` and are counted as HUMAN by the digest's `is_bot IS NOT 1` predicate (§3). Dormant since AECI-582 backfilled every row on 2026-08-13 |
 * | `referrer_source_incomplete` | N human rows in the window have `referrer_source IS NULL` — not backfillable, the header was never stored |
 * | `direct_is_mixed_bucket` | a `Direct` bucket is present; `PageViewTracker` POSTs on every SPA navigation and the same-origin `Referer` classifies as `Direct`, so in-app hops and true direct arrivals are indistinguishable (AECI-585 separates them) |
 * | `visitor_definition_approximate` | `unique_visitors` is `DISTINCT (user_agent_hash, cf_asn)` — over-counts on browser update, under-counts behind shared NAT (§9.8) |
 * | `catalog_series_is_additions_only` | a `catalog.*` series counts `*.created` events, never net totals — rows can vanish without per-row audit (§4) |
 * | `catalog_series_starts_at` | the window starts before the earliest `audit_log` row, so the leading segment reads zero for want of data, not for want of activity |
 * | `internal_filter_unavailable` | `ANALYTICS_INTERNAL_ASNS` is unset, so `excluding_internal` is null everywhere (the shipped default) |
 * | `internal_filter_applied` | the filter ran; both numbers are present and the excluded ASNs are in `params.asns` |
 * | `requires_recompute` | an expensive status item was omitted from the default `/overview` or `/system`; re-request with `?recompute=1` |
 * | `algolia_credentials_absent` | `?recompute=1` ran but `ALGOLIA_APP_ID`/`ALGOLIA_ADMIN_KEY` are unset, so drift could not be measured |
 * | `funnel_is_promoted_cohort_only` | every `products` row reads `promotion_status='promoted'`, so the funnel has exactly one populated stage — the pre-promotion stages live in the review app, not D1 (§13 D6) |
 * | `trade_facet_sparse_by_design` | products carry no `trade` tag and that is not by itself a defect: `TRADES_VOCABULARY.md` §1.1 tags a product only when it has trade-SPECIFIC value, so horizontal platforms correctly carry zero rows |
 * | `api_docs_flag_inconsistent` | N products have `has_api_docs = 1` but no `api_docs_url` — the flag and the artifact disagree |
 * | `series_partly_reconstructed` | some days in the window come from the P2.1 backfill rather than a same-day snapshot, and are approximate (§4); `params.reconstructed_days` counts them and `params.reconstructed_through` is the last such day |
 * | `cron_liveness_unavailable` | `job_runs` (§7.2) does not exist yet, so N of the nine crons have NO last-run record in D1 — Datadog is the only source (AECI-583 fixes this) |
 * | `orphan_sweep_not_persisted` | the Algolia orphan sweep's result is written nowhere today; it runs inside the 09:00 drift cron and reports only to Datadog (AECI-583) |
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
  'funnel_is_promoted_cohort_only',
  'trade_facet_sparse_by_design',
  'api_docs_flag_inconsistent',
  'series_partly_reconstructed',
  'cron_liveness_unavailable',
  'orphan_sweep_not_persisted',
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
 *
 * **One endpoint reads `applied` differently**, and deliberately:
 * {@link AdminPageViewsResponseSchema} is a row feed, not a count, so there the
 * flag means *"the row list was filtered"*. Its counts are computed both ways
 * unconditionally — see that schema's docblock for why.
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

/**
 * Where the numbers came from.
 *
 * - `live` — aggregated over `page_views` / `audit_log` / `profiles` on this request.
 * - `snapshot` — every day in the window came from `metrics_daily` (P2.1 / §7.1).
 * - `mixed` — some days from the snapshot, the rest aggregated live.
 *
 * `mixed` is not an edge case: the current UTC day is never snapshotted (the
 * cron writes the prior COMPLETE day), so any window reaching today is mixed by
 * construction. This is a provenance axis and is deliberately separate from
 * {@link AdminTimeseriesPointSchema}'s `reconstructed`, which is about
 * exactness — a snapshot row can be either.
 */
export const AdminMetricSourceSchema = z.enum(['live', 'snapshot', 'mixed']);
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

/** Deploy identity — the **API Worker's** own `/api/version` values, read from
 *  the same `COMMIT_SHA` / `DEPLOYED_AT` / `ENV` vars by the same Worker, so this
 *  and `GET /api/version` can never disagree. The SSR Worker's `/_version` is
 *  fetched separately by the UI and compared against this (they exist as two
 *  endpoints precisely so a stale SSR deploy is detectable — AECI-92); nothing
 *  reachable from the API Worker knows the SSR Worker's SHA. */
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
export const ADMIN_METRIC_KEYS = [
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
] as const;

export const AdminMetricKeySchema = z.enum(ADMIN_METRIC_KEYS);
export type AdminMetricKey = z.infer<typeof AdminMetricKeySchema>;

/**
 * The **stock** half of the `metrics_daily` vocabulary (P2.1 / §7.1): an
 * instantaneous count sampled once a day, as against the *flow* keys above,
 * which count events inside a day.
 *
 * These are written by the snapshot cron but are **not yet readable** through
 * `GET /api/admin/metrics/timeseries` — {@link AdminMetricKeySchema} is
 * deliberately still the endpoint's vocabulary. They are captured from day one
 * anyway because a stock is unrecoverable retroactively: §4 shows the audit log
 * cannot reproduce a past total (827 `integration.created` events back 496 live
 * rows), so any day not sampled is lost permanently. §5.4 (Audience) and §5.5
 * (Catalog "counts over time") are the screens that will read them.
 *
 * The key names state their own filter — `*_promoted` where the table carries a
 * `promotion_status` gate, `*_total` where it does not. `queue.requests_open`
 * uses the same `status='open'` predicate as the overview's `open_requests`
 * ({@link AdminModerationDepthSchema}), so the two can never disagree.
 */
export const ADMIN_SNAPSHOT_STOCK_METRIC_KEYS = [
  'catalog.products_promoted',
  'catalog.vendors_promoted',
  'catalog.integrations_total',
  'catalog.claims_total',
  /** `approved` only — the canonical `COUNTED_REVIEW_STATUS`, matching the public
   *  review APIs and `products.review_count`. */
  'catalog.reviews_approved',
  'accounts.profiles_total',
  /** `unsubscribed_at IS NULL`. Paired with the key below, churn is exact. */
  'audience.subscribers_active',
  'audience.subscribers_unsubscribed',
  'audience.feedback_total',
  'queue.reviews_pending',
  'queue.requests_open',
] as const;

/**
 * Every metric the P2.1 snapshot cron writes to `metrics_daily`, flows first.
 *
 * Built by spreading {@link ADMIN_METRIC_KEYS} rather than re-listing it, so the
 * endpoint's vocabulary is a **structural** subset of the snapshot's — a key
 * added to the endpoint that the cron does not write is impossible by
 * construction, rather than caught by a reviewer.
 */
export const ADMIN_SNAPSHOT_METRIC_KEYS = [
  ...ADMIN_METRIC_KEYS,
  ...ADMIN_SNAPSHOT_STOCK_METRIC_KEYS,
] as const;

export const AdminSnapshotMetricKeySchema = z.enum(ADMIN_SNAPSHOT_METRIC_KEYS);
export type AdminSnapshotMetricKey = (typeof ADMIN_SNAPSHOT_METRIC_KEYS)[number];

/**
 * Provenance of one `metrics_daily` row (§7.1, as shipped).
 *
 * §7.1 sketched four columns and proposed marking a backfilled row through its
 * `computed_at`; that heuristic mislabels a legitimate late re-run of a *missed*
 * day, whose sources are still intact, as approximate. A stored column says it
 * outright and yields one precedence rule the cron and the backfill both obey:
 * **a `measured` write always wins; a `reconstructed` write applies only when
 * the existing row is absent or itself `reconstructed`.** That is what makes the
 * backfill re-runnable without ever corrupting a real snapshot.
 */
export const ADMIN_SNAPSHOT_SOURCES = ['measured', 'reconstructed'] as const;
export const AdminSnapshotSourceSchema = z.enum(ADMIN_SNAPSHOT_SOURCES);
export type AdminSnapshotSource = (typeof ADMIN_SNAPSHOT_SOURCES)[number];

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

/**
 * One bucket. `value_excluding_internal` is null unless the metric is
 * `traffic.*` AND the filter was applied.
 *
 * `reconstructed` is **per point, not per response**, because a window can span
 * the snapshot boundary and a response-level flag could not say which days it
 * applied to. True means the value came from P2.1's backfill of a day that
 * predates the snapshot cron and could only be approximated (§4: 827
 * `integration.created` events back 496 live rows). False means it was measured
 * — either snapshotted on the day, or aggregated live from rows that still
 * exist. Blending the two without saying so is what §1.1 forbids.
 */
export const AdminTimeseriesPointSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  value: z.number().nonnegative(),
  value_excluding_internal: z.number().nonnegative().nullable(),
  reconstructed: z.boolean(),
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

// ─── GET /api/admin/system (AECI-580 / P1.6) ─────────────────────────────────

/**
 * The §5.6 bundle: deploy identity, cron liveness, the ten data-quality checks,
 * Algolia state, and D1 size + row counts — "effectively the daily procedure in
 * `POST_LAUNCH_MONITORING.md` turned into one screen".
 *
 * ─── Why so much of this is nullable ─────────────────────────────────────────
 *
 * Two different reasons, and the UI must not conflate them:
 *
 * **1. Deferred by cost.** `data_quality` and `algolia.drift` are `null` on the
 * default response and filled by `?recompute=1`, exactly as on `/overview` — the
 * data-quality suite HTTP-probes a sample of logo URLs and drift costs three
 * Algolia queries, neither of which should ride a dashboard poll. Still a pure
 * read: §13 **D8** draws the line at side effects, not manual-ness, so this
 * writes nothing, sends nothing, and carries no `audit_log` obligation.
 *
 * **2. Genuinely unrecorded.** Cron outcomes and the orphan-sweep result do not
 * exist in D1 at all until `job_runs` lands (§7.2 / AECI-583); today they live
 * only as Datadog metrics. These are `null` with an accompanying note, and
 * {@link AdminCronRunSchema}'s `source` discriminator exists so the UI renders
 * them as *unknown* rather than as a passing check. A status screen that reports
 * "fine" because it has no data is worse than one that reports nothing.
 */

/**
 * The nine cron jobs in `apps/api/src/scheduled.ts`, as a closed vocabulary.
 * These are the ids `job_runs.job` will carry (§7.2), so AECI-583 persists
 * against these strings rather than inventing a second naming. `metrics-snapshot`
 * is the ninth, added with the §7.1 snapshot cron (AECI-581).
 */
export const AdminCronJobSchema = z.enum([
  'metrics-snapshot', // 15 0 * * *
  'data-quality', // 0 4 * * *
  'analytics-digest', // 0 5 * * *
  'moderation-snapshot', // 0 6 * * *
  'home-stats', // 0 7 * * *
  'algolia-sync', // 0 8 * * *
  'algolia-drift', // 0 9 * * *
  'request-reconcile', // */15 * * * *
  'waf-poll', // 0 * * * *
]);
export type AdminCronJob = z.infer<typeof AdminCronJobSchema>;

/**
 * Where a cron row's last-run information came from — the field that stops the
 * screen lying.
 *
 * | value | means |
 * |---|---|
 * | `job_runs` | read from the §7.2 table. **Unreachable until AECI-583**; declared now so adding it is not a reshape |
 * | `derived` | inferred from a D1 side effect the job leaves behind (`derived_from` names it). Proves the job RAN; says nothing about whether it SUCCEEDED, so `last_outcome` stays null |
 * | `unknown` | no record exists anywhere in D1. The UI renders "Unknown", never a tick |
 */
export const AdminCronRunSourceSchema = z.enum(['job_runs', 'derived', 'unknown']);
export type AdminCronRunSource = z.infer<typeof AdminCronRunSourceSchema>;

/**
 * One cron's liveness row. All nine are ALWAYS present — a job missing from the
 * array would read as "not configured", which is a different and wrong claim
 * from "we have no record of its last run".
 */
export const AdminCronRunSchema = z.object({
  job: AdminCronJobSchema,
  /** The 5-field cron expression, byte-equal to `wrangler.jsonc`'s
   *  `triggers.crons` entry (the handler imports the same constants
   *  `scheduled.ts` declares, so the two cannot desync). */
  schedule: z.string().min(1),
  source: AdminCronRunSourceSchema,
  last_run_at: z.string().datetime().nullable(),
  /** Null on every row today: `job_runs` does not exist, and a `derived`
   *  timestamp attests to the run, not to its outcome. */
  last_outcome: z.enum(['ok', 'failed', 'skipped']).nullable(),
  duration_ms: z.number().int().nonnegative().nullable(),
  /** The D1 artifact `source: 'derived'` was read from, e.g.
   *  `stats_cache.computed_at`. Null otherwise — surfaced so the UI can qualify
   *  the timestamp instead of presenting an inference as a record. */
  derived_from: z.string().nullable(),
});
export type AdminCronRun = z.infer<typeof AdminCronRunSchema>;

/**
 * The incremental Algolia sync's watermark (`stats_cache['algolia_sync_watermark']`
 * — `apps/api/src/lib/algolia-sync.ts`). `computed_at` is the row's own stamp,
 * i.e. the last time the sync advanced the fence; `entities` is the per-entity
 * ISO cursor. A never-run sync has no row at all → the whole object is null, not
 * a fabricated epoch.
 */
export const AdminAlgoliaWatermarkSchema = z.object({
  computed_at: z.string().datetime().nullable(),
  entities: z.array(
    z.object({
      entity: z.string().min(1),
      watermark: z.string().nullable(),
    }),
  ),
});
export type AdminAlgoliaWatermark = z.infer<typeof AdminAlgoliaWatermarkSchema>;

/**
 * Algolia state. `drift` is null unless `?recompute=1` (cost). `orphan_sweep` is
 * null **always**, for a different reason: the sweep runs inside the 09:00 drift
 * cron and reports only to Datadog — nothing persists its result, so there is no
 * D1 read that could fill it. AECI-583 stores it in `job_runs.detail`; the slot
 * is declared now so filling it later is additive. It is accompanied by an
 * `orphan_sweep_not_persisted` note.
 */
export const AdminAlgoliaStatusSchema = z.object({
  watermark: AdminAlgoliaWatermarkSchema.nullable(),
  drift: AdminAlgoliaDriftStatusSchema.nullable(),
  orphan_sweep: z.null(),
});
export type AdminAlgoliaStatus = z.infer<typeof AdminAlgoliaStatusSchema>;

export const AdminTableCountSchema = z.object({
  table: z.string().min(1),
  rows: z.number().int().nonnegative(),
});
export type AdminTableCount = z.infer<typeof AdminTableCountSchema>;

/**
 * D1 footprint. `tables` is every user table (SQLite/Cloudflare internals and
 * `d1_migrations` excluded), name-ordered, enumerated from `sqlite_master` at
 * request time rather than from a hardcoded list — so a table added by a
 * migration appears without a code change.
 *
 * `size_bytes` comes from D1's own `meta.size_after` and is null where that is
 * unavailable (notably the better-sqlite3 test harness). Null renders as
 * "unknown"; it is never approximated from the row counts.
 */
export const AdminDatabaseStatusSchema = z.object({
  size_bytes: z.number().int().nonnegative().nullable(),
  tables: z.array(AdminTableCountSchema),
});
export type AdminDatabaseStatus = z.infer<typeof AdminDatabaseStatusSchema>;

/**
 * `?recompute=1` (§13 **D8**) re-runs the ten §23.1 checks and the drift count
 * live. Pure read — it writes nothing, sends no email, and carries no
 * `audit_log` obligation, which is what keeps §6's "all endpoints are GET,
 * read-only" unconditionally true. The side-effecting
 * `POST /api/admin/jobs/:job/run` stays deferred; do not add one.
 */
export const AdminSystemQuerySchema = z.object({
  recompute: z
    .enum(['0', '1'])
    .default('0')
    .transform((v) => v === '1'),
});
export type AdminSystemQuery = z.infer<typeof AdminSystemQuerySchema>;

export const AdminSystemResponseSchema = z.object({
  generated_at: z.string().datetime(),
  source: AdminMetricSourceSchema,
  /** True when `?recompute=1` was passed and the expensive items ran. */
  recomputed: z.boolean(),
  notes: z.array(AdminNoteSchema),
  /** The API Worker's build metadata. The SSR Worker's comes from `/_version`,
   *  which the UI fetches alongside this and compares — see
   *  {@link AdminVersionStatusSchema}. */
  version: AdminVersionStatusSchema,
  /** All eight, always. */
  crons: z.array(AdminCronRunSchema),
  /** Null unless `?recompute=1` (with a `requires_recompute` note). */
  data_quality: AdminDataQualityStatusSchema.nullable(),
  algolia: AdminAlgoliaStatusSchema,
  database: AdminDatabaseStatusSchema,
  /** `MAX(stats_cache.computed_at)` — the same freshness figure the §5.1 status
   *  strip reports, from the same helper, so the two screens agree. */
  stats_freshness: AdminStatsFreshnessSchema,
});
export type AdminSystemResponse = z.infer<typeof AdminSystemResponseSchema>;

// ─── GET /api/admin/catalog/coverage (AECI-579 / P1.5) ───────────────────────

/**
 * The §5.5 catalog readout: coverage gaps, the promotion funnel, the
 * `research_status` distribution, taxonomy usage per facet, and the Stage 1.5
 * claim/attestation spine.
 *
 * ─── Three shapes carry the design ───────────────────────────────────────────
 *
 * **1. No `window`.** Unlike the three P1.1 endpoints, coverage is a snapshot of
 * *current state*, not an aggregate over a time range — "how many products have
 * no logo" has no window. Attaching one would be exactly the false precision
 * §1.1 forbids. `generated_at` / `source` / `notes` carry over unchanged; the
 * time-series half of §5.5 ("counts over time", "additions per day") is served by
 * `GET /api/admin/metrics/timeseries` with the `catalog.*` metric keys, which
 * already carries `catalog_series_is_additions_only`. There is one implementation
 * of that series and it is not here.
 *
 * **2. The count is the truth; the sample is the starting point.** Every gap
 * reports an EXACT `total` alongside a capped `sample`. `universe` travels with
 * it so the UI can render "171 of 171" — and 171-of-171 is a worklist, not an
 * error state. `?sample=0` returns counts only.
 *
 * **3. Degeneracy is reported, not hidden.** `promoted_cohort_only` is DERIVED
 * from the rows (every product reads `promoted`), never hardcoded, so it
 * self-retires the day a genuine un-promote path lands. §13 D6 explains why it is
 * true today: promote is D1's only INSERT path into `products` and sets
 * `'promoted'` on both branches, nothing ever writes `'ready'`/`'pending'`, and
 * retraction hard-deletes (`lib/retract-product.ts`). The pre-promotion funnel
 * lives in the review app.
 */

/** Max sample rows a caller may request per gap list. Beyond this the list stops
 *  being a starting point and starts being a data export — which is the review
 *  app's job, not the console's. */
export const ADMIN_COVERAGE_MAX_SAMPLE = 50;

/** Default sample size, matching `SAMPLE_LIMIT` in `apps/api/src/lib/data-quality.ts`
 *  so the screen and the 04:00 data-quality email show the same depth. */
export const ADMIN_COVERAGE_DEFAULT_SAMPLE = 10;

export const AdminCatalogCoverageQuerySchema = z.object({
  /** Rows returned per gap list. `0` returns exact counts with empty samples —
   *  the cheap mode for a summary strip. */
  sample: z.coerce
    .number()
    .int()
    .min(0)
    .max(ADMIN_COVERAGE_MAX_SAMPLE)
    .default(ADMIN_COVERAGE_DEFAULT_SAMPLE),
});
export type AdminCatalogCoverageQuery = z.infer<typeof AdminCatalogCoverageQuerySchema>;

/** Live catalog totals, as of the request. */
export const AdminCatalogTotalsSchema = z.object({
  products: z.number().int().nonnegative(),
  integrations: z.number().int().nonnegative(),
  vendors: z.number().int().nonnegative(),
  claims: z.number().int().nonnegative(),
  attestations: z.number().int().nonnegative(),
});
export type AdminCatalogTotals = z.infer<typeof AdminCatalogTotalsSchema>;

/**
 * The gap vocabulary. Each is a `products` predicate an operator can act on.
 *
 * | key | predicate |
 * |---|---|
 * | `products_without_vendor` | no `product_vendors` row (same predicate as the `products_without_vendor` data-quality check) |
 * | `products_without_logo` | `logo_url IS NULL` — 171 of 171 in the §14.2 census; vendors do carry logos |
 * | `products_without_description` | `description IS NULL` or blank after trim |
 * | `products_without_api_docs` | `api_docs_url IS NULL` — the URL is the actionable artifact, not the `has_api_docs` flag |
 * | `products_without_category` / `_audience` / `_phase` | no row in the matching join table |
 * | `products_without_trade` | no `product_trades` row. **Read this one with `trade_facet_sparse_by_design`**: the join is sparse by design (`TRADES_VOCABULARY.md` §1.1), so a horizontal platform carrying zero rows is correct, not a defect. |
 */
export const AdminCoverageGapKeySchema = z.enum([
  'products_without_vendor',
  'products_without_logo',
  'products_without_description',
  'products_without_api_docs',
  'products_without_category',
  'products_without_audience',
  'products_without_phase',
  'products_without_trade',
]);
export type AdminCoverageGapKey = z.infer<typeof AdminCoverageGapKeySchema>;

/**
 * One gap. `total` is exact; `sample` is capped at the request's `sample` value
 * and ordered by name so the list is stable between requests. `ref` rows link to
 * the AECi product page — D1 stores no curation-tool key (ADR 0021: "AECi does
 * not store your Airtable/record IDs"), so a per-row deep link into the review
 * app is not constructible from this data.
 */
export const AdminCoverageGapSchema = z.object({
  key: AdminCoverageGapKeySchema,
  /** EXACT count of affected products. */
  total: z.number().int().nonnegative(),
  /** Total products, so a share ("171 of 171") is computable without a second read. */
  universe: z.number().int().nonnegative(),
  sample: z.array(LinkRefSchema),
  /** `total > sample.length` — true whenever the list is a window onto more work. */
  sample_truncated: z.boolean(),
});
export type AdminCoverageGap = z.infer<typeof AdminCoverageGapSchema>;

/** The five `products.promotion_status` values the CHECK constraint admits. */
export const AdminPromotionStatusSchema = z.enum([
  'pending',
  'ready',
  'promoted',
  'retracted',
  'rejected',
]);
export type AdminPromotionStatus = z.infer<typeof AdminPromotionStatusSchema>;

/**
 * The §5.5 funnel. `stages` is zero-filled across all five statuses in pipeline
 * order, so an absent status renders as 0 rather than vanishing.
 */
export const AdminPromotionFunnelSchema = z.object({
  stages: z.array(
    z.object({
      status: AdminPromotionStatusSchema,
      count: z.number().int().nonnegative(),
    }),
  ),
  total: z.number().int().nonnegative(),
  /**
   * DERIVED: there is at least one product and every one reads `promoted`. When
   * true the response also carries `funnel_is_promoted_cohort_only`, and the UI
   * must say so — a 171/0/0/0/0 funnel with no explanation reads as a bug.
   */
  promoted_cohort_only: z.boolean(),
});
export type AdminPromotionFunnel = z.infer<typeof AdminPromotionFunnelSchema>;

/** The four `products.research_status` values the CHECK constraint admits. */
export const AdminResearchStatusSchema = z.enum(['pending', 'in_progress', 'done', 'blocked']);
export type AdminResearchStatus = z.infer<typeof AdminResearchStatusSchema>;

/** `research_status` distribution, zero-filled across all four values. */
export const AdminResearchStatusCountSchema = z.object({
  status: AdminResearchStatusSchema,
  count: z.number().int().nonnegative(),
});
export type AdminResearchStatusCount = z.infer<typeof AdminResearchStatusCountSchema>;

export const AdminTaxonomyFacetSchema = z.enum([
  'category',
  'audience',
  'phase',
  'trade',
  'data_object',
]);
export type AdminTaxonomyFacet = z.infer<typeof AdminTaxonomyFacetSchema>;

/** One term and how much of the catalog uses it. `published` is non-null only for
 *  `trade`, where `TRADE_PUBLISH_MIN_PRODUCTS` gates the term's own SEO page. */
export const AdminTaxonomyTermUsageSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().min(1),
  name: z.string().min(1),
  count: z.number().int().nonnegative(),
  published: z.boolean().nullable(),
});
export type AdminTaxonomyTermUsage = z.infer<typeof AdminTaxonomyTermUsageSchema>;

/**
 * Usage for one facet. Terms come back **uncapped** — the five vocabularies total
 * ~122 terms, so paging would be ceremony.
 *
 * `counts_what` exists because `data_object` is not like its four siblings: data
 * objects are referenced by **claims**, not by products, so its `count` is a claim
 * count. Saying so on the wire is cheaper than a UI that has to remember.
 */
export const AdminTaxonomyFacetUsageSchema = z.object({
  facet: AdminTaxonomyFacetSchema,
  counts_what: z.enum(['products', 'claims']),
  terms_total: z.number().int().nonnegative(),
  /** Terms with `count > 0`. */
  terms_used: z.number().int().nonnegative(),
  /** `TRADE_PUBLISH_MIN_PRODUCTS`, or null for the facets that have no gate. */
  publish_floor: z.number().int().positive().nullable(),
  /** Terms clearing the floor, or null for the facets that have no gate. */
  terms_published: z.number().int().nonnegative().nullable(),
  terms: z.array(AdminTaxonomyTermUsageSchema),
});
export type AdminTaxonomyFacetUsage = z.infer<typeof AdminTaxonomyFacetUsageSchema>;

/** An integration in a sample list. `name` is nullable in the schema, so the
 *  endpoints of the pair travel too — they are what the pair URL is built from
 *  (`/products/:contextSlug/integrations/:otherSlug`). */
export const AdminIntegrationRefSchema = z.object({
  id: z.string().uuid(),
  name: z.string().nullable(),
  source_product: LinkRefSchema,
  target_product: LinkRefSchema,
});
export type AdminIntegrationRef = z.infer<typeof AdminIntegrationRefSchema>;

/**
 * The Stage 1.5 claim/attestation spine (§5.5). 915 claims backed by 915
 * attestations in the §14.2 census — the interesting numbers are the zeros:
 * integrations carrying no claim at all, and claims carrying no ACTIVE
 * attestation (`deprecated_at IS NULL`, matching `attestations_active_idx`).
 */
export const AdminClaimCoverageSchema = z.object({
  integrations_total: z.number().int().nonnegative(),
  integrations_with_claims: z.number().int().nonnegative(),
  integrations_without_claims: z.number().int().nonnegative(),
  claims_total: z.number().int().nonnegative(),
  claims_with_active_attestation: z.number().int().nonnegative(),
  claims_without_active_attestation: z.number().int().nonnegative(),
  attestations_total: z.number().int().nonnegative(),
  /** Capped sample of integrations with zero claims — the actionable half. */
  integrations_without_claims_sample: z.array(AdminIntegrationRefSchema),
  integrations_without_claims_sample_truncated: z.boolean(),
});
export type AdminClaimCoverage = z.infer<typeof AdminClaimCoverageSchema>;

export const AdminCatalogCoverageResponseSchema = z.object({
  generated_at: z.string().datetime(),
  source: AdminMetricSourceSchema,
  notes: z.array(AdminNoteSchema),
  /** The `sample` actually applied, echoed so the UI can label a truncated list. */
  sample_limit: z.number().int().nonnegative(),
  totals: AdminCatalogTotalsSchema,
  funnel: AdminPromotionFunnelSchema,
  research_status: z.array(AdminResearchStatusCountSchema),
  gaps: z.array(AdminCoverageGapSchema),
  taxonomy: z.array(AdminTaxonomyFacetUsageSchema),
  claim_coverage: AdminClaimCoverageSchema,
});
export type AdminCatalogCoverageResponse = z.infer<typeof AdminCatalogCoverageResponseSchema>;

// ─── GET /api/admin/page-views ───────────────────────────────────────────────

/**
 * Filter sentinel meaning "this column IS NULL".
 *
 * The breakdown endpoint surfaces NULL groups as their own bucket (`key: null`)
 * rather than dropping them, because dropping them is how a source breakdown
 * quietly starts claiming attribution it does not have. The feed's `source` and
 * `country` filters need a way to *select* that bucket, and a query string cannot
 * carry a null — hence a sentinel rather than a second boolean parameter.
 *
 * It is deliberately not a value either column can legitimately hold:
 * `referrer_source` comes from `lib/referrer-classification.ts`'s closed label
 * table and `cf_country` is a two-character Cloudflare code.
 */
export const ADMIN_PAGE_VIEW_NULL_FILTER = '__none__';

/**
 * The §5.2 Activity feed's filters. `from` / `to` are UTC calendar dates, both
 * inclusive, and are **required** — the same contract as
 * {@link AdminTrafficBreakdownQuerySchema}, so the two page_views endpoints
 * cannot disagree about what window they are describing.
 *
 * `traffic` defaults to `human`, matching §5.2's stated filter default.
 *
 * Note what is NOT here: the `/admin/*` + `/account` exclusion. That is §13
 * **D12**'s read-side floor, applied *beneath* these filters and not settable by
 * a caller, so no combination of query parameters can surface an operator row.
 */
export const AdminPageViewsQuerySchema = PageQuerySchema.extend({
  from: utcDate,
  to: utcDate,
  traffic: AdminTrafficPopulationSchema.default('human'),
  /** Exact `referrer_source` match, or {@link ADMIN_PAGE_VIEW_NULL_FILTER}. */
  source: z.string().min(1).max(64).optional(),
  /** Exact `cf_country` match, or {@link ADMIN_PAGE_VIEW_NULL_FILTER}. */
  country: z.string().min(1).max(8).optional(),
  /** Substring match on `path`. `%` and `_` are escaped server-side, so operator
   *  input is matched literally rather than as a LIKE pattern. */
  path_contains: z.string().min(1).max(200).optional(),
  exclude_internal: z
    .enum(['0', '1'])
    .default('0')
    .transform((v) => v === '1'),
});
export type AdminPageViewsQuery = z.infer<typeof AdminPageViewsQuerySchema>;

/**
 * One visit. The column set is §5.2's mapping of PostHog's Activity explorer, and
 * two absences in it are load-bearing rather than incidental:
 *
 * **`visitor_hash` is the FIRST 8 CHARACTERS of `user_agent_hash`, truncated in
 * SQL.** §9.7 requires the panel to render "a truncated hash as a pseudonymous
 * visitor id" and to "not attempt correlation beyond that". Truncating at the
 * query rather than in the template means the full hash never crosses the wire at
 * all — the privacy property is enforced by this contract instead of by UI
 * discipline, and cannot be undone by a later template change.
 *
 * **`user_id`, `session_id` and `profile_role` are absent and stay absent.** §13
 * **D7** settled that the three dead columns are *dropped* (AECI-585), not
 * filled, and that no session identifier is introduced — a durable first-party id
 * is exactly what would drag `page_views` back inside the consent question this
 * feed exists to route around. A visitor is therefore
 * `(user_agent_hash, cf_asn)` and nothing more (§9.8).
 *
 * `path` is the route **pattern** (`/products/:slug`) as stored at ingest, so
 * `entity` carries the real name for product and vendor rows. A taxonomy row
 * hydrates to `null` and renders as the bare pattern until AECI-585 stores the
 * concrete path; `entity` is also `null` when the referenced row has since been
 * deleted, matching the `target` fallback on `/api/admin/requests`.
 */
export const AdminPageViewRowSchema = z.object({
  id: z.number().int().positive(),
  created_at: z.string().datetime(),

  /** `null` = never classified. Those rows read as HUMAN under the digest's
   *  `is_bot IS NOT 1` predicate, which is what `bot_classification_incomplete`
   *  exists to disclose. */
  is_bot: z.boolean().nullable(),
  bot_name: z.string().nullable(),

  /** Truncated to 8 characters server-side — never the full hash. */
  visitor_hash: z.string().nullable(),
  cf_asn: z.number().int().positive().nullable(),

  cf_country: z.string().nullable(),
  /** The Cloudflare colo, which *is* the nearest city (§5.2). */
  cf_colo: z.string().nullable(),

  path: z.string().min(1),
  entity_type: z.enum(['product', 'vendor']).nullable(),
  entity: LinkRefSchema.nullable(),

  /** `null` means unknown, NOT `Direct` — every row before August 2026 has it
   *  null and is not backfillable. The UI must not collapse the two (§1.1). */
  referrer_source: z.string().nullable(),
  /** External referrer HOST only, never the path or query (AECI-526 / §9.7). */
  referrer: z.string().nullable(),
});
export type AdminPageViewRow = z.infer<typeof AdminPageViewRowSchema>;

/**
 * The standard paginated envelope plus the honesty fields. `total` is the number
 * of **rows** matching every applied filter, so it is what paginates.
 *
 * ─── Why the internal-ASN filter behaves differently here ─────────────────────
 *
 * §13 **D10** constraint 2 is "show both numbers, never substitute". On a count
 * endpoint that falls out of {@link AdminCountSchema} for free. On a *row feed* it
 * does not: `exclude_internal=1` removes rows, and if the counts were computed the
 * same way the operator would simply see a smaller number with nothing to compare
 * it against — which is the substitution the constraint forbids.
 *
 * So this endpoint resolves the filter twice. `window_total` and
 * `window_visitors` are computed **both ways unconditionally** whenever
 * `ANALYTICS_INTERNAL_ASNS` is set, toggle or no toggle, so the UI can always
 * render "1,204 views · 312 excluding internal traffic". `exclude_internal` then
 * governs only which rows come back. This follows the precedent already set by
 * `/api/admin/overview`, which likewise always asks — its whole job is to show
 * both figures side by side.
 *
 * Two consequences worth knowing before reading a response:
 *
 * - `internal_filter.applied` means **"the row list was filtered"**, not "the
 *   second count was computed". It is the toggle's state.
 * - Both counts honour `source` / `country` / `path_contains`, so they reconcile
 *   with `total`: with the toggle off `total === window_total.total`, and with it
 *   on `total === window_total.excluding_internal`.
 *
 * When the var is unset — the shipped default on every tier — `excluding_internal`
 * is null on both counts and the UI hides the toggle entirely (§13 D10
 * constraint 3).
 *
 * `window_visitors` is §9.8's definition: distinct `(user_agent_hash, cf_asn)`
 * pairs in the window. §13 D7 requires that definition, and its over-count (a
 * browser update changes the UA) and under-count (shared NAT), to appear next to
 * the number in the UI — `visitor_definition_approximate` is always in `notes` for
 * this reason.
 */
export const AdminPageViewsResponseSchema = paginatedResponseSchema(AdminPageViewRowSchema).extend({
  traffic: AdminTrafficPopulationSchema,
  window: AdminWindowSchema,
  generated_at: z.string().datetime(),
  source: AdminMetricSourceSchema,
  notes: z.array(AdminNoteSchema),
  /** `applied` = the ROW LIST was filtered. See the docblock above. */
  internal_filter: AdminInternalFilterSchema,
  /** Views matching every filter EXCEPT `exclude_internal`, in both forms. */
  window_total: AdminCountSchema,
  /** §9.8 distinct `(user_agent_hash, cf_asn)` pairs, in both forms. */
  window_visitors: AdminCountSchema,
});
export type AdminPageViewsResponse = z.infer<typeof AdminPageViewsResponseSchema>;
