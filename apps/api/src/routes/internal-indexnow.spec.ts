/**
 * The IndexNow runner's two internal routes (AECI-1476) against the in-memory D1
 * harness, through the real sub-router: the bearer middleware, the Zod contracts
 * and the drain functions underneath. PostHog is the one mock, so the heartbeat
 * and the submit metric can be read.
 *
 * What each test pins, in the order the runner meets it:
 *
 *   - **Auth.** A missing or wrong token is a 401 on both routes and never reaches
 *     D1. An unset `INDEXNOW_RUNNER_TOKEN` fails closed.
 *   - **Batch.** `no_creds` is a 200 skip (staging, demo). An empty buffer is a
 *     200 `empty`. A full buffer comes back in drain order with the target. Retired
 *     rows are consumed here and never reach the runner. Every call emits
 *     `aeci.indexnow.batch`.
 *   - **Result.** A 2xx logs, deletes and audits in ONE batch. A 429 logs refused
 *     rows and deletes nothing. `attempts: 0` writes nothing. A replay writes
 *     nothing. An id no longer queued is ignored.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, indexnowQueue, jobRuns, recrawlSubmissions, slugRedirects } from '../db/schema';
import type { Env } from '../env';
import {
  INDEXNOW_BATCH_METRIC,
  INDEXNOW_DRAINED_ACTION,
  INDEXNOW_SUBMIT_METRIC,
  INDEXNOW_SUBMITTED_URLS_METRIC,
} from '../lib/indexnow-drain';
import { enqueueIndexNowUrls } from '../lib/indexnow-queue';
import { submitMetricsBatch, type PosthogMetricPoint } from '../posthog';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import { createIndexNowRunnerRouter } from './internal-indexnow';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
  submitMetricsBatch: vi.fn(),
}));

const TOKEN = 'runner-token-0123456789abcdef';
const ENV = {
  ENV: 'production',
  INDEXNOW_KEY: 'a1b2c3d4e5f6a7b8',
  PUBLIC_SITE_URL: 'https://www.aecintegrations.com',
  INDEXNOW_RUNNER_TOKEN: TOKEN,
} as unknown as Env;

const url = (slug: string) => `https://www.aecintegrations.com/products/${slug}`;

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  vi.mocked(submitMetricsBatch).mockClear();
});
afterEach(() => t.dispose());

async function post(
  path: string,
  opts: { body?: unknown; env?: Env; token?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = opts.token === undefined ? TOKEN : opts.token;
  if (token !== null) headers['authorization'] = `Bearer ${token}`;
  return createIndexNowRunnerRouter(t.factory).request(
    path,
    {
      method: 'POST',
      headers,
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    },
    opts.env ?? ENV,
    fakeExecutionContext(),
  );
}

const BATCH = '/api/internal/indexnow/batch';
const resultPath = (batchId: string) => `/api/internal/indexnow/batch/${batchId}/result`;

/** Every metric point the routes sent, flattened across `submitMetricsBatch` calls. */
function points(): PosthogMetricPoint[] {
  return vi.mocked(submitMetricsBatch).mock.calls.flatMap((call) => call[3]);
}

async function queuedUrls(): Promise<string[]> {
  const rows = await t.db
    .select({ url: indexnowQueue.url })
    .from(indexnowQueue)
    .orderBy(indexnowQueue.id);
  return rows.map((r) => r.url);
}

const audits = () =>
  t.db.select().from(auditLog).where(eq(auditLog.action, INDEXNOW_DRAINED_ACTION));

type Ready = { batchId: string; ids: number[]; urls: string[] };

async function batch(): Promise<Ready> {
  const res = await post(BATCH);
  expect(res.status).toBe(200);
  return (await res.json()) as Ready;
}

function report(ids: number[], over: Record<string, unknown> = {}) {
  return {
    ids,
    status: 200,
    attempts: 1,
    message: '',
    submittedAt: '2026-10-27T00:20:05.000Z',
    ...over,
  };
}

describe('auth', () => {
  const FAKE = '00000000-0000-4000-8000-000000000000';

  it.each([
    ['batch', BATCH],
    ['result', resultPath(FAKE)],
  ])('401s the %s route with no token', async (_name, path) => {
    const res = await post(path, { token: null, body: report([1]) });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');
  });

  it.each([
    ['batch', BATCH],
    ['result', resultPath(FAKE)],
  ])('401s the %s route with the wrong token', async (_name, path) => {
    const res = await post(path, { token: 'wrong', body: report([1]) });
    expect(res.status).toBe(401);
  });

  it('fails closed when INDEXNOW_RUNNER_TOKEN is unset', async () => {
    const res = await post(BATCH, { env: { ...ENV, INDEXNOW_RUNNER_TOKEN: undefined } });
    expect(res.status).toBe(401);
  });

  it('never reaches D1 or the heartbeat on a 401', async () => {
    await enqueueIndexNowUrls(t.db, [url('revit')]);
    await post(BATCH, { token: 'wrong' });
    expect(await queuedUrls()).toEqual([url('revit')]);
    expect(points()).toEqual([]);
  });
});

describe('POST /api/internal/indexnow/batch', () => {
  it('skips with no_creds on a tier without INDEXNOW_KEY (R7)', async () => {
    const res = await post(BATCH, { env: { ...ENV, INDEXNOW_KEY: undefined } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: 'no_creds' });
    expect(points()).toContainEqual(
      expect.objectContaining({
        metric: INDEXNOW_BATCH_METRIC,
        tags: ['trigger:runner', 'outcome:skipped'],
      }),
    );
  });

  it('answers empty on an empty buffer and emits the heartbeat', async () => {
    const res = await post(BATCH);
    expect(await res.json()).toEqual({ empty: true, retired: 0 });
    expect(points()).toContainEqual({
      kind: 'count',
      metric: INDEXNOW_BATCH_METRIC,
      value: 1,
      tags: ['trigger:runner', 'outcome:empty'],
    });
  });

  it('hands out the drain set in tier order with the public target, and writes nothing', async () => {
    await enqueueIndexNowUrls(t.db, [{ url: url('tier-4'), priority: 4 }]);
    await enqueueIndexNowUrls(t.db, [{ url: url('tier-1'), priority: 1 }]);
    await enqueueIndexNowUrls(t.db, [{ url: url('tier-2'), priority: 2 }]);

    const body = (await batch()) as Ready & Record<string, unknown>;

    expect(body.urls).toEqual([url('tier-1'), url('tier-2'), url('tier-4')]);
    expect(body.ids).toHaveLength(3);
    expect(body).toMatchObject({
      host: 'www.aecintegrations.com',
      key: 'a1b2c3d4e5f6a7b8',
      keyLocation: 'https://www.aecintegrations.com/a1b2c3d4e5f6a7b8.txt',
      retired: 0,
    });
    expect(body.batchId).toMatch(/^[0-9a-f-]{36}$/);
    // The rows stay queued until the result route hears back.
    expect(await queuedUrls()).toHaveLength(3);
    expect(await audits()).toHaveLength(0);
    expect(points()).toContainEqual(
      expect.objectContaining({
        metric: INDEXNOW_BATCH_METRIC,
        tags: ['trigger:runner', 'outcome:ok'],
      }),
    );
  });

  it('consumes retired rows itself and never hands them to the runner (R5)', async () => {
    await t.db.insert(slugRedirects).values({
      entity: 'product',
      fromSlug: 'old-name',
      toSlug: 'new-name',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await enqueueIndexNowUrls(t.db, [url('old-name'), url('revit')]);

    const body = (await batch()) as Ready & { retired: number };

    expect(body.urls).toEqual([url('revit')]);
    expect(body.retired).toBe(1);
    expect(await queuedUrls()).toEqual([url('revit')]);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({
      reason: 'retired',
      rowsDeleted: 1,
      batchId: body.batchId,
    });
    // A retired URL is never sent, so it is never logged.
    expect(await t.db.select().from(recrawlSubmissions)).toEqual([]);
  });

  it('answers empty with the batch id when every row was retired', async () => {
    await t.db.insert(slugRedirects).values({
      entity: 'product',
      fromSlug: 'old-name',
      toSlug: 'new-name',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await enqueueIndexNowUrls(t.db, [url('old-name')]);

    const body = (await (await post(BATCH)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ empty: true, retired: 1 });
    expect(body['batchId']).toEqual(expect.any(String));
    expect(await queuedUrls()).toEqual([]);
  });
});

describe('POST /api/internal/indexnow/batch/:batchId/result', () => {
  it('on a 2xx logs, deletes and audits in ONE db.batch, sharing the batch id', async () => {
    await enqueueIndexNowUrls(t.db, [
      { url: url('a'), priority: 1 },
      { url: url('b'), priority: 4 },
    ]);
    const plan = await batch();
    const spy = vi.spyOn(t.db, 'batch');

    const res = await post(resultPath(plan.batchId), { body: report(plan.ids) });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      replayed: false,
      batchId: plan.batchId,
      outcome: 'accepted',
      logged: 2,
      deleted: 2,
      ignored: 0,
      pending: 0,
      deferred: 0,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await queuedUrls()).toEqual([]);
    const logged = await t.db.select().from(recrawlSubmissions);
    expect(logged.map((r) => [r.url, r.outcome, r.httpStatus, r.batchId, r.submittedAt])).toEqual([
      [url('a'), 'accepted', 200, plan.batchId, '2026-10-27T00:20:05.000Z'],
      [url('b'), 'accepted', 200, plan.batchId, '2026-10-27T00:20:05.000Z'],
    ]);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({
      reason: 'submitted',
      rowsDeleted: 2,
      status: 200,
      batchId: plan.batchId,
      byTier: { 1: 1, 4: 1 },
    });
    expect(points()).toEqual(
      expect.arrayContaining([
        {
          kind: 'count',
          metric: INDEXNOW_SUBMIT_METRIC,
          value: 1,
          tags: ['source:runner', 'outcome:ok'],
        },
        {
          kind: 'count',
          metric: INDEXNOW_SUBMITTED_URLS_METRIC,
          value: 1,
          tags: ['source:runner', 'tier:1'],
        },
        expect.objectContaining({ metric: 'aeci.indexnow.pending', tags: ['trigger:runner'] }),
        expect.objectContaining({ metric: 'aeci.indexnow.deferred', tags: ['trigger:runner'] }),
      ]),
    );
  });

  it('on a 429 logs refused rows, deletes nothing and writes no audit row', async () => {
    await enqueueIndexNowUrls(t.db, [url('a'), url('b')]);
    const plan = await batch();

    const res = await post(resultPath(plan.batchId), {
      body: report(plan.ids, { status: 429, message: 'TooManyRequests' }),
    });

    expect(await res.json()).toMatchObject({
      outcome: 'refused',
      logged: 2,
      deleted: 0,
      pending: 2,
    });
    expect(await queuedUrls()).toHaveLength(2);
    expect(await audits()).toHaveLength(0);
    const logged = await t.db.select().from(recrawlSubmissions);
    expect(logged.map((r) => [r.outcome, r.httpStatus])).toEqual([
      ['refused', 429],
      ['refused', 429],
    ]);
    expect(points()).toContainEqual({
      kind: 'count',
      metric: INDEXNOW_SUBMIT_METRIC,
      value: 1,
      tags: ['source:runner', 'outcome:failed'],
    });
  });

  it('writes nothing when nothing went on the wire (status 0, attempts 0)', async () => {
    await enqueueIndexNowUrls(t.db, [url('a')]);
    const plan = await batch();

    const res = await post(resultPath(plan.batchId), {
      body: report(plan.ids, { status: 0, attempts: 0, message: 'indexnow_no_urls' }),
    });

    expect(await res.json()).toMatchObject({ outcome: 'failed', logged: 0, deleted: 0 });
    expect(await t.db.select().from(recrawlSubmissions)).toEqual([]);
    expect(await queuedUrls()).toEqual([url('a')]);
    expect(await audits()).toHaveLength(0);
  });

  it('is idempotent on the batch id: a replay writes nothing and emits nothing (R4)', async () => {
    await enqueueIndexNowUrls(t.db, [url('a')]);
    const plan = await batch();
    await post(resultPath(plan.batchId), { body: report(plan.ids, { status: 429 }) });
    vi.mocked(submitMetricsBatch).mockClear();

    // The runner retries its POST after a timeout, this time claiming success.
    const res = await post(resultPath(plan.batchId), { body: report(plan.ids) });

    expect(await res.json()).toEqual({ replayed: true, batchId: plan.batchId });
    expect(await t.db.select().from(recrawlSubmissions)).toHaveLength(1);
    expect(await queuedUrls()).toEqual([url('a')]);
    expect(await audits()).toHaveLength(0);
    expect(points()).toEqual([]);
  });

  it('ignores ids no longer queued and takes tiers from the re-read rows (R6)', async () => {
    await enqueueIndexNowUrls(t.db, [{ url: url('a'), priority: 2 }]);
    const plan = await batch();

    const res = await post(resultPath(plan.batchId), {
      body: report([...plan.ids, 999_999]),
    });

    expect(await res.json()).toMatchObject({ logged: 1, deleted: 1, ignored: 1 });
    const [row] = await audits();
    expect(row!.metadata).toMatchObject({ rowsDeleted: 1, byTier: { 2: 1 } });
  });

  it('rejects a malformed batch id and a malformed body with a 400', async () => {
    expect((await post(resultPath('not-a-uuid'), { body: report([1]) })).status).toBe(400);
    const plan = { batchId: '00000000-0000-4000-8000-000000000000' };
    expect((await post(resultPath(plan.batchId), { body: { ids: [] } })).status).toBe(400);
  });
});

describe('the job_runs row for indexnow-send (ruling 2026-10-27)', () => {
  const runs = () => t.db.select().from(jobRuns);

  it('records a refused result with its batch id, status and reason', async () => {
    await enqueueIndexNowUrls(t.db, [url('a'), url('b')]);
    const plan = await batch();

    await post(resultPath(plan.batchId), {
      body: report(plan.ids, { status: 429, message: 'TooManyRequests' }),
    });

    const rows = await runs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      job: 'indexnow-send',
      outcome: 'failed',
      startedAt: '2026-10-27T00:20:05.000Z',
    });
    expect(rows[0]!.finishedAt).toEqual(expect.any(String));
    expect(rows[0]!.detail).toEqual({
      job: 'indexnow-send',
      batchId: plan.batchId,
      outcome: 'refused',
      status: 429,
      attempts: 1,
      urls: 2,
      logged: 2,
      deleted: 0,
      ignored: 0,
      reason: 'indexnow_429: TooManyRequests',
    });
  });

  it('records an accepted result as ok, with no reason', async () => {
    await enqueueIndexNowUrls(t.db, [url('a')]);
    const plan = await batch();

    await post(resultPath(plan.batchId), { body: report(plan.ids) });

    const [row] = await runs();
    expect(row).toMatchObject({ job: 'indexnow-send', outcome: 'ok' });
    expect(row!.detail).toMatchObject({
      batchId: plan.batchId,
      outcome: 'accepted',
      status: 200,
      logged: 1,
      deleted: 1,
    });
    expect(row!.detail).not.toHaveProperty('reason');
    expect(points()).toContainEqual({
      kind: 'count',
      metric: 'aeci.job_runs.write',
      value: 1,
      tags: ['phase:finish', 'job:indexnow-send', 'outcome:ok'],
    });
  });

  it('treats a result that logged nothing as recorded: a replay writes no second row', async () => {
    await enqueueIndexNowUrls(t.db, [url('a')]);
    const plan = await batch();
    const nothingSent = report(plan.ids, { status: 0, attempts: 0, message: 'indexnow_no_urls' });
    await post(resultPath(plan.batchId), { body: nothingSent });

    const res = await post(resultPath(plan.batchId), { body: nothingSent });

    expect(await res.json()).toEqual({ replayed: true, batchId: plan.batchId });
    expect(await runs()).toHaveLength(1);
  });

  it('writes no second row on a replay', async () => {
    await enqueueIndexNowUrls(t.db, [url('a')]);
    const plan = await batch();
    await post(resultPath(plan.batchId), { body: report(plan.ids, { status: 429 }) });

    await post(resultPath(plan.batchId), { body: report(plan.ids, { status: 429 }) });

    expect(await runs()).toHaveLength(1);
  });

  it('a failed job_runs write changes neither the response nor the ledger', async () => {
    await enqueueIndexNowUrls(t.db, [url('a'), url('b')]);
    const plan = await batch();
    // Take the bookkeeping table away. The ledger tables are untouched.
    t.raw.exec('DROP TABLE job_runs');

    const res = await post(resultPath(plan.batchId), { body: report(plan.ids) });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      replayed: false,
      batchId: plan.batchId,
      outcome: 'accepted',
      logged: 2,
      deleted: 2,
      ignored: 0,
      pending: 0,
      deferred: 0,
    });
    expect(await queuedUrls()).toEqual([]);
    expect(await t.db.select().from(recrawlSubmissions)).toHaveLength(2);
    expect(await audits()).toHaveLength(1);
    expect(points()).toContainEqual({
      kind: 'count',
      metric: 'aeci.job_runs.write',
      value: 1,
      tags: ['phase:finish', 'job:indexnow-send', 'outcome:failed'],
    });
  });
});
