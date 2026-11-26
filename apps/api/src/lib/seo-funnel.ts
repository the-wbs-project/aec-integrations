/**
 * Panel 3 of the search console, the funnel (AECI-823, `ADMIN_PANEL_SPEC.md`
 * §5.24.7). `GET /api/admin/seo/funnel` in `routes/admin-seo.ts` calls
 * {@link readSeoFunnel}. Everything here is a read of `metrics_daily`, plus a live
 * lane computation when the snapshot has not written the day yet. No `audit_log`
 * row (ADR 0022).
 *
 * ─── Stages ──────────────────────────────────────────────────────────────────
 *
 * Google: catalog, crawled, impressed ("Indexed (lower bound)"), clicked. Google
 * has no bulk index API, so it never has `indexed`.
 * Bing: catalog, crawled, indexed (`search.bing.www.in_index`, "as reported by
 * Bing"), clicked. The ingest stores no Bing count of pages with an impression,
 * so Bing never has `impressed`.
 *
 * A stage with no data is omitted, never zeroed. `catalog` and `crawled` come
 * from D1, so they are always present for both engines. The two engines are
 * never summed: they are different indexes.
 *
 * ─── The two kinds of day, and the window each gets ──────────────────────────
 *
 * The D1 stages are UTC. `day` is the last complete UTC day. The crawl figures
 * cover the 28 days ending at 00:00 UTC after `day`, which is what the 00:15
 * snapshot stores under `day` as `seo.catalog_urls` and `seo.crawled_urls_*`.
 *
 * The ingested stages are Pacific dates. Google and Bing report by Pacific Time
 * day, and the weekly ingest files each row under that date without re-cutting it
 * (§5.24.8). This module does not re-cut it either. Each ingested series gets its
 * own window: the 28 Pacific dates ending on the newest date holding its daily
 * impressions row. That end is two to nine days behind `day`, because Google
 * finalises a day late and the ingest runs weekly. Ending the window on `day` instead would leave
 * those days empty and under-count clicks and impressions. The Google 28-day
 * page count is filed under the same end date by the ingest, so stage 3 and
 * stage 4 cover the same Pacific dates.
 *
 * A series whose newest date is older than the 28 dates ending on `day` is stale.
 * It is treated as no data. An engine with no ingested stage at all, for this or
 * any other reason, carries `search_ingest_absent`. The click totals sum only
 * the dates that hold both a clicks row and an impressions row, because the
 * ingest stores the two as separate rows and either can be missing on a date. A
 * click window with fewer than 28 such dates carries `search_window_incomplete`,
 * and `days_recorded` counts those dates. The
 * comparison treats the Pacific date and the UTC label as plain dates. They can
 * differ by one day at the edge, which the 28-day reach makes immaterial.
 */
import type {
  AdminNote,
  SeoEngine,
  SeoFunnelBaseline,
  SeoFunnelEngine,
  SeoFunnelResponse,
  SeoFunnelStage,
  SeoPacificWindow,
  SeoSearchTotals,
  AdminSnapshotMetricKey,
  SearchIngestMetricKey,
} from '@aeci/shared';
import { and, gte, inArray, lte } from 'drizzle-orm';

import type { Db } from '../db/client';
import { metricsDaily } from '../db/schema';
import { note, shiftDay } from './admin-analytics';
import { computeSeoLanes, crawlNotes, crawlWindow, toCrawlAdminWindow } from './seo-queue';

/** The funnel's window length, in days of either kind. Search Console's own
 *  reports use 28. */
export const SEO_FUNNEL_WINDOW_DAYS = 28;

/**
 * The AECI-799 baseline (`ANALYTICS_BASELINE.md`, "AECI-799 addendum"): three
 * months ending 2026-09-05, Search type Web, the Domain property with no host
 * filter, read on 2026-09-09. Search Console showed impressions as "15.9K" and
 * CTR as "0.3%", so both are as precise as the console was.
 */
export const AECI_799_BASELINE: SeoFunnelBaseline['reference'] = {
  clicks: 41,
  impressions: 15_900,
  ctr: 0.003,
  position_avg: 31.9,
  window_end: '2026-09-05',
  window_months: 3,
  taken_on: '2026-09-09',
  impressions_rounded: true,
};

type FunnelKey = AdminSnapshotMetricKey | SearchIngestMetricKey;

const SNAPSHOT_KEYS = {
  catalog: 'seo.catalog_urls',
  crawledGoogle: 'seo.crawled_urls_google',
  crawledBing: 'seo.crawled_urls_bing',
} as const satisfies Record<string, AdminSnapshotMetricKey>;

interface SeriesKeys {
  clicks: SearchIngestMetricKey;
  impressions: SearchIngestMetricKey;
  position?: SearchIngestMetricKey;
}

const GOOGLE_WWW: SeriesKeys = {
  clicks: 'search.google.www_page.clicks',
  impressions: 'search.google.www_page.impressions',
  position: 'search.google.www_page.position_avg',
};
const GOOGLE_PROPERTY: SeriesKeys = {
  clicks: 'search.google.property.clicks',
  impressions: 'search.google.property.impressions',
  position: 'search.google.property.position_avg',
};
const BING_WWW: SeriesKeys = {
  clicks: 'search.bing.www.clicks',
  impressions: 'search.bing.www.impressions',
};
const GOOGLE_CATALOG_IMPRESSED = 'search.google.www_page.catalog_pages_with_impressions_28d';
const BING_IN_INDEX = 'search.bing.www.in_index';

const FUNNEL_KEYS: readonly FunnelKey[] = [
  ...Object.values(SNAPSHOT_KEYS),
  ...Object.values(GOOGLE_WWW),
  ...Object.values(GOOGLE_PROPERTY),
  ...Object.values(BING_WWW),
  GOOGLE_CATALOG_IMPRESSED,
  BING_IN_INDEX,
];

/** `metric → day → value`. */
export type FunnelRows = Map<string, Map<string, number>>;

/** The last complete UTC day before `now`, `YYYY-MM-DD`. */
export function lastCompleteUtcDay(now: Date): string {
  return shiftDay(now.toISOString().slice(0, 10), -1);
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

const whole = (v: number) => Math.max(0, Math.round(v));

/**
 * The newest date in the 28 dates ending `day` that holds a row for any of
 * `anchorKeys`, or null. Plain string compare: every label is `YYYY-MM-DD`.
 */
function newestIngestedDay(
  rows: FunnelRows,
  anchorKeys: readonly string[],
  day: string,
): string | null {
  const earliest = shiftDay(day, -(SEO_FUNNEL_WINDOW_DAYS - 1));
  let newest: string | null = null;
  for (const key of anchorKeys) {
    for (const d of rows.get(key)?.keys() ?? []) {
      if (d >= earliest && d <= day && (newest === null || d > newest)) newest = d;
    }
  }
  return newest;
}

/**
 * The dates in `[from, to]` that hold BOTH a clicks row and an impressions row.
 * The ingest writes each field as its own row, and a field the engine left out
 * writes none (`search-ingest-bing.ts`, `search-ingest.ts`). A clicks row with no
 * impressions row has no denominator, and an impressions row with no clicks row
 * is not a measured zero. So a window sums matched dates only.
 */
function matchedDays(rows: FunnelRows, keys: SeriesKeys, from: string, to: string): string[] {
  const clicksByDay = rows.get(keys.clicks);
  if (!clicksByDay) return [];
  const days: string[] = [];
  for (const d of rows.get(keys.impressions)?.keys() ?? []) {
    if (d >= from && d <= to && clicksByDay.has(d)) days.push(d);
  }
  return days;
}

/** The 28 Pacific dates ending `end`, with how many of them hold both a clicks
 *  and an impressions row of `keys`. */
function pacificWindow(rows: FunnelRows, end: string, keys: SeriesKeys): SeoPacificWindow {
  const from = shiftDay(end, -(SEO_FUNNEL_WINDOW_DAYS - 1));
  return {
    from,
    to: end,
    timezone: 'America/Los_Angeles',
    days: SEO_FUNNEL_WINDOW_DAYS,
    days_recorded: matchedDays(rows, keys, from, end).length,
  };
}

/**
 * Clicks, impressions, CTR and position over the dates in `[from, to]` that hold
 * both a clicks and an impressions row, or null when no date does. A series
 * with no row in the window is therefore absent, never a measured 0% CTR. CTR is
 * summed clicks over summed impressions, never a mean of daily ratios. Position
 * is weighted by each matched day's impressions, because the stored figure is
 * already that day's impression-weighted average.
 */
export function sumSeries(
  rows: FunnelRows,
  keys: SeriesKeys,
  from: string,
  to: string,
): SeoSearchTotals | null {
  const days = matchedDays(rows, keys, from, to);
  if (days.length === 0) return null;
  const clicksByDay = rows.get(keys.clicks)!;
  const impressionsByDay = rows.get(keys.impressions)!;
  const positionByDay = keys.position ? rows.get(keys.position) : undefined;

  let clicks = 0;
  let impressions = 0;
  let weighted = 0;
  let weight = 0;
  for (const d of days) {
    const dayImpressions = impressionsByDay.get(d)!;
    clicks += clicksByDay.get(d)!;
    impressions += dayImpressions;
    const position = positionByDay?.get(d);
    if (position === undefined || dayImpressions <= 0) continue;
    weighted += position * dayImpressions;
    weight += dayImpressions;
  }

  const c = whole(clicks);
  const i = whole(impressions);
  return {
    clicks: c,
    impressions: i,
    ctr: rate(c, i),
    position_avg: weight > 0 ? Math.round((weighted / weight) * 10) / 10 : null,
  };
}

/** The newest value of `key` inside `[from, to]`, with its date. */
function latestIn(
  rows: FunnelRows,
  key: string,
  from: string,
  to: string,
): { day: string; value: number } | null {
  let best: { day: string; value: number } | null = null;
  for (const [d, v] of rows.get(key) ?? []) {
    if (d >= from && d <= to && (best === null || d > best.day)) best = { day: d, value: v };
  }
  return best;
}

interface D1Stages {
  catalog: number;
  crawled: Record<SeoEngine, number>;
}

function d1Head(d1: D1Stages, engine: SeoEngine): SeoFunnelStage[] {
  return [
    { stage: 'catalog', count: d1.catalog, rate: null, measure: 'measured', source: 'd1' },
    {
      stage: 'crawled',
      count: d1.crawled[engine],
      rate: rate(d1.crawled[engine], d1.catalog),
      measure: 'measured',
      source: 'd1',
    },
  ];
}

function clickedStage(
  totals: SeoSearchTotals,
  source: SeoFunnelStage['source'],
  withPosition: boolean,
): SeoFunnelStage {
  return {
    stage: 'clicked',
    count: totals.clicks,
    rate: totals.ctr,
    measure: 'measured',
    source,
    impressions: totals.impressions,
    ...(withPosition ? { position_avg: totals.position_avg } : {}),
  };
}

/** The Google funnel. `www_page` scope only: the stage-3 page count exists only
 *  at that scope. The `property` figures ride `baseline`. */
export function googleFunnel(rows: FunnelRows, day: string, d1: D1Stages): SeoFunnelEngine {
  const stages = d1Head(d1, 'google');
  // The window is anchored on the daily impressions series alone. The 28-day page
  // count comes from a different call. If the daily call failed and the page call
  // succeeded, anchoring on the page count would move the window forward over
  // days with no daily rows, and stage 4 would sum fewer days than it says.
  const end = newestIngestedDay(rows, [GOOGLE_WWW.impressions], day);
  let searchWindow: SeoPacificWindow | null = null;
  if (end !== null) {
    searchWindow = pacificWindow(rows, end, GOOGLE_WWW);
    // Filed by the ingest under the 28-day window's own end date. A row under
    // any other date covers a different 28 days, so it is not read.
    const impressed = rows.get(GOOGLE_CATALOG_IMPRESSED)?.get(end);
    if (impressed !== undefined) {
      const count = whole(impressed);
      stages.push({
        stage: 'impressed',
        count,
        rate: rate(count, d1.catalog),
        measure: 'lower_bound',
        source: 'search_console',
        as_of: end,
      });
    }
    const totals = sumSeries(rows, GOOGLE_WWW, searchWindow.from, searchWindow.to);
    if (totals) stages.push(clickedStage(totals, 'search_console', true));
  }

  const propertyEnd = newestIngestedDay(rows, [GOOGLE_PROPERTY.impressions], day);
  let current: SeoFunnelBaseline['current'] = null;
  if (propertyEnd !== null) {
    const window = pacificWindow(rows, propertyEnd, GOOGLE_PROPERTY);
    const totals = sumSeries(rows, GOOGLE_PROPERTY, window.from, window.to);
    if (totals) current = { ...totals, window };
  }

  return {
    engine: 'google',
    scope: 'www_page',
    search_window: searchWindow,
    stages,
    baseline: { scope: 'property', current, reference: AECI_799_BASELINE },
  };
}

/** The Bing funnel: stages 0, 1, 2 and 4, never 3 (§5.24.7). */
export function bingFunnel(rows: FunnelRows, day: string, d1: D1Stages): SeoFunnelEngine {
  const stages = d1Head(d1, 'bing');
  // Stage 2 is a daily reading, not a sum, so it does not need the click window.
  // It is the newest reading in the 28 dates ending `day`, dated by `as_of`. The
  // click window is anchored on the daily impressions series alone, as for Google.
  const inIndex = latestIn(rows, BING_IN_INDEX, shiftDay(day, -(SEO_FUNNEL_WINDOW_DAYS - 1)), day);
  if (inIndex) {
    const count = whole(inIndex.value);
    stages.push({
      stage: 'indexed',
      count,
      rate: rate(count, d1.catalog),
      measure: 'engine_reported',
      source: 'bing_webmaster',
      as_of: inIndex.day,
    });
  }
  const end = newestIngestedDay(rows, [BING_WWW.impressions], day);
  let searchWindow: SeoPacificWindow | null = null;
  if (end !== null) {
    searchWindow = pacificWindow(rows, end, BING_WWW);
    const totals = sumSeries(rows, BING_WWW, searchWindow.from, searchWindow.to);
    if (totals) stages.push(clickedStage(totals, 'bing_webmaster', false));
  }
  return { engine: 'bing', scope: 'www', search_window: searchWindow, stages, baseline: null };
}

/** Every funnel key from the earliest date any window can start on through `day`. */
export async function readFunnelRows(db: Db, day: string): Promise<FunnelRows> {
  // A window ends no earlier than `day − 27` and spans 28 dates.
  const from = shiftDay(day, -(2 * SEO_FUNNEL_WINDOW_DAYS - 2));
  const stored = await db
    .select({ day: metricsDaily.day, metric: metricsDaily.metric, value: metricsDaily.value })
    .from(metricsDaily)
    .where(
      and(
        inArray(metricsDaily.metric, [...FUNNEL_KEYS]),
        gte(metricsDaily.day, from),
        lte(metricsDaily.day, day),
      ),
    );
  const rows: FunnelRows = new Map();
  for (const r of stored) {
    let byDay = rows.get(r.metric);
    if (!byDay) rows.set(r.metric, (byDay = new Map()));
    byDay.set(r.day, r.value);
  }
  return rows;
}

/**
 * The D1 stages for `day`: the snapshot's stored stocks when all three exist,
 * else the same computation the snapshot runs, ending at the same instant. The
 * fallback keeps stage 1 present before the 00:15 snapshot has filed `day`.
 */
async function d1Stages(db: Db, rows: FunnelRows, day: string, dayEnd: Date): Promise<D1Stages> {
  const catalog = rows.get(SNAPSHOT_KEYS.catalog)?.get(day);
  const google = rows.get(SNAPSHOT_KEYS.crawledGoogle)?.get(day);
  const bing = rows.get(SNAPSHOT_KEYS.crawledBing)?.get(day);
  if (catalog !== undefined && google !== undefined && bing !== undefined) {
    return { catalog: whole(catalog), crawled: { google: whole(google), bing: whole(bing) } };
  }
  const lanes = await computeSeoLanes(db, dayEnd);
  return { catalog: lanes.catalogUrls, crawled: lanes.crawled };
}

export async function readSeoFunnel(db: Db, now: Date): Promise<SeoFunnelResponse> {
  const day = lastCompleteUtcDay(now);
  const dayEnd = new Date(`${shiftDay(day, 1)}T00:00:00.000Z`);
  const window = crawlWindow(dayEnd);

  const rows = await readFunnelRows(db, day);
  const d1 = await d1Stages(db, rows, day, dayEnd);
  const engines = [googleFunnel(rows, day, d1), bingFunnel(rows, day, d1)];

  const notes: AdminNote[] = crawlNotes({
    ...(window.clamped ? { clampedFrom: window.from } : {}),
    reachesUnverified: window.reachesUnverified,
  });
  if (engines[0]!.stages.some((s) => s.stage === 'impressed')) {
    notes.push(
      note(
        'indexed_is_impression_lower_bound',
        "Google's indexed figure counts catalog pages with at least one impression in 28 days. It is a lower bound, not Google's index count.",
      ),
    );
  }
  for (const e of engines) {
    // Every ingested stage omitted, for whatever reason: say so, so the panel
    // never shows two D1 stages with no explanation.
    if (!e.stages.some((s) => s.source !== 'd1')) {
      notes.push(
        note(
          'search_ingest_absent',
          `No ${e.engine} ingest data falls in the window, so only the D1 stages are shown.`,
          { engine: e.engine },
        ),
      );
    }
    const w = e.search_window;
    if (w !== null && w.days_recorded < w.days) {
      notes.push(
        note(
          'search_window_incomplete',
          `Only ${w.days_recorded} of the ${w.days} ${e.engine} days from ${w.from} to ${w.to} hold both daily clicks and impressions, so the click totals cover fewer days than the window.`,
          {
            engine: e.engine,
            days_recorded: w.days_recorded,
            days: w.days,
            from: w.from,
            to: w.to,
          },
        ),
      );
    }
  }

  return {
    generated_at: now.toISOString(),
    day,
    crawl_window: toCrawlAdminWindow(window),
    engines,
    notes,
  };
}
