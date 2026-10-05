/**
 * Recrawl cause linkage (AECI-1184) against the in-memory D1 harness.
 *
 * The behaviours that cost something if they regress:
 *
 *   - **Causes do not dedupe.** Two writes on one URL are one queue row and two
 *     cause rows. Deduping the causes would lose exactly the second vendor.
 *   - **The drain copies every cause onto the submission**, in its own batch,
 *     and the transient table empties on success.
 *   - **A refusal copies the causes and keeps them**, so tomorrow's attempt is
 *     attributed too.
 *   - **Every path that drops queue rows sweeps their causes**: the 7-day
 *     expiry, the all-retired commit, and (in `admin-reindex.spec.ts`) the
 *     worklist clear.
 *   - **Every statement stays under D1's 100-bound-parameter cap.** The harness
 *     binds 32,766, so only the emitted SQL can tell.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  gscRecrawlQueue,
  recrawlQueueCauses,
  recrawlSubmissionCauses,
  recrawlSubmissions,
  slugRedirects,
} from '../db/schema';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';

import { drainIndexNowQueue } from './indexnow-drain';
import { enqueueIndexNowUrls } from './indexnow-queue';
import {
  copyCausesToSubmissions,
  enqueueRecrawlCauses,
  RECRAWL_CAUSE_ROWS_PER_STATEMENT,
  recrawlCauseInsertStatements,
  sweepOrphanCauses,
  type RecrawlCause,
} from './recrawl-causes';

const NOW = new Date('2026-10-04T12:00:00.000Z');
const ENV = {
  INDEXNOW_KEY: 'a1b2c3d4e5f6a7b8',
  PUBLIC_SITE_URL: 'https://www.aecintegrations.com',
} as unknown as Env;
const url = (slug: string) => `https://www.aecintegrations.com/products/${slug}`;

const VENDOR_A: RecrawlCause = {
  source: 'vendor',
  auditLogId: 'audit-a',
  vendorId: 'vendor-a',
  productId: 'product-1',
  promoteJobId: null,
};
const VENDOR_B: RecrawlCause = { ...VENDOR_A, auditLogId: 'audit-b', vendorId: 'vendor-b' };
const PROMOTE: RecrawlCause = {
  source: 'promote',
  auditLogId: null,
  vendorId: null,
  productId: null,
  promoteJobId: 'job-1',
};

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

type Compiled = { toSQL(): { sql: string; params: unknown[] } };
const compiled = (stmt: unknown) => (stmt as Compiled).toSQL();

function respond(status: number): typeof fetch {
  return vi.fn().mockResolvedValue(new Response('', { status })) as unknown as typeof fetch;
}

function drain(fetchImpl: typeof fetch, now: Date = NOW) {
  return drainIndexNowQueue({
    db: t.db,
    env: ENV,
    metrics: { count: () => {}, gauge: () => {} },
    log: () => {},
    fetchImpl,
    now: () => now,
    sleep: async () => {},
  });
}

const queueCauses = () => t.db.select().from(recrawlQueueCauses).orderBy(recrawlQueueCauses.id);
const submissionCauses = () =>
  t.db.select().from(recrawlSubmissionCauses).orderBy(recrawlSubmissionCauses.id);
const submissions = () => t.db.select().from(recrawlSubmissions).orderBy(recrawlSubmissions.id);

/** What a producer does: queue upsert, then the causes for the same URLs. */
async function produce(urls: string[], cause: RecrawlCause, now: Date = NOW) {
  await enqueueIndexNowUrls(t.db, urls, cause.source, () => now);
  await enqueueRecrawlCauses(t.db, 'indexnow', urls, cause, () => now);
}

describe('statement builders — D1 bound-parameter cap', () => {
  it.each([0, 1, RECRAWL_CAUSE_ROWS_PER_STATEMENT, RECRAWL_CAUSE_ROWS_PER_STATEMENT + 1, 1_000])(
    'keeps every cause INSERT at or under 100 parameters at %i URLs',
    (n) => {
      const urls = Array.from({ length: n }, (_, i) => url(`p${i}`));
      const stmts = recrawlCauseInsertStatements(t.db, 'indexnow', urls, VENDOR_A, 'now');
      expect(stmts).toHaveLength(Math.ceil(n / RECRAWL_CAUSE_ROWS_PER_STATEMENT));
      for (const stmt of stmts) expect(compiled(stmt).params.length).toBeLessThanOrEqual(100);
    },
  );

  it('binds eight parameters per row, so a full statement is 96', () => {
    const urls = Array.from({ length: RECRAWL_CAUSE_ROWS_PER_STATEMENT }, (_, i) => url(`p${i}`));
    const [stmt] = recrawlCauseInsertStatements(t.db, 'gsc', urls, VENDOR_A, 'now');
    expect(compiled(stmt).params).toHaveLength(96);
  });

  it('collapses a URL repeated inside one write to one cause row', () => {
    const stmts = recrawlCauseInsertStatements(
      t.db,
      'indexnow',
      [url('a'), url('a')],
      VENDOR_A,
      'now',
    );
    expect(compiled(stmts[0]).params).toHaveLength(8);
  });

  it('the copy and the sweep bind a constant number of parameters at any run size', () => {
    const copy = compiled(copyCausesToSubmissions(t.db, 'indexnow', 'batch-1'));
    expect(copy.params).toEqual(['indexnow', 'batch-1']);
    expect(copy.sql).toMatch(/^insert into "recrawl_submission_causes"/i);
    expect(copy.sql).toMatch(/join "recrawl_queue_causes"/i);

    const sweep = compiled(sweepOrphanCauses(t.db, 'gsc'));
    expect(sweep.params).toEqual(['gsc']);
    expect(sweep.sql).toMatch(/not exists \(select 1 from "gsc_recrawl_queue" q/i);
  });
});

describe('enqueueRecrawlCauses', () => {
  it('keeps two causes on one queue row when two writes hit the same URL', async () => {
    await produce([url('a')], VENDOR_A);
    await produce([url('a')], VENDOR_B);

    const causes = await queueCauses();
    expect(causes.map((c) => [c.channel, c.url, c.vendorId, c.auditLogId])).toEqual([
      ['indexnow', url('a'), 'vendor-a', 'audit-a'],
      ['indexnow', url('a'), 'vendor-b', 'audit-b'],
    ]);
  });

  it('writes nothing for an empty URL list', async () => {
    expect(await enqueueRecrawlCauses(t.db, 'indexnow', [], VENDOR_A)).toBe(0);
    expect(await queueCauses()).toEqual([]);
  });
});

describe('the drain copies and sweeps causes', () => {
  it('on success: one submission per URL, every cause copied, the transient table empty', async () => {
    await produce([url('a'), url('b')], VENDOR_A);
    await produce([url('a')], VENDOR_B);
    await produce([url('a')], PROMOTE);

    await drain(respond(200));

    const subs = await submissions();
    expect(subs.map((s) => s.url)).toEqual([url('a'), url('b')]);
    const subA = subs.find((s) => s.url === url('a'))!;
    const subB = subs.find((s) => s.url === url('b'))!;

    const copied = await submissionCauses();
    expect(
      copied
        .filter((c) => c.submissionId === subA.id)
        .map((c) => [c.source, c.vendorId, c.auditLogId, c.promoteJobId])
        .sort(),
    ).toEqual([
      ['promote', null, null, 'job-1'],
      ['vendor', 'vendor-a', 'audit-a', null],
      ['vendor', 'vendor-b', 'audit-b', null],
    ]);
    expect(copied.filter((c) => c.submissionId === subB.id).map((c) => c.vendorId)).toEqual([
      'vendor-a',
    ]);
    expect(copied.every((c) => c.queuedAt === NOW.toISOString())).toBe(true);

    expect(await queueCauses()).toEqual([]);
  });

  it('on a 429: copies the causes onto the refused row and keeps them for the retry', async () => {
    await produce([url('a')], VENDOR_A);
    await drain(respond(429));

    const [refused] = await submissions();
    expect(refused!.outcome).toBe('refused');
    expect((await submissionCauses()).map((c) => [c.submissionId, c.vendorId])).toEqual([
      [refused!.id, 'vendor-a'],
    ]);
    expect(await queueCauses()).toHaveLength(1);

    // The retry is attributed too, then the transient row goes.
    await drain(respond(200));
    const accepted = (await submissions()).find((s) => s.outcome === 'accepted')!;
    expect(
      (await submissionCauses())
        .filter((c) => c.submissionId === accepted.id)
        .map((c) => c.vendorId),
    ).toEqual(['vendor-a']);
    expect(await queueCauses()).toEqual([]);
  });

  it('never touches the gsc channel', async () => {
    await produce([url('a')], VENDOR_A);
    await t.db.insert(gscRecrawlQueue).values({
      url: url('a'),
      priority: 2,
      reason: 'product.updated',
      source: 'vendor',
      queuedAt: NOW.toISOString(),
    });
    await enqueueRecrawlCauses(t.db, 'gsc', [url('a')], VENDOR_A);

    await drain(respond(200));

    expect((await queueCauses()).map((c) => c.channel)).toEqual(['gsc']);
    expect(await submissionCauses()).toHaveLength(1);
  });

  it('sweeps an orphan cause whose URL was never queued', async () => {
    await produce([url('a')], VENDOR_A);
    // A cause that landed just after an earlier drain deleted its row.
    await enqueueRecrawlCauses(t.db, 'indexnow', [url('gone')], VENDOR_B);

    await drain(respond(200));

    expect(await queueCauses()).toEqual([]);
    expect((await submissionCauses()).map((c) => c.vendorId)).toEqual(['vendor-a']);
  });

  it('the 7-day expiry sweeps the expired URLs causes and copies nothing', async () => {
    const old = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1_000);
    await produce([url('stale')], VENDOR_A, old);

    // A refused run, so the expiry is the only thing that removes rows.
    await drain(respond(429));

    expect(await queueCauses()).toEqual([]);
    expect(await submissionCauses()).toEqual([]);
  });

  it('the all-retired path sweeps the causes and copies nothing', async () => {
    await t.db.insert(slugRedirects).values({
      entity: 'product',
      fromSlug: 'old',
      toSlug: 'new',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await produce([url('old')], VENDOR_A);

    const fetchImpl = respond(200);
    await drain(fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await queueCauses()).toEqual([]);
    expect(await submissionCauses()).toEqual([]);
  });

  it('a run with sent and retired URLs copies only the sent ones', async () => {
    await t.db.insert(slugRedirects).values({
      entity: 'product',
      fromSlug: 'old',
      toSlug: 'new',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await produce([url('old'), url('live')], VENDOR_A);

    await drain(respond(200));

    const [sub] = await submissions();
    expect(sub!.url).toBe(url('live'));
    expect((await submissionCauses()).map((c) => c.submissionId)).toEqual([sub!.id]);
    expect(await queueCauses()).toEqual([]);
  });
});
