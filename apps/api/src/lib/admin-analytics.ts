/**
 * The admin panel's read layer (AECI-574 / `ADMIN_PANEL_SPEC.md` §6).
 *
 * Everything the `/api/admin/*` read endpoints need that is not
 * endpoint-specific: UTC windows, day bucketing, the human/bot population,
 * unique visitors, the metric vocabulary, the breakdown dimensions, the §5.2
 * visit feed, and the honesty-envelope notes. Route handlers stay thin — parse
 * the query, call in here, wrap the envelope.
 *
 * Three things are load-bearing and easy to get wrong:
 *
 * **1. Every window is UTC and half-open.** `[startIso, endIso)`, the same shape
 * `analytics-digest.ts` uses, so a row at exactly midnight belongs to exactly one
 * day and the panel and the 05:00 email can never disagree about a boundary row.
 * `created_at` is always `new Date().toISOString()` (`db/schema.ts`), so it is
 * lexicographically sortable AND its first ten characters ARE the UTC date —
 * which is why day bucketing is `substr(created_at, 1, 10)` rather than
 * `strftime`. No parsing, no timezone, no format assumption beyond ISO 8601.
 *
 * **2. The bias notes are derived, never hardcoded.** The spec named 2026-08-05
 * as the date bot classification became trustworthy. That date is deliberately
 * absent from this file: `bot_classification_incomplete` fires because the window
 * actually contains `is_bot IS NULL` rows. That paid off twice — the real date
 * turned out to be 2026-08-03, and when AECI-582 backfilled those rows on
 * 2026-08-13 the note retired itself on every screen with no code change, instead
 * of lingering as a hardcoded date asserting a bias that no longer existed.
 *
 * **3. Both numbers, never one.** Counts are {@link AdminCount}s whose `total` is
 * always unfiltered; `ANALYTICS_INTERNAL_ASNS` only ever adds a second figure
 * beside it (§13 D10 constraint 2, `lib/internal-asns.ts`).
 */

import {
  ADMIN_METRICS_MAX_DAYS,
  ADMIN_PAGE_VIEW_NULL_FILTER,
  type AdminBreakdownDimension,
  type AdminBreakdownRow,
  type AdminCount,
  type AdminInternalFilter,
  type AdminMetricKey,
  type AdminNote,
  type AdminNoteCode,
  type AdminPageViewRow,
  type AdminTrafficPoint,
  type AdminTrafficPopulation,
  type AdminWindow,
} from '@aeci/shared';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  lt,
  lte,
  sql,
  type SQL,
} from 'drizzle-orm';

import type { Db } from '../db/client';
import { auditLog, metricsDaily, pageViews, products, profiles } from '../db/schema';
import type { Env } from '../env';
import { ApiError } from '../errors';
import { BOT, HUMAN, NOT_INTERNAL as EXCLUDE_UNTRACKED_ROUTES } from './analytics-digest';
import { resolveRequestTargets } from './drizzle-helpers';
import { excludeInternalAsns, parseInternalAsns } from './internal-asns';

const DAY_MS = 86_400_000;

// ─── UTC windows ─────────────────────────────────────────────────────────────

/** A resolved, half-open UTC window plus the calendar labels that produced it. */
export interface UtcWindow {
  /** Inclusive start, ISO 8601 UTC (always midnight). */
  startIso: string;
  /** EXCLUSIVE end, ISO 8601 UTC (always midnight). */
  endIso: string;
  /** First UTC day in the window, `YYYY-MM-DD`. */
  fromDay: string;
  /** LAST UTC day in the window, `YYYY-MM-DD` — inclusive, so `toDay` is one day
   *  before `endIso`. */
  toDay: string;
  /** Whole days spanned. */
  days: number;
}

/**
 * Parse a `YYYY-MM-DD` label to its UTC-midnight epoch, rejecting dates that
 * match the shape but do not exist. `2026-02-30` passes the Zod regex and
 * `Date.UTC` silently rolls it to March 2 — the round-trip check is what turns
 * that into a 400 instead of a chart of the wrong month.
 */
function parseUtcDay(label: string, field: string): number {
  const [y, m, d] = label.split('-').map(Number);
  const ms = Date.UTC(y as number, (m as number) - 1, d as number);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== label) {
    throw new ApiError(400, 'VALIDATION_FAILED', `${field} is not a real calendar date`, { field });
  }
  return ms;
}

function dayLabel(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The single UTC day `label`. */
export function utcDayWindow(label: string, field = 'day'): UtcWindow {
  const start = parseUtcDay(label, field);
  return {
    startIso: new Date(start).toISOString(),
    endIso: new Date(start + DAY_MS).toISOString(),
    fromDay: label,
    toDay: label,
    days: 1,
  };
}

/**
 * The window `[from, to]` — **both calendar dates inclusive**, so `from === to`
 * is a legal single-day range. Internally half-open: `to` is widened to the start
 * of the following day.
 *
 * Capped at {@link ADMIN_METRICS_MAX_DAYS} to match §7.4's `page_views`
 * retention: a window longer than what is retained can only mislead.
 */
export function utcRangeWindow(from: string, to: string): UtcWindow {
  const start = parseUtcDay(from, 'from');
  const lastDay = parseUtcDay(to, 'to');
  if (lastDay < start) {
    throw new ApiError(400, 'VALIDATION_FAILED', '`to` must not be earlier than `from`', {
      field: 'to',
    });
  }
  const days = Math.round((lastDay - start) / DAY_MS) + 1;
  if (days > ADMIN_METRICS_MAX_DAYS) {
    throw new ApiError(
      400,
      'VALIDATION_FAILED',
      `Window spans ${days} days; the maximum is ${ADMIN_METRICS_MAX_DAYS} (page_views retention)`,
      { field: 'from' },
    );
  }
  return {
    startIso: new Date(start).toISOString(),
    endIso: new Date(lastDay + DAY_MS).toISOString(),
    fromDay: from,
    toDay: to,
    days,
  };
}

/** The `days`-long window ending WITH (and including) `endDay`. Used for the
 *  overview's 30-day chart and its 7-day delta baselines. */
export function trailingWindow(endDay: string, days: number): UtcWindow {
  const end = parseUtcDay(endDay, 'day');
  const start = end - (days - 1) * DAY_MS;
  return {
    startIso: new Date(start).toISOString(),
    endIso: new Date(end + DAY_MS).toISOString(),
    fromDay: dayLabel(start),
    toDay: endDay,
    days,
  };
}

/** `label` moved by `delta` whole UTC days. */
export function shiftDay(label: string, delta: number): string {
  return dayLabel(parseUtcDay(label, 'day') + delta * DAY_MS);
}

/** The wire form. `timezone` is a literal: UTC is the only window this API
 *  speaks (§9.5); the UI's WIB toggle is presentational. */
export function toAdminWindow(w: UtcWindow): AdminWindow {
  return { from: w.startIso, to: w.endIso, timezone: 'UTC', days: w.days };
}

/** Every `YYYY-MM-DD` in the window, in order — the zero-fill spine, so a chart
 *  never has to infer a gap from a missing key. */
export function enumerateDays(w: UtcWindow): string[] {
  const out: string[] = [];
  const start = Date.parse(w.startIso);
  for (let i = 0; i < w.days; i += 1) out.push(dayLabel(start + i * DAY_MS));
  return out;
}

/** True when the window runs past the start of the current UTC day, i.e. its last
 *  bucket is still filling. */
export function isPartial(w: UtcWindow, now: Date): boolean {
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Date.parse(w.endIso) > startOfToday;
}

// ─── Population + filter predicates ──────────────────────────────────────────

/** The `page_views` predicate for a population. `human` is the digest's exact
 *  NULL-safe `is_bot IS NOT 1` (imported, not re-derived). Internal — routes pass
 *  a `traffic` value, never a predicate. */
function populationPredicate(traffic: AdminTrafficPopulation): SQL | undefined {
  if (traffic === 'human') return HUMAN;
  if (traffic === 'bot') return BOT;
  return undefined;
}

/** `created_at` inside `[start, end)`, with the operator-only routes excluded.
 *  ISO 8601 text sorts lexicographically the same as chronologically, so the
 *  string range is exact. `EXCLUDE_UNTRACKED_ROUTES` (AECI-575) is folded in here
 *  because every `page_views` read in this module derives its base predicate from
 *  `inWindow`, so this is the single choke point that keeps the panel counting the
 *  same population the digest does — `/admin/*` and `/account` out of both. */
function inWindow(column: typeof pageViews.createdAt, w: UtcWindow): SQL {
  return and(gte(column, w.startIso), lt(column, w.endIso), EXCLUDE_UNTRACKED_ROUTES) as SQL;
}

/** Resolved state of the `ANALYTICS_INTERNAL_ASNS` read-time filter. */
export interface InternalFilterState {
  /** The var is set to at least one parseable ASN. */
  available: boolean;
  /** Available AND requested for this query — i.e. `excluding_internal` values
   *  were actually computed. */
  applied: boolean;
  asns: number[];
  /** The `WHERE` fragment, or undefined when not applied. */
  predicate: SQL | undefined;
}

/**
 * Read the env var and decide whether the filter runs for this request.
 * `requested` is the endpoint's `?exclude_internal=1` (the overview always asks,
 * since its whole job is to show both figures side by side).
 */
export function resolveInternalFilter(env: Env, requested: boolean): InternalFilterState {
  const asns = parseInternalAsns(env.ANALYTICS_INTERNAL_ASNS);
  const available = asns.length > 0;
  const applied = available && requested;
  return { available, applied, asns, predicate: applied ? excludeInternalAsns(asns) : undefined };
}

export function toAdminInternalFilter(state: InternalFilterState): AdminInternalFilter {
  return { available: state.available, applied: state.applied, asns: state.asns };
}

// ─── Counting ────────────────────────────────────────────────────────────────

/**
 * `COUNT(*)` over an arbitrary table with an optional predicate.
 *
 * Shared by the overview's live totals and the P2.1 snapshot cron's stock
 * metrics (`lib/metrics-snapshot.ts`) — deliberately one implementation, so a
 * `metrics_daily` row and the overview's headline figure for the same table can
 * never be counted two different ways.
 */
export async function countAll(
  db: Db,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- one shared counter across a dozen unrelated tables; each call site is type-checked by its own `where`.
  table: any,
  where?: SQL,
): Promise<number> {
  const [row] = await db.select({ value: count() }).from(table).where(where);
  return row?.value ?? 0;
}

async function countPageViewRows(db: Db, where: SQL | undefined): Promise<number> {
  const [row] = await db.select({ value: count() }).from(pageViews).where(where);
  return row?.value ?? 0;
}

/**
 * A `page_views` count in both forms. The unfiltered figure is ALWAYS computed;
 * the filtered one is a second query that only runs when the filter applies, so
 * the shipped-unset default costs nothing.
 */
export async function countViewsBoth(
  db: Db,
  w: UtcWindow,
  traffic: AdminTrafficPopulation,
  filter: InternalFilterState,
  extra?: SQL,
): Promise<AdminCount> {
  const base = and(inWindow(pageViews.createdAt, w), populationPredicate(traffic), extra);
  const total = await countPageViewRows(db, base);
  if (!filter.applied) return { total, excluding_internal: null };
  return {
    total,
    excluding_internal: await countPageViewRows(db, and(base, filter.predicate)),
  };
}

/**
 * Just the filtered half of a `page_views` count, for callers that already hold
 * the unfiltered figure and must not recompute it.
 *
 * The overview is exactly that caller: its `total` IS the digest's number,
 * straight out of `collectAnalyticsMetrics`. Recounting it here would put a
 * second implementation of the same query behind the acceptance criterion that
 * says the two must agree.
 */
export async function countViewsExcludingInternal(
  db: Db,
  w: UtcWindow,
  traffic: AdminTrafficPopulation,
  filter: InternalFilterState,
): Promise<number | null> {
  if (!filter.applied) return null;
  return countPageViewRows(
    db,
    and(inWindow(pageViews.createdAt, w), populationPredicate(traffic), filter.predicate),
  );
}

/**
 * §9.8's visitor definition: `DISTINCT (user_agent_hash, cf_asn)` inside the
 * window. There is no session concept in `page_views` (§7.3 D7 settled that no
 * session identifier is introduced), so this is the honest available proxy — it
 * over-counts when a browser updates its UA and under-counts behind shared NAT.
 * That caveat travels with the number as `visitor_definition_approximate`.
 *
 * `coalesce` gives NULL components a stable bucket rather than dropping the row;
 * a raw `count(distinct)` over a NULL-bearing tuple would silently under-report.
 */
async function countDistinctVisitors(db: Db, where: SQL | undefined): Promise<number> {
  const expr = sql<number>`count(distinct coalesce(${pageViews.userAgentHash}, '') || '|' || coalesce(${pageViews.cfAsn}, ''))`;
  const [row] = await db.select({ value: expr }).from(pageViews).where(where);
  return Number(row?.value ?? 0);
}

export async function countUniqueVisitorsBoth(
  db: Db,
  w: UtcWindow,
  traffic: AdminTrafficPopulation,
  filter: InternalFilterState,
  extra?: SQL,
): Promise<AdminCount> {
  const base = and(inWindow(pageViews.createdAt, w), populationPredicate(traffic), extra);
  const total = await countDistinctVisitors(db, base);
  if (!filter.applied) return { total, excluding_internal: null };
  return {
    total,
    excluding_internal: await countDistinctVisitors(db, and(base, filter.predicate)),
  };
}

// ─── Day bucketing ───────────────────────────────────────────────────────────

/** `substr(created_at, 1, 10)` — see the module header for why this beats
 *  `strftime` on an ISO-8601 text column. */
const pageViewDay = sql<string>`substr(${pageViews.createdAt}, 1, 10)`;
const auditDay = sql<string>`substr(${auditLog.createdAt}, 1, 10)`;
const profileDay = sql<string>`substr(${profiles.createdAt}, 1, 10)`;

async function pageViewsPerDay(db: Db, where: SQL | undefined): Promise<Map<string, number>> {
  const rows = await db
    .select({ day: pageViewDay, value: count() })
    .from(pageViews)
    .where(where)
    .groupBy(pageViewDay);
  return new Map(rows.map((r) => [r.day, r.value]));
}

async function auditEventsPerDay(
  db: Db,
  w: UtcWindow,
  action: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({ day: auditDay, value: count() })
    .from(auditLog)
    .where(
      and(
        gte(auditLog.createdAt, w.startIso),
        lt(auditLog.createdAt, w.endIso),
        eq(auditLog.action, action),
      ),
    )
    .groupBy(auditDay);
  return new Map(rows.map((r) => [r.day, r.value]));
}

async function profilesPerDay(db: Db, w: UtcWindow): Promise<Map<string, number>> {
  const rows = await db
    .select({ day: profileDay, value: count() })
    .from(profiles)
    .where(and(gte(profiles.createdAt, w.startIso), lt(profiles.createdAt, w.endIso)))
    .groupBy(profileDay);
  return new Map(rows.map((r) => [r.day, r.value]));
}

/** The human-vs-bot chart series, zero-filled across the whole window. */
export async function trafficSeries(db: Db, w: UtcWindow): Promise<AdminTrafficPoint[]> {
  const window = inWindow(pageViews.createdAt, w);
  const [human, bot] = await Promise.all([
    pageViewsPerDay(db, and(window, HUMAN)),
    pageViewsPerDay(db, and(window, BOT)),
  ]);
  return enumerateDays(w).map((day) => ({
    day,
    human: human.get(day) ?? 0,
    bot: bot.get(day) ?? 0,
  }));
}

// ─── The metric vocabulary ───────────────────────────────────────────────────

/** `audit_log.action` behind each `catalog.*` series (§5.5 — additions from the
 *  event stream, never net totals; §4 explains why totals are unrecoverable). */
const CATALOG_ACTION: Partial<Record<AdminMetricKey, string>> = {
  'catalog.products_created': 'product.created',
  'catalog.integrations_created': 'integration.created',
  'catalog.vendors_created': 'vendor.created',
  'catalog.claims_created': 'claim.created',
};

/** Metrics that read `page_views` and can therefore be ASN-filtered. Everything
 *  else returns a null `excluding_internal` — there is no ASN on a catalog row to
 *  filter against, and pretending otherwise would be the "silently substituted
 *  figure" §1.1 forbids. */
export function metricSupportsInternalFilter(metric: AdminMetricKey): boolean {
  return metric.startsWith('traffic.');
}

/** One day-bucketed series for `metric`, zero-filled, plus the window total.
 *  Both come back in unfiltered/filtered pairs where the metric supports it. */
export async function metricSeries(
  db: Db,
  metric: AdminMetricKey,
  w: UtcWindow,
  filter: InternalFilterState,
): Promise<{ perDay: Map<string, number>; perDayFiltered: Map<string, number> | null }> {
  const filterable = metricSupportsInternalFilter(metric) && filter.applied;

  if (metric === 'traffic.unique_visitors') {
    // Distinct-visitor counts do not sum across days, so each bucket is its own
    // aggregate — a day-grouped `count(distinct …)` is exactly right here and is
    // NOT the same as the window's distinct total (a visitor on three days counts
    // three times in the series, once in the total). Stated so the chart and the
    // headline number reading differently is understood rather than reported.
    const expr = sql<number>`count(distinct coalesce(${pageViews.userAgentHash}, '') || '|' || coalesce(${pageViews.cfAsn}, ''))`;
    const run = async (extra?: SQL): Promise<Map<string, number>> => {
      const rows = await db
        .select({ day: pageViewDay, value: expr })
        .from(pageViews)
        .where(and(inWindow(pageViews.createdAt, w), HUMAN, extra))
        .groupBy(pageViewDay);
      return new Map(rows.map((r) => [r.day, Number(r.value)]));
    };
    return {
      perDay: await run(),
      perDayFiltered: filterable ? await run(filter.predicate) : null,
    };
  }

  if (metric === 'traffic.page_views_human' || metric === 'traffic.page_views_bot') {
    const population = metric === 'traffic.page_views_human' ? HUMAN : BOT;
    const base = and(inWindow(pageViews.createdAt, w), population);
    return {
      perDay: await pageViewsPerDay(db, base),
      perDayFiltered: filterable ? await pageViewsPerDay(db, and(base, filter.predicate)) : null,
    };
  }

  if (metric === 'accounts.sign_ins_new') {
    return { perDay: await profilesPerDay(db, w), perDayFiltered: null };
  }

  const action = CATALOG_ACTION[metric];
  /* c8 ignore next 3 -- unreachable: the Zod enum admits no other member. */
  if (!action) {
    throw new ApiError(400, 'VALIDATION_FAILED', `Unsupported metric ${metric}`, {
      field: 'metric',
    });
  }
  return { perDay: await auditEventsPerDay(db, w, action), perDayFiltered: null };
}

/** One day's stored snapshot: the value, and whether it was reconstructed by the
 *  P2.1 backfill rather than captured on the day. */
export interface SnapshotPoint {
  value: number;
  reconstructed: boolean;
}

/**
 * The `metrics_daily` rows covering `w` for one metric (AECI-581 / §7.1) —
 * the storage half of the swap `metricSeries` aggregates live.
 *
 * Days with no row simply do not appear: the caller falls back to live
 * aggregation for those, which is what keeps a window spanning the snapshot
 * boundary continuous. `day` is `YYYY-MM-DD` TEXT and `w.fromDay`/`w.toDay` are
 * inclusive calendar labels, so a plain `BETWEEN` on the text column is exact —
 * the same lexical=chronological property the rest of this module relies on.
 *
 * `value` is stored REAL (so a future ratio metric needs no migration) but every
 * metric in the vocabulary today is a count, and the wire schema is an integer —
 * hence the round.
 */
export async function snapshotSeries(
  db: Db,
  metric: AdminMetricKey,
  w: UtcWindow,
): Promise<Map<string, SnapshotPoint>> {
  const rows = await db
    .select({ day: metricsDaily.day, value: metricsDaily.value, source: metricsDaily.source })
    .from(metricsDaily)
    .where(
      and(
        eq(metricsDaily.metric, metric),
        gte(metricsDaily.day, w.fromDay),
        lte(metricsDaily.day, w.toDay),
      ),
    );
  return new Map(
    rows.map((r) => [
      r.day,
      { value: Math.round(r.value), reconstructed: r.source === 'reconstructed' },
    ]),
  );
}

// ─── Breakdown dimensions ────────────────────────────────────────────────────

/** The grouped column per dimension. `product` is handled separately — it joins. */
const DIMENSION_COLUMN = {
  source: pageViews.referrerSource,
  country: pageViews.cfCountry,
  path: pageViews.path,
  bot: pageViews.botName,
} as const;

/**
 * Display fallback for a null group key. These are NOT user-facing translations —
 * the UI keys off `row.key === null` and renders its own localized placeholder;
 * `label` exists so a curl / log line is readable, exactly like an `AdminNote`'s
 * `message`. `Other bot` matches the digest's own fallback so the two agree.
 */
const NULL_LABEL: Record<AdminBreakdownDimension, string> = {
  source: 'Unattributed',
  country: 'Unknown',
  path: 'Unknown',
  product: 'Unknown',
  bot: 'Other bot',
};

export interface BreakdownPage {
  rows: AdminBreakdownRow[];
  /** Distinct groups in the window (the paginated `total`). */
  groups: number;
}

/**
 * One page of grouped counts, ordered by views desc with the key as a stable
 * tiebreak so pagination cannot repeat or skip a group across pages (the AECI-99
 * rule).
 *
 * NULL keys are surfaced as their own bucket rather than dropped, so the page
 * reconciles against `window_total` — dropping them is how a source breakdown
 * quietly starts claiming 100% attribution it does not have.
 */
export async function breakdown(
  db: Db,
  dimension: AdminBreakdownDimension,
  w: UtcWindow,
  traffic: AdminTrafficPopulation,
  filter: InternalFilterState,
  page: number,
  perPage: number,
): Promise<BreakdownPage> {
  const base = and(inWindow(pageViews.createdAt, w), populationPredicate(traffic));
  const offset = (page - 1) * perPage;

  if (dimension === 'product') {
    const withProduct = and(base, isNotNull(pageViews.productId));
    const rows = await db
      .select({ id: products.id, name: products.name, slug: products.slug, views: count() })
      .from(pageViews)
      .innerJoin(products, eq(pageViews.productId, products.id))
      .where(withProduct)
      .groupBy(products.id)
      .orderBy(desc(count()), asc(products.id))
      .limit(perPage)
      .offset(offset);

    const filtered = filter.applied
      ? new Map(
          (
            await db
              .select({ id: products.id, views: count() })
              .from(pageViews)
              .innerJoin(products, eq(pageViews.productId, products.id))
              .where(and(withProduct, filter.predicate))
              .groupBy(products.id)
          ).map((r) => [r.id, r.views]),
        )
      : null;

    const [groupRow] = await db
      .select({ value: count() })
      .from(
        db
          .select({ id: products.id })
          .from(pageViews)
          .innerJoin(products, eq(pageViews.productId, products.id))
          .where(withProduct)
          .groupBy(products.id)
          .as('g'),
      );

    return {
      groups: groupRow?.value ?? 0,
      rows: rows.map((r) => ({
        key: r.id,
        label: r.name,
        ref: { id: r.id, name: r.name, slug: r.slug },
        views: r.views,
        views_excluding_internal: filtered ? (filtered.get(r.id) ?? 0) : null,
      })),
    };
  }

  const column = DIMENSION_COLUMN[dimension];
  // Views desc, then named groups before the NULL bucket, then the key — a
  // deterministic total order, so pagination cannot repeat or skip a group
  // (AECI-99). The explicit `IS NULL` sort beats `NULLS LAST`: SQLite ascending
  // puts NULL first, and an unattributed bucket should not outrank a named source
  // that drew the same number of views.
  const rows = await db
    .select({ key: column, views: count() })
    .from(pageViews)
    .where(base)
    .groupBy(column)
    .orderBy(desc(count()), asc(sql`${column} IS NULL`), asc(column))
    .limit(perPage)
    .offset(offset);

  const filtered = filter.applied
    ? new Map(
        (
          await db
            .select({ key: column, views: count() })
            .from(pageViews)
            .where(and(base, filter.predicate))
            .groupBy(column)
        ).map((r) => [r.key, r.views]),
      )
    : null;

  const [groupRow] = await db
    .select({ value: count() })
    .from(db.select({ key: column }).from(pageViews).where(base).groupBy(column).as('g'));

  return {
    groups: groupRow?.value ?? 0,
    rows: rows.map((r) => ({
      key: r.key,
      label: r.key ?? NULL_LABEL[dimension],
      ref: null,
      views: r.views,
      views_excluding_internal: filtered ? (filtered.get(r.key) ?? 0) : null,
    })),
  };
}

// ─── The Activity feed (§5.2) ────────────────────────────────────────────────

/**
 * How much of `user_agent_hash` the feed is allowed to expose.
 *
 * The truncation happens in SQL, not in the template, so the full hash never
 * leaves the API. §9.7 permits "a truncated hash as a pseudonymous visitor id"
 * and forbids correlation beyond that; doing it here makes that a property of the
 * query rather than a habit of the UI.
 */
const VISITOR_HASH_CHARS = 8;

/**
 * Escape the SQL `LIKE` metacharacters so operator input matches literally.
 *
 * Without this, a `path_contains` of `%` matches every row and `_` matches any
 * character — the filter would silently behave as a pattern language nobody
 * documented. Paired with an explicit `ESCAPE '\'` clause at the call site, since
 * Drizzle's `like()` helper emits no `ESCAPE`.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** The feed's user-facing column filters, straight off the parsed query. */
export interface PageViewFilterInput {
  source?: string;
  country?: string;
  path_contains?: string;
}

/**
 * The `WHERE` fragment for the feed's `source` / `country` / `path_contains`
 * filters, or `undefined` when none are set.
 *
 * `ADMIN_PAGE_VIEW_NULL_FILTER` selects the NULL bucket that `breakdown()`
 * surfaces as `key: null` — a query string cannot carry a null, and those rows
 * are a real population (every row before August 2026 has a NULL
 * `referrer_source`), so they need to be selectable rather than merely visible.
 *
 * This is deliberately NOT where the `/admin/*` exclusion lives: that is a floor
 * beneath these filters, folded into {@link inWindow} (§13 D12).
 */
export function pageViewFilterPredicate(f: PageViewFilterInput): SQL | undefined {
  const source =
    f.source === undefined
      ? undefined
      : f.source === ADMIN_PAGE_VIEW_NULL_FILTER
        ? isNull(pageViews.referrerSource)
        : eq(pageViews.referrerSource, f.source);

  const country =
    f.country === undefined
      ? undefined
      : f.country === ADMIN_PAGE_VIEW_NULL_FILTER
        ? isNull(pageViews.cfCountry)
        : eq(pageViews.cfCountry, f.country);

  const path =
    f.path_contains === undefined
      ? undefined
      : sql`${pageViews.path} like ${`%${escapeLike(f.path_contains)}%`} escape '\\'`;

  return and(source, country, path);
}

export interface PageViewPage {
  rows: AdminPageViewRow[];
  /** Rows matching every applied filter — the paginated `total`. */
  total: number;
}

/**
 * One page of the reverse-chronological visit feed, entity-hydrated.
 *
 * Three things here are load-bearing:
 *
 * **The base predicate comes from {@link inWindow}.** That is the single choke
 * point that folds in `EXCLUDE_UNTRACKED_ROUTES` — §13 D12's retroactive
 * `/admin/*` + `/account` exclusion, applied *beneath* the caller's filters so no
 * combination of query parameters can surface an operator row. Hand-rolling the
 * range here would silently lose it.
 *
 * **Ordering is `created_at DESC, id DESC`.** `page_views.id` is an autoincrement
 * integer PK, so the pair is a strict total order and pagination can neither
 * repeat nor skip a row when several visits share a timestamp (the AECI-99 rule
 * `admin-requests.ts` and {@link breakdown} both follow).
 *
 * **Hydration reuses `resolveRequestTargets`.** One batched `IN (...)` per target
 * table over the page, never per row. A row carries `product_id` XOR `vendor_id`;
 * both are UUIDs, so the single returned map cannot collide. A taxonomy row
 * (`/categories/:slug`) carries neither and resolves to `null` — expected until
 * AECI-585 stores the concrete path — as does a row whose entity has since been
 * deleted.
 */
export async function listPageViews(
  db: Db,
  w: UtcWindow,
  traffic: AdminTrafficPopulation,
  filter: InternalFilterState,
  extra: SQL | undefined,
  page: number,
  perPage: number,
): Promise<PageViewPage> {
  const where = and(
    inWindow(pageViews.createdAt, w),
    populationPredicate(traffic),
    extra,
    filter.predicate,
  );

  const [raw, total] = await Promise.all([
    db
      .select({
        id: pageViews.id,
        createdAt: pageViews.createdAt,
        isBot: pageViews.isBot,
        botName: pageViews.botName,
        visitorHash: sql<
          string | null
        >`substr(${pageViews.userAgentHash}, 1, ${VISITOR_HASH_CHARS})`,
        cfAsn: pageViews.cfAsn,
        cfCountry: pageViews.cfCountry,
        cfColo: pageViews.cfColo,
        path: pageViews.path,
        productId: pageViews.productId,
        vendorId: pageViews.vendorId,
        referrerSource: pageViews.referrerSource,
        referrer: pageViews.referrer,
      })
      .from(pageViews)
      .where(where)
      .orderBy(desc(pageViews.createdAt), desc(pageViews.id))
      .limit(perPage)
      .offset((page - 1) * perPage),
    countPageViewRows(db, where),
  ]);

  const entities = await resolveRequestTargets(
    db,
    raw.flatMap((r) =>
      r.productId
        ? [{ targetType: 'product', targetId: r.productId }]
        : r.vendorId
          ? [{ targetType: 'vendor', targetId: r.vendorId }]
          : [],
    ),
  );

  return {
    total,
    rows: raw.map((r): AdminPageViewRow => {
      const entityId = r.productId ?? r.vendorId;
      return {
        id: r.id,
        created_at: r.createdAt,
        is_bot: r.isBot,
        bot_name: r.botName,
        visitor_hash: r.visitorHash,
        cf_asn: r.cfAsn,
        cf_country: r.cfCountry,
        cf_colo: r.cfColo,
        path: r.path,
        entity_type: r.productId ? 'product' : r.vendorId ? 'vendor' : null,
        entity: entityId ? (entities.get(entityId) ?? null) : null,
        referrer_source: r.referrerSource,
        referrer: r.referrer,
      };
    }),
  };
}

// ─── The honesty envelope ────────────────────────────────────────────────────

const SEVERITY: Record<AdminNoteCode, 'info' | 'warn'> = {
  partial_day: 'info',
  bot_classification_incomplete: 'warn',
  referrer_source_incomplete: 'warn',
  direct_is_mixed_bucket: 'info',
  visitor_definition_approximate: 'info',
  catalog_series_is_additions_only: 'warn',
  catalog_series_starts_at: 'info',
  internal_filter_unavailable: 'info',
  internal_filter_applied: 'info',
  requires_recompute: 'info',
  algolia_credentials_absent: 'info',
  // A cron whose last run cannot be observed at all is a real observability gap,
  // not a footnote. Since AECI-583 it means the job has not run since run
  // recording shipped (or was added since), which is still worth a `warn`.
  cron_liveness_unavailable: 'warn',
  // No longer emitted (AECI-583 persists the sweep); retained because removing a
  // code is a breaking change and the map must stay total over `AdminNoteCode`.
  orphan_sweep_not_persisted: 'info',
  // A stored observability record that cannot be parsed is a defect in the
  // recorder, not a caveat about the data.
  stored_result_unreadable: 'warn',
  // AECI-579 / P1.5. `warn` means a reader who misses the note draws a WRONG
  // conclusion — a one-stage funnel looks broken, and a flag disagreeing with
  // its artifact is a real defect. The trade note is `info`: it reframes a number
  // that is otherwise easy to misread as a backlog, but nothing is wrong.
  funnel_is_promoted_cohort_only: 'warn',
  trade_facet_sparse_by_design: 'info',
  api_docs_flag_inconsistent: 'warn',
  // AECI-581 / P2.1. `warn`, on the same test: a reader who misses it reads an
  // approximation as a measurement. §4 shows the pre-snapshot catalog segment can
  // only ever be approximate (827 `integration.created` events back 496 live rows).
  series_partly_reconstructed: 'warn',
};

/** Build a note. `message` is the untranslated operator fallback; the UI renders
 *  localized prose from `code` + `params` (§9.4). */
export function note(
  code: AdminNoteCode,
  message: string,
  params?: Record<string, string | number>,
): AdminNote {
  return { code, severity: SEVERITY[code], message, ...(params ? { params } : {}) };
}

/** Rows in the window whose `is_bot` was never classified. They read as HUMAN
 *  under the digest's predicate — the whole reason the note exists. */
async function countUnclassifiedRows(db: Db, w: UtcWindow): Promise<number> {
  return countPageViewRows(
    db,
    and(inWindow(pageViews.createdAt, w), sql`${pageViews.isBot} IS NULL`),
  );
}

/** Human rows in the window with no `referrer_source`. Not backfillable — the
 *  header was never stored — so a source breakdown must declare it. */
async function countMissingReferrerSource(db: Db, w: UtcWindow): Promise<number> {
  return countPageViewRows(
    db,
    and(inWindow(pageViews.createdAt, w), HUMAN, sql`${pageViews.referrerSource} IS NULL`),
  );
}

/** The earliest `audit_log` row, or null on an empty log. A `catalog.*` window
 *  reaching back past this reads zero for want of data, not for want of activity. */
export async function earliestAuditDay(db: Db): Promise<string | null> {
  const [row] = await db
    .select({ day: sql<string | null>`min(substr(${auditLog.createdAt}, 1, 10))` })
    .from(auditLog);
  return row?.day ?? null;
}

/** The three notes every `page_views`-derived response owes its reader, derived
 *  from the window's actual contents. */
export async function trafficNotes(
  db: Db,
  w: UtcWindow,
  opts: { unique?: boolean; sources?: boolean } = {},
): Promise<AdminNote[]> {
  const out: AdminNote[] = [];

  const unclassified = await countUnclassifiedRows(db, w);
  if (unclassified > 0) {
    out.push(
      note(
        'bot_classification_incomplete',
        `${unclassified} page view(s) in this window have no bot classification and are counted as human. Backfill them with scripts/ops/2026-08-page-view-bot-backfill/.`,
        { rows: unclassified, window_from: w.fromDay, window_to: w.toDay },
      ),
    );
  }

  if (opts.sources) {
    const missing = await countMissingReferrerSource(db, w);
    if (missing > 0) {
      out.push(
        note(
          'referrer_source_incomplete',
          `${missing} human page view(s) in this window have no referrer source. Not backfillable — the header was never stored.`,
          { rows: missing },
        ),
      );
    }
    out.push(
      note(
        'direct_is_mixed_bucket',
        'Direct mixes true direct arrivals with in-app SPA navigation (the same-origin Referer classifies as Direct). AECI-585 separates them.',
      ),
    );
  }

  if (opts.unique) {
    out.push(
      note(
        'visitor_definition_approximate',
        'A visitor is a distinct (user_agent_hash, cf_asn) pair in the window. This over-counts on browser updates and under-counts behind shared NAT.',
      ),
    );
  }

  return out;
}

/** The internal-filter note — one of the two always fires, so the reader is never
 *  left guessing whether a figure was filtered (§13 D10 constraint 2). */
export function internalFilterNote(state: InternalFilterState): AdminNote {
  if (!state.applied) {
    return note(
      'internal_filter_unavailable',
      state.available
        ? 'Internal-traffic filtering is configured but was not requested; every figure is unfiltered.'
        : 'ANALYTICS_INTERNAL_ASNS is unset, so no internal-traffic figure is available. Every figure is unfiltered.',
    );
  }
  return note(
    'internal_filter_applied',
    `Figures are reported both unfiltered and excluding AS${state.asns.join(', AS')}. The unfiltered figure is always the primary one.`,
    { asns: state.asns.join(',') },
  );
}
