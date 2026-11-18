import { describe, expect, it } from 'vitest';

import { makeTestDb, migrationFiles, statementsForMigration } from './d1';

/**
 * AECI-1621: `0123_outstanding_mulholland_black.sql` adds `plan_change_snapshots`
 * (`DATABASE_SCHEMA.md` §9.16, ADR 0056). This file is the tripwire on the body.
 *
 * It must stay additive: one `CREATE TABLE` and its two indexes. No statement may touch
 * an existing table, because a drizzle-kit recreate runs a `DROP TABLE` whose implicit
 * DELETE fires `ON DELETE CASCADE` into the children (`docs/migrations.md` §0). The table
 * has no FK: its evidence must outlive a retracted product.
 */
const MIGRATION = '0123_outstanding_mulholland_black.sql';
const NOW = '2026-11-16T00:00:00.000Z';

describe(`${MIGRATION}: additive: one CREATE TABLE and two CREATE INDEXes`, () => {
  it('creates the table and its indexes, and nothing else', () => {
    const statements = statementsForMigration(MIGRATION).map((s) => s.trim());
    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatch(/^CREATE TABLE `plan_change_snapshots` \(/);
    expect(statements[1]).toBe(
      'CREATE INDEX `plan_change_snapshots_r2_key_due_at_idx` ON `plan_change_snapshots` (`r2_key`,`due_at`);',
    );
    expect(statements[2]).toBe(
      'CREATE INDEX `plan_change_snapshots_product_event_at_idx` ON `plan_change_snapshots` (`product_id`,`event_at`);',
    );
    for (const s of statements) {
      expect(s).not.toMatch(/__new_|DROP |ALTER TABLE|INSERT INTO|PRAGMA|REFERENCES/i);
    }
  });

  it('is in the migration set the harness applies', () => {
    expect(migrationFiles()).toContain(MIGRATION);
  });

  it('keeps every row of every existing table', async () => {
    const t = await makeTestDb({ upToExclusive: MIGRATION });
    try {
      t.raw
        .prepare(
          `INSERT INTO profiles (id, role, created_at, updated_at) VALUES ('u1', 'reviewer', ?, ?)`,
        )
        .run(NOW, NOW);
      const tables = () =>
        (
          t.raw
            .prepare(
              `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name`,
            )
            .all() as { name: string }[]
        ).map((r) => r.name);
      const counts = (names: string[]) =>
        Object.fromEntries(
          names.map((n) => [
            n,
            (t.raw.prepare(`SELECT count(*) AS n FROM "${n}"`).get() as { n: number }).n,
          ]),
        );
      const before = tables();
      const beforeCounts = counts(before);

      for (const s of statementsForMigration(MIGRATION)) t.raw.prepare(s).run();

      expect(tables()).toEqual([...before, 'plan_change_snapshots'].sort());
      expect(counts(before)).toEqual(beforeCounts);
      expect(beforeCounts.profiles).toBe(1);
    } finally {
      t.dispose();
    }
  });
});
