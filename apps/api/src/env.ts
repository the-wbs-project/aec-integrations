export type Env = {
  /** Prisma Accelerate URL (`prisma://...`) used by the Worker at runtime. */
  DATABASE_URL: string;
  ENV?: 'preview' | 'staging' | 'production';
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
};
