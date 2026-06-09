/**
 * Cron entrypoint for the API Worker (AECI-139 / Phase 3.6 + AECI-140 / Phase 3.7).
 *
 * The API Worker is request-driven (`index.ts` exports the Hono `fetch`); this
 * adds a `scheduled` handler that dispatches on `controller.cron`, so multiple
 * daily jobs share one Worker rather than spawning a second (future jobs — e.g.
 * the §10 stats pipeline at 02:00 — slot in alongside). Cron triggers are
 * registered per-env in `wrangler.jsonc` (staging + production only — NOT
 * preview/PR-previews).
 *
 * 03:00 UTC — daily incremental Algolia sync (`./lib/algolia-sync`, AECI-139):
 * push the rows changed since the stored watermark to the env's three indexes,
 * removing `retracted`/`rejected` records. The full reindex is the separate
 * AECI-138 CLI; this keeps the index fresh between those.
 *
 * 04:00 UTC — daily Algolia ↔ Supabase index-drift reconciliation
 * (`./lib/algolia-drift`, AECI-140 / §23.1): compare promoted-row counts to
 * Algolia object counts per entity and emit the `aeci.algolia.index_drift` gauge.
 * Report-only — no auto-remediation; the alert is the Datadog monitor
 * (`observability/datadog/monitor-algolia-index-drift.json`). Re-run the AECI-138
 * bulk sync to repair.
 *
 * Best-effort + observable: the work is **awaited** (so a failure is logged and
 * the run isn't torn down mid-batch), while metric/log emission rides
 * `ctx.waitUntil` via the shared Datadog client. The cron has no incoming
 * `Request`, so a synthetic one is passed to the Datadog helpers (used only to
 * derive the `host` tag, which falls back to the worker slug).
 */

import type { AlgoliaEnv } from '@aeci/shared/algolia';

import { logToDatadog, submitCount, submitDistribution, submitGauge } from './datadog';
import type { Env } from './env';
import {
  createAlgoliaCounter,
  reportAlgoliaDrift,
  type AlgoliaIndexDrift,
  type DriftCountPrisma,
} from './lib/algolia-drift';
import { runDailySync, type AlgoliaSyncPrisma } from './lib/algolia-sync';
import { emitAlgoliaSyncMetrics, type SyncMetricSink } from './lib/algolia-sync-metrics';
import { getPrisma } from './prisma';

/** Cron expression for the daily incremental Algolia sync (`wrangler.jsonc`). */
const ALGOLIA_SYNC_CRON = '0 3 * * *';

/** Cron expression for the daily index-drift check (`wrangler.jsonc`). */
const ALGOLIA_DRIFT_CRON = '0 4 * * *';

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

/** Adapt the shared Datadog submitters into the pure metrics module's sink, so
 *  `emitAlgoliaSyncMetrics` stays free of `ctx`/`env`/`Request` plumbing. */
function syncMetricSink(ctx: ExecutionContext, env: Env, req: Request): SyncMetricSink {
  return {
    count: (metric, value, tags) => submitCount(ctx, env, req, metric, value, tags),
    distribution: (metric, value, tags) => submitDistribution(ctx, env, req, metric, value, tags),
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
  emitAlgoliaSyncMetrics(
    syncMetricSink(ctx, env, req),
    'cron',
    result.entities,
    Date.now() - started,
  );

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

/**
 * Worker `scheduled` handler. Dispatches on the cron expression so additional
 * scheduled jobs register their own trigger + case without a second Worker.
 */
export const scheduled: ExportedHandlerScheduledHandler<Env> = async (controller, env, ctx) => {
  switch (controller.cron) {
    case ALGOLIA_SYNC_CRON:
      await runAlgoliaSync(env, ctx);
      return;
    case ALGOLIA_DRIFT_CRON:
      await runAlgoliaDrift(env, ctx);
      return;
    default:
      // A trigger fired with no matching case — surface it rather than silently
      // doing nothing (e.g. a wrangler.jsonc cron added without a handler).
      console.warn(`scheduled: no handler for cron "${controller.cron}"`);
  }
};
