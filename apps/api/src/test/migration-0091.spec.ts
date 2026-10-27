import { describe, expect, it } from 'vitest';

import { makeTestDb, migrationFiles, statementsForMigration } from './d1';

/**
 * AECI-1403 (E8.6) — `0091_smooth_falcon.sql` drops `plan_inquiries`, the retired
 * "Talk to us about Managed" lead table (`docs/DATABASE_SCHEMA.md` §2a). This file is
 * the tripwire on the body.
 *
 * The migration must stay a single leaf `DROP TABLE`. In SQLite a `DROP TABLE` runs an
 * implicit DELETE that fires `ON DELETE` actions on the tables that reference the
 * dropped one, and `PRAGMA defer_foreign_keys` does not stop it (`docs/migrations.md`
 * §0). That hazard needs a child, and this table has none. The second test fails if one
 * is ever added before this migration.
 */
const MIGRATION = '0091_smooth_falcon.sql';
const NOW = '2026-10-27T00:00:00.000Z';

const withoutComments = (s: string) =>
  s
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim();

describe(`${MIGRATION} — a leaf DROP TABLE`, () => {
  const statements = statementsForMigration(MIGRATION).map(withoutComments);

  it('carries exactly one DROP TABLE and nothing else', () => {
    expect(statements).toEqual(['DROP TABLE `plan_inquiries`;']);
    for (const s of statements) {
      expect(s).not.toMatch(/__new_|CREATE|ALTER TABLE|INSERT INTO|PRAGMA/i);
    }
  });

  it('drops a table no earlier migration references, so the drop cascades nowhere', () => {
    const earlier = migrationFiles().filter((file) => file < MIGRATION);
    for (const file of earlier) {
      for (const s of statementsForMigration(file)) {
        expect(s, file).not.toMatch(/REFERENCES\s+[`"]?plan_inquiries\b/i);
      }
    }
  });

  it('removes the table and its index, and keeps the other lead-capture rows', async () => {
    const t = await makeTestDb({ upToExclusive: MIGRATION });
    try {
      t.raw
        .prepare(
          `INSERT INTO plan_inquiries (topic, email, company, created_at)
           VALUES ('managed', 'a@example.com', 'A', ?)`,
        )
        .run(NOW);
      t.raw
        .prepare(
          `INSERT INTO feedback (email, subscribed, created_at) VALUES ('b@example.com', 0, ?)`,
        )
        .run(NOW);

      for (const s of statementsForMigration(MIGRATION)) t.raw.prepare(s).run();

      const leftovers = t.raw
        .prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'plan_inquiries%'`)
        .all();
      expect(leftovers).toEqual([]);
      expect(t.raw.prepare(`SELECT count(*) AS n FROM feedback`).get()).toEqual({ n: 1 });
    } finally {
      t.dispose();
    }
  });
});
