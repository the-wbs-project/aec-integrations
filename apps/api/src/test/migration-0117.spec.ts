import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration } from './d1';

/**
 * AECI-534, PR B — `0117_drop_has_api_docs.sql` drops `products.has_api_docs`. This
 * file is the tripwire on the body.
 *
 * It must stay one plain `DROP COLUMN`. A recreate of `products` runs a `DROP TABLE`,
 * whose implicit DELETE fires `ON DELETE CASCADE` into every child of `products`.
 * `PRAGMA defer_foreign_keys` does not stop that (`docs/migrations.md` §3.3a). The
 * seeded test below proves a product and a child row survive.
 */
const MIGRATION = '0117_drop_has_api_docs.sql';
const NOW = '2026-11-11T00:00:00.000Z';

const withoutComments = (s: string) =>
  s
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim();

describe(`${MIGRATION} — one plain DROP COLUMN`, () => {
  it('carries exactly the drop and nothing else', () => {
    const statements = statementsForMigration(MIGRATION).map(withoutComments);
    expect(statements).toEqual(['ALTER TABLE `products` DROP COLUMN `has_api_docs`;']);
    expect(statements[0]).not.toMatch(/__new_|DROP TABLE|CREATE|INSERT INTO|PRAGMA/i);
  });

  it('drops the column and keeps every product and child row', async () => {
    const t = await makeTestDb({ upToExclusive: MIGRATION });
    try {
      t.raw
        .prepare(
          `INSERT INTO products (id, slug, name, has_api_docs, created_at, updated_at)
           VALUES ('p1', 'p', 'P', 1, ?, ?)`,
        )
        .run(NOW, NOW);
      t.raw
        .prepare(
          `INSERT INTO taxonomy_categories (id, slug, name, created_at, updated_at)
           VALUES ('c1', 'c', 'C', ?, ?)`,
        )
        .run(NOW, NOW);
      t.raw
        .prepare(
          `INSERT INTO product_categories (product_id, category_id, created_at)
           VALUES ('p1', 'c1', ?)`,
        )
        .run(NOW);

      const snapshot = () => ({
        products: t.raw.prepare(`SELECT id, slug FROM products ORDER BY id`).all(),
        children: t.raw.prepare(`SELECT product_id FROM product_categories`).all(),
      });
      const before = snapshot();

      for (const s of statementsForMigration(MIGRATION)) t.raw.prepare(s).run();

      expect(before.children).toEqual([{ product_id: 'p1' }]);
      expect(snapshot()).toEqual(before);
      expect(t.raw.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
      const columns = t.raw
        .prepare(`SELECT name FROM pragma_table_info('products')`)
        .all() as Array<{ name: string }>;
      expect(columns.map((c) => c.name)).not.toContain('has_api_docs');
    } finally {
      t.dispose();
    }
  });
});
