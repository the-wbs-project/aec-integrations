/**
 * Bing Webmaster Tools read transport (AECI-821, `ADMIN_PANEL_SPEC.md` §5.24.10).
 *
 * Three read methods of the BWT JSON API, each a `GET` with the site and the key in
 * the query string:
 *
 *   `GET https://ssl.bing.com/webmaster/api.svc/json/{Method}?siteUrl={site}&apikey={key}`
 *
 * | Method | Gives |
 * |---|---|
 * | `GetRankAndTrafficStats` | daily `Clicks` and `Impressions`, every vertical including Chat |
 * | `GetCrawlStats` | daily `InIndex`, `CrawledPages`, `CrawlErrors`, for the last six months |
 * | `GetFeeds` | the site's top-level sitemaps, with `UrlCount` and `LastCrawled` |
 *
 * A 200 body is `{"d":[...]}`. Dates are WCF strings, `/Date(1316156400000-0700)/`:
 * epoch milliseconds, then the offset the server meant. {@link parseBingDate} reads
 * both. The method paths, the body shapes and the date format are Microsoft's
 * reference pages for `IWebmasterApi`.
 *
 * ─── A pure transport, so it can move ───────────────────────────────────────
 *
 * Like `callIndexNow`, this module imports nothing from the Worker runtime. It
 * takes an injected `fetchImpl` and `sleep`, so the same file can run on a GitHub
 * Actions runner if Bing starts refusing the shared Cloudflare egress, the way
 * IndexNow did (AECI-1476). Today the Worker runs it.
 *
 * ─── Errors arrive as HTTP 400 with a JSON body ─────────────────────────────
 *
 * Microsoft documents every API error as `HTTP/1.1 400` with
 * `{"ErrorCode":3,"Message":"InvalidApiKey"}`. So a throttle is not a 429, and a
 * status-only classifier would call a routine throttle a refused key. A 400 body
 * is therefore read, and its `ErrorCode` decides the kind. Every other non-200 body
 * goes through `discardResponseBody`, because a Worker holds about six open
 * connections and an unread body keeps one (CLAUDE.md, the connection-limit rule).
 *
 * ─── The key is in the URL, so the URL is never recorded ────────────────────
 *
 * The API key travels as `?apikey=`, as Microsoft's samples show. Every message this
 * module returns is built from our own vocabulary (`http_400`, `bwt_ThrottleUser`),
 * never from Bing's free-text `Message`. A thrown fetch error is recorded as the
 * fixed code `network_error`, never the runtime's text. So the key cannot reach a
 * log line, a `job_runs` detail or a metric attribute through this module.
 *
 * Cloudflare's own stored traces are a separate question, open as AECI-2075. We do
 * not know whether they record an outbound call's query string, so the lane stays off
 * in production until it is answered (`docs/environments.md`).
 *
 * Never throws. Every failure is a structured result, so one failed call cannot
 * stop the lane's other calls.
 */

import { discardResponseBody } from '@aeci/shared/response-drain';

export const BWT_API_BASE = 'https://ssl.bing.com/webmaster/api.svc/json';

/** Waits before the 2nd and 3rd attempt on a 5xx, a dropped connection, an
 *  unreadable body or a Bing `InternalError` / `UnknownError`. */
export const BWT_RETRY_DELAYS_MS = [2_000, 5_000] as const;

export type BingMethod = 'GetRankAndTrafficStats' | 'GetCrawlStats' | 'GetFeeds';

export type BingErrorKind =
  /** `ThrottleUser` or `ThrottleHost`, or an HTTP 429. Routine. Not retried. */
  | 'throttled'
  /** `InvalidApiKey`, `UserBlocked`, `UserNotFound` or `NotAuthorized`, or an HTTP
   *  401 / 403. The key is wrong, or the site is not the key owner's. */
  | 'auth'
  /** 5xx, a dropped connection, an unreadable body, or Bing's `InternalError` /
   *  `UnknownError`, still failing after the retries. */
  | 'transient'
  /** Any other error code or 4xx, e.g. `InvalidUrl` or `Deprecated`. */
  | 'rejected';

export type BingFailure = {
  ok: false;
  kind: BingErrorKind;
  /** Our vocabulary only. Safe to log. */
  message: string;
  /** Bing's numeric `ErrorCode`, when a 400 body carried one. */
  errorCode?: number;
};

export type BingResult<T> = { ok: true; rows: T[] } | BingFailure;

/** `RankAndTrafficStats`. */
export interface BingTrafficRow {
  Date?: string;
  Clicks?: number;
  Impressions?: number;
}

/** `CrawlStats`. Microsoft lists the fields and describes none of them. */
export interface BingCrawlRow {
  Date?: string;
  InIndex?: number;
  CrawledPages?: number;
  CrawlErrors?: number;
  InLinks?: number;
  Code2xx?: number;
  Code301?: number;
  Code302?: number;
  Code4xx?: number;
  Code5xx?: number;
  AllOtherCodes?: number;
  BlockedByRobotsTxt?: number;
  ContainsMalware?: number;
}

/** `Feed`. */
export interface BingFeedRow {
  Url?: string;
  UrlCount?: number;
  LastCrawled?: string;
  Submitted?: string;
  Status?: string;
  Type?: string;
  Compressed?: boolean;
  FileSize?: number;
}

/**
 * `ApiErrorCode`, Microsoft's enum, by value. Only the codes that change how a
 * call is treated are listed. The rest read as `rejected`.
 */
export const BING_ERROR_CODES: Readonly<Record<number, { name: string; kind: BingErrorKind }>> = {
  1: { name: 'InternalError', kind: 'transient' },
  2: { name: 'UnknownError', kind: 'transient' },
  3: { name: 'InvalidApiKey', kind: 'auth' },
  4: { name: 'ThrottleUser', kind: 'throttled' },
  5: { name: 'ThrottleHost', kind: 'throttled' },
  6: { name: 'UserBlocked', kind: 'auth' },
  7: { name: 'InvalidUrl', kind: 'rejected' },
  8: { name: 'InvalidParameter', kind: 'rejected' },
  10: { name: 'UserNotFound', kind: 'auth' },
  11: { name: 'NotFound', kind: 'rejected' },
  13: { name: 'NotAllowed', kind: 'rejected' },
  14: { name: 'NotAuthorized', kind: 'auth' },
  16: { name: 'Deprecated', kind: 'rejected' },
};

const BY_NAME = new Map(
  Object.entries(BING_ERROR_CODES).map(([code, v]) => [v.name, Number(code)] as const),
);

interface CallOpts {
  base?: string;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The request URL. Holds the key, so it is passed to `fetch` and nowhere else. */
export function bingRequestUrl(
  base: string,
  method: BingMethod,
  siteUrl: string,
  apiKey: string,
): string {
  const qs = new URLSearchParams({ siteUrl, apikey: apiKey });
  return `${base}/${method}?${qs.toString()}`;
}

const WCF_DATE = /^\/Date\((-?\d+)(?:([+-])(\d{2})(\d{2}))?\)\/$/;

/**
 * A WCF JSON date, `/Date(ms)/` or `/Date(ms±hhmm)/`. `ms` is UTC epoch
 * milliseconds. The offset is the zone the server meant the instant in, so
 * `/Date(1316156400000-0700)/` is 2011-09-16 00:00 at UTC-7, the XML sample's
 * `2011-09-16T00:00:00-07:00`. Returns null for anything else.
 */
export function parseBingDate(value: unknown): { ms: number; offsetMinutes: number | null } | null {
  if (typeof value !== 'string') return null;
  const m = value.match(WCF_DATE);
  if (!m) return null;
  const ms = Number(m[1]);
  if (!Number.isSafeInteger(ms)) return null;
  if (!m[2]) return { ms, offsetMinutes: null };
  const minutes = Number(m[3]) * 60 + Number(m[4]);
  return { ms, offsetMinutes: m[2] === '-' ? -minutes : minutes };
}

/** Classify a 400 body. Bing's `ErrorCode` wins; its `Message` name is the fallback. */
function classify400(body: unknown): BingFailure {
  const b = (body ?? {}) as { ErrorCode?: unknown; Message?: unknown };
  let code = typeof b.ErrorCode === 'number' ? b.ErrorCode : undefined;
  if (code === undefined && typeof b.Message === 'string') code = BY_NAME.get(b.Message);
  if (code === undefined) return { ok: false, kind: 'rejected', message: 'http_400' };
  const known = BING_ERROR_CODES[code];
  return known
    ? { ok: false, kind: known.kind, message: `bwt_${known.name}`, errorCode: code }
    : { ok: false, kind: 'rejected', message: `bwt_code_${code}`, errorCode: code };
}

/**
 * One BWT read with the Search Console transport's retry shape: retry a transient
 * failure, return anything else at once. The caller makes calls one at a time.
 * Never throws.
 */
export async function callBingWebmaster<T>(
  fetchImpl: typeof fetch,
  method: BingMethod,
  siteUrl: string,
  apiKey: string,
  opts: CallOpts = {},
): Promise<BingResult<T>> {
  const { base = BWT_API_BASE, sleep = realSleep } = opts;
  const url = bingRequestUrl(base, method, siteUrl, apiKey);
  let last: BingFailure = { ok: false, kind: 'transient', message: 'not_attempted' };
  for (let attempt = 0; attempt <= BWT_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(BWT_RETRY_DELAYS_MS[attempt - 1]!);
    let res: Response;
    try {
      res = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' } });
    } catch {
      // A fixed code, never the runtime's text: that text may quote the request URL,
      // and the URL holds the key.
      last = { ok: false, kind: 'transient', message: 'network_error' };
      continue;
    }
    if (res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        last = { ok: false, kind: 'transient', message: 'unparseable_body' };
        continue;
      }
      const d = (body as { d?: unknown } | null)?.d;
      // A null or absent `d` is an empty answer: zero rows, which the lane reads as
      // `no_data`. Any other non-array is a shape we do not know.
      if (d === null || d === undefined) return { ok: true, rows: [] };
      if (!Array.isArray(d)) return { ok: false, kind: 'rejected', message: 'unexpected_body' };
      return { ok: true, rows: d as T[] };
    }
    if (res.status === 400) {
      // Read, not discarded: the error code is in the body. Reading it releases
      // the connection too.
      const body: unknown = await res.json().catch(() => null);
      const failure = classify400(body);
      if (failure.kind !== 'transient') return failure;
      last = failure;
      continue;
    }
    discardResponseBody(res);
    const message = `http_${res.status}`;
    if (res.status === 429) return { ok: false, kind: 'throttled', message };
    if (res.status === 401 || res.status === 403) return { ok: false, kind: 'auth', message };
    if (res.status < 500) return { ok: false, kind: 'rejected', message };
    last = { ok: false, kind: 'transient', message };
  }
  return last;
}
