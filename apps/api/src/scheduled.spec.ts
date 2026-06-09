/**
 * Unit tests for the ADR 0013 cron→queue→consumer orchestration in
 * `scheduled.ts`. The dispatched job impls (`runDailySync`, `reportAlgoliaDrift`)
 * and Prisma/Datadog are mocked, so these lock in the orchestration contract
 * only: the cron `scheduled` handler enqueues when a queue binding is present,
 * runs inline when it is absent, and falls back to inline (logging the failure)
 * when `queue.send` rejects; the `queue` consumer `ack()`s on success and
 * `retry()`s on an unexpected throw.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AlgoliaJob, Env } from './env';

vi.mock('./datadog', () => ({
  logToDatadog: vi.fn(),
  submitCount: vi.fn(),
  submitGauge: vi.fn(),
}));
vi.mock('./lib/algolia-sync', () => ({ runDailySync: vi.fn() }));
vi.mock('./lib/algolia-drift', () => ({
  createAlgoliaCounter: vi.fn(() => ({})),
  reportAlgoliaDrift: vi.fn(),
}));
vi.mock('./prisma', () => ({ getPrisma: vi.fn(() => ({})) }));

import { logToDatadog } from './datadog';
import { reportAlgoliaDrift } from './lib/algolia-drift';
import { runDailySync } from './lib/algolia-sync';
import { getPrisma } from './prisma';
import { queue, scheduled } from './scheduled';

// Must stay byte-equal to the constants / `wrangler.jsonc` triggers.
const SYNC_CRON = '0 8 * * *';
const DRIFT_CRON = '0 9 * * *';

const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    ALGOLIA_APP_ID: 'APP',
    ALGOLIA_ADMIN_KEY: 'write-key',
    ENV: 'staging',
    ...over,
  } as unknown as Env;
}

function cronController(cron: string) {
  return { cron, scheduledTime: 0, noRetry: vi.fn() } as unknown as Parameters<typeof scheduled>[0];
}

function makeBatch(job: AlgoliaJob, queueName: string) {
  const ack = vi.fn();
  const retry = vi.fn();
  const batch = {
    queue: queueName,
    messages: [
      { id: '1', attempts: 1, body: { job, trigger: 'cron', enqueuedAt: 'x' }, ack, retry },
    ],
  } as unknown as Parameters<typeof queue>[0];
  return { batch, ack, retry };
}

beforeEach(() => {
  vi.clearAllMocks();
  // runAlgoliaSync reads `result.entities` after the call; default to a clean run.
  vi.mocked(runDailySync).mockResolvedValue({ entities: [] } as never);
  vi.mocked(getPrisma).mockReturnValue({} as never);
});

describe('scheduled (cron producer)', () => {
  it('enqueues the sync job when the queue binding is present (does not run inline)', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env = makeEnv({ ALGOLIA_SYNC_QUEUE: { send } as never });

    await scheduled(cronController(SYNC_CRON), env, ctx);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ job: 'sync', trigger: 'cron' }));
    expect(runDailySync).not.toHaveBeenCalled();
  });

  it('enqueues the drift job onto its own queue', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env = makeEnv({ ALGOLIA_DRIFT_QUEUE: { send } as never });

    await scheduled(cronController(DRIFT_CRON), env, ctx);

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ job: 'drift', trigger: 'cron' }));
    expect(reportAlgoliaDrift).not.toHaveBeenCalled();
  });

  it('runs the job inline when no queue binding is present (local/preview)', async () => {
    await scheduled(cronController(SYNC_CRON), makeEnv(), ctx);

    expect(runDailySync).toHaveBeenCalledTimes(1);
  });

  it('falls back to an inline run and logs to Datadog when queue.send rejects', async () => {
    const send = vi.fn().mockRejectedValue(new Error('queue down'));
    const env = makeEnv({ ALGOLIA_SYNC_QUEUE: { send } as never });

    await scheduled(cronController(SYNC_CRON), env, ctx);

    expect(send).toHaveBeenCalledTimes(1);
    expect(runDailySync).toHaveBeenCalledTimes(1); // ran inline rather than dropping the tick
    expect(logToDatadog).toHaveBeenCalledWith(
      ctx,
      env,
      expect.anything(),
      expect.objectContaining({ level: 'error', message: 'aeci.algolia.sync.enqueue_failed' }),
    );
  });
});

describe('queue (consumer)', () => {
  it('ack()s a message whose job runs successfully', async () => {
    const { batch, ack, retry } = makeBatch('sync', 'aeci-algolia-sync-staging');

    await queue(batch, makeEnv(), ctx);

    expect(runDailySync).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('retry()s when the job throws unexpectedly (e.g. Prisma init)', async () => {
    vi.mocked(getPrisma).mockImplementation(() => {
      throw new Error('prisma init failed');
    });
    const { batch, ack, retry } = makeBatch('sync', 'aeci-algolia-sync-staging');

    await queue(batch, makeEnv(), ctx);

    expect(retry).toHaveBeenCalledTimes(1);
    expect(ack).not.toHaveBeenCalled();
  });
});
