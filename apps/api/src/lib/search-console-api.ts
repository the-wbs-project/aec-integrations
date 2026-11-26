/**
 * Search Console read transport: Search Analytics and Sitemaps (AECI-820,
 * `ADMIN_PANEL_SPEC.md` §5.24.10).
 *
 * Two calls, both read-only under the `webmasters.readonly` scope the URL
 * Inspection run already holds (`./google-service-account`):
 *
 *   - `POST {base}/sites/{siteUrl}/searchAnalytics/query`, Google's
 *     `searchanalytics.query`. Dates are Pacific Time, inclusive.
 *   - `GET {base}/sites/{siteUrl}/sitemaps`, Google's `sitemaps.list`. The
 *     response's top-level key is `sitemap`.
 *
 * Both paths and the `www.googleapis.com/webmasters/v3` base are the ones
 * Google's reference pages give. The `siteUrl` is URL-encoded in the path.
 *
 * Pure apart from the injected `fetchImpl` and `sleep`, and **never throws**:
 * every failure is a structured result, so one failed call cannot stop the run's
 * other calls. Every response whose body is not read goes through
 * `discardResponseBody`, because a Worker holds about six open connections and an
 * unread body keeps one (CLAUDE.md, the connection-limit rule).
 *
 * Quota: Search Analytics allows 1,200 queries a minute per site. The weekly run
 * makes a handful. A 429 is therefore not retried: it means something else spent
 * the quota, and a retry would only spend more.
 */

import { discardResponseBody } from '@aeci/shared/response-drain';

import { SEARCH_CONSOLE_SITE } from './google-service-account';

export const SEARCH_CONSOLE_API_BASE = 'https://www.googleapis.com/webmasters/v3';

/** Waits before the 2nd and 3rd attempt on a 5xx or a dropped connection. */
export const SEARCH_CONSOLE_RETRY_DELAYS_MS = [2_000, 5_000] as const;

export type SearchConsoleErrorKind =
  /** 429. The quota is spent. Not retried. */
  | 'quota'
  /** 401 / 403. The key is wrong or lost access to the property. */
  | 'auth'
  /** 5xx, a dropped connection or an unreadable body, still failing after the retries. */
  | 'transient'
  /** Any other 4xx, e.g. a malformed request. */
  | 'rejected';

export type SearchConsoleFailure = { ok: false; kind: SearchConsoleErrorKind; message: string };

/** One `searchanalytics.query` row. `keys` follow the request's `dimensions`. */
export interface SearchAnalyticsRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

/** The request body fields this module sends. Google's names, verbatim. */
export interface SearchAnalyticsQuery {
  startDate: string;
  endDate: string;
  dimensions?: ('date' | 'page' | 'query')[];
  type?: 'web';
  dimensionFilterGroups?: {
    groupType: 'and';
    filters: {
      dimension: 'page' | 'query';
      operator: 'includingRegex' | 'equals' | 'contains';
      expression: string;
    }[];
  }[];
  aggregationType?: 'auto' | 'byPage' | 'byProperty';
  rowLimit?: number;
  startRow?: number;
  dataState?: 'final' | 'all';
}

export type SearchAnalyticsResult =
  | { ok: true; rows: SearchAnalyticsRow[]; aggregation: string | null }
  | SearchConsoleFailure;

/** One `sitemaps` resource, as the list returns it. Google types the counts as
 *  `long`, which its JSON APIs encode as strings, so they are parsed with
 *  {@link toCount}. */
export interface SitemapEntry {
  path?: string;
  lastSubmitted?: string;
  lastDownloaded?: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  type?: string;
  warnings?: string | number;
  errors?: string | number;
  contents?: { type?: string; submitted?: string | number }[];
}

export type SitemapListResult = { ok: true; sitemaps: SitemapEntry[] } | SearchConsoleFailure;

interface CallOpts {
  site?: string;
  base?: string;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A Google `long` (string or number) as a finite number, or null. */
export function toCount(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function siteUrl(base: string, site: string): string {
  return `${base}/sites/${encodeURIComponent(site)}`;
}

/**
 * One request with the inspection transport's retry shape: retry a 5xx, a
 * dropped connection or an unreadable body; return any 4xx at once. `parse` reads
 * the 200 body. Every non-200 body is discarded.
 */
async function call<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  parse: (body: unknown) => T,
  sleep: (ms: number) => Promise<void>,
): Promise<{ ok: true; value: T } | SearchConsoleFailure> {
  let last: SearchConsoleFailure = { ok: false, kind: 'transient', message: 'not_attempted' };
  for (let attempt = 0; attempt <= SEARCH_CONSOLE_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(SEARCH_CONSOLE_RETRY_DELAYS_MS[attempt - 1]!);
    let res: Response;
    try {
      res = await fetchImpl(url, init);
    } catch (error) {
      last = {
        ok: false,
        kind: 'transient',
        message: error instanceof Error ? error.message : 'network_error',
      };
      continue;
    }
    if (res.ok) {
      try {
        return { ok: true, value: parse(await res.json()) };
      } catch {
        last = { ok: false, kind: 'transient', message: 'unparseable_body' };
        continue;
      }
    }
    discardResponseBody(res);
    const message = `http_${res.status}`;
    if (res.status === 429) return { ok: false, kind: 'quota', message };
    if (res.status === 401 || res.status === 403) return { ok: false, kind: 'auth', message };
    if (res.status < 500) return { ok: false, kind: 'rejected', message };
    last = { ok: false, kind: 'transient', message };
  }
  return last;
}

/** `searchanalytics.query`, one page of rows. The caller pages with `startRow`. */
export async function querySearchAnalytics(
  fetchImpl: typeof fetch,
  token: string,
  query: SearchAnalyticsQuery,
  opts: CallOpts = {},
): Promise<SearchAnalyticsResult> {
  const { site = SEARCH_CONSOLE_SITE, base = SEARCH_CONSOLE_API_BASE, sleep = realSleep } = opts;
  const result = await call(
    fetchImpl,
    `${siteUrl(base, site)}/searchAnalytics/query`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(query),
    },
    (body) => {
      const b = (body ?? {}) as { rows?: unknown; responseAggregationType?: unknown };
      return {
        // No `rows` key is Google's answer for "no data in the window".
        rows: Array.isArray(b.rows) ? (b.rows as SearchAnalyticsRow[]) : [],
        aggregation:
          typeof b.responseAggregationType === 'string' ? b.responseAggregationType : null,
      };
    },
    sleep,
  );
  return result.ok ? { ok: true, ...result.value } : result;
}

/** `sitemaps.list` for the property. */
export async function listSitemaps(
  fetchImpl: typeof fetch,
  token: string,
  opts: CallOpts = {},
): Promise<SitemapListResult> {
  const { site = SEARCH_CONSOLE_SITE, base = SEARCH_CONSOLE_API_BASE, sleep = realSleep } = opts;
  const result = await call(
    fetchImpl,
    `${siteUrl(base, site)}/sitemaps`,
    { method: 'GET', headers: { authorization: `Bearer ${token}` } },
    (body) => {
      const b = (body ?? {}) as { sitemap?: unknown };
      return Array.isArray(b.sitemap) ? (b.sitemap as SitemapEntry[]) : [];
    },
    sleep,
  );
  return result.ok ? { ok: true, sitemaps: result.value } : result;
}
