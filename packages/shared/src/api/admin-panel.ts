import { z } from 'zod';

import { LinkRefSchema, PageQuerySchema, paginatedResponseSchema } from './common';

/**
 * Admin panel read contracts (AECI-574 / Phase 8.3 P1.1, extended by AECI-577 /
 * P1.3, AECI-579 / P1.5, AECI-580 / P1.6, and AECI-586 / P5.1) — the endpoints
 * the rest of the operator console renders from. Source of
 * truth: `docs/ADMIN_PANEL_SPEC.md` §6, `docs/API_CONTRACTS.md` §6.10.
 *
 *   GET /api/admin/overview           — the §5.1 bundle in one round trip
 *   GET /api/admin/metrics/timeseries — a single metric, day-bucketed
 *   GET /api/admin/traffic/breakdown  — grouped counts over a window
 *   GET /api/admin/page-views         — the §5.2 Activity feed, row by row
 *   GET /api/admin/catalog/coverage   — the §5.5 gap lists, funnel, and taxonomy usage
 *   GET /api/admin/system             — the §5.6 bundle (AECI-580)
 *   GET /api/admin/audience           — the §5.4 bundle: subscribers, churn, UTM, geo (AECI-586)
 *   GET /api/admin/feedback           — the feedback inbox, paginated (AECI-586)
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
 * | `referrer_source_is_unverified` | `Referer` is client-supplied and unverifiable, so a source is what the request CLAIMED. Emitted unconditionally with any source breakdown, and deliberately not gated on detecting a forgery — a forged referrer is indistinguishable from a real one once §9.7 has reduced it to a host, so "none detected" would be a claim the rows cannot support (AECI-624) |
 * | `direct_is_mixed_bucket` | a `Direct` bucket is present; `PageViewTracker` POSTs on every SPA navigation and the same-origin `Referer` classifies as `Direct`, so in-app hops and true direct arrivals are indistinguishable. AECI-585 stores a `navigation` flag at ingest, but no endpoint groups on it yet and rows written before it cannot be separated at all |
 * | `visitor_definition_approximate` | `unique_visitors` is `DISTINCT (user_agent_hash, cf_asn)` — over-counts on browser update, under-counts behind shared NAT (§9.8) |
 * | `corroborated_is_a_referrer_floor` | `corroborated_views` counts arrivals with a NAMED external referrer (AECI-683). Emitted unconditionally with the figure: it UNDER-counts (Referrer-Policy strips real referrals into `Direct`) and it is forgeable UPWARD, since it rests on the same unverified `Referer` as `referrer_source_is_unverified` |
 * | `operator_leak_is_an_inference` | `operator_leak_excluded` rows were matched by `(user_agent_hash, cf_asn)` against a verified operator session within `OPERATOR_PAIR_LOOKBACK_DAYS` (AECI-683). Unlike the `is_operator` flag itself, that is a judgement about identity, not a verified session |
 * | `automation_filter_applied` | the headline is `page_views_human_raw` less the views the swarm detector attributed to automated clients (AECI-745). `message` carries the published thresholds (`SWARM_THRESHOLD_NOTE`) and, when the day flagged anything, that day's own `swarmNote(...)` sentence |
 * | `automation_filter_did_not_run` | the detector failed for this window, so `page_views_human` is UNFILTERED and `automation_flagged` is null. A `warn`: unlike the standing caveats this is a real, clearable condition, and a reader who misses it reads a raw count as a filtered one |
 * | `catalog_series_is_additions_only` | a `catalog.*` series counts `*.created` events, never net totals — rows can vanish without per-row audit (§4). `basis=additions` only |
 * | `catalog_series_starts_at` | the window starts before the earliest `audit_log` row, so the leading segment reads zero for want of data, not for want of activity. `basis=additions` only |
 * | `catalog_series_is_surviving_rows` | `basis=net`: the series counts rows PRESENT NOW, bucketed by `created_at`. A row removed later is subtracted from the bucket it was ADDED in, not the bucket it was removed in, so past buckets restate downwards over time. That restatement is what makes the series sum to the live catalog (AECI-686) |
 * | `catalog_claims_recreated_by_promote` | `basis=net` on `catalog.claims_created`: promote REPLACES an integration's claims on every push (delete + re-insert with fresh ids), so `claims.created_at` is the last promote of its integration, not when the claim first appeared. The column is a valid count of live rows and a poor arrival history (AECI-604 is the fix) |
 * | `internal_filter_unavailable` | `ANALYTICS_INTERNAL_ASNS` is unset, so `excluding_internal` is null everywhere (the shipped default) |
 * | `internal_filter_applied` | the filter ran; both numbers are present and the excluded ASNs are in `params.asns` |
 * | `requires_recompute` | an expensive status item was omitted from the default `/overview` or `/system`; re-request with `?recompute=1` |
 * | `algolia_credentials_absent` | `?recompute=1` ran but `ALGOLIA_APP_ID`/`ALGOLIA_ADMIN_KEY` are unset, so drift could not be measured |
 * | `funnel_is_promoted_cohort_only` | every `products` row reads `promotion_status='promoted'`, so the funnel has exactly one populated stage — the pre-promotion stages live in the review app, not D1 (§13 D6) |
 * | `trade_facet_sparse_by_design` | products carry no `trade` tag and that is not by itself a defect: `TRADES_VOCABULARY.md` §1.1 tags a product only when it has trade-SPECIFIC value, so horizontal platforms correctly carry zero rows |
 * | `api_docs_flag_inconsistent` | N products have `has_api_docs = 1` but no `api_docs_url` — the flag and the artifact disagree |
 * | `series_partly_reconstructed` | some days in the window come from the P2.1 backfill rather than a same-day snapshot, and are approximate (§4); `params.reconstructed_days` counts them and `params.reconstructed_through` is the last such day |
 * | `cron_liveness_unavailable` | N of the ten crons have no `job_runs` row yet — they have not run since run recording shipped, or were added since. Datadog's no-data monitors stay the authority for "a job stopped firing" |
 * | `orphan_sweep_not_persisted` | **No longer emitted (AECI-583)** — the sweep's result IS persisted now, in the 09:00 drift run's `job_runs.detail`. Retained because removing a code is a breaking change, and so an older cached response still renders |
 * | `stored_result_unreadable` | a stored `job_runs.detail` could not be parsed, so the item is omitted rather than partially reported. `params.job` names which cron's payload |
 * | `utm_attribution_incomplete` | `params.missing` of `params.total` signups in the window carry no `utm_source` — the unattributed bucket is real signups, not missing rows. The direct analogue of `referrer_source_incomplete`, and like it, derived from the window rather than from a date |
 * | `audience_history_is_current_state` | the subscriber series reads each `mailing_list` row's CURRENT `created_at` / `unsubscribed_at`. A resubscribe **clears** `unsubscribed_at` (`POST /api/subscribe`'s reactivation path), so a subscriber who churned and returned reads as never-churned and their earlier suppressed days are reported as active. This is the one thing the soft delete cannot preserve, and it is the honest counterweight to "churn is exactly computable" |
 */
export const AdminNoteCodeSchema = z.enum([
  'partial_day',
  'bot_classification_incomplete',
  'referrer_source_incomplete',
  'referrer_source_is_unverified',
  'direct_is_mixed_bucket',
  'visitor_definition_approximate',
  'corroborated_is_a_referrer_floor',
  'operator_leak_is_an_inference',
  // AECI-745 — the automation filter, in the two states it can be in. Two codes
  // rather than one with a flag, because "it ran" and "it failed" are read by
  // different people for different reasons and must style differently.
  'automation_filter_applied',
  'automation_filter_did_not_run',
  'catalog_series_is_additions_only',
  'catalog_series_starts_at',
  // AECI-686 — the `basis=net` counterparts of the two above.
  'catalog_series_is_surviving_rows',
  'catalog_claims_recreated_by_promote',
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
  'stored_result_unreadable',
  // AECI-586 / P5.1 — audience
  'utm_attribution_incomplete',
  'audience_history_is_current_state',
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

/**
 * `asn_registry` freshness + reach (AECI-624 / §7.6).
 *
 * Two numbers rather than one, because "the refresh ran" and "the annotation is
 * worth anything" are different questions. `entries` is how many networks the
 * registry can speak to at all; `coverage` is the share of the ASNs `page_views`
 * has actually seen that it has a record for — the number that silently decays
 * between Mondays as new networks arrive, and the one that decides whether a
 * given Activity row shows an annotation.
 *
 * `fetched_at` null means the refresh has never landed (a fresh environment).
 * That is distinct from a stale one, and the UI must not render them alike: an
 * empty registry annotates nothing and says so, while a stale one keeps
 * annotating from last-known-good and needs the date shown beside it.
 */
export const AdminAsnRegistryStatusSchema = z.object({
  entries: z.number().int().nonnegative(),
  fetched_at: z.string().datetime().nullable(),
  age_hours: z.number().nullable(),
  /** Older than two refresh intervals (14 days) — one missed Monday is a blip,
   *  two is a broken feed. Null `fetched_at` is NOT stale; it is unpopulated. */
  stale: z.boolean(),
  /** Distinct `page_views.cf_asn` values the registry has a record for, over the
   *  total. Null when there are no ASNs to cover (a fresh `page_views`), because
   *  0/0 is not 0% — it is "not applicable", and rounding it to zero would show a
   *  healthy new environment a broken-looking gauge. */
  coverage: z.number().min(0).max(1).nullable(),
});
export type AdminAsnRegistryStatus = z.infer<typeof AdminAsnRegistryStatusSchema>;

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

/**
 * The ten checks. `failing` counts checks with findings OR an error — a skipped
 * check (no creds) is not a failure.
 *
 * Since AECI-583 these are served **from storage by default**: the 04:00 cron
 * persists its whole result set in `job_runs.detail` (§7.2), and the default
 * response replays it rather than reporting nothing. `?recompute=1` still runs
 * them live and is the refresh. `source` + `computed_at` exist so the screen can
 * never present a stored result as a fresh one — a status object that cannot say
 * where it came from is precisely what the persistence was added to fix.
 */
export const AdminDataQualityStatusSchema = z.object({
  /** `job_runs` = the stored result of the last scheduled run, byte-identical to
   *  what that run's email reported (both render the same
   *  `DataQualityCheckResult[]`). `live` = run just now for this request. */
  source: z.enum(['job_runs', 'live']),
  /** When the checks actually RAN — the run's `finished_at` for `job_runs`, and
   *  the request time for `live`. Never the response's own `generated_at`: a
   *  stored result shown under the response timestamp claims a freshness it does
   *  not have. Null only when a stored row somehow carries no finish stamp. */
  computed_at: z.string().datetime().nullable(),
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
  /**
   * **Human page views AFTER the automation filter** — the digest's headline, and
   * since AECI-745 the panel's too.
   *
   * ⚠️ **This field was REDEFINED.** Through AECI-744 it carried the raw
   * server-side count; AECI-741 made the filtered figure the email's headline and
   * left the panel on the raw one, so the two surfaces answered "how many humans?"
   * with different numbers (14 vs 70 on 2026-08-30). Rather than add a second
   * headline and leave readers to pick, the headline moved here and the raw count
   * moved to {@link AdminOverviewTrafficSchema.shape.page_views_human_raw}. A
   * reader that upgrades without noticing gets the BETTER number, which is why
   * this direction was chosen — but it is a silent semantic change and nothing in
   * the type says so, hence this comment.
   *
   * `excluding_internal` is filtered the same way, so the pair cannot show an
   * ASN-excluded figure larger than the total it is a subset of.
   *
   * Equal to `page_views_human_raw` when `automation_flagged` is null (the
   * detector did not run). That is not a coincidence to rely on — read
   * `automation_flagged` to know which of the two you are looking at.
   */
  page_views_human: AdminCountSchema,
  /**
   * The RAW server-side count: what `page_views_human` meant before AECI-745.
   *
   * Kept, rather than dropped, because it is a genuinely different measurement
   * and the email prints both: an UPPER bound, counted server-side on every
   * full-document load, so a crawler that never runs our JavaScript is in it.
   * The envelope on the tile has to show the subtraction, and a subtraction needs
   * its minuend.
   */
  page_views_human_raw: AdminCountSchema,
  /**
   * Human views the automation filter removed from the reported day, or **null
   * when the detector did not run**.
   *
   * Null and zero are different and must render differently: zero is a clean day,
   * null is an OUTAGE in which the headline above is unfiltered. A UI that prints
   * "0 flagged" for a failed detector makes the failure look like good news,
   * which is the one thing it must never look like.
   */
  automation_flagged: z.number().int().nonnegative().nullable(),
  page_views_bot: AdminCountSchema,
  /** DISTINCT `(user_agent_hash, cf_asn)` among HUMAN rows in the window (§9.8). */
  unique_visitors: AdminCountSchema,
  /** Post-automation human page views, this day vs the prior day — the digest's
   *  delta, and **filtered on BOTH sides** (AECI-741): a filtered day against an
   *  unfiltered prior day manufactures a large fake drop. Redefined by AECI-745
   *  alongside `page_views_human`, for the same reason and with the same caveat. */
  delta_day: AdminDeltaSchema,
  /**
   * Human page views, the 7 days ending with this one vs the 7 before that.
   *
   * **RAW on both sides, unlike `delta_day`** — deliberately, and the panel says
   * so. Filtering it would mean running the swarm detector over 14 further days
   * on every request, which is not a cost this endpoint can carry. Two deltas
   * with different populations sitting side by side is a real hazard; the answer
   * is to label it, not to fabricate a filtered week from an unfiltered one.
   */
  delta_7d: AdminDeltaSchema,
  /** 30 UTC days ending with the reported day, zero-filled. RAW, like
   *  `delta_7d` and for the same reason. The filtered series is the
   *  `traffic.page_views_human_after_automation` metric key, which is served from
   *  `metrics_daily` precisely because it cannot be computed live per day. */
  series_30d: z.array(AdminTrafficPointSchema),
  top_sources: z.array(AdminSourceCountSchema),
  top_products: z.array(AdminProductViewsSchema),
  /**
   * Human views in the window that arrived with a NAMED external search or social
   * referrer, and the §9.8 visitors behind them (AECI-683). The digest's own
   * numbers — the third figure it prints beside the server-side upper bound and
   * the PostHog lower bound.
   *
   * A plain count rather than an {@link AdminCountSchema} on purpose: there is no
   * ASN-filtered variant of it, and a nullable `excluding_internal` that is always
   * null would imply a second number exists.
   *
   * **This is a FLOOR and it is built on a CLAIM.** Referrer-Policy strips real
   * referrals into `Direct`, so it under-counts; and nothing verifies a `Referer`
   * (§9.7 — production holds a confirmed forgery). The UI must print both caveats
   * beside it, exactly as the email does. The value is still the most useful of
   * the three, because a rotating-proxy pool sends no `Referer` at all.
   */
  corroborated_views: z.number().int().nonnegative(),
  corroborated_visitors: z.number().int().nonnegative(),
  /**
   * Human views excluded because they share a `(user_agent_hash, cf_asn)` pair
   * with a verified operator session nearby in time — the rows a lapsed admin
   * session left unflagged (AECI-683, `analytics-digest.ts` `OPERATOR_PAIR_MATCH`).
   *
   * Surfaced rather than silently netted off because, unlike the path and session
   * halves of the same exclusion, this one is an INFERENCE about identity. The
   * panel and the email report the same figure.
   */
  operator_leak_excluded: z.number().int().nonnegative(),
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
 * A `catalog.*` key names a SERIES, not a source: {@link AdminMetricBasisSchema}
 * picks which of the two readings of "how many were added" the response carries.
 * The key stays `*_created` under both because it is `metrics_daily.metric`
 * verbatim (§7.1) and renaming it would orphan every stored row.
 */
export const ADMIN_METRIC_KEYS = [
  'traffic.page_views_human',
  /**
   * Human page views less the views the swarm detector attributed to automated
   * clients — the filtered series behind `/admin/overview`'s headline (AECI-745).
   *
   * **Served from `metrics_daily` ONLY.** Every other key here falls back to a
   * live per-day aggregation for days the snapshot has not captured; this one
   * cannot, because "live" means running the detector once per day in the window
   * — roughly seven D1 reads per day, so ~210 for a 30-day chart. Days with no
   * stored row are therefore a GAP, not a zero and not a recompute, and
   * `series_partly_reconstructed` / `catalog_series_starts_at` style notes say
   * where the series begins. Fill history with `pnpm ops:backfill-metrics-daily`,
   * which can afford the per-day cost that a request cannot.
   *
   * For the same reason `excludeInternal=1` is rejected on this key: the internal
   * filter bypasses the snapshot by design, and there is no live path to fall
   * back to.
   */
  'traffic.page_views_human_after_automation',
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
 * Which reading of a `catalog.*` series to serve (AECI-686). **`catalog.*` only** —
 * `basis=net` on any other metric is a 400, because neither `page_views` nor
 * `profiles` has the delete problem this dimension exists to answer.
 *
 * ─── `additions` — creation EVENTS (the original, still the default) ─────────
 *
 * Counts `audit_log` `*.created` rows in the bucket. An event outlives the row it
 * describes, so this over-reports whenever anything is removed: in production
 * 11,827 `claim.created` events back 1,691 live claims, and 1,275
 * `integration.created` events back 944. It is the honest answer to "how much
 * work happened", and it does not reconcile with a live `count(*)`.
 *
 * ─── `net` — rows PRESENT NOW, bucketed by `created_at` ──────────────────────
 *
 * Counts the rows still in the catalog, attributed to the day they arrived. This
 * is the requested net delta: 20 added and 5 removed reads 15.
 *
 * Two properties follow from that and are stated in the response's notes rather
 * than left to inference:
 *
 * **It restates.** A removal is subtracted from the bucket the row was *added*
 * in, not the bucket it was removed in — the only attribution available, because
 * nothing records deletions (there is no `*.deleted` audit action, and every
 * delete path is raw SQL outside the Worker; `lib/retract-product.ts` documents
 * this). So a past bucket falls as its rows die. That is exactly what makes the
 * series sum to the live total, which is the property §5.5 wanted.
 *
 * **It is never snapshotted.** A retroactive value must not be frozen into
 * `metrics_daily`, so `basis=net` bypasses the snapshot entirely and always
 * reports `source: 'live'` with `reconstructed: false` on every point — the rows
 * exist, so nothing is being approximated.
 *
 * `additions` remains the default because it is the shipped behaviour and because
 * churn is real information that `net` cannot show: a month that created and
 * destroyed 300 integrations reads 0 net and 300 additions.
 */
export const AdminMetricBasisSchema = z.enum(['additions', 'net']);
export type AdminMetricBasis = z.infer<typeof AdminMetricBasisSchema>;

/** True for the four keys that accept `basis=net` — the ones backed by a catalog
 *  table with a `created_at` a live row still carries. Exported so the API's
 *  validation and the UI's request-building agree on one predicate. */
export function metricSupportsNetBasis(metric: AdminMetricKey): boolean {
  return metric.startsWith('catalog.');
}

/**
 * The **stock** half of the `metrics_daily` vocabulary (P2.1 / §7.1): an
 * instantaneous count sampled once a day, as against the *flow* keys above,
 * which count events inside a day.
 *
 * These are written by the snapshot cron but are **not readable** through
 * `GET /api/admin/metrics/timeseries` — {@link AdminMetricKeySchema} is
 * deliberately still the endpoint's vocabulary. They are captured from day one
 * anyway because a stock is unrecoverable retroactively: §4 shows the audit log
 * cannot reproduce a past total (827 `integration.created` events back 496 live
 * rows), so any day not sampled is lost permanently.
 *
 * **The three `audience.*` keys are the exception that proves the rule, and
 * AECI-586 deliberately did NOT read them.** An earlier draft of this comment
 * said §5.4 (Audience) would. It does not, because `mailing_list` is the one
 * source here that *can* be reconstructed exactly: `unsubscribed_at` is a soft
 * delete (AECI-537), so no row is ever removed and
 * `created_at <= D AND (unsubscribed_at IS NULL OR unsubscribed_at > D)` gives
 * the active count on any past day. Serving §5.4 from the snapshot instead would
 * have cost history (stocks are never backfilled, so these series begin at the
 * first cron run on 2026-08-13) and risked a worse error: the timeseries
 * endpoint **zero-fills**, and a zero-filled stock reports an uncaptured day as
 * *zero subscribers* rather than as unknown. `GET /api/admin/audience` therefore
 * derives its own series live, and these rows remain the durable record — the
 * only place a pre-resubscribe state survives, since a reactivation erases
 * `unsubscribed_at` from the row itself. §5.5 (Catalog "counts over time")
 * remains the screen that will read the `catalog.*` stocks.
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

/**
 * §7.4 / §13 **D5** retention windows, in days — the source literals the
 * pruning cron (AECI-584) enforces and the read side caps against.
 *
 * 400 rather than 180 for `page_views` because storage was never the binding
 * constraint (280 MB vs 125 MB against D1's 10 GB limit); **irreversibility**
 * is. D1 Time Travel recovers only ~30 days, so a prune past that is permanent,
 * and 400 days is the first window that keeps year-over-year comparison
 * possible with ~5 weeks of overlap. `job_runs` is operational, not historical.
 *
 * `metrics_daily` deliberately has NO entry: its retention is indefinite, it is
 * the long memory that survives the `page_views` prune, and the absence of a
 * constant is the point — there is no window for the cron to read.
 */
export const PAGE_VIEWS_RETENTION_DAYS = 400;
export const JOB_RUNS_RETENTION_DAYS = 90;

/**
 * Floor for the `PAGE_VIEWS_RETENTION_DAYS` / `JOB_RUNS_RETENTION_DAYS` env
 * overrides (`apps/api/src/env.ts`). D1 Time Travel recovers roughly 30 days, so
 * a window shorter than that would delete rows past the point of any recovery
 * the moment it took effect. An override below this floor is ignored, not
 * clamped — a typo'd `4` should fall back to the reviewed default, not quietly
 * become the shortest legal window.
 */
export const MIN_RETENTION_DAYS = 30;

/** Longest window the API will aggregate, tied to §7.4's `page_views`
 *  retention: asking for more than is retained can only mislead. Derived rather
 *  than a second `400`, so shortening the retention window moves the query cap
 *  with it. (An `env` override does NOT move this — it is resolved at build
 *  time; a shortened window just makes the cap wider than what is retained,
 *  which returns empty tails rather than wrong numbers.) */
export const ADMIN_METRICS_MAX_DAYS = PAGE_VIEWS_RETENTION_DAYS;

const utcDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

/**
 * `from` / `to` are UTC calendar dates and are **both inclusive** — `from=to`
 * is a valid single-day range. The response's `window.to` reports the resulting
 * exclusive instant so the boundary is never ambiguous.
 *
 * `interval` has one value today. `metrics_daily` (P2.1) stores per-day rows, so
 * week/month roll-ups are a later additive extension, not a reshape.
 *
 * `basis` defaults to `additions`, which is the pre-AECI-686 behaviour — an
 * omitted param must not change an existing caller's numbers.
 */
export const AdminTimeseriesQuerySchema = z.object({
  metric: AdminMetricKeySchema,
  from: utcDate,
  to: utcDate,
  interval: z.enum(['day']).default('day'),
  basis: AdminMetricBasisSchema.default('additions'),
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
 *
 * Always false under `basis=net`, which reads the surviving rows themselves and
 * so has nothing to approximate.
 */
export const AdminTimeseriesPointSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  value: z.number().nonnegative(),
  value_excluding_internal: z.number().nonnegative().nullable(),
  reconstructed: z.boolean(),
});
export type AdminTimeseriesPoint = z.infer<typeof AdminTimeseriesPointSchema>;

/**
 * How the ASN registry reads a network (AECI-624 / §7.6). **Our** coarse bucket,
 * derived from the upstream's own word — which travels beside it as `info_type`,
 * so a reader can see the claim and our reading of it separately.
 *
 * | value | means |
 * |---|---|
 * | `eyeball` | a network real people browse from — consumer ISPs, but also corporate, university, non-profit and government networks. Corroborates `is_bot: false` |
 * | `transit` | a tier-1 / wholesale carrier. Carries everyone, so it corroborates nothing either way — deliberately NOT folded into `eyeball`, because "we can't tell" and "it's a person" are different answers |
 * | `non_eyeball` | registered as something no residential subscriber sits behind: content/CDN, network services, route servers. **A suspicion, not a verdict** — Google and Netflix are `Content` too, so it means "not an eyeball network", never "hosting" |
 * | `unclassified` | the registry has a record but no usable type. Says nothing |
 *
 * The absence of an annotation entirely (`asn_registry: null`) is a *fifth*
 * state and a distinct one: the registry has never heard of this ASN. Roughly a
 * quarter of production traffic sits in `unclassified` + no-record combined, so
 * neither may be rendered as if it were a finding.
 */
export const AdminAsnNetworkClassSchema = z.enum([
  'eyeball',
  'transit',
  'non_eyeball',
  'unclassified',
]);
export type AdminAsnNetworkClass = z.infer<typeof AdminAsnNetworkClassSchema>;

/**
 * What the ASN registry says about one network — a **read-time annotation**, never
 * a stored verdict.
 *
 * This exists because `is_bot` cannot answer the question. That column is decided
 * once at ingest from a hand-curated list (`lib/bot-classification.ts`) whose
 * membership rule is deliberately strict, and the raw User-Agent is discarded
 * after hashing, so every revision of that list costs a one-way backfill. On
 * 2026-08-13 a five-request burst from three continents with rotating forged
 * referrers put three rows in the human bucket because one exit ASN
 * (FDCservers.net) is not on the list. Rather than widen the list — measured
 * against production, the free external lists are *narrower* than ours and would
 * have missed that ASN too — the panel annotates.
 *
 * So an annotation never contradicts `is_bot`; it stands beside it. `fetched_at`
 * travels on every one because an annotation from a registry that stopped
 * refreshing must be readable as stale rather than silently trusted (§9.8's
 * obligation to state a number's bias next to it, applied to a label).
 */
export const AdminAsnAnnotationSchema = z.object({
  asn: z.number().int().positive(),
  /** The upstream's verbatim classification (PeeringDB `info_type`, e.g.
   *  `"Content"`). Null when the record exists but carries no type. */
  info_type: z.string().nullable(),
  as_name: z.string().nullable(),
  network_class: AdminAsnNetworkClassSchema,
  /** Which feed this came from (`"peeringdb"`). */
  source: z.string().min(1),
  fetched_at: z.string().datetime(),
});
export type AdminAsnAnnotation = z.infer<typeof AdminAsnAnnotationSchema>;

/** Every day in the window appears in `points`, zero-filled — a chart should
 *  never have to infer a gap. */
export const AdminTimeseriesResponseSchema = z.object({
  metric: AdminMetricKeySchema,
  interval: z.enum(['day']),
  /** Echoed so a caller can never mistake which reading it received — the two
   *  differ by an order of magnitude on `catalog.claims_created`. */
  basis: AdminMetricBasisSchema,
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
  /** Group by `cf_asn` (AECI-624). The aggregate counterpart to the Activity
   *  feed's per-row ASN annotation: it answers "which networks is my traffic
   *  actually coming from", which is the question `dimension=country` only
   *  approximates. Each group carries its `asn_registry` annotation. */
  'asn',
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
  /** Populated only for `dimension=asn`, and only when the registry has a record
   *  for that network (AECI-624 / §7.6). Null on every other dimension and on an
   *  unknown ASN — the two are indistinguishable here by design, because the
   *  dimension already tells the reader which case applies. */
  asn_registry: AdminAsnAnnotationSchema.nullable().default(null),
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
 * **1. Deferred by cost.** `algolia.drift` is `null` on the default response and
 * filled by `?recompute=1`, exactly as on `/overview` — drift costs three Algolia
 * queries, which should not ride a dashboard poll. `data_quality` was null for
 * the same reason (its suite HTTP-probes a sample of logo URLs) until AECI-583
 * gave it somewhere to be read from: the default now replays the 04:00 run's
 * stored result, tagged `source: 'job_runs'` with its own `computed_at`, and the
 * recompute is the refresh. Still a pure read either way: §13 **D8** draws the
 * line at side effects, not manual-ness, so this writes nothing, sends nothing,
 * and carries no `audit_log` obligation.
 *
 * **2. Genuinely unrecorded.** Still the reason for a null, but a much narrower
 * one since AECI-583: a cron that has not run since run recording shipped has no
 * `job_runs` row, and D1 size is unknowable on some engines.
 * {@link AdminCronRunSchema}'s `source` discriminator, its `run_state`
 * companion, and the nullability throughout exist so the UI renders those as
 * *unknown* or *in flight* rather than as a passing check. A status screen that
 * reports "fine" because it has no data is worse than one that reports nothing.
 */

/**
 * The eleven cron jobs in `apps/api/src/scheduled.ts`, as a closed vocabulary.
 * These are the ids `job_runs.job` carries (§7.2), so AECI-583 persists against
 * these strings rather than inventing a second naming. `metrics-snapshot` is the
 * ninth, added with the §7.1 snapshot cron (AECI-581); `retention-prune` is the
 * tenth, added with the §7.4 pruning cron (AECI-584); `asn-registry` is the
 * eleventh and the only weekly one, added with the §7.6 read-time ASN
 * classification (AECI-624).
 */
export const AdminCronJobSchema = z.enum([
  'metrics-snapshot', // 15 0 * * *
  'retention-prune', // 0 3 * * *
  'data-quality', // 0 4 * * *
  'analytics-digest', // 0 5 * * *
  'moderation-snapshot', // 0 6 * * *
  'home-stats', // 0 7 * * *
  'algolia-sync', // 0 8 * * *
  'algolia-drift', // 0 9 * * *
  'request-reconcile', // */15 * * * *
  'waf-poll', // 0 * * * *
  'asn-registry', // 0 2 * * 2  (weekly; CF day-of-week is 1=Sunday, so 2 = Monday)
]);
export type AdminCronJob = z.infer<typeof AdminCronJobSchema>;

/**
 * Where a cron row's last-run information came from — the field that stops the
 * screen lying.
 *
 * | value | means |
 * |---|---|
 * | `job_runs` | read from the §7.2 table — the normal case since AECI-583. The row the cron wrote on entry and completed on exit |
 * | `derived` | inferred from a D1 side effect the job leaves behind (`derived_from` names it). Proves the job RAN; says nothing about whether it SUCCEEDED, so `last_outcome` stays null. Now only the fallback for a job that has not run since run recording shipped |
 * | `unknown` | no record exists anywhere in D1. The UI renders "Unknown", never a tick |
 */
export const AdminCronRunSourceSchema = z.enum(['job_runs', 'derived', 'unknown']);
export type AdminCronRunSource = z.infer<typeof AdminCronRunSourceSchema>;

/**
 * Whether the `job_runs` row this liveness came from is finished.
 *
 * `in_flight` means the row has a `started_at` and no `finished_at` — the run is
 * either genuinely mid-flight, or the isolate was reclaimed and never completed
 * it. Deliberately NOT folded into `last_outcome`: that field mirrors the stored
 * `job_runs.outcome` column, and inventing a `'running'` wire value with no
 * storage counterpart would have the API assert an outcome for a run that has
 * none. Equally deliberately NOT left implicit — `source: 'job_runs'` with a null
 * `last_outcome` is also what a finished row with an unrecognized stored outcome
 * produces, so the UI must not have to infer the difference.
 *
 * There is no `stalled` member: classifying stalled needs a per-job threshold —
 * the quarter-hourly reconcile is late at 30 minutes, a daily job at six hours.
 * The UI renders "In flight since {stamp}", which is self-evidently stale when
 * the stamp is days old, and Datadog's no-data monitors remain the alerting
 * authority for "a job stopped finishing".
 *
 * Null on `derived` and `unknown` rows — the question does not apply.
 */
export const AdminCronRunStateSchema = z.enum(['complete', 'in_flight']);
export type AdminCronRunState = z.infer<typeof AdminCronRunStateSchema>;

/**
 * One cron's liveness row. All ten are ALWAYS present — a job missing from the
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
  /** The stored `job_runs.outcome`. Null on a `derived` row (a side-effect
   *  timestamp attests to the run, not to its outcome), on an `unknown` row, and
   *  — structurally — on any row whose `run_state` is `in_flight`: an unfinished
   *  run can never report an outcome, whatever happens to be stored. */
  last_outcome: z.enum(['ok', 'failed', 'skipped']).nullable(),
  /** `finished_at − started_at`. Null while in flight and on non-`job_runs` rows. */
  duration_ms: z.number().int().nonnegative().nullable(),
  run_state: AdminCronRunStateSchema.nullable(),
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

/** One index's orphan-sweep outcome — the wire form of `EntityOrphanResult`
 *  (`apps/api/src/lib/algolia-orphans.ts`), minus its `orphanIds` (an unbounded
 *  id list the sweep logs to Datadog; the counts are what an operator acts on). */
export const AdminOrphanSweepIndexSchema = z.object({
  entity: z.string().min(1),
  index_name: z.string().min(1),
  index_count: z.number().int().nonnegative(),
  promoted_count: z.number().int().nonnegative(),
  /** Objects in the index with no promoted D1 row (`index − D1`). */
  orphans: z.number().int().nonnegative(),
  /** Actually removed — 0 when the safety cap refused, or on a delete error. */
  deleted: z.number().int().nonnegative(),
  /** The cap refused this pass; `orphans` is the backlog. Re-run the CLI with
   *  `--force` (see `docs/RUNBOOKS.md`). */
  skipped_by_safety_cap: z.boolean(),
  ok: z.boolean(),
  error: z.string().optional(),
});
export type AdminOrphanSweepIndex = z.infer<typeof AdminOrphanSweepIndexSchema>;

/**
 * The last 09:00 drift cron's orphan sweep, read from that run's
 * `job_runs.detail` (§7.2 / AECI-583).
 *
 * `ok` is false when any index errored — the sweep still ran and its counts are
 * real, which is why it is a field rather than the reason the whole object is
 * null. Null means **no record**: no completed drift run has stored a sweep (a
 * fresh environment, or a tier where the cron skips for want of Algolia
 * credentials). Null is never "clean".
 */
export const AdminOrphanSweepStatusSchema = z.object({
  /** The storing run's `finished_at`. */
  ran_at: z.string().datetime().nullable(),
  ok: z.boolean(),
  total_orphans: z.number().int().nonnegative(),
  total_deleted: z.number().int().nonnegative(),
  /** How many indexes the safety cap refused — the `--force` signal. */
  capped: z.number().int().nonnegative(),
  indexes: z.array(AdminOrphanSweepIndexSchema),
});
export type AdminOrphanSweepStatus = z.infer<typeof AdminOrphanSweepStatusSchema>;

/**
 * Algolia state. `drift` is null unless `?recompute=1` (cost).
 *
 * `orphan_sweep` used to be null **always**, because the sweep runs inside the
 * 09:00 drift cron and reported only to Datadog. AECI-583 persists it in that
 * run's `job_runs.detail`, so the reserved slot is now filled and the
 * `orphan_sweep_not_persisted` note is no longer emitted. It is still nullable —
 * for "no completed run has stored one", which is a different claim from "the
 * sweep found nothing".
 */
export const AdminAlgoliaStatusSchema = z.object({
  watermark: AdminAlgoliaWatermarkSchema.nullable(),
  drift: AdminAlgoliaDriftStatusSchema.nullable(),
  orphan_sweep: AdminOrphanSweepStatusSchema.nullable(),
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
  /** All eleven, always. */
  crons: z.array(AdminCronRunSchema),
  /** The last stored 04:00 run by default, or the live result under
   *  `?recompute=1` — `source` says which. Null only when nothing has been stored
   *  yet, or when the stored payload was unreadable (`stored_result_unreadable`). */
  data_quality: AdminDataQualityStatusSchema.nullable(),
  algolia: AdminAlgoliaStatusSchema,
  database: AdminDatabaseStatusSchema,
  /** `MAX(stats_cache.computed_at)` — the same freshness figure the §5.1 status
   *  strip reports, from the same helper, so the two screens agree. */
  stats_freshness: AdminStatsFreshnessSchema,
  /** How fresh, how large, and how far-reaching the §7.6 ASN registry is. The
   *  Activity screen's annotations are only as good as this row. */
  asn_registry: AdminAsnRegistryStatusSchema,
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
 * **D7** settled that the three dead columns are *dropped*, not filled, and that no
 * session identifier is introduced — a durable first-party id is exactly what would
 * drag `page_views` back inside the consent question this feed exists to route
 * around. AECI-585 dropped them, so their absence here is now structural rather
 * than a matter of which columns the query selects. A visitor is therefore
 * `(user_agent_hash, cf_asn)` and nothing more (§9.8).
 *
 * `path` is the route **pattern** (`/products/:slug`) as stored at ingest, so
 * `entity` carries the real name for product and vendor rows; `entity` is `null`
 * when the referenced row has since been deleted, matching the `target` fallback on
 * `/api/admin/requests`.
 *
 * A taxonomy row still hydrates to `null` and renders as the bare pattern. AECI-585
 * added `concrete_path` / `taxonomy_kind` / `taxonomy_id` at **ingest** — so the
 * data now exists, where before it did not — but that issue was scoped to the write
 * side, and widening `entity_type` here to the six kinds is a follow-up.
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

  /**
   * The traffic source the request **claimed**, not one that was verified.
   *
   * It is derived from the `Referer` header, which is supplied by the client and
   * is unverifiable by construction — there is no handshake with the named site
   * and §9.7 stores only the host, so not even the path survives to sanity-check.
   * Production contains a confirmed forgery (2026-08-13, `www.youtube.com`), and
   * a real click from that site would have produced a byte-identical row. The UI
   * must present this as a claim (§9.7); see `referrer_source_is_unverified` in
   * `notes`.
   *
   * `null` means unknown, NOT `Direct` — every row before August 2026 has it null
   * and is not backfillable. The UI must not collapse the two (§1.1).
   */
  referrer_source: z.string().nullable(),
  /** External referrer HOST only, never the path or query (AECI-526 / §9.7). */
  referrer: z.string().nullable(),

  /**
   * What the ASN registry says about `cf_asn` (AECI-624 / §7.6) — an annotation
   * joined at read time, `null` when the registry has no record for this network.
   *
   * It never alters `is_bot`, which stays exactly as ingest wrote it. A row can
   * legitimately read `is_bot: false` with `network_class: 'non_eyeball'`; that
   * pairing is the point, not a contradiction to be resolved.
   */
  asn_registry: AdminAsnAnnotationSchema.nullable(),
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

// ─── GET /api/admin/audience (AECI-586 / Phase 8.3 P5.1) ─────────────────────

/** Rows per breakdown dimension. A cap rather than pagination: seven breakdowns
 *  ride in one bundle and paginating each would need seven cursors for a screen
 *  whose whole point is the shape of the head, not the tail. */
export const ADMIN_AUDIENCE_MAX_BREAKDOWN = 50;
export const ADMIN_AUDIENCE_DEFAULT_BREAKDOWN = 8;

/**
 * `from` / `to` are UTC calendar dates, both inclusive, and required — the same
 * contract as {@link AdminTimeseriesQuerySchema}, so no two panel endpoints can
 * disagree about what window they describe. The `ADMIN_METRICS_MAX_DAYS` cap
 * applies here too, even though `mailing_list` has no retention policy: a
 * consistent ceiling is easier to reason about than a per-endpoint one.
 */
export const AdminAudienceQuerySchema = z.object({
  from: utcDate,
  to: utcDate,
  breakdown_limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(ADMIN_AUDIENCE_MAX_BREAKDOWN)
    .default(ADMIN_AUDIENCE_DEFAULT_BREAKDOWN),
});
export type AdminAudienceQuery = z.infer<typeof AdminAudienceQuerySchema>;

/**
 * One group in a UTM or geography breakdown.
 *
 * `key` is the raw column value and is **null for the unattributed bucket** — a
 * signup with no `utm_source`, or one Cloudflare could not geolocate. That
 * bucket is surfaced rather than dropped, exactly as on
 * {@link AdminBreakdownRowSchema}, so the rows reconcile against
 * `window_totals.signups`; dropping it is how an attribution breakdown quietly
 * starts claiming attribution it does not have.
 *
 * `label` is untranslated operator text (a fallback for curl and logs). The UI
 * keys off `key === null` and renders its own localized placeholder. For the
 * `asn` dimension it carries `as_organization` where the row has one — an ASN
 * cannot label itself — and `AS<number>` where it does not.
 */
export const AdminAudienceBreakdownRowSchema = z.object({
  key: z.string().nullable(),
  label: z.string().min(1),
  subscribers: z.number().int().nonnegative(),
});
export type AdminAudienceBreakdownRow = z.infer<typeof AdminAudienceBreakdownRowSchema>;

/**
 * Lifetime subscriber state. **No window** — "how many people are on the list"
 * has no time range, the same reasoning that keeps a window off
 * {@link AdminCatalogCoverageResponseSchema}.
 *
 * `active` is the identical predicate `/api/admin/overview`'s
 * `active_subscribers` and the snapshot cron's `audience.subscribers_active`
 * use (`unsubscribed_at IS NULL`), so the three can never disagree.
 *
 * **`churn_rate` is `null`, never `0`, when `total_ever` is 0.** A rate over an
 * empty list is undefined, not zero, and rendering `0%` would claim a clean bill
 * of health nobody measured — §5.1's "`null` renders as *Not measured*, never as
 * zero", applied to a ratio. It is a fraction in `[0, 1]`; the UI formats it.
 */
export const AdminAudienceSubscribersSchema = z.object({
  /** `unsubscribed_at IS NULL`. */
  active: z.number().int().nonnegative(),
  /** `unsubscribed_at IS NOT NULL` — a suppression record, not a deleted row. */
  unsubscribed: z.number().int().nonnegative(),
  /** Row count: `active + unsubscribed`. One row per email, ever. */
  total_ever: z.number().int().nonnegative(),
  /** `unsubscribed / total_ever`, or null when the list is empty. */
  churn_rate: z.number().min(0).max(1).nullable(),
});
export type AdminAudienceSubscribers = z.infer<typeof AdminAudienceSubscribersSchema>;

/**
 * One day of the subscriber series, zero-filled across the whole window.
 *
 * `signups` and `unsubscribes` are *flows* bucketed on `created_at` and
 * `unsubscribed_at`. `active_cumulative` is the *stock* at the end of that day,
 * carried forward from `window_totals.active_at_start` — a row can only enter
 * the population through `created_at` and leave it through `unsubscribed_at`,
 * so the running sum is exact rather than an estimate, and
 * `active_at_start + Σ(signups − unsubscribes) === active_at_end` holds by
 * construction.
 */
export const AdminAudienceSeriesPointSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  signups: z.number().int().nonnegative(),
  unsubscribes: z.number().int().nonnegative(),
  active_cumulative: z.number().int().nonnegative(),
});
export type AdminAudienceSeriesPoint = z.infer<typeof AdminAudienceSeriesPointSchema>;

/**
 * The windowed half. `churn_rate` here is the conventional period churn —
 * unsubscribes in the window over the population that existed when it opened —
 * and is `null` when nobody was subscribed at the start, for the same reason as
 * the lifetime one. `net` is the only signed figure in the response: a window
 * can lose more subscribers than it gains.
 */
export const AdminAudienceWindowTotalsSchema = z.object({
  signups: z.number().int().nonnegative(),
  unsubscribes: z.number().int().nonnegative(),
  /** `signups − unsubscribes`. May be negative. */
  net: z.number().int(),
  active_at_start: z.number().int().nonnegative(),
  active_at_end: z.number().int().nonnegative(),
  /** `unsubscribes / active_at_start`, or null when `active_at_start` is 0. */
  churn_rate: z.number().min(0).nullable(),
});
export type AdminAudienceWindowTotals = z.infer<typeof AdminAudienceWindowTotalsSchema>;

/**
 * The §5.4 Audience bundle.
 *
 * ─── Why this series is derived live and not read from `metrics_daily` ───────
 *
 * §7.1 snapshots `audience.subscribers_active` / `_unsubscribed` /
 * `feedback_total` every day and anticipated this screen reading them. It does
 * not, for two reasons that only apply to this table.
 *
 * **It does not need to.** `unsubscribed_at` is a soft delete (AECI-537) and
 * nothing anywhere hard-deletes a `mailing_list` row, so the population on any
 * past day is exactly `created_at <= D AND (unsubscribed_at IS NULL OR
 * unsubscribed_at > D)`. That is the property §4 shows the catalog stocks lack —
 * 827 `integration.created` events back 496 live rows — and it is why a snapshot
 * was needed there and is redundant here.
 *
 * **And it would cost.** Stocks are never backfilled, so those series begin at
 * the first cron run (2026-08-13) while `mailing_list` reaches back to the first
 * signup; and `/metrics/timeseries` zero-fills, which is right for a flow and
 * wrong for a stock — an uncaptured day would report *zero subscribers* rather
 * than unknown. The snapshot rows stay written: they are the only durable record
 * of a pre-resubscribe state, which is precisely what
 * `audience_history_is_current_state` discloses this response cannot see.
 *
 * `source` is therefore the literal `'live'` rather than
 * {@link AdminMetricSourceSchema} — `'snapshot'` and `'mixed'` are unreachable
 * here by design, and a three-value enum would imply a storage swap that is not
 * coming.
 */
export const AdminAudienceResponseSchema = z.object({
  window: AdminWindowSchema,
  generated_at: z.string().datetime(),
  source: z.literal('live'),
  notes: z.array(AdminNoteSchema),
  breakdown_limit: z.number().int().positive(),

  /** Lifetime, windowless. */
  subscribers: AdminAudienceSubscribersSchema,

  /** Every day in the window, zero-filled — a chart never infers a gap. */
  series: z.array(AdminAudienceSeriesPointSchema),
  window_totals: AdminAudienceWindowTotalsSchema,

  /** Grouped over signups **inside the window**, so a row's share is
   *  `subscribers / window_totals.signups` with no second request. */
  utm: z.object({
    source: z.array(AdminAudienceBreakdownRowSchema),
    medium: z.array(AdminAudienceBreakdownRowSchema),
    campaign: z.array(AdminAudienceBreakdownRowSchema),
  }),
  geography: z.object({
    country: z.array(AdminAudienceBreakdownRowSchema),
    region: z.array(AdminAudienceBreakdownRowSchema),
    city: z.array(AdminAudienceBreakdownRowSchema),
    asn: z.array(AdminAudienceBreakdownRowSchema),
  }),

  /** Counts only — the rows are `GET /api/admin/feedback`. */
  feedback: z.object({
    total_ever: z.number().int().nonnegative(),
    in_window: z.number().int().nonnegative(),
  }),
});
export type AdminAudienceResponse = z.infer<typeof AdminAudienceResponseSchema>;

// ─── GET /api/admin/feedback (AECI-586 / Phase 8.3 P5.1) ─────────────────────

/**
 * The feedback inbox. `PageQuerySchema` only — no window, deliberately: this is
 * an inbox read end to end, not a measurement, and the windowed count already
 * rides on `/api/admin/audience` as `feedback.in_window`.
 */
export const AdminFeedbackQuerySchema = PageQuerySchema;
export type AdminFeedbackQuery = z.infer<typeof AdminFeedbackQuerySchema>;

/**
 * One submission, as `POST /api/feedback` stored it (`api/landing.ts`).
 *
 * **This is the first read surface the `feedback` table has ever had.** Until
 * now the only way anyone saw a submission was the fire-and-forget operator
 * email to `ADMIN_ALERT_EMAIL` (§6.13) — so nothing here is a re-shaping of an
 * existing view; the column set simply is the row.
 *
 * `email` crosses in full rather than truncated. That is the opposite of
 * {@link AdminPageViewRowSchema}'s `visitor_hash` and deliberately so: a page
 * view is an observation of someone who never identified themself, while this is
 * contact information a person volunteered *in order to be replied to*. Redacting
 * it would defeat the field's only purpose. It follows `/api/admin/requests`,
 * which likewise returns `submitter_email` whole.
 *
 * `referrer` is a URL a submitter's browser supplied. It is data, not a
 * destination — the UI renders it as text, never as a link.
 */
export const AdminFeedbackRowSchema = z.object({
  id: z.number().int().positive(),
  created_at: z.string().datetime(),
  /** Free text: "what features would you want?" `null` when only `tools` was given. */
  features: z.string().nullable(),
  /** Free text: "what tools do you use?" `null` when only `features` was given. */
  tools: z.string().nullable(),
  email: z.string().nullable(),
  /** The mailing-list opt-in checkbox on the feedback form. */
  subscribed: z.boolean(),
  country: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  timezone: z.string().nullable(),
  referrer: z.string().nullable(),
});
export type AdminFeedbackRow = z.infer<typeof AdminFeedbackRowSchema>;

/**
 * The standard paginated envelope. `total` is every row in the table, since the
 * endpoint takes no filters; ordering is `created_at DESC, id DESC` — the
 * autoincrement id breaks ties so a page boundary is stable even for two
 * submissions stamped in the same millisecond.
 *
 * `notes` is present and normally empty. It costs nothing and means a future
 * caveat here needs no envelope change on either side of the wire.
 */
export const AdminFeedbackResponseSchema = paginatedResponseSchema(AdminFeedbackRowSchema).extend({
  generated_at: z.string().datetime(),
  source: z.literal('live'),
  notes: z.array(AdminNoteSchema),
});
export type AdminFeedbackResponse = z.infer<typeof AdminFeedbackResponseSchema>;
