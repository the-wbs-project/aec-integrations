import { describe, expect, it } from 'vitest';

import { makeTestDb, migrationFiles, statementsForMigration } from './d1';

/**
 * AECI-1620 — `0120_fat_mephistopheles.sql` adds the `legal_notice_deliveries` table
 * (`DATABASE_SCHEMA.md` §8.6j). This file is the tripwire on the body.
 *
 * It must stay additive: one `CREATE TABLE` and its unique index. No statement may touch
 * an existing table, because a drizzle-kit recreate runs a `DROP TABLE` whose implicit
 * DELETE fires `ON DELETE CASCADE` into the children (`docs/migrations.md` §0, §3.3a).
 * The seeded test proves every existing table keeps its rows.
 */
const MIGRATION = '0120_fat_mephistopheles.sql';
const NOW = '2026-11-12T00:00:00.000Z';

describe(`${MIGRATION} — additive: one CREATE TABLE and one CREATE UNIQUE INDEX`, () => {
  it('creates legal_notice_deliveries and its unique index, and nothing else', () => {
    const statements = statementsForMigration(MIGRATION).map((s) => s.trim());
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^CREATE TABLE `legal_notice_deliveries` \(/);
    expect(statements[1]).toBe(
      'CREATE UNIQUE INDEX `legal_notice_deliveries_version_vendor_key` ON `legal_notice_deliveries` (`legal_version_id`,`vendor_id`);',
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
          `INSERT INTO legal_versions (id, document, version, effective_at, summary_json, material,
             requires_acceptance, pdf_key, pdf_sha256, pdf_bytes, published_by, published_at)
           VALUES ('lv1', 'vendor_terms', '1.4', 0, '[]', 1, 0, 'k', 'h', 1, 'u', ?)`,
        )
        .run(NOW);
      t.raw
        .prepare(
          `INSERT INTO products (id, slug, name, created_at, updated_at)
           VALUES ('p1', 'p', 'P', ?, ?)`,
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

      expect(tables()).toEqual([...before, 'legal_notice_deliveries'].sort());
      expect(counts(before)).toEqual(beforeCounts);
      expect(beforeCounts.legal_versions).toBe(1);
      expect(beforeCounts.products).toBe(1);
    } finally {
      t.dispose();
    }
  });

  it('refuses a second row for the same version and company', async () => {
    const t = await makeTestDb();
    try {
      const insert = t.raw.prepare(
        `INSERT INTO legal_notice_deliveries (legal_version_id, vendor_id, status, created_at, updated_at)
         VALUES ('lv1', 'v1', 'queued', ?, ?)`,
      );
      insert.run(NOW, NOW);
      expect(() => insert.run(NOW, NOW)).toThrow(
        /UNIQUE constraint failed: legal_notice_deliveries/,
      );
    } finally {
      t.dispose();
    }
  });
});
