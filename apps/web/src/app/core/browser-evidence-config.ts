/**
 * The browser report (AECI-1714, epic AECI-1711): the gates, the ray readers and
 * the transport. `PageViewTracker` posts `ran` and `interacted` through these to
 * `POST /api/page-views/browser-evidence` (AECI-1713).
 *
 * This module is in the initial bundle, so it imports plain constants only. The
 * body schema (`BrowserEvidencePostSchema`) never comes here: a Zod schema in an
 * eager module stays in the bundle (the reason `page-view-browser-evidence.ts` is
 * its own module). `CF_RAY_PATTERN` is the regex that schema applies, so a ray this
 * module accepts is a ray the API accepts.
 *
 * Nothing here writes to the browser: no `localStorage`, `sessionStorage`, cookie
 * or IndexedDB. The report never goes to PostHog (`docs/ANALYTICS.md` §5).
 */
import type { HttpClient } from '@angular/common/http';

import { BROWSER_EVIDENCE_URL, CF_RAY_PATTERN, type BrowserEvidence } from '@aeci/shared';

import { browserSendsPrivacySignal, regionAllowsCollection } from './turnstile-config';

/** The `Server-Timing` entry name the gateway stamps with the request's ray. */
const CF_RAY_TIMING_NAME = 'cfray';

/** One `desc` parameter of a `Server-Timing` metric, quoted or bare. */
const DESC_PARAM = /^desc\s*=\s*"?([^"]*)"?$/i;

/**
 * Whether this page load may send the browser report. All three gates must pass:
 *
 * 1. The tier turned it on. The SSR Worker injects
 *    `window.__AECI_BROWSER_EVIDENCE__ = { enabled: true }` only when the wrangler
 *    var `BROWSER_EVIDENCE_ENABLED` is `"true"` (`browser-evidence-bootstrap-inject.ts`).
 *    Anything other than a literal `true` is off.
 * 2. The browser sends neither GPC nor DNT (`browserSendsPrivacySignal`).
 * 3. The gateway did not stamp `Server-Timing: geo;desc="eu"`, and the browser
 *    exposes `serverTiming` at all (`regionAllowsCollection`, ruling 21).
 *
 * Pure (reads `globalThis`) and platform-blind: the caller adds the browser check.
 */
export function browserEvidenceEnabled(): boolean {
  const g = globalThis as { __AECI_BROWSER_EVIDENCE__?: { enabled?: unknown } | null };
  return (
    g.__AECI_BROWSER_EVIDENCE__?.enabled === true &&
    !browserSendsPrivacySignal() &&
    regionAllowsCollection()
  );
}

/** The ray when it matches the API's pattern, else `null`. */
function validRay(ray: string | null | undefined): string | null {
  return ray && CF_RAY_PATTERN.test(ray) ? ray : null;
}

/**
 * The page load's Ray ID from the gateway's `Server-Timing: cfray` entry on the
 * document (AECI-1330), or `null` when it is absent (local dev, a browser without
 * `serverTiming`) or fails the API's ray pattern. Used by the Turnstile landing
 * verdict and the browser report alike.
 */
export function readLandingCfRay(): string | null {
  const entry = globalThis.performance?.getEntriesByType?.('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined;
  return validRay(entry?.serverTiming?.find((t) => t.name === CF_RAY_TIMING_NAME)?.description);
}

/**
 * The ray in a `Server-Timing` response header, or `null`. The gateway appends
 * `cfray;desc="<ray>"` to the in-app beacon's response (`withGatewayServerTiming`),
 * and the browser joins several header lines with `, `. Local dev sends no `cf-ray`,
 * so the entry is absent there and this returns `null`.
 */
export function cfRayFromServerTiming(header: string | null | undefined): string | null {
  if (!header) return null;
  for (const metric of header.split(',')) {
    const [name, ...params] = metric.split(';').map((part) => part.trim());
    if (name !== CF_RAY_TIMING_NAME) continue;
    for (const param of params) {
      const match = param.match(DESC_PARAM);
      if (match) return validRay(match[1]);
    }
  }
  return null;
}

/**
 * Send the in-app page-view beacon and resolve the ray on its response, or `null`.
 * The gateway stamps `Server-Timing: cfray` on the beacon's response with the ray
 * the API stored on its `browser-spa` row (`CACHE_STRATEGY.md` §4a.1), so that ray
 * names this view's row. A failed request resolves `null`. Never rejects. Shared by
 * the tracker's own post and the lazy Turnstile beacon, so both read it one way.
 */
export function postSpaBeaconRequest(
  http: HttpClient,
  url: string,
  body: object,
): Promise<string | null> {
  return new Promise((resolve) => {
    http.post(url, body, { observe: 'response' }).subscribe({
      next: (res) => resolve(cfRayFromServerTiming(res.headers.get('server-timing'))),
      error: () => resolve(null),
      complete: () => resolve(null),
    });
  });
}

/**
 * Post one report, `{ cf_ray, evidence }`. `keepalive` lets an `interacted` report
 * outlive a page that is closing. Same-origin credentials only. The response body is
 * released unread and every error is swallowed: a 429 from the shared `token`
 * bucket, a 400 or a network failure costs one report, never the page.
 */
export function postBrowserEvidence(cfRay: string, evidence: BrowserEvidence): void {
  try {
    void globalThis
      .fetch(BROWSER_EVIDENCE_URL, {
        method: 'POST',
        keepalive: true,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cf_ray: cfRay, evidence }),
      })
      .then((res) => res.body?.cancel())
      .catch(() => undefined);
  } catch {
    // A missing or throwing `fetch` costs the report, never the page.
  }
}
