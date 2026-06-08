/**
 * Injects the public Algolia search config `<script>` into the SSR HTML
 * response (AECI-134 / Phase 3.1). Mirrors `server-bootstrap-inject.ts` (the
 * Datadog RUM bootstrap) exactly — same status / content-type / `</head>` /
 * content-length guards.
 *
 * InstantSearch (3.9, the consumer) needs an `appId`, a query-only `searchKey`,
 * and the physical index names at app boot. The search key is explicitly
 * client-exposed (it can do nothing but search this env's three indexes), so we
 * read `ALGOLIA_APP_ID` + `ALGOLIA_SEARCH_KEY` from the SSR Worker's `env`,
 * derive the index names from `ENV`, and inline a tiny
 * `window.__AECI_ALGOLIA__ = {...}` snippet before `</head>`.
 *
 * Security (the review gate): the Algolia ADMIN/management key is never part of
 * `WebEnv`, so it can never be read here — this helper only ever serializes the
 * public search config. A unit test (`algolia-bootstrap-inject.spec.ts`) proves
 * an admin-key value placed on `env` does not appear in the output.
 *
 * Caching note (§9.1a): the injected values depend ONLY on deployment env (not
 * per-visitor state), so it is safe to inject before edge cache write — every
 * visitor of the same deployment sees the same config.
 *
 * No-op contract: when `ALGOLIA_APP_ID` or `ALGOLIA_SEARCH_KEY` is absent (local
 * dev without secrets, or any env where search is not yet provisioned), the
 * helper returns the response unchanged and emits no `window.__AECI_ALGOLIA__`.
 */

import { indexNamesFor } from '@aeci/shared/algolia';

import type { AlgoliaPublicConfig, WebEnv } from './env';

const HEAD_CLOSE = '</head>';

/**
 * Builds the value assigned to `window.__AECI_ALGOLIA__`, or `null` when either
 * of the two public Algolia credentials is missing.
 */
export function buildAlgoliaPublicConfig(env: WebEnv): AlgoliaPublicConfig | null {
  const appId = env.ALGOLIA_APP_ID;
  const searchKey = env.ALGOLIA_SEARCH_KEY;
  if (!appId || !searchKey) return null;
  return {
    appId,
    searchKey,
    indexes: indexNamesFor(env.ENV ?? 'development'),
  };
}

/**
 * Builds the `<script>` tag exposing the public Algolia config to the browser,
 * or `null` when the config is unavailable.
 *
 * Values are JSON-encoded and `<` is escaped to `<` so a stray angle
 * bracket inside a key (or a future field) cannot break out of the script
 * element.
 */
export function buildAlgoliaBootstrapScript(env: WebEnv): string | null {
  const cfg = buildAlgoliaPublicConfig(env);
  if (!cfg) return null;
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  return `<script>window.__AECI_ALGOLIA__=${json};</script>`;
}

/**
 * Splices the bootstrap `<script>` into a rendered HTML response just before
 * `</head>`. Returns the original response untouched when:
 *
 *   - Public Algolia config is missing (dev / search-not-provisioned envs).
 *   - Response is not `text/html` (assets, JSON proxies, etc.).
 *   - Response status is outside 2xx (no point mutating error bodies).
 *   - The HTML has no `</head>` token (defensive; SSR output always does).
 */
export async function injectAlgoliaBootstrap(response: Response, env: WebEnv): Promise<Response> {
  const script = buildAlgoliaBootstrapScript(env);
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
