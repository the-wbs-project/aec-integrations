/**
 * Cron entrypoint for the API Worker (AECI-140 / Phase 3.7).
 *
 * The API Worker is request-driven (`index.ts` exports the Hono `fetch`); this
 * adds a `scheduled` handler that dispatches on `controller.cron`, so multiple
 * daily jobs share one Worker rather than spawning a second. Cron triggers are
 * registered per-env in `wrangler.jsonc` (staging + production only — NOT
 * preview/PR-previews).
 *
 * NOTE (parallel work): AECI-139 (Phase 3.6, daily incremental Algolia sync at
 * 03:00 UTC) adds its own `scheduled.ts` + `case '0 3 * * *'` on this same
 * Worker. The two converge into ONE `scheduled` handler whose switch carries
 * both cases (and `wrangler.jsonc` lists both crons). This file is structured to
 * match AECI-139's dispatch skeleton so that merge is mechanical.
 *
 * 04:00 UTC — daily Algolia ↔ Supabase index-drift reconciliation
 * (`./lib/algolia-drift`, §23.1): compares promoted-row counts to Algolia object
 * counts per entity and emits the `aeci.algolia.index_drift` gauge. Report-only —
 * no auto-remediation; the alert is the Datadog monitor
 * (`observability/datadog/monitor-algolia-index-drift.json`). Re-run the AECI-138
 * bulk sync to repair.
 *
 * Best-effort + observable: the comparison is **awaited** (so a failure is logged
 * and the run isn't torn down mid-check), while metric/log emission rides
 * `ctx.waitUntil` via the shared Datadog client. The cron has no incoming
 * `Request`, so a synthetic one is passed to the Datadog helpers (used only to
 * derive the `host` tag, which falls back to the worker slug).
 */

import type { AlgoliaEnv } from '@aeci/shared/algolia';

import { logToDatadog, submitGauge } from './datadog';
import type { Env } from './env';
import {
  createAlgoliaCounter,
  reportAlgoliaDrift,
  type AlgoliaIndexDrift,
  type DriftCountPrisma,
} from './lib/algolia-drift';
import { getPrisma } from './prisma';

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
    // The Algolia count (fetch) or the watermark-free Prisma counts can throw;
    // log loudly, never rethrow (a thrown cron just shows as a failed invocation
    // with no detail).
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
    case ALGOLIA_DRIFT_CRON:
      await runAlgoliaDrift(env, ctx);
      return;
    default:
      // A trigger fired with no matching case — surface it rather than silently
      // doing nothing (e.g. a wrangler.jsonc cron added without a handler).
      console.warn(`scheduled: no handler for cron "${controller.cron}"`);
  }
};
