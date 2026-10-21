/**
 * The AECI-1345 admin read side of `page_view_classifications`: counts per class
 * with internal traffic beside them, latest version per day, the version seam,
 * the 50% unresolved gate, and the per-row lookup.
 */

import { AdminTrafficClassSchema } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pageViews } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  CLASSIFICATION_UNRESOLVED_SHARE_MAX,
  readClassificationSummary,
  readRowClassifications,
} from './admin-classification';
import { TRAFFIC_CLASSES } from './traffic-classifier';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

async function view(createdAt: string, extra: Partial<typeof pageViews.$inferInsert> = {}) {
  const [row] = await t.db
    .insert(pageViews)
    .values({ path: '/x', createdAt, userAgentHash: 'ua', cfAsn: 7713, ...extra })
    .returning({ id: pageViews.id });
  return row!.id;
}

function classify(
  pageViewId: number,
  cls: string,
  version: string,
  evaluatedAt: string,
  codes: string[] = ['no_corroboration'],
) {
  const day = (
    t.raw
      .prepare(`SELECT substr(created_at, 1, 10) AS d FROM page_views WHERE id = ?`)
      .get(pageViewId) as { d: string }
  ).d;
  t.raw
    .prepare(
      `INSERT INTO page_view_classifications
         (page_view_id, class, reason_codes, classifier_version, evaluated_at,
          evidence_from, evidence_to, view_day, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      pageViewId,
      cls,
      JSON.stringify(codes),
      version,
      evaluatedAt,
      `${day}T00:00:00.000Z`,
      `${day}T00:00:00.000Z`,
      day,
      evaluatedAt,
    );
}

const D1 = '2026-10-01';
const D2 = '2026-10-02';
const countOf = (s: Awaited<ReturnType<typeof readClassificationSummary>>, cls: string) =>
  s.summary.counts.find((c) => c.class === cls)?.views;

describe('readClassificationSummary', () => {
  it('mirrors the classifier vocabulary exactly', () => {
    expect([...AdminTrafficClassSchema.options]).toEqual([...TRAFFIC_CLASSES]);
  });

  it('reports null and four zeros when nothing was classified, never an absent class', async () => {
    await view(`${D1}T10:00:00.000Z`);
    const read = await readClassificationSummary(t.db, { fromDay: D1, toDay: D1 }, 3);
    expect(read.summary).toEqual({
      classifier_version: null,
      counts: TRAFFIC_CLASSES.map((c) => ({ class: c, views: 0, visitors: 0 })),
      internal_excluded: { views: 0, operator_leak_inferred: 3 },
      basis: 'requests',
      version_seam: null,
    });
    expect(read.unresolvedShareExceeded).toBe(false);
  });

  it('splits internal traffic off beside the classes, decided at read time', async () => {
    const human = await view(`${D1}T10:00:00.000Z`, { userAgentHash: 'a' });
    const op = await view(`${D1}T11:00:00.000Z`, { isOperator: true, userAgentHash: 'op' });
    const bot = await view(`${D1}T12:00:00.000Z`, { userAgentHash: 'b' });
    classify(human, 'browser_with_human_evidence', 'v1', '2026-10-02T00:45:00.000Z');
    classify(op, 'browser_with_human_evidence', 'v1', '2026-10-02T00:45:00.000Z');
    classify(bot, 'identified_automation', 'v1', '2026-10-02T00:45:00.000Z');

    const read = await readClassificationSummary(t.db, { fromDay: D1, toDay: D1 }, 0);
    expect(read.summary.classifier_version).toBe('v1');
    expect(countOf(read, 'browser_with_human_evidence')).toBe(1);
    expect(countOf(read, 'identified_automation')).toBe(1);
    expect(read.summary.internal_excluded.views).toBe(1);
    expect(read.summary.counts.find((c) => c.class === 'identified_automation')?.visitors).toBe(1);
  });

  it('counts a day on its LATEST version only, chosen by evaluation time, not by string order', async () => {
    const a = await view(`${D1}T10:00:00.000Z`);
    const b = await view(`${D1}T11:00:00.000Z`);
    // "z-old" sorts after "a-new" but was evaluated first.
    classify(a, 'unresolved', 'z-old', '2026-10-02T00:45:00.000Z');
    classify(b, 'unresolved', 'z-old', '2026-10-02T00:45:00.000Z');
    classify(a, 'suspected_automation', 'a-new', '2026-10-05T00:45:00.000Z');
    classify(b, 'suspected_automation', 'a-new', '2026-10-05T00:45:00.000Z');

    const read = await readClassificationSummary(t.db, { fromDay: D1, toDay: D1 }, 0);
    expect(read.summary.classifier_version).toBe('a-new');
    expect(countOf(read, 'suspected_automation')).toBe(2);
    expect(countOf(read, 'unresolved')).toBe(0);
    // One day, one latest version: no seam inside a single day.
    expect(read.summary.version_seam).toBeNull();
  });

  it('flags a seam when the window spans a version change, never blending the days', async () => {
    const a = await view(`${D1}T10:00:00.000Z`);
    const b = await view(`${D2}T10:00:00.000Z`);
    classify(a, 'unresolved', 'v1', '2026-10-02T00:45:00.000Z');
    classify(b, 'browser_with_human_evidence', 'v2', '2026-10-03T00:45:00.000Z');

    const read = await readClassificationSummary(t.db, { fromDay: D1, toDay: D2 }, 0);
    expect(read.summary.classifier_version).toBe('v2');
    expect(read.summary.version_seam).toEqual({
      from_version: 'v1',
      to_version: 'v2',
      changed_on: D2,
    });
    expect(countOf(read, 'unresolved')).toBe(1);
    expect(countOf(read, 'browser_with_human_evidence')).toBe(1);
  });

  it('gates the unresolved warning strictly above the threshold', async () => {
    expect(CLASSIFICATION_UNRESOLVED_SHARE_MAX).toBe(0.5);
    const ids = [
      await view(`${D1}T10:00:00.000Z`, { userAgentHash: 'a' }),
      await view(`${D1}T11:00:00.000Z`, { userAgentHash: 'b' }),
      await view(`${D1}T12:00:00.000Z`, { userAgentHash: 'c' }),
    ];
    classify(ids[0]!, 'unresolved', 'v1', '2026-10-02T00:45:00.000Z');
    classify(ids[1]!, 'identified_automation', 'v1', '2026-10-02T00:45:00.000Z');

    const half = await readClassificationSummary(t.db, { fromDay: D1, toDay: D1 }, 0);
    expect(half).toMatchObject({ unresolved: 1, classified: 2, unresolvedShareExceeded: false });

    classify(ids[2]!, 'unresolved', 'v1', '2026-10-02T00:45:00.000Z');
    const over = await readClassificationSummary(t.db, { fromDay: D1, toDay: D1 }, 0);
    expect(over).toMatchObject({ unresolved: 2, classified: 3, unresolvedShareExceeded: true });
  });
});

describe('readRowClassifications', () => {
  it('returns the latest classification per row and nothing for an unclassified row', async () => {
    const a = await view(`${D1}T10:00:00.000Z`);
    const b = await view(`${D1}T11:00:00.000Z`);
    classify(a, 'unresolved', 'v1', '2026-10-02T00:45:00.000Z', ['no_corroboration']);
    classify(a, 'suspected_automation', 'v2', '2026-10-09T00:45:00.000Z', [
      'asn_datacenter',
      'verdict_non_browser',
      'evidence_no_tls',
    ]);
    t.raw
      .prepare(
        `UPDATE page_view_classifications SET evidence_from = ?, evidence_to = ? WHERE classifier_version = 'v2'`,
      )
      .run('2026-09-17T00:00:00.000Z', '2026-10-02T00:30:00.000Z');

    const map = await readRowClassifications(t.db, [a, b]);
    expect(map.has(b)).toBe(false);
    expect(map.get(a)).toEqual({
      class: 'suspected_automation',
      reason_codes: ['asn_datacenter', 'verdict_non_browser', 'evidence_no_tls'],
      classifier_version: 'v2',
      evaluated_at: '2026-10-09T00:45:00.000Z',
      evidence_window: {
        from: '2026-09-17T00:00:00.000Z',
        to: '2026-10-02T00:30:00.000Z',
        timezone: 'UTC',
        days: 16,
      },
      evidence_complete: false,
    });
  });

  it('reads nothing for an empty page', async () => {
    expect((await readRowClassifications(t.db, [])).size).toBe(0);
  });
});
