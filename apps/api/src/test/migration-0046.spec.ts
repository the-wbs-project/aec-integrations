import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration, type TestDb } from './d1';

/**
 * AECI-1046 — `0046_absurd_ozymandias.sql`, `integrations.retired_by`.
 *
 * Same hazard as 0044: a recreate of `integrations` DROPs it and the DROP fires the
 * cascades into `claims` -> `attestations` and `integration_field_challenges`
 * (`docs/migrations.md` §3.3a). So:
 *
 *   1. The file is one `ADD COLUMN` and nothing else.
 *   2. Applied to a SEEDED pre-0046 database (including a retired row), every child
 *      row survives and the retired row keeps NULL, which readers treat as 'owner'.
 *   3. The hand-written `retired_by` CHECK is in the live DDL and enforced, and the
 *      0044 `origin` CHECK is still there.
 */
const MIGRATION = '0046_absurd_ozymandias.sql';
const NOW = '2026-09-22T00:00:00.000Z';

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
    `INSERT INTO integrations (id, source_product_id, target_product_id, built_by_vendor_id, maintained_by, claimed_at, retired_at, created_at, updated_at)
       VALUES ('i1','p1','p2','v1','vendor',?,?,?,?)`,
    NOW,
    NOW,
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
  it('is one ADD COLUMN on integrations and nothing else', () => {
    const statements = statementsForMigration(MIGRATION);
    expect(statements).toHaveLength(1);
    const sql = statements[0]!
      .split('\n')
      .filter((line) => !line.startsWith('--'))
      .join('\n')
      .trim();
    expect(sql).toMatch(/^ALTER TABLE `integrations` ADD `retired_by`/);
    expect(sql).not.toMatch(/DROP TABLE|CREATE TABLE|__new_|INSERT INTO|RENAME|UPDATE/i);
  });

  it('keeps every cascade child of integrations and does not backfill', async () => {
    const t = await seedPreMigration();
    try {
      t.applyMigration(MIGRATION);
      expect(count(t, 'integrations')).toBe(1);
      expect(count(t, 'claims')).toBe(1);
      expect(count(t, 'attestations')).toBe(1);
      expect(count(t, 'integration_field_challenges')).toBe(1);
      const row = t.raw
        .prepare(`SELECT retired_at, retired_by FROM integrations WHERE id = 'i1'`)
        .get() as Record<string, unknown>;
      // A pre-0046 retire was an owner retire. NULL stays, readers map it to 'owner'.
      expect(row).toEqual({ retired_at: NOW, retired_by: null });
    } finally {
      t.dispose();
    }
  });

  it('keeps the hand-written retired_by and origin CHECKs in the live DDL', async () => {
    const t = await makeTestDb();
    try {
      const ddl = (
        t.raw
          .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='integrations'`)
          .get() as { sql: string }
      ).sql;
      expect(ddl).toMatch(/"retired_by" IN \('owner', 'aeci'\)/);
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
      const insert = (id: string, retiredBy: string | null) =>
        run(
          `INSERT INTO integrations (id, source_product_id, target_product_id, retired_by, created_at, updated_at)
             VALUES (?, 'p1', 'p2', ?, ?, ?)`,
          id,
          retiredBy,
          NOW,
          NOW,
        );
      insert('i-live', null);
      insert('i-owner', 'owner');
      insert('i-aeci', 'aeci');
      expect(() => insert('i-bad', 'admin')).toThrow(/CHECK constraint failed/);
    } finally {
      t.dispose();
    }
  });
});
