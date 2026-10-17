import { describe, expect, it } from 'vitest';

import { makeTestDb, migrationFiles, statementsForMigration } from './d1';

/**
 * AECI-1357 (E1.8) — `0081_daffy_vision.sql` drops `vendor_plan_pricing`, the retired
 * per-vendor price override (`docs/VENDOR_SIGNUP_PROCESS.md` §2 decision 8). This file
 * is the tripwire on the body.
 *
 * The migration must stay a single leaf `DROP TABLE`. In SQLite a `DROP TABLE` runs an
 * implicit DELETE that fires `ON DELETE` actions on the tables that reference the
 * dropped one, and `PRAGMA defer_foreign_keys` does not stop it (`docs/migrations.md`
 * §0). That hazard needs a child, and this table has none. The second test fails if one
 * is ever added before this migration.
 */
const MIGRATION = '0081_daffy_vision.sql';
const NOW = '2026-10-17T00:00:00.000Z';

const withoutComments = (s: string) =>
  s
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim();

describe(`${MIGRATION} — a leaf DROP TABLE`, () => {
  const statements = statementsForMigration(MIGRATION).map(withoutComments);

  it('carries exactly one DROP TABLE and nothing else', () => {
    expect(statements).toEqual(['DROP TABLE `vendor_plan_pricing`;']);
    for (const s of statements) {
      expect(s).not.toMatch(/__new_|CREATE|ALTER TABLE|INSERT INTO|PRAGMA/i);
    }
  });

  it('drops a table no earlier migration references, so the drop cascades nowhere', () => {
    const earlier = migrationFiles().filter((file) => file < MIGRATION);
    for (const file of earlier) {
      for (const s of statementsForMigration(file)) {
        expect(s, file).not.toMatch(/REFERENCES\s+[`"]?vendor_plan_pricing\b/i);
      }
    }
  });

  it('removes the table, keeps its vendor and keeps its audit history', async () => {
    const t = await makeTestDb({ upToExclusive: MIGRATION });
    try {
      t.raw
        .prepare(
          `INSERT INTO vendors (id, slug, company_name, created_at, updated_at)
           VALUES ('v1', 'v', 'V', ?, ?)`,
        )
        .run(NOW, NOW);
      t.raw
        .prepare(
          `INSERT INTO vendor_plan_pricing (vendor_id, managed_price_cents, created_at, updated_at)
           VALUES ('v1', 1250, ?, ?)`,
        )
        .run(NOW, NOW);
      t.raw
        .prepare(
          `INSERT INTO audit_log (id, actor_type, action, entity_type, entity_id, created_at)
           VALUES ('a1', 'admin', 'vendor_plan_pricing.set', 'vendor_plan_pricing', 'v1', ?)`,
        )
        .run(NOW);

      for (const s of statementsForMigration(MIGRATION)) t.raw.prepare(s).run();

      const table = t.raw
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get('vendor_plan_pricing');
      expect(table).toBeUndefined();
      expect(t.raw.prepare(`SELECT count(*) AS n FROM vendors`).get()).toEqual({ n: 1 });
      expect(
        t.raw
          .prepare(`SELECT count(*) AS n FROM audit_log WHERE entity_type = 'vendor_plan_pricing'`)
          .get(),
      ).toEqual({ n: 1 });
    } finally {
      t.dispose();
    }
  });
});
