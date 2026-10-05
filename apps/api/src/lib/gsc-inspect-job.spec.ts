/**
 * The daily URL Inspection run, one chunk at a time (AECI-1236), against the
 * real migrations in the in-memory D1 harness with Google stubbed.
 *
 * What must hold, because each failure is silent in production:
 *   - only PASS + crawled-after-last-change closes; everything else is tagged;
 *   - a page edited during the run is neither closed nor tagged;
 *   - the closes and their ONE summary audit row commit together, and an empty
 *     close set writes no audit row;
 *   - a 429 halts the chain; an error leaves the row untagged for the next run,
 *     and the run's later chunks skip it via `skipIds`;
 *   - the chunk reads never-inspected rows first and skips recent inspections.
 */

import { generateKeyPairSync } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, gscRecrawlQueue } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';

import {
  GSC_INSPECT_CHUNK_SIZE,
  REINDEX_AUTO_CLEARED_ACTION,
  runGscInspectChunk,
  type GscInspectDeps,
} from './gsc-inspect-job';
import { GOOGLE_TOKEN_ENDPOINT } from './gsc-inspection';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA_JSON = JSON.stringify({
  client_email: 'inspector@example.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
});

const BASE = 'https://www.aecintegrations.com';
const NOW = new Date('2026-10-05T12:00:00.000Z');
const CHANGED = '2026-09-28T00:00:00.000Z';

type Answer = object | number | Error;

/** Google stub: the token exchange always succeeds; inspections answer from `byPath`. */
function google(byPath: Record<string, Answer>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === GOOGLE_TOKEN_ENDPOINT) {
      return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
    }
    const inspected = JSON.parse(init!.body as string).inspectionUrl as string;
    const answer = byPath[inspected.replace(BASE, '')];
    if (answer === undefined) throw new Error(`unstubbed ${inspected}`);
    if (answer instanceof Error) throw answer;
    if (typeof answer === 'number') return new Response('{}', { status: answer });
    return new Response(JSON.stringify({ inspectionResult: { indexStatusResult: answer } }), {
      status: 200,
    });
  });
}

const PASS_AFTER = { verdict: 'PASS', lastCrawlTime: '2026-10-01T00:00:00Z' };
const PASS_BEFORE = {
  verdict: 'PASS',
  lastCrawlTime: '2026-09-25T00:00:00Z',
  coverageState: 'Submitted and indexed',
};
const UNKNOWN = { verdict: 'NEUTRAL', coverageState: 'URL is unknown to Google' };
const NOT_FOUND = {
  verdict: 'FAIL',
  pageFetchState: 'NOT_FOUND',
  lastCrawlTime: '2026-10-02T00:00:00Z',
};

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

async function seed(
  path: string,
  opts: { priority?: number; changed?: string; inspectedAt?: string | null } = {},
) {
  await t.db.insert(gscRecrawlQueue).values({
    url: `${BASE}${path}`,
    priority: opts.priority ?? 3,
    reason: 'vendor.updated',
    source: 'promote',
    queuedAt: '2026-09-20T00:00:00.000Z',
    lastChangedAt: opts.changed ?? CHANGED,
    inspectedAt: opts.inspectedAt ?? null,
  });
}

const deps = (fetchImpl: ReturnType<typeof google>): GscInspectDeps => ({
  db: t.db,
  serviceAccountJson: SA_JSON,
  indexNowKey: 'k',
  publicSiteUrl: BASE,
  fetchImpl: fetchImpl as unknown as typeof fetch,
  now: () => NOW,
  sleep: async () => {},
});

const rowAt = async (path: string) =>
  (
    await t.db
      .select()
      .from(gscRecrawlQueue)
      .where(eq(gscRecrawlQueue.url, `${BASE}${path}`))
  )[0];

describe('runGscInspectChunk', () => {
  it('closes PASS-after-change, tags the rest, and writes ONE summary audit row', async () => {
    await seed('/vendors/done');
    await seed('/vendors/stale');
    await seed('/vendors/new');
    await seed('/vendors/gone');
    const result = await runGscInspectChunk(
      deps(
        google({
          '/vendors/done': PASS_AFTER,
          '/vendors/stale': PASS_BEFORE,
          '/vendors/new': UNKNOWN,
          '/vendors/gone': NOT_FOUND,
        }),
      ),
      1_500,
    );

    expect(result).toMatchObject({
      outcome: 'ok',
      inspected: 4,
      closed: 1,
      tagged: 3,
      errors: 0,
      next: null,
    });
    expect(await rowAt('/vendors/done')).toBeUndefined();
    expect(await rowAt('/vendors/stale')).toMatchObject({
      inspectReason: 'crawl_predates_change',
      lastCrawlAt: '2026-09-25T00:00:00Z',
      coverageState: 'Submitted and indexed',
      inspectedAt: NOW.toISOString(),
    });
    expect((await rowAt('/vendors/new'))!.inspectReason).toBe('unknown_to_google');
    // A 404 is tagged, never closed (ADR 0030).
    expect((await rowAt('/vendors/gone'))!.inspectReason).toBe('page_fetch_failed');

    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: 'system',
      action: REINDEX_AUTO_CLEARED_ACTION,
      entityType: 'gsc_recrawl_queue',
    });
    const metadata = audits[0]!.metadata as { closed: number; rows: { url: string }[] };
    expect(metadata.closed).toBe(1);
    expect(metadata.rows.map((r) => r.url)).toEqual([`${BASE}/vendors/done`]);
    expect(result.auditEntry?.action).toBe(REINDEX_AUTO_CLEARED_ACTION);
  });

  it('writes no audit row when nothing was closed', async () => {
    await seed('/vendors/stale');
    await runGscInspectChunk(deps(google({ '/vendors/stale': PASS_BEFORE })), 1_500);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('compares with last_changed_at, not queued_at', async () => {
    // Queued on the 20th, crawled on the 1st, edited again on the 3rd.
    await seed('/vendors/edited-again', { changed: '2026-10-03T00:00:00.000Z' });
    const result = await runGscInspectChunk(
      deps(google({ '/vendors/edited-again': PASS_AFTER })),
      1_500,
    );
    expect(result.closed).toBe(0);
    expect((await rowAt('/vendors/edited-again'))!.inspectReason).toBe('crawl_predates_change');
  });

  it('leaves alone a row whose page changed while it was being inspected', async () => {
    await seed('/vendors/racing');
    const fetchImpl = google({ '/vendors/racing': PASS_AFTER });
    const editingFetch = vi.fn(async (url: string, init?: RequestInit) => {
      const res = await fetchImpl(url, init);
      if (url !== GOOGLE_TOKEN_ENDPOINT) {
        // The vendor saves an edit mid-inspection.
        await t.db
          .update(gscRecrawlQueue)
          .set({ lastChangedAt: '2026-10-05T11:59:00.000Z' })
          .where(eq(gscRecrawlQueue.url, `${BASE}/vendors/racing`));
      }
      return res;
    });
    const result = await runGscInspectChunk(
      deps(editingFetch as unknown as ReturnType<typeof google>),
      1_500,
    );
    expect(result).toMatchObject({ closed: 0, tagged: 0 });
    const row = (await rowAt('/vendors/racing'))!;
    expect(row.inspectedAt).toBeNull();
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('halts the chain on a 429 and leaves the refused rows untagged', async () => {
    await seed('/vendors/a');
    await seed('/vendors/b');
    const result = await runGscInspectChunk(
      deps(google({ '/vendors/a': PASS_BEFORE, '/vendors/b': 429 })),
      1_500,
    );
    expect(result).toMatchObject({ outcome: 'halted_quota', errors: 1, tagged: 1, next: null });
    expect((await rowAt('/vendors/b'))!.inspectedAt).toBeNull();
  });

  it('leaves an errored row untagged so the next run retries it', async () => {
    await seed('/vendors/flaky');
    const result = await runGscInspectChunk(
      deps(google({ '/vendors/flaky': new TypeError('fetch failed') })),
      1_500,
    );
    expect(result).toMatchObject({ outcome: 'ok', errors: 1, tagged: 0 });
    expect(result.failedIds).toEqual([(await rowAt('/vendors/flaky'))!.id]);
    expect((await rowAt('/vendors/flaky'))!.inspectedAt).toBeNull();
  });

  // Review finding: an errored row stays never-inspected, so it sorts to the top
  // again. Without the skip list, 100 permanently rejected URLs would fill every
  // chunk of every run and nothing behind them would ever be inspected.
  it('skips the ids an earlier chunk of the run failed on', async () => {
    await seed('/vendors/rejected', { priority: 1 });
    await seed('/vendors/behind', { priority: 4 });
    const first = await runGscInspectChunk(
      deps(google({ '/vendors/rejected': 400, '/vendors/behind': UNKNOWN })),
      1_500,
    );
    expect(first.failedIds).toHaveLength(1);

    const fetchImpl = google({ '/vendors/behind': UNKNOWN });
    await t.db.update(gscRecrawlQueue).set({ inspectedAt: null });
    const second = await runGscInspectChunk(deps(fetchImpl), 1_500, first.failedIds);
    const asked = fetchImpl.mock.calls
      .filter(([u]) => u !== GOOGLE_TOKEN_ENDPOINT)
      .map(([, init]) => JSON.parse(init!.body as string).inspectionUrl.replace(BASE, ''));
    expect(asked).toEqual(['/vendors/behind']);
    expect(second).toMatchObject({ inspected: 1, errors: 0, failedIds: [] });
  });

  it('reads never-inspected rows first, then the oldest inspection, and skips recent ones', async () => {
    await seed('/vendors/recent', { inspectedAt: '2026-10-04T00:00:00.000Z' });
    await seed('/vendors/old', { inspectedAt: '2026-09-01T00:00:00.000Z' });
    await seed('/vendors/never-t4', { priority: 4 });
    await seed('/vendors/never-t2', { priority: 2 });
    const fetchImpl = google({
      '/vendors/old': UNKNOWN,
      '/vendors/never-t4': UNKNOWN,
      '/vendors/never-t2': UNKNOWN,
    });
    await runGscInspectChunk(deps(fetchImpl), 1_500);
    const asked = fetchImpl.mock.calls
      .filter(([u]) => u !== GOOGLE_TOKEN_ENDPOINT)
      .map(([, init]) => JSON.parse(init!.body as string).inspectionUrl.replace(BASE, ''));
    expect(asked).toEqual(['/vendors/never-t2', '/vendors/never-t4', '/vendors/old']);
  });

  it('returns the remaining budget when a full chunk ran', async () => {
    const byPath: Record<string, Answer> = {};
    for (let i = 0; i < GSC_INSPECT_CHUNK_SIZE + 5; i++) {
      await seed(`/vendors/v${i}`);
      byPath[`/vendors/v${i}`] = UNKNOWN;
    }
    const first = await runGscInspectChunk(deps(google(byPath)), 1_500);
    expect(first).toMatchObject({ inspected: GSC_INSPECT_CHUNK_SIZE, next: 1_400 });
    const second = await runGscInspectChunk(deps(google(byPath)), first.next!);
    expect(second).toMatchObject({ inspected: 5, next: null });
  });

  it('caps the chunk at the remaining budget', async () => {
    await seed('/vendors/a');
    await seed('/vendors/b');
    const result = await runGscInspectChunk(
      deps(google({ '/vendors/a': UNKNOWN, '/vendors/b': UNKNOWN })),
      1,
    );
    expect(result).toMatchObject({ inspected: 1, next: null });
  });

  it('skips without the key or outside a public env, and makes no call', async () => {
    await seed('/vendors/a');
    const fetchImpl = google({});
    expect(
      await runGscInspectChunk({ ...deps(fetchImpl), serviceAccountJson: undefined }, 1_500),
    ).toMatchObject({ outcome: 'skipped', reason: 'no_creds' });
    expect(
      await runGscInspectChunk({ ...deps(fetchImpl), indexNowKey: undefined }, 1_500),
    ).toMatchObject({ outcome: 'skipped', reason: 'not_public' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('halts as auth when the token exchange is refused', async () => {
    await seed('/vendors/a');
    const fetchImpl = vi.fn().mockResolvedValue(new Response('no', { status: 400 }));
    const result = await runGscInspectChunk(
      deps(fetchImpl as unknown as ReturnType<typeof google>),
      1_500,
    );
    expect(result).toMatchObject({ outcome: 'halted_auth', inspected: 0 });
  });
});
