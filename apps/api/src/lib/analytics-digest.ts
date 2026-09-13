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
 * ─── What the headline is CALLED, and why (AECI-869) ────────────────────────
 *
 * It is **"requests of unresolved origin"**, not "human page views". The figure is
 * unchanged — see {@link unresolvedRequests} — but the name it carried until
 * 2026-09-11 asserted something the evidence never supported. Every exclusion
 * behind it is a *negative* test: not on the crawler list, not failing the
 * AECI-658 header checks, not over a swarm threshold. None of that is evidence of
 * a person, and AECI-868 showed how far the gap can open: for four days the cache
 * gateway replaced `request.cf` on the SSR loopback, every full-document arrival
 * stored a NULL `cf_asn`, `countDistinct(cf_asn)` was therefore zero, and neither
 * automation grouping nor the operator retro-join could fire over a population of
 * any size. The residual read 364 / 699 / 680 and the email called all of it
 * human.
 *
 * Two consequences are built into this module rather than left to the reader:
 * **{@link arrivalTelemetryDegraded}** puts the outage in the subject line and at
 * the top of the tile, so a blind day can never again look like a quiet one; and
 * **{@link trafficDaysNotComparable}** suppresses the delta arithmetic outright
 * across a telemetry boundary rather than hedging it. The word "human" survives in
 * exactly one place, {@link corroboratedLines}, which names its own evidence.
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
 *     the operator-only paths (below).
 *   - crawler activity: `page_views` where `is_bot = 1`, grouped by `bot_name`.
 *   - new users: `profiles.created_at` (a profile row is created on first sign-in).
 *   - total users: cumulative `COUNT(profiles)`.
 *   - pending moderation: `reviews` where `status='pending'` (a live snapshot).
 */

import { and, count, desc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { pageViews, products, profiles, reviews } from '../db/schema';
import {
  ARRIVAL_CF_COVERAGE_MIN,
  readArrivalCfCoverage,
  type ArrivalCfCoverage,
} from './arrival-coverage';
// The population predicates live in their own module (AECI-745) so that BOTH this
// file and `swarm-detection.ts` can import them and neither has to import the
// other. That is what lets the collector below run the detector itself instead of
// leaving the figure stranded in `scheduled.ts`, reachable only by the email.
import {
  type AutomationExclusion,
  BOT,
  HUMAN,
  NOT_INTERNAL,
  NOT_INTERNAL_BEFORE_RETRO_JOIN,
  notFlagged,
  OPERATOR_PAIR_LOOKBACK_DAYS,
  OPERATOR_PAIR_MATCH,
} from './page-view-predicates';
import { NAMED_REFERRER_SOURCES } from './referrer-classification';
import {
  detectSwarms,
  NON_BROWSER_VERDICTS,
  type SwarmSummary,
  swarmNote,
} from './swarm-detection';

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
  /** HUMAN page views (`is_bot IS NOT 1`) in the reported day / prior day. */
  pageViews: DailyCount;
  /** Bot/crawler page views (`is_bot = 1`) in the reported day / prior day. */
  botPageViews: DailyCount;
  /** New accounts (profiles created) in the reported day / prior day. */
  newUsers: DailyCount;
  /** Cumulative registered users as of the run. */
  totalUsers: number;
  /** Reviews currently awaiting moderation (a live snapshot, not windowed). */
  pendingModeration: number;
  /** Top products by HUMAN views in the reported day (up to 5; empty when none). */
  topProducts: TopProduct[];
  /** HUMAN traffic sources in the reported day (LinkedIn/Google/Direct/…), most first. */
  referrers: ReferrerCount[];
  /** Every bot/crawler active in the reported day, most crawls first. */
  botActivity: BotActivity[];
  /**
   * Human views carrying a NAMED external referrer (`NAMED_REFERRER_SOURCES`) in
   * the reported day / prior day — the digest's CORROBORATED population
   * (AECI-683).
   *
   * A third figure beside the server-side upper bound and the PostHog lower
   * bound, and the only one of the three that a rotating-proxy pool cannot
   * inflate: it sends no `Referer` at all. It is a floor, not a truth — see
   * {@link NAMED_REFERRER_SOURCES} for the two caveats that must be printed
   * beside it.
   */
  corroboratedViews: DailyCount;
  /** DISTINCT `(user_agent_hash, cf_asn)` — §9.8 "visitors" — behind
   *  `corroboratedViews.day`. The number the operator actually wants: on
   *  2026-08-26 it was 7, behind 8 corroborated views, against a headline of 102. */
  corroboratedVisitors: number;
  /**
   * Human views the operator-pair retro-join removed from the reported day
   * ({@link OPERATOR_PAIR_MATCH}, AECI-683) — i.e. rows a lapsed admin session
   * left unflagged.
   *
   * Reported rather than silently subtracted because, unlike the path and session
   * halves of {@link NOT_INTERNAL}, this half is an inference about identity.
   * A number that quietly moved would be the same failure mode the headline had.
   */
  operatorLeakViews: number;
  /**
   * The automation filter for this window and the one before it, or `null` when
   * the detector did not run (AECI-745).
   *
   * **The nullability is a distinction, not a convenience.** `null` means the
   * detector FAILED — an outage — and both surfaces must then report the raw
   * count *plus a warning that it is unfiltered*. An object whose `note` is null
   * means it ran and flagged nothing, which is a RESULT and reads as a clean day.
   * Collapsing the two would make a failed detector look like a clean day, and a
   * clean day is exactly what a failed detector must never be allowed to look
   * like.
   *
   * This field is why AECI-745 exists: before it, the figure was computed in
   * `scheduled.ts` beside the digest and so reached the EMAIL only, leaving
   * `/admin/overview` leading with the raw count while the 05:00 mail led with
   * the filtered one. Anything both surfaces should report belongs here.
   */
  automation: AutomationFilter | null;
  /**
   * The reported day's full detector output, for the `job_runs` detail projection
   * in `scheduled.ts` and nothing else.
   *
   * Separate from {@link automation} on purpose: that one is the shared contract
   * both surfaces render, this one is the cron's diagnostic record (candidate
   * counts, truncation, the non-browser networks). It rides along so the cron
   * keeps its detail WITHOUT a second detector run — the prior day's summary is
   * not carried, because the only thing the cron reads from it is already
   * `automation.flagged.prior`.
   */
  swarm: SwarmSummary | null;
  /**
   * Whether the reported day's full-document arrivals actually carried network
   * metadata (AECI-868 / AECI-869).
   *
   * This is not a caveat about a number — it is whether the INPUT to half the
   * numbers existed. Every network-based exclusion reads `cf_asn` and treats NULL
   * as *no evidence* rather than as an error, so when the column stops arriving
   * the exclusions quietly stop excluding and the residual grows. On production
   * that ran for four days and read as a good week.
   *
   * Collected here rather than in either surface because both must say the same
   * thing (AECI-745): the email prints it beside the headline and
   * `/admin/overview` prints it in the §13 D15 envelope.
   */
  arrivalCoverage: ArrivalCfCoverage;
  /**
   * The same measurement for the PRIOR day — the delta baseline.
   *
   * Present for one reason: a day-over-day comparison between a measured day and
   * a blind one is not a comparison, and {@link deltaText} has to be able to say
   * so. Same argument as {@link AutomationFilter.flagged}'s `prior`, which exists
   * because comparing a filtered day against an unfiltered one manufactures a
   * fake delta. Here the manufactured delta points the other way — a blind day
   * over-reports, so the morning after the pipeline breaks reads as growth.
   */
  priorArrivalCoverage: ArrivalCfCoverage;
}

const TOP_PRODUCTS_LIMIT = 5;

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
 * The headline's label, inflected (AECI-869).
 *
 * A helper rather than {@link plural}, which appends an `s` to the last word and
 * would produce "requests of unresolved origins". Named and exported so the
 * subject, the plain-text body and the HTML tile cannot drift — the whole point
 * of the rename is that one class of number has one name everywhere.
 */
export function unresolvedLabel(n: number): string {
  return n === 1 ? 'request of unresolved origin' : 'requests of unresolved origin';
}

/**
 * Is a day-over-day comparison of this window's `page_views` figures meaningless
 * because one of the two days was blind (AECI-869)?
 *
 * **Either** day, not both. A measured day beside a blind one is the case that
 * actually misleads: the blind day over-reports, so the morning the pipeline
 * breaks prints growth and the morning it is fixed prints a collapse. Two blind
 * days are also incomparable, but at least consistently so.
 *
 * Scoped to the page-view family. `newUsers` buckets `profiles.created_at` and
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

/** Top products by HUMAN `page_views` in `[startIso, endIso)`, joined to `products`. */
async function topProductsByViews(
  db: Db,
  startIso: string,
  endIso: string,
  exclusion?: AutomationExclusion,
): Promise<TopProduct[]> {
  const rows = await db
    .select({ name: products.name, slug: products.slug, views: count() })
    .from(pageViews)
    .innerJoin(products, eq(pageViews.productId, products.id))
    .where(
      and(
        gte(pageViews.createdAt, startIso),
        lt(pageViews.createdAt, endIso),
        isNotNull(pageViews.productId),
        HUMAN,
        NOT_INTERNAL,
        notFlagged(exclusion),
      ),
    )
    .groupBy(products.id)
    .orderBy(desc(count()))
    .limit(TOP_PRODUCTS_LIMIT);
  return rows.map((r) => ({ name: r.name, slug: r.slug, views: r.views }));
}

/** HUMAN traffic sources in `[startIso, endIso)`, grouped by `referrer_source`, most
 *  first. Rows captured before the referrer classifier shipped have a NULL
 *  `referrer_source` and are excluded (there's nothing to attribute). */
async function referrerBreakdown(
  db: Db,
  startIso: string,
  endIso: string,
  exclusion?: AutomationExclusion,
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
        notFlagged(exclusion),
      ),
    )
    .groupBy(pageViews.referrerSource)
    .orderBy(desc(count()));
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
    .orderBy(desc(count()));
  return rows.map((r) => ({ name: r.name ?? 'Other bot', crawls: r.crawls }));
}

/** `COUNT(*)` of human views in `[startIso, endIso)` carrying a NAMED external
 *  referrer. Deliberately `IN (named)` rather than `!= 'Direct'`: `Other` is an
 *  open bucket a forger controls, and `Direct` swallows every stripped referral. */
async function countCorroboratedViews(db: Db, startIso: string, endIso: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(pageViews)
    .where(
      and(
        gte(pageViews.createdAt, startIso),
        lt(pageViews.createdAt, endIso),
        HUMAN,
        NOT_INTERNAL,
        inArray(pageViews.referrerSource, [...NAMED_REFERRER_SOURCES]),
      ),
    );
  return row?.value ?? 0;
}

/** DISTINCT `(user_agent_hash, cf_asn)` behind {@link countCorroboratedViews}.
 *
 *  `coalesce` on both halves is not decoration: `count(distinct a || '|' || b)`
 *  over a NULL-bearing tuple yields NULL for the whole concatenation and the row
 *  vanishes from the count. Same expression the panel uses for §9.8 visitors, so
 *  the two cannot disagree about what a visitor is. */
async function countCorroboratedVisitors(
  db: Db,
  startIso: string,
  endIso: string,
): Promise<number> {
  const [row] = await db
    .select({
      value: sql<number>`count(distinct coalesce(${pageViews.userAgentHash}, '') || '|' || coalesce(${pageViews.cfAsn}, ''))`,
    })
    .from(pageViews)
    .where(
      and(
        gte(pageViews.createdAt, startIso),
        lt(pageViews.createdAt, endIso),
        HUMAN,
        NOT_INTERNAL,
        inArray(pageViews.referrerSource, [...NAMED_REFERRER_SOURCES]),
      ),
    );
  return Number(row?.value ?? 0);
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
 * Since AECI-745 this ALSO runs the swarm detector, rather than taking its result
 * from a caller. That inverts the old arrangement deliberately: an
 * `AutomationExclusion` parameter is a parameter a caller can forget, and
 * `/admin/overview` forgot it for the whole life of the field, which is the
 * divergence this closes. Detection is now a property of collecting the metrics,
 * so no caller can collect them without it.
 */
export async function collectAnalyticsMetrics(
  db: Db,
  window: DigestWindow,
): Promise<AnalyticsMetrics> {
  const { swarm, automation, exclusion } = await runAutomationFilter(db, window);
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
    corroboratedDay,
    corroboratedPrior,
    corroboratedVisitors,
    operatorLeakViews,
    arrivalCoverage,
    priorArrivalCoverage,
  ] = await Promise.all([
    countPageViews(db, window.startIso, window.endIso, 'human'),
    countPageViews(db, window.priorStartIso, window.startIso, 'human'),
    countPageViews(db, window.startIso, window.endIso, 'bot'),
    countPageViews(db, window.priorStartIso, window.startIso, 'bot'),
    countNewProfiles(db, window.startIso, window.endIso),
    countNewProfiles(db, window.priorStartIso, window.startIso),
    db.select({ value: count() }).from(profiles),
    db.select({ value: count() }).from(reviews).where(eq(reviews.status, 'pending')),
    topProductsByViews(db, window.startIso, window.endIso, exclusion),
    referrerBreakdown(db, window.startIso, window.endIso, exclusion),
    botActivityInWindow(db, window.startIso, window.endIso),
    countCorroboratedViews(db, window.startIso, window.endIso),
    countCorroboratedViews(db, window.priorStartIso, window.startIso),
    countCorroboratedVisitors(db, window.startIso, window.endIso),
    countOperatorLeakViews(db, window.startIso, window.endIso),
    // AECI-869. Both days, for the reason `runAutomationFilter` reads both days:
    // the headline's delta compares them, and a comparison across a telemetry
    // boundary is not one. Two cheap single-row aggregates, in the existing
    // fan-out rather than after it.
    readArrivalCfCoverage(db, window.startIso, window.endIso),
    readArrivalCfCoverage(db, window.priorStartIso, window.startIso),
  ]);
  return {
    pageViews: { day: humanViewsDay, prior: humanViewsPrior },
    botPageViews: { day: botViewsDay, prior: botViewsPrior },
    newUsers: { day: newUsersDay, prior: newUsersPrior },
    totalUsers: totalUsersRows[0]?.value ?? 0,
    pendingModeration: pendingRows[0]?.value ?? 0,
    topProducts,
    referrers,
    botActivity,
    corroboratedViews: { day: corroboratedDay, prior: corroboratedPrior },
    corroboratedVisitors,
    operatorLeakViews,
    automation,
    swarm,
    arrivalCoverage,
    priorArrivalCoverage,
  };
}

/**
 * The row-level exclusion a detector run implies — the exact complement of the
 * views its `flaggedViews` counted.
 *
 * Exported because `/admin/overview` needs it too: its `excluding_internal` is a
 * SUBSET of the post-automation total, so it has to filter by the same rows the
 * headline subtracted or it can report a subset larger than its own superset.
 * Deriving it in one place is what keeps that impossible; the route reads
 * `metrics.swarm` and calls this rather than re-mapping the candidate lists.
 *
 * `undefined` for a null summary, which reads through `notFlagged` as "no
 * filter" — the correct behaviour when the detector did not run, since the
 * headline it accompanies is the unfiltered count.
 */
export function automationExclusionFor(
  swarm: SwarmSummary | null,
): AutomationExclusion | undefined {
  if (!swarm) return undefined;
  return {
    uaHashes: swarm.uaCandidates.map((c) => c.userAgentHash),
    asns: swarm.asnCandidates.map((c) => c.cfAsn),
    // Unconditional, unlike the two lists: the detector's union count always
    // includes the verdict matcher, so its complement must too, or the tables
    // would keep rows the headline already subtracted (AECI-744).
    verdicts: [...NON_BROWSER_VERDICTS],
  };
}

/**
 * Detect the reported day's automated clients and the prior day's, and turn them
 * into the two shapes the rest of this module needs: the {@link AutomationFilter}
 * both surfaces report, and the {@link AutomationExclusion} the per-row tables
 * filter by.
 *
 * ─── Both days, and that is not symmetry for its own sake ───────────────────
 *
 * The headline is the count remaining AFTER the filter, so its day-over-day delta
 * has to subtract from both sides. Comparing a filtered day against an unfiltered
 * prior day would manufacture a large fake drop on the first morning and a wrong
 * delta every morning after (AECI-741).
 *
 * ─── Fails SOFT, and loudly ─────────────────────────────────────────────────
 *
 * A detector failure returns `automation: null` and no exclusion, which the
 * formatter already renders as the raw count plus an explicit UNFILTERED warning,
 * and which the panel renders the same way. Letting it throw instead would take
 * down the 05:00 digest AND `/admin/overview` — two surfaces whose whole job is
 * to keep reporting — for a bug in one of the numbers they report. The
 * `console.warn` is what keeps that degradation from being silent; `job_runs`
 * records the null alongside it.
 */
async function runAutomationFilter(
  db: Db,
  window: DigestWindow,
): Promise<{
  swarm: SwarmSummary | null;
  automation: AutomationFilter | null;
  exclusion: AutomationExclusion | undefined;
}> {
  try {
    const [day, prior] = await Promise.all([
      detectSwarms(db, window.startIso, window.endIso),
      detectSwarms(db, window.priorStartIso, window.startIso),
    ]);
    return {
      swarm: day,
      automation: {
        flagged: { day: day.flaggedViews, prior: prior.flaggedViews },
        note: swarmNote(day),
      },
      exclusion: automationExclusionFor(day),
    };
  } catch (err) {
    console.warn('[analytics-digest] swarm detection failed; reporting UNFILTERED', err);
    return { swarm: null, automation: null, exclusion: undefined };
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
  /**
   * The client-side human floor (AECI-660). Present only when the PostHog query
   * ran; the formatter renders an "unavailable" note otherwise, never a zero.
   * A fabricated 0 beside a real 48 would read as a finding.
   */
  posthog?: { pageviews: number; people: number } | null;
  /** Why the PostHog figure is missing, when it is. Shown so a silently-skipping
   *  join is visible in the email rather than only in `job_runs`. */
  posthogUnavailable?: string | null;
  /**
   * Successful browser-bundle executions (AECI-870) — the `app_started` Tier 2
   * beacon, operator and PostHog-detected bots removed.
   *
   * A THIRD population, and the only one in this email that a client which never
   * runs JavaScript cannot enter. Same absent-vs-zero discipline as `posthog`
   * above: null renders an "unavailable" note, and zero renders as zero, because
   * zero starts on a day with arrivals is a finding — a broken bundle or a
   * blocked collector — rather than an absence.
   */
  browserStarts?: { startsAll: number; starts: number; searchReferred: number } | null;
  /** Why the browser-start figure is missing, when it is. */
  browserStartsUnavailable?: string | null;
  // NOTE: there is deliberately no `automation` option here any more (AECI-745).
  // The filter now arrives on `AnalyticsMetrics.automation`, computed by the same
  // call that produced every other number in the email. An option would be a
  // SECOND source for the one figure `unresolvedRequests` exists to keep
  // single-sourced, and an option a caller can pass is an option a caller can
  // pass differently from the one the panel reads.
}

/**
 * What the caller measured about automated traffic in the reported day — the
 * input behind the digest's headline number (AECI-741).
 *
 * `note` being null means "the detector ran and flagged nothing", which is a
 * RESULT. The whole object being null/absent means "the detector did not run",
 * which is an OUTAGE. The two render differently on purpose: the first is a
 * headline equal to the raw count, the second is a headline equal to the raw
 * count *plus a warning that it is unfiltered*. Collapsing them into one
 * nullable string — which is what the previous `swarmNote` option did — makes a
 * failed detector look like a clean day, and a clean day is exactly what a
 * failed detector must never be allowed to look like.
 */
export interface AutomationFilter {
  /**
   * Human views attributable to a flagged automated client, in the reported day
   * and the prior day.
   *
   * `prior` is not decoration. The headline is now the count remaining AFTER
   * this filter, so its day-over-day delta has to subtract from both sides.
   * Comparing a filtered day against an unfiltered prior day would manufacture a
   * large fake drop on the first morning and a wrong delta every morning after.
   */
  flagged: DailyCount;
  /** The pre-rendered `swarmNote(...)` sentence, or null when nothing was flagged. */
  note: string | null;
}

/**
 * The digest's HEADLINE population: **requests of unresolved origin** — page
 * views left after the crawler classification and the automation filter, for the
 * reported day and the prior day.
 *
 * ─── The arithmetic is AECI-745's; the name is AECI-869's ───────────────────
 *
 * This was `unresolvedRequests` until 2026-09-11 and nothing about what it
 * computes has changed. What changed is the claim the name made. Passing the
 * crawler list, the AECI-658 header checks and the swarm thresholds is the
 * **absence of a bot match**; it is not evidence of a person, and the two are
 * only close when the detectors have inputs. AECI-868 removed those inputs for
 * four days — every arrival stored a NULL `cf_asn`, so `countDistinct(cf_asn)`
 * was zero and neither grouping could fire over a population of any size — and
 * the residual inflated to 364 / 699 / 680 with nothing anywhere saying the
 * exclusions had stopped working. A number called "humans" cannot report that
 * about itself; a number called "unresolved" can.
 *
 * Exported so the admin panel can lead with the same figure rather than
 * re-deriving the subtraction — the §6.10 parity guarantee is only structural
 * while both surfaces read one definition. Since AECI-745 it takes the metrics
 * ALONE, because the filter now lives on them: passing the filter separately
 * would let a caller subtract one day's flagged count from another day's total.
 *
 * The wire field is still `page_views_human` and the stored series is still
 * `traffic.page_views_human_after_automation`. Neither was renamed: the metric
 * key is `metrics_daily.metric` verbatim and renaming it would orphan every
 * stored row, and the wire field was already redefined once ten days earlier.
 * Both carry the explanation in their own docblocks instead.
 *
 * Clamped at zero defensively. `flagged` is a subset of the same
 * `HUMAN`+`NOT_INTERNAL` population `pageViews` counts, computed from the same
 * predicates over the same window, so it cannot legitimately exceed it — but a
 * negative headline would be a far worse failure than a zero one if that ever
 * stopped being true.
 */
export function unresolvedRequests(metrics: AnalyticsMetrics): DailyCount {
  const automation = metrics.automation;
  if (!automation) return metrics.pageViews;
  return {
    day: Math.max(0, metrics.pageViews.day - automation.flagged.day),
    prior: Math.max(0, metrics.pageViews.prior - automation.flagged.prior),
  };
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
function deltaText(c: DailyCount, opts: { notComparable?: boolean } = {}): string {
  if (opts.notComparable) {
    return 'not comparable with the prior day (arrival network telemetry was unavailable)';
  }
  const { diff, pct } = computeDelta(c);
  if (diff === 0) return 'no change vs prior day';
  const magnitude = Math.abs(diff);
  const sign = diff > 0 ? '+' : '-';
  const pctText = pct === null ? '' : ` (${sign}${Math.abs(pct)}%)`;
  return `${sign}${magnitude}${pctText} vs ${c.prior} prior day`;
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
  const { pageViews: pv, botPageViews: bot, newUsers, topProducts } = metrics;
  const topName = topProducts[0]?.name;
  const net = unresolvedRequests(metrics);
  // The subject line is the number the operator actually reads, so it carries
  // the filtered figure with the raw one in parentheses (AECI-741) rather than
  // the reverse. ASCII, not a "<=" glyph, so it survives every mail client's
  // subject rendering.
  //
  // AECI-869 renamed the class. The old subject read "N human views after
  // automation", and "after automation" was doing the work of a disclaimer that
  // the word before it cancelled out. "Unresolved" carries the same information
  // without the claim, so the qualifier is no longer load-bearing and the raw
  // count keeps its parenthesis. Without the filter the AECI-658 hedge is now
  // redundant for the same reason — "up to N unresolved" says nothing "N
  // unresolved (UNFILTERED)" does not, and UNFILTERED names the actual defect.
  const headline = metrics.automation
    ? `${net.day} ${unresolvedLabel(net.day)} (${pv.day} raw)`
    : `${pv.day} ${unresolvedLabel(pv.day)} (UNFILTERED)`;
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
 * What the headline is, and what sits beside it, as one plain-text block.
 *
 * Shared by the text and HTML builders so the wording cannot drift between the
 * two renderings of the same email — an explanation only helps if both halves say
 * the same thing.
 *
 * ─── Three figures, three populations, NO arithmetic between them (AECI-869) ──
 *
 * The block used to read as one bracket: a server-side upper bound, a PostHog
 * lower bound, and the headline "our best estimate inside that range". Two of
 * those three claims were wrong.
 *
 * - **The headline is not a count of humans.** It is what no rule excluded. The
 *   rules are a crawler list, a set of header checks, and thresholds that need a
 *   `cf_asn` to evaluate; when the ASN stopped arriving (AECI-868) the thresholds
 *   stopped firing and the residual grew with nothing to say why.
 * - **PostHog is not a floor under it.** Its query filters event, date and host
 *   and nothing else (`lib/posthog-query.ts`), so it counts operators and any bot
 *   that runs JavaScript, and `uniq(person_id)` is an identity count rather than
 *   a person count. Measured twice against production, its "1 person" WAS the
 *   operator (2026-08-23 and 2026-08-26). A number that includes the operator
 *   cannot bound a number that excludes them, in either direction.
 *
 * So each is stated as its own observation with its own caveat, and the email no
 * longer tells the reader to subtract, bracket or interpolate between them. The
 * one honest relation left is the corroborated line, and it says what corroborated
 * it.
 */
function boundsLines(metrics: AnalyticsMetrics, opts: AnalyticsDigestOptions): string[] {
  const lines = metrics.automation
    ? [
        `The headline counts requests no rule could exclude. It is the ${metrics.pageViews.day} views`,
        `counted server-side less the ${metrics.automation.flagged.day} attributed to automated clients.`,
        'Read it as a RESIDUAL, not as people: surviving the crawler list, the header checks and the',
        'automation thresholds is the absence of a bot match, not evidence of a person. The raw',
        'server-side figure is an UPPER bound on humans — it is written on every full-document load,',
        'so any crawler that does not run JavaScript is still in it. Most viewed products and Traffic',
        'sources below exclude the same flagged clients, so every figure in this email describes one',
        'population.',
      ]
    : [
        'The automation filter did not run for this day, so the headline is UNFILTERED: nothing has',
        'been subtracted from the raw server-side count at all. Page views are counted on every',
        'full-document load, so any crawler that does not run JavaScript is in the number, and it is',
        'not comparable with a day the filter ran on.',
      ];
  // AECI-869. Placed here, at the top of the explanation, rather than after the
  // three figures: when this fires it does not qualify them, it invalidates them.
  if (arrivalTelemetryDegraded(metrics.arrivalCoverage)) {
    const { arrivals, arrivalsWithAsn } = metrics.arrivalCoverage;
    lines.push(
      ARRIVAL_TELEMETRY_UNAVAILABLE_NOTE,
      `Only ${arrivalsWithAsn} of ${arrivals} full-document arrivals carried a network (ASN), so the`,
      'datacentre classification, both automation groupings and the operator retro-join had no input',
      'and could not fire. Absent evidence is not evidence of absence: the headline is inflated by an',
      'unknown amount and this day is NOT comparable with a day that has telemetry.',
    );
  }
  if (opts.posthog) {
    const { pageviews, people } = opts.posthog;
    // A SEPARATE observation (AECI-869), deliberately not framed as a bound on
    // the headline. Both caveats are mandatory: the filter is host+date only, and
    // `uniq(person_id)` counts identities rather than people.
    lines.push(
      `Separately, PostHog recorded ${plural(pageviews, 'page view')} from ` +
        `${people} ${people === 1 ? 'identity' : 'identities'} on the same day and host. That is a` +
        ' different population, not a floor under the headline: it fires only when our JavaScript' +
        ' runs and the visitor consented, and its filter is event, date and host only — so operators' +
        ' and any script that runs JavaScript are both still in it. Twice in August its "1 person"' +
        ' was the operator. Do not add it to, or subtract it from, any figure above.',
    );
  } else if (opts.posthogUnavailable) {
    lines.push(`PostHog client-side figure unavailable (${opts.posthogUnavailable}).`);
  }
  // AECI-870. A THIRD observation, beside the consented `$pageview` one and
  // never summed with it: their populations overlap, and one is consent-gated
  // while the other is not. Placed after it because they come from the same
  // vendor and a reader who has just been told not to add PostHog to the
  // headline needs to be told the same thing about this before moving on.
  if (opts.browserStarts) {
    const { starts, searchReferred } = opts.browserStarts;
    lines.push(
      `Browser starts: ${starts} (${searchReferred} search-referred). Operator and` +
        ' PostHog-detected bots excluded. Counts bundle executions, not people; browsers with' +
        ' tracker blockers never report. This is the one figure here a client that never runs' +
        ' JavaScript cannot enter, which makes a zero on a day with arrivals a finding rather' +
        ' than a quiet day. It is not a floor under the headline and not an addend to it: a' +
        ' successful start proves execution, not humanity, and a real headless browser produces' +
        ' one. Do not add it to, or subtract it from, any figure above.',
    );
  } else if (opts.browserStartsUnavailable) {
    lines.push(`Browser-start figure unavailable (${opts.browserStartsUnavailable}).`);
  }
  lines.push(...corroboratedLines(metrics));
  if (metrics.operatorLeakViews > 0) {
    lines.push(
      `${plural(metrics.operatorLeakViews, 'view')} were excluded as operator self-traffic that a ` +
        `lapsed admin session left unflagged: same browser and network as a verified operator ` +
        `session within ${OPERATOR_PAIR_LOOKBACK_DAYS} days. That is an inference about identity, ` +
        `not a verified session, which is why it is stated rather than silently subtracted.`,
    );
  }
  return lines;
}

/**
 * The corroborated-human sentences (AECI-683), shared by both renderings.
 *
 * **The one place in this email that may say "human" (AECI-869)**, and it may
 * only because it names its own evidence in the same breath: a NAMED external
 * search or social referrer. Every other figure here is a residual, a raw count
 * or a different population; this is the only one with a positive signal behind
 * it, and a proxy pool cannot manufacture that signal because it sends no
 * `Referer` at all.
 *
 * Both caveats are mandatory and neither is boilerplate. It is a FLOOR because
 * Referrer-Policy strips real referrals into `Direct`; and a referrer is a CLAIM,
 * unverifiable by construction now that only the host is stored (§9.7) — prod
 * holds one confirmed forgery. A number this small reads as precise unless the
 * text says otherwise, and the whole point of this digest change is to stop
 * numbers reading as more certain than they are.
 *
 * It is **supporting evidence, not a verified floor**. The caveats are what make
 * the difference, so neither may be dropped to shorten the email.
 */
function corroboratedLines(metrics: AnalyticsMetrics): string[] {
  const { day } = metrics.corroboratedViews;
  if (day === 0) {
    return [
      'No arrival carried an external search or social referrer, so nothing in the day is',
      'positively corroborated as human. That is common at this volume, not an outage — and it',
      'does not make the headline above any more or less likely to be people.',
    ];
  }
  const visitors = metrics.corroboratedVisitors;
  return [
    `Separately, ${plural(day, 'view')} from ${plural(visitors, 'visitor')} arrived with a NAMED ` +
      `external search or social referrer. That referrer is what corroborates them as human, and ` +
      `it is the only positive evidence of a person this email holds: a rotating-proxy pool sends ` +
      `no Referer at all, so it cannot manufacture one.`,
    'It is supporting evidence, not a verified floor. Privacy tools strip the header, so real',
    'referrals land in Direct and this under-counts; and a referrer is a claim the request made,',
    'not a verified fact — only the host is stored, and production holds one confirmed forgery.',
    'It is a SUBSET of the headline, never an addend to it.',
  ];
}

function buildText(metrics: AnalyticsMetrics, opts: AnalyticsDigestOptions): string {
  const { pageViews: pv, botPageViews: bot, newUsers, totalUsers, pendingModeration } = metrics;
  const { topProducts, referrers, botActivity } = metrics;

  const t: string[] = [
    'AECi daily analytics digest',
    `Environment: ${opts.env}`,
    `Day (UTC): ${opts.dayLabel}`,
    `Generated: ${opts.generatedAt.toISOString()}`,
    '',
    // AECI-869: the section no longer claims the population it reports. "Humans"
    // was the heading over a residual.
    '== Traffic (unresolved origin) ==',
  ];
  // Headline first, raw second, indented under it (AECI-741). The operator asked
  // for the post-automation figure to be the number they SEE; ordering is most of
  // what makes that true in a plain-text mail client, where there is no type
  // scale to lean on.
  const net = unresolvedRequests(metrics);
  const notComparable = trafficDaysNotComparable(metrics);
  if (metrics.automation) {
    t.push(
      `Requests of unresolved origin: ${net.day} (${deltaText(net, { notComparable })})  [headline]`,
      `  from ${pv.day} counted server-side (${deltaText(pv, { notComparable })}), less ` +
        `${plural(metrics.automation.flagged.day, 'view')} flagged as automation  [upper bound]`,
    );
  } else {
    t.push(
      `Requests of unresolved origin: ${pv.day} (${deltaText(pv, { notComparable })})  [upper bound]`,
      '  (automation filter did not run this day — this figure is UNFILTERED)',
    );
  }
  // AECI-869. Directly under the headline, because it is the one line that says
  // whether the exclusions behind that headline ran at all.
  if (arrivalTelemetryDegraded(metrics.arrivalCoverage)) {
    t.push(
      `  ** ${ARRIVAL_TELEMETRY_UNAVAILABLE_NOTE}`,
      `  ** ${metrics.arrivalCoverage.arrivalsWithAsn} of ${metrics.arrivalCoverage.arrivals} arrivals carried a network (ASN).`,
    );
  }
  if (opts.posthog) {
    t.push(
      `PostHog page views: ${opts.posthog.pageviews} from ${opts.posthog.people} ` +
        `${opts.posthog.people === 1 ? 'identity' : 'identities'}  [separate observation]`,
    );
  }
  // AECI-870. Its own line, never folded into the one above: `$pageview` is
  // consent-gated Tier 3 and `app_started` is Tier 2 for every visitor, so the
  // two count different populations out of the same vendor.
  if (opts.browserStarts) {
    t.push(
      `Browser starts: ${opts.browserStarts.starts} (${opts.browserStarts.searchReferred} ` +
        `search-referred)  [separate observation]`,
    );
  } else if (opts.browserStartsUnavailable) {
    t.push(`Browser starts: unavailable (${opts.browserStartsUnavailable})`);
  }
  t.push(
    `Corroborated as human by an external referrer: ${metrics.corroboratedViews.day} from ` +
      `${plural(metrics.corroboratedVisitors, 'visitor')}  [supporting evidence]`,
  );
  if (metrics.operatorLeakViews > 0) {
    t.push(
      `  (${plural(metrics.operatorLeakViews, 'view')} excluded as operator self-traffic on a lapsed session)`,
    );
  }
  if (metrics.automation?.note) {
    t.push(`Automation signal: ${metrics.automation.note}`);
  }
  if (bot.day > 0) {
    t.push(
      `  (${bot.day} bot/crawler view${bot.day === 1 ? '' : 's'} excluded — see Crawler activity)`,
    );
  }
  if (topProducts.length > 0) {
    t.push(
      '',
      metrics.automation
        ? 'Most viewed products (unresolved, after automation):'
        : 'Most viewed products (unresolved):',
    );
    topProducts.forEach((p, i) =>
      t.push(`  ${i + 1}. ${p.name} — ${plural(p.views, 'view')} (/${p.slug})`),
    );
  } else {
    t.push('Most viewed product: (no unresolved product page views)');
  }

  t.push('', `== Traffic sources (unresolved${metrics.automation ? ', after automation' : ''}) ==`);
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

  t.push('', ...boundsLines(metrics, opts));

  t.push(
    '',
    'Human vs. bot is classified at capture from User-Agent + network (ASN) — a maintained heuristic, not exact.',
    'Traffic sources come from the Referer header (best-effort — privacy tools strip it, so external sources are under-counted; stripped arrivals fall into Direct).',
    'Report-only: counts are read from the app database; the window is the full prior UTC day.',
  );
  return t.join('\n');
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

/** A big primary number with a caption + a muted delta line beneath. */
function primaryStat(value: number, caption: string, delta: string): string {
  return (
    `<div style="margin:0 0 2px"><span style="font-size:34px;font-weight:700;color:${HTML.ink};line-height:1">${value}</span>` +
    ` <span style="font-size:14px;color:${HTML.muted}">${escapeHtml(caption)}</span></div>` +
    `<div style="font-size:13px;color:${HTML.muted}">${escapeHtml(delta)}</div>`
  );
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
  const { pageViews: pv, botPageViews: bot, newUsers, totalUsers, pendingModeration } = metrics;
  const { topProducts, referrers, botActivity } = metrics;

  const header =
    `<div style="border-top:4px solid ${HTML.accent};background:${HTML.accentSoft};padding:20px 24px">` +
    `<div style="font-size:18px;font-weight:700;color:${HTML.ink}">AECi daily analytics digest</div>` +
    `<div style="margin-top:6px;font-size:13px;color:${HTML.muted}">` +
    `<span style="display:inline-block;background:${HTML.accent};color:#fff;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:600;letter-spacing:.03em">${escapeHtml(opts.env)}</span>` +
    `&nbsp; · &nbsp;${escapeHtml(opts.dayLabel)} (UTC)&nbsp; · &nbsp;generated ${escapeHtml(opts.generatedAt.toISOString())}</div></div>`;

  // The upper-bound caption sits ON the big number, not in a footnote. The whole
  // failure mode this fixes is a figure that reads as authoritative because
  // nothing next to it says otherwise.
  // AECI-869: a SEPARATE observation, not a bound. Its HogQL filters event, date
  // and host only, so it counts operators and any script that runs JavaScript;
  // `uniq(person_id)` is an identity count. Calling it a lower bound under the
  // headline invited exactly the arithmetic the issue forbids.
  const posthogLine = opts.posthog
    ? `<p style="margin:8px 0 0;font-size:13px;color:${HTML.muted}">` +
      `<strong style="color:${HTML.ink}">${opts.posthog.pageviews}</strong> PostHog page view${opts.posthog.pageviews === 1 ? '' : 's'} ` +
      `from <strong style="color:${HTML.ink}">${opts.posthog.people}</strong> ${opts.posthog.people === 1 ? 'identity' : 'identities'} ` +
      `(client-side, consented only) &mdash; a <strong>separate observation</strong>, filtered by date and host only. ` +
      `Not a floor under the figure above, and never added to or subtracted from it.</p>`
    : opts.posthogUnavailable
      ? `<p style="margin:8px 0 0;font-size:13px;color:${HTML.muted}">PostHog client-side figure unavailable (${escapeHtml(opts.posthogUnavailable)}).</p>`
      : '';
  // AECI-870. Beside the line above, never inside it. `app_started` is the Tier 2
  // beacon — every visitor, no consent gate — so it is a different population out
  // of the same vendor, and the two must not read as one figure with two numbers.
  const browserStartsLine = opts.browserStarts
    ? `<p style="margin:8px 0 0;font-size:13px;color:${HTML.muted}">` +
      `<strong style="color:${HTML.ink}">${opts.browserStarts.starts}</strong> browser start${opts.browserStarts.starts === 1 ? '' : 's'} ` +
      `(<strong style="color:${HTML.ink}">${opts.browserStarts.searchReferred}</strong> search-referred), operator and ` +
      `PostHog-detected bots excluded &mdash; a <strong>separate observation</strong>. It counts bundle ` +
      `executions, not people, and browsers with tracker blockers never report. A client that never runs ` +
      `JavaScript cannot enter it; a real headless browser can. Never added to or subtracted from any figure above.</p>`
    : opts.browserStartsUnavailable
      ? `<p style="margin:8px 0 0;font-size:13px;color:${HTML.muted}">Browser-start figure unavailable (${escapeHtml(opts.browserStartsUnavailable)}).</p>`
      : '';
  // The corroborated figure sits ON the tile beside the headline, not in the
  // footnote, for the same reason the upper-bound caption does: a number the
  // operator has to scroll to find is a number they will read the headline
  // instead of. It is the one line here that may say "human" (AECI-869), because
  // it names the evidence in the same sentence.
  const corroboratedLine =
    `<p style="margin:8px 0 0;font-size:13px;color:${HTML.muted}">` +
    `<strong style="color:${HTML.ink}">${metrics.corroboratedViews.day}</strong> view${metrics.corroboratedViews.day === 1 ? '' : 's'} ` +
    `from <strong style="color:${HTML.ink}">${metrics.corroboratedVisitors}</strong> ${metrics.corroboratedVisitors === 1 ? 'visitor' : 'visitors'} ` +
    `arrived with a named external search or social referrer, which corroborates them as ` +
    `<strong>human</strong> &mdash; supporting evidence, not a verified floor, and a subset of the figure above.</p>`;
  const operatorLeakLine =
    metrics.operatorLeakViews > 0
      ? `<p style="margin:6px 0 0;font-size:13px;color:${HTML.muted}">${metrics.operatorLeakViews} view${metrics.operatorLeakViews === 1 ? '' : 's'} excluded as operator self-traffic on a lapsed session.</p>`
      : '';
  const swarmLine = metrics.automation?.note
    ? `<p style="margin:10px 0 0;padding:10px 12px;border-left:3px solid ${HTML.accent};background:${HTML.accentSoft};font-size:13px;color:${HTML.ink}">` +
      `<strong>Automation signal.</strong> ${escapeHtml(metrics.automation.note)}</p>`
    : '';
  // AECI-741. The big number is the post-automation count; the raw server-side
  // figure survives as a muted sub-line because it is still the upper bound and
  // still the thing every prior email reported. Demoted, not deleted — an
  // operator comparing this morning against last week needs to be able to see
  // both, and a number that silently changed meaning is the failure mode
  // AECI-658 already had to fix once.
  //
  // AECI-869 relabelled it. Same figure, same subtraction, same sub-line; the
  // caption no longer calls the residual "human".
  const net = unresolvedRequests(metrics);
  const notComparable = trafficDaysNotComparable(metrics);
  const headlineStat = metrics.automation
    ? primaryStat(net.day, unresolvedLabel(net.day), deltaText(net, { notComparable })) +
      `<p style="margin:6px 0 0;font-size:13px;color:${HTML.muted}">` +
      `From <strong style="color:${HTML.ink}">${pv.day}</strong> counted server-side ` +
      `(${escapeHtml(deltaText(pv, { notComparable }))}), less <strong style="color:${HTML.ink}">${metrics.automation.flagged.day}</strong> ` +
      `flagged as automation. The raw figure is an <strong>upper bound</strong> on humans; the ` +
      `headline is what no rule could exclude, which is not the same as a person.</p>`
    : primaryStat(pv.day, unresolvedLabel(pv.day), deltaText(pv, { notComparable })) +
      `<p style="margin:6px 0 0;font-size:13px;color:${HTML.muted}">Counted server-side on every full-document load, so this is an <strong>upper bound</strong> on humans. ` +
      `<strong style="color:${HTML.danger}">The automation filter did not run for this day</strong>, so nothing has been removed.</p>`;
  // AECI-869. Styled as the loudest thing on the tile, above every other caveat,
  // because it does not qualify the figure above it — it says the exclusions
  // behind that figure had no input. A four-day outage read as a good week
  // precisely because nothing occupied this position.
  const telemetryLine = arrivalTelemetryDegraded(metrics.arrivalCoverage)
    ? `<p style="margin:10px 0 0;padding:10px 12px;border-left:3px solid ${HTML.danger};background:#fef2f2;font-size:13px;color:${HTML.ink}">` +
      `<strong style="color:${HTML.danger}">${escapeHtml(ARRIVAL_TELEMETRY_UNAVAILABLE_NOTE)}</strong> ` +
      `Only ${metrics.arrivalCoverage.arrivalsWithAsn} of ${metrics.arrivalCoverage.arrivals} full-document arrivals ` +
      `carried a network (ASN), so the datacentre classification, both automation groupings and the ` +
      `operator retro-join could not fire. This day is not comparable with a day that has telemetry.</p>`
    : '';
  const traffic =
    sectionTitle('Traffic (unresolved origin)') +
    headlineStat +
    telemetryLine +
    posthogLine +
    browserStartsLine +
    corroboratedLine +
    operatorLeakLine +
    swarmLine +
    (bot.day > 0
      ? `<p style="margin:6px 0 0;font-size:13px;color:${HTML.muted}">${bot.day} bot/crawler view${bot.day === 1 ? '' : 's'} excluded — see <strong>Crawler activity</strong> below.</p>`
      : '');

  const productLabel = (p: TopProduct): string =>
    `${escapeHtml(p.name)} <span style="color:${HTML.muted};font-size:12px">/${escapeHtml(p.slug)}</span>`;
  const productsSection =
    sectionTitle(
      metrics.automation
        ? 'Most viewed products (unresolved, after automation)'
        : 'Most viewed products (unresolved)',
    ) +
    (topProducts.length > 0
      ? rankTable(
          'Product',
          'Views',
          topProducts.map((p) => ({ label: productLabel(p), count: p.views })),
        )
      : emptyNote('No human product page views.'));

  const referrersSection =
    sectionTitle(
      metrics.automation
        ? 'Traffic sources (unresolved, after automation)'
        : 'Traffic sources (unresolved)',
    ) +
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

  const footer =
    // Same prose as the plain-text body, from the same helper: the two bounds
    // only help if both renderings of the email explain them identically.
    `${escapeHtml(boundsLines(metrics, opts).join(' '))} ` +
    `Human vs. bot is classified at capture from User-Agent + network (ASN) — a maintained heuristic, not exact. ` +
    `Traffic sources come from the Referer header (best-effort — privacy tools strip it, so external sources are under-counted; stripped arrivals fall into Direct). ` +
    `Report-only: counts are read from the app database; the window is the full prior UTC day.`;

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
    `<div style="padding:4px 24px 24px">${traffic}${productsSection}${referrersSection}${signIns}${moderation}${crawlers}</div>` +
    `</div>` +
    `<div style="max-width:640px;margin:12px auto 0;padding:0 4px;font-size:12px;line-height:1.5;color:${HTML.muted};font-family:${FONT}">${footer}</div>` +
    `</div></body></html>`
  );
}
