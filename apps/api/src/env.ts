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
};
