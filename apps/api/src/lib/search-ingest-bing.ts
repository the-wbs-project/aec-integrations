/**
 * The weekly search ingest, Bing lane (AECI-821, `ADMIN_PANEL_SPEC.md` §5.24.8 and
 * §5.24.10). It runs in the same `search-ingest` job as the Google lane
 * (`./search-ingest`), after it, and neither lane reads the other's result.
 *
 * Pulls three Bing Webmaster Tools reads for the registered `www.` site and writes
 * {@link SEARCH_INGEST_BING_METRIC_KEYS} into `metrics_daily`.
 *
 * | # | Call | Gives |
 * |---|---|---|
 * | 1 | `GetRankAndTrafficStats` | daily clicks and impressions |
 * | 2 | `GetCrawlStats` | daily `InIndex`, crawled pages, crawl errors |
 * | 3 | `GetFeeds` | the `www.` sitemap's URL count and last crawl |
 *
 * Sequential, through the pure transport in `./bing-webmaster-api`.
 *
 * ─── The gate ────────────────────────────────────────────────────────────────
 *
 * The lane is `skipped`, never `failed`, when `BWT_API_KEY` is absent, when
 * `BWT_SITE_URL` is unset, or when the site URL is not the
 * `https://www.aecintegrations.com/` site. The last rule keeps the keys honest:
 * every key says `www`, so a figure for another host must never be stored under
 * one. The key is pushed to production only, so the key itself is the tier gate.
 *
 * ─── The window, and what is written ─────────────────────────────────────────
 *
 * The daily window is the Google lane's: {@link SEARCH_INGEST_DAILY_WINDOW_DAYS}
 * Pacific days ending {@link SEARCH_INGEST_FINAL_LAG_DAYS} days before the run. Bing
 * returns up to six months. Only days inside the window are written, so a missed
 * week leaves no gap and a day Bing revised is corrected the next week.
 *
 * Each row is filed under its Pacific day: the calendar date of Bing's `Date`
 * instant at the offset Bing stated, else in America/Los_Angeles. A day Bing did
 * not return writes nothing. A field Bing left out writes nothing for that key.
 * Neither is ever a stored 0. The two `sitemap_*` keys are a sample taken at the
 * run, filed under the run's UTC day, like the Google `www_sitemap` keys.
 *
 * `in_index` is Bing's own figure. Microsoft does not define it. It is stored "as
 * reported by Bing" and never called a true count (§5.24.8).
 *
 * ─── Fail open ───────────────────────────────────────────────────────────────
 *
 * Each call fails alone. A throttle (`ThrottleUser`, `ThrottleHost`) is routine:
 * the call is `throttled`, its keys are `failed`, and the next week re-pulls the
 * window. The lane is `failed` only when every call reports a refused credential,
 * which is the state an operator must fix. A D1 write failure throws, and the
 * caller retries the run, which is safe because every write is an upsert.
 *
 * No `audit_log` row: ADR 0022's 2026-11-24 amendment covers these keys.
 */

import type { SearchIngestBingMetricKey } from '@aeci/shared';

import type { Db } from '../db/client';
import { shiftDay } from './admin-analytics';
import {
  callBingWebmaster,
  parseBingDate,
  type BingCrawlRow,
  type BingErrorKind,
  type BingFeedRow,
  type BingTrafficRow,
} from './bing-webmaster-api';
import { toCount } from './search-console-api';
import {
  pacificDay,
  SEARCH_INGEST_DAILY_WINDOW_DAYS,
  SEARCH_INGEST_FINAL_LAG_DAYS,
  SEARCH_INGEST_WWW_SITEMAP,
  upsertSearchMetric,
  type SearchIngestKeyOutcome,
} from './search-ingest';

/** The only host the `search.bing.www.*` keys may describe. */
export const BING_INGEST_WWW_HOST = 'www.aecintegrations.com';

export type BingIngestCallName = 'traffic' | 'crawl' | 'feeds';

export interface BingIngestCallReport {
  outcome: 'ok' | BingErrorKind;
  /** Our vocabulary only, never Bing's text. Holds no key. */
  message?: string;
  /** Bing's `ErrorCode`, when a 400 carried one. */
  errorCode?: number;
  /** Rows Bing returned. */
  rows: number;
  /** `metrics_daily` rows written from this call. */
  written: number;
}

/** What Bing said about the `www.` sitemap. Dates are ISO strings here, because a
 *  date is not a `metrics_daily` value. */
export interface BingIngestSitemapState {
  url: string;
  lastCrawled: string | null;
  submitted: string | null;
  status: string | null;
  urlCount: number | null;
}

export interface BingSearchIngestResult {
  outcome: 'ok' | 'skipped' | 'failed';
  /** Why it was skipped or failed. */
  reason?: 'no_creds' | 'no_site_url' | 'site_url_not_www' | 'bing_refused_credential';
  /** The registered site the calls named. Not a secret. */
  siteUrl?: string;
  /** The Pacific-day window written. Absent when skipped. */
  window?: { start: string; end: string };
  calls: Partial<Record<BingIngestCallName, BingIngestCallReport>>;
  metrics: Partial<Record<SearchIngestBingMetricKey, SearchIngestKeyOutcome>>;
  /** Null when the feed list had no `www.` sitemap or failed. */
  sitemap?: BingIngestSitemapState | null;
  written: number;
}

export interface BingSearchIngestDeps {
  db: Db;
  /** `BWT_API_KEY`. */
  apiKey: string | undefined;
  /** `BWT_SITE_URL`, the site exactly as BWT registered it. */
  siteUrl: string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const TRAFFIC_KEYS = {
  clicks: 'search.bing.www.clicks',
  impressions: 'search.bing.www.impressions',
} as const satisfies Record<string, SearchIngestBingMetricKey>;

const CRAWL_KEYS = {
  inIndex: 'search.bing.www.in_index',
  crawledPages: 'search.bing.www.crawled_pages',
  crawlErrors: 'search.bing.www.crawl_errors',
} as const satisfies Record<string, SearchIngestBingMetricKey>;

const SITEMAP_KEYS = {
  urls: 'search.bing.www.sitemap_urls',
  crawlAge: 'search.bing.www.sitemap_crawl_age_days',
} as const satisfies Record<string, SearchIngestBingMetricKey>;

/** Every Bing key this module can write. A test pins it to the shared list. */
export const BING_INGEST_WRITTEN_KEYS: readonly SearchIngestBingMetricKey[] = [
  ...Object.values(TRAFFIC_KEYS),
  ...Object.values(CRAWL_KEYS),
  ...Object.values(SITEMAP_KEYS),
];

/**
 * The Pacific reporting day of a Bing `Date`. Bing states its offset (`-0700`,
 * `-0800`), and the calendar date at that offset is the day Bing meant. With no
 * offset, the date in America/Los_Angeles. Null for an unparseable value.
 */
export function bingReportingDay(value: unknown): string | null {
  const parsed = parseBingDate(value);
  if (!parsed) return null;
  if (parsed.offsetMinutes === null) return pacificDay(new Date(parsed.ms));
  const wall = new Date(parsed.ms + parsed.offsetMinutes * 60_000);
  return Number.isNaN(wall.getTime()) ? null : wall.toISOString().slice(0, 10);
}

/** A Bing `Date` as an ISO instant, or null. */
function bingInstant(value: unknown): Date | null {
  const parsed = parseBingDate(value);
  if (!parsed) return null;
  const d = new Date(parsed.ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Whether `BWT_SITE_URL` names the `www.` site, the only scope the keys allow. */
export function isWwwBingSite(siteUrl: string): boolean {
  try {
    const u = new URL(siteUrl);
    return (
      (u.protocol === 'https:' || u.protocol === 'http:') &&
      u.hostname === BING_INGEST_WWW_HOST &&
      (u.pathname === '/' || u.pathname === '')
    );
  } catch {
    return false;
  }
}

/** Run the Bing lane once. Never throws on a Bing failure. */
export async function runBingSearchIngest(
  deps: BingSearchIngestDeps,
): Promise<BingSearchIngestResult> {
  const { db, fetchImpl = fetch, now = () => new Date(), sleep } = deps;
  const empty = { calls: {}, metrics: {}, written: 0 };
  const apiKey = deps.apiKey?.trim();
  if (!apiKey) return { outcome: 'skipped', reason: 'no_creds', ...empty };
  const siteUrl = deps.siteUrl?.trim();
  if (!siteUrl) return { outcome: 'skipped', reason: 'no_site_url', ...empty };
  if (!isWwwBingSite(siteUrl)) {
    return { outcome: 'skipped', reason: 'site_url_not_www', siteUrl, ...empty };
  }

  const startedAt = now();
  const computedAt = startedAt.toISOString();
  const end = shiftDay(pacificDay(startedAt), -SEARCH_INGEST_FINAL_LAG_DAYS);
  const start = shiftDay(end, -(SEARCH_INGEST_DAILY_WINDOW_DAYS - 1));
  const opts = sleep ? { sleep } : {};

  const calls: BingSearchIngestResult['calls'] = {};
  const metrics: BingSearchIngestResult['metrics'] = {};
  let written = 0;
  const mark = (keys: readonly SearchIngestBingMetricKey[], outcome: SearchIngestKeyOutcome) => {
    for (const k of keys) metrics[k] = outcome;
  };
  const failed = (r: { kind: BingErrorKind; message: string; errorCode?: number }) => ({
    outcome: r.kind,
    message: r.message,
    ...(r.errorCode !== undefined ? { errorCode: r.errorCode } : {}),
    rows: 0,
    written: 0,
  });

  /** Write each key's value for each in-window day, once per day. */
  const writeDaily = async <R extends { Date?: string }>(
    rows: R[],
    fields: Partial<Record<SearchIngestBingMetricKey, (row: R) => unknown>>,
  ): Promise<number> => {
    const keys = Object.keys(fields) as SearchIngestBingMetricKey[];
    const perKey = new Map<SearchIngestBingMetricKey, number>(keys.map((k) => [k, 0]));
    const seen = new Set<string>();
    let n = 0;
    for (const row of rows) {
      const day = bingReportingDay(row.Date);
      // Only days inside the window, and only once each.
      if (!day || day < start || day > end || seen.has(day)) continue;
      seen.add(day);
      for (const key of keys) {
        const value = toCount(fields[key]!(row));
        // A field Bing left out writes nothing, never a 0.
        if (value === null) continue;
        await upsertSearchMetric(db, day, key, value, computedAt);
        perKey.set(key, perKey.get(key)! + 1);
        n++;
      }
    }
    for (const key of keys) metrics[key] = perKey.get(key)! > 0 ? 'written' : 'no_data';
    return n;
  };

  // Call 1: daily clicks and impressions.
  const traffic = await callBingWebmaster<BingTrafficRow>(
    fetchImpl,
    'GetRankAndTrafficStats',
    siteUrl,
    apiKey,
    opts,
  );
  if (!traffic.ok) {
    calls.traffic = failed(traffic);
    mark(Object.values(TRAFFIC_KEYS), 'failed');
  } else {
    const n = await writeDaily(traffic.rows, {
      [TRAFFIC_KEYS.clicks]: (r: BingTrafficRow) => r.Clicks,
      [TRAFFIC_KEYS.impressions]: (r: BingTrafficRow) => r.Impressions,
    });
    calls.traffic = { outcome: 'ok', rows: traffic.rows.length, written: n };
    written += n;
  }

  // Call 2: Bing's daily index and crawl figures.
  const crawl = await callBingWebmaster<BingCrawlRow>(
    fetchImpl,
    'GetCrawlStats',
    siteUrl,
    apiKey,
    opts,
  );
  if (!crawl.ok) {
    calls.crawl = failed(crawl);
    mark(Object.values(CRAWL_KEYS), 'failed');
  } else {
    const n = await writeDaily(crawl.rows, {
      [CRAWL_KEYS.inIndex]: (r: BingCrawlRow) => r.InIndex,
      [CRAWL_KEYS.crawledPages]: (r: BingCrawlRow) => r.CrawledPages,
      [CRAWL_KEYS.crawlErrors]: (r: BingCrawlRow) => r.CrawlErrors,
    });
    calls.crawl = { outcome: 'ok', rows: crawl.rows.length, written: n };
    written += n;
  }

  // Call 3: the `www.` sitemap, a sample at the run.
  let sitemap: BingIngestSitemapState | null = null;
  const feeds = await callBingWebmaster<BingFeedRow>(fetchImpl, 'GetFeeds', siteUrl, apiKey, opts);
  if (!feeds.ok) {
    calls.feeds = failed(feeds);
    mark(Object.values(SITEMAP_KEYS), 'failed');
  } else {
    const entry = feeds.rows.find((f) => f.Url === SEARCH_INGEST_WWW_SITEMAP);
    let n = 0;
    if (!entry) {
      mark(Object.values(SITEMAP_KEYS), 'no_data');
    } else {
      const lastCrawled = bingInstant(entry.LastCrawled);
      const submitted = bingInstant(entry.Submitted);
      sitemap = {
        url: SEARCH_INGEST_WWW_SITEMAP,
        lastCrawled: lastCrawled?.toISOString() ?? null,
        submitted: submitted?.toISOString() ?? null,
        status: typeof entry.Status === 'string' ? entry.Status : null,
        urlCount: toCount(entry.UrlCount),
      };
      const runDay = computedAt.slice(0, 10);
      const values: Record<(typeof SITEMAP_KEYS)[keyof typeof SITEMAP_KEYS], number | null> = {
        [SITEMAP_KEYS.urls]: sitemap.urlCount,
        [SITEMAP_KEYS.crawlAge]: lastCrawled
          ? Math.max(0, (startedAt.getTime() - lastCrawled.getTime()) / 86_400_000)
          : null,
      };
      for (const key of Object.values(SITEMAP_KEYS)) {
        const value = values[key];
        if (value === null) {
          metrics[key] = 'no_data';
          continue;
        }
        await upsertSearchMetric(db, runDay, key, value, computedAt);
        metrics[key] = 'written';
        n++;
      }
    }
    calls.feeds = { outcome: 'ok', rows: feeds.rows.length, written: n };
    written += n;
  }

  // Failed only when Bing refused the credential on every call.
  const reports = Object.values(calls);
  const allAuth = reports.length > 0 && reports.every((c) => c.outcome === 'auth');
  return {
    outcome: allAuth ? 'failed' : 'ok',
    ...(allAuth ? { reason: 'bing_refused_credential' as const } : {}),
    siteUrl,
    window: { start, end },
    calls,
    metrics,
    sitemap,
    written,
  };
}

/**
 * The heartbeat outcome for the Bing lane. `throttled` is its own value, so a run
 * of throttles is visible on the dashboard without reading as broken: it is the
 * signal to move the transport to a runner (§5.24.10).
 */
export function bingHeartbeatOutcome(
  result: BingSearchIngestResult,
): 'ok' | 'partial' | 'throttled' | 'skipped' | 'failed' {
  if (result.outcome !== 'ok') return result.outcome;
  const bad = Object.values(result.calls).filter((c) => c.outcome !== 'ok');
  // The Google lane's rule: a key that failed under a call that succeeded is a
  // failure too. No Bing path does that today, so this is a guard.
  const keyFailedUnderOkCall = Object.values(result.metrics).some((m) => m === 'failed');
  if (bad.length === 0) return keyFailedUnderOkCall ? 'partial' : 'ok';
  return bad.every((c) => c.outcome === 'throttled') ? 'throttled' : 'partial';
}
