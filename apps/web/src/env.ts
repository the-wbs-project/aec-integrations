/**
 * Runtime environment surface for the SSR Worker (`apps/web/`).
 *
 * Cloudflare injects `env` per request. Service bindings (`ASSETS`, `API`) are
 * fetcher RPC handles configured in `wrangler.jsonc`. `ENV` is a public `vars`
 * value. Datadog credentials are set with `wrangler secret put`:
 *
 *   - DD_APPLICATION_ID, DD_CLIENT_TOKEN — explicitly client-exposed per
 *     AECI-31 acceptance criteria. They are rendered into the SSR HTML by
 *     `injectDatadogBootstrap` so `@datadog/browser-rum` can pick them up at
 *     hydration. We still store them as secrets (not `vars`) so the values do
 *     not live in git.
 *   - DD_API_KEY — server-only. Used by `logToDatadog()` (see
 *     `./server-datadog.ts`) to POST logs to the Datadog HTTP intake. Never
 *     rendered into HTML.
 *   - DD_SITE — public, the Datadog site host (`datadoghq.com`,
 *     `datadoghq.eu`, etc.). Defaults to `datadoghq.com` when absent.
 *
 * Cache-tag purge surface (AECI-56 / Phase 2.10):
 *
 *   - ADMIN_PURGE_TOKEN — caller-facing bearer for `POST /admin/purge`.
 *     Wrangler secret. Phase 6 replaces this with Cloudflare Access.
 *   - CF_PURGE_API_TOKEN — Cloudflare API token used by the purge handler to
 *     call CF's purge-by-tag API. Must be scoped to `Zone.Cache Purge` on
 *     `aecintegrations.com` only (`docs/CACHE_STRATEGY.md` §5 line 109).
 *   - CF_ZONE_ID — public `vars` entry; the Cloudflare zone ID the purge call
 *     targets.
 *
 * Algolia search surface (AECI-134 / Phase 3.1):
 *
 *   - ALGOLIA_APP_ID, ALGOLIA_SEARCH_KEY — explicitly client-exposed. The
 *     SEARCH key is query-only and scoped to this env's three indexes; both are
 *     rendered into the SSR HTML by `injectAlgoliaBootstrap` so InstantSearch
 *     can pick them up at hydration (consumer lands in 3.9). Stored as secrets
 *     (not `vars`) only to keep values out of git.
 *   - The Algolia ADMIN/management key is **never** part of `WebEnv` — it must
 *     never reach the browser (review gate). It lives on the API Worker only
 *     (`apps/api/src/env.ts`). Mirrors the DD `DD_API_KEY` server-only rule.
 *
 * All Datadog, purge, and Algolia fields are optional so the Worker boots
 * cleanly in local dev before secrets have been provisioned — the RUM provider
 * and `logToDatadog` helper no-op when missing; the purge endpoint returns
 * `cf_credentials_missing` in its `failed[]` payload; the Algolia bootstrap
 * injects nothing (no `window.__AECI_ALGOLIA__`).
 */

import type { AlgoliaIndexNames } from '@aeci/shared/algolia';

export type DatadogPublicConfig = {
  applicationId: string;
  clientToken: string;
  site: string;
  env: string;
};

/**
 * Public Algolia config rendered into the SSR HTML for the browser
 * (`window.__AECI_ALGOLIA__`). Carries the app id, the query-only search key,
 * and this env's physical index names — all non-secret. The admin/management
 * key is intentionally absent (review gate). Consumed by InstantSearch in 3.9.
 */
export type AlgoliaPublicConfig = {
  appId: string;
  searchKey: string;
  indexes: AlgoliaIndexNames;
};

/**
 * Public Supabase config rendered into the SSR HTML for the browser
 * (`window.__AECI_SUPABASE__`, AECI-194). Carries the project base URL and the
 * publishable/anon key — both non-secret (the anon key only unlocks anon-RLS
 * access + the auth endpoints; same security class as `ALGOLIA_SEARCH_KEY`).
 * The service-role key is intentionally never part of `WebEnv` (review gate,
 * AUTH_AND_RLS.md §3). Consumed by the login page's browser Supabase client.
 */
export type SupabasePublicConfig = {
  url: string;
  anonKey: string;
};

export type WebEnv = {
  ASSETS: Fetcher;
  API: Fetcher;
  /**
   * Deployment environment label. Each wrangler env block sets this explicitly
   * (`preview`/`staging`/`production`); when unset (bare `wrangler dev`, tests)
   * Datadog logs/metrics and the RUM bootstrap report `development` — matching
   * the API Worker's `/api/version` convention (AECI-119).
   */
  ENV?: 'development' | 'preview' | 'staging' | 'production';
  /**
   * Crawler-indexing gate (`server/robots-policy.ts`). FAIL-CLOSED: indexing is
   * blocked on every environment unless this is exactly the string `"true"`.
   * Pre-launch, no env sets it — so `demo.aecintegrations.com` (public, the
   * `production` env, NOT behind Cloudflare Access), staging, and PR previews
   * all emit `X-Robots-Tag: noindex` (the authoritative block) plus a
   * sitemap-less `robots.txt` that still allows crawling so the noindex is seen.
   * Deliberately NOT derived from `ENV` — `production` is the pre-launch demo.
   * Set to `"true"` on the env that should be indexed at public launch.
   */
  ALLOW_INDEXING?: string;
  /**
   * Build metadata for `GET /_version` (AECI-92), injected via `wrangler --var`
   * at deploy/dev time. Optional so the handler returns sentinels (`unknown` /
   * epoch) rather than throwing when no `--var` flag is passed (bare
   * `wrangler dev`, tests). Mirrors the API Worker's `COMMIT_SHA`/`DEPLOYED_AT`
   * (`apps/api/src/env.ts`) so both Workers report the same shape.
   */
  COMMIT_SHA?: string;
  DEPLOYED_AT?: string;
  DD_APPLICATION_ID?: string;
  DD_CLIENT_TOKEN?: string;
  DD_API_KEY?: string;
  DD_SITE?: string;
  ADMIN_PURGE_TOKEN?: string;
  CF_PURGE_API_TOKEN?: string;
  CF_ZONE_ID?: string;
  /**
   * Public Algolia credentials (AECI-134). `ALGOLIA_SEARCH_KEY` is query-only
   * and index-scoped — safe to render into HTML. Both are absent until the
   * operator provisions them; absent → the Algolia bootstrap is a no-op. The
   * admin/management key is deliberately NOT here (review gate).
   */
  ALGOLIA_APP_ID?: string;
  ALGOLIA_SEARCH_KEY?: string;
  /**
   * Supabase auth surface (AECI-193 / Phase 5.2).
   *
   * - SUPABASE_URL — public project base URL (`https://<ref>.supabase.co`),
   *   plain `vars` entry per env (dev project for preview/staging, prod
   *   project for production).
   * - SUPABASE_ANON_KEY — the publishable/anon key. Safe to expose (it only
   *   unlocks anon-RLS access + the auth endpoints) but stored as a CI-pushed
   *   secret to keep values out of git — same convention as
   *   `ALGOLIA_SEARCH_KEY`. Absent → `createSupabaseServerClient` returns
   *   `null` and auth surfaces degrade gracefully (no throw at boot).
   * - The service-role key is NEVER part of `WebEnv` (or any Worker env) —
   *   AUTH_AND_RLS.md §3. Mirrors the Algolia admin-key rule above.
   */
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
};
