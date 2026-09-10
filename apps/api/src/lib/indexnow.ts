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
 * How many times a *retryable* failure is re-sent before the outcome is returned
 * as-is (AECI-826). Two, so such a request is attempted at most three times.
 *
 * **What counts as retryable is decided by {@link isRetryableStatus}, and a bare
 * 429 does not (AECI-833).** This constant is therefore the ceiling on a 5xx, a
 * transport error, or a 429 that named a usable `Retry-After` — never on a bare
 * rate limit. See that function for why the two are governed by different rules.
 */
export const INDEXNOW_MAX_RETRIES = 2;

/** Backoff before retry N (1-indexed), in ms, when the response carries no usable
 *  `Retry-After`. Deliberately short and finite: the drain cron is the long
 *  backoff, so all this has to survive is a momentary aggregator fault. Since
 *  AECI-833 a bare 429 never reaches this schedule at all. */
const INDEXNOW_RETRY_DELAYS_MS = [1_000, 4_000];

/** Ceiling on an upstream-supplied `Retry-After`. IndexNow may name a window far
 *  longer than a cron tick; waiting it out inside the Worker would burn the
 *  invocation for a submission the next tick retries anyway. Past this we return
 *  the failure and let the buffer hold the URLs.
 *
 *  Since AECI-833 this cap is load-bearing on the 429 path rather than merely
 *  protective: an over-cap `Retry-After` makes {@link retryAfterMs} return
 *  `undefined`, which makes the 429 unretryable, so the tick costs one request. */
const INDEXNOW_MAX_RETRY_AFTER_MS = 10_000;

/**
 * Whether this failure is worth re-sending. **429 and 5xx are governed by
 * different rules, and conflating them was AECI-833.**
 *
 * - **5xx** — an aggregator fault, transient by nature and unrelated to how often
 *   we call. Retried blind on the {@link INDEXNOW_RETRY_DELAYS_MS} schedule, as is
 *   a thrown transport error (DNS, TLS, connection reset).
 * - **429** — a rate limit. Re-sending inside the same window is the exact
 *   behaviour the `indexnow_queue` buffer exists to remove, and it is the reason
 *   ADR 0025 declined a Cloudflare Queue. So a 429 is retried **only** when the
 *   response carries a usable `Retry-After`, i.e. only when IndexNow itself named
 *   a time to come back. A bare 429 is returned on the first attempt and the next
 *   twenty-minute drain tick is the backoff.
 * - **any other 4xx** — a bad key, a host mismatch, a malformed body. A defect a
 *   retry cannot fix.
 *
 * This is what makes the drain's documented ceiling honest. Before the gate every
 * tick under a sustained throttle spent three guaranteed-failing requests against
 * the limiter we were waiting on; production measured exactly that on its first
 * real tick (`attempts: 3`, 2026-09-09 08:20:11 UTC).
 */
function isRetryableStatus(status: number, retryAfter: number | undefined): boolean {
  if (status === 429) return retryAfter !== undefined;
  return status >= 500 && status < 600;
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
 * Retries a 5xx, a transport error, and a 429 that names a capped `Retry-After`,
 * up to {@link INDEXNOW_MAX_RETRIES} times. **A bare 429 is not retried** — see
 * {@link isRetryableStatus} (AECI-826, gated by AECI-833). Every attempt's body is consumed or discarded
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
      if (!isRetryableStatus(res.status, retryAfter)) return last;
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
