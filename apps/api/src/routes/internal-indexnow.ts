/**
 * The IndexNow runner's two internal routes (AECI-1476 / `STAGE_1_SPEC.md` §20.2,
 * `API_CONTRACTS.md` §6.12a):
 *
 *   POST /api/internal/indexnow/batch                  — read the day's drain set.
 *   POST /api/internal/indexnow/batch/:batchId/result  — record what IndexNow said.
 *
 * ─── Why a runner calls these at all ──────────────────────────────────────────
 *
 * The daily IndexNow request used to leave from the API Worker, and IndexNow
 * refused it with a 429 on most days even at one request a day. A one-shot probe
 * from a GitHub-hosted runner got a 200 the same UTC day (run 40286642092): the
 * Worker's egress IPs are shared with every other Cloudflare Worker. So the one
 * outbound POST moved to `apps/api/scripts/indexnow-runner.ts`, run at 00:20 UTC
 * by `.github/workflows/indexnow-send.yml`. The Worker keeps every decision and
 * every ledger write (`lib/indexnow-drain.ts`). The runner only carries the request.
 *
 * ─── Auth, and the limiter that is deliberately absent ────────────────────────
 *
 * Both routes sit behind `Authorization: Bearer <INDEXNOW_RUNNER_TOKEN>`
 * (`requireIndexNowRunnerAuth`, constant-time, 401 when the secret or the header is
 * missing). Neither is rate-limited (`docs/waf-rate-limits.md` §6.2): token-gated,
 * machine to machine, once a day, and a 429 here would cost a day's submission.
 * Reached from the public host through the SSR Worker's raw `/api/*` passthrough.
 *
 * ─── Telemetry ────────────────────────────────────────────────────────────────
 *
 * The batch route emits `aeci.indexnow.batch{outcome:ok|empty|skipped}` on every
 * authenticated call: the runner's liveness heartbeat. The result route emits
 * `aeci.indexnow.submit{source:runner}`, the per-tier `submitted_urls`, and the
 * `pending`/`deferred` gauges. Each route sends its points in ONE
 * `submitMetricsBatch` request, never one connection per point (AECI-666).
 */

import {
  ApiErrorCode,
  IndexNowBatchIdParamSchema,
  IndexNowBatchResponseSchema,
  IndexNowResultRequestSchema,
  IndexNowResultResponseSchema,
  type IndexNowBatchResponse,
  type IndexNowResultResponse,
} from '@aeci/shared';
import { Hono, type Context } from 'hono';

import type { Env } from '../env';
import { ApiError, errorHandler } from '../errors';
import { json } from '../http';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import {
  INDEXNOW_BATCH_METRIC,
  prepareIndexNowBatch,
  recordIndexNowResult,
  type IndexNowDrainLogSink,
  type IndexNowDrainMetricSink,
} from '../lib/indexnow-drain';
import { requireIndexNowRunnerAuth } from '../lib/review-auth';
import { logToPosthog, submitMetricsBatch, type PosthogMetricPoint } from '../posthog';

type RunnerContext = Context<{ Bindings: Env }>;

/** `source` on every log line and on the rejected-request logs. */
const LOG_SOURCE = 'indexnow-runner';

/** Collect points, then send them in one request. Observability never breaks the
 *  route: a missing `ExecutionContext` (a non-Worker harness) is swallowed. */
function collectingSink(c: RunnerContext) {
  const points: PosthogMetricPoint[] = [];
  const sink: IndexNowDrainMetricSink = {
    count: (metric, value, tags) => void points.push({ kind: 'count', metric, value, tags }),
    gauge: (metric, value, tags) => void points.push({ kind: 'gauge', metric, value, tags }),
  };
  const flush = () => {
    if (points.length === 0) return;
    try {
      submitMetricsBatch(c.executionCtx, c.env, c.req.raw, points.splice(0));
    } catch (error) {
      console.warn('indexnow-runner: metric emit failed', error);
    }
  };
  return { sink, flush };
}

function logSink(c: RunnerContext): IndexNowDrainLogSink {
  return (event) => {
    try {
      logToPosthog(c.executionCtx, c.env, c.req.raw, { ...event, source: LOG_SOURCE });
    } catch (error) {
      console.warn('indexnow-runner: log emit failed', error);
    }
  };
}

/** `POST /api/internal/indexnow/batch`. */
export function createIndexNowBatchHandler(dbFor?: DbFactory) {
  return async (c: RunnerContext): Promise<Response> => {
    const { db } = writeDb(c, dbFor);
    const metrics = collectingSink(c);
    const plan = await prepareIndexNowBatch({ db, env: c.env, log: logSink(c) });

    if (plan.kind === 'failed') {
      // A local fault, never transient. No heartbeat: the cron's
      // `aeci.indexnow.drain{outcome:failed}` already pages on it, and the runner
      // goes red on this 500.
      throw new ApiError(
        500,
        ApiErrorCode.INTERNAL_ERROR,
        'PUBLIC_SITE_URL is not a valid URL; nothing to send',
      );
    }

    let body: IndexNowBatchResponse;
    let outcome: 'ok' | 'empty' | 'skipped';
    if (plan.kind === 'skipped') {
      body = { skipped: 'no_creds' };
      outcome = 'skipped';
    } else if (plan.kind === 'empty') {
      body = {
        empty: true,
        retired: plan.retired,
        ...(plan.batchId ? { batchId: plan.batchId } : {}),
      };
      outcome = 'empty';
    } else {
      body = {
        batchId: plan.batchId,
        host: plan.host,
        key: plan.key,
        keyLocation: plan.keyLocation,
        ids: plan.ids,
        urls: plan.urls,
        retired: plan.retired,
      };
      outcome = 'ok';
    }

    metrics.sink.count(INDEXNOW_BATCH_METRIC, 1, ['trigger:runner', `outcome:${outcome}`]);
    metrics.flush();
    validateResponseInDev(c.env, () => IndexNowBatchResponseSchema.parse(body));
    return json(body);
  };
}

/** `POST /api/internal/indexnow/batch/:batchId/result`. */
export function createIndexNowResultHandler(dbFor?: DbFactory) {
  return async (c: RunnerContext): Promise<Response> => {
    const { batchId } = IndexNowBatchIdParamSchema.parse({ batchId: c.req.param('batchId') });
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError(400, ApiErrorCode.MALFORMED_REQUEST, 'Request body is not valid JSON');
    }
    const report = IndexNowResultRequestSchema.parse(raw);

    const { db } = writeDb(c, dbFor);
    const metrics = collectingSink(c);
    const result = await recordIndexNowResult(
      { db, metrics: metrics.sink, log: logSink(c) },
      { batchId, ...report },
    );
    metrics.flush();

    const body: IndexNowResultResponse = result.replayed
      ? { replayed: true, batchId }
      : {
          replayed: false,
          batchId,
          outcome: result.outcome,
          logged: result.logged,
          deleted: result.deleted,
          ignored: result.ignored,
          pending: result.pending,
          deferred: result.deferred,
        };
    validateResponseInDev(c.env, () => IndexNowResultResponseSchema.parse(body));
    return json(body);
  };
}

/**
 * The sub-router `index.ts` mounts. Its own `onError` opts into `logClientErrors`,
 * so a 401 or a 400 from the runner is a PostHog log under `source:indexnow-runner`
 * with the `trace_id` the runner prints. The auth middleware runs before either
 * handler, so an unauthenticated call never reaches D1.
 */
export function createIndexNowRunnerRouter(dbFor?: DbFactory): Hono<{ Bindings: Env }> {
  const router = new Hono<{ Bindings: Env }>();
  router.onError(errorHandler({ logClientErrors: true, source: LOG_SOURCE }));
  router.post(
    '/api/internal/indexnow/batch',
    requireIndexNowRunnerAuth(),
    createIndexNowBatchHandler(dbFor),
  );
  router.post(
    '/api/internal/indexnow/batch/:batchId/result',
    requireIndexNowRunnerAuth(),
    createIndexNowResultHandler(dbFor),
  );
  return router;
}
