export type Env = {
  /** Prisma Accelerate URL (`prisma://...`) used by the Worker at runtime. */
  DATABASE_URL: string;
  /**
   * Deployment environment label. Each wrangler env block sets this explicitly
   * (`preview`/`staging`/`production`); when unset (bare `wrangler dev`, tests)
   * both `/api/version` and Datadog tags report `development` — one convention
   * for the unset state (AECI-119).
   */
  ENV?: 'development' | 'preview' | 'staging' | 'production';
  /**
   * Commit SHA the Worker was deployed at (AECI-74). Injected via
   * `wrangler dev --var COMMIT_SHA:$(git rev-parse HEAD)` locally and
   * `wrangler deploy --var COMMIT_SHA:$GITHUB_SHA` in CI (AECI-71). Absent →
   * `/api/version` reports `sha: "unknown"`.
   */
  COMMIT_SHA?: string;
  /**
   * ISO 8601 datetime the Worker was deployed at (AECI-74). Injected via
   * `wrangler dev --var DEPLOYED_AT:$(date -u …)` locally. Absent →
   * `/api/version` reports the Unix epoch (a valid ISO datetime sentinel).
   */
  DEPLOYED_AT?: string;
  /**
   * Datadog Logs HTTP intake credentials (AECI-31). `DD_API_KEY` is required
   * for `logToDatadog()` to forward; absent → helper is a no-op so dev boots
   * cleanly without a Datadog account. `DD_SITE` defaults to `datadoghq.com`.
   */
  DD_API_KEY?: string;
  DD_SITE?: string;
  /**
   * Bearer token gating `POST /api/promote` (the review-app push endpoint).
   * Set as a Wrangler secret per environment; absent → every promote request is
   * rejected 401 (fail-closed). Compared constant-time in `lib/review-auth.ts`.
   */
  REVIEW_APP_TOKEN?: string;
  /**
   * KV namespace for `GET /api/taxonomy` read-through caching (AECI-54).
   * Optional: handler falls back to a direct Prisma fetch when the binding is
   * absent (e.g. local `wrangler dev` without `--remote`). 5-minute TTL is
   * the staleness bound until admin/purge lands (Phase 2.10).
   */
  TAXONOMY_KV?: KVNamespace;
  /**
   * Cloudflare API token used by `POST /api/promote` to purge the edge-cache
   * tags a promote invalidated (AECI-105). The promote handler calls
   * Cloudflare's purge-by-tag API **directly** over HTTPS — there is no longer a
   * `WEB` service binding back to the SSR Worker (that web↔api cycle was removed
   * in Option B; see `docs/adr/0010-promote-purges-cloudflare-directly.md`).
   * Must be scoped to `Zone.Cache Purge` on `aecintegrations.com` only
   * (`docs/CACHE_STRATEGY.md` §5) — the same scope the web Worker's token uses.
   * Set as a Wrangler secret per environment. Optional: absent (with `CF_ZONE_ID`)
   * → cache purge is a graceful no-op (e.g. local `pnpm dev:bound`, PR previews).
   */
  CF_PURGE_API_TOKEN?: string;
  /**
   * Cloudflare zone ID the promote purge targets (AECI-105). Public value, set
   * per environment alongside `CF_PURGE_API_TOKEN`. Optional: absent → cache
   * purge is a graceful no-op.
   */
  CF_ZONE_ID?: string;
};
