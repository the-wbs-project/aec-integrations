/**
 * The IndexNow buffer + drain (AECI-826 / §20.2) against the in-memory D1 harness.
 *
 * Five behaviours here are the ones that cost something if they regress, and each
 * is observed rather than assumed:
 *
 *   - **A burst of promotes produces ONE request.** This is the acceptance
 *     criterion the whole issue is about. Asserted by buffering three times and
 *     counting `fetch` calls after a single drain.
 *   - **A 429 leaves every row in place.** If the drain deleted on failure, the
 *     URLs would be lost silently — the same class of invisible loss the old
 *     design had, just moved.
 *   - **The delete and its `audit_log` row commit together** (§26.1's
 *     scheduled-deletion exception), and a run that deletes nothing writes no row.
 *   - **Dedupe is real.** The same URL buffered twice is submitted once.
 *   - **A row queued past the max age is dropped rather than submitted**, so a
 *     week-long outage cannot grow the table without bound.
 *
 * Row counts are read back with `select`, never from a batch return value: the
 * harness's `db.batch` shim and D1 alike are unreliable about `meta.changes`.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, indexnowQueue } from '../db/schema';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';

import {
  drainIndexNowQueue,
  INDEXNOW_DRAINED_ACTION,
  INDEXNOW_EXPIRED_METRIC,
  INDEXNOW_SUBMIT_METRIC,
  type IndexNowDrainLogSink,
} from './indexnow-drain';
import {
  enqueueIndexNowUrls,
  INDEXNOW_INSERT_ROWS_PER_STATEMENT,
  INDEXNOW_QUEUE_MAX_AGE_DAYS,
  indexNowInsertStatements,
} from './indexnow-queue';

const NOW = new Date('2026-09-09T12:00:00.000Z');

const ENV = {
  INDEXNOW_KEY: 'a1b2c3d4e5f6a7b8',
  PUBLIC_SITE_URL: 'https://www.aecintegrations.com',
} as unknown as Env;

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

/**
 * A metric + log sink that records instead of emitting.
 *
 * `logs` is typed off `IndexNowDrainLogSink`'s own parameter rather than
 * re-declared, so every field the drain reports (`attempts`, `status`, `pending`,
 * `urls_count`) is assertable here and a new one cannot go unobservable.
 */
type DrainLogEvent = Parameters<IndexNowDrainLogSink>[0];

function sinks() {
  const metrics: { metric: string; value: number; tags: string[] }[] = [];
  const logs: DrainLogEvent[] = [];
  return {
    metrics,
    logs,
    deps: {
      metrics: {
        count: (metric: string, value: number, tags: string[]) =>
          void metrics.push({ metric, value, tags }),
        gauge: (metric: string, value: number, tags: string[]) =>
          void metrics.push({ metric, value, tags }),
      },
      log: (event: DrainLogEvent) => void logs.push(event),
    },
  };
}

function respond(status: number, body = ''): typeof fetch {
  return vi.fn().mockResolvedValue(new Response(body, { status })) as unknown as typeof fetch;
}

async function queued(): Promise<string[]> {
  const rows = await t.db
    .select({ url: indexnowQueue.url })
    .from(indexnowQueue)
    .orderBy(indexnowQueue.id);
  return rows.map((r) => r.url);
}

async function drainAudits() {
  return t.db.select().from(auditLog).where(eq(auditLog.action, INDEXNOW_DRAINED_ACTION));
}

const url = (slug: string) => `https://www.aecintegrations.com/products/${slug}`;

describe('enqueueIndexNowUrls', () => {
  it('buffers each URL once — the same URL twice is one row (dedupe)', async () => {
    expect(await enqueueIndexNowUrls(t.db, [url('revit'), url('procore')])).toBe(2);
    // A second promote of the same product inside the drain window. The
    // pre-AECI-826 design made this a second outbound request.
    expect(await enqueueIndexNowUrls(t.db, [url('revit'), url('bluebeam')])).toBe(1);
    expect(await queued()).toEqual([url('revit'), url('procore'), url('bluebeam')]);
  });

  it('is a no-op on an empty list', async () => {
    expect(await enqueueIndexNowUrls(t.db, [])).toBe(0);
    expect(await queued()).toEqual([]);
  });

  // ── D1's 100-bound-parameter cap ──────────────────────────────────────────
  //
  // The set is unbounded — one URL per integration in the promote payload — and
  // the largest submission production has made carried 107. Three bound values
  // per row means an unchunked INSERT of 34 URLs is already over the limit, and
  // the promote's fail-open catch would swallow the rejection and buffer NOTHING.

  it('keeps every statement under D1s 100-bound-parameter cap', async () => {
    // The load-bearing assertion. better-sqlite3 binds 32,766 parameters happily,
    // so the behavioural test below passes with or without the chunking; only the
    // emitted SQL can tell the two apart.
    const urls = Array.from({ length: 107 }, (_, i) => url(`p-${i}`));
    const stmts = indexNowInsertStatements(t.db, urls, NOW.toISOString(), 'promote');

    expect(stmts).toHaveLength(Math.ceil(107 / INDEXNOW_INSERT_ROWS_PER_STATEMENT));
    for (const stmt of stmts) {
      expect(stmt.toSQL().params.length).toBeLessThanOrEqual(100);
    }
  });

  it('buffers a URL set larger than one statement can carry', async () => {
    const urls = Array.from({ length: INDEXNOW_INSERT_ROWS_PER_STATEMENT * 3 + 8 }, (_, i) =>
      url(`p-${i}`),
    );

    expect(await enqueueIndexNowUrls(t.db, urls)).toBe(urls.length);
    expect(await queued()).toHaveLength(urls.length);
    // Dedupe still spans chunk boundaries — the unique index does the work, not
    // the statement grouping.
    expect(await enqueueIndexNowUrls(t.db, urls)).toBe(0);
  });
});

describe('drainIndexNowQueue', () => {
  it('collapses a burst of promotes into ONE IndexNow request (the AC)', async () => {
    // Three promotes, as a bulk curation session produces. Before AECI-826 this
    // was three outbound requests; eleven in seven minutes is what got us 429ed.
    await enqueueIndexNowUrls(t.db, [url('revit'), '/products']);
    await enqueueIndexNowUrls(t.db, [url('procore')]);
    await enqueueIndexNowUrls(t.db, [url('bluebeam')]);

    const fetchImpl = respond(200);
    const s = sinks();
    const result = await drainIndexNowQueue({
      db: t.db,
      env: ENV,
      ...s.deps,
      fetchImpl,
      now: () => NOW,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
    expect(body.urlList).toHaveLength(4);
    expect(body.host).toBe('www.aecintegrations.com');
    expect(body.keyLocation).toBe('https://www.aecintegrations.com/a1b2c3d4e5f6a7b8.txt');
    expect(result).toMatchObject({ ok: true, submitted: 4, deleted: 4, pending: 0 });
    expect(await queued()).toEqual([]);
  });

  it('emits aeci.indexnow.submit{source:cron,outcome:ok} on success', async () => {
    await enqueueIndexNowUrls(t.db, [url('revit')]);
    const s = sinks();
    await drainIndexNowQueue({
      db: t.db,
      env: ENV,
      ...s.deps,
      fetchImpl: respond(200),
      now: () => NOW,
    });
    expect(s.metrics).toContainEqual({
      metric: INDEXNOW_SUBMIT_METRIC,
      value: 1,
      tags: ['source:cron', 'outcome:ok'],
    });
  });

  it('writes ONE audit row in the same commit as the delete (§26.1)', async () => {
    await enqueueIndexNowUrls(t.db, [url('revit'), url('procore')]);
    const s = sinks();
    await drainIndexNowQueue({
      db: t.db,
      env: ENV,
      ...s.deps,
      fetchImpl: respond(200),
      now: () => NOW,
    });

    const rows = await drainAudits();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorType).toBe('system');
    expect(rows[0]!.entityType).toBe('indexnow_queue');
    expect(rows[0]!.metadata).toMatchObject({ rowsDeleted: 2, reason: 'submitted', status: 200 });
  });

  it('KEEPS every row on a 429 and writes no audit row', async () => {
    // The failure this whole issue is about. Deleting here would lose the URLs
    // silently, which is the old defect wearing a new hat.
    await enqueueIndexNowUrls(t.db, [url('revit'), url('procore')]);
    const s = sinks();

    const result = await drainIndexNowQueue({
      db: t.db,
      env: ENV,
      ...s.deps,
      fetchImpl: respond(429, '{"errorCode":"TooManyRequests"}'),
      now: () => NOW,
      // Instant backoff. Unreachable on this path since AECI-833 gated the bare
      // 429, but kept so the test still passes if the gate is ever loosened —
      // the real schedule is 1 s + 4 s, fine in a twenty-minute cron and fatal to
      // a 5 s test timeout.
      sleep: async () => {},
    });

    expect(result).toMatchObject({ ok: false, submitted: 2, deleted: 0, pending: 2, status: 429 });
    expect(result.reason).toContain('429');
    expect(await queued()).toHaveLength(2);
    expect(await drainAudits()).toHaveLength(0);
    expect(s.metrics).toContainEqual({
      metric: INDEXNOW_SUBMIT_METRIC,
      value: 1,
      tags: ['source:cron', 'outcome:failed'],
    });
    expect(s.logs.some((l) => l.level === 'warn' && l.reason?.includes('429'))).toBe(true);
  });

  it('spends exactly ONE request on a throttled tick (AECI-833)', async () => {
    // The drain-level statement of the ceiling. `*/20` gives 72 ticks a day, and
    // this is what makes that 72 REQUESTS a day rather than 216: production
    // measured `attempts: 3` on its first real tick under a sustained throttle,
    // spending three guaranteed-failing requests against the limiter it was
    // waiting on. A bare 429 is not retried (`lib/indexnow.ts` isRetryableStatus).
    await enqueueIndexNowUrls(t.db, [url('revit'), url('procore')]);
    const fetchImpl = respond(429, '{"errorCode":"TooManyRequests"}');
    const s = sinks();

    const result = await drainIndexNowQueue({
      db: t.db,
      env: ENV,
      ...s.deps,
      fetchImpl,
      now: () => NOW,
      // Deliberately NO injected sleep. A retried tick would wait the real 1 s +
      // 4 s and blow the default timeout, so a regression here fails loudly
      // rather than passing slowly.
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, status: 429, attempts: 1 });
    expect(
      s.logs.some((l) => l.message === 'aeci.indexnow.submit_failed' && l.attempts === 1),
    ).toBe(true);
  });

  it('makes no request at all when the buffer is empty', async () => {
    const fetchImpl = respond(200);
    const s = sinks();
    const result = await drainIndexNowQueue({
      db: t.db,
      env: ENV,
      ...s.deps,
      fetchImpl,
      now: () => NOW,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, submitted: 0, pending: 0 });
    // No submission means no submit metric. The always-on heartbeat is
    // `aeci.indexnow.drain`, emitted by the scheduled.ts wrapper, not here.
    expect(s.metrics.filter((m) => m.metric === INDEXNOW_SUBMIT_METRIC)).toEqual([]);
  });

  it('skips with no_creds when INDEXNOW_KEY is absent, and touches nothing', async () => {
    await enqueueIndexNowUrls(t.db, [url('revit')]);
    const fetchImpl = respond(200);
    const s = sinks();

    const result = await drainIndexNowQueue({
      db: t.db,
      env: { PUBLIC_SITE_URL: ENV.PUBLIC_SITE_URL } as unknown as Env,
      ...s.deps,
      fetchImpl,
      now: () => NOW,
    });

    expect(result).toMatchObject({ ok: false, reason: 'no_creds' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await queued()).toHaveLength(1);
  });

  it('fails without submitting when PUBLIC_SITE_URL is unparseable', async () => {
    await enqueueIndexNowUrls(t.db, [url('revit')]);
    const fetchImpl = respond(200);
    const s = sinks();

    const result = await drainIndexNowQueue({
      db: t.db,
      env: { INDEXNOW_KEY: 'k', PUBLIC_SITE_URL: 'not a url' } as unknown as Env,
      ...s.deps,
      fetchImpl,
      now: () => NOW,
    });

    expect(result).toMatchObject({ ok: false, reason: 'invalid_public_site_url' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('drops rows past the max age instead of submitting them, and audits the drop', async () => {
    const old = new Date(NOW.getTime() - (INDEXNOW_QUEUE_MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1_000);
    await enqueueIndexNowUrls(t.db, [url('ancient')], 'promote', () => old);
    await enqueueIndexNowUrls(t.db, [url('fresh')], 'promote', () => NOW);

    const fetchImpl = respond(200);
    const s = sinks();
    const result = await drainIndexNowQueue({
      db: t.db,
      env: ENV,
      ...s.deps,
      fetchImpl,
      now: () => NOW,
    });

    expect(result).toMatchObject({ expired: 1, submitted: 1, deleted: 1 });
    const body = JSON.parse((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
    expect(body.urlList).toEqual([url('fresh')]);
    expect(s.metrics).toContainEqual({
      metric: INDEXNOW_EXPIRED_METRIC,
      value: 1,
      tags: ['trigger:cron'],
    });
    // Two audit rows: one for the expiry sweep, one for the drain. They are
    // separate commits on purpose — sharing a batch would let the two delete
    // predicates overlap and double-count the same row.
    const rows = await drainAudits();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r.metadata as { reason: string }).reason).sort()).toEqual([
      'expired',
      'submitted',
    ]);
  });

  it('leaves a URL buffered mid-drain for the next tick', async () => {
    await enqueueIndexNowUrls(t.db, [url('first')]);

    // A promote that commits while the request is in flight. Its row gets a
    // higher `id` than the drain's cursor, so `id <= maxId` must not take it.
    const fetchImpl = vi.fn(async () => {
      await enqueueIndexNowUrls(t.db, [url('mid-flight')]);
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    const s = sinks();
    const result = await drainIndexNowQueue({
      db: t.db,
      env: ENV,
      ...s.deps,
      fetchImpl,
      now: () => NOW,
    });

    expect(result).toMatchObject({ submitted: 1, deleted: 1, pending: 1 });
    expect(await queued()).toEqual([url('mid-flight')]);
  });
});
