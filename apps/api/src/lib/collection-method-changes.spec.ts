/**
 * `COLLECTION_METHOD_CHANGES` is the code form of `POST_LAUNCH_MONITORING.md` §3d
 * (AECI-1346). The first case parses the doc table and pins the two equal, so a
 * new doc row without a code row, or the reverse, fails CI.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  anyNotComparable,
  COLLECTION_METHOD_CHANGES,
  collectionMethodSeam,
  type CollectionMethodChange,
} from './collection-method-changes';

/** The §3d table rows, parsed into the fields the doc carries. */
function parseSection3d(markdown: string) {
  const start = markdown.indexOf('### 3d. Page-view collection method changes');
  expect(start, '§3d heading').toBeGreaterThan(-1);
  const end = markdown.indexOf('\n## ', start);
  const section = markdown.slice(start, end === -1 ? undefined : end);
  const rows = section
    .split('\n')
    .filter((l) => /^\| \d{4}-\d{2}-\d{2} /.test(l))
    .map((l) =>
      l
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  return rows.map((cells) => {
    expect(cells, 'five columns per §3d row').toHaveLength(5);
    const [when, tier, change, , comparable] = cells as [string, string, string, string, string];
    const m = when.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) \(`([0-9a-f]+)`\)$/);
    expect(m, `date cell "${when}"`).not.toBeNull();
    expect(comparable, `comparable cell "${comparable}"`).toMatch(/^(yes|no)$/);
    return {
      at: `${m![1]}T${m![2]}:00.000Z`,
      tier,
      sha: m![3],
      issue: change.match(/AECI-\d+/)?.[0],
      arrivalsComparable: comparable === 'yes',
    };
  });
}

describe('COLLECTION_METHOD_CHANGES', () => {
  it('equals the POST_LAUNCH_MONITORING.md §3d table, row for row', () => {
    const doc = readFileSync(
      join(process.cwd(), '..', '..', 'docs', 'POST_LAUNCH_MONITORING.md'),
      'utf8',
    );
    const fromDoc = parseSection3d(doc);
    const fromCode = COLLECTION_METHOD_CHANGES.map(
      ({ at, tier, sha, issue, arrivalsComparable }) => ({
        at,
        tier,
        sha,
        issue,
        arrivalsComparable,
      }),
    );
    expect(fromDoc.length).toBeGreaterThan(0);
    expect(fromDoc).toEqual(fromCode);
  });
});

describe('collectionMethodSeam', () => {
  const day = (d: string) => ({
    startIso: `${d}T00:00:00.000Z`,
    endIso: new Date(Date.parse(`${d}T00:00:00.000Z`) + 86_400_000).toISOString(),
  });

  it('matches only the tier the row deployed to', () => {
    expect(collectionMethodSeam('staging', day('2026-10-21')).map((r) => r.sha)).toEqual([
      'faa81a01f',
    ]);
    expect(collectionMethodSeam('production', day('2026-10-21'))).toEqual([]);
    expect(collectionMethodSeam('production', day('2026-10-22')).map((r) => r.sha)).toEqual([
      '88cedfbc3',
    ]);
    expect(collectionMethodSeam('demo', day('2026-10-22')).map((r) => r.sha)).toEqual([
      '957951a08',
    ]);
  });

  it('matches nothing on a local run', () => {
    const all = { startIso: '2000-01-01T00:00:00.000Z', endIso: '2100-01-01T00:00:00.000Z' };
    expect(collectionMethodSeam(undefined, all)).toEqual([]);
    expect(collectionMethodSeam('development', all)).toEqual([]);
    expect(collectionMethodSeam('', all)).toEqual([]);
  });

  it('treats the window as [start, end): the exact timestamp is inside, the end is not', () => {
    const at = '2026-10-21T10:38:00.000Z';
    const dayEnd = '2026-10-22T00:00:00.000Z';
    expect(collectionMethodSeam('staging', { startIso: at, endIso: dayEnd })).toHaveLength(1);
    expect(
      collectionMethodSeam('staging', { startIso: '2026-10-21T00:00:00.000Z', endIso: at }),
    ).toEqual([]);
    expect(
      collectionMethodSeam('staging', { startIso: '2026-10-21T10:38:00.001Z', endIso: dayEnd }),
    ).toEqual([]);
  });

  it('returns rows oldest first and reports whether any breaks comparability', () => {
    const row = (at: string, sha: string, arrivalsComparable: boolean): CollectionMethodChange => ({
      at,
      tier: 'demo',
      sha,
      issue: 'AECI-0',
      summary: 's',
      arrivalsComparable,
    });
    const rows = [
      row('2026-10-25T00:00:00.000Z', 'b', true),
      row('2026-10-24T00:00:00.000Z', 'a', false),
    ];
    const window = { startIso: '2026-10-01T00:00:00.000Z', endIso: '2026-11-01T00:00:00.000Z' };
    const found = collectionMethodSeam('demo', window, rows);
    expect(found.map((r) => r.sha)).toEqual(['a', 'b']);
    expect(anyNotComparable(found)).toBe(true);
    expect(anyNotComparable(found.slice(1))).toBe(false);
    expect(anyNotComparable([])).toBe(false);
  });
});
