// ---------------------------------------------------------------------------
// HTML fetch helpers used by Tier 2 evidence pre-fetch and Tier 4 URL
// verification. Modeled on services/feeds.ts:fetchFeed — same browser UA +
// timeout + abort pattern, just with an HTML Accept header.
//
// Failures resolve to null/error variants rather than throwing so the
// research workflow can fan out across many candidate URLs in parallel
// without a single 404 sinking the whole pre-fetch step.
// ---------------------------------------------------------------------------

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const HTML_HEADERS: Record<string, string> = {
  'User-Agent': BROWSER_UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export interface FetchedHtml {
  url: string;
  finalUrl: string;
  status: number;
  body: string;
}

/**
 * Fetch an HTML page with a browser UA and 8s timeout. Returns null on
 * network failure or non-2xx status — the caller treats that as "no
 * evidence here, move on".
 */
export async function fetchHtml(url: string, timeoutMs = 8_000): Promise<FetchedHtml | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: HTML_HEADERS,
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const body = await res.text();
    return { url, finalUrl: res.url, status: res.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export type UrlVerificationReason =
  | 'not_found'
  | 'parked'
  | 'redirect_to_other_brand'
  | 'fetch_error';

export interface UrlVerification {
  ok: boolean;
  finalUrl: string;
  status: number;
  reason?: UrlVerificationReason;
}

const PARKED_DOMAIN_KEYWORDS = [
  'domain for sale',
  'buy this domain',
  'this domain is for sale',
  'domain is parked',
  'parked domain',
  'godaddy.com/domain',
];

/**
 * Verify a URL is alive and points at real content (not a 4xx/5xx or a parked
 * domain page). Returns the canonical resolved URL after redirects so
 * Airtable can be normalized to e.g. https://www.acme.com/ instead of
 * http://acme.com.
 */
export async function verifyUrl(url: string, timeoutMs = 8_000): Promise<UrlVerification> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // Most CDNs answer HEAD; some reject it. Try HEAD then fall back to GET.
    let res = await fetch(url, {
      method: 'HEAD',
      signal: ctrl.signal,
      headers: HTML_HEADERS,
      redirect: 'follow',
    }).catch(() => null);
    if (!res || res.status === 405 || res.status === 501) {
      res = await fetch(url, {
        signal: ctrl.signal,
        headers: HTML_HEADERS,
        redirect: 'follow',
      }).catch(() => null);
    }
    if (!res) {
      return { ok: false, finalUrl: url, status: 0, reason: 'fetch_error' };
    }
    if (res.status >= 400) {
      return {
        ok: false,
        finalUrl: res.url || url,
        status: res.status,
        reason: 'not_found',
      };
    }
    // Parked-domain detection: GET a small slice of the body and look for
    // common landing-page signatures. HEAD responses don't carry a body so
    // we issue a follow-up GET only when we haven't already.
    let body = '';
    if (res.body) {
      try {
        body = await res.text();
      } catch {
        body = '';
      }
    }
    if (!body) {
      const get = await fetch(res.url || url, {
        signal: ctrl.signal,
        headers: HTML_HEADERS,
        redirect: 'follow',
      }).catch(() => null);
      if (get) body = await get.text().catch(() => '');
    }
    const lower = body.toLowerCase();
    if (
      lower.length < 500 ||
      PARKED_DOMAIN_KEYWORDS.some((kw) => lower.includes(kw))
    ) {
      // Short bodies or parked-domain keywords flag the URL as unusable.
      // Heuristic, not perfect — see Tier 4 verification tests.
      const isShort = lower.length < 500;
      const reason: UrlVerificationReason = isShort ? 'not_found' : 'parked';
      return {
        ok: false,
        finalUrl: res.url || url,
        status: res.status,
        reason,
      };
    }
    return { ok: true, finalUrl: res.url || url, status: res.status };
  } catch {
    return { ok: false, finalUrl: url, status: 0, reason: 'fetch_error' };
  } finally {
    clearTimeout(t);
  }
}
