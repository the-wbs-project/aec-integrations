/**
 * Scheduled-job entrypoints for the API Worker (AECI-139 / Phase 3.6 + AECI-140 /
 * Phase 3.7). Two handlers, deliberately split:
 *
 *   • `scheduled` — the cron trigger. It does NOT run the work; it only enqueues
 *     a `AlgoliaJobMessage` onto the matching Cloudflare Queue (`enqueueOrRun`).
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
 *
 * Best-effort + observable: the work is **awaited** in the consumer (so a failure
 * is logged and the run isn't torn down mid-batch), while metric/log emission
 * rides `ctx.waitUntil` via the shared Datadog client. The job has no incoming
 * `Request`, so a synthetic one is passed to the Datadog helpers (used only to
 * derive the `host` tag, which falls back to the worker slug).
 */

import type { AlgoliaEnv } from '@aeci/shared/algolia';

import { logToDatadog, submitCount, submitGauge } from './datadog';
import type { AlgoliaJob, AlgoliaJobMessage, Env } from './env';
import {
  createAlgoliaCounter,
  reportAlgoliaDrift,
  type AlgoliaIndexDrift,
  type DriftCountPrisma,
} from './lib/algolia-drift';
import { runDailySync, type AlgoliaSyncPrisma } from './lib/algolia-sync';
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

  let result: Awaited<ReturnType<typeof runDailySync>>;
  try {
    result = await runDailySync(prisma, fetch, creds, algoliaEnvFor(env), new Date());
  } catch (error) {
    // runDailySync swallows per-entity push failures, but the watermark
    // read/write (Prisma/Accelerate) can still throw — log loudly, never rethrow
    // (a thrown cron just shows as a failed invocation with no detail).
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

  for (const entity of result.entities) {
    submitCount(ctx, env, req, 'aeci.algolia.sync', 1, [
      'trigger:cron',
      `entity:${entity.entity}`,
      `outcome:${entity.ok ? 'ok' : 'failed'}`,
    ]);
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

/** Run a job, or — preferably — enqueue it. On staging/production the matching
 *  queue binding is present, so we `send` a message and return immediately; the
 *  `queue` consumer below does the work (ADR 0013). On an env without the binding
 *  (local `wrangler dev`, preview) there is no queue, so run inline — a
 *  `--test-scheduled` tick must never be silently dropped. */
async function enqueueOrRun(env: Env, ctx: ExecutionContext, job: AlgoliaJob): Promise<void> {
  const queue = job === 'sync' ? env.ALGOLIA_SYNC_QUEUE : env.ALGOLIA_DRIFT_QUEUE;
  if (queue) {
    const message: AlgoliaJobMessage = {
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
      logToDatadog(ctx, env, cronRequest(`/cron/algolia-${job}`), {
        level: 'error',
        message: `aeci.algolia.${job}.enqueue_failed`,
        source: `algolia-${job}-cron`,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    console.warn(`scheduled: no queue binding for "${job}" — running inline (local/preview)`);
  }
  await runAlgoliaJob(env, ctx, job);
}

/** Dispatch a job kind to its implementation. Shared by the inline fallback and
 *  the queue consumer so both paths stay identical. */
async function runAlgoliaJob(env: Env, ctx: ExecutionContext, job: AlgoliaJob): Promise<void> {
  if (job === 'sync') {
    await runAlgoliaSync(env, ctx);
  } else {
    await runAlgoliaDrift(env, ctx);
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
    case ALGOLIA_SYNC_CRON:
      await enqueueOrRun(env, ctx, 'sync');
      return;
    case ALGOLIA_DRIFT_CRON:
      await enqueueOrRun(env, ctx, 'drift');
      return;
    default:
      // A trigger fired with no matching case — surface it rather than silently
      // doing nothing (e.g. a wrangler.jsonc cron added without a handler).
      console.warn(`scheduled: no handler for cron "${controller.cron}"`);
  }
};

/**
 * Worker `queue` consumer — runs the actual Algolia job for each message the
 * cron `scheduled` handler enqueued (ADR 0013). Bound to both job queues in
 * `wrangler.jsonc`; `batch.queue` would distinguish them, but the message body's
 * `job` is authoritative. Batches are size-1 (each job is a singleton), so this
 * loops at most once per invocation. `runAlgoliaSync`/`runAlgoliaDrift` swallow
 * their own operational errors (logging to Datadog), so reaching the `catch`
 * means an unexpected throw (e.g. Prisma client init) — `retry()` it per the
 * consumer's `max_retries`; everything else `ack()`s.
 */
export const queue: ExportedHandlerQueueHandler<Env, AlgoliaJobMessage> = async (
  batch,
  env,
  ctx,
) => {
  for (const message of batch.messages) {
    const { job } = message.body;
    try {
      await runAlgoliaJob(env, ctx, job);
      message.ack();
    } catch (error) {
      console.error(
        `queue: Algolia job "${job}" threw on ${batch.queue} (retrying):`,
        error instanceof Error ? error.message : String(error),
      );
      message.retry();
    }
  }
};
