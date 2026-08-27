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

import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  not,
  notLike,
  or,
  sql,
} from 'drizzle-orm';

import { UNTRACKED_ROUTE_PREFIXES } from '@aeci/shared';

import type { Db } from '../db/client';
import { pageViews, products, profiles, reviews } from '../db/schema';
import { NAMED_REFERRER_SOURCES } from './referrer-classification';

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
}

const TOP_PRODUCTS_LIMIT = 5;

/**
 * A row is "human" when it isn't flagged as a bot. `is_bot IS NOT 1` (NULL-safe) so
 * pre-classification rows (`is_bot = NULL`) count as human, not vanish.
 *
 * Exported because the admin panel (AECI-574) reads the SAME population — sharing
 * the predicate is what makes "the screen and the 05:00 email cannot disagree"
 * structural rather than a convention someone has to remember. The panel also
 * surfaces the resulting bias as a `bot_classification_incomplete` note.
 */
export const HUMAN = or(isNull(pageViews.isBot), eq(pageViews.isBot, false));
export const BOT = eq(pageViews.isBot, true);

/**
 * How far either side of a row the retro-join will look for an `is_operator = 1`
 * anchor on the same visitor pair. A documented launch tunable
 * (`POST_LAUNCH_MONITORING.md` §3) — raise it only against measured evidence.
 *
 * Symmetric on purpose: a lapse can sit before the operator's first flagged row
 * of a session as easily as after their last. On 2026-08-26 the anchors were on
 * BOTH sides of the gap (02:48-04:42 and 07:33 onward, with 05:46-07:32 dark).
 */
export const OPERATOR_PAIR_LOOKBACK_DAYS = 30;

/** `'-30 days'` / `'+30 days'`, bound as ordinary parameters rather than inlined.
 *  Two parameters for the whole predicate, no matter how many pairs exist. */
const LOOKBACK_BACK = `-${OPERATOR_PAIR_LOOKBACK_DAYS} days`;
const LOOKBACK_FWD = `+${OPERATOR_PAIR_LOOKBACK_DAYS} days`;

/**
 * "This row shares a `(user_agent_hash, cf_asn)` pair with a VERIFIED operator
 * row nearby in time" — the read-side repair for the operator session-lapse leak
 * (AECI-683).
 *
 * ─── The defect it closes ───────────────────────────────────────────────────
 *
 * `is_operator` is decided once, at ingest, and `lib/operator-session.ts` resolves
 * every failure to `false` — deliberately, so an auth hiccup costs a flag rather
 * than the row. An **expired** access token is one of those failures. So an
 * operator who browses across a token expiry writes flagged rows, then unflagged
 * rows, then flagged rows again, and nothing on the unflagged ones distinguishes
 * them from a visitor. On 2026-08-26 that was 22 views in one 105-minute gap
 * (ending on `/auth/login`, which is what a lapse looks like from the outside),
 * inside a 102-view "human" day whose corroborated population was 8 views from
 * 7 visitors.
 *
 * ─── Why the PAIR, and not either half ──────────────────────────────────────
 *
 * Measured on production 2026-08-19 and recorded in
 * `scripts/ops/2026-08-operator-page-view-backfill/operator-pairs.sql`:
 *
 *   - **The UA hash alone is wrong.** The operator's second browser hash
 *     `d37ac4d2…` — the very hash that leaked here — spans 6 ASNs across 5
 *     countries. A UA hash is a browser BUILD, shared with strangers; flagging it
 *     outright would delete real visitors in four countries.
 *   - **The ASN alone is wrong.** "Everything from Indonesia" was 44% false
 *     positives and 50% recall. That is the objection §13 D10 already recorded
 *     against `ANALYTICS_INTERNAL_ASNS`.
 *   - **The pair is right**, and is also exactly the tuple §9.8 already calls a
 *     "visitor" — so this excludes operator VISITORS in the same terms the panel
 *     counts everyone else in.
 *
 * ─── Why the anchors come from `is_operator = 1` only ───────────────────────
 *
 * The ops backfill could also prove a pair from an `/admin*` row, because no
 * visitor reaches one. That is no longer available: since AECI-575's write-side
 * guard (`server-runtime.ts`, `page-view-tracker.ts`) untracked routes are not
 * written AT ALL, so there are no such rows to harvest from any recent window.
 * `/account` would be the wrong source regardless — every signed-in user reaches
 * it, so harvesting there would exclude ordinary members' public browsing.
 *
 * ─── Two properties that must not be refactored away ────────────────────────
 *
 * **NULL-safe by construction.** A row with a NULL `user_agent_hash` or `cf_asn`
 * makes the inner `=` NULL, the subquery matches nothing, and `NOT EXISTS` is
 * TRUE — the row is KEPT. The tempting `NOT (hash = ? AND asn = ?)` form does the
 * opposite: SQL's three-valued logic turns it NULL and the `WHERE` drops the row.
 * Do not rewrite it that way.
 *
 * **The `strftime` format string is load-bearing.** `created_at` is
 * `new Date().toISOString()` — `2026-08-26T05:46:00.000Z`. Bare `datetime(…)`
 * returns `2026-07-27 05:46:00`, and a space sorts BEFORE `T`, so comparing the
 * two shapes is silently wrong at the boundary. `%Y-%m-%dT%H:%M:%fZ` reproduces
 * the stored format exactly.
 *
 * Exported in its POSITIVE form so the count of what the clause removes and the
 * clause itself are the same expression and cannot drift.
 */
export const OPERATOR_PAIR_MATCH = sql`exists (
    select 1 from ${pageViews} as op
     where op.is_operator = 1
       and op.user_agent_hash = ${pageViews.userAgentHash}
       and op.cf_asn = ${pageViews.cfAsn}
       and op.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', ${pageViews.createdAt}, ${LOOKBACK_BACK})
       and op.created_at <= strftime('%Y-%m-%dT%H:%M:%fZ', ${pageViews.createdAt}, ${LOOKBACK_FWD})
  )`;

/**
 * The path + flag halves WITHOUT the retro-join — the population the digest
 * counted before AECI-683.
 *
 * Exists only so `operatorLeakViews` can report exactly what the retro-join
 * removed. Nothing else should read it: a caller that wants "not the operator"
 * wants {@link NOT_INTERNAL}.
 */
const NOT_INTERNAL_BEFORE_RETRO_JOIN = and(
  ...UNTRACKED_ROUTE_PREFIXES.flatMap((prefix) => [
    notLike(pageViews.path, prefix),
    notLike(pageViews.path, `${prefix}/%`),
  ]),
  or(isNull(pageViews.isOperator), eq(pageViews.isOperator, false)),
);

/**
 * Excludes the operator's own traffic. Three independent halves, deliberately one
 * predicate:
 *
 *   - **Operator-only PATHS** (`/admin/*`, `/account`) — the read-side half of
 *     AECI-575 / ADMIN_PANEL_SPEC §9.6, described below.
 *   - **Operator SESSIONS** (`is_operator = 1`) — the operator browsing the
 *     PUBLIC site while signed in as an admin (§13 **D13**,
 *     `lib/operator-session.ts`). The path half never saw these: standing on
 *     `/products/procore` is indistinguishable from a visitor doing the same,
 *     and on 2026-08-19 that was 15% of all human public-page views.
 *   - **Operator VISITOR PAIRS** ({@link OPERATOR_PAIR_MATCH}, AECI-683) — the
 *     rows a lapsed session left unflagged. The session half cannot see these
 *     either: `is_operator` is decided once at ingest and an expired token reads
 *     exactly like an anonymous request.
 *
 * They live in one constant because they answer one question — "is this row the
 * operator?" — and because a caller that remembered one and forgot the others
 * would report a number that is partly corrected, which is worse than any
 * consistent alternative. NULL-safe on `is_operator`: every row written before
 * D13 shipped is NULL and counts as a visitor, so history keeps reading exactly
 * as it did rather than shifting under a column it never had.
 *
 * **The third half is an INFERENCE, and is therefore reported.** The first two
 * are facts about the request — a path no visitor reaches, a signature that
 * verified — so the digest excludes them silently: they were never visitor
 * traffic. A pair match is a judgement about identity, and `ANALYTICS_BASELINE.md`
 * is explicit that the pair cohort must not be read as equivalent to the live
 * flag. So `AnalyticsMetrics.operatorLeakViews` counts what it removed and the
 * email prints it. Silence would be the same failure the headline number itself
 * was guilty of.
 *
 * The tracker no longer writes the path rows, but rows captured BEFORE that
 * shipped are indistinguishable from real traffic once they're in the table, so
 * filtering only at the write side would leave every pre-fix day permanently
 * inflated and inconsistent with every post-fix day. Applying it here makes the
 * whole history read the same way.
 *
 * Prefix list comes from `@aeci/shared` so the read side can't drift from the two
 * write-side guards. `path` is NOT NULL, so `NOT LIKE` is safe here (no
 * three-valued-logic surprise), and `page_views_path_idx` covers the column.
 *
 * **Kept a static constant on purpose.** The retro-join is written as a
 * self-contained correlated subquery anchored on each row's OWN timestamp rather
 * than as a `notInternalFor(window)` function, so all five read surfaces below
 * keep sharing one expression instead of each remembering to thread a window
 * through. It also binds a fixed two parameters regardless of how many operator
 * pairs exist — a JS-resolved pair list would bind two per pair and scale with
 * the data, which is precisely the D1 bound-parameter hazard the better-sqlite3
 * test harness cannot fail on (`TESTING_STRATEGY.md` §6.3).
 *
 * Exported because four other read surfaces must exclude the same rows or they
 * diverge from the digest they are meant to mirror: the admin panel
 * (`lib/admin-analytics.ts` + `routes/admin-overview.ts`, AECI-574), the
 * `metrics_daily` snapshot that reaches D1 through the first of those, and the
 * public home page's trending card (`lib/home-stats.ts`). Both panel modules
 * import it as `EXCLUDE_OPERATOR_TRAFFIC`, to stay distinct from that module's
 * unrelated `ANALYTICS_INTERNAL_ASNS` "internal" filter — the alias says *traffic*
 * rather than *routes* because since D13 it is no longer only about paths.
 *
 * Trending is the one that bites hardest if forgotten: it renders publicly, and
 * D12 recorded it as immune to the path half (an `/admin/*` row has no
 * `product_id`) — which is true and does not extend to an operator session, which
 * carries the FK like any other product view.
 *
 * One structural caveat: the correlated subquery names `"page_views"` columns
 * directly, so a caller that ALIASES `pageViews` would silently break the
 * correlation. No caller does today; keep it that way.
 */
export const NOT_INTERNAL = and(NOT_INTERNAL_BEFORE_RETRO_JOIN, not(OPERATOR_PAIR_MATCH));

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
async function topProductsByViews(db: Db, startIso: string, endIso: string): Promise<TopProduct[]> {
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

/** Run every read for the digest concurrently. Report-only; never mutates. */
export async function collectAnalyticsMetrics(
  db: Db,
  window: DigestWindow,
): Promise<AnalyticsMetrics> {
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
    topProductsByViews(db, window.startIso, window.endIso),
    referrerBreakdown(db, window.startIso, window.endIso),
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
  };
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
   * Pre-rendered rotating-proxy note for the same window (AECI-658), or null when
   * nothing was flagged.
   *
   * Passed in ALREADY RENDERED rather than as a `SwarmSummary`, for two reasons.
   * The formatter stays pure — it has always taken data and options and reached
   * for nothing — and, more practically, `swarm-detection` imports this module's
   * `HUMAN` / `NOT_INTERNAL` predicates, so importing its renderer back here
   * would close a runtime import cycle. It would happen to work today (the
   * predicates are only dereferenced inside a function body) and would break the
   * first time either module grew a top-level use. The caller renders; we print.
   */
  swarmNote?: string | null;
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
  // "up to" rather than a bare count (AECI-658). The subject line is the number
  // the operator actually reads, and for weeks it asserted a figure that was an
  // order of magnitude high with nothing to qualify it. ASCII, not a "<=" glyph,
  // so it survives every mail client's subject rendering.
  return (
    `AECi daily digest (${opts.env}) — ${opts.dayLabel}: ` +
    `up to ${plural(pv.day, 'human view')}, ${plural(newUsers.day, 'new user')}` +
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
 */
function boundsLines(metrics: AnalyticsMetrics, opts: AnalyticsDigestOptions): string[] {
  const lines = [
    'Page views above are an UPPER bound on humans: they are counted server-side on every',
    'full-document load, so any crawler that does not run JavaScript is still in the number.',
  ];
  if (opts.posthog) {
    const { pageviews, people } = opts.posthog;
    lines.push(
      `PostHog (client-side, consented only) saw ${plural(pageviews, 'page view')} from ` +
        `${people} ${people === 1 ? 'person' : 'people'} the same day: a LOWER bound.`,
      'The truth is between the two. A large gap means most arrivals never ran our JavaScript.',
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
    `Page views: ${pv.day} (${deltaText(pv)})  [upper bound]`,
  ];
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
  if (opts.swarmNote) {
    t.push(`Automation signal: ${opts.swarmNote}`);
  }
  if (bot.day > 0) {
    t.push(
      `  (${bot.day} bot/crawler view${bot.day === 1 ? '' : 's'} excluded — see Crawler activity)`,
    );
  }
  if (topProducts.length > 0) {
    t.push('', 'Most viewed products:');
    topProducts.forEach((p, i) =>
      t.push(`  ${i + 1}. ${p.name} — ${plural(p.views, 'view')} (/${p.slug})`),
    );
  } else {
    t.push('Most viewed product: (no human product page views)');
  }

  t.push('', '== Traffic sources (humans) ==');
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
  const swarmLine = opts.swarmNote
    ? `<p style="margin:10px 0 0;padding:10px 12px;border-left:3px solid ${HTML.accent};background:${HTML.accentSoft};font-size:13px;color:${HTML.ink}">` +
      `<strong>Automation signal.</strong> ${escapeHtml(opts.swarmNote)}</p>`
    : '';
  const traffic =
    sectionTitle('Traffic (humans)') +
    primaryStat(pv.day, pv.day === 1 ? 'human page view' : 'human page views', deltaText(pv)) +
    `<p style="margin:6px 0 0;font-size:13px;color:${HTML.muted}">Counted server-side on every full-document load, so this is an <strong>upper bound</strong> on humans.</p>` +
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
    sectionTitle('Most viewed products (humans)') +
    (topProducts.length > 0
      ? rankTable(
          'Product',
          'Views',
          topProducts.map((p) => ({ label: productLabel(p), count: p.views })),
        )
      : emptyNote('No human product page views.'));

  const referrersSection =
    sectionTitle('Traffic sources (humans)') +
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
