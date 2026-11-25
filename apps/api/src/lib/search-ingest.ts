/**
 * The weekly search ingest, Google lane (AECI-820, `ADMIN_PANEL_SPEC.md` §5.24.8
 * and §5.24.10). Bing (AECI-821) is the second lane of the same run, in
 * `./search-ingest-bing`. Neither lane reads the other's result.
 *
 * Pulls Search Analytics and the Sitemaps list for `sc-domain:aecintegrations.com`
 * and writes {@link SEARCH_INGEST_GOOGLE_METRIC_KEYS} into `metrics_daily`. It is
 * the second writer of that table. The 00:15 snapshot is the first.
 *
 * ─── The calls, all sequential on one token ──────────────────────────────────
 *
 * | # | Call | Gives |
 * |---|---|---|
 * | 0 | token exchange | one access token for the run |
 * | 1 | Search Analytics, `date`, `www.` page filter | daily `www_page` clicks, impressions, position |
 * | 2 | Search Analytics, `date`, no filter, `byProperty` | daily `property` clicks, impressions, position |
 * | 3 | Search Analytics, `page`, `www.` filter, 28 days | pages with an impression, all and catalog only |
 * | 4 | Search Analytics, `query`, `www.` filter, 28 days | distinct queries |
 * | 5 | Sitemaps list | the `www.` sitemap's last read, size, errors, warnings |
 *
 * Calls 3 and 4 page by `startRow` only when a page comes back full, up to
 * {@link SEARCH_ANALYTICS_MAX_PAGES}. A 1,500-URL site is not expected to fill one.
 *
 * ─── The window, in Pacific days ─────────────────────────────────────────────
 *
 * Google's dates are Pacific Time. Data is "typically available after 2-3 days",
 * so every window ends {@link SEARCH_INGEST_FINAL_LAG_DAYS} Pacific days before
 * the run, and every call asks for `dataState: 'final'`. The daily calls re-pull
 * {@link SEARCH_INGEST_DAILY_WINDOW_DAYS} days, two weekly runs' worth. So one
 * missed week leaves no gap, and a day Google finalised late is corrected the
 * next week. The 28-day calls end on the newest day call 1 returned, which is a
 * day Google has finalised, so the count never covers a part-loaded day.
 *
 * ─── What is written, and what never is ──────────────────────────────────────
 *
 *   - **Only days Google returned.** A day absent from a response writes nothing.
 *     It is never written as 0, because a stored 0 is indistinguishable from a
 *     measured quiet day, and a re-pull must not erase an earlier figure by
 *     absence (ADR 0027's `stored → 0` refusal). The same holds for the 28-day
 *     counts: an empty answer, or a `www_page` series with no day in the window,
 *     records the keys as `no_data` and writes nothing.
 *   - **Idempotent upserts on `(day, metric)`**, `source: 'measured'`, per key and
 *     outside any batch, as §7.1 writes. A re-pull overwrites with Google's
 *     current figure. ADR 0027 allows a `measured` write over `measured` where the
 *     source still holds the data, and Google keeps 16 months.
 *   - **No `audit_log` row.** Exempt under ADR 0022's 2026-11-24 amendment, the
 *     operator-only reading of an external system. The run's record is its
 *     `job_runs` row.
 *
 * ─── Fail open ───────────────────────────────────────────────────────────────
 *
 * Each call returns a structured result and never throws. One call's failure
 * writes nothing for the keys it feeds and the other calls still run. The run is
 * `failed` only when the credential is refused: the token endpoint rejects it (a
 * 4xx other than 429), the key will not import, or every call answers 401 or 403.
 * That is the state an operator must fix. A token exchange that stays transient
 * (5xx, 429, a dropped connection) after the in-process retries ends the run `ok`
 * with `reason: 'token_transient'`, every key `failed` and nothing written. A D1 write
 * failure throws, so the queue retries the run, and the retry is safe because
 * every write is an upsert. No `catch` here wraps a write. The one `catch` covers
 * the catalog URL read alone: a failed read marks only the catalog key `failed`.
 *
 * ─── The indexed count is a proxy, stated where it is computed ───────────────
 *
 * No Google API returns the Page indexing report's total. `contents[].indexed` in
 * the Sitemaps API is deprecated. URL Inspection is per URL, 2,000 a day, and the
 * daily `gsc-inspect` run already budgets 1,500 of them (§5.24.10 rule 5). So the
 * stored figure is pages with at least one impression in 28 days. It is a lower
 * bound on indexed pages, and the weekly manual read of the Page indexing report
 * stays (`POST_LAUNCH_MONITORING.md` §2a).
 */

import type { SearchIngestGoogleMetricKey, SearchIngestMetricKey } from '@aeci/shared';

import type { Db } from '../db/client';
import { metricsDaily } from '../db/schema';
import { shiftDay } from './admin-analytics';
import {
  getGoogleAccessToken,
  parseServiceAccount,
  type TokenFailureKind,
  type TokenResult,
} from './google-service-account';
import {
  listSitemaps,
  SEARCH_CONSOLE_RETRY_DELAYS_MS,
  querySearchAnalytics,
  toCount,
  type SearchAnalyticsQuery,
  type SearchAnalyticsRow,
  type SearchConsoleErrorKind,
  type SitemapEntry,
} from './search-console-api';
import { buildCatalogSitemap } from './sitemap-build';

/** The host every `www_page` and `www_sitemap` key is filtered to. */
export const SEARCH_INGEST_WWW_ORIGIN = 'https://www.aecintegrations.com';
/** RE2, as Google's `includingRegex` takes it. Anchored, so the apex and `demo.`
 *  never match. */
export const SEARCH_INGEST_WWW_PAGE_REGEX = '^https://www\\.aecintegrations\\.com/';
/** The sitemap whose state the `www_sitemap` keys record. */
export const SEARCH_INGEST_WWW_SITEMAP = `${SEARCH_INGEST_WWW_ORIGIN}/sitemap.xml`;

/** Pacific days between the run and the newest day asked for. */
export const SEARCH_INGEST_FINAL_LAG_DAYS = 3;
/** Daily-series days re-pulled per run: two weekly runs. */
export const SEARCH_INGEST_DAILY_WINDOW_DAYS = 14;
/** The trailing window of the `_28d` keys. Search Console's own reports use 28. */
export const SEARCH_INGEST_ROLLING_DAYS = 28;
/** Google's maximum `rowLimit`. */
export const SEARCH_ANALYTICS_ROW_LIMIT = 25_000;
/** Pages per paged call. Four full pages is 100,000 rows, far past this site. */
export const SEARCH_ANALYTICS_MAX_PAGES = 4;

export const SEARCH_INGEST_RUN_METRIC = 'aeci.search_ingest.run';

export type SearchIngestCallName =
  | 'token'
  | 'www_daily'
  | 'property_daily'
  | 'www_pages_28d'
  | 'www_queries_28d'
  | 'sitemaps';

/** One call's outcome, as `job_runs.detail` records it. */
export interface SearchIngestCallReport {
  outcome: 'ok' | SearchConsoleErrorKind | TokenFailureKind;
  message?: string;
  /** Rows Google returned, across pages. */
  rows: number;
  /** `metrics_daily` rows written from this call. */
  written: number;
  /** The paged call stopped at {@link SEARCH_ANALYTICS_MAX_PAGES} with more rows left. */
  truncated?: boolean;
  /** `www_pages_28d` only: why the catalog URL read failed, when it did. The
   *  call itself succeeded, so `outcome` stays `ok`. Error message only, no stack. */
  catalogReadError?: string;
}

/** The longest error message a call report keeps. */
const ERROR_MESSAGE_MAX = 200;

/** Per key: written, or why not. `no_data` means the call succeeded with nothing
 *  to store, e.g. no impressions, or no `www.` sitemap entry. */
export type SearchIngestKeyOutcome = 'written' | 'no_data' | 'failed';

/** What Google said about the `www.` sitemap. The dates are stored here because a
 *  date is not a `metrics_daily` value (§5.24.10). */
export interface SearchIngestSitemapState {
  path: string;
  lastDownloaded: string | null;
  lastSubmitted: string | null;
  isPending: boolean | null;
  errors: number | null;
  warnings: number | null;
  submitted: number | null;
}

export interface GoogleSearchIngestResult {
  outcome: 'ok' | 'skipped' | 'failed';
  /** Why it was skipped or failed. */
  reason?: string;
  /** The Pacific-day windows asked for. Absent when skipped before any call. */
  window?: {
    daily: { start: string; end: string };
    rolling: { start: string; end: string };
  };
  calls: Partial<Record<SearchIngestCallName, SearchIngestCallReport>>;
  metrics: Partial<Record<SearchIngestGoogleMetricKey, SearchIngestKeyOutcome>>;
  /** Null when the list had no `www.` entry or failed. */
  sitemap?: SearchIngestSitemapState | null;
  /** `metrics_daily` rows written in total. */
  written: number;
}

export interface GoogleSearchIngestDeps {
  db: Db;
  /** `GSC_SA_KEY_JSON`. */
  serviceAccountJson: string | undefined;
  /** `INDEXNOW_KEY` + `PUBLIC_SITE_URL`: the §20.2 "this env is public and
   *  indexable" signal `gsc-inspect` uses. Production only. */
  indexNowKey: string | undefined;
  publicSiteUrl: string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** The catalog sitemap's absolute URLs. Defaults to {@link catalogUrlSet}. */
  catalogUrls?: () => Promise<ReadonlySet<string>>;
}

/** `YYYY-MM-DD` of `now` in America/Los_Angeles, Google's reporting day. */
export function pacificDay(now: Date): string {
  // `en-CA` formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

/**
 * The catalog sitemap's `<loc>` URLs, built on {@link SEARCH_INGEST_WWW_ORIGIN}.
 *
 * Read from `buildCatalogSitemap`'s output rather than restating its visibility,
 * retired-slug and trade rules (§5.24.5). AECI-818 extracts the URL list into a
 * function both callers share. When it lands, this reads that list instead.
 */
export async function catalogUrlSet(db: Db): Promise<ReadonlySet<string>> {
  const { xml } = await buildCatalogSitemap(db, SEARCH_INGEST_WWW_ORIGIN);
  const urls = new Set<string>();
  for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    urls.add(m[1]!.replace(/&(?:amp|lt|gt|quot|apos);/g, (e) => XML_ENTITIES[e]!));
  }
  return urls;
}

const WWW_FILTER: NonNullable<SearchAnalyticsQuery['dimensionFilterGroups']> = [
  {
    groupType: 'and',
    filters: [
      { dimension: 'page', operator: 'includingRegex', expression: SEARCH_INGEST_WWW_PAGE_REGEX },
    ],
  },
];

/** Daily keys per scope, in the order the daily writer fills them. */
const DAILY_KEYS = {
  www: {
    clicks: 'search.google.www_page.clicks',
    impressions: 'search.google.www_page.impressions',
    position: 'search.google.www_page.position_avg',
  },
  property: {
    clicks: 'search.google.property.clicks',
    impressions: 'search.google.property.impressions',
    position: 'search.google.property.position_avg',
  },
} as const satisfies Record<string, Record<string, SearchIngestGoogleMetricKey>>;

const SITEMAP_KEYS = [
  'search.google.www_sitemap.urls_submitted',
  'search.google.www_sitemap.errors',
  'search.google.www_sitemap.warnings',
  'search.google.www_sitemap.download_age_days',
] as const satisfies readonly SearchIngestGoogleMetricKey[];

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Upsert one `(day, metric)` row as `measured`. Throws on a D1 failure. Both
 *  lanes write through it. */
export async function upsertSearchMetric(
  db: Db,
  day: string,
  metric: SearchIngestMetricKey,
  value: number,
  computedAt: string,
): Promise<void> {
  await db
    .insert(metricsDaily)
    .values({ day, metric, value, source: 'measured', computedAt })
    .onConflictDoUpdate({
      target: [metricsDaily.day, metricsDaily.metric],
      set: { value, source: 'measured', computedAt },
    });
}

/** Fetch every page of a paged query, one request at a time. */
async function queryAllPages(
  fetchImpl: typeof fetch,
  token: string,
  query: SearchAnalyticsQuery,
  sleep: ((ms: number) => Promise<void>) | undefined,
): Promise<
  | { ok: true; rows: SearchAnalyticsRow[]; truncated: boolean }
  | { ok: false; kind: SearchConsoleErrorKind; message: string }
> {
  const rows: SearchAnalyticsRow[] = [];
  for (let page = 0; page < SEARCH_ANALYTICS_MAX_PAGES; page++) {
    const res = await querySearchAnalytics(
      fetchImpl,
      token,
      {
        ...query,
        rowLimit: SEARCH_ANALYTICS_ROW_LIMIT,
        startRow: page * SEARCH_ANALYTICS_ROW_LIMIT,
      },
      sleep ? { sleep } : {},
    );
    if (!res.ok) return res;
    rows.push(...res.rows);
    if (res.rows.length < SEARCH_ANALYTICS_ROW_LIMIT) return { ok: true, rows, truncated: false };
  }
  return { ok: true, rows, truncated: true };
}

/** Run the Google lane once. Never throws on a Google failure. */
export async function runGoogleSearchIngest(
  deps: GoogleSearchIngestDeps,
): Promise<GoogleSearchIngestResult> {
  const { db, fetchImpl = fetch, now = () => new Date(), sleep } = deps;
  const empty = { calls: {}, metrics: {}, written: 0 };
  const account = parseServiceAccount(deps.serviceAccountJson);
  if (!account) return { outcome: 'skipped', reason: 'no_creds', ...empty };
  if (!deps.indexNowKey || !deps.publicSiteUrl) {
    return { outcome: 'skipped', reason: 'not_public', ...empty };
  }

  // The token exchange retries a transient failure in-process, as every call here
  // does, with the same delays. A refusal is the credential: the run fails. A
  // transient failure that outlasts the retries is recorded and the run ends `ok`,
  // the way `gsc-inspect` treats a call that stays transient. The next Sunday
  // re-pulls 14 days, so no daily figure is lost. No queue retry: a token endpoint
  // outage is not something a retry seconds later is likely to clear.
  let token: TokenResult = { ok: false, kind: 'transient', message: 'not_attempted' };
  for (let attempt = 0; attempt <= SEARCH_CONSOLE_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await (sleep ?? realSleep)(SEARCH_CONSOLE_RETRY_DELAYS_MS[attempt - 1]!);
    token = await getGoogleAccessToken(fetchImpl, account);
    if (token.ok || token.kind === 'refused') break;
  }
  if (!token.ok) {
    if (token.kind === 'refused') return { outcome: 'failed', reason: token.message, ...empty };
    const metrics: GoogleSearchIngestResult['metrics'] = {};
    for (const key of SEARCH_INGEST_WRITTEN_KEYS) metrics[key] = 'failed';
    return {
      outcome: 'ok',
      reason: 'token_transient',
      calls: { token: { outcome: 'transient', message: token.message, rows: 0, written: 0 } },
      metrics,
      written: 0,
    };
  }

  const startedAt = now();
  const computedAt = startedAt.toISOString();
  const dailyEnd = shiftDay(pacificDay(startedAt), -SEARCH_INGEST_FINAL_LAG_DAYS);
  const dailyStart = shiftDay(dailyEnd, -(SEARCH_INGEST_DAILY_WINDOW_DAYS - 1));
  const opts = sleep ? { sleep } : {};

  const calls: GoogleSearchIngestResult['calls'] = {};
  const metrics: GoogleSearchIngestResult['metrics'] = {};
  let written = 0;
  const mark = (keys: readonly SearchIngestGoogleMetricKey[], outcome: SearchIngestKeyOutcome) => {
    for (const k of keys) metrics[k] = outcome;
  };

  // Calls 1 and 2: the daily series, one scope each.
  let newestFinalDay: string | null = null;
  for (const scope of ['www', 'property'] as const) {
    const name: SearchIngestCallName = scope === 'www' ? 'www_daily' : 'property_daily';
    const keys = DAILY_KEYS[scope];
    const res = await querySearchAnalytics(
      fetchImpl,
      token.token,
      {
        startDate: dailyStart,
        endDate: dailyEnd,
        dimensions: ['date'],
        type: 'web',
        dataState: 'final',
        rowLimit: SEARCH_ANALYTICS_ROW_LIMIT,
        ...(scope === 'www'
          ? { dimensionFilterGroups: WWW_FILTER }
          : { aggregationType: 'byProperty' as const }),
      },
      opts,
    );
    if (!res.ok) {
      calls[name] = { outcome: res.kind, message: res.message, rows: 0, written: 0 };
      mark(Object.values(keys), 'failed');
      continue;
    }
    let n = 0;
    const seen = new Set<string>();
    for (const row of res.rows) {
      const day = row.keys?.[0];
      // Only days inside the window asked for, and only once each.
      if (!day || !DAY.test(day) || day < dailyStart || day > dailyEnd || seen.has(day)) continue;
      seen.add(day);
      const clicks = toCount(row.clicks);
      const impressions = toCount(row.impressions);
      if (clicks !== null) {
        await upsertSearchMetric(db, day, keys.clicks, clicks, computedAt);
        n++;
      }
      if (impressions !== null) {
        await upsertSearchMetric(db, day, keys.impressions, impressions, computedAt);
        n++;
      }
      // Position means nothing on a day with no impressions: no row, not 0.
      const position = toCount(row.position);
      if (impressions !== null && impressions > 0 && position !== null) {
        await upsertSearchMetric(db, day, keys.position, position, computedAt);
        n++;
      }
      if (scope === 'www' && (newestFinalDay === null || day > newestFinalDay)) {
        newestFinalDay = day;
      }
    }
    calls[name] = { outcome: 'ok', rows: res.rows.length, written: n };
    mark(Object.values(keys), n > 0 ? 'written' : 'no_data');
    written += n;
  }

  // The 28-day window ends on the newest finalised day call 1 returned. If call 1
  // failed, it falls back to the lagged end, which Google has usually finalised.
  // If call 1 succeeded with no day, calls 3 and 4 are skipped below. The window
  // is recorded in the result either way.
  const rollingEnd = newestFinalDay ?? dailyEnd;
  const rollingStart = shiftDay(rollingEnd, -(SEARCH_INGEST_ROLLING_DAYS - 1));
  const rolling: SearchAnalyticsQuery = {
    startDate: rollingStart,
    endDate: rollingEnd,
    type: 'web',
    dataState: 'final',
    dimensionFilterGroups: WWW_FILTER,
  };

  // Call 3: distinct `www.` pages with an impression, and the catalog subset.
  const pagesKeys = [
    'search.google.www_page.pages_with_impressions_28d',
    'search.google.www_page.catalog_pages_with_impressions_28d',
  ] as const;
  const queriesKey = 'search.google.www_page.queries_28d' as const;
  // The `www_page` call succeeded and Google had no finalised day with data in the
  // window. A 28-day count over that window would be a 0 that means "no data", so
  // calls 3 and 4 are skipped and nothing is written (never a 0 by absence).
  const wwwEmpty = calls.www_daily?.outcome === 'ok' && newestFinalDay === null;
  if (wwwEmpty) {
    mark([...pagesKeys, queriesKey], 'no_data');
  } else {
    const pages = await queryAllPages(
      fetchImpl,
      token.token,
      { ...rolling, dimensions: ['page'] },
      sleep,
    );
    if (!pages.ok) {
      calls.www_pages_28d = { outcome: pages.kind, message: pages.message, rows: 0, written: 0 };
      mark(pagesKeys, 'failed');
    } else {
      const impressed = new Set<string>();
      for (const row of pages.rows) {
        const url = row.keys?.[0];
        if (url && (toCount(row.impressions) ?? 0) > 0) impressed.add(url);
      }
      let n = 0;
      let catalogReadError: string | undefined;
      if (impressed.size === 0) {
        // An empty answer is "no data", never a stored 0.
        mark(pagesKeys, 'no_data');
      } else {
        await upsertSearchMetric(db, rollingEnd, pagesKeys[0], impressed.size, computedAt);
        n = 1;
        metrics[pagesKeys[0]] = 'written';
        // Only the catalog read is caught. The upsert below sits outside the
        // `try`, so a D1 write failure throws like every other write here and
        // the queue retries the run.
        let catalog: ReadonlySet<string> | null = null;
        try {
          catalog = await (deps.catalogUrls ?? (() => catalogUrlSet(db)))();
        } catch (error) {
          // The catalog read failed. The all-pages figure stands. The catalog figure
          // is absent this week rather than guessed. The key reads `failed`, which
          // turns the heartbeat `partial` (searchIngestHadFailures), and the
          // message is kept on the call report for `/admin/system`.
          metrics[pagesKeys[1]] = 'failed';
          catalogReadError = (error instanceof Error ? error.message : String(error)).slice(
            0,
            ERROR_MESSAGE_MAX,
          );
        }
        if (catalog) {
          let inCatalog = 0;
          for (const url of impressed) if (catalog.has(url)) inCatalog++;
          await upsertSearchMetric(db, rollingEnd, pagesKeys[1], inCatalog, computedAt);
          n++;
          metrics[pagesKeys[1]] = 'written';
        }
      }
      calls.www_pages_28d = {
        outcome: 'ok',
        rows: pages.rows.length,
        written: n,
        ...(pages.truncated ? { truncated: true } : {}),
        ...(catalogReadError !== undefined ? { catalogReadError } : {}),
      };
      written += n;
    }

    // Call 4: distinct queries. A lower bound: Google drops rare queries.
    const queries = await queryAllPages(
      fetchImpl,
      token.token,
      { ...rolling, dimensions: ['query'] },
      sleep,
    );
    if (!queries.ok) {
      calls.www_queries_28d = {
        outcome: queries.kind,
        message: queries.message,
        rows: 0,
        written: 0,
      };
      metrics[queriesKey] = 'failed';
    } else {
      const distinct = new Set(queries.rows.map((r) => r.keys?.[0]).filter(Boolean));
      const n = distinct.size > 0 ? 1 : 0;
      if (n > 0) await upsertSearchMetric(db, rollingEnd, queriesKey, distinct.size, computedAt);
      calls.www_queries_28d = {
        outcome: 'ok',
        rows: queries.rows.length,
        written: n,
        ...(queries.truncated ? { truncated: true } : {}),
      };
      metrics[queriesKey] = n > 0 ? 'written' : 'no_data';
      written += n;
    }
  }

  // Call 5: the `www.` sitemap's state. A sample at the run, filed under the
  // run's UTC day like a snapshot stock.
  let sitemap: SearchIngestSitemapState | null = null;
  const list = await listSitemaps(fetchImpl, token.token, opts);
  if (!list.ok) {
    calls.sitemaps = { outcome: list.kind, message: list.message, rows: 0, written: 0 };
    mark(SITEMAP_KEYS, 'failed');
  } else {
    const entry: SitemapEntry | undefined = list.sitemaps.find(
      (s) => s.path === SEARCH_INGEST_WWW_SITEMAP,
    );
    let n = 0;
    if (!entry) {
      mark(SITEMAP_KEYS, 'no_data');
    } else {
      const submittedParts = (entry.contents ?? []).map((c) => toCount(c.submitted));
      const submitted = submittedParts.some((v) => v !== null)
        ? submittedParts.reduce<number>((a, v) => a + (v ?? 0), 0)
        : null;
      const downloadedMs = entry.lastDownloaded ? Date.parse(entry.lastDownloaded) : NaN;
      sitemap = {
        path: SEARCH_INGEST_WWW_SITEMAP,
        lastDownloaded: entry.lastDownloaded ?? null,
        lastSubmitted: entry.lastSubmitted ?? null,
        isPending: typeof entry.isPending === 'boolean' ? entry.isPending : null,
        errors: toCount(entry.errors),
        warnings: toCount(entry.warnings),
        submitted,
      };
      const runDay = computedAt.slice(0, 10);
      const values: Record<(typeof SITEMAP_KEYS)[number], number | null> = {
        'search.google.www_sitemap.urls_submitted': submitted,
        'search.google.www_sitemap.errors': sitemap.errors,
        'search.google.www_sitemap.warnings': sitemap.warnings,
        'search.google.www_sitemap.download_age_days': Number.isFinite(downloadedMs)
          ? Math.max(0, (startedAt.getTime() - downloadedMs) / 86_400_000)
          : null,
      };
      for (const key of SITEMAP_KEYS) {
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
    calls.sitemaps = { outcome: 'ok', rows: list.sitemaps.length, written: n };
    written += n;
  }

  // Failed only when the credential is refused everywhere: an operator must act.
  const reports = Object.values(calls);
  const allAuth = reports.length > 0 && reports.every((c) => c.outcome === 'auth');
  return {
    outcome: allAuth ? 'failed' : 'ok',
    ...(allAuth ? { reason: 'google_refused_credential' } : {}),
    window: {
      daily: { start: dailyStart, end: dailyEnd },
      rolling: { start: rollingStart, end: rollingEnd },
    },
    calls,
    metrics,
    sitemap,
    written,
  };
}

/**
 * Whether anything failed, for the heartbeat's `partial` outcome: a call, or a
 * key whose call succeeded but which still could not be written. The catalog
 * figure is that case: its call is `ok` when only the catalog URL read failed.
 */
export function searchIngestHadFailures(result: GoogleSearchIngestResult): boolean {
  return (
    Object.values(result.calls).some((c) => c.outcome !== 'ok') ||
    Object.values(result.metrics).some((m) => m === 'failed')
  );
}

/** The keys whose outcome is `failed`, for the `partial` log line. */
export function searchIngestFailedKeys(result: {
  metrics: Partial<Record<string, SearchIngestKeyOutcome>>;
}): string[] {
  return Object.entries(result.metrics)
    .filter(([, m]) => m === 'failed')
    .map(([k]) => k);
}

/** Every Google key this module can write. A test pins it to the shared list. */
export const SEARCH_INGEST_WRITTEN_KEYS: readonly SearchIngestGoogleMetricKey[] = [
  ...Object.values(DAILY_KEYS.www),
  ...Object.values(DAILY_KEYS.property),
  'search.google.www_page.pages_with_impressions_28d',
  'search.google.www_page.catalog_pages_with_impressions_28d',
  'search.google.www_page.queries_28d',
  ...SITEMAP_KEYS,
];
