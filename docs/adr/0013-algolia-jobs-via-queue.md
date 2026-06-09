# ADR 0013: Daily Algolia jobs run via a queue (cron enqueues, a consumer executes)

**Status:** Accepted
**Date:** 2026-06-09
**Context owner:** chrisw@thewbsproject.com
**Relates to:** AECI-139 (incremental sync), AECI-140 (index-drift reconcile); revisits the "Cloudflare Queue deferred" posture of ADR 0010

---

## Context

The API Worker runs two daily Algolia jobs, registered as cron triggers in `apps/api/wrangler.jsonc` (staging + production only):

- **08:00 UTC (= 03:00 EST)** — incremental sync (`src/lib/algolia-sync.ts`), and
- **09:00 UTC (= 04:00 EST)** — index-drift reconciliation (`src/lib/algolia-drift.ts`).

Originally the `scheduled()` handler ran the work **inline**: `controller.cron` selected the function and awaited it in the cron invocation. That works, but couples scheduling to execution — the cron tick is the only producer, there is no separate retry surface, and forcing a run on demand has no natural entry point.

The decision owner's stated preference is that recurring jobs be structured as **cron → enqueue → consume**: the cron is only a scheduler that drops a message; a queue consumer does the work. This is a deliberate revisit of ADR 0010's "a Cloudflare Queue is the deferred evolution" note — adopted here for the Algolia jobs specifically (not the promote-purge path, which stays direct).

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

This narrows ADR 0010's deferral: a Queue is now used for the Algolia jobs. The promote→purge path remains a direct Cloudflare call (ADR 0010 Option B) — unchanged.
