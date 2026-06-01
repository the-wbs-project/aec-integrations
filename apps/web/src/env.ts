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
 * All Datadog and purge fields are optional so the Worker boots cleanly in
 * local dev before secrets have been provisioned — the RUM provider and
 * `logToDatadog` helper no-op when missing; the purge endpoint returns
 * `cf_credentials_missing` in its `failed[]` payload.
 */

export type DatadogPublicConfig = {
  applicationId: string;
  clientToken: string;
  site: string;
  env: string;
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
  DD_APPLICATION_ID?: string;
  DD_CLIENT_TOKEN?: string;
  DD_API_KEY?: string;
  DD_SITE?: string;
  ADMIN_PURGE_TOKEN?: string;
  CF_PURGE_API_TOKEN?: string;
  CF_ZONE_ID?: string;
};
