/**
 * Search Console URL Inspection transport and the close/tag decision (AECI-1236,
 * §20.2, ADR 0031's 2026-10-05 amendment).
 *
 * The URL Inspection API is **read-only**. It answers "what does Google's index
 * hold for this URL", with `verdict`, `coverageState`, `pageFetchState` and
 * `lastCrawlTime`. It cannot request indexing: that is still a person in Search
 * Console (AECI-747). The daily job (`gsc-inspect-job.ts`) uses the answer to
 * close worklist rows Google has already re-crawled and to tag the rest.
 *
 * Pure apart from the injected `fetchImpl` and `sleep`, and never throws: every
 * failure is a structured result, so one bad URL cannot end a run.
 *
 * Quota (Google's published limits, per property): 2,000 calls a day and 600 a
 * minute. A 429 is NOT retried here. Inside one run a 429 almost always means
 * the daily quota is spent, and retrying would only burn the run's wall time,
 * so the caller halts on it instead.
 */

import { discardResponseBody } from '@aeci/shared/response-drain';

import { SEARCH_CONSOLE_READONLY_SCOPE, SEARCH_CONSOLE_SITE } from './google-service-account';

// The service account and token exchange moved to `./google-service-account` when
// the weekly search ingest became a second reader (AECI-820). Re-exported so the
// inspection run and its specs keep one import site.
export {
  GOOGLE_TOKEN_ENDPOINT,
  getGoogleAccessToken,
  parseServiceAccount,
  SEARCH_CONSOLE_SITE,
  type GoogleServiceAccount,
  type TokenFailureKind,
  type TokenResult,
} from './google-service-account';

export const URL_INSPECTION_ENDPOINT =
  'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
/** Read-only. The service account can inspect, never change the property. The
 *  scope is shared with the search ingest; this name is kept for its readers. */
export const URL_INSPECTION_SCOPE = SEARCH_CONSOLE_READONLY_SCOPE;

/** Waits before the 2nd and 3rd attempt on a 5xx or a dropped connection. */
export const INSPECT_RETRY_DELAYS_MS = [2_000, 5_000] as const;

/** The fields of `inspectionResult.indexStatusResult` this module reads. */
export interface IndexStatus {
  verdict?: string;
  coverageState?: string;
  pageFetchState?: string;
  indexingState?: string;
  lastCrawlTime?: string;
}

export type InspectErrorKind =
  /** 429. Treated as "the daily quota is spent": the run halts. */
  | 'quota'
  /** 401 / 403. The key is wrong or lost access to the property: the run halts. */
  | 'auth'
  /** 5xx or a dropped connection, still failing after the retries. */
  | 'transient'
  /** Any other 4xx, e.g. a URL outside the property. */
  | 'rejected';

export type InspectResult =
  | { ok: true; status: IndexStatus }
  | { ok: false; kind: InspectErrorKind; message: string };

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function inspectUrl(
  fetchImpl: typeof fetch,
  token: string,
  url: string,
  opts: { site?: string; endpoint?: string; sleep?: (ms: number) => Promise<void> } = {},
): Promise<InspectResult> {
  const {
    site = SEARCH_CONSOLE_SITE,
    endpoint = URL_INSPECTION_ENDPOINT,
    sleep = realSleep,
  } = opts;
  let last: InspectResult = { ok: false, kind: 'transient', message: 'not_attempted' };
  for (let attempt = 0; attempt <= INSPECT_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(INSPECT_RETRY_DELAYS_MS[attempt - 1]!);
    let res: Response;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ inspectionUrl: url, siteUrl: site }),
      });
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
        const body = (await res.json()) as {
          inspectionResult?: { indexStatusResult?: IndexStatus };
        };
        return { ok: true, status: body.inspectionResult?.indexStatusResult ?? {} };
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

/** Why a row still needs a person, from one inspection. Stored in `inspect_reason`. */
export const GSC_INSPECT_REASONS = [
  /** Indexed, but Google's last crawl came before the page's last change. */
  'crawl_predates_change',
  'unknown_to_google',
  'discovered_not_indexed',
  'crawled_not_indexed',
  /** Google saw a `noindex`. A request helps once the page is indexable. */
  'excluded_noindex',
  /** Google saw a redirect at this URL. */
  'page_with_redirect',
  /** Google's fetch failed: 404, soft 404, server error, blocked. Never closed (ADR 0030). */
  'page_fetch_failed',
  'not_indexed_other',
] as const;
export type GscInspectReason = (typeof GSC_INSPECT_REASONS)[number];

export type InspectDecision = { action: 'close' } | { action: 'tag'; reason: GscInspectReason };

/** `pageFetchState` values that mean Google's fetch did not succeed. */
const FETCH_FAILED = new Set([
  'SOFT_404',
  'BLOCKED_ROBOTS_TXT',
  'NOT_FOUND',
  'ACCESS_DENIED',
  'SERVER_ERROR',
  'REDIRECT_ERROR',
  'ACCESS_FORBIDDEN',
  'BLOCKED_4XX',
  'INTERNAL_CRAWL_ERROR',
  'INVALID_URL',
]);

/**
 * Close or tag one row.
 *
 * **Close only when Google reports the page indexed (`PASS`) AND its last crawl is
 * strictly after `changedAt`.** `changedAt` is `last_changed_at`, falling back to
 * `queued_at` for a row written before migration 0064. It must not be `queued_at`
 * alone: a re-enqueue leaves `queued_at` untouched (ADR 0031 §4), so a page edited
 * again after Google's crawl would look done.
 *
 * A failed fetch is tagged, never closed. A 404 says the page is gone *to Google*;
 * it is not our evidence that nobody needs the row (ADR 0030: never infer a delete
 * from absence).
 */
export function decideInspection(status: IndexStatus, changedAt: string): InspectDecision {
  const crawl = status.lastCrawlTime ? Date.parse(status.lastCrawlTime) : NaN;
  const changed = Date.parse(changedAt);
  if (status.verdict === 'PASS' && Number.isFinite(crawl) && crawl > changed) {
    return { action: 'close' };
  }
  if (status.pageFetchState && FETCH_FAILED.has(status.pageFetchState)) {
    return { action: 'tag', reason: 'page_fetch_failed' };
  }
  if (status.verdict === 'PASS') return { action: 'tag', reason: 'crawl_predates_change' };
  if (
    status.indexingState === 'BLOCKED_BY_META_TAG' ||
    status.indexingState === 'BLOCKED_BY_HTTP_HEADER'
  ) {
    return { action: 'tag', reason: 'excluded_noindex' };
  }
  const coverage = (status.coverageState ?? '').toLowerCase();
  if (coverage.includes('redirect')) return { action: 'tag', reason: 'page_with_redirect' };
  if (coverage.includes('unknown to google')) return { action: 'tag', reason: 'unknown_to_google' };
  if (coverage.startsWith('discovered')) return { action: 'tag', reason: 'discovered_not_indexed' };
  if (coverage.startsWith('crawled')) return { action: 'tag', reason: 'crawled_not_indexed' };
  if (coverage.includes('noindex')) return { action: 'tag', reason: 'excluded_noindex' };
  return { action: 'tag', reason: 'not_indexed_other' };
}
