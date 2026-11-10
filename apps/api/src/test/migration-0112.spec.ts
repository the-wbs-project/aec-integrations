import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration, type TestDb } from './d1';

/**
 * AECI-979: `0112_brown_sir_ram.sql` recreates `slug_redirects` to widen its entity
 * CHECK to the four taxonomy kinds, and seeds the AECI-926 category redirect.
 *
 * Three things a regeneration or a careless edit could lose, each asserted here:
 *
 *   1. CONSERVATION. The recreate copies every row. Production holds the two 0039
 *      seeds plus two ops-script rows (AECI-1495), and the copy must carry them all.
 *   2. THE SEED ROW. drizzle-kit writes only the recreate; the INSERT is hand-added,
 *      and without it `/categories/reality-capture-scan-to-bim` 404s.
 *   3. THE PRAGMA. drizzle-kit emits `PRAGMA foreign_keys=OFF`, which D1 does not
 *      support (`docs/migrations.md` §3.3a rule 1).
 *
 * The recreate is the safe class: nothing references `slug_redirects`
 * (`d1.spec.ts` pins the empty child list at HEAD).
 */
const MIGRATION = '0112_brown_sir_ram.sql';
const NOW = '2026-11-10T00:00:00.000Z';

const rows = (t: TestDb) =>
  t.raw
    .prepare('SELECT entity, from_slug, to_slug FROM slug_redirects ORDER BY entity, from_slug')
    .all();

function applyMigration(t: TestDb): void {
  for (const stmt of statementsForMigration(MIGRATION)) t.raw.prepare(stmt).run();
}

describe(`${MIGRATION} — the slug_redirects recreate`, () => {
  it('carries every existing row through the recreate and adds the category seed', async () => {
    const t = await makeTestDb({ upToExclusive: MIGRATION });
    try {
      // The AECI-1495 shape: rows inserted after 0039 by an ops script.
      t.raw
        .prepare(
          `INSERT INTO slug_redirects (entity, from_slug, to_slug, reason, created_at)
             VALUES ('vendor', 'coda', 'superhuman', 'ops', ?), ('product', 'coda', 'superhuman-docs', 'ops', ?)`,
        )
        .run(NOW, NOW);
      expect(rows(t)).toHaveLength(4);

      applyMigration(t);

      expect(rows(t)).toEqual([
        {
          entity: 'category',
          from_slug: 'reality-capture-scan-to-bim',
          to_slug: 'reality-capture',
        },
        { entity: 'product', from_slug: 'autodesk-construction-cloud', to_slug: 'autodesk-forma' },
        { entity: 'product', from_slug: 'coda', to_slug: 'superhuman-docs' },
        { entity: 'vendor', from_slug: 'bluebeam', to_slug: 'nemetschek-group' },
        { entity: 'vendor', from_slug: 'coda', to_slug: 'superhuman' },
      ]);
    } finally {
      t.dispose();
    }
  });

  it('admits the four taxonomy kinds and still rejects an unwired kind', async () => {
    const t = await makeTestDb();
    try {
      const insert = t.raw.prepare(
        `INSERT INTO slug_redirects (entity, from_slug, to_slug, created_at) VALUES (?, 'old', 'new', ?)`,
      );
      for (const kind of ['audience', 'phase', 'trade', 'category']) {
        expect(() => insert.run(kind, NOW)).not.toThrow();
      }
      expect(() => insert.run('integration', NOW)).toThrow(/CHECK constraint failed/);
      // The distinct CHECK survived the recreate.
      expect(() =>
        t.raw
          .prepare(
            `INSERT INTO slug_redirects (entity, from_slug, to_slug, created_at) VALUES ('category', 'x', 'x', ?)`,
          )
          .run(NOW),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      t.dispose();
    }
  });

  it('still carries its hand edits in the committed file', () => {
    const statements = statementsForMigration(MIGRATION);
    const code = statements.map((s) =>
      s
        .split('\n')
        .filter((l) => !l.startsWith('--'))
        .join('\n'),
    );
    expect(code.filter((s) => /INSERT INTO `slug_redirects`/.test(s))).toHaveLength(1);
    expect(code.some((s) => /PRAGMA defer_foreign_keys = true/.test(s))).toBe(true);
    expect(code.some((s) => /PRAGMA foreign_keys/.test(s))).toBe(false);
  });
});
