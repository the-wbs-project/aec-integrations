/**
 * Injects the Turnstile bootstrap `<script>` into the SSR HTML response
 * (AECI-1457).
 *
 * The browser `TurnstileService` (`app/core/turnstile.service.ts`) needs the
 * widget site key at hydration. The site key is public by design (Cloudflare
 * renders it into every page that hosts a widget), but it varies per deployment
 * environment, so it is read from the SSR Worker's `env` and inlined as
 * `window.__AECI_TURNSTILE__ = {...}` before `</head>`. Mirrors
 * `posthog-bootstrap-inject.ts`.
 *
 * Caching note: the injected value depends ONLY on the deployment env, never on
 * the visitor, so the cached HTML stays visitor-state-neutral. Whether a given
 * visitor runs Turnstile (DNT / GPC skip it) is decided in the browser.
 *
 * No-op contract: with no `TURNSTILE_SITE_KEY` (local dev without `.dev.vars`,
 * and production until AECI-1458) the helper returns the response unchanged,
 * the browser finds no config, and Turnstile never loads.
 */

import type { TurnstilePublicConfig, WebEnv } from './env';

const HEAD_CLOSE = '</head>';

/**
 * Builds the value assigned to `window.__AECI_TURNSTILE__`, or `null` when the
 * site key is missing.
 */
export function buildTurnstilePublicConfig(env: WebEnv): TurnstilePublicConfig | null {
  const siteKey = env.TURNSTILE_SITE_KEY;
  if (!siteKey) return null;
  return { siteKey };
}

/**
 * Builds the `<script>` tag that exposes the Turnstile config to the browser, or
 * `null` when the config is unavailable. The JSON is `<`-escaped so a stray
 * angle bracket in the value cannot break out of the script element.
 */
export function buildTurnstileBootstrapScript(env: WebEnv): string | null {
  const cfg = buildTurnstilePublicConfig(env);
  if (!cfg) return null;
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  return `<script>window.__AECI_TURNSTILE__=${json};</script>`;
}

/**
 * Splices the bootstrap `<script>` into a rendered HTML response just before
 * `</head>`. Returns the original response untouched when the site key is
 * missing, the response is not `text/html`, the status is outside 2xx, or the
 * HTML has no `</head>`.
 */
export async function injectTurnstileBootstrap(response: Response, env: WebEnv): Promise<Response> {
  const script = buildTurnstileBootstrapScript(env);
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
