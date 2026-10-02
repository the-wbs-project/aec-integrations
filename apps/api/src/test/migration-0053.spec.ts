import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration, type TestDb } from './d1';

/**
 * AECI-1216 — `0053_blushing_crystal.sql`, `products.integrations_reviewed_at`, the
 * integration-list "Looks right" stamp (`STAGE_2_PAID_TIERS_SPEC.md` §13.9,
 * `DATABASE_SCHEMA.md` §4.2).
 *
 * `products` is the widest cascade parent in the schema. A drizzle-kit recreate DROPs
 * it, and the DROP takes `integrations`, their `claims` and `attestations`, and
 * every `product_*` join with it (`docs/migrations.md` §0). So:
 *
 *   1. The file is one plain `ADD COLUMN`, nullable, with no CHECK and nothing else.
 *   2. Applied to a SEEDED pre-0053 database, every child row survives.
 *   3. The new column starts NULL on every row. There is no backfill: "never
 *      checked" is the truthful starting state.
 */
const MIGRATION = '0053_blushing_crystal.sql';
const NOW = '2026-10-02T00:00:00.000Z';
const STATEMENT = /^ALTER TABLE `products` ADD `integrations_reviewed_at` text;?$/;

const count = (t: TestDb, table: string): number =>
  (t.raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

async function seedPreMigration(): Promise<TestDb> {
  const t = await makeTestDb({ upToExclusive: MIGRATION });
  const run = (sql: string, ...args: unknown[]) => t.raw.prepare(sql).run(...args);
  run(
    `INSERT INTO vendors (id, slug, company_name, created_at, updated_at) VALUES ('v1','v','V',?,?)`,
    NOW,
    NOW,
  );
  for (const [id, slug] of [
    ['p1', 'a'],
    ['p2', 'b'],
  ] as const) {
    run(
      `INSERT INTO products (id, slug, name, last_reviewed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      slug,
      slug.toUpperCase(),
      NOW,
      NOW,
      NOW,
    );
  }
  run(
    `INSERT INTO product_vendors (product_id, vendor_id, is_primary, created_at)
       VALUES ('p1','v1',1,?)`,
    NOW,
  );
  run(
    `INSERT INTO taxonomy_data_objects (id, slug, name, display_order, created_at, updated_at)
       VALUES ('do1','rfis','RFIs',10,?,?)`,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO integrations (id, source_product_id, target_product_id, created_at, updated_at)
       VALUES ('i1','p1','p2',?,?)`,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO claims (id, integration_id, data_object_id, direction, created_at, updated_at)
       VALUES ('c1','i1','do1','a_to_b',?,?)`,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO attestations (id, claim_id, source, asserted, created_at, updated_at)
       VALUES ('a1','c1','aeci',1,?,?)`,
    NOW,
    NOW,
  );
  return t;
}

describe(`${MIGRATION} — additive`, () => {
  it('is one plain ADD COLUMN of integrations_reviewed_at, and nothing else', () => {
    const statements = statementsForMigration(MIGRATION);
    expect(statements).toHaveLength(1);
    const sql = statements[0]!
      .split('\n')
      .filter((line) => !line.startsWith('--'))
      .join('\n')
      .trim();
    expect(sql).toMatch(STATEMENT);
    expect(sql).not.toMatch(/DROP TABLE|CREATE TABLE|__new_|INSERT INTO|RENAME|UPDATE |CHECK/i);
  });

  it('keeps every child row and starts the column NULL, on seeded data', async () => {
    const t = await seedPreMigration();
    try {
      t.applyMigration(MIGRATION);
      expect(count(t, 'products')).toBe(2);
      expect(count(t, 'product_vendors')).toBe(1);
      expect(count(t, 'integrations')).toBe(1);
      expect(count(t, 'claims')).toBe(1);
      expect(count(t, 'attestations')).toBe(1);
      expect(
        t.raw
          .prepare(
            `SELECT integrations_reviewed_at, last_reviewed_at FROM products WHERE id = 'p1'`,
          )
          .get(),
      ).toEqual({ integrations_reviewed_at: null, last_reviewed_at: NOW });
    } finally {
      t.dispose();
    }
  });
});
