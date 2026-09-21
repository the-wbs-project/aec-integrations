import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration, type TestDb } from './d1';

/**
 * AECI-1005 — `0044_slippery_edwin_jarvis.sql`, the vendor-ownership columns on
 * `integrations` (`claimed_at`, `origin`, `retired_at`; ADR 0035).
 *
 * `integrations` has two cascade children (`claims`, which cascades on into
 * `attestations`, and `integration_field_challenges`). A drizzle-kit recreate of
 * this table DROPs it, and the DROP fires those cascades: 0027 measured 1,697
 * claims and 1,697 attestations lost that way (`docs/migrations.md` §3.3a). So
 * this migration is additive by construction and these tests hold it there:
 *
 *   1. The file is three `ADD COLUMN`s and nothing else.
 *   2. Applied to a SEEDED pre-0044 database, every child row survives (rule 3 of
 *      §3.3a: a migration that applies cleanly to empty tables proves nothing).
 *   3. The hand-written `origin` CHECK is present in the live DDL. It is a column
 *      constraint drizzle-kit cannot see, so a later recreate generated from
 *      `schema.ts` would drop it silently. This assertion is what notices.
 */
const MIGRATION = '0044_slippery_edwin_jarvis.sql';
const NOW = '2026-09-21T00:00:00.000Z';

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
  run(
    `INSERT INTO products (id, slug, name, created_at, updated_at) VALUES ('p1','a','A',?,?)`,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO products (id, slug, name, created_at, updated_at) VALUES ('p2','b','B',?,?)`,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO taxonomy_data_objects (id, slug, name, display_order, created_at, updated_at)
       VALUES ('do1','rfis','RFIs',10,?,?)`,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO integrations (id, source_product_id, target_product_id, built_by_vendor_id, maintained_by, created_at, updated_at)
       VALUES ('i1','p1','p2','v1','vendor',?,?)`,
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
  run(
    `INSERT INTO integration_field_challenges
       (id, integration_id, field, reason, submitter_vendor_id, routed_to, status, created_at, updated_at)
     VALUES ('f1','i1','name','r','v1','aeci','open',?,?)`,
    NOW,
    NOW,
  );
  return t;
}

describe(`${MIGRATION} — additive`, () => {
  it('is three ADD COLUMNs on integrations and nothing else', () => {
    const statements = statementsForMigration(MIGRATION);
    expect(statements).toHaveLength(3);
    for (const s of statements) {
      // The header comment rides on the first chunk, so match the statement line.
      const sql = s
        .split('\n')
        .filter((line) => !line.startsWith('--'))
        .join('\n')
        .trim();
      expect(sql).toMatch(/^ALTER TABLE `integrations` ADD `(claimed_at|origin|retired_at)`/);
      expect(sql).not.toMatch(/DROP TABLE|CREATE TABLE|__new_|INSERT INTO|RENAME/i);
    }
  });

  it('keeps every cascade child of integrations when applied to seeded data', async () => {
    const t = await seedPreMigration();
    try {
      t.applyMigration(MIGRATION);
      expect(count(t, 'integrations')).toBe(1);
      expect(count(t, 'claims')).toBe(1);
      expect(count(t, 'attestations')).toBe(1);
      expect(count(t, 'integration_field_challenges')).toBe(1);
      const row = t.raw
        .prepare(
          `SELECT claimed_at, origin, retired_at, maintained_by FROM integrations WHERE id = 'i1'`,
        )
        .get() as Record<string, unknown>;
      // Existing rows are AECi-seeded and unclaimed. `maintained_by = 'vendor'` is
      // untouched, which is decision 13: that marker is NOT ownership.
      expect(row).toEqual({
        claimed_at: null,
        origin: 'aeci',
        retired_at: null,
        maintained_by: 'vendor',
      });
    } finally {
      t.dispose();
    }
  });

  it('keeps the hand-written origin CHECK in the live DDL and enforces it', async () => {
    const t = await makeTestDb();
    try {
      const ddl = (
        t.raw
          .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='integrations'`)
          .get() as { sql: string }
      ).sql;
      // If this fails, a recreate of `integrations` regenerated the table from
      // `schema.ts` and dropped the column constraint. Re-add it by hand in that
      // migration; do not move it into `schema.ts` (see the 0044 header).
      expect(ddl).toMatch(/"origin" IN \('aeci', 'vendor'\)/);

      const run = (sql: string, ...args: unknown[]) => t.raw.prepare(sql).run(...args);
      run(
        `INSERT INTO products (id, slug, name, created_at, updated_at) VALUES ('p1','a','A',?,?)`,
        NOW,
        NOW,
      );
      run(
        `INSERT INTO products (id, slug, name, created_at, updated_at) VALUES ('p2','b','B',?,?)`,
        NOW,
        NOW,
      );
      const insert = (id: string, origin: string) =>
        run(
          `INSERT INTO integrations (id, source_product_id, target_product_id, origin, created_at, updated_at)
             VALUES (?, 'p1', 'p2', ?, ?, ?)`,
          id,
          origin,
          NOW,
          NOW,
        );
      insert('i-aeci', 'aeci');
      insert('i-vendor', 'vendor');
      expect(() => insert('i-bad', 'review-app')).toThrow(/CHECK constraint failed/);
    } finally {
      t.dispose();
    }
  });
});
