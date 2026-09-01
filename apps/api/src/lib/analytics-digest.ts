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
 * Human vs. bot (AECI-526 follow-up): the digest's headline "Page views" and "Most
 * viewed products" report HUMANS ONLY (`is_bot IS NOT 1`), and a "Crawler activity"
 * section lists every bot/crawler and its crawl count for the day (`is_bot = 1`,
 * grouped by `bot_name`). The `is_bot` / `bot_name` classification is written at
 * ingest by `lib/bot-classification.ts` (`page_views` route). Rows captured before
 * that column existed have `is_bot = NULL` and read as human until the one-time ASN
 * backfill runs — a safe degradation (matches the pre-split behavior) rather than
 * silently dropping rows.
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
}

const TOP_PRODUCTS_LIMIT = 5;

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
  // NOTE: there is deliberately no `automation` option here any more (AECI-745).
  // The filter now arrives on `AnalyticsMetrics.automation`, computed by the same
  // call that produced every other number in the email. An option would be a
  // SECOND source for the one figure `humanViewsAfterAutomation` exists to keep
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
 * The digest's HEADLINE population: human page views left after the automation
 * filter, for the reported day and the prior day.
 *
 * Exported so the admin panel can lead with the same figure rather than
 * re-deriving the subtraction — the §6.10 parity guarantee is only structural
 * while both surfaces read one definition. Since AECI-745 it takes the metrics
 * ALONE, because the filter now lives on them: passing the filter separately
 * would let a caller subtract one day's flagged count from another day's total.
 *
 * Clamped at zero defensively. `flagged` is a subset of the same
 * `HUMAN`+`NOT_INTERNAL` population `pageViews` counts, computed from the same
 * predicates over the same window, so it cannot legitimately exceed it — but a
 * negative headline would be a far worse failure than a zero one if that ever
 * stopped being true.
 */
export function humanViewsAfterAutomation(metrics: AnalyticsMetrics): DailyCount {
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

/** Human day-over-day delta, e.g. `+8 (+18%) vs 45 prior day`, `-3 (-7%) vs 45 prior
 *  day`, or `no change vs prior day`. Percentages are omitted when the prior day was 0
 *  (division would be meaningless). ASCII only, so it renders cleanly in plain text. */
function deltaText(c: DailyCount): string {
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
  const net = humanViewsAfterAutomation(metrics);
  // The subject line is the number the operator actually reads, so it carries
  // the filtered figure with the raw one in parentheses (AECI-741) rather than
  // the reverse. Without the filter it keeps the AECI-658 "up to" hedge: for
  // weeks the subject asserted a figure that was an order of magnitude high with
  // nothing to qualify it. ASCII, not a "<=" glyph, so it survives every mail
  // client's subject rendering.
  const headline = metrics.automation
    ? `${plural(net.day, 'human view')} after automation (${pv.day} raw)`
    : `up to ${plural(pv.day, 'human view')}`;
  return (
    `AECi daily digest (${opts.env}) — ${opts.dayLabel}: ` +
    `${headline}, ${plural(newUsers.day, 'new user')}` +
    (topName ? ` · top: ${topName}` : '') +
    (bot.day > 0 ? ` · ${plural(bot.day, 'crawl')}` : '')
  );
}

// ── plain text ──

/**
 * The two bounds, as one plain-text block.
 *
 * Shared by the text and HTML builders so the wording cannot drift between the
 * two renderings of the same email — the pair only helps if both halves say the
 * same thing.
 *
 * The framing is deliberate. `page_views` is written server-side on every
 * full-document load including cache hits, so a crawler that never runs
 * JavaScript still counts: an UPPER bound. PostHog fires only when JS runs and
 * the visitor consented, so a real person who declines is invisible: a LOWER
 * bound. `POST_LAUNCH_MONITORING.md` §3 has instructed reading the server figure
 * as an upper bound since launch; until AECI-658 the email never said so, which
 * is how a number that was ~10x high read as authoritative for weeks.
 *
 * Since AECI-741 the RAW server-side figure is no longer the headline, so these
 * lines have to say which number they are bounding. Describing the headline as
 * an upper bound when it is a filtered estimate would be the same class of error
 * in the opposite direction.
 */
function boundsLines(metrics: AnalyticsMetrics, opts: AnalyticsDigestOptions): string[] {
  const lines = metrics.automation
    ? [
        `The headline is the ${metrics.pageViews.day} views counted server-side less the`,
        `${metrics.automation.flagged.day} attributed to automated clients. The raw server-side figure is an`,
        'UPPER bound: it is written on every full-document load, so any crawler that does not run',
        'JavaScript is still in it. The filter is a maintained heuristic over a small sample, so the',
        'headline is an estimate — it is not a census, and it can be wrong in both directions.',
        'Most viewed products and Traffic sources below exclude the same flagged clients, so every',
        'figure in this email describes one population.',
      ]
    : [
        'The automation filter did not run for this day, so the headline is UNFILTERED and is an',
        'UPPER bound on humans: page views are counted server-side on every full-document load,',
        'so any crawler that does not run JavaScript is still in the number.',
      ];
  if (opts.posthog) {
    const { pageviews, people } = opts.posthog;
    lines.push(
      `PostHog (client-side, consented only) saw ${plural(pageviews, 'page view')} from ` +
        `${people} ${people === 1 ? 'person' : 'people'} the same day: a LOWER bound.`,
      metrics.automation
        ? 'The truth is between that floor and the raw server-side figure; the headline is our best estimate inside that range.'
        : 'The truth is between the two. A large gap means most arrivals never ran our JavaScript.',
    );
  } else if (opts.posthogUnavailable) {
    lines.push(`PostHog lower bound unavailable (${opts.posthogUnavailable}).`);
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
 * Both caveats are mandatory and neither is boilerplate. It is a FLOOR because
 * Referrer-Policy strips real referrals into `Direct`; and a referrer is a CLAIM,
 * unverifiable by construction now that only the host is stored (§9.7) — prod
 * holds one confirmed forgery. A number this small reads as precise unless the
 * text says otherwise, and the whole point of this digest change is to stop
 * numbers reading as more certain than they are.
 */
function corroboratedLines(metrics: AnalyticsMetrics): string[] {
  const { day } = metrics.corroboratedViews;
  if (day === 0) {
    return [
      'No arrival carried an external search or social referrer, so nothing in the day is',
      'positively corroborated as a person. That is common at this volume, not an outage.',
    ];
  }
  const visitors = metrics.corroboratedVisitors;
  return [
    `Of those, ${plural(day, 'view')} from ${plural(visitors, 'visitor')} arrived with an external ` +
      `search or social referrer — the strongest positive evidence of a person we hold ` +
      `server-side, because a proxy pool sends no Referer at all.`,
    'Read it as a FLOOR: privacy tools strip the header, so real referrals land in Direct.',
    'And a referrer is a claim, not a verified fact — only the host is stored.',
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
    '== Traffic (humans) ==',
  ];
  // Headline first, raw second, indented under it (AECI-741). The operator asked
  // for the post-automation figure to be the number they SEE; ordering is most of
  // what makes that true in a plain-text mail client, where there is no type
  // scale to lean on.
  const net = humanViewsAfterAutomation(metrics);
  if (metrics.automation) {
    t.push(
      `Human page views after automation: ${net.day} (${deltaText(net)})  [headline]`,
      `  from ${pv.day} counted server-side (${deltaText(pv)}), less ` +
        `${plural(metrics.automation.flagged.day, 'view')} flagged as automation  [upper bound]`,
    );
  } else {
    t.push(
      `Page views: ${pv.day} (${deltaText(pv)})  [upper bound]`,
      '  (automation filter did not run this day — this figure is UNFILTERED)',
    );
  }
  if (opts.posthog) {
    t.push(
      `PostHog page views: ${opts.posthog.pageviews} from ${opts.posthog.people} ` +
        `${opts.posthog.people === 1 ? 'person' : 'people'}  [lower bound]`,
    );
  }
  t.push(
    `Corroborated by an external referrer: ${metrics.corroboratedViews.day} from ` +
      `${plural(metrics.corroboratedVisitors, 'visitor')}  [floor]`,
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
      metrics.automation ? 'Most viewed products (after automation):' : 'Most viewed products:',
    );
    topProducts.forEach((p, i) =>
      t.push(`  ${i + 1}. ${p.name} — ${plural(p.views, 'view')} (/${p.slug})`),
    );
  } else {
    t.push('Most viewed product: (no human product page views)');
  }

  t.push('', `== Traffic sources (humans${metrics.automation ? ', after automation' : ''}) ==`);
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
      `Bot/crawler page views: ${bot.day} (${deltaText(bot)}) from ${plural(botActivity.length, 'source')}`,
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
  const posthogLine = opts.posthog
    ? `<p style="margin:8px 0 0;font-size:13px;color:${HTML.muted}">` +
      `<strong style="color:${HTML.ink}">${opts.posthog.pageviews}</strong> PostHog page view${opts.posthog.pageviews === 1 ? '' : 's'} ` +
      `from <strong style="color:${HTML.ink}">${opts.posthog.people}</strong> ${opts.posthog.people === 1 ? 'person' : 'people'} ` +
      `(client-side, consented only) &mdash; a <strong>lower bound</strong>.</p>`
    : opts.posthogUnavailable
      ? `<p style="margin:8px 0 0;font-size:13px;color:${HTML.muted}">PostHog lower bound unavailable (${escapeHtml(opts.posthogUnavailable)}).</p>`
      : '';
  // The corroborated figure sits ON the tile beside the two bounds, not in the
  // footnote, for the same reason the upper-bound caption does: a number the
  // operator has to scroll to find is a number they will read the headline
  // instead of.
  const corroboratedLine =
    `<p style="margin:8px 0 0;font-size:13px;color:${HTML.muted}">` +
    `<strong style="color:${HTML.ink}">${metrics.corroboratedViews.day}</strong> view${metrics.corroboratedViews.day === 1 ? '' : 's'} ` +
    `from <strong style="color:${HTML.ink}">${metrics.corroboratedVisitors}</strong> ${metrics.corroboratedVisitors === 1 ? 'visitor' : 'visitors'} ` +
    `arrived with an external search or social referrer &mdash; a <strong>corroborated floor</strong>.</p>`;
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
  const net = humanViewsAfterAutomation(metrics);
  const headlineStat = metrics.automation
    ? primaryStat(
        net.day,
        net.day === 1 ? 'human page view after automation' : 'human page views after automation',
        deltaText(net),
      ) +
      `<p style="margin:6px 0 0;font-size:13px;color:${HTML.muted}">` +
      `From <strong style="color:${HTML.ink}">${pv.day}</strong> counted server-side ` +
      `(${escapeHtml(deltaText(pv))}), less <strong style="color:${HTML.ink}">${metrics.automation.flagged.day}</strong> ` +
      `flagged as automation. The raw figure is an <strong>upper bound</strong>; the headline is a ` +
      `heuristic estimate, not a census.</p>`
    : primaryStat(pv.day, pv.day === 1 ? 'human page view' : 'human page views', deltaText(pv)) +
      `<p style="margin:6px 0 0;font-size:13px;color:${HTML.muted}">Counted server-side on every full-document load, so this is an <strong>upper bound</strong> on humans. ` +
      `<strong style="color:${HTML.danger}">The automation filter did not run for this day</strong>, so nothing has been removed.</p>`;
  const traffic =
    sectionTitle('Traffic (humans)') +
    headlineStat +
    posthogLine +
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
        ? 'Most viewed products (humans, after automation)'
        : 'Most viewed products (humans)',
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
        ? 'Traffic sources (humans, after automation)'
        : 'Traffic sources (humans)',
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
      ? `<p style="margin:0 0 8px;font-size:14px;color:${HTML.muted}">${bot.day} bot/crawler page view${bot.day === 1 ? '' : 's'} <span style="color:${HTML.ink}">(${escapeHtml(deltaText(bot))})</span> from ${botActivity.length} source${botActivity.length === 1 ? '' : 's'}.</p>` +
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
