import { describe, expect, it } from 'vitest';

import { makeTestDb, migrationFiles, statementsForMigration } from './d1';

/**
 * AECI-2198: `0136_products_summary.sql` adds the nullable
 * `products.summary` column (`DATABASE_SCHEMA.md` §4.2). This file is the
 * tripwire on the body.
 *
 * It must stay one bare `ALTER TABLE products ADD`. A drizzle-kit recreate of `products`
 * runs a `DROP TABLE` whose implicit DELETE fires `ON DELETE CASCADE` into every child
 * table (`docs/migrations.md` §0), so a `__new_products` statement here is data loss.
 */
const MIGRATION = '0136_products_summary.sql';
const NOW = '2026-11-26T00:00:00.000Z';

describe(`${MIGRATION}: one bare ADD COLUMN on products`, () => {
  it('adds the column and nothing else', () => {
    const statements = statementsForMigration(MIGRATION).map((s) => s.trim());
    expect(statements).toEqual(['ALTER TABLE `products` ADD `summary` text;']);
    for (const s of statements) {
      expect(s).not.toMatch(/__new_|DROP |INSERT INTO|PRAGMA|CHECK/i);
    }
  });

  it('is in the migration set the harness applies', () => {
    expect(migrationFiles()).toContain(MIGRATION);
  });

  it('keeps an existing product row and leaves the new column NULL', async () => {
    const t = await makeTestDb({ upToExclusive: MIGRATION });
    try {
      t.raw
        .prepare(
          `INSERT INTO products (id, slug, name, description, created_at, updated_at)
           VALUES ('p1', 'p-one', 'P One', 'Long text.', ?, ?)`,
        )
        .run(NOW, NOW);

      for (const s of statementsForMigration(MIGRATION)) t.raw.prepare(s).run();

      const row = t.raw
        .prepare(`SELECT description, summary FROM products WHERE id = 'p1'`)
        .get() as { description: string; summary: string | null };
      expect(row).toEqual({ description: 'Long text.', summary: null });
    } finally {
      t.dispose();
    }
  });
});
