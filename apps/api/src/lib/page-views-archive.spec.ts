/**
 * The `page_views` archive (AECI-1228, ADR 0050) against the in-memory D1 harness and
 * an in-memory R2 bucket.
 *
 * The rule every test here guards: a ledger row exists only for a day whose objects
 * R2 confirmed and whose D1 count still matched after the copy. A ledger row is what
 * lets the prune delete a day, so a ledger row written too early loses data.
 */

import { PAGE_VIEWS_ARCHIVE_AGE_DAYS, PAGE_VIEWS_RETENTION_DAYS } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pageViews, pageViewsArchiveDays } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { makeFakeR2Bucket, type FakeR2Bucket } from '../test/fake-r2';
import { shiftDay } from './admin-analytics';
import {
  ARCHIVE_PAGE_ROWS,
  archiveDueDays,
  archiveObjectKey,
  dueArchiveDays,
  emitArchiveMetrics,
  MAX_ARCHIVE_DAYS_PER_RUN,
  resolveArchiveAgeDays,
  type ArchiveRunSummary,
} from './page-views-archive';
import { BACKFILL_MAX_AGE_DAYS } from './traffic-classification-writer';

const NOW = new Date('2027-08-01T03:00:00.000Z');
const TODAY = '2027-08-01';
const AGE = PAGE_VIEWS_ARCHIVE_AGE_DAYS;
/** The newest day a default run archives: exactly 371 days old. */
const DUE_DAY = shiftDay(TODAY, -AGE); // 2026-07-26

let t: TestDb;
let bucket: FakeR2Bucket;
beforeEach(async () => {
  t = await makeTestDb();
  bucket = makeFakeR2Bucket();
});
afterEach(() => t.dispose());

const at = (day: string, time = '12:00:00.000Z') => `${day}T${time}`;

async function seedPageViews(
  day: string,
  n: number,
  extra: Partial<typeof pageViews.$inferInsert> = {},
) {
  for (let i = 0; i < n; i += 500) {
    const size = Math.min(500, n - i);
    await t.db
      .insert(pageViews)
      .values(Array.from({ length: size }, () => ({ path: '/x', createdAt: at(day), ...extra })));
  }
}

/** One classification per page view of `day`. */
function seedClassifications(day: string): void {
  t.raw
    .prepare(
      `INSERT INTO page_view_classifications
         (page_view_id, class, reason_codes, classifier_version, evaluated_at,
          evidence_from, evidence_to, view_day, created_at)
       SELECT id, 'unresolved', '["no_corroboration"]', 'tc-test', created_at, created_at,
              created_at, substr(created_at, 1, 10), created_at
         FROM page_views WHERE substr(created_at, 1, 10) = ?`,
    )
    .run(day);
}

const ledger = () => t.db.select().from(pageViewsArchiveDays).orderBy(pageViewsArchiveDays.day);

async function gunzipLines(key: string): Promise<Record<string, unknown>[]> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`no object at ${key}`);
  const stream = new Blob([await object.arrayBuffer()])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  const text = await new Response(stream).text();
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------

describe('PAGE_VIEWS_ARCHIVE_AGE_DAYS', () => {
  it('is one day past the oldest backfill, so no reclassification follows the copy', () => {
    expect(PAGE_VIEWS_ARCHIVE_AGE_DAYS).toBe(BACKFILL_MAX_AGE_DAYS + 1);
    expect(PAGE_VIEWS_ARCHIVE_AGE_DAYS).toBeLessThan(PAGE_VIEWS_RETENTION_DAYS);
  });
});

describe('resolveArchiveAgeDays', () => {
  it('uses the default when unset or blank', () => {
    expect(resolveArchiveAgeDays(undefined, 400)).toBe(371);
    expect(resolveArchiveAgeDays(' ', 400)).toBe(371);
  });

  it('accepts a whole number from 1 to one below the window', () => {
    expect(resolveArchiveAgeDays('2', 400)).toBe(2);
    expect(resolveArchiveAgeDays('1', 400)).toBe(1);
    expect(resolveArchiveAgeDays('399', 400)).toBe(399);
  });

  it('ignores and reports a value below 1, at or above the window, or not whole', () => {
    const onInvalid = vi.fn();
    expect(resolveArchiveAgeDays('0', 400, onInvalid)).toBe(371);
    expect(resolveArchiveAgeDays('400', 400, onInvalid)).toBe(371);
    expect(resolveArchiveAgeDays('2.5', 400, onInvalid)).toBe(371);
    expect(resolveArchiveAgeDays('soon', 400, onInvalid)).toBe(371);
    expect(onInvalid).toHaveBeenCalledTimes(4);
    expect(onInvalid).toHaveBeenCalledWith(expect.stringContaining('400-day page_views window'));
  });

  it('holds the default below a shortened page_views window', () => {
    expect(resolveArchiveAgeDays(undefined, 200)).toBe(199);
  });
});

describe('dueArchiveDays', () => {
  it('is empty on an empty table', async () => {
    expect(await dueArchiveDays(t.db, NOW, AGE)).toEqual([]);
  });

  it('does not touch a day younger than the archive age', async () => {
    await seedPageViews(shiftDay(DUE_DAY, 1), 3);
    expect(await dueArchiveDays(t.db, NOW, AGE)).toEqual([]);
    const summary = await archiveDueDays(t.db, bucket, NOW, AGE);
    expect(summary).toMatchObject({ status: 'nothing_due', daysArchived: 0 });
    expect(bucket.puts).toEqual([]);
    expect(await ledger()).toEqual([]);
  });

  it('lists every day from the oldest row to the due line, empty days included, minus the ledger', async () => {
    await seedPageViews(shiftDay(DUE_DAY, -3), 1);
    await seedPageViews(DUE_DAY, 1);
    await t.db.insert(pageViewsArchiveDays).values({
      day: shiftDay(DUE_DAY, -2),
      pageViewsRows: 0,
      classificationRows: 0,
      objectKey: 'k',
      bytes: 20,
      sha256: 's',
      archivedAt: NOW.toISOString(),
    });
    expect(await dueArchiveDays(t.db, NOW, AGE)).toEqual([
      shiftDay(DUE_DAY, -3),
      shiftDay(DUE_DAY, -1),
      DUE_DAY,
    ]);
  });
});

describe('archiveDueDays', () => {
  it('archives a due day with exact counts, every column, and writes the ledger row last', async () => {
    await seedPageViews(DUE_DAY, 3, { isBot: true, cfAsn: 13335 });
    seedClassifications(DUE_DAY);
    // A day after the due line, which must stay out of the archive.
    await seedPageViews(shiftDay(DUE_DAY, 1), 2);

    const summary = await archiveDueDays(t.db, bucket, NOW, AGE);

    expect(summary).toMatchObject({ status: 'archived', daysArchived: 1, failedDays: [] });
    expect(bucket.keys()).toEqual([
      archiveObjectKey('page_view_classifications', DUE_DAY),
      archiveObjectKey('page_views', DUE_DAY),
    ]);
    expect(archiveObjectKey('page_views', DUE_DAY)).toBe(
      `page_views/day=${DUE_DAY}/page_views.ndjson.gz`,
    );

    const views = await gunzipLines(archiveObjectKey('page_views', DUE_DAY));
    expect(views).toHaveLength(3);
    // D1 column names and D1 values, 0/1 booleans included.
    expect(views[0]).toMatchObject({
      path: '/x',
      created_at: at(DUE_DAY),
      is_bot: 1,
      cf_asn: 13335,
    });
    expect(Object.keys(views[0] ?? {})).toContain('client_verdict');
    const classifications = await gunzipLines(
      archiveObjectKey('page_view_classifications', DUE_DAY),
    );
    expect(classifications).toHaveLength(3);
    expect(classifications.map((c) => c.page_view_id)).toEqual(views.map((v) => v.id));

    const head = await bucket.head(archiveObjectKey('page_views', DUE_DAY));
    const [row] = await ledger();
    expect(row).toMatchObject({
      day: DUE_DAY,
      pageViewsRows: 3,
      classificationRows: 3,
      objectKey: archiveObjectKey('page_views', DUE_DAY),
      bytes: head?.size,
      sha256: head?.customMetadata.sha256,
      archivedAt: NOW.toISOString(),
    });
    expect(head?.customMetadata.rows).toBe('3');
    expect(row?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('pages a day larger than one read page', async () => {
    await seedPageViews(DUE_DAY, ARCHIVE_PAGE_ROWS + 5);

    await archiveDueDays(t.db, bucket, NOW, AGE);

    expect(await gunzipLines(archiveObjectKey('page_views', DUE_DAY))).toHaveLength(
      ARCHIVE_PAGE_ROWS + 5,
    );
    expect((await ledger())[0]?.pageViewsRows).toBe(ARCHIVE_PAGE_ROWS + 5);
  });

  it('writes no ledger row when a put fails, and still archives the other days', async () => {
    const bad = shiftDay(DUE_DAY, -1);
    await seedPageViews(bad, 2);
    await seedPageViews(DUE_DAY, 2);
    bucket.failPut(new RegExp(`day=${bad}/page_view_classifications`));

    const summary = await archiveDueDays(t.db, bucket, NOW, AGE);

    expect(summary).toMatchObject({ status: 'failed', daysArchived: 1, failedDays: [bad] });
    expect(summary.days[0]).toMatchObject({
      day: bad,
      status: 'failed',
      reason: expect.stringContaining('fake R2 put failed'),
    });
    expect((await ledger()).map((r) => r.day)).toEqual([DUE_DAY]);
  });

  it('writes no ledger row when head does not confirm the object', async () => {
    await seedPageViews(DUE_DAY, 2);
    bucket.corruptHead(/page_views\.ndjson\.gz$/);

    const summary = await archiveDueDays(t.db, bucket, NOW, AGE);

    expect(summary.days[0]).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('head_mismatch'),
    });
    expect(await ledger()).toEqual([]);
  });

  it('writes no ledger row when the D1 count changes between the copy and the recount', async () => {
    await seedPageViews(DUE_DAY, 2);
    // A row lands for the day while the objects are being written.
    const put = bucket.put.bind(bucket);
    let inserted = false;
    bucket.put = async (key, value, options) => {
      if (!inserted) {
        inserted = true;
        await seedPageViews(DUE_DAY, 1);
      }
      return put(key, value, options);
    };

    const summary = await archiveDueDays(t.db, bucket, NOW, AGE);

    expect(summary.days[0]).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('count_changed views=2->3'),
    });
    expect(await ledger()).toEqual([]);

    // The next night copies the day as it now stands.
    const retry = await archiveDueDays(t.db, bucket, NOW, AGE);
    expect(retry).toMatchObject({ status: 'archived', daysArchived: 1 });
    expect((await ledger())[0]?.pageViewsRows).toBe(3);
  });

  it(`archives at most ${MAX_ARCHIVE_DAYS_PER_RUN} days a run, oldest first`, async () => {
    const days = Array.from({ length: 10 }, (_, i) => shiftDay(DUE_DAY, i - 9));
    for (const day of days) await seedPageViews(day, 1);

    const first = await archiveDueDays(t.db, bucket, NOW, AGE);
    expect(first.daysArchived).toBe(MAX_ARCHIVE_DAYS_PER_RUN);
    expect((await ledger()).map((r) => r.day)).toEqual(days.slice(0, MAX_ARCHIVE_DAYS_PER_RUN));

    const second = await archiveDueDays(t.db, bucket, NOW, AGE);
    expect(second.daysArchived).toBe(3);
    expect((await ledger()).map((r) => r.day)).toEqual(days);

    expect(await archiveDueDays(t.db, bucket, NOW, AGE)).toMatchObject({ status: 'nothing_due' });
  });

  it('archives an empty day inside the range with zero counts', async () => {
    await seedPageViews(shiftDay(DUE_DAY, -1), 1);
    await seedPageViews(shiftDay(DUE_DAY, 1), 1);

    await archiveDueDays(t.db, bucket, NOW, AGE);

    expect(await ledger()).toMatchObject([
      { day: shiftDay(DUE_DAY, -1), pageViewsRows: 1 },
      { day: DUE_DAY, pageViewsRows: 0, classificationRows: 0 },
    ]);
    expect(await gunzipLines(archiveObjectKey('page_views', DUE_DAY))).toEqual([]);
  });
});

describe('emitArchiveMetrics', () => {
  const run = (summary: ArchiveRunSummary) => {
    const counts: Array<[string, number, string[]]> = [];
    emitArchiveMetrics({ count: (m, v, tags) => counts.push([m, v, tags]) }, summary);
    return counts;
  };
  const base = { daysArchived: 0, failedDays: [], days: [] };

  it('counts archived and failed days separately', () => {
    expect(run({ ...base, status: 'failed', daysArchived: 2, failedDays: ['a'] })).toEqual([
      ['aeci.pageviews.archive', 2, ['trigger:cron', 'outcome:archived']],
      ['aeci.pageviews.archive', 1, ['trigger:cron', 'outcome:failed']],
    ]);
  });

  it('counts a crashed step as one failure', () => {
    expect(run({ ...base, status: 'failed' })).toEqual([
      ['aeci.pageviews.archive', 1, ['trigger:cron', 'outcome:failed']],
    ]);
  });

  it.each(['nothing_due', 'skipped', 'archive_unbound'] as const)(
    'emits one %s point',
    (status) => {
      expect(run({ ...base, status })).toEqual([
        ['aeci.pageviews.archive', 1, ['trigger:cron', `outcome:${status}`]],
      ]);
    },
  );
});
