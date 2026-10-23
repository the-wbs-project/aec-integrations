/**
 * Daily operator analytics digest (AECI-526).
 *
 * A queue-less daily cron (`scheduled.ts` `runAnalyticsDigestJob`) summarizes the
 * prior UTC day's site activity and emails it to the operator. Two layers, mirroring
 * the §23.1 data-quality digest split (`data-quality.ts` collects, `data-quality-email.ts`
 * formats):
 *
 *   - `collectAnalyticsMetrics(db, window)` — the read-only D1 aggregation.
 *   - `buildAnalyticsDigest(metrics, opts)` — a pure formatter → `{ subject, text, html }`.
 *
 * Human vs. bot (AECI-526 follow-up): the digest's headline and "Most viewed
 * products" exclude known bots (`is_bot IS NOT 1`), and a "Crawler activity"
 * section lists every bot/crawler and its crawl count for the day (`is_bot = 1`,
 * grouped by `bot_name`). The `is_bot` / `bot_name` classification is written at
 * ingest by `lib/bot-classification.ts` (`page_views` route). Rows captured before
 * that column existed have `is_bot = NULL` and read as human until the one-time ASN
 * backfill runs — a safe degradation (matches the pre-split behavior) rather than
 * silently dropping rows.
 *
 * ─── The classes lead (AECI-1346), and are the only population (AECI-1460) ───
 *
 * Since D19 Phase 3 the email opens with the four stored traffic classes
 * ({@link DigestClassification}), read through the same functions
 * `/admin/overview` uses. Phase 4 (AECI-1460) removed the residual that used to
 * sit below them ("requests of unresolved origin"), the `AutomationExclusion`
 * behind it, the AECI-683 referrer floor and the PostHog lines. The swarm and
 * verdict detectors still run, as classifier inputs (`traffic-classifier.ts`).
 *
 * The top products and traffic sources tables filter by the same record:
 * {@link automationClassFilterForDay} drops views classed as automation on the
 * day's latest classifier version. A day with no classes prints them unfiltered,
 * with {@link TABLES_UNCLASSIFIED_NOTE}.
 *
 * Two AECI-869 rules survive the residual. **{@link arrivalTelemetryDegraded}**
 * puts a telemetry outage in the subject line and above the tables, so a blind
 * day can never look like a quiet one; and **{@link trafficDaysNotComparable}**
 * suppresses the crawler delta across a telemetry boundary rather than hedging it.
 *
 * Internal traffic (AECI-575): every `page_views` read here excludes the
 * operator-only paths in `UNTRACKED_ROUTE_PREFIXES` (`/admin/*`, `/account`). The
 * tracker stopped writing them, but rows captured before that shipped are still
 * in the table and would otherwise keep inflating the headline — on the
 * 2026-08-10 digest day, 67 of 92 "human" views came from the operator's own ISP.
 * Filtering on read as well keeps every pre-fix day comparable with every
 * post-fix one. Unlike the bot split, the exclusion is not surfaced in the email:
 * these were never visitor traffic.
 *
 * Every count is a report-only read (no `audit_log` row, no mutation — `page_views`
 * is analytics, not domain state). The day window is **UTC**: Cloudflare cron is
 * UTC-only / DST-unaware (see `scheduled.ts`), so bucketing the day in UTC avoids a
 * DST off-by-one; the email labels the window as UTC. Sources:
 *   - human page views + top products: `page_views` where `is_bot IS NOT 1`, minus
 *     the operator-only paths (below). Top products also count the integration
 *     pair pages a product is an endpoint of (AECI-929), from
 *     {@link PAIR_ATTRIBUTION_STARTS_ON}.
 *   - crawler activity: `page_views` where `is_bot = 1`, grouped by `bot_name`.
 *   - new users: `profiles.created_at` (a profile row is created on first sign-in).
 *   - total users: cumulative `COUNT(profiles)`.
 *   - pending moderation: `reviews` where `status='pending'` (a live snapshot).
 */

import { and, asc, count, desc, eq, gte, isNotNull, lt, type SQL } from 'drizzle-orm';

import type { AdminClassificationSummary, AdminTrafficClass } from '@aeci/shared';

import type { Db } from '../db/client';
import { pageViews, products, profiles, reviews } from '../db/schema';
import {
  automationClassFilterForDay,
  type AutomationClassFilter,
  classDeltaBlocker,
  CLASSIFICATION_UNRESOLVED_SHARE_MAX,
  type ClassDeltaBlocker,
  readClassificationSeries,
  readClassificationSummary,
  type ClassificationDay,
  type ClassificationSummaryRead,
} from './admin-classification';
import { textAsc } from './collation';
import {
  anyNotComparable,
  collectionMethodSeam,
  type CollectionMethodChange,
} from './collection-method-changes';
import {
  ARRIVAL_CF_COVERAGE_MIN,
  readArrivalCfCoverage,
  type ArrivalCfCoverage,
} from './arrival-coverage';
// The population predicates live in their own module (AECI-745) so that BOTH this
// file and `swarm-detection.ts` can import them and neither has to import the other.
import {
  BOT,
  HUMAN,
  NOT_INTERNAL,
  NOT_INTERNAL_BEFORE_RETRO_JOIN,
  OPERATOR_PAIR_MATCH,
} from './page-view-predicates';
import { productAttributedViews } from './product-attributed-views';

/** A single UTC-day window plus the immediately-preceding day (for day-over-day deltas). */
export interface DigestWindow {
  /** Inclusive start of the reported day (ISO 8601, UTC midnight). */
  startIso: string;
  /** Exclusive end of the reported day (== start of "today", UTC midnight). */
  endIso: string;
  /** Inclusive start of the prior day (== `startIso` − 24h) for the delta baseline. */
  priorStartIso: string;
  /** Human label for the reported day, e.g. `2026-07-23` (UTC). */
  dayLabel: string;
}

const DAY = 86_400_000;

/**
 * The window for an arbitrary UTC day, `YYYY-MM-DD`. Factored out of
 * {@link dailyWindows} so the admin panel can report any single day through the
 * exact same window arithmetic the 05:00 email uses — "identical to that day's
 * digest" is an AECI-574 acceptance criterion, and a second copy of this
 * arithmetic is precisely how the two would drift apart.
 */
export function windowsForDay(dayLabel: string): DigestWindow {
  const startDay = Date.parse(`${dayLabel}T00:00:00.000Z`);
  return {
    startIso: new Date(startDay).toISOString(),
    endIso: new Date(startDay + DAY).toISOString(),
    priorStartIso: new Date(startDay - DAY).toISOString(),
    dayLabel,
  };
}

/**
 * The prior *complete* UTC day relative to `now`, plus the day before it (delta
 * baseline). Run at ~05:00 UTC (noon Jakarta), this reports a full, already-closed calendar day —
 * never a partial one. ISO-8601 `text` timestamps sort lexicographically the same as
 * chronologically, so the `gte`/`lt` string range on `created_at` is exact.
 */
export function dailyWindows(now: Date): DigestWindow {
  const startToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return windowsForDay(new Date(startToday - DAY).toISOString().slice(0, 10));
}

/** A product and its human view count in the reported window. */
export interface TopProduct {
  name: string;
  slug: string;
  views: number;
}

/** One bot/crawler and how many page views (crawls) it made in the reported day. */
export interface BotActivity {
  name: string;
  crawls: number;
}

/** A human traffic source (e.g. LinkedIn, Google, Direct) and its view count. */
export interface ReferrerCount {
  source: string;
  views: number;
}

/** A count for the reported day and the day before (for the delta). */
export interface DailyCount {
  day: number;
  prior: number;
}

export interface AnalyticsMetrics {
  /**
   * HUMAN page views (`is_bot IS NOT 1`) in the reported day / prior day. Raw:
   * nothing subtracted. Not printed since AECI-1460; `job_runs.detail` records it
   * as `pageViewsHuman`, the same figure as the `traffic.page_views_human` key.
   */
  pageViews: DailyCount;
  /** Bot/crawler page views (`is_bot = 1`) in the reported day / prior day. */
  botPageViews: DailyCount;
  /** New accounts (profiles created) in the reported day / prior day. */
  newUsers: DailyCount;
  /** Cumulative registered users as of the run. */
  totalUsers: number;
  /** Reviews currently awaiting moderation (a live snapshot, not windowed). */
  pendingModeration: number;
  /** Top products by HUMAN views in the reported day, less classed automation
   *  (AECI-1460; up to 5; empty when none). */
  topProducts: TopProduct[];
  /** HUMAN traffic sources in the reported day (LinkedIn/Google/Direct/…), less
   *  classed automation (AECI-1460), most first. */
  referrers: ReferrerCount[];
  /**
   * True when {@link topProducts} and {@link referrers} are NOT filtered by class
   * (AECI-1460): the reported day has no classification rows, or the read failed.
   * Both surfaces then say so (the email's {@link TABLES_UNCLASSIFIED_NOTE}, the
   * overview's `tables_unclassified` note).
   */
  tablesUnclassified: boolean;
  /** Every bot/crawler active in the reported day, most crawls first. */
  botActivity: BotActivity[];
  /**
   * Human views the operator-pair retro-join removed from the reported day
   * ({@link OPERATOR_PAIR_MATCH}, AECI-683) — i.e. rows a lapsed admin session
   * left unflagged.
   *
   * Reported rather than silently subtracted because, unlike the path and session
   * halves of {@link NOT_INTERNAL}, this half is an inference about identity. The
   * class section prints it on its internal line.
   */
  operatorLeakViews: number;
  /**
   * Whether the reported day's full-document arrivals actually carried network
   * metadata (AECI-868 / AECI-869).
   *
   * This is not a caveat about a number — it is whether the INPUT to half the
   * numbers existed. Every network-based classifier input reads `cf_asn` and
   * treats NULL as *no evidence* rather than as an error, so when the column stops
   * arriving the automation classes quietly shrink. On production that ran for
   * four days and read as a good week.
   *
   * Collected here rather than in either surface because both must say the same
   * thing (AECI-745): the email prints it above the tables and in the subject,
   * and `/admin/overview` prints it in the §13 D15 envelope.
   */
  arrivalCoverage: ArrivalCfCoverage;
  /**
   * The same measurement for the PRIOR day — the delta baseline.
   *
   * Present for one reason: a day-over-day comparison between a measured day and
   * a blind one is not a comparison, and {@link deltaText} has to be able to say
   * so. A blind day over-reports, so the morning after the pipeline breaks reads
   * as growth.
   */
  priorArrivalCoverage: ArrivalCfCoverage;
  /**
   * The stored D19 traffic classes for the reported day and the prior day
   * (AECI-1346, D19 Phase 3). The email leads with them.
   *
   * **Null means the read FAILED**, and the email says the classes could not be
   * read. A day the classifier never ran is not null: it is an object whose
   * `day.summary.classifier_version` is null. Neither state prints zeros.
   */
  classification: DigestClassification | null;
}

/**
 * The classes the digest leads with, read from `page_view_classifications`
 * through the same two functions `/admin/overview` uses (`admin-classification.ts`).
 */
export interface DigestClassification {
  /** The reported day: four class counts with visitors, plus the internal split. */
  day: ClassificationSummaryRead;
  /** The prior day's views per class, or null when the prior day was not classified. */
  prior: ClassificationDay | null;
  /** The D19(c) seam over `[prior day, reported day]`, or null. */
  versionSeam: AdminClassificationSummary['version_seam'];
}

const TOP_PRODUCTS_LIMIT = 5;

/**
 * The first UTC day whose `page_views` rows carry pair-page attribution
 * (AECI-929 / `ADMIN_PANEL_SPEC.md` §7.3). Before it, a view of an integration
 * pair page counted for neither endpoint, so a top-products table spanning it
 * compares two different populations. Both renderings print it under the table.
 *
 * Set to the production deploy date of migration 0067. The backfill
 * (`scripts/ops/2026-10-pair-page-view-backfill/`) can move earlier rows into the
 * population, but it has not run on production, so this date stands until it does.
 */
export const PAIR_ATTRIBUTION_STARTS_ON = '2026-10-09';

/** The caption both renderings print under the top-products table. */
export const PAIR_ATTRIBUTION_NOTE = `Includes integration-page views from ${PAIR_ATTRIBUTION_STARTS_ON}.`;

/**
 * Is this window's arrival telemetry too sparse for the network-based exclusions
 * to have meant anything (AECI-869)?
 *
 * `arrivals > 0` first, and it is not defensive: {@link readArrivalCfCoverage}
 * returns coverage 1 for an empty window, so the guard is really about intent —
 * a day with no arrivals has nothing to be blind about, and reporting an outage
 * on a quiet night is how a warning stops being read.
 *
 * One predicate, exported, so the email, the panel note and the tile caption
 * cannot end up with three readings of one ratio.
 */
export function arrivalTelemetryDegraded(coverage: ArrivalCfCoverage): boolean {
  return coverage.arrivals > 0 && coverage.coverage < ARRIVAL_CF_COVERAGE_MIN;
}

/**
 * The sentence both renderings of the email print when {@link arrivalTelemetryDegraded}
 * is true, and the panel's `arrival_telemetry_unavailable` note restates.
 *
 * It names the consequence rather than the cause. An operator does not need to
 * know that a cache gateway replaced `request.cf`; they need to know that the
 * exclusions they are reading the output of did not run.
 */
export const ARRIVAL_TELEMETRY_UNAVAILABLE_NOTE =
  'Arrival network telemetry unavailable for this day; network-based exclusions did not run.';

/**
 * Is a day-over-day comparison of this window's `page_views` figures meaningless
 * because one of the two days was blind (AECI-869)?
 *
 * **Either** day, not both. A measured day beside a blind one is the case that
 * actually misleads: the blind day over-reports, so the morning the pipeline
 * breaks prints growth and the morning it is fixed prints a collapse. Two blind
 * days are also incomparable, but at least consistently so.
 *
 * Scoped to the page-view family: since AECI-1460 that is the crawler delta.
 * `newUsers` buckets `profiles.created_at` and
 * reads no network column at all, so its delta stays a real comparison on a blind
 * day and suppressing it would be a false alarm.
 */
export function trafficDaysNotComparable(metrics: AnalyticsMetrics): boolean {
  return (
    arrivalTelemetryDegraded(metrics.arrivalCoverage) ||
    arrivalTelemetryDegraded(metrics.priorArrivalCoverage)
  );
}

/** `COUNT(*)` of human or bot `page_views` in `[startIso, endIso)`. */
async function countPageViews(
  db: Db,
  startIso: string,
  endIso: string,
  kind: 'human' | 'bot',
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(pageViews)
    .where(
      and(
        gte(pageViews.createdAt, startIso),
        lt(pageViews.createdAt, endIso),
        kind === 'bot' ? BOT : HUMAN,
        NOT_INTERNAL,
      ),
    );
  return row?.value ?? 0;
}

/** `COUNT(*)` of `profiles` created in `[startIso, endIso)` — new sign-ins. */
async function countNewProfiles(db: Db, startIso: string, endIso: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(profiles)
    .where(and(gte(profiles.createdAt, startIso), lt(profiles.createdAt, endIso)));
  return row?.value ?? 0;
}

/**
 * Top products by HUMAN `page_views` in `[startIso, endIso)`, joined to `products`.
 *
 * A product's views include the integration pair pages it is an endpoint of, so
 * one pair-page view counts for both products (AECI-929, `productAttributedViews`).
 * The caller's predicates run once, inside that helper's CTE, so the class
 * filter's subquery is bound once rather than per attribution column.
 *
 * `classFilter` is {@link automationClassFilterForDay}'s predicate (AECI-1460),
 * or undefined on an unclassified day.
 */
async function topProductsByViews(
  db: Db,
  startIso: string,
  endIso: string,
  classFilter: SQL | undefined,
): Promise<TopProduct[]> {
  const av = productAttributedViews(
    db,
    and(
      gte(pageViews.createdAt, startIso),
      lt(pageViews.createdAt, endIso),
      HUMAN,
      NOT_INTERNAL,
      classFilter,
    ),
  );
  const rows = await db
    .with(av.cte)
    .select({ name: products.name, slug: products.slug, views: count() })
    .from(av.views)
    .innerJoin(products, eq(av.productId, products.id))
    .groupBy(products.id)
    // A count tie reads A to Z, then id, so the cut at the limit is stable
    // (AECI-1243).
    .orderBy(desc(count()), textAsc(products.name), asc(products.id))
    .limit(TOP_PRODUCTS_LIMIT);
  return rows.map((r) => ({ name: r.name, slug: r.slug, views: r.views }));
}

/** HUMAN traffic sources in `[startIso, endIso)`, grouped by `referrer_source`, most
 *  first. Rows captured before the referrer classifier shipped have a NULL
 *  `referrer_source` and are excluded (there's nothing to attribute). `classFilter`
 *  is the same class predicate the product table takes (AECI-1460). */
async function referrerBreakdown(
  db: Db,
  startIso: string,
  endIso: string,
  classFilter: SQL | undefined,
): Promise<ReferrerCount[]> {
  const rows = await db
    .select({ source: pageViews.referrerSource, views: count() })
    .from(pageViews)
    .where(
      and(
        gte(pageViews.createdAt, startIso),
        lt(pageViews.createdAt, endIso),
        HUMAN,
        isNotNull(pageViews.referrerSource),
        NOT_INTERNAL,
        classFilter,
      ),
    )
    .groupBy(pageViews.referrerSource)
    // Count tie: A to Z; the raw column settles a case-only tie (AECI-1243).
    .orderBy(desc(count()), textAsc(pageViews.referrerSource), asc(pageViews.referrerSource));
  return rows.map((r) => ({ source: r.source ?? 'Direct', views: r.views }));
}

/** Every bot/crawler active in `[startIso, endIso)`, grouped by `bot_name`, most
 *  crawls first. A NULL `bot_name` (shouldn't occur for `is_bot = 1`) falls back to
 *  "Other bot" so the grouping stays labelled. */
async function botActivityInWindow(
  db: Db,
  startIso: string,
  endIso: string,
): Promise<BotActivity[]> {
  const rows = await db
    .select({ name: pageViews.botName, crawls: count() })
    .from(pageViews)
    .where(
      and(gte(pageViews.createdAt, startIso), lt(pageViews.createdAt, endIso), BOT, NOT_INTERNAL),
    )
    .groupBy(pageViews.botName)
    // Count tie: A to Z; the raw column settles a case-only tie (AECI-1243).
    .orderBy(desc(count()), textAsc(pageViews.botName), asc(pageViews.botName));
  return rows.map((r) => ({ name: r.name ?? 'Other bot', crawls: r.crawls }));
}

/** `COUNT(*)` of the rows {@link OPERATOR_PAIR_MATCH} removes from the human
 *  population — the positive form of the same expression `NOT_INTERNAL` negates,
 *  so the reported figure and the exclusion cannot drift. */
async function countOperatorLeakViews(db: Db, startIso: string, endIso: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(pageViews)
    .where(
      and(
        gte(pageViews.createdAt, startIso),
        lt(pageViews.createdAt, endIso),
        HUMAN,
        NOT_INTERNAL_BEFORE_RETRO_JOIN,
        OPERATOR_PAIR_MATCH,
      ),
    );
  return row?.value ?? 0;
}

/**
 * Run every read for the digest concurrently. Report-only; never mutates.
 *
 * One read runs first: the tables' class filter for the reported day
 * (AECI-1460), because both table queries take its predicate. Everything else
 * runs in one fan-out. Before AECI-1460 that first read was the swarm detector,
 * about seven reads per day over two days; this is one grouped read.
 */
export async function collectAnalyticsMetrics(
  db: Db,
  window: DigestWindow,
): Promise<AnalyticsMetrics> {
  const tableFilter = await readTableClassFilter(db, window.dayLabel);
  const [
    humanViewsDay,
    humanViewsPrior,
    botViewsDay,
    botViewsPrior,
    newUsersDay,
    newUsersPrior,
    totalUsersRows,
    pendingRows,
    topProducts,
    referrers,
    botActivity,
    operatorLeakViews,
    arrivalCoverage,
    priorArrivalCoverage,
    classification,
  ] = await Promise.all([
    countPageViews(db, window.startIso, window.endIso, 'human'),
    countPageViews(db, window.priorStartIso, window.startIso, 'human'),
    countPageViews(db, window.startIso, window.endIso, 'bot'),
    countPageViews(db, window.priorStartIso, window.startIso, 'bot'),
    countNewProfiles(db, window.startIso, window.endIso),
    countNewProfiles(db, window.priorStartIso, window.startIso),
    db.select({ value: count() }).from(profiles),
    db.select({ value: count() }).from(reviews).where(eq(reviews.status, 'pending')),
    topProductsByViews(db, window.startIso, window.endIso, tableFilter.predicate),
    referrerBreakdown(db, window.startIso, window.endIso, tableFilter.predicate),
    botActivityInWindow(db, window.startIso, window.endIso),
    countOperatorLeakViews(db, window.startIso, window.endIso),
    // AECI-869. Both days: the crawler delta compares them, and a comparison
    // across a telemetry boundary is not one. Two cheap single-row aggregates.
    readArrivalCfCoverage(db, window.startIso, window.endIso),
    readArrivalCfCoverage(db, window.priorStartIso, window.startIso),
    // AECI-1346. The D19 classes, in the same fan-out. Soft: a failure is null.
    readDigestClassification(db, window),
  ]);
  // The summary passes the D15(b) operator-leak figure through to the class
  // section's internal line. It is counted in the same fan-out, so it is attached
  // here.
  if (classification) {
    classification.day.summary.internal_excluded.operator_leak_inferred = operatorLeakViews;
  }
  return {
    pageViews: { day: humanViewsDay, prior: humanViewsPrior },
    botPageViews: { day: botViewsDay, prior: botViewsPrior },
    newUsers: { day: newUsersDay, prior: newUsersPrior },
    totalUsers: totalUsersRows[0]?.value ?? 0,
    pendingModeration: pendingRows[0]?.value ?? 0,
    topProducts,
    referrers,
    tablesUnclassified: tableFilter.unclassified,
    botActivity,
    operatorLeakViews,
    arrivalCoverage,
    priorArrivalCoverage,
    classification,
  };
}

/**
 * The tables' class filter for the reported day (AECI-1460).
 *
 * **Fails soft, to unfiltered.** A failed read returns `unclassified: true`, so
 * the tables print unfiltered with the same note an unclassified day gets.
 * Throwing would take the whole 05:00 email and `/admin/overview` down for a
 * filter on two tables.
 */
async function readTableClassFilter(db: Db, day: string): Promise<AutomationClassFilter> {
  try {
    return await automationClassFilterForDay(db, day);
  } catch (err) {
    console.warn('[analytics-digest] class filter read failed; the tables are unfiltered', err);
    return { predicate: undefined, version: null, unclassified: true };
  }
}

/**
 * The reported day's class summary and the prior day's class views (AECI-1346).
 *
 * Two reads: the day's summary, and a two-day series that yields the prior day
 * and the seam through the same `versionSeamFor` rule the overview uses.
 *
 * **Fails soft.** A failure returns null and the email says the classes could
 * not be read. Throwing would take the whole 05:00 email down for one section.
 */
async function readDigestClassification(
  db: Db,
  window: DigestWindow,
): Promise<DigestClassification | null> {
  const priorDay = window.priorStartIso.slice(0, 10);
  try {
    const [day, series] = await Promise.all([
      readClassificationSummary(db, { fromDay: window.dayLabel, toDay: window.dayLabel }, 0),
      readClassificationSeries(db, { fromDay: priorDay, toDay: window.dayLabel }),
    ]);
    return {
      day,
      prior: series.perDay.get(priorDay) ?? null,
      versionSeam: series.versionSeam,
    };
  } catch (err) {
    console.warn('[analytics-digest] classification read failed; the email omits the classes', err);
    return null;
  }
}

// ─── Pure formatter ──────────────────────────────────────────────────────────────

export interface AnalyticsDigestOptions {
  /** Deployment env label for the subject + header (e.g. `production`). */
  env: string;
  /** The reported UTC day, e.g. `2026-07-23` (from `DigestWindow.dayLabel`). */
  dayLabel: string;
  /** When the run completed — rendered into the header. */
  generatedAt: Date;
  // AECI-1460 removed `posthog`, `posthogUnavailable`, `browserStarts` and
  // `browserStartsUnavailable`: the email prints no PostHog figure any more.
}

export interface EmailDigest {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function plural(n: number, singular: string): string {
  return `${n} ${singular}${n === 1 ? '' : 's'}`;
}

/** The arithmetic behind {@link deltaText}, as structured data. */
export interface Delta {
  current: number;
  prior: number;
  /** `current - prior`. */
  diff: number;
  /** Rounded percentage change, or `null` when `prior` is 0 — a percentage
   *  against zero is meaningless, so the digest omits it in exactly that case. */
  pct: number | null;
}

/**
 * Period-over-period delta. Extracted from {@link deltaText} so the admin panel
 * (AECI-574) can return the SAME numbers as structured JSON: the panel must
 * localize its own prose (CLAUDE.md's i18n rule is unconditional), but it must
 * not re-derive the semantics — "identical to that day's digest email" is an
 * acceptance criterion, and sharing this function is what makes it true by
 * construction rather than by inspection.
 */
export function computeDelta(c: DailyCount): Delta {
  const diff = c.day - c.prior;
  // `|| 0` normalizes the `-0` that `Math.sign(-1) * 0` produces for a change too
  // small to round to a whole percent — `-0` serializes as `0` but fails a strict
  // `Object.is` assertion, which is exactly the kind of ghost a parity spec should
  // not have to chase.
  const pct =
    c.prior > 0 ? Math.round((Math.abs(diff) / c.prior) * 100) * Math.sign(diff) || 0 : null;
  return { current: c.day, prior: c.prior, diff, pct };
}

/**
 * Human day-over-day delta, e.g. `+8 (+18%) vs 45 prior day`, `-3 (-7%) vs 45 prior
 * day`, or `no change vs prior day`. Percentages are omitted when the prior day was 0
 * (division would be meaningless). ASCII only, so it renders cleanly in plain text.
 *
 * **`notComparable` suppresses the arithmetic entirely (AECI-869)**, rather than
 * printing it with a caveat attached. A delta is a single claim — "this moved by
 * N" — and a claim qualified underneath itself is still read as the claim; the
 * figure is what gets quoted. When one of the two days had no arrival network
 * telemetry, its exclusions did not run and its count is inflated by an unknown
 * amount, so the difference is not a measurement of anything. The correct output
 * is not a hedged number, it is no number.
 *
 * Passed by the caller rather than derived here because this function takes a
 * {@link DailyCount} and a count does not know which days it spans.
 */
function deltaText(
  c: DailyCount,
  opts: { notComparable?: NotComparableReason | null } = {},
): string {
  if (opts.notComparable) return NOT_COMPARABLE_TEXT[opts.notComparable];
  const { diff, pct } = computeDelta(c);
  if (diff === 0) return 'no change vs prior day';
  const magnitude = Math.abs(diff);
  const sign = diff > 0 ? '+' : '-';
  const pctText = pct === null ? '' : ` (${sign}${Math.abs(pct)}%)`;
  return `${sign}${magnitude}${pctText} vs ${c.prior} prior day`;
}

/**
 * Why a day-over-day delta prints no arithmetic. `telemetry` is AECI-869's
 * blind-day rule. The other three are AECI-1346's class rules
 * ({@link classDeltaBlocker}), and `method` also covers the crawler delta.
 */
export type NotComparableReason = 'telemetry' | Exclude<ClassDeltaBlocker, 'day_unclassified'>;

const NOT_COMPARABLE_TEXT: Record<NotComparableReason, string> = {
  telemetry: 'not comparable with the prior day (arrival network telemetry was unavailable)',
  classifier: 'not comparable with the prior day (classifier changed)',
  method: 'not comparable with the prior day (collection method changed)',
  prior_unclassified: 'not comparable with the prior day (the prior day was not classified)',
};

/**
 * The §3d collection-method changes for this tier between the start of the prior
 * day and the end of the reported day (AECI-1346). A row there means the two
 * days the deltas compare were counted differently. `env` is the raw `ENV` var.
 */
export function digestMethodSeams(env: string, dayLabel: string): CollectionMethodChange[] {
  const w = windowsForDay(dayLabel);
  return collectionMethodSeam(env, { startIso: w.priorStartIso, endIso: w.endIso });
}

/**
 * Why the crawler page-view delta prints no arithmetic, or null. AECI-869's
 * telemetry rule first, then a non-comparable §3d row (AECI-1346), because both
 * change which rows the two days count.
 */
function pageViewDeltaNotComparable(
  metrics: AnalyticsMetrics,
  methodRows: readonly CollectionMethodChange[],
): NotComparableReason | null {
  if (trafficDaysNotComparable(metrics)) return 'telemetry';
  if (anyNotComparable(methodRows)) return 'method';
  return null;
}

/** The four D19(b) classes, in reporting order, with the email's labels. */
const CLASS_LABELS: ReadonlyArray<{ cls: AdminTrafficClass; label: string }> = [
  { cls: 'identified_automation', label: 'Identified automation' },
  { cls: 'suspected_automation', label: 'Suspected automation' },
  { cls: 'browser_with_human_evidence', label: 'Browser activity with supporting human evidence' },
  { cls: 'unresolved', label: 'Unresolved' },
];

/** The heuristic caveat, printed beside the human-evidence row, never in the footer. */
const HEURISTIC_NOTE =
  'This class is a heuristic. It means our app ran and nothing contradicted it. It does not prove a person was there.';

const NOT_CLASSIFIED_NOTE = 'The classifier did not run for this day. No class counts are shown.';
const CLASSES_UNREAD_NOTE =
  'The traffic classes could not be read for this day. No class counts are shown.';

/** `2026-10-21T10:38:00.000Z` as `2026-10-21 10:38 UTC`. */
function utcMinute(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** One sentence per §3d row, naming the change and its treatment. */
function methodSeamSentence(row: CollectionMethodChange): string {
  return (
    `Collection method changed at ${utcMinute(row.at)}: ${row.summary} (${row.issue}). ` +
    (row.arrivalsComparable
      ? 'Arrival counts stay comparable, so the changes vs the prior day stand.'
      : 'Counts either side are not comparable, so the changes vs the prior day are not shown.')
  );
}

/** One row of the class section, already computed for both renderings. */
interface ClassRow {
  label: string;
  views: number;
  visitors: number;
  delta: string;
  cls: AdminTrafficClass;
}

/**
 * Everything the class section prints, computed once for the subject, the text
 * and the HTML (AECI-1346). `state` separates the three cases that must never
 * look alike: classified, not classified, and a failed read.
 */
interface ClassSection {
  state: 'classified' | 'not_classified' | 'unread';
  version: string | null;
  rows: ClassRow[];
  internalViews: number;
  operatorLeak: number;
  unresolvedShare: { unresolved: number; classified: number } | null;
  versionSeam: AdminClassificationSummary['version_seam'];
  methodRows: CollectionMethodChange[];
}

function classSection(metrics: AnalyticsMetrics, opts: AnalyticsDigestOptions): ClassSection {
  const methodRows = digestMethodSeams(opts.env, opts.dayLabel);
  const c = metrics.classification;
  const empty = {
    version: null,
    rows: [],
    internalViews: 0,
    operatorLeak: 0,
    unresolvedShare: null,
    versionSeam: null,
    methodRows,
  };
  if (!c) return { state: 'unread', ...empty };
  const summary = c.day.summary;
  if (!summary.classifier_version) return { state: 'not_classified', ...empty };

  const blocker = classDeltaBlocker(
    summary.classifier_version,
    c.prior?.version,
    anyNotComparable(methodRows),
  );
  const reason = blocker === 'day_unclassified' ? null : blocker;
  const rows = CLASS_LABELS.map(({ cls, label }) => {
    const count = summary.counts.find((x) => x.class === cls);
    const views = count?.views ?? 0;
    return {
      cls,
      label,
      views,
      visitors: count?.visitors ?? 0,
      delta: deltaText({ day: views, prior: c.prior?.views[cls] ?? 0 }, { notComparable: reason }),
    };
  });
  return {
    state: 'classified',
    version: summary.classifier_version,
    rows,
    internalViews: summary.internal_excluded.views,
    operatorLeak: summary.internal_excluded.operator_leak_inferred,
    unresolvedShare: c.day.unresolvedShareExceeded
      ? { unresolved: c.day.unresolved, classified: c.day.classified }
      : null,
    versionSeam: c.versionSeam,
    methodRows,
  };
}

/** The class section's warning and seam sentences, shared by both renderings. */
function classSectionNotes(sec: ClassSection): string[] {
  const out: string[] = [];
  if (sec.versionSeam) {
    out.push(
      `Classifier changed from ${sec.versionSeam.from_version} to ${sec.versionSeam.to_version} ` +
        `on ${sec.versionSeam.changed_on}. Each day is counted on its own version, so the changes ` +
        'vs the prior day are not shown.',
    );
  }
  out.push(...sec.methodRows.map(methodSeamSentence));
  return out;
}

function unresolvedShareSentence(share: { unresolved: number; classified: number }): string {
  return (
    `More than ${CLASSIFICATION_UNRESOLVED_SHARE_MAX * 100}% of the classified requests are unresolved ` +
    `(${share.unresolved} of ${share.classified}). Read the split as mostly unknown, not as a confident breakdown.`
  );
}

function internalSentence(sec: ClassSection): string {
  return (
    `Internal traffic, excluded by identity: ${plural(sec.internalViews, 'view')}. ` +
    `Operator-leak inference: ${plural(sec.operatorLeak, 'view')}. It is not a class, and no class above counts it.`
  );
}

export function buildAnalyticsDigest(
  metrics: AnalyticsMetrics,
  opts: AnalyticsDigestOptions,
): EmailDigest {
  return {
    subject: buildSubject(metrics, opts),
    text: buildText(metrics, opts),
    html: buildHtml(metrics, opts),
  };
}

function buildSubject(metrics: AnalyticsMetrics, opts: AnalyticsDigestOptions): string {
  const { botPageViews: bot, newUsers, topProducts } = metrics;
  const topName = topProducts[0]?.name;
  // AECI-1346 made the classes lead. AECI-1460 removed the residual fallback, so
  // a day with no classes carries no traffic count at all, only the reason. A
  // missing classifier run is still visible before the email is opened.
  // `automation` is identified plus suspected.
  const sec = classSection(metrics, opts);
  const views = (cls: AdminTrafficClass) => sec.rows.find((r) => r.cls === cls)?.views ?? 0;
  const headline =
    sec.state === 'classified'
      ? `${views('browser_with_human_evidence')} with human evidence · ` +
        `${views('unresolved')} unresolved · ` +
        `${views('identified_automation') + views('suspected_automation')} automation (${sec.version})`
      : sec.state === 'unread'
        ? 'CLASSES UNAVAILABLE'
        : 'NOT CLASSIFIED';
  // The telemetry outage goes in the SUBJECT, not only the body. A four-day
  // outage read as a good week because every surface that could have reported it
  // was one the operator had to open first.
  const blind = arrivalTelemetryDegraded(metrics.arrivalCoverage) ? ' · NO NETWORK TELEMETRY' : '';
  return (
    `AECi daily digest (${opts.env}) — ${opts.dayLabel}: ` +
    `${headline}, ${plural(newUsers.day, 'new user')}` +
    (topName ? ` · top: ${topName}` : '') +
    (bot.day > 0 ? ` · ${plural(bot.day, 'crawl')}` : '') +
    blind
  );
}

// ── plain text ──

/**
 * The table headings and the note an unclassified day carries (AECI-1460).
 * One source for both renderings, so the text and the HTML cannot drift.
 */
export const TABLES_UNCLASSIFIED_NOTE =
  'This day has no traffic classes, so the product and source tables are not filtered for automation.';

function productsHeading(metrics: AnalyticsMetrics): string {
  return metrics.tablesUnclassified
    ? 'Most viewed products (not filtered by class)'
    : 'Most viewed products (excluding classed automation)';
}

function sourcesHeading(metrics: AnalyticsMetrics): string {
  return metrics.tablesUnclassified
    ? 'Traffic sources (not filtered by class)'
    : 'Traffic sources (excluding classed automation)';
}

/** The AECI-869 blind-day sentences. They sit above the tables, because when
 *  they fire the classifier's network inputs had nothing to read. */
function telemetrySentences(metrics: AnalyticsMetrics): string[] {
  if (!arrivalTelemetryDegraded(metrics.arrivalCoverage)) return [];
  const { arrivals, arrivalsWithAsn } = metrics.arrivalCoverage;
  return [
    ARRIVAL_TELEMETRY_UNAVAILABLE_NOTE,
    `Only ${arrivalsWithAsn} of ${arrivals} full-document arrivals carried a network (ASN), so the ` +
      'datacentre classification, both automation groupings and the operator retro-join had no ' +
      'input. This day is not comparable with a day that has telemetry.',
  ];
}

/** The footer both renderings print. */
const FOOTER_LINES = [
  'Human vs. bot is classified at capture from User-Agent + network (ASN) — a maintained heuristic, not exact.',
  'Traffic sources come from the Referer header (best-effort — privacy tools strip it, so external sources are under-counted; stripped arrivals fall into Direct).',
  'Report-only: counts are read from the app database; the window is the full prior UTC day.',
];

function buildText(metrics: AnalyticsMetrics, opts: AnalyticsDigestOptions): string {
  const { botPageViews: bot, newUsers, totalUsers, pendingModeration } = metrics;
  const { topProducts, referrers, botActivity } = metrics;
  const notComparable = pageViewDeltaNotComparable(
    metrics,
    digestMethodSeams(opts.env, opts.dayLabel),
  );

  const t: string[] = [
    'AECi daily analytics digest',
    `Environment: ${opts.env}`,
    `Day (UTC): ${opts.dayLabel}`,
    `Generated: ${opts.generatedAt.toISOString()}`,
    '',
    ...classSectionText(metrics, opts),
    ...telemetrySentences(metrics).map((n) => `  ** ${n}`),
    '',
    `== ${productsHeading(metrics)} ==`,
  ];
  if (metrics.tablesUnclassified) t.push(`  ** ${TABLES_UNCLASSIFIED_NOTE}`);
  if (topProducts.length > 0) {
    topProducts.forEach((p, i) =>
      t.push(`  ${i + 1}. ${p.name} — ${plural(p.views, 'view')} (/${p.slug})`),
    );
    // AECI-929. Under the list, because it qualifies every number in it.
    t.push(`  (${PAIR_ATTRIBUTION_NOTE})`);
  } else {
    t.push('(no product page views)');
  }

  t.push('', `== ${sourcesHeading(metrics)} ==`);
  if (referrers.length > 0) {
    referrers.forEach((r, i) => t.push(`  ${i + 1}. ${r.source} — ${plural(r.views, 'view')}`));
  } else {
    t.push('(no referrer data yet)');
  }

  t.push(
    '',
    '== Sign-ins ==',
    `New sign-ins (new accounts): ${newUsers.day} (${deltaText(newUsers)})`,
    `Total sign-ins (registered users): ${totalUsers}`,
    '',
    '== Moderation ==',
    pendingModeration > 0
      ? `Reviews awaiting moderation: ${pendingModeration} — see /admin/reviews`
      : 'Reviews awaiting moderation: 0',
    '',
    '== Crawler activity ==',
  );
  if (botActivity.length > 0) {
    t.push(
      `Bot/crawler page views: ${bot.day} (${deltaText(bot, { notComparable })}) from ${plural(botActivity.length, 'source')}`,
    );
    botActivity.forEach((b, i) => t.push(`  ${i + 1}. ${b.name} — ${plural(b.crawls, 'crawl')}`));
  } else {
    t.push('No bot/crawler activity.');
  }

  t.push('', ...FOOTER_LINES);
  return t.join('\n');
}

/**
 * The class section as plain text (AECI-1346). First in the email. Every figure
 * names its basis (D19(a)), internal traffic is its own line (D19(b)), and a
 * seam is flagged, never blended (D19(c)).
 */
function classSectionText(metrics: AnalyticsMetrics, opts: AnalyticsDigestOptions): string[] {
  const sec = classSection(metrics, opts);
  const t: string[] = ['== Traffic by class (requests) =='];
  const notes = classSectionNotes(sec).map((n) => `  ** ${n}`);
  if (sec.state !== 'classified') {
    t.push(sec.state === 'unread' ? CLASSES_UNREAD_NOTE : NOT_CLASSIFIED_NOTE, ...notes);
    return t;
  }
  t.push(`Classifier ${sec.version}. Counts are requests, not people.`, ...notes);
  for (const r of sec.rows) {
    t.push(
      `${r.label}: ${plural(r.views, 'view')} from ${plural(r.visitors, 'visitor')} (${r.delta})`,
    );
    if (r.cls === 'browser_with_human_evidence') t.push(`  ${HEURISTIC_NOTE}`);
    if (r.cls === 'unresolved' && sec.unresolvedShare) {
      t.push(`  ** ${unresolvedShareSentence(sec.unresolvedShare)}`);
    }
  }
  t.push(internalSentence(sec));
  return t;
}

/** The class section as HTML (AECI-1346). Same facts and sentences as the text. */
function classSectionHtml(metrics: AnalyticsMetrics, opts: AnalyticsDigestOptions): string {
  const sec = classSection(metrics, opts);
  const callout = (text: string) =>
    `<p style="margin:10px 0 0;padding:10px 12px;border-left:3px solid ${HTML.accent};background:${HTML.accentSoft};font-size:13px;color:${HTML.ink}">${escapeHtml(text)}</p>`;
  const notes = classSectionNotes(sec).map(callout).join('');
  const title = sectionTitle('Traffic by class (requests)');
  if (sec.state !== 'classified') {
    return (
      title + emptyNote(sec.state === 'unread' ? CLASSES_UNREAD_NOTE : NOT_CLASSIFIED_NOTE) + notes
    );
  }
  const muted = `font-weight:400;color:${HTML.muted}`;
  const rows = sec.rows.flatMap((r) => {
    const out = [
      kvRow(
        r.label,
        `${r.views} <span style="${muted}">· ${escapeHtml(plural(r.visitors, 'visitor'))} · ${escapeHtml(r.delta)}</span>`,
      ),
    ];
    if (r.cls === 'browser_with_human_evidence') {
      out.push(
        `<tr><td colspan="2" style="padding:0 0 7px;font-size:12px;color:${HTML.muted}">${escapeHtml(HEURISTIC_NOTE)}</td></tr>`,
      );
    }
    if (r.cls === 'unresolved' && sec.unresolvedShare) {
      out.push(
        `<tr><td colspan="2" style="padding:0 0 7px;font-size:12px;color:${HTML.danger}">${escapeHtml(unresolvedShareSentence(sec.unresolvedShare))}</td></tr>`,
      );
    }
    return out;
  });
  return (
    title +
    `<p style="margin:0 0 6px;font-size:13px;color:${HTML.muted}">Classifier <strong style="color:${HTML.ink}">${escapeHtml(sec.version ?? '')}</strong>. Counts are requests, not people.</p>` +
    notes +
    kvTable(rows) +
    `<p style="margin:10px 0 0;padding-top:8px;border-top:1px solid ${HTML.border};font-size:13px;color:${HTML.muted}">${escapeHtml(internalSentence(sec))}</p>`
  );
}

// ── html ──

const HTML = {
  ink: '#27272a',
  muted: '#71717a',
  border: '#e4e4e7',
  accent: '#2e4a3d',
  accentSoft: '#eef2f0',
  danger: '#b91c1c',
  pageBg: '#f4f4f5',
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function sectionTitle(label: string): string {
  return `<h3 style="margin:28px 0 10px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${HTML.accent}">${escapeHtml(label)}</h3>`;
}

/** A label:value row for the compact key/value tables (sign-ins, moderation). */
function kvRow(label: string, value: string, emphasize = false): string {
  const valColor = emphasize ? HTML.danger : HTML.ink;
  return (
    `<tr><td style="padding:7px 0;color:${HTML.muted};font-size:14px">${escapeHtml(label)}</td>` +
    `<td style="padding:7px 0;text-align:right;color:${valColor};font-weight:600;font-size:14px">${value}</td></tr>`
  );
}

function kvTable(rows: string[]): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${rows.join('')}</table>`;
}

/** A ranked data table: `#`, a left label, and a right-aligned count. */
function rankTable(
  labelHead: string,
  countHead: string,
  rows: ReadonlyArray<{ label: string; count: number }>,
): string {
  const th = `padding:6px 0;border-bottom:2px solid ${HTML.border};color:${HTML.muted};font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em`;
  const body = rows
    .map((r, i) => {
      const td = `padding:9px 0;border-bottom:1px solid ${HTML.border}`;
      return (
        `<tr><td style="${td};color:${HTML.muted};width:28px">${i + 1}</td>` +
        `<td style="${td};padding-left:8px;color:${HTML.ink}">${r.label}</td>` +
        `<td style="${td};text-align:right;color:${HTML.ink};font-weight:600">${r.count}</td></tr>`
      );
    })
    .join('');
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px">` +
    `<thead><tr><th style="${th};text-align:left;width:28px">#</th>` +
    `<th style="${th};text-align:left;padding-left:8px">${escapeHtml(labelHead)}</th>` +
    `<th style="${th};text-align:right">${escapeHtml(countHead)}</th></tr></thead>` +
    `<tbody>${body}</tbody></table>`
  );
}

function emptyNote(text: string): string {
  return `<p style="margin:8px 0 0;font-size:14px;color:${HTML.muted}">${escapeHtml(text)}</p>`;
}

function buildHtml(metrics: AnalyticsMetrics, opts: AnalyticsDigestOptions): string {
  const { botPageViews: bot, newUsers, totalUsers, pendingModeration } = metrics;
  const { topProducts, referrers, botActivity } = metrics;
  const notComparable = pageViewDeltaNotComparable(
    metrics,
    digestMethodSeams(opts.env, opts.dayLabel),
  );

  const header =
    `<div style="border-top:4px solid ${HTML.accent};background:${HTML.accentSoft};padding:20px 24px">` +
    `<div style="font-size:18px;font-weight:700;color:${HTML.ink}">AECi daily analytics digest</div>` +
    `<div style="margin-top:6px;font-size:13px;color:${HTML.muted}">` +
    `<span style="display:inline-block;background:${HTML.accent};color:#fff;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:600;letter-spacing:.03em">${escapeHtml(opts.env)}</span>` +
    `&nbsp; · &nbsp;${escapeHtml(opts.dayLabel)} (UTC)&nbsp; · &nbsp;generated ${escapeHtml(opts.generatedAt.toISOString())}</div></div>`;

  // AECI-869. Styled as the loudest thing in the email, because it does not
  // qualify a figure, it says the classifier's network inputs were empty.
  const [telemetryHead, telemetryBody] = telemetrySentences(metrics);
  const telemetryLine = telemetryHead
    ? `<p style="margin:10px 0 0;padding:10px 12px;border-left:3px solid ${HTML.danger};background:#fef2f2;font-size:13px;color:${HTML.ink}">` +
      `<strong style="color:${HTML.danger}">${escapeHtml(telemetryHead)}</strong> ${escapeHtml(telemetryBody ?? '')}</p>`
    : '';
  const unclassifiedLine = metrics.tablesUnclassified
    ? `<p style="margin:0 0 8px;font-size:13px;color:${HTML.muted}">${escapeHtml(TABLES_UNCLASSIFIED_NOTE)}</p>`
    : '';

  const productLabel = (p: TopProduct): string =>
    `${escapeHtml(p.name)} <span style="color:${HTML.muted};font-size:12px">/${escapeHtml(p.slug)}</span>`;
  const productsSection =
    sectionTitle(productsHeading(metrics)) +
    unclassifiedLine +
    (topProducts.length > 0
      ? rankTable(
          'Product',
          'Views',
          topProducts.map((p) => ({ label: productLabel(p), count: p.views })),
        ) +
        // AECI-929. Under the table, because it qualifies every number in it.
        `<p style="margin:6px 0 0;font-size:13px;color:${HTML.muted}">${escapeHtml(PAIR_ATTRIBUTION_NOTE)}</p>`
      : emptyNote('No product page views.'));

  const referrersSection =
    sectionTitle(sourcesHeading(metrics)) +
    (referrers.length > 0
      ? rankTable(
          'Source',
          'Views',
          referrers.map((r) => ({ label: escapeHtml(r.source), count: r.views })),
        )
      : emptyNote('No referrer data yet.'));

  const signIns =
    sectionTitle('Sign-ins') +
    kvTable([
      kvRow(
        'New sign-ins (new accounts)',
        `${newUsers.day} <span style="font-weight:400;color:${HTML.muted}">(${escapeHtml(deltaText(newUsers))})</span>`,
      ),
      kvRow('Total registered users', String(totalUsers)),
    ]);

  const moderation =
    sectionTitle('Moderation') +
    kvTable([
      pendingModeration > 0
        ? kvRow('Reviews awaiting moderation', `${pendingModeration} · /admin/reviews`, true)
        : kvRow('Reviews awaiting moderation', '0'),
    ]);

  const crawlers =
    sectionTitle('Crawler activity') +
    (botActivity.length > 0
      ? `<p style="margin:0 0 8px;font-size:14px;color:${HTML.muted}">${bot.day} bot/crawler page view${bot.day === 1 ? '' : 's'} <span style="color:${HTML.ink}">(${escapeHtml(deltaText(bot, { notComparable }))})</span> from ${botActivity.length} source${botActivity.length === 1 ? '' : 's'}.</p>` +
        rankTable(
          'Bot / crawler',
          'Crawls',
          botActivity.map((b) => ({ label: escapeHtml(b.name), count: b.crawls })),
        )
      : emptyNote('No bot/crawler activity.'));

  // Same prose as the plain-text footer, from the same constant.
  const footer = escapeHtml(FOOTER_LINES.join(' '));

  return (
    `<!doctype html><html lang="en"><head>` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light">` +
    `<title>AECi daily analytics digest — ${escapeHtml(opts.dayLabel)}</title>` +
    `</head>` +
    `<body style="margin:0;padding:0;background:${HTML.pageBg}">` +
    `<div style="max-width:640px;margin:0 auto;padding:24px 12px">` +
    `<div style="background:#fff;border:1px solid ${HTML.border};border-radius:10px;overflow:hidden;font-family:${FONT};color:${HTML.ink}">` +
    header +
    `<div style="padding:4px 24px 24px">${classSectionHtml(metrics, opts)}${telemetryLine}${productsSection}${referrersSection}${signIns}${moderation}${crawlers}</div>` +
    `</div>` +
    `<div style="max-width:640px;margin:12px auto 0;padding:0 4px;font-size:12px;line-height:1.5;color:${HTML.muted};font-family:${FONT}">${footer}</div>` +
    `</div></body></html>`
  );
}
