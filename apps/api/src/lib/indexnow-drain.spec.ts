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
 *   - **Tiers (AECI-1136).** A queued URL's tier only improves, the daily send
 *     goes tier 1 first and tier 4 last, a deep buffer is paged up to 10,000 URLs
 *     in one request, and the delete takes exactly the rows that were sent.
 *
 * Row counts are read back with `select`, never from a batch return value: the
 * harness's `db.batch` shim and D1 alike are unreliable about `meta.changes`.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, indexnowQueue, slugRedirects } from '../db/schema';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';

import { INDEXNOW_MAX_URLS } from './indexnow';
import {
  drainIndexNowQueue,
  drainMetricOutcome,
  INDEXNOW_DRAINED_ACTION,
  INDEXNOW_EXPIRED_METRIC,
  INDEXNOW_SUBMIT_METRIC,
  INDEXNOW_SUBMITTED_URLS_METRIC,
  type IndexNowDrainLogSink,
} from './indexnow-drain';
import {
  deleteDrainedIndexNowUrls,
  enqueueIndexNowUrls,
  INDEXNOW_DELETE_IDS_PER_STATEMENT,
  INDEXNOW_DRAIN_BATCH_SIZE,
  INDEXNOW_INSERT_ROWS_PER_STATEMENT,
  INDEXNOW_QUEUE_MAX_AGE_DAYS,
  indexNowEntriesByTier,
  indexNowInsertStatements,
  readPendingIndexNowUrls,
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
  // the largest submission production has made carried 107. Four bound values
  // per row means an unchunked INSERT of 26 URLs is already over the limit, and
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

  it('stays under the cap with the priority column bound (AECI-1136)', async () => {
    // Four bound values per row since `priority` landed. A full chunk must be
    // exactly at or under 100; 33 rows (the old size) would bind 132.
    const entries = Array.from({ length: INDEXNOW_INSERT_ROWS_PER_STATEMENT * 2 }, (_, i) => ({
      url: url(`p-${i}`),
      priority: (i % 4) + 1,
    }));
    const stmts = indexNowInsertStatements(t.db, entries, NOW.toISOString(), 'promote');
    expect(stmts).toHaveLength(2);
    for (const stmt of stmts) {
      const n = stmt.toSQL().params.length;
      expect(n).toBeLessThanOrEqual(100);
      expect(n).toBe(INDEXNOW_INSERT_ROWS_PER_STATEMENT * 4);
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

  it('does not submit a URL whose slug has retired (AECI-978)', async () => {
    // Migration 0039 seeds `autodesk-construction-cloud` -> `autodesk-forma`. A
    // promote can buffer the old URL minutes before the retirement row lands, so
    // this drain-time filter is the only gate that catches it. Asking an engine to
    // crawl a 301 spends one of a strictly limited number of submissions.
    await enqueueIndexNowUrls(t.db, [url('autodesk-construction-cloud'), url('revit')]);

    const fetchImpl = respond(200);
    const s = sinks();
    const result = await drainIndexNowQueue({
      db: t.db,
      env: ENV,
      ...s.deps,
      fetchImpl,
      now: () => NOW,
    });

    const body = JSON.parse((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
    expect(body.urlList).toEqual([url('revit')]);
    // Submitted counts what went on the wire; deleted counts what left the buffer.
    // The retired row is CONSUMED — leaving it would re-run this filter forever.
    expect(result).toMatchObject({ ok: true, submitted: 1, retired: 1, deleted: 2 });
    expect(await queued()).toEqual([]);
    expect(s.logs).toContainEqual(
      expect.objectContaining({ message: 'aeci.indexnow.retired_skipped', urls_count: 1 }),
    );
  });

  it('makes no request at all when every buffered URL has retired', async () => {
    await enqueueIndexNowUrls(t.db, [url('autodesk-construction-cloud')]);

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
    expect(result).toMatchObject({ ok: true, submitted: 0, retired: 1, deleted: 1 });
    expect(await queued()).toEqual([]);
  });

  it('matches the retired path exactly, never by prefix', async () => {
    // `/products/procore-x` must survive a retirement of `/products/procore`, and a
    // vendor mapping must not suppress a product URL of the same slug.
    await t.db.insert(slugRedirects).values({
      entity: 'product',
      fromSlug: 'procore',
      toSlug: 'procore-platform',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await enqueueIndexNowUrls(t.db, [
      url('procore'),
      url('procore-x'),
      'https://www.aecintegrations.com/vendors/procore',
    ]);

    const fetchImpl = respond(200);
    const s = sinks();
    await drainIndexNowQueue({
      db: t.db,
      env: ENV,
      ...s.deps,
      fetchImpl,
      now: () => NOW,
    });

    const body = JSON.parse((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
    expect(body.urlList).toEqual([
      url('procore-x'),
      'https://www.aecintegrations.com/vendors/procore',
    ]);
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
      // the real schedule is 1 s + 4 s, fine in a daily cron and fatal to a 5 s
      // test timeout.
      sleep: async () => {},
    });

    expect(result).toMatchObject({ ok: false, submitted: 2, deleted: 0, pending: 2, status: 429 });
    expect(result.reason).toContain('429');
    // A refusal, not a local fault: the heartbeat must not reach the combined
    // cron-failure alert, which pages on any `outcome:failed` (AECI-864).
    expect(drainMetricOutcome(result)).toBe('refused');
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
    // The drain-level statement of the ceiling. The drain runs once a day
    // (AECI-1136), and this is what makes that one REQUEST a day rather than three:
    // production
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
    expect(drainMetricOutcome(result)).toBe('ok');
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
    expect(drainMetricOutcome(result)).toBe('skipped');
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
    expect(result.refused).toBeUndefined();
    // The one drain outcome that reaches the combined cron-failure alert.
    expect(drainMetricOutcome(result)).toBe('failed');
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

  it('leaves a URL buffered mid-drain for the next run', async () => {
    await enqueueIndexNowUrls(t.db, [url('first')]);

    // A promote that commits while the request is in flight. Its id was never
    // read, so the id-list delete must not take it.
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

// ─── AECI-1136: tiers, ordering, paging, exact deletion ──────────────────────

async function rowsByUrl(): Promise<Map<string, { priority: number; queuedAt: string }>> {
  const rows = await t.db
    .select({
      url: indexnowQueue.url,
      priority: indexnowQueue.priority,
      queuedAt: indexnowQueue.queuedAt,
    })
    .from(indexnowQueue);
  return new Map(rows.map((r) => [r.url, { priority: r.priority, queuedAt: r.queuedAt }]));
}

const at = (iso: string) => () => new Date(iso);

describe('indexNowEntriesByTier', () => {
  it("takes each URL's tier from the GSC entry for the same URL, and 4 for the rest", () => {
    const entries = indexNowEntriesByTier(
      [url('new-one'), url('edited'), 'https://www.aecintegrations.com/products', url('pair-edit')],
      [
        { url: url('new-one'), reason: 'product.created' },
        { url: url('edited'), reason: 'product.updated' },
        { url: url('pair-edit'), reason: 'pair.updated' },
        // A GSC entry the IndexNow set does not contain adds nothing.
        { url: url('not-in-indexnow'), reason: 'product.created' },
      ],
    );
    expect(entries).toEqual([
      { url: url('new-one'), priority: 1 },
      { url: url('edited'), priority: 2 },
      // A hub page: no GSC reason, so the lowest tier.
      { url: 'https://www.aecintegrations.com/products', priority: 4 },
      { url: url('pair-edit'), priority: 4 },
    ]);
  });

  it('keeps the best tier when one URL has two reasons', () => {
    expect(
      indexNowEntriesByTier(
        [url('x')],
        [
          { url: url('x'), reason: 'product.minor' },
          { url: url('x'), reason: 'product.created' },
        ],
      ),
    ).toEqual([{ url: url('x'), priority: 1 }]);
  });
});

describe('enqueueIndexNowUrls — tier only improves (AECI-1136)', () => {
  it('raises a queued URL to a better tier and keeps its original queued_at', async () => {
    expect(
      await enqueueIndexNowUrls(
        t.db,
        [{ url: url('a'), priority: 4 }],
        'promote',
        at('2026-09-01T00:00:00.000Z'),
      ),
    ).toBe(1);
    // A better tier later: the row rises, but it is an UPDATE, not a new row.
    expect(
      await enqueueIndexNowUrls(
        t.db,
        [{ url: url('a'), priority: 1 }],
        'vendor',
        at('2026-09-02T00:00:00.000Z'),
      ),
    ).toBe(0);
    expect((await rowsByUrl()).get(url('a'))).toEqual({
      priority: 1,
      queuedAt: '2026-09-01T00:00:00.000Z',
    });
  });

  it('never lowers a tier', async () => {
    await enqueueIndexNowUrls(
      t.db,
      [{ url: url('a'), priority: 2 }],
      'promote',
      at('2026-09-01T00:00:00.000Z'),
    );
    await enqueueIndexNowUrls(
      t.db,
      [{ url: url('a'), priority: 4 }],
      'promote',
      at('2026-09-02T00:00:00.000Z'),
    );
    await enqueueIndexNowUrls(t.db, [url('a')], 'promote', at('2026-09-03T00:00:00.000Z'));
    expect((await rowsByUrl()).get(url('a'))).toEqual({
      priority: 2,
      queuedAt: '2026-09-01T00:00:00.000Z',
    });
  });

  it('buffers a bare string at tier 4 and collapses in-call duplicates to the best tier', async () => {
    await enqueueIndexNowUrls(t.db, [
      url('hub'),
      { url: url('b'), priority: 3 },
      { url: url('b'), priority: 1 },
    ]);
    const rows = await rowsByUrl();
    expect(rows.get(url('hub'))?.priority).toBe(4);
    expect(rows.get(url('b'))?.priority).toBe(1);
  });
});

describe('drainIndexNowQueue — daily, tiered (AECI-1136)', () => {
  function sentUrls(fetchImpl: typeof fetch): string[] {
    return JSON.parse((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]![1].body).urlList;
  }

  it('sends highest tier first, oldest first within a tier, and tier 4 last', async () => {
    // Inserted in the WRONG order on purpose: the oldest row is tier 4.
    await enqueueIndexNowUrls(
      t.db,
      [{ url: url('t4-old'), priority: 4 }],
      'promote',
      at('2026-09-09T01:00:00.000Z'),
    );
    await enqueueIndexNowUrls(
      t.db,
      [{ url: url('t2'), priority: 2 }],
      'promote',
      at('2026-09-09T02:00:00.000Z'),
    );
    await enqueueIndexNowUrls(
      t.db,
      [{ url: url('t1-new'), priority: 1 }],
      'promote',
      at('2026-09-09T04:00:00.000Z'),
    );
    await enqueueIndexNowUrls(
      t.db,
      [{ url: url('t1-old'), priority: 1 }],
      'promote',
      at('2026-09-09T03:00:00.000Z'),
    );
    await enqueueIndexNowUrls(
      t.db,
      [{ url: url('t3'), priority: 3 }],
      'promote',
      at('2026-09-09T05:00:00.000Z'),
    );

    const fetchImpl = respond(200);
    const s = sinks();
    const result = await drainIndexNowQueue({
      db: t.db,
      env: ENV,
      ...s.deps,
      fetchImpl,
      now: () => NOW,
    });

    expect(sentUrls(fetchImpl)).toEqual([
      url('t1-old'),
      url('t1-new'),
      url('t2'),
      url('t3'),
      url('t4-old'),
    ]);
    expect(result.byTier).toEqual({ 1: 2, 2: 1, 3: 1, 4: 1 });
    expect(s.metrics.filter((m) => m.metric === INDEXNOW_SUBMITTED_URLS_METRIC)).toEqual([
      { metric: INDEXNOW_SUBMITTED_URLS_METRIC, value: 2, tags: ['source:cron', 'tier:1'] },
      { metric: INDEXNOW_SUBMITTED_URLS_METRIC, value: 1, tags: ['source:cron', 'tier:2'] },
      { metric: INDEXNOW_SUBMITTED_URLS_METRIC, value: 1, tags: ['source:cron', 'tier:3'] },
      { metric: INDEXNOW_SUBMITTED_URLS_METRIC, value: 1, tags: ['source:cron', 'tier:4'] },
    ]);
  });

  it('pages the read and sends up to 10,000 URLs in ONE request, leaving the lowest tier behind', async () => {
    // 10,050 rows: 10,000 at tier 2 and 50 at tier 4, the tier-4 rows OLDEST.
    // The day's cap has to cut the tier-4 rows, not the newest tier-2 ones.
    const low = Array.from({ length: 50 }, (_, i) => ({ url: url(`low-${i}`), priority: 4 }));
    const high = Array.from({ length: INDEXNOW_MAX_URLS }, (_, i) => ({
      url: url(`high-${i}`),
      priority: 2,
    }));
    await enqueueIndexNowUrls(t.db, low, 'promote', at('2026-09-09T00:00:00.000Z'));
    await enqueueIndexNowUrls(t.db, high, 'promote', at('2026-09-09T01:00:00.000Z'));

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
    const sent = sentUrls(fetchImpl);
    expect(sent).toHaveLength(INDEXNOW_MAX_URLS);
    expect(new Set(sent).size).toBe(INDEXNOW_MAX_URLS);
    expect(sent.some((u) => u.includes('/low-'))).toBe(false);
    expect(result).toMatchObject({
      ok: true,
      submitted: INDEXNOW_MAX_URLS,
      deleted: INDEXNOW_MAX_URLS,
      pending: 50,
    });
    expect((await queued()).every((u) => u.includes('/low-'))).toBe(true);
    // One audit row for the whole day, however many delete statements it took.
    const audits = await drainAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({
      rowsDeleted: INDEXNOW_MAX_URLS,
      byTier: { 2: INDEXNOW_MAX_URLS },
    });
  });

  it('keyset pages never overlap and never skip', async () => {
    const entries = Array.from({ length: 7 }, (_, i) => ({
      url: url(`k-${i}`),
      priority: (i % 3) + 1,
    }));
    await enqueueIndexNowUrls(t.db, entries, 'promote', at('2026-09-09T00:00:00.000Z'));
    const p1 = await readPendingIndexNowUrls(t.db, 3);
    const p2 = await readPendingIndexNowUrls(t.db, 3, p1[p1.length - 1]);
    const p3 = await readPendingIndexNowUrls(t.db, 3, p2[p2.length - 1]);
    const all = [...p1, ...p2, ...p3];
    expect(all).toHaveLength(7);
    expect(new Set(all.map((r) => r.id)).size).toBe(7);
    expect(all.map((r) => r.priority)).toEqual([1, 1, 1, 2, 2, 3, 3]);
    expect(INDEXNOW_DRAIN_BATCH_SIZE).toBeLessThanOrEqual(2_000);
  });

  it('deletes exactly the sent rows, even when a better-tier row lands mid-request', async () => {
    // The hazard that rules out a tier watermark: a tier-1 URL buffered while
    // the request is in flight sorts BEFORE every sent tier-3 row. A "delete
    // everything up to the last sent row" would drop it unsent.
    await enqueueIndexNowUrls(t.db, [
      { url: url('sent-a'), priority: 3 },
      { url: url('sent-b'), priority: 3 },
    ]);
    const fetchImpl = vi.fn(async () => {
      await enqueueIndexNowUrls(t.db, [{ url: url('late-tier-1'), priority: 1 }]);
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

    expect(result).toMatchObject({ submitted: 2, deleted: 2, pending: 1 });
    expect(await queued()).toEqual([url('late-tier-1')]);
  });

  it('chunks the delete under the 100-bound-parameter cap', () => {
    const ids = Array.from({ length: 250 }, (_, i) => i + 1);
    const stmts = deleteDrainedIndexNowUrls(t.db, ids);
    expect(stmts).toHaveLength(Math.ceil(250 / INDEXNOW_DELETE_IDS_PER_STATEMENT));
    for (const stmt of stmts) {
      expect(
        (stmt as unknown as { toSQL(): { params: unknown[] } }).toSQL().params.length,
      ).toBeLessThanOrEqual(100);
    }
  });

  it('on a 429 keeps every tiered row, writes no audit row and emits no per-tier count', async () => {
    await enqueueIndexNowUrls(t.db, [
      { url: url('a'), priority: 1 },
      { url: url('b'), priority: 4 },
    ]);
    const fetchImpl = respond(429, '{"errorCode":"TooManyRequests"}');
    const s = sinks();
    const result = await drainIndexNowQueue({
      db: t.db,
      env: ENV,
      ...s.deps,
      fetchImpl,
      now: () => NOW,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, status: 429, attempts: 1, deleted: 0, pending: 2 });
    expect(drainMetricOutcome(result)).toBe('refused');
    expect((await rowsByUrl()).get(url('a'))?.priority).toBe(1);
    expect(await drainAudits()).toHaveLength(0);
    expect(s.metrics.filter((m) => m.metric === INDEXNOW_SUBMITTED_URLS_METRIC)).toEqual([]);
  });
});
