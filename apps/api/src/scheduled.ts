/**
 * Scheduled-job entrypoints for the API Worker (AECI-139 / Phase 3.6 + AECI-140 /
 * Phase 3.7). Two handlers, deliberately split:
 *
 *   • `scheduled` — the cron trigger. It does NOT run the work; it only enqueues
 *     a `ScheduledJobMessage` onto the matching Cloudflare Queue (`enqueueOrRun`).
 *   • `queue` — the consumer. It receives the message and runs the actual job.
 *
 * This cron→queue→consumer split (ADR 0013) decouples scheduling from execution:
 * the queue gives native retries, and the same queue can be fed by a future
 * manual/REST producer to force a run on demand. Both queues are bound per-env in
 * `wrangler.jsonc` (staging + production only — NOT base config / preview, so PR
 * previews carry no queues and run no daily jobs). On an env without the binding
 * (local `wrangler dev`, preview), `enqueueOrRun` runs the job inline so a
 * `--test-scheduled` tick is never silently dropped.
 *
 * Cron triggers (`wrangler.jsonc`), staging + production:
 * 07:00 UTC (= 02:00 EST) — daily home-stats compute (`./lib/home-stats`,
 * AECI-178 / Phase 4.3 / §10): recompute the seven `home.*` `stats_cache` keys
 * and upsert each. Runs before the Algolia sync so a fresh stats row is ready at
 * the start of the US morning. Per-key best-effort (one key failing doesn't abort
 * the rest); empty `page_views` → empty `trending_products`.
 * 08:00 UTC (= 03:00 EST) — incremental Algolia sync (`./lib/algolia-sync`,
 * AECI-139): push rows changed since the stored watermark to the env's three
 * indexes, removing `retracted`/`rejected` records. The full reindex is the
 * separate AECI-138 CLI; this keeps the index fresh between those.
 * 09:00 UTC (= 04:00 EST) — Algolia ↔ Supabase index-drift reconciliation
 * (`./lib/algolia-drift`, AECI-140 / §23.1): compare promoted-row counts to
 * Algolia object counts per entity and emit the `aeci.algolia.index_drift` gauge.
 * Report-only — no auto-remediation; the alert is the Datadog monitor
 * (`observability/datadog/monitor-algolia-index-drift.json`). Re-run the AECI-138
 * bulk sync to repair.
 * Every 15 minutes (the one sub-hourly trigger; see `RECONCILE_CRON`) —
 * request→Linear reconciliation sweep (`./lib/reconciliation-sweep`, AECI-214 /
 * Phase 6.7 / §6.2/§6.4): retry `vendor_requests` stuck
 * `open`/`linear_issue_id=null` (their §6.4 on-submit issue creation failed), and
 * on a persistent failure raise the §6.2 admin alert. A tight backstop, not a
 * daily batch.
 *
 * Best-effort + observable: the work is **awaited** in the consumer (so a failure
 * is logged and the run isn't torn down mid-batch), while metric/log emission
 * rides `ctx.waitUntil` via the shared Datadog client. The job has no incoming
 * `Request`, so a synthetic one is passed to the Datadog helpers (used only to
 * derive the `host` tag, which falls back to the worker slug).
 */

import type { AlgoliaEnv } from '@aeci/shared/algolia';

import { logToDatadog, submitCount, submitDistribution, submitGauge } from './datadog';
import type { ScheduledJob, ScheduledJobMessage, ScheduledJobMessageInput, Env } from './env';
import {
  createAlgoliaCounter,
  reportAlgoliaDrift,
  type AlgoliaIndexDrift,
  type DriftCountPrisma,
} from './lib/algolia-drift';
import { runDailySync, type AlgoliaSyncPrisma } from './lib/algolia-sync';
import { emitAlgoliaSyncMetrics, type SyncMetricSink } from './lib/algolia-sync-metrics';
import { runHomeStats, type HomeStatsPrisma, type HomeStatsResult } from './lib/home-stats';
import { emitHomeStatsMetrics } from './lib/home-stats-metrics';
import {
  emitModerationQueueMetrics,
  oldestPendingAgeHours,
  type ModerationMetricSink,
} from './lib/moderation-metrics';
import { runReconciliationSweep, type ReconcilePrisma } from './lib/reconciliation-sweep';
import { getPrisma } from './prisma';

/** Cron expression for the daily incremental Algolia sync (`wrangler.jsonc`).
 *  08:00 UTC = 03:00 EST (US-East, our launch customer base). Cloudflare cron
 *  is UTC-only / DST-unaware, so this is 04:00 EDT in summer — both dead-of-night
 *  in the US, deliberately accepted (no per-season retune). MUST stay byte-equal
 *  to the `triggers.crons` entry in `wrangler.jsonc` or `controller.cron` won't
 *  match the `switch` below. */
const ALGOLIA_SYNC_CRON = '0 8 * * *';

/** Cron expression for the daily index-drift check (`wrangler.jsonc`).
 *  09:00 UTC = 04:00 EST — kept one hour after the sync so reconciliation reads
 *  a settled index. MUST stay byte-equal to `wrangler.jsonc` (see sync note). */
const ALGOLIA_DRIFT_CRON = '0 9 * * *';

/** Cron expression for the daily home-stats compute (`wrangler.jsonc`, AECI-178).
 *  07:00 UTC = 02:00 EST — one hour before the Algolia sync, so the `home.*`
 *  `stats_cache` rows are fresh at the start of the US morning. MUST stay
 *  byte-equal to `wrangler.jsonc` (see sync note). */
const STATS_CRON = '0 7 * * *';

/** Cron expression for the daily moderation-queue health snapshot (`wrangler.jsonc`,
 *  AECI-206). 06:00 UTC (= 01:00 EST) — one hour before the home-stats cron, in the
 *  same dead-of-night daily window. A cheap read-only gauge (no queue / ADR 0013
 *  consumer — `queueForJob` returns `undefined`, so it always runs inline). MUST
 *  stay byte-equal to the `triggers.crons` entry in `wrangler.jsonc`. */
const MODERATION_CRON = '0 6 * * *';

/** Cron expression for the request→Linear reconciliation sweep (`wrangler.jsonc`,
 *  AECI-214 / Phase 6.7). **Every 15 minutes** — unlike the daily batch jobs, this
 *  is a tight backstop: a request whose §6.4 on-submit issue creation failed is
 *  retried within ~15 min. Queue-backed (ADR 0013) so it gets native retries. MUST
 *  stay byte-equal to the `triggers.crons` entry in `wrangler.jsonc`. */
const RECONCILE_CRON = '*/15 * * * *';

/** The gauge a Datadog monitor alerts on (see docs/OBSERVABILITY.md). */
const DRIFT_METRIC = 'aeci.algolia.index_drift';

/** Synthetic request so the Datadog helpers can derive a `host` tag (the cron
 *  has no incoming Request; `hostnameFromRequest` uses the URL host or falls
 *  back to the worker slug). */
function cronRequest(path: string): Request {
  return new Request(`https://aeci-api${path}`);
}

/** Map the Worker `ENV` var to the Algolia env (unset → `development`, which
 *  folds onto the preview index set — same convention as `/api/version`). */
function algoliaEnvFor(env: Env): AlgoliaEnv {
  return env.ENV ?? 'development';
}

/** Adapt the shared Datadog submitters into the pure metrics modules' sink, so
 *  `emitAlgoliaSyncMetrics` / `emitHomeStatsMetrics` / `emitModerationQueueMetrics`
 *  stay free of `ctx`/`env`/`Request` plumbing. The count + distribution + gauge
 *  shape satisfies `SyncMetricSink` / `StatsMetricSink` (count + distribution) and
 *  `ModerationMetricSink` (gauge) alike. */
function metricSink(
  ctx: ExecutionContext,
  env: Env,
  req: Request,
): SyncMetricSink & ModerationMetricSink {
  return {
    count: (metric, value, tags) => submitCount(ctx, env, req, metric, value, tags),
    distribution: (metric, value, tags) => submitDistribution(ctx, env, req, metric, value, tags),
    gauge: (metric, value, tags) => submitGauge(ctx, env, req, metric, value, tags),
  };
}

async function runAlgoliaSync(env: Env, ctx: ExecutionContext): Promise<void> {
  const req = cronRequest('/cron/algolia-sync');
  const creds = { appId: env.ALGOLIA_APP_ID, apiKey: env.ALGOLIA_ADMIN_KEY };

  // Defensive no-op: production deploys are gated on these secrets
  // (verify-worker-secrets.sh), but local/preview may legitimately lack them.
  if (!creds.appId || !creds.apiKey) {
    submitCount(ctx, env, req, 'aeci.algolia.sync', 1, [
      'trigger:cron',
      'entity:all',
      'outcome:skipped_no_creds',
    ]);
    logToDatadog(ctx, env, req, {
      level: 'warn',
      message: 'aeci.algolia.sync.skipped_no_creds',
      source: 'algolia-sync-cron',
    });
    return;
  }

  const prisma = getPrisma(env) as unknown as AlgoliaSyncPrisma;

  const started = Date.now();
  let result: Awaited<ReturnType<typeof runDailySync>>;
  try {
    result = await runDailySync(prisma, fetch, creds, algoliaEnvFor(env), new Date());
  } catch (error) {
    // runDailySync swallows per-entity push failures, but the watermark
    // read/write (Prisma/Accelerate) can still throw — log loudly, never rethrow
    // (a thrown cron just shows as a failed invocation with no detail). This is
    // a pre-push crash, not a completed run, so it stays inline rather than going
    // through emitAlgoliaSyncMetrics (which is per-entity, completed-run only).
    submitCount(ctx, env, req, 'aeci.algolia.sync', 1, [
      'trigger:cron',
      'entity:all',
      'outcome:failed',
    ]);
    logToDatadog(ctx, env, req, {
      level: 'error',
      message: 'aeci.algolia.sync.crashed',
      source: 'algolia-sync-cron',
      reason: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  // Per-entity outcome + records counts and the run-level duration distribution
  // (AECI-141). Shared with the promote hook so the two writers can't drift.
  emitAlgoliaSyncMetrics(metricSink(ctx, env, req), 'cron', result.entities, Date.now() - started);

  for (const entity of result.entities) {
    logToDatadog(ctx, env, req, {
      level: entity.ok ? 'info' : 'error',
      message: `aeci.algolia.sync ${entity.entity} saved=${entity.saved} deleted=${entity.deleted}`,
      source: 'algolia-sync-cron',
      entity: entity.entity,
      saved: entity.saved,
      deleted: entity.deleted,
      transform_errors: entity.transformErrors,
      ...(entity.ok ? {} : { reason: entity.error }),
    });
  }
}

async function runAlgoliaDrift(env: Env, ctx: ExecutionContext): Promise<void> {
  const req = cronRequest('/cron/algolia-drift');

  // Defensive no-op: production deploys are gated on these secrets
  // (verify-worker-secrets.sh), but local/preview may legitimately lack them.
  if (!env.ALGOLIA_APP_ID || !env.ALGOLIA_ADMIN_KEY) {
    logToDatadog(ctx, env, req, {
      level: 'warn',
      message: 'aeci.algolia.index_drift.skipped_no_creds',
      source: 'algolia-drift-cron',
    });
    return;
  }

  const prisma = getPrisma(env) as unknown as DriftCountPrisma;
  const algolia = createAlgoliaCounter(env.ALGOLIA_APP_ID, env.ALGOLIA_ADMIN_KEY);
  const ddEnv = algoliaEnvFor(env);

  try {
    await reportAlgoliaDrift(
      {
        prisma,
        algolia,
        // Gauge per entity, always (0 when clean) so a no-data monitor can tell
        // "ran clean" from "didn't run".
        emitGauge: (row: AlgoliaIndexDrift) =>
          submitGauge(ctx, env, req, DRIFT_METRIC, row.drift, [
            `entity:${row.entity}`,
            `index:${row.indexName}`,
          ]),
        onDrift: (drifted: AlgoliaIndexDrift[]) =>
          logToDatadog(ctx, env, req, {
            level: 'error',
            message: `aeci.algolia.index_drift on ${ddEnv}: ${drifted
              .map((d) => `${d.indexName} ${d.drift > 0 ? '+' : ''}${d.drift}`)
              .join(', ')} (report-only; re-run the bulk sync to repair)`,
            source: 'algolia-drift-cron',
            drift: drifted,
          }),
      },
      { env: ddEnv },
    );
  } catch (error) {
    // The Algolia count (fetch) or the Prisma counts can throw; log loudly,
    // never rethrow (a thrown cron just shows as a failed invocation with no
    // detail).
    logToDatadog(ctx, env, req, {
      level: 'error',
      message: 'aeci.algolia.index_drift.crashed',
      source: 'algolia-drift-cron',
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runHomeStatsJob(env: Env, ctx: ExecutionContext): Promise<void> {
  const req = cronRequest('/cron/stats');
  const prisma = getPrisma(env) as unknown as HomeStatsPrisma;

  const started = Date.now();
  let result: HomeStatsResult;
  try {
    result = await runHomeStats(prisma, new Date());
  } catch (error) {
    // `runHomeStats` is per-key best-effort and never throws on a compute/write
    // failure, so reaching here is a pre-compute crash (e.g. Prisma client init).
    // Log loudly + count an outright failure; never rethrow (a thrown cron is an
    // opaque failed invocation with no detail).
    submitCount(ctx, env, req, 'aeci.stats.compute', 1, ['trigger:cron', 'outcome:failed']);
    logToDatadog(ctx, env, req, {
      level: 'error',
      message: 'aeci.stats.compute.crashed',
      source: 'stats-cron',
      reason: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const written = result.keys.filter((k) => k.status === 'written').length;
  const failed = result.keys.filter((k) => k.status === 'failed').length;
  const skipped = result.keys.filter((k) => k.status === 'skipped').length;

  for (const k of result.keys) {
    logToDatadog(ctx, env, req, {
      level: k.status === 'failed' ? 'error' : 'info',
      message: `aeci.stats.compute ${k.key} status=${k.status}`,
      source: 'stats-cron',
      key: k.key,
      status: k.status,
      ...(k.error ? { reason: k.error } : {}),
    });
  }

  // Job-level + per-key outcome/duration metrics (AECI-180 / 4.5) — the dashboard
  // and the failure + freshness monitors query these. The shared emitter derives
  // the run `outcome` from the per-key statuses so it can't drift from the log.
  emitHomeStatsMetrics(metricSink(ctx, env, req), 'cron', result, Date.now() - started);
  logToDatadog(ctx, env, req, {
    level: failed > 0 ? 'warn' : 'info',
    message: `aeci.stats.computed keys_written=${written} keys_failed=${failed} keys_skipped=${skipped}`,
    source: 'stats-cron',
    keys_written: written,
    keys_failed: failed,
    keys_skipped: skipped,
  });
}

/** Loose structural Prisma surface for the moderation-queue snapshot — a count
 *  plus the oldest pending row's `created_at`. A real accelerated client
 *  satisfies it (cf. the loose surfaces in `routes/admin-reviews.ts`). */
type ModerationQueuePrisma = {
  review: {
    count(args: { where: { status: string } }): Promise<number>;
    findFirst(args: {
      where: { status: string };
      orderBy: { createdAt: 'asc' };
      select: { createdAt: true };
    }): Promise<{ createdAt: Date } | null>;
  };
};

/** Snapshot the pending-review moderation queue and emit its health gauges
 *  (AECI-206 / Phase 5.15): depth + oldest-pending age. Report-only — like the
 *  index-drift check it never mutates; the alert is the Datadog "moderation
 *  backlog" monitor. Two cheap indexed reads, so it runs inline (no queue). */
async function runModerationQueueMetrics(env: Env, ctx: ExecutionContext): Promise<void> {
  const req = cronRequest('/cron/moderation-queue');
  const prisma = getPrisma(env) as unknown as ModerationQueuePrisma;

  try {
    const [pendingCount, oldest] = await Promise.all([
      prisma.review.count({ where: { status: 'pending' } }),
      prisma.review.findFirst({
        where: { status: 'pending' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);
    const ageHours = oldestPendingAgeHours(
      pendingCount,
      oldest ? oldest.createdAt.getTime() : null,
      Date.now(),
    );
    emitModerationQueueMetrics(metricSink(ctx, env, req), {
      pendingCount,
      oldestPendingAgeHours: ageHours,
    });
    logToDatadog(ctx, env, req, {
      level: 'info',
      message: `aeci.moderation.queue depth=${pendingCount} oldest_age_hours=${ageHours.toFixed(2)}`,
      source: 'moderation-cron',
    });
  } catch (error) {
    // Mirror the drift/stats crash path: log loudly, never throw (a failed cron
    // must not tear down the invocation).
    logToDatadog(ctx, env, req, {
      level: 'error',
      message: 'aeci.moderation.queue.crashed',
      source: 'moderation-cron',
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Run the request→Linear reconciliation sweep (AECI-214 / Phase 6.7): retry
 *  `vendor_requests` stuck `open`/`linear_issue_id=null` and alert on persistent
 *  failures. `getPrisma()` is outside any try (a client-init throw propagates to
 *  the consumer's `retry()`, mirroring `runAlgoliaSync`); the sweep's own
 *  unexpected read failures likewise propagate so the queue re-runs it (idempotent
 *  via `createLinearIssueForRequest`). */
async function runReconcileJob(env: Env, ctx: ExecutionContext): Promise<void> {
  const req = cronRequest('/cron/reconcile');
  const prisma = getPrisma(env) as unknown as ReconcilePrisma;
  await runReconciliationSweep({ env, executionCtx: ctx, req: { raw: req } }, prisma);
}

/** The producer queue binding for a job (absent on local/preview → inline run). */
function queueForJob(env: Env, job: ScheduledJob): Queue<ScheduledJobMessage> | undefined {
  switch (job) {
    case 'sync':
      return env.ALGOLIA_SYNC_QUEUE;
    case 'drift':
      return env.ALGOLIA_DRIFT_QUEUE;
    case 'stats':
      return env.STATS_QUEUE;
    case 'reconcile':
      return env.RECONCILE_QUEUE;
    case 'moderation':
      // Queue-less by design: a cheap read-only gauge needs no retry/queue, so it
      // always runs inline (AECI-206). No `MODERATION_QUEUE` binding exists.
      return undefined;
  }
}

/** Cron path + log identifiers for a job's enqueue-failure log. `sync`/`drift`
 *  live under the `algolia` domain (unchanged); `stats` under its own. */
function enqueueFailureLog(job: ScheduledJob): { path: string; message: string; source: string } {
  if (job === 'stats') {
    return { path: '/cron/stats', message: 'aeci.stats.enqueue_failed', source: 'stats-cron' };
  }
  if (job === 'moderation') {
    // Unreachable in practice (moderation is queue-less, so `queue.send` is never
    // called) — kept so the mapping is total over `ScheduledJob`.
    return {
      path: '/cron/moderation-queue',
      message: 'aeci.moderation.queue.enqueue_failed',
      source: 'moderation-cron',
    };
  }
  if (job === 'reconcile') {
    return {
      path: '/cron/reconcile',
      message: 'aeci.linear.reconcile.enqueue_failed',
      source: 'reconcile',
    };
  }
  return {
    path: `/cron/algolia-${job}`,
    message: `aeci.algolia.${job}.enqueue_failed`,
    source: `algolia-${job}-cron`,
  };
}

/** Run a job, or — preferably — enqueue it. On staging/production the matching
 *  queue binding is present, so we `send` a message and return immediately; the
 *  `queue` consumer below does the work (ADR 0013). On an env without the binding
 *  (local `wrangler dev`, preview) there is no queue, so run inline — a
 *  `--test-scheduled` tick must never be silently dropped. */
async function enqueueOrRun(env: Env, ctx: ExecutionContext, job: ScheduledJob): Promise<void> {
  const queue = queueForJob(env, job);
  if (queue) {
    const message: ScheduledJobMessage = {
      job,
      trigger: 'cron',
      enqueuedAt: new Date().toISOString(),
    };
    try {
      await queue.send(message);
      return;
    } catch (error) {
      // `queue.send` can reject (transient queue error / throttling, or a
      // deleted/missing queue). Don't let it escape as an opaque failed-cron
      // with no detail — log loudly (as the job impls do) and fall through to
      // an inline run so the scheduled tick is never silently dropped.
      const log = enqueueFailureLog(job);
      logToDatadog(ctx, env, cronRequest(log.path), {
        level: 'error',
        message: log.message,
        source: log.source,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    console.warn(`scheduled: no queue binding for "${job}" — running inline (local/preview)`);
  }
  await runScheduledJob(env, ctx, job);
}

/** Dispatch a job kind to its implementation. Shared by the inline fallback and
 *  the queue consumer so both paths stay identical. */
async function runScheduledJob(env: Env, ctx: ExecutionContext, job: ScheduledJob): Promise<void> {
  switch (job) {
    case 'sync':
      await runAlgoliaSync(env, ctx);
      return;
    case 'drift':
      await runAlgoliaDrift(env, ctx);
      return;
    case 'stats':
      await runHomeStatsJob(env, ctx);
      return;
    case 'moderation':
      await runModerationQueueMetrics(env, ctx);
      return;
    case 'reconcile':
      await runReconcileJob(env, ctx);
      return;
  }
}

/**
 * Worker `scheduled` handler — the cron trigger. It does not run the work; it
 * enqueues the job (see `enqueueOrRun` / ADR 0013). Dispatches on the cron
 * expression so additional scheduled jobs register their own trigger + case
 * without a second Worker.
 */
export const scheduled: ExportedHandlerScheduledHandler<Env> = async (controller, env, ctx) => {
  switch (controller.cron) {
    case STATS_CRON:
      await enqueueOrRun(env, ctx, 'stats');
      return;
    case ALGOLIA_SYNC_CRON:
      await enqueueOrRun(env, ctx, 'sync');
      return;
    case ALGOLIA_DRIFT_CRON:
      await enqueueOrRun(env, ctx, 'drift');
      return;
    case MODERATION_CRON:
      await enqueueOrRun(env, ctx, 'moderation');
      return;
    case RECONCILE_CRON:
      await enqueueOrRun(env, ctx, 'reconcile');
      return;
    default:
      // A trigger fired with no matching case — surface it rather than silently
      // doing nothing (e.g. a wrangler.jsonc cron added without a handler).
      console.warn(`scheduled: no handler for cron "${controller.cron}"`);
  }
};

/**
 * Fill in the properties an out-of-band queue message can omit. The cron
 * producer (`enqueueOrRun`) always stamps `trigger` + `enqueuedAt`, but an
 * operator force-run — a Cloudflare Queues REST push of just `{ "job": "stats" }`
 * (ADR 0013) — does not. The consumer implies them after the fact: a body with
 * no `trigger` was not enqueued by the cron, so it's `'manual'`; `enqueuedAt`
 * falls back to when the queue received the message. Pure + exported so the
 * contract is unit-tested directly.
 */
export function normalizeJobMessage(
  body: ScheduledJobMessageInput,
  receivedAt: string,
): ScheduledJobMessage {
  return {
    job: body.job,
    trigger: body.trigger ?? 'manual',
    enqueuedAt: body.enqueuedAt ?? receivedAt,
  };
}

/**
 * Worker `queue` consumer — runs the actual scheduled job for each message the
 * cron `scheduled` handler enqueued (ADR 0013). Bound to every job queue in
 * `wrangler.jsonc`; `batch.queue` would distinguish them, but the message body's
 * `job` is authoritative. Messages may also be pushed out-of-band (an operator
 * force-run sending just `{ job }`); `normalizeJobMessage` implies the missing
 * `trigger` / `enqueuedAt`. Batches are size-1 (each job is a singleton), so this
 * loops at most once per invocation. The job impls (`runAlgoliaSync`,
 * `runAlgoliaDrift`, `runHomeStatsJob`) swallow their own operational errors
 * (logging to Datadog), so reaching the `catch` means an unexpected throw (e.g.
 * Prisma client init) — `retry()` it per the consumer's `max_retries`; everything
 * else `ack()`s.
 */
export const queue: ExportedHandlerQueueHandler<Env, ScheduledJobMessageInput> = async (
  batch,
  env,
  ctx,
) => {
  for (const message of batch.messages) {
    const { job, trigger } = normalizeJobMessage(message.body, message.timestamp.toISOString());
    try {
      await runScheduledJob(env, ctx, job);
      message.ack();
    } catch (error) {
      console.error(
        `queue: scheduled job "${job}" (trigger=${trigger}) threw on ${batch.queue} (retrying):`,
        error instanceof Error ? error.message : String(error),
      );
      message.retry();
    }
  }
};
