import { describe, expect, it } from 'vitest';

import { makeTestDb, migrationFiles, statementsForMigration } from './d1';

/**
 * AECI-1688 — `0119_violet_warpath.sql` adds the `legal_versions` table
 * (`DATABASE_SCHEMA.md` §8.6i). This file is the tripwire on the body.
 *
 * It must stay additive: one `CREATE TABLE` and its unique index. No statement may touch
 * an existing table, because a drizzle-kit recreate runs a `DROP TABLE` whose implicit
 * DELETE fires `ON DELETE CASCADE` into the children (`docs/migrations.md` §0, §3.3a).
 * The seeded test proves every existing table keeps its rows.
 */
const MIGRATION = '0119_violet_warpath.sql';
const NOW = '2026-11-12T00:00:00.000Z';

describe(`${MIGRATION} — additive: one CREATE TABLE and one CREATE UNIQUE INDEX`, () => {
  it('creates legal_versions and its unique index, and nothing else', () => {
    const statements = statementsForMigration(MIGRATION).map((s) => s.trim());
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^CREATE TABLE `legal_versions` \(/);
    expect(statements[1]).toBe(
      'CREATE UNIQUE INDEX `legal_versions_document_version_key` ON `legal_versions` (`document`,`version`);',
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
          `INSERT INTO products (id, slug, name, created_at, updated_at)
           VALUES ('p1', 'p', 'P', ?, ?)`,
        )
        .run(NOW, NOW);
      t.raw
        .prepare(
          `INSERT INTO agreement_acceptances (id, document, version, source, email, accepted_at, created_at)
           VALUES ('a1', 'vendor_terms', '1.3', 'claim', 'x@example.com', ?, ?)`,
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

      expect(tables()).toEqual([...before, 'legal_versions'].sort());
      expect(counts(before)).toEqual(beforeCounts);
      expect(beforeCounts.products).toBe(1);
      expect(beforeCounts.agreement_acceptances).toBe(1);
    } finally {
      t.dispose();
    }
  });

  it('refuses a second row for the same document and version', async () => {
    const t = await makeTestDb();
    try {
      const insert = t.raw.prepare(
        `INSERT INTO legal_versions (id, document, version, effective_at, summary_json, material,
           requires_acceptance, pdf_key, pdf_sha256, pdf_bytes, published_by, published_at)
         VALUES (?, 'vendor_terms', '1.4', 0, '[]', 1, 0, 'k', 'h', 1, 'u', ?)`,
      );
      insert.run('r1', NOW);
      expect(() => insert.run('r2', NOW)).toThrow(/UNIQUE constraint failed: legal_versions/);
    } finally {
      t.dispose();
    }
  });
});
