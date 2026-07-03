/**
 * IndexNow submission transport (AECI-236).
 *
 * The one outbound call that tells IndexNow which URLs changed:
 * `POST https://api.indexnow.org/indexnow` with a
 * `{ host, key, keyLocation, urlList }` JSON body. The aggregator endpoint fans
 * the submission out to every participating engine (Bing, Yandex, Seznam, Naver),
 * so a single call covers them all.
 *
 * Shaped like `callCloudflarePurge` (`@aeci/shared/cache-purge`): *pure
 * transport*, never throws — a network error or non-2xx upstream is returned as a
 * structured `{ ok: false }` outcome so the post-promote caller can log it without
 * a try/catch and the write is never blocked (§20.2 acceptance criterion). It
 * lives in the API Worker (not `@aeci/shared`) because there is exactly one call
 * site — the SSR Worker only *serves* the key-verification file, it never submits.
 *
 * `fetchImpl` is injected (defaults to the global `fetch`) so tests can supply a
 * mock without monkey-patching the global.
 */

/** IndexNow aggregator endpoint — fans out to all participating engines. */
export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

/**
 * IndexNow accepts up to 10,000 URLs per request. A single promote produces a
 * handful, so we never approach this — the array body IS the "batch" (AECI-236).
 * The slice is a defensive guard, never a real truncation.
 */
export const INDEXNOW_MAX_URLS = 10_000;

export type IndexNowOutcome =
  | { ok: true; status: number }
  | { ok: false; status: number; message: string };

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
};

/**
 * Submit `urlList` to IndexNow. Never throws; returns a structured outcome.
 * No-ops to a structured `{ ok: false }` (without calling fetch) when the key /
 * host is absent or the URL list is empty.
 */
export async function callIndexNow(
  fetchImpl: typeof fetch,
  submission: IndexNowSubmission,
): Promise<IndexNowOutcome> {
  const { host, key, keyLocation, urlList, endpoint = INDEXNOW_ENDPOINT } = submission;
  if (!host || !key) {
    return { ok: false, status: 0, message: 'indexnow_config_missing' };
  }
  if (urlList.length === 0) {
    return { ok: false, status: 0, message: 'indexnow_no_urls' };
  }
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host,
        key,
        keyLocation,
        urlList: urlList.slice(0, INDEXNOW_MAX_URLS),
      }),
    });
    // IndexNow returns 200 (accepted) or 202 (received, pending validation) on
    // success — both are `res.ok`.
    if (res.ok) return { ok: true, status: res.status };
    let message = res.statusText || 'indexnow_failed';
    try {
      const body = (await res.text()).trim();
      if (body) message = body;
    } catch {
      // Body unreadable; statusText is good enough.
    }
    return { ok: false, status: res.status, message };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      message: error instanceof Error ? error.message : 'indexnow_network_error',
    };
  }
}
