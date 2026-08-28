import type { CachePurgeMessage } from '@aeci/shared';

import type { PromoteWorkflowParams } from './lib/promote-jobs';

/**
 * Which scheduled job a queue message asks the consumer to run. `sync` / `drift`
 * are the Algolia jobs (AECI-139 / AECI-140); `stats` is the home-stats compute
 * job (AECI-178 / Phase 4.3) that upserts the `home.*` `stats_cache` keys;
 * `moderation` snapshots the pending-review queue for its health gauges (AECI-206
 * / Phase 5.15); `reconcile` is the request→Linear reconciliation sweep
 * (AECI-214 / Phase 6.7) that retries stuck `vendor_requests` whose §6.4 issue
 * creation failed. Named generically because the union now spans more than
 * Algolia. `moderation` is queue-less (a cheap read-only gauge) — it always runs
 * inline (`queueForJob` returns `undefined`), so it never appears on the wire as
 * a `ScheduledJobMessage`. Unlike the daily jobs, `reconcile` runs every 15
 * minutes (see `RECONCILE_CRON` in `scheduled.ts`) — a tight backstop, not a
 * daily batch. `data_quality` is the daily 04:00 UTC §23.1 data-quality suite
 * (AECI-241 / Phase 7.6): ten read-only integrity checks + an email digest.
 * `waf` is the hourly WAF firewall-event poll (AECI-262 / §15.1): like
 * `moderation` it is queue-less (a cheap read-only Cloudflare GraphQL Analytics
 * read) and always runs inline. `attestation_notify` is the daily 10:00 UTC §7
 * attestation detector sweep (AECI-302 / `STAGE_2_ATTESTATIONS_SPEC.md` §7):
 * four detectors over the claim/attestation spine, vendor nudge + AECi ops email
 * via Resend, and an `audit_log` suppression ledger. Queue-backed, unlike the
 * read-only gauges — it sends mail and writes D1, so it wants native retries.
 * read) and always runs inline. `analytics` is the daily 05:00 UTC (noon Jakarta) operator
 * analytics digest (AECI-526): like `moderation`/`waf` it is queue-less (a cheap
 * read-only aggregation + one email) and always runs inline. `snapshot` is the
 * daily 00:15 UTC `metrics_daily` capture (AECI-581 / `ADMIN_PANEL_SPEC.md`
 * §7.1): it records the prior COMPLETE UTC day, and like `moderation`/`waf`/
 * `analytics` it is queue-less — every metric is isolated in its own try/catch
 * and any missed day is recoverable by re-running the backfill over that range,
 * so queue-native retries would buy nothing. `retention` is the daily 03:00 UTC
 * §7.4 retention prune (AECI-584): it deletes `page_views` past 400 days and
 * `job_runs` past 90, never touches `metrics_daily`, and refuses to run at all
 * if the 00:15 snapshot has not captured every day inside its cut window. Also
 * queue-less — a skipped or partial run is simply re-attempted tomorrow, and a
 * retry of a destructive job is the last thing worth automating.
 * `entitlement_expiry` is the daily 11:00 UTC Stage 2 §7 term-expiry warning
 * sweep (AECI-613 / `STAGE_2_PAID_TIERS_SPEC.md` §7): one indexed read over
 * `vendor_entitlements_expiry_idx` → a renewal prompt to the vendor's seats and
 * an operator copy to `ADMIN_ALERT_EMAIL`, fenced by `expiry_notice_sent_at` so a
 * term earns one notice rather than one per night. Queue-less like
 * `moderation`/`waf`/`analytics`, and it **warns only** — it never writes
 * `status` and never writes `vendors.verified` (§7.3).
 */
export type ScheduledJob =
  | 'sync'
  | 'drift'
  | 'stats'
  | 'moderation'
  | 'reconcile'
  | 'data_quality'
  | 'waf'
  | 'attestation_notify'
  | 'analytics'
  | 'snapshot'
  | 'retention'
  | 'entitlement_expiry';

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
  /**
   * Cloudflare D1 binding for the application database (ADR 0016, AECI-252).
   * Accessed via the Drizzle client factory `getDb(env)` (`src/db/client.ts`),
   * which asserts its presence. `wrangler dev` serves a local SQLite copy;
   * staging/production bind per-env databases. The application DB is D1 only —
   * the former Prisma Accelerate `DATABASE_URL` path is gone (ADR 0016 / AECI-278).
   * Optional because some test/tooling contexts construct a partial Env without
   * a binding.
   */
  DB?: D1Database;
  /**
   * Supabase service-role key (auth project only), used by every split-identity
   * seam via the Supabase Admin API — the register is `docs/AUTH_AND_RLS.md` §3.1
   * (ADR 0016 §3 / AECI-254): `auth.users` email reads (seam #2), GDPR erasure of
   * the `auth.users` row (seam #3), and vendor-claimant identity resolution —
   * email→user lookup (#4a) + account provisioning (#4b), AECI-527.
   *
   * Read in exactly ONE module, `lib/supabase-admin.ts` (the single-module
   * invariant, §3.1) — a project-wide auth key with no scoped alternative, so keep
   * it to one door.
   *
   * Provisioning (AECI-530, per ADR 0016 §6): a SINGLE shared, un-suffixed GH
   * secret — one Supabase auth project backs every env (ADR 0017) — that CI pushes
   * to THIS Worker on staging (`deploy.yml`), demo, and production
   * (`promote-to-{demo,prod}.yml`), each a graceful warn-and-skip step. Never on
   * the web Worker, and deliberately never on per-PR previews (see the note in
   * `pr-preview.yml`), so local dev and previews run keyless by design.
   *
   * Optional + fail-safe: absent → email reads degrade to `null`, claim resolution
   * reports `unavailable`, and the erasure `auth.users` delete is SKIPPED (the D1
   * erasure still commits, but the auth row survives; the skip is currently
   * unlogged — see the §8 note in `AUTH_AND_RLS.md`, tracked as AECI-531).
   */
  SUPABASE_SERVICE_ROLE_KEY?: string;
  /**
   * Deployment environment label. Each wrangler env block sets this explicitly
   * (`preview`/`staging`/`demo`/`production`); when unset (bare `wrangler dev`,
   * tests) both `/api/version` and the telemetry tags report `development` — one
   * convention for the unset state (AECI-119). `demo` + `production` are the two
   * public, non-Access-gated tiers (see `@aeci/shared/deploy-env`). `stage2` is
   * the TEMPORARY Stage 2 test tier (AECI-637) — Access-gated, so deliberately
   * NOT a public site; remove it from this union at teardown.
   */
  ENV?: 'development' | 'preview' | 'staging' | 'demo' | 'production' | 'stage2';
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
   * PostHog transport config (AECI-642 / `docs/POSTHOG_MIGRATION_SPEC.md` §AW1).
   *
   * `POSTHOG_PROJECT_KEY` is the PUBLISHABLE `phc_` project token — not a
   * secret, so it is a committed per-env **var** in `wrangler.jsonc` rather than
   * a `wrangler secret` (spec §3.2: keeping it a CI-pushed secret is what
   * produced the weeks-dark prod analytics of AECI-326). It authenticates all
   * three pipes (OTLP logs, OTLP metrics, `posthog-node` events), which takes
   * Worker telemetry secrets from 4 to 0. Absent → the whole transport is a
   * total no-op, so a keyless local Worker boots cleanly.
   *
   * `POSTHOG_HOST` is the **ingest** origin (`https://us.i.posthog.com`), NOT
   * the management API (`us.posthog.com`); swapping them 404s. Defaults to the
   * US ingest host when unset.
   *
   * Topology (spec §3.6 / D4): preview/staging/demo/stage2 carry the
   * `aec-integrations-dev` (525793) token; ONLY production carries
   * `aec-integrations` (354071).
   */
  POSTHOG_PROJECT_KEY?: string;
  POSTHOG_HOST?: string;
  /**
   * Bearer token gating `POST /api/promote` (the review-app push endpoint).
   * Set as a Wrangler secret per environment; absent → every promote request is
   * rejected 401 (fail-closed). Compared constant-time in `lib/review-auth.ts`.
   */
  REVIEW_APP_TOKEN?: string;
  /**
   * HMAC signing secret for the inbound Linear webhook (`POST /api/webhooks/
   * linear`, AECI-212). Set as a Wrangler secret per environment; absent → every
   * webhook is rejected 401 (fail-closed). Verified constant-time in
   * `lib/linear-webhook-auth.ts` against the `Linear-Signature` header.
   */
  LINEAR_WEBHOOK_SIGNING_SECRET?: string;
  /**
   * Cloudflare Workflow binding carrying the promote ingest (AECI-563 / ADR 0021).
   * `POST /api/promote` creates an instance whose **id is the caller-supplied job
   * id** — the kick-off idempotency key, since `create({ id })` throws on a
   * duplicate — and `GET /api/promote/jobs/:id` reads its status/output back.
   * One Workflow per environment (`aeci-promote-{preview,staging,demo,production}`),
   * like the queues, so environments never share instances.
   *
   * Optional because some test/tooling contexts construct a partial Env without a
   * binding. Absent → promote rejects `503 DEPENDENCY_FAILURE` (a configuration
   * fault, not a caller error); the poll degrades to the KV result mirror.
   */
  PROMOTE_WORKFLOW?: Workflow<PromoteWorkflowParams>;
  /**
   * KV namespace backing the promote job protocol (AECI-563). Two key spaces, both
   * defined in `lib/promote-jobs.ts`:
   *   - `promote:payload:{jobId}` (24h) — a validated bundle too large to inline into
   *     the Workflow event params, which the platform caps at 1 MiB. Staged here by
   *     the kick-off and read back by the Workflow's first step.
   *   - `promote:result:{jobId}` (90d) — the committed ID map, mirrored so it stays
   *     fetchable after the Workflow instance ages out of its 30-day retention.
   *
   * Own namespace per environment. Optional + degrading: absent → an oversize bundle
   * is rejected `413 PAYLOAD_TOO_LARGE` (rather than silently over-filling the params)
   * and the IDs are only fetchable for the instance retention window.
   */
  PROMOTE_KV?: KVNamespace;
  /**
   * KV namespace for `GET /api/taxonomy` read-through caching (AECI-54).
   * Optional: handler falls back to a direct D1 read when the binding is
   * absent (e.g. local `wrangler dev` without `--remote`). 5-minute TTL is
   * the staleness bound until admin/purge lands (Phase 2.10).
   */
  TAXONOMY_KV?: KVNamespace;
  /**
   * Cloudflare zone ID for `aecintegrations.com`. Public value, set per
   * environment as a Wrangler secret. Consumed (as the GraphQL `zoneTag`) by the
   * hourly AECI-262 WAF firewall-event poll (`scheduled.ts` `runWafMetricsJob`,
   * paired with `CF_ANALYTICS_API_TOKEN`). Optional: absent → the poll logs
   * `outcome:skipped_no_creds` and no-ops. (The promote's cache purge no longer
   * reads this — it enqueues onto the `aeci-cache-purge-{env}` Queue since WC-5;
   * the old zone HTTP purge + `CF_PURGE_API_TOKEN` were retired in WC-10.)
   */
  CF_ZONE_ID?: string;
  /**
   * Cloudflare API token used by the hourly WAF firewall-event poll
   * (`scheduled.ts` `runWafMetricsJob`, AECI-262 / §15.1) to read the zone's
   * `firewallEventsAdaptiveGroups` over the GraphQL Analytics API and emit the
   * `aeci.waf.ratelimit.blocked` count. Scope: `Zone Analytics: Read` on
   * `aecintegrations.com` — a narrow, read-only scope (distinct from the retired
   * `Zone.Cache Purge` purge token), so it is its own secret. One un-suffixed GH secret
   * covers the shared zone across all envs; CI pushes it per env (deploy.yml /
   * promote-to-demo.yml / promote-to-prod.yml — graceful warn-skip, no hard gate).
   * Optional + fail-safe: absent (with `CF_ZONE_ID`) → the poll logs
   * `outcome:skipped_no_creds` and no-ops (local/preview/pre-provisioning). See
   * `docs/waf-rate-limits.md` §5.
   */
  CF_ANALYTICS_API_TOKEN?: string;
  /**
   * IndexNow key for the post-promote URL submission (AECI-236, §20.2). Also the
   * contents of the `{key}.txt` verification file the SSR Worker serves at the
   * site root (`apps/web/src/server/routes/indexnow-key.ts`). Set as a Wrangler
   * secret. 8–128 chars of `[A-Za-z0-9-]`. Optional + fail-open: absent (with or
   * without `PUBLIC_SITE_URL`) → the promote IndexNow submission is a graceful
   * no-op (local `dev:bound` / PR previews / pre-launch).
   *
   * **Provision ONLY at public launch**, on the env whose web Worker has
   * `ALLOW_INDEXING="true"`. Pinging IndexNow for a `noindex` site (every env
   * pre-launch — `apps/web/wrangler.jsonc`) is a correctness bug; the secret's
   * absence is the enforcement.
   */
  INDEXNOW_KEY?: string;
  /**
   * Canonical public site origin (no trailing slash, e.g. `https://aecintegrations.com`),
   * SHARED by two features: the absolute URLs submitted to IndexNow on promote
   * (AECI-236) AND the absolute links built in transactional emails (the product
   * page in the review-approved email, the guidelines in the rejected email —
   * AECI-240). Public value, set as a plain wrangler `var` per env (like
   * `SUPABASE_URL`/`CF_ZONE_ID`). The API Worker is private — its own request URL
   * is NOT the public origin — so the canonical host must be configured here, not
   * derived from the request. Set it to the same host the SSR Worker serves at
   * launch (canonicals are self-referential to the serving origin, ADR 0011).
   * Absent → the IndexNow submission no-ops and email links are omitted (never a
   * dead host).
   */
  PUBLIC_SITE_URL?: string;
  /**
   * Google Indexing API service-account email (`client_email` from the SA JSON)
   * for the best-effort post-promote ping (AECI-263, §20.2). The `iss` of the
   * RS256 JWT the Worker signs to obtain an OAuth access token. Set as a Wrangler
   * secret. Optional + fail-open: absent (with or without
   * `GOOGLE_INDEXING_SA_PRIVATE_KEY` / `PUBLIC_SITE_URL`) → the promote Google
   * Indexing submission is a graceful no-op (local `dev:bound` / PR previews /
   * pre-launch).
   *
   * **Provision ONLY at public launch**, on the env whose web Worker has
   * `ALLOW_INDEXING="true"` — alongside `INDEXNOW_KEY`. Pinging Google for a
   * `noindex` site is a correctness bug; the secret's absence is the enforcement.
   */
  GOOGLE_INDEXING_SA_EMAIL?: string;
  /**
   * Google Indexing API service-account private key (`private_key` from the SA
   * JSON): a PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----`), RSA-2048. Signs the
   * assertion JWT (AECI-263). Set as a Wrangler secret; `\n`-escaped single-line
   * values are normalized to real newlines before import. Optional + fail-open
   * like `GOOGLE_INDEXING_SA_EMAIL` above — provision ONLY at launch.
   */
  GOOGLE_INDEXING_SA_PRIVATE_KEY?: string;
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
   * job (AECI-178 / Phase 4.3); `RECONCILE_QUEUE` carries the request→Linear
   * reconciliation sweep (AECI-214 / Phase 6.7). The Algolia bindings keep their
   * names — they *are* Algolia queues — but now carry the generic
   * `ScheduledJobMessage`.
   */
  ALGOLIA_SYNC_QUEUE?: Queue<ScheduledJobMessage>;
  ALGOLIA_DRIFT_QUEUE?: Queue<ScheduledJobMessage>;
  STATS_QUEUE?: Queue<ScheduledJobMessage>;
  RECONCILE_QUEUE?: Queue<ScheduledJobMessage>;
  /**
   * Queue carrying the daily §23.1 data-quality job (AECI-241 / Phase 7.6).
   * Same producer/consumer split as the others; absent on local/preview → the
   * cron runs the job inline (`enqueueOrRun`).
   */
  DATA_QUALITY_QUEUE?: Queue<ScheduledJobMessage>;
  /**
   * Queue carrying the daily §7 attestation detector sweep (AECI-302 /
   * `STAGE_2_ATTESTATIONS_SPEC.md` §7.4). Queue-backed rather than inline like the
   * read-only gauges because the job sends email and writes `audit_log`, so it
   * benefits from the consumer's native retries. Same producer/consumer split as
   * the others; absent on local/preview → the cron runs the job inline
   * (`enqueueOrRun`).
   */
  ATTESTATION_NOTIFY_QUEUE?: Queue<ScheduledJobMessage>;
  /**
   * Cloudflare Queue **producer** binding for cross-Worker cache-purge (WC-5 /
   * AECI-319 / ADR 0020 §3). The post-promote purge (`purgeAfterPromote`, the ordered
   * home-stats flow) and review moderation (`admin-reviews.ts`) enqueue a
   * {@link CachePurgeMessage} here; the **SSR Worker** consumes `aeci-cache-purge-{env}`
   * and issues `ctx.cache.purge()` from its own cache (the API Worker's zone-HTTP purge
   * is inert against native Workers Cache). Bound on staging + demo + production only
   * (the consumer binding lives in `apps/web/wrangler.jsonc`). Absent on local
   * `wrangler dev` / preview → the producers no-op gracefully (no edge cache there).
   */
  CACHE_PURGE_QUEUE?: Queue<CachePurgeMessage>;
  /**
   * Supabase project base URL (AECI-193 / Phase 5.2), e.g.
   * `https://<ref>.supabase.co`. Public value, set as a plain wrangler var per
   * env. Used ONLY to derive the JWKS endpoint
   * (`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`) and the expected `iss`
   * claim for user-JWT verification in `lib/user-auth.ts` — no DB round-trip,
   * no Supabase client on this Worker. Absent → `requireUserAuth()` rejects
   * every request 401 (fail-closed). The **anon key** is deliberately not bound
   * here: the API Worker verifies tokens with public JWKS material only
   * (AUTH_AND_RLS.md §4). The **service-role key** IS bound, separately, as
   * `SUPABASE_SERVICE_ROLE_KEY` — but only for the Admin-API split-identity seams
   * (AUTH_AND_RLS.md §3.1), never for token verification. This value is also the
   * Admin-API base URL those seams build on.
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
   * Retention-window overrides for the §7.4 pruning cron (AECI-584), in whole
   * days. UNSET on every tier — the reviewed defaults live in `@aeci/shared`
   * (`PAGE_VIEWS_RETENTION_DAYS` 400, `JOB_RUNS_RETENTION_DAYS` 90), and these
   * exist so §13 D5's figure can be **shortened** on one tier without a deploy.
   * Same declare-the-seam posture as `PAGE_VIEWS_MIN_BOT_SCORE` above.
   *
   * Parsed by `resolveRetentionDays` (`lib/retention-prune.ts`): must be a
   * finite integer `>= MIN_RETENTION_DAYS` (30 — D1 Time Travel's horizon).
   * Anything else is IGNORED and logged, not clamped: a typo'd `4` must fall
   * back to the reviewed default rather than quietly becoming the shortest legal
   * window, because the mistake it would cause is unrecoverable.
   *
   * Note these do NOT move `ADMIN_METRICS_MAX_DAYS` (a build-time constant), so
   * a shortened window leaves the admin API's query cap wider than what is
   * retained — which returns empty tails, not wrong numbers.
   */
  PAGE_VIEWS_RETENTION_DAYS?: string;
  JOB_RUNS_RETENTION_DAYS?: string;
  /**
   * Internal-traffic ASN list for the admin panel's read-time filter (AECI-574 /
   * `ADMIN_PANEL_SPEC.md` §13 **D10**). On 2026-08-10, 67 of the digest's 92
   * "human" page views came from the operator's own ISP (AS23700, Jakarta); this
   * is the coarse instrument for subtracting that. The precise ones are AECI-575
   * (exclude `/admin/*` from `PageViewTracker`) and AECI-585 (capture
   * `cf_as_organization` so the filter can label itself) — both shipped, though
   * the holder name is null on every row written before AECI-585 deployed and is
   * not backfillable.
   *
   * **QUERY-TIME ONLY — three binding constraints (D10):**
   *   1. It is a `WHERE` clause evaluated at read time. It must NEVER touch
   *      `is_bot`, NEVER run at ingest, and NEVER enter
   *      `scripts/ops/backfill-page-view-bots.sql`. This is a different kind of
   *      object from `DATACENTER_ASNS` (`lib/bot-classification.ts`), whose
   *      membership doctrine is strict precisely because it writes a permanent,
   *      unreviewable classification. A read-time filter is toggleable and
   *      reversible, so that doctrine does not transfer — keep the two lists
   *      separate concepts and do not merge them.
   *   2. Show BOTH numbers, never substitute. Every count the panel returns
   *      carries the unfiltered figure as its primary value.
   *   3. Declare the seam, ship it UNSET. Do not hardcode an ASN.
   *
   * Format: comma / semicolon / whitespace-separated ASNs, with an optional `AS`
   * prefix — `"AS23700, 4134"` and `"23700 4134"` are equivalent. Parsed
   * leniently by `parseInternalAsns` (`lib/internal-asns.ts`), mirroring the
   * `parseRecipients` splitter (`lib/email.ts`) — junk entries are dropped, not
   * fatal. Absent (the default on every tier) → the filter is **unavailable**,
   * `excluding_internal` is null everywhere, and the UI hides the toggle. Same
   * declare-the-seam posture as `PAGE_VIEWS_MIN_BOT_SCORE` above.
   */
  ANALYTICS_INTERNAL_ASNS?: string;
  /**
   * Anthropic API key for review toxicity scoring (AECI-258, supersedes the
   * AECI-198 / Phase 5.7 `PERSPECTIVE_API_KEY` — Google is sunsetting
   * Perspective). The Worker reads it at runtime to score review bodies via
   * Claude Haiku on `POST /api/reviews`. Set as a Wrangler secret per env.
   * Optional and **fail-open**: absent → `scoreToxicity()` is a silent no-op
   * that stores `null` (the expected state in local `dev:bound` / PR previews),
   * and any outage also stores `null` (logged `warn`) — the score only ever
   * *flags* the moderation queue, it never blocks a submission. See
   * `lib/toxicity.ts` and `STAGE_1_PHASE_5_SPEC.md` §5.3.
   *
   * **GDPR prerequisite:** the Messages API has no per-request no-store control,
   * so the Anthropic org behind this key **must** have zero data retention (ZDR)
   * enabled before a real key is set — otherwise scored review bodies are retained
   * ~30 days outside the `AUTH_AND_RLS.md` §8 erasure boundary.
   */
  ANTHROPIC_API_KEY?: string;
  /**
   * Linear personal API key for the form→Linear pipeline (AECI-211 / Phase 6.4).
   * Set as a Wrangler secret per env. Optional and **fail-open** (mirrors
   * `ANTHROPIC_API_KEY`): absent → `createLinearIssueForRequest()` is a silent
   * no-op (the expected state in local `dev:bound` / PR previews — the secret is
   * staging/prod only), so the request still returns `201` and its row simply sits
   * `open` with `linear_issue_id=null` for the reconciliation sweep (§6.7) to pick
   * up. Presented raw in the `Authorization` header (no `Bearer` prefix — Linear's
   * convention). See `lib/linear.ts` and `STAGE_1_PHASE_6_SPEC.md` §6.1/§6.2.
   */
  LINEAR_API_KEY?: string;
  /**
   * Recipient for the persistent-failure admin alert raised by the reconciliation
   * sweep (AECI-214 / Phase 6.7) — the `To:` address of the §6.2 admin email now
   * wired through Resend (`lib/email.ts`, AECI-240). Absent → the sweep's
   * `sendAdminAlert()` seam returns `'skipped'` and the **PostHog alert**
   * (`aeci.linear.reconcile.persistent_failure` + the `source:reconcile` error log)
   * is the guaranteed backstop (§6.2). Set as a plain wrangler var per env.
   */
  ADMIN_ALERT_EMAIL?: string;
  /**
   * Recipient for the operator "new vendor claim" alert — sent post-commit from
   * `POST /api/requests/claim` (`routes/requests.ts`). A SINGLE address, like
   * `ADMIN_ALERT_EMAIL` (the transactional transport passes `to` through to Resend
   * verbatim; only the `_TO` digest vars take a parsed list). Separate from
   * `ADMIN_ALERT_EMAIL` on purpose: claim intake
   * goes to the support inbox (`support@aecintegrations.com`), while
   * `ADMIN_ALERT_EMAIL` remains the individual operator address the sweep alerts and
   * lead-capture notifications use. Plain wrangler var per env. Absent → the alert is
   * a `skipped` no-op and the submit still returns `201` — the Linear issue
   * (§6.4) stays the durable record either way.
   */
  CLAIM_ALERT_EMAIL?: string;
  /**
   * Resend API key — the single transactional-email secret for the API Worker.
   * Powers BOTH the §11.1 transactional templates (AECI-240 / Phase 7.5 — review
   * submit/moderate, account delete, the reconcile-sweep admin alert) AND the daily
   * data-quality digest (AECI-241 / Phase 7.6, `sendEmail`). Set as a Wrangler
   * **secret** per env, staging/prod only. Optional and **fail-open** (mirrors
   * `ANTHROPIC_API_KEY`): absent → every `lib/email.ts` send is a silent `'skipped'`
   * (the expected state in local `dev:bound` / PR previews), so the triggering
   * action / cron still succeeds. The repo standardized on Resend over the spec's
   * original "Loops"; see `docs/email.md`. Presented as a Bearer token to Resend.
   */
  RESEND_API_KEY?: string;
  /**
   * Sender for the §11.1 transactional emails — the Resend `from` (AECI-240).
   * Accepts a bare address or a `Name <addr>` form (e.g.
   * `AEC Integrations <notifications@aecintegrations.com>`). Must be a verified
   * Resend domain. Absent → sends `'skipped'` (alongside an absent `RESEND_API_KEY`).
   * Set as a plain wrangler var per env. See `docs/email.md`.
   */
  EMAIL_FROM?: string;
  /**
   * Sender + recipient(s) for the data-quality digest (AECI-241). `_FROM` is a
   * single verified Resend sender; `_TO` is a comma/whitespace-separated list
   * (Chris + Bill), parsed by `parseRecipients` (`lib/email.ts`). Plain wrangler
   * vars per env. Either absent → the send is a `skipped` no-op.
   */
  DATA_QUALITY_EMAIL_FROM?: string;
  DATA_QUALITY_EMAIL_TO?: string;
  /**
   * Recipient(s) for the daily operator analytics digest (AECI-526). A
   * comma/whitespace-separated list parsed by `parseRecipients` (`lib/email.ts`);
   * the sender is the shared `EMAIL_FROM` (no separate `_FROM` — one verified
   * sender). Plain wrangler var. Set on **production only** — staging/demo run the
   * cron (for liveness) but intentionally leave this unset, so only prod's real
   * numbers are emailed; every other env (incl. local/preview) is `skipped`.
   * Absent → the digest send is a `skipped` no-op, so the cron still runs and
   * emits its outcome metric. See `scheduled.ts` `runAnalyticsDigestJob` +
   * `docs/email.md`.
   */
  ANALYTICS_DIGEST_EMAIL_TO?: string;
};
