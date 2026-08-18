/**
 * `job_runs` bookkeeping (AECI-583 / §7.2). These lock in the four properties the
 * table's honesty rests on, against a real migrated SQLite:
 *
 *  1. the row exists BEFORE the job runs and carries no outcome until it finishes
 *     — that is what makes a timed-out run detectable;
 *  2. a thrown handler is recorded `failed` and **rethrown**, while a merely
 *     *reported* failure does not throw (so instrumenting does not widen the queue
 *     retry surface);
 *  3. nothing here can throw at its caller, whatever D1 does;
 *  4. `outcome` admits exactly three values plus NULL — no `'running'`.
 */

import { asc } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { jobRuns } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import type { DataQualityCheckResult } from './data-quality';
import {
  DETAIL_MAX_BYTES,
  finishJobRun,
  latestCompletedJobRun,
  latestJobRun,
  latestJobRuns,
  orphanSweepDetail,
  startJobRun,
  withJobRun,
  type JobRunSink,
} from './job-runs';

const AT = new Date('2026-08-13T04:00:00.000Z');
const DONE = new Date('2026-08-13T04:00:12.000Z');

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

const rows = () => t.db.select().from(jobRuns).orderBy(asc(jobRuns.id));

/** Simulate D1 failing under the bookkeeping writer. */
const breakTable = () => t.raw.prepare('DROP TABLE job_runs').run();

describe('startJobRun / finishJobRun', () => {
  it('writes the entry row with NO finish stamp and NO outcome', async () => {
    const handle = await startJobRun(t.db, 'data-quality', AT);

    expect(handle).not.toBeNull();
    expect(handle?.id).toEqual(expect.any(Number));

    const [row] = await rows();
    expect(row).toMatchObject({
      job: 'data-quality',
      startedAt: AT.toISOString(),
      // The AC: an interrupted run is distinguishable precisely because these two
      // stay null until the job reports back.
      finishedAt: null,
      outcome: null,
    });
  });

  it('completes exactly the row it was handed, leaving others alone', async () => {
    const first = await startJobRun(t.db, 'waf-poll', AT);
    await startJobRun(t.db, 'home-stats', AT);

    await finishJobRun(first, { outcome: 'ok', finishedAt: DONE });

    const all = await rows();
    expect(all[0]).toMatchObject({
      job: 'waf-poll',
      outcome: 'ok',
      finishedAt: DONE.toISOString(),
    });
    expect(all[1]).toMatchObject({ job: 'home-stats', outcome: null, finishedAt: null });
  });

  it('no-ops on a null handle rather than throwing', async () => {
    await expect(finishJobRun(null, { outcome: 'ok', finishedAt: DONE })).resolves.toBeUndefined();
    expect(await rows()).toHaveLength(0);
  });

  it('returns null without touching D1 when there is no database binding', async () => {
    // `jobRunDb()` hands `null` through when `getDb` throws — a job that needs no
    // database must not be taken down by its own bookkeeping.
    await expect(startJobRun(null, 'waf-poll', AT)).resolves.toBeNull();
  });

  it('swallows an insert failure, reports it to the sink, and returns null', async () => {
    const sink = vi.fn();
    breakTable();

    await expect(startJobRun(t.db, 'algolia-sync', AT, sink as JobRunSink)).resolves.toBeNull();
    expect(sink).toHaveBeenCalledWith({
      phase: 'start',
      job: 'algolia-sync',
      outcome: 'failed',
      reason: expect.any(String),
    });
  });

  it('swallows a finish failure the same way', async () => {
    const sink = vi.fn();
    const handle = await startJobRun(t.db, 'algolia-sync', AT);
    breakTable();

    await expect(
      finishJobRun(handle, { outcome: 'ok', finishedAt: DONE }, sink as JobRunSink),
    ).resolves.toBeUndefined();
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'finish', outcome: 'failed' }),
    );
  });

  it('reports a successful write too — an always-on series is what tells a broken recorder from an idle one', async () => {
    const sink = vi.fn();
    const handle = await startJobRun(t.db, 'waf-poll', AT, sink as JobRunSink);
    await finishJobRun(handle, { outcome: 'ok', finishedAt: DONE }, sink as JobRunSink);

    expect(sink).toHaveBeenNthCalledWith(1, { phase: 'start', job: 'waf-poll', outcome: 'ok' });
    expect(sink).toHaveBeenNthCalledWith(2, { phase: 'finish', job: 'waf-poll', outcome: 'ok' });
  });
});

describe('the outcome CHECK constraint', () => {
  const insert = (outcome: string | null) =>
    t.raw
      .prepare('INSERT INTO job_runs (job, started_at, outcome) VALUES (?, ?, ?)')
      .run('waf-poll', AT.toISOString(), outcome);

  it.each(['ok', 'failed', 'skipped'])('accepts %s', (outcome) => {
    expect(() => insert(outcome)).not.toThrow();
  });

  it('accepts NULL — that is how an in-flight run is represented', () => {
    // SQLite satisfies a CHECK when the expression is true OR null, and
    // `NULL IN (…)` is null. The whole "no fourth member" decision rests on this.
    expect(() => insert(null)).not.toThrow();
  });

  it.each(['running', 'partial', ''])('rejects %s', (outcome) => {
    expect(() => insert(outcome)).toThrow(/CHECK constraint failed/);
  });
});

describe('detail', () => {
  it('deep round-trips a real data-quality result set', async () => {
    const checks: DataQualityCheckResult[] = [
      {
        id: 'broken_integration_refs',
        label: 'Broken refs',
        severity: 'error',
        count: 2,
        sample: ['a', 'b'],
      },
      {
        id: 'logo_404',
        label: 'Logo 404s',
        severity: 'warn',
        count: 0,
        sample: [],
        skipped: true,
        note: 'no creds',
      },
    ];
    const handle = await startJobRun(t.db, 'data-quality', AT);
    await finishJobRun(handle, {
      outcome: 'failed',
      detail: { job: 'data-quality', durationMs: 1200, checks, email: 'sent' },
      finishedAt: DONE,
    });

    const [row] = await rows();
    expect(row?.detail).toEqual({
      job: 'data-quality',
      durationMs: 1200,
      checks,
      email: 'sent',
    });
  });

  it('replaces an oversized payload with a sentinel rather than failing the write', async () => {
    const handle = await startJobRun(t.db, 'data-quality', AT);
    const huge: DataQualityCheckResult[] = [
      {
        id: 'x',
        label: 'x',
        severity: 'warn',
        count: 1,
        sample: ['y'.repeat(DETAIL_MAX_BYTES + 1)],
      },
    ];

    await finishJobRun(handle, {
      outcome: 'ok',
      detail: { job: 'data-quality', durationMs: 1, checks: huge, email: 'sent' },
      finishedAt: DONE,
    });

    const [row] = await rows();
    // The run itself is still recorded truthfully; only the payload is dropped.
    expect(row?.outcome).toBe('ok');
    expect(row?.detail).toEqual({
      job: 'data-quality',
      reason: expect.stringContaining('truncated'),
    });
  });
});

describe('withJobRun', () => {
  it('records a thrown handler as failed and RETHROWS, so the queue still retries', async () => {
    const boom = new Error('boom');

    await expect(
      withJobRun({ db: t.db, job: 'request-reconcile', now: () => AT }, () => Promise.reject(boom)),
    ).rejects.toThrow(boom);

    const [row] = await rows();
    expect(row).toMatchObject({
      outcome: 'failed',
      finishedAt: AT.toISOString(),
      detail: { job: 'request-reconcile', reason: 'boom' },
    });
  });

  it('does NOT throw when the handler merely REPORTS failure', async () => {
    // Load-bearing: only `reconcile` retries today, and instrumenting must not
    // silently extend that to the other seven.
    await expect(
      withJobRun({ db: t.db, job: 'home-stats', now: () => AT }, async () => ({
        outcome: 'failed' as const,
      })),
    ).resolves.toBeUndefined();

    expect((await rows())[0]).toMatchObject({ outcome: 'failed' });
  });

  it('still runs the job — and returns normally — when the bookkeeping table is gone', async () => {
    breakTable();
    const run = vi.fn().mockResolvedValue({ outcome: 'ok' as const });

    await expect(withJobRun({ db: t.db, job: 'waf-poll' }, run)).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('writes the entry row BEFORE invoking the job', async () => {
    let seenDuringRun: unknown[] = [];
    await withJobRun({ db: t.db, job: 'data-quality', now: () => AT }, async () => {
      seenDuringRun = await rows();
      return { outcome: 'ok' as const };
    });

    // The row the job saw mid-flight is the unfinished one. This is the property
    // an isolate that never comes back relies on.
    expect(seenDuringRun).toHaveLength(1);
    expect(seenDuringRun[0]).toMatchObject({ finishedAt: null, outcome: null });
  });
});

describe('read helpers', () => {
  const seed = (
    job: string,
    startedAt: string,
    over: { finishedAt?: string; outcome?: string; detail?: unknown } = {},
  ) =>
    t.raw
      .prepare(
        'INSERT INTO job_runs (job, started_at, finished_at, outcome, detail) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        job,
        startedAt,
        over.finishedAt ?? null,
        over.outcome ?? null,
        over.detail === undefined ? null : JSON.stringify(over.detail),
      );

  it('returns the newest run per job', async () => {
    seed('waf-poll', '2026-08-11T00:00:00.000Z', {
      outcome: 'ok',
      finishedAt: '2026-08-11T00:00:01.000Z',
    });
    seed('waf-poll', '2026-08-13T00:00:00.000Z', {
      outcome: 'failed',
      finishedAt: '2026-08-13T00:00:01.000Z',
    });
    seed('waf-poll', '2026-08-12T00:00:00.000Z', {
      outcome: 'ok',
      finishedAt: '2026-08-12T00:00:01.000Z',
    });

    expect((await latestJobRun(t.db, 'waf-poll'))?.outcome).toBe('failed');
  });

  it('breaks a started_at tie on the higher id — the later insert', async () => {
    seed('waf-poll', AT.toISOString(), { outcome: 'ok', finishedAt: DONE.toISOString() });
    seed('waf-poll', AT.toISOString(), { outcome: 'skipped', finishedAt: DONE.toISOString() });

    expect((await latestJobRun(t.db, 'waf-poll'))?.outcome).toBe('skipped');
  });

  it('omits a job that has never run rather than reporting it as null', async () => {
    seed('waf-poll', AT.toISOString());

    const map = await latestJobRuns(t.db, ['waf-poll', 'home-stats']);
    expect(map['waf-poll']).toBeDefined();
    expect('home-stats' in map).toBe(false);
  });

  it('skips an in-flight run when looking for the last COMPLETED result', async () => {
    seed('data-quality', '2026-08-12T04:00:00.000Z', {
      finishedAt: '2026-08-12T04:01:00.000Z',
      outcome: 'ok',
      detail: { job: 'data-quality', checks: [] },
    });
    // Today's 04:00 run, still going: no finish stamp, no payload.
    seed('data-quality', '2026-08-13T04:00:00.000Z');

    const row = await latestCompletedJobRun(t.db, 'data-quality');
    // Yesterday's stored result, not a blank — that is the point.
    expect(row?.startedAt).toBe('2026-08-12T04:00:00.000Z');
  });

  it('steps past a completed FAILURE envelope when a detail key is required', async () => {
    // Yesterday's good run — has a checks payload.
    seed('data-quality', '2026-08-12T04:00:00.000Z', {
      finishedAt: '2026-08-12T04:01:00.000Z',
      outcome: 'ok',
      detail: { job: 'data-quality', checks: [{ id: 'x' }] },
    });
    // Today's run crashed before producing checks: completed, non-null detail,
    // but a `{ job, reason }` envelope with no `checks`.
    seed('data-quality', '2026-08-13T04:00:00.000Z', {
      finishedAt: '2026-08-13T04:00:05.000Z',
      outcome: 'failed',
      detail: { job: 'data-quality', reason: 'boom' },
    });

    // Without the key requirement the newest completed row wins — the crash.
    expect((await latestCompletedJobRun(t.db, 'data-quality'))?.outcome).toBe('failed');
    // With it, the crash is stepped past and yesterday's good run is served,
    // so a pre-run crash cannot shadow the last stored checks.
    const row = await latestCompletedJobRun(t.db, 'data-quality', { requireDetailKey: 'checks' });
    expect(row?.startedAt).toBe('2026-08-12T04:00:00.000Z');
  });
});

describe('orphanSweepDetail', () => {
  it('extracts the sweep half of a drift payload', () => {
    const sweep = { ran: true, ok: true, totalOrphans: 0, totalDeleted: 0, entities: [] };
    expect(
      orphanSweepDetail({ job: 'algolia-drift', report: { ran: true, drifted: [] }, sweep }),
    ).toEqual(sweep);
  });

  it.each([
    ['a payload from another job', { job: 'data-quality', checks: [] }],
    ['a crash envelope with no sweep', { job: 'algolia-drift', reason: 'no_creds' }],
    ['a non-object', 'not json'],
    ['null', null],
  ])('returns null for %s', (_label, detail) => {
    expect(orphanSweepDetail(detail)).toBeNull();
  });
});
