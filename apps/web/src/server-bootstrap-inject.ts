/**
 * Injects the Datadog RUM bootstrap `<script>` into the SSR HTML response.
 *
 * The Browser RUM SDK needs `applicationId` + `clientToken` at app boot. Both
 * are explicitly client-exposed (per AECI-31 acceptance criteria) but they
 * vary per deployment environment. We read them from the SSR Worker's `env`
 * and inline a tiny `window.__AECI_DD__ = {...}` snippet before `</head>` so
 * the Angular bundle finds them on hydration (see `app/datadog.provider.ts`).
 *
 * Caching note (§9.1a): the injected values depend ONLY on deployment env
 * (not per-visitor state), so it is safe to inject before edge cache write —
 * every visitor of the same deployment sees the same tokens. We deliberately
 * do this transform inside `handleSsr` so the cached payload already carries
 * the script tag (no per-request rewriting on cache hits).
 *
 * No-op contract: when the public Datadog vars are absent (local dev without
 * secrets provisioned, or any env where RUM is intentionally off), the
 * helper returns the response unchanged. The browser provider mirrors the
 * same defensive check so missing config never throws.
 */

import type { DatadogPublicConfig, WebEnv } from './env';

const HEAD_CLOSE = '</head>';

/**
 * Builds the value that gets assigned to `window.__AECI_DD__`, or `null` when
 * either of the two public RUM credentials is missing.
 */
export function buildDatadogPublicConfig(env: WebEnv): DatadogPublicConfig | null {
  const applicationId = env.DD_APPLICATION_ID;
  const clientToken = env.DD_CLIENT_TOKEN;
  if (!applicationId || !clientToken) return null;
  return {
    applicationId,
    clientToken,
    site: env.DD_SITE || 'datadoghq.com',
    env: env.ENV ?? 'preview',
  };
}

/**
 * Builds the `<script>` tag that exposes the public Datadog config to the
 * browser, or `null` when the config is unavailable.
 *
 * Values are JSON-encoded and `<` is escaped to `<` so a stray angle
 * bracket inside a token (or a future field) cannot break out of the script
 * element.
 */
export function buildDatadogBootstrapScript(env: WebEnv): string | null {
  const cfg = buildDatadogPublicConfig(env);
  if (!cfg) return null;
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  return `<script>window.__AECI_DD__=${json};</script>`;
}

/**
 * Splices the bootstrap `<script>` into a rendered HTML response just before
 * `</head>`. Returns the original response untouched when:
 *
 *   - Public Datadog config is missing (dev / RUM-off environments).
 *   - Response is not `text/html` (assets, JSON proxies, etc.).
 *   - Response status is outside 2xx (no point mutating error bodies; SSR's
 *     own 404 short-text payload would have no `</head>` anyway).
 *   - The HTML has no `</head>` token (defensive; SSR output always does).
 */
export async function injectDatadogBootstrap(
  response: Response,
  env: WebEnv,
): Promise<Response> {
  const script = buildDatadogBootstrapScript(env);
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
