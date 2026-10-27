/**
 * The whole IndexNow day in one call, for specs (AECI-1476).
 *
 * Production splits the drain across three callers: the 00:05 cron
 * (`runIndexNowHousekeeping`), the runner's batch call (`prepareIndexNowBatch`),
 * the runner's one IndexNow request (`callIndexNow`), and the runner's result call
 * (`recordIndexNowResult`). This composes them in that order, against an injected
 * `fetch`, and reports in the shape the pre-AECI-1476 in-Worker drain returned.
 * That keeps the drain's end-to-end invariants (one request, tier order, paging,
 * exact deletion, the log and the resend window) under test through the real
 * functions, without each spec re-wiring four calls.
 *
 * Test-only. The runner script (`scripts/indexnow-runner.ts`) is the production
 * composition, over HTTP.
 */

import type { Db } from '../db/client';
import type { Env } from '../env';
import { callIndexNow } from '../lib/indexnow';
import {
  prepareIndexNowBatch,
  recordIndexNowResult,
  runIndexNowHousekeeping,
  type IndexNowDrainLogSink,
  type IndexNowDrainMetricSink,
} from '../lib/indexnow-drain';
import {
  countDeferredIndexNowUrls,
  countPendingIndexNowUrls,
  INDEXNOW_RESEND_MIN_DAYS,
  staleCutoffIso,
} from '../lib/indexnow-queue';

export interface PipelineResult {
  /** URLs handed to the transport. */
  submitted: number;
  /** Per tier, on an accepted submission only. */
  byTier?: Record<number, number>;
  /** Rows that left the buffer: retired rows plus, on success, the sent rows. */
  deleted: number;
  expired: number;
  retired: number;
  pending: number;
  deferred: number;
  status: number;
  attempts: number;
  ok: boolean;
  reason?: string;
  batchId?: string;
  refused?: true;
}

export async function runIndexNowPipeline(deps: {
  db: Db;
  env: Env;
  metrics: IndexNowDrainMetricSink;
  log: IndexNowDrainLogSink;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}): Promise<PipelineResult> {
  const { db, env, metrics, log } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const clock = deps.now ?? (() => new Date());
  const base = { submitted: 0, deleted: 0, retired: 0, status: 0, attempts: 0 };

  const hk = await runIndexNowHousekeeping({ db, env, metrics, log, now: clock });
  if (!hk.ok) return { ...base, ...hk };

  const counts = async () => ({
    pending: await countPendingIndexNowUrls(db),
    deferred: await countDeferredIndexNowUrls(
      db,
      staleCutoffIso(clock(), INDEXNOW_RESEND_MIN_DAYS),
    ),
  });

  const plan = await prepareIndexNowBatch({ db, env, log, now: clock });
  if (plan.kind === 'skipped' || plan.kind === 'failed') {
    return { ...base, ...hk, ok: false, reason: plan.reason };
  }
  if (plan.kind === 'empty') {
    return {
      ...base,
      expired: hk.expired,
      retired: plan.retired,
      deleted: plan.retired,
      ...(await counts()),
      ok: true,
      ...(plan.batchId ? { batchId: plan.batchId } : {}),
    };
  }

  const submittedAt = clock().toISOString();
  const sent = await callIndexNow(fetchImpl, {
    host: plan.host,
    key: plan.key,
    keyLocation: plan.keyLocation,
    urlList: plan.urls,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
  const message = sent.ok ? '' : sent.message;
  const recorded = await recordIndexNowResult(
    { db, metrics, log, now: clock },
    {
      batchId: plan.batchId,
      ids: plan.ids,
      status: sent.status,
      attempts: sent.attempts,
      message,
      submittedAt,
    },
  );
  if (recorded.replayed) throw new Error('a fresh batch cannot be a replay');

  return {
    submitted: plan.urls.length,
    ...(sent.ok ? { byTier: recorded.byTier } : {}),
    deleted: plan.retired + recorded.deleted,
    expired: hk.expired,
    retired: plan.retired,
    pending: recorded.pending,
    deferred: recorded.deferred,
    status: sent.status,
    attempts: sent.attempts,
    ok: sent.ok,
    ...(sent.ok ? {} : { reason: `indexnow_${sent.status}: ${message}`, refused: true as const }),
    ...(sent.ok || recorded.logged > 0 || plan.retired > 0 ? { batchId: plan.batchId } : {}),
  };
}
