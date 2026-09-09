/**
 * IndexNow submission transport (AECI-236).
 *
 * The one outbound call that tells IndexNow which URLs changed:
 * `POST https://api.indexnow.org/indexnow` with a
 * `{ host, key, keyLocation, urlList }` JSON body. The aggregator endpoint fans
 * the submission out to every participating engine (Bing, Yandex, Seznam, Naver),
 * so a single call covers them all.
 *
 * A *pure transport* (same shape as the shared Algolia batch client): never
 * throws — a network error or non-2xx upstream is returned as a
 * structured `{ ok: false }` outcome so the caller can log it without a try/catch
 * and the write is never blocked (§20.2 acceptance criterion). It lives in the API
 * Worker (not `@aeci/shared`) because both call sites are here: the twenty-minute
 * drain cron (`lib/indexnow-drain.ts`, AECI-826) and the `ops:submit-trade-urls`
 * script. The SSR Worker only *serves* the key-verification file, it never submits.
 *
 * **Since AECI-826 the promote does NOT call this.** It appends URLs to
 * `indexnow_queue` and the drain cron submits them in one batched request. Calling
 * this directly from a per-write path is what produced twenty-three consecutive
 * HTTP 429s in production; if you are adding a new caller, buffer instead.
 *
 * `fetchImpl` is injected (defaults to the global `fetch`) so tests can supply a
 * mock without monkey-patching the global.
 */

import { discardResponseBody } from '@aeci/shared/response-drain';

/** IndexNow aggregator endpoint — fans out to all participating engines. */
export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

/**
 * IndexNow accepts up to 10,000 URLs per request. A single promote produces a
 * handful, so we never approach this — the array body IS the "batch" (AECI-236).
 * The slice is a defensive guard, never a real truncation.
 */
export const INDEXNOW_MAX_URLS = 10_000;

export type IndexNowOutcome =
  | { ok: true; status: number; attempts: number }
  | { ok: false; status: number; message: string; attempts: number };

/**
 * How many times a throttled or upstream-failed submission is re-sent before the
 * outcome is returned as-is (AECI-826). Two, so a request is attempted at most
 * three times.
 *
 * This handles an ISOLATED 429. It is explicitly NOT the fix for the burst that
 * produced twenty-three consecutive 429s in production — that is the
 * `indexnow_queue` buffer plus the twenty-minute drain cron, because a retry
 * inside the same rate-limit window is just a fourth request that also fails.
 * Both exist; neither replaces the other.
 */
export const INDEXNOW_MAX_RETRIES = 2;

/** Backoff before retry N (1-indexed), in ms, when the response carries no usable
 *  `Retry-After`. Deliberately short and finite: the drain cron is the long
 *  backoff, so all this has to survive is a momentary throttle. */
const INDEXNOW_RETRY_DELAYS_MS = [1_000, 4_000];

/** Ceiling on an upstream-supplied `Retry-After`. IndexNow may name a window far
 *  longer than a cron tick; waiting it out inside the Worker would burn the
 *  invocation for a submission the next tick retries anyway. Past this we return
 *  the failure and let the buffer hold the URLs. */
const INDEXNOW_MAX_RETRY_AFTER_MS = 10_000;

/** Status codes worth re-sending: the rate limit itself, and any upstream 5xx.
 *  A 4xx that is not 429 (a bad key, a host mismatch, a malformed body) is a
 *  defect that a retry cannot fix, so it is returned on the first attempt. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * `Retry-After` in ms, or `undefined` when absent, unparseable, or beyond
 * {@link INDEXNOW_MAX_RETRY_AFTER_MS}. Accepts both RFC 9110 forms — delta
 * seconds and an HTTP date.
 */
export function retryAfterMs(header: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;
  const seconds = Number(trimmed);
  const ms = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(trimmed) - now;
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return ms > INDEXNOW_MAX_RETRY_AFTER_MS ? undefined : ms;
}

export type IndexNowSubmission = {
  /**
   * The bare hostname the URLs live on (e.g. `aecintegrations.com`) — NOT a
   * scheme-qualified URL. A full URL here is a common IndexNow `422` cause.
   */
  host: string;
  /** The IndexNow key — also the contents of the `{key}.txt` verification file. */
  key: string;
  /** Absolute URL of the verification file (`https://{host}/{key}.txt`). */
  keyLocation: string;
  /** The affected URLs to submit. Must all be on `host`. */
  urlList: string[];
  /** Override the aggregator endpoint (tests). */
  endpoint?: string;
  /** Injected sleep for the retry backoff, so tests neither wait nor
   *  monkey-patch timers. Defaults to a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected clock, used only to turn an HTTP-date `Retry-After` into a delay. */
  now?: () => number;
};

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Submit `urlList` to IndexNow. Never throws; returns a structured outcome.
 * No-ops to a structured `{ ok: false }` (without calling fetch) when the key /
 * host is absent or the URL list is empty.
 *
 * Retries a 429 or a 5xx up to {@link INDEXNOW_MAX_RETRIES} times, honouring a
 * capped `Retry-After` (AECI-826). Every attempt's body is consumed or discarded
 * before the next one starts, so a retry loop cannot accumulate held connections
 * — the AECI-666 failure mode, which a retry is exactly the kind of change that
 * would reintroduce.
 */
export async function callIndexNow(
  fetchImpl: typeof fetch,
  submission: IndexNowSubmission,
): Promise<IndexNowOutcome> {
  const {
    host,
    key,
    keyLocation,
    urlList,
    endpoint = INDEXNOW_ENDPOINT,
    sleep = realSleep,
    now = Date.now,
  } = submission;
  if (!host || !key) {
    return { ok: false, status: 0, message: 'indexnow_config_missing', attempts: 0 };
  }
  if (urlList.length === 0) {
    return { ok: false, status: 0, message: 'indexnow_no_urls', attempts: 0 };
  }

  const body = JSON.stringify({
    host,
    key,
    keyLocation,
    urlList: urlList.slice(0, INDEXNOW_MAX_URLS),
  });

  let last: IndexNowOutcome = { ok: false, status: 0, message: 'indexnow_no_attempt', attempts: 0 };
  for (let attempt = 1; attempt <= INDEXNOW_MAX_RETRIES + 1; attempt++) {
    let retryAfter: number | undefined;
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body,
      });
      // IndexNow returns 200 (accepted) or 202 (received, pending validation) on
      // success — both are `res.ok`.
      if (res.ok) {
        // Success carries nothing we read; release the connection (AECI-666).
        discardResponseBody(res);
        return { ok: true, status: res.status, attempts: attempt };
      }
      retryAfter = retryAfterMs(res.headers.get('retry-after'), now());
      let message = res.statusText || 'indexnow_failed';
      try {
        // Reading the body also releases the connection (AECI-666) — every
        // non-ok path here must either read or discard before looping.
        const text = (await res.text()).trim();
        if (text) message = text;
      } catch {
        // Body unreadable; statusText is good enough, but the connection still
        // has to go back.
        discardResponseBody(res);
      }
      last = { ok: false, status: res.status, message, attempts: attempt };
      if (!isRetryableStatus(res.status)) return last;
    } catch (error) {
      // A transport-level failure (DNS, TLS, connection reset). Retried on the
      // same schedule as a 5xx: it is the same class of transient.
      last = {
        ok: false,
        status: 0,
        message: error instanceof Error ? error.message : 'indexnow_network_error',
        attempts: attempt,
      };
    }
    if (attempt > INDEXNOW_MAX_RETRIES) break;
    await sleep(retryAfter ?? INDEXNOW_RETRY_DELAYS_MS[attempt - 1] ?? 0);
  }
  return last;
}
