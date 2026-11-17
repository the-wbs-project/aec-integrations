import { describe, expect, it } from 'vitest';

import { makeTestDb, migrationFiles, statementsForMigration } from './d1';

/**
 * AECI-1637: `0122_clever_roughhouse.sql` adds `legal_notice_reader_deliveries`
 * (`DATABASE_SCHEMA.md` §8.6l) and `terms_acceptances` (§8.6k). This file is the tripwire
 * on the body.
 *
 * It must stay additive: two `CREATE TABLE`s and their unique indexes. No statement may
 * touch an existing table, because a drizzle-kit recreate runs a `DROP TABLE` whose
 * implicit DELETE fires `ON DELETE CASCADE` into the children (`docs/migrations.md` §0).
 * Neither table has an FK: a reader acceptance survives the account's deletion (ruling 1
 * of 2026-11-13).
 */
const MIGRATION = '0122_clever_roughhouse.sql';
const NOW = '2026-11-13T00:00:00.000Z';

describe(`${MIGRATION}: additive: two CREATE TABLEs and two CREATE UNIQUE INDEXes`, () => {
  it('creates the two tables and their unique indexes, and nothing else', () => {
    const statements = statementsForMigration(MIGRATION).map((s) => s.trim());
    expect(statements).toHaveLength(4);
    expect(statements[0]).toMatch(/^CREATE TABLE `legal_notice_reader_deliveries` \(/);
    expect(statements[1]).toBe(
      'CREATE UNIQUE INDEX `legal_notice_reader_deliveries_version_profile_key` ON `legal_notice_reader_deliveries` (`legal_version_id`,`profile_id`);',
    );
    expect(statements[2]).toMatch(/^CREATE TABLE `terms_acceptances` \(/);
    expect(statements[3]).toBe(
      'CREATE UNIQUE INDEX `terms_acceptances_profile_document_version_key` ON `terms_acceptances` (`profile_id`,`document`,`version`);',
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

      expect(tables()).toEqual(
        [...before, 'legal_notice_reader_deliveries', 'terms_acceptances'].sort(),
      );
      expect(counts(before)).toEqual(beforeCounts);
      expect(beforeCounts.profiles).toBe(1);
    } finally {
      t.dispose();
    }
  });

  it('refuses a second acceptance of one version by one account, and outlives the profile', async () => {
    const t = await makeTestDb();
    try {
      t.raw
        .prepare(
          `INSERT INTO profiles (id, role, created_at, updated_at) VALUES ('u1', 'reviewer', ?, ?)`,
        )
        .run(NOW, NOW);
      const insert = t.raw.prepare(
        `INSERT INTO terms_acceptances (id, document, version, profile_id, email, accepted_at,
           checkbox_label, checkbox_label_sha256, checkbox_default_unticked, created_at)
         VALUES (?, 'terms', '1.2', 'u1', 'a@b.co', ?, 'l', 'h', 1, ?)`,
      );
      insert.run('a1', NOW, NOW);
      expect(() => insert.run('a2', NOW, NOW)).toThrow(
        /UNIQUE constraint failed: terms_acceptances/,
      );
      t.raw.prepare(`DELETE FROM profiles WHERE id = 'u1'`).run();
      expect(
        (t.raw.prepare(`SELECT count(*) AS n FROM terms_acceptances`).get() as { n: number }).n,
      ).toBe(1);
    } finally {
      t.dispose();
    }
  });
});
