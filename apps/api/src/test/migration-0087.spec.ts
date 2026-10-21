import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration } from './d1';

/**
 * AECI-1345 — `0087_third_spitfire.sql` creates `page_view_classifications`
 * (`DATABASE_SCHEMA.md` §9.7, `ADMIN_PANEL_SPEC.md` §13 D19). This file is the
 * tripwire on the body.
 *
 * The migration must be purely additive. `page_views` is the hottest table in the
 * app, and a drizzle-kit recreate of it (`__new_page_views`) would DROP the parent
 * and fire every `ON DELETE` action under it (`docs/migrations.md` §0). Any other
 * shape fails the first test.
 */
const MIGRATION = '0087_third_spitfire.sql';
const NOW = '2026-10-21T00:00:00.000Z';

const withoutComments = (s: string) =>
  s
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim();

describe(`${MIGRATION} — page_view_classifications`, () => {
  const statements = statementsForMigration(MIGRATION).map(withoutComments);

  it('is one CREATE TABLE and two CREATE INDEX on the new table, and no recreate', () => {
    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatch(/^CREATE TABLE `page_view_classifications` \(/);
    expect(statements[1]).toMatch(
      /^CREATE UNIQUE INDEX `page_view_classifications_view_version_idx` ON `page_view_classifications` \(`page_view_id`,`classifier_version`\);$/,
    );
    expect(statements[2]).toMatch(
      /^CREATE INDEX `page_view_classifications_day_idx` ON `page_view_classifications` \(`view_day`,`classifier_version`,`class`\);$/,
    );
    for (const s of statements) {
      expect(s).not.toMatch(/__new_|DROP TABLE|ALTER TABLE|INSERT INTO|PRAGMA|^UPDATE|^DELETE/i);
    }
    // No CHECK: a log table must not drop a row on a violation (§9.7).
    expect(statements[0]).not.toMatch(/CHECK/i);
  });

  it('leaves seeded page_views untouched', async () => {
    const t = await makeTestDb({ upToExclusive: MIGRATION });
    try {
      const insert = t.raw.prepare(`INSERT INTO page_views (path, created_at) VALUES (?, ?)`);
      insert.run('/a', NOW);
      insert.run('/b', NOW);
      const before = t.raw.prepare(`SELECT * FROM page_views ORDER BY id`).all();

      t.applyMigration(MIGRATION);

      expect(t.raw.prepare(`SELECT * FROM page_views ORDER BY id`).all()).toEqual(before);
      expect(t.raw.prepare(`SELECT count(*) AS n FROM page_view_classifications`).get()).toEqual({
        n: 0,
      });
    } finally {
      t.dispose();
    }
  });

  it('cascades a page_views delete to its classifications, and refuses a duplicate version', async () => {
    const t = await makeTestDb();
    try {
      const pv = t.raw
        .prepare(`INSERT INTO page_views (path, created_at) VALUES ('/a', ?)`)
        .run(NOW).lastInsertRowid;
      const insert = t.raw.prepare(
        `INSERT INTO page_view_classifications
           (page_view_id, class, reason_codes, classifier_version, evaluated_at,
            evidence_from, evidence_to, view_day, created_at)
         VALUES (?, 'unresolved', '[]', ?, ?, ?, ?, '2026-10-21', ?)`,
      );
      insert.run(pv, '1.0.0', NOW, NOW, NOW, NOW);
      insert.run(pv, '1.1.0', NOW, NOW, NOW, NOW);
      expect(() => insert.run(pv, '1.0.0', NOW, NOW, NOW, NOW)).toThrow(/UNIQUE constraint failed/);

      t.raw.prepare(`DELETE FROM page_views WHERE id = ?`).run(pv);
      expect(t.raw.prepare(`SELECT count(*) AS n FROM page_view_classifications`).get()).toEqual({
        n: 0,
      });
    } finally {
      t.dispose();
    }
  });
});
