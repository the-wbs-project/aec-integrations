/**
 * Injects the PostHog bootstrap `<script>` into the SSR HTML response (AECI-239
 * / §14.1).
 *
 * The browser analytics layer needs the project API key + ingestion host at
 * hydration. Both are explicitly client-exposed (the project API key is a
 * publishable key — same security class as the Algolia search key) but they
 * vary per deployment environment. We read them
 * from the SSR Worker's `env` and inline a tiny `window.__AECI_POSTHOG__ = {...}`
 * snippet before `</head>` so the Angular bundle finds them on hydration (see
 * `app/analytics/posthog-config.ts`).
 *
 * Caching note (§9.1a): the injected values depend ONLY on deployment env (not
 * per-visitor state), so it is safe to inject before edge cache write — every
 * visitor of the same deployment sees the same config. We deliberately do this
 * transform inside `handleSsr` so the cached payload already carries the script
 * tag (no per-request rewriting on cache hits). Note the *consent* gate lives
 * entirely client-side (`app/analytics/consent.ts`); this only exposes config.
 *
 * No-op contract: when `POSTHOG_PROJECT_KEY` is absent (bare `wrangler dev`
 * with no vars, or any env where analytics is intentionally off), the helper
 * returns the response unchanged. The browser reader mirrors the same defensive
 * check so missing config never throws — mirrors the other bootstrap injectors.
 *
 * AECI-640 renamed `POSTHOG_KEY` → `POSTHOG_PROJECT_KEY` and moved it from a
 * CI-pushed secret to a committed per-env `vars` entry. The `phc_` token ships
 * in this very script tag on every page, so treating it as a secret bought
 * nothing and cost the weeks-dark production analytics of AECI-326.
 */

import type { PostHogPublicConfig, WebEnv } from './env';

const HEAD_CLOSE = '</head>';

/** Default **ingest** host when `POSTHOG_HOST` is unset (US Cloud). Note this
 *  is `us.i.posthog.com`, not `us.posthog.com` — the latter is the management
 *  API and produces a confusing 404 on an intake path. The static CSP
 *  `connect-src` is pinned to the matching US hosts — see
 *  `server/seo-headers.ts`. */
const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

/**
 * Builds the value assigned to `window.__AECI_POSTHOG__`, or `null` when the
 * project API key is missing. The host falls back to the US Cloud default.
 */
export function buildPostHogPublicConfig(env: WebEnv): PostHogPublicConfig | null {
  const key = env.POSTHOG_PROJECT_KEY;
  if (!key) return null;
  return {
    key,
    host: env.POSTHOG_HOST || DEFAULT_POSTHOG_HOST,
  };
}

/**
 * Builds the `<script>` tag that exposes the public PostHog config to the
 * browser, or `null` when the config is unavailable.
 *
 * Values are JSON-encoded and `<` is escaped to `<` so a stray angle
 * bracket inside the key/host (or a future field) cannot break out of the
 * script element.
 */
export function buildPostHogBootstrapScript(env: WebEnv): string | null {
  const cfg = buildPostHogPublicConfig(env);
  if (!cfg) return null;
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  return `<script>window.__AECI_POSTHOG__=${json};</script>`;
}

/**
 * Splices the bootstrap `<script>` into a rendered HTML response just before
 * `</head>`. Returns the original response untouched when:
 *
 *   - Public PostHog config is missing (dev / analytics-off environments).
 *   - Response is not `text/html` (assets, JSON proxies, etc.).
 *   - Response status is outside 2xx (no point mutating error bodies; SSR's
 *     own 404 short-text payload would have no `</head>` anyway).
 *   - The HTML has no `</head>` token (defensive; SSR output always does).
 */
export async function injectPostHogBootstrap(response: Response, env: WebEnv): Promise<Response> {
  const script = buildPostHogBootstrapScript(env);
  if (!script) return response;
  if (response.status < 200 || response.status >= 300) return response;

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('text/html')) return response;

  const html = await response.clone().text();
  const idx = html.indexOf(HEAD_CLOSE);
  if (idx === -1) return response;

  const next = html.slice(0, idx) + script + html.slice(idx);
  const headers = new Headers(response.headers);
  // The body length changed — drop any cached content-length so the runtime
  // recomputes it instead of truncating/padding to the original size.
  headers.delete('content-length');
  return new Response(next, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
