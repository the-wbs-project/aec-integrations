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
 * All Datadog fields are optional so the Worker boots cleanly in local dev
 * before secrets have been provisioned — the RUM provider and `logToDatadog`
 * helper no-op when the relevant fields are missing.
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
  ENV?: 'preview' | 'production';
  DD_APPLICATION_ID?: string;
  DD_CLIENT_TOKEN?: string;
  DD_API_KEY?: string;
  DD_SITE?: string;
};
