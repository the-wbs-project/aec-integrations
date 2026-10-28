# ADR 0013: Daily Algolia jobs run via a queue (cron enqueues, a consumer executes)

**Status:** Accepted
**Date:** 2026-06-09
**Context owner:** chrisw@thewbsproject.com
**Relates to:** AECI-139 (incremental sync), AECI-140 (index-drift reconcile); revisits the "Cloudflare Queue deferred" posture of ADR 0028 (numbered 0010 when this ADR was written)

---

## Context

The API Worker runs two daily Algolia jobs, registered as cron triggers in `apps/api/wrangler.jsonc` (staging + production only):

- **08:00 UTC (= 03:00 EST)** — incremental sync (`src/lib/algolia-sync.ts`), and
- **09:00 UTC (= 04:00 EST)** — index-drift reconciliation (`src/lib/algolia-drift.ts`).

Originally the `scheduled()` handler ran the work **inline**: `controller.cron` selected the function and awaited it in the cron invocation. That works, but couples scheduling to execution — the cron tick is the only producer, there is no separate retry surface, and forcing a run on demand has no natural entry point.

The decision owner's stated preference is that recurring jobs be structured as **cron → enqueue → consume**: the cron is only a scheduler that drops a message; a queue consumer does the work. This is a deliberate revisit of ADR 0028's "a Cloudflare Queue is the deferred evolution" note — adopted here for the Algolia jobs specifically (not the promote-purge path, which stays direct).

## Decision

- Add two Cloudflare Queues **per environment**: `aeci-algolia-sync-<env>` and `aeci-algolia-drift-<env>` (staging + production → four queues). Names, not IDs, so nothing is hardcoded beyond the name.
- The API Worker is **both producer and consumer** of these queues (self-consume). Producer bindings `ALGOLIA_SYNC_QUEUE` / `ALGOLIA_DRIFT_QUEUE` and the matching `consumers` entries live on the `staging` + `production` env blocks of `apps/api/wrangler.jsonc` — **not** the base config or `preview`, exactly mirroring where the cron triggers live (so PR-preview Workers carry no queues and run no daily jobs).
- The cron `scheduled()` handler no longer runs work inline. It calls `enqueueOrRun(env, ctx, job)`, which `queue.send()`s a typed `AlgoliaJobMessage` (`{ job, trigger, enqueuedAt }`) and returns.
- A new `queue()` consumer handler (`src/scheduled.ts`, exported from `src/index.ts`) receives each message and runs the job via the shared `runAlgoliaJob()` dispatcher — the **same** code path the inline fallback uses, so behaviour is identical regardless of entry point.
- **Inline fallback:** on an env without the queue binding (local `wrangler dev`, preview), `enqueueOrRun` runs the job inline. This keeps `wrangler dev --test-scheduled` working and guarantees a scheduled tick is never silently dropped.
- **Consumer config:** `max_batch_size: 1` (each job is a singleton), `max_concurrency: 1`, `max_retries: 3`. The jobs are idempotent (sync upserts by `objectID`; drift is read-only), so retries are safe. The implementations swallow their own operational errors (logging to Datadog), so the consumer only `retry()`s on an *unexpected* throw (e.g. Prisma client init) and `ack()`s otherwise.
- **Provisioning:** the four queues are created by an idempotent `wrangler queues create` step in `deploy.yml` (staging) and `promote-to-prod.yml` (production), run **before** the API deploy — a `queues.consumers` binding to a non-existent queue fails the deploy.

## Consequences

- ➕ Scheduling is decoupled from execution. The cron is a thin producer; the consumer owns the work and gets queue-native retries.
- ➕ A natural **force-run** entry point exists: anything that can `send()` to the queue (a future admin route / REST producer, message `trigger: 'manual'`) triggers a run without waiting for the cron.
- ➕ The inline fallback means local/preview behaviour is unchanged and testable; no queue infra needed to run the job in dev.
- ➖ **New infra + two prerequisites.** Cloudflare Queues require the **Workers Paid** plan, and the CI `CLOUDFLARE_API_TOKEN` must carry the **Queues edit** permission — or both the `wrangler queues create` step and the Worker deploy (consumer binding) fail. These are one-time account/token changes, flagged in `docs/environments.md` and `docs/CICD_PLAN.md`.
- ➖ More moving parts than inline: a cron tick now spans two invocations (producer + consumer). The cron trigger is still required — Queues do not schedule — so this adds a hop rather than replacing the cron.
- ➖ No dead-letter queue yet: after `max_retries` a message is dropped. Acceptable because the daily cadence re-runs the job and the drift monitor (`aeci.algolia.index_drift`) catches a missed sync independently. Add a DLQ if that proves insufficient.
- ↔ The `aeci.algolia.sync` / `aeci.algolia.index_drift` metrics are emitted from the consumer now instead of the cron invocation; tag values (`trigger:cron`) are unchanged, so dashboards/monitors are unaffected.

This narrows ADR 0028's deferral: a Queue is now used for the Algolia jobs. The promote→purge path remains a direct Cloudflare call (ADR 0028 Option B) — unchanged.

**Amendment 2026-10-10 (AECI-1268):** There is no `preview` env block any more. The top-level `apps/api/wrangler.jsonc` block is local-dev config with no queue bindings, so the inline fallback still covers it. The Algolia sync job and the drift job's orphan sweep also no-op on a non-staging/demo/production `ENV` unless `ALGOLIA_ALLOW_LOCAL_WRITES=true` (`apps/api/src/lib/algolia-write-guard.ts`).

**Amendment 2026-10-23 (AECI-1423):** The inline fallback no longer means "local". Twelve of the 21 jobs are queue-less by design, each with its reason on its `queueForJob` case, so they run inline on every tier. `queueForJob` now returns `QUEUE_LESS` for them and `undefined` only when a queue-backed job's binding is absent. `enqueueOrRun` logs the three paths apart: an info line for a queue-less job, the error `aeci.scheduled.queue_binding_missing` to PostHog for a missing binding on staging, demo or production, and the plain "(local)" warning for a missing binding on local dev. "Deployed" uses the same allowlist as the Algolia write guard (`isDeployedTier`). Before this, every deployed tick of a queue-less job warned "(local)", which would have hid a real missing binding. Every path still runs the job, so a tick is never dropped.

**Amendment 2026-10-28 (AECI-1509):** `STATS_QUEUE` now also carries an event-driven message. A successful promote sends `{ job: 'stats', trigger: 'promote' }` with a 60 s delay, so `ScheduledJobMessage.trigger` gains `'promote'`. The consumer routes that message to `runDebouncedHomeStats` (`apps/api/src/lib/home-stats-refresh.ts`), not `runScheduledJob`. It writes no `job_runs` row, because the promote refresh never did and one row per promote would bury the 07:00 cron's own record. Queues have no dedupe, so a `stats_cache` watermark (`home_stats_refreshed_at`, the last run's start) does it: the consumer recomputes only when no run has started since the message's `enqueuedAt`. The cron message is unchanged and never touches that watermark.
