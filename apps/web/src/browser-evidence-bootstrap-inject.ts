/**
 * Injects the browser-report switch into the SSR HTML response (AECI-1714, epic
 * AECI-1711).
 *
 * `PageViewTracker` posts `ran` and `interacted` (`app/core/browser-evidence-config.ts`)
 * only when the page carries `window.__AECI_BROWSER_EVIDENCE__ = { enabled: true }`.
 * The switch is the per-tier wrangler var `BROWSER_EVIDENCE_ENABLED`: `"true"` turns
 * it on, anything else (including unset) leaves the page without the script, so the
 * tracker sends nothing. Production ships `"false"` until Privacy Policy 1.1 is in
 * force (AECI-1715). A sibling of `window.__AECI_TURNSTILE__` rather than a field on
 * it, because that object exists only on a tier with a Turnstile site key.
 *
 * Caching note: like `turnstile-bootstrap-inject.ts`, this runs in `Renderer`, so the
 * script is stored with the page. That is safe because the value depends ONLY on the
 * deployment env, never on the visitor, and each env and Worker version is its own
 * cache namespace (`CACHE_STRATEGY.md` §4a), so flipping the var, which takes a
 * deploy, never serves a page carrying the old value. Whether a given visitor sends
 * the report (DNT / GPC, the `Server-Timing: geo` stamp) is decided in the browser.
 */

import type { BrowserEvidencePublicConfig, WebEnv } from './env';

const HEAD_CLOSE = '</head>';

/**
 * Builds the value assigned to `window.__AECI_BROWSER_EVIDENCE__`, or `null` when
 * the tier has not turned the report on.
 */
export function buildBrowserEvidencePublicConfig(env: WebEnv): BrowserEvidencePublicConfig | null {
  return env.BROWSER_EVIDENCE_ENABLED === 'true' ? { enabled: true } : null;
}

/** Builds the bootstrap `<script>`, or `null` when the report is off on this tier. */
export function buildBrowserEvidenceBootstrapScript(env: WebEnv): string | null {
  const cfg = buildBrowserEvidencePublicConfig(env);
  if (!cfg) return null;
  return `<script>window.__AECI_BROWSER_EVIDENCE__=${JSON.stringify(cfg)};</script>`;
}

/**
 * Splices the bootstrap `<script>` into a rendered HTML response just before
 * `</head>`. Returns the original response untouched when the report is off, the
 * response is not `text/html`, the status is outside 2xx, or the HTML has no
 * `</head>`.
 */
export async function injectBrowserEvidenceBootstrap(
  response: Response,
  env: WebEnv,
): Promise<Response> {
  const script = buildBrowserEvidenceBootstrapScript(env);
  if (!script) return response;
  if (response.status < 200 || response.status >= 300) return response;

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('text/html')) return response;

  const html = await response.clone().text();
  const idx = html.indexOf(HEAD_CLOSE);
  if (idx === -1) return response;

  const next = html.slice(0, idx) + script + html.slice(idx);
  const headers = new Headers(response.headers);
  // The body length changed: drop any content-length so the runtime recomputes it.
  headers.delete('content-length');
  return new Response(next, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
