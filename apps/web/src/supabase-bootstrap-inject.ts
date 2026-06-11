/**
 * Injects the public Supabase auth config `<script>` into the SSR HTML
 * response (AECI-194 / Phase 5.3). Mirrors `algolia-bootstrap-inject.ts` (and
 * transitively `server-bootstrap-inject.ts`, the Datadog RUM bootstrap)
 * exactly — same status / content-type / `</head>` / content-length guards.
 *
 * The login page's browser Supabase client (`@supabase/ssr`
 * `createBrowserClient`) needs the public `SUPABASE_URL` + `SUPABASE_ANON_KEY`
 * at hydration. The anon key is explicitly client-exposable (it only unlocks
 * anon-RLS access + the auth endpoints — same security class as
 * `ALGOLIA_SEARCH_KEY`), so we read both from the SSR Worker's `env` and
 * inline a tiny `window.__AECI_SUPABASE__ = {...}` snippet before `</head>`.
 *
 * Security (the review gate): the Supabase SERVICE-ROLE key is never part of
 * `WebEnv` (AUTH_AND_RLS.md §3), so it can never be read here — this helper
 * only ever serializes the public auth config. A unit test
 * (`supabase-bootstrap-inject.spec.ts`) proves a service-role value placed on
 * `env` does not appear in the output.
 *
 * Caching note (§9.1a): the injected values depend ONLY on deployment env (not
 * per-visitor state), so it is safe to inject before edge cache write — every
 * visitor of the same deployment sees the same config.
 *
 * No-op contract: when `SUPABASE_URL` or `SUPABASE_ANON_KEY` is absent (local
 * dev without secrets, or any env where auth is not yet provisioned), the
 * helper returns the response unchanged and emits no `window.__AECI_SUPABASE__`
 * — the login page then renders its "temporarily unavailable" notice.
 */

import type { SupabasePublicConfig, WebEnv } from './env';

const HEAD_CLOSE = '</head>';

/**
 * Builds the value assigned to `window.__AECI_SUPABASE__`, or `null` when
 * either of the two public Supabase values is missing.
 */
export function buildSupabasePublicConfig(env: WebEnv): SupabasePublicConfig | null {
  const url = env.SUPABASE_URL;
  const anonKey = env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

/**
 * Builds the `<script>` tag exposing the public Supabase config to the
 * browser, or `null` when the config is unavailable.
 *
 * Values are JSON-encoded and `<` is escaped to `<` so a stray angle
 * bracket inside a value (or a future field) cannot break out of the script
 * element.
 */
export function buildSupabaseBootstrapScript(env: WebEnv): string | null {
  const cfg = buildSupabasePublicConfig(env);
  if (!cfg) return null;
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  return `<script>window.__AECI_SUPABASE__=${json};</script>`;
}

/**
 * Splices the bootstrap `<script>` into a rendered HTML response just before
 * `</head>`. Returns the original response untouched when:
 *
 *   - Public Supabase config is missing (dev / auth-not-provisioned envs).
 *   - Response is not `text/html` (assets, JSON proxies, etc.).
 *   - Response status is outside 2xx (no point mutating error bodies).
 *   - The HTML has no `</head>` token (defensive; SSR output always does).
 */
export async function injectSupabaseBootstrap(response: Response, env: WebEnv): Promise<Response> {
  const script = buildSupabaseBootstrapScript(env);
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
