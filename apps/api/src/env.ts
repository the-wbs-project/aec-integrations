/**
 * Which daily scheduled job a queue message asks the consumer to run. `sync` /
 * `drift` are the Algolia jobs (AECI-139 / AECI-140); `stats` is the home-stats
 * compute job (AECI-178 / Phase 4.3) that upserts the `home.*` `stats_cache`
 * keys. Named generically because the union now spans more than Algolia.
 */
export type ScheduledJob = 'sync' | 'drift' | 'stats';

/**
 * Body of a message on a scheduled-job queue. Producer: the cron `scheduled()`
 * handler; consumer: the `queue()` handler — both in `src/scheduled.ts`. The
 * cron no longer runs the work inline; it enqueues one of these and the consumer
 * executes it (decouples scheduling from execution; queue-native retries). See
 * `docs/adr/0013-algolia-jobs-via-queue.md`.
 */
export type ScheduledJobMessage = {
  job: ScheduledJob;
  /** What caused the enqueue: `cron` = the daily scheduled trigger; `manual` =
   *  an operator force-run (e.g. a Cloudflare Queues REST push — the consumer
   *  implies this when a message arrives without a `trigger`; see
   *  `ScheduledJobMessageInput`). */
  trigger: 'cron' | 'manual';
  /** ISO 8601 enqueue timestamp, for staleness / observability. */
  enqueuedAt: string;
};

/**
 * What can actually *arrive* on a job queue. The cron producer (`enqueueOrRun`)
 * always sends a full {@link ScheduledJobMessage}, but a message may also be
 * pushed out-of-band — e.g. an operator force-run via the Cloudflare Queues REST
 * API sending just `{ "job": "stats" }`. In that case `trigger` and `enqueuedAt`
 * are absent on the wire, and the consumer implies them after the fact
 * (`normalizeJobMessage` in `src/scheduled.ts`): `trigger` → `'manual'`,
 * `enqueuedAt` → the queue's receive time. Only `job` is required — it selects
 * the handler. See `docs/adr/0013-algolia-jobs-via-queue.md`.
 */
export type ScheduledJobMessageInput = { job: ScheduledJob } & Partial<
  Omit<ScheduledJobMessage, 'job'>
>;

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
  /**
   * Algolia application id (AECI-134). Single, shared across envs (one app;
   * only indexes/keys differ). Provisioned in Phase 3.1. Optional until the
   * sync pipeline (3.5/3.6) reads it.
   */
  ALGOLIA_APP_ID?: string;
  /**
   * Algolia **management** key (AECI-134) — search + index-mutation ACLs, scoped
   * to this env's three indexes, rotated independently per env. Provisioned in
   * Phase 3.1, consumed by the sync scripts from 3.5. NEVER client-exposed: this
   * is the API Worker only; the SSR Worker (`apps/web/src/env.ts`) gets the
   * query-only search key instead. Optional until 3.5.
   */
  ALGOLIA_ADMIN_KEY?: string;
  /**
   * Cloudflare Queue **producer** bindings for the daily scheduled jobs. The
   * cron `scheduled()` handler enqueues a `ScheduledJobMessage` here rather than
   * doing the work inline; the `queue()` consumer (`src/scheduled.ts`) runs it.
   * Bound on staging + production only (mirrors the cron triggers). Absent on
   * local `wrangler dev` / preview → the scheduled handler falls back to running
   * the job inline (see `enqueueOrRun`), so a `--test-scheduled` tick is never
   * silently dropped. The Worker also *consumes* these queues (the consumer
   * bindings live in `wrangler.jsonc`, not the `Env` type). See
   * `docs/adr/0013-algolia-jobs-via-queue.md`.
   *
   * `ALGOLIA_SYNC_QUEUE` / `ALGOLIA_DRIFT_QUEUE` carry the Algolia sync (AECI-139)
   * and index-drift (AECI-140) jobs; `STATS_QUEUE` carries the home-stats compute
   * job (AECI-178 / Phase 4.3). The Algolia bindings keep their names — they *are*
   * Algolia queues — but now carry the generic `ScheduledJobMessage`.
   */
  ALGOLIA_SYNC_QUEUE?: Queue<ScheduledJobMessage>;
  ALGOLIA_DRIFT_QUEUE?: Queue<ScheduledJobMessage>;
  STATS_QUEUE?: Queue<ScheduledJobMessage>;
  /**
   * Supabase project base URL (AECI-193 / Phase 5.2), e.g.
   * `https://<ref>.supabase.co`. Public value, set as a plain wrangler var per
   * env. Used ONLY to derive the JWKS endpoint
   * (`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`) and the expected `iss`
   * claim for user-JWT verification in `lib/user-auth.ts` — no DB round-trip,
   * no Supabase client on this Worker. Absent → `requireUserAuth()` rejects
   * every request 401 (fail-closed). The anon key and service-role key are
   * deliberately NOT bound here: the API Worker verifies tokens with public
   * JWKS material only (AUTH_AND_RLS.md §4).
   */
  SUPABASE_URL?: string;
  /**
   * Bot-score sampling floor for `page_views` capture (AECI-177). Cloudflare Bot
   * Management scores requests 1–99 (lower = more bot-like). When SET to an
   * integer N, captured page views whose `cf_bot_score < N` are dropped to keep
   * the table from growing on automated traffic; UNSET (the default everywhere
   * today) captures every view. The §14.2 sampling **policy** is deferred until
   * launch traffic is visible — this is only the seam, so nothing is hardcoded
   * to drop. Parsed with `parseInt`; a non-numeric value is treated as unset.
   */
  PAGE_VIEWS_MIN_BOT_SCORE?: string;
  /**
   * Google Perspective API key for review toxicity scoring (AECI-198 / Phase
   * 5.7). Set as a Wrangler secret per env. Optional and **fail-open**: absent →
   * `scoreToxicity()` is a silent no-op that stores `null` (the expected state in
   * local `dev:bound` / PR previews), and any outage also stores `null` (logged
   * `warn`) — the score only ever *flags* the moderation queue, it never blocks a
   * submission. See `lib/perspective.ts` and `STAGE_1_PHASE_5_SPEC.md` §5.3.
   */
  PERSPECTIVE_API_KEY?: string;
};
