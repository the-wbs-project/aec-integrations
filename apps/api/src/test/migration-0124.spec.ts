import { describe, expect, it } from 'vitest';

import { makeTestDb, migrationFiles, statementsForMigration } from './d1';

/**
 * AECI-1680: `0124_silky_lila_cheney.sql` adds `acceptance_chain_exports` and
 * `acceptance_chain_rows` (`DATABASE_SCHEMA.md` §9.17, ADR 0057). This file is the
 * tripwire on the body.
 *
 * It must stay additive: two `CREATE TABLE`s and one index. No statement may touch an
 * existing table, because a drizzle-kit recreate runs a `DROP TABLE` whose implicit
 * DELETE fires `ON DELETE CASCADE` into the children (`docs/migrations.md` §0). Neither
 * table has an FK: the ledger must outlive any row it fingerprints.
 */
const MIGRATION = '0124_silky_lila_cheney.sql';
const NOW = '2026-11-17T00:00:00.000Z';

describe(`${MIGRATION}: additive: two CREATE TABLEs and one CREATE INDEX`, () => {
  it('creates the tables and the index, and nothing else', () => {
    const statements = statementsForMigration(MIGRATION).map((s) => s.trim());
    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatch(/^CREATE TABLE `acceptance_chain_exports` \(/);
    expect(statements[1]).toBe(
      'CREATE INDEX `acceptance_chain_exports_tsa_status_idx` ON `acceptance_chain_exports` (`tsa_status`,`seq`);',
    );
    expect(statements[2]).toMatch(/^CREATE TABLE `acceptance_chain_rows` \(/);
    expect(statements[2]).toContain('PRIMARY KEY(`table_name`, `row_id`)');
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

      expect(tables()).toEqual(
        [...before, 'acceptance_chain_exports', 'acceptance_chain_rows'].sort(),
      );
      expect(counts(before)).toEqual(beforeCounts);
      expect(beforeCounts.profiles).toBe(1);
    } finally {
      t.dispose();
    }
  });

  it('the seq primary key refuses a second row for one file', async () => {
    const t = await makeTestDb();
    try {
      const insert = () =>
        t.raw
          .prepare(
            `INSERT INTO acceptance_chain_exports (seq, day, object_key, sha256, state_sha256, entries, tsa_status, exported_at) VALUES (1, '2026-11-17', 'k', 's', 'st', 0, 'pending', ?)`,
          )
          .run(NOW);
      insert();
      expect(insert).toThrow(/UNIQUE|PRIMARY/);
    } finally {
      t.dispose();
    }
  });
});
