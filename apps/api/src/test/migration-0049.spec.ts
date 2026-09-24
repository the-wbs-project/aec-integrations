import { describe, expect, it } from 'vitest';

import {
  ddlHasColumn,
  notVendorHeldSql,
  vendorHeldColumnsSql,
  // @ts-expect-error — plain-ESM ops module, deliberately untyped.
} from '../../../../scripts/ops/2026-09-retraction-consumer/vendor-held.mjs';
import { makeTestDb, statementsForMigration, type TestDb } from './d1';

/**
 * AECI-1088 — `0049_majestic_mentallo.sql`, the vendor-ownership columns on
 * `connector_evidenced_pairs` (`claimed_at`, `origin`, `retired_at`, `retired_by`;
 * the AECI-1040 owner carve-out, ADR 0035).
 *
 * `connector_evidenced_pairs` is a cascade parent of `claims`
 * (`claims.connector_evidenced_pair_id`), and `attestations` cascade from `claims`. A
 * drizzle-kit recreate of this table DROPs it, and the DROP takes both, two levels
 * deep (`docs/migrations.md` §3.3a). So:
 *
 *   1. The file is four `ADD COLUMN`s on this table and nothing else.
 *   2. Applied to a SEEDED pre-0049 database, the pair, its claim and its
 *      attestation survive, and the pair reads as AECi-seeded and unclaimed.
 *   3. The hand-written `origin` and `retired_by` CHECKs are in the live DDL and
 *      enforced. drizzle-kit cannot see them, so a later recreate generated from
 *      `schema.ts` would drop them silently. This assertion is what notices.
 *   4. The ops lanes' DDL probe now finds both vendor-held columns on this table, so
 *      `notVendorHeldSql` switches on. Before 0049 it returns '' without an error.
 */
const MIGRATION = '0049_majestic_mentallo.sql';
const NOW = '2026-09-23T00:00:00.000Z';
const DDL_SQL = `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'connector_evidenced_pairs'`;
const STATEMENT = /^ALTER TABLE `connector_evidenced_pairs` ADD `([a-z_]+)`/;

const count = (t: TestDb, table: string): number =>
  (t.raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

const ddlOf = (t: TestDb): string => (t.raw.prepare(DDL_SQL).get() as { sql: string }).sql;

function seedProducts(t: TestDb): void {
  const run = (sql: string, ...args: unknown[]) => t.raw.prepare(sql).run(...args);
  run(
    `INSERT INTO vendors (id, slug, company_name, created_at, updated_at) VALUES ('v1','v','V',?,?)`,
    NOW,
    NOW,
  );
  for (const [id, slug] of [
    ['p0', 'z'],
    ['p1', 'a'],
    ['p2', 'b'],
    ['p3', 'c'],
  ] as const) {
    run(
      `INSERT INTO products (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      id,
      slug,
      slug.toUpperCase(),
      NOW,
      NOW,
    );
  }
}

async function seedPreMigration(): Promise<TestDb> {
  const t = await makeTestDb({ upToExclusive: MIGRATION });
  seedProducts(t);
  const run = (sql: string, ...args: unknown[]) => t.raw.prepare(sql).run(...args);
  run(
    `INSERT INTO taxonomy_data_objects (id, slug, name, display_order, created_at, updated_at)
       VALUES ('do1','rfis','RFIs',10,?,?)`,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO connector_evidenced_pairs
       (id, connector_product_id, product_a_id, product_b_id, built_by_vendor_id, maintained_by, created_at, updated_at)
     VALUES ('e1','p3','p1','p2','v1','vendor',?,?)`,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO claims (id, connector_evidenced_pair_id, data_object_id, direction, created_at, updated_at)
       VALUES ('c1','e1','do1','a_to_b',?,?)`,
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
  it('is four ADD COLUMNs on connector_evidenced_pairs and nothing else', () => {
    const statements = statementsForMigration(MIGRATION);
    expect(statements).toHaveLength(4);
    const columns: string[] = [];
    for (const s of statements) {
      // The header comment rides on the first chunk, so match the statement line.
      const sql = s
        .split('\n')
        .filter((line) => !line.startsWith('--'))
        .join('\n')
        .trim();
      const match = sql.match(STATEMENT);
      expect(match, sql).not.toBeNull();
      columns.push(match![1]!);
      expect(sql).not.toMatch(/DROP TABLE|CREATE TABLE|__new_|INSERT INTO|RENAME|UPDATE /i);
    }
    expect(columns).toEqual(['claimed_at', 'origin', 'retired_at', 'retired_by']);
  });

  it('keeps the pair, its claim and its attestation when applied to seeded data', async () => {
    const t = await seedPreMigration();
    try {
      t.applyMigration(MIGRATION);
      expect(count(t, 'connector_evidenced_pairs')).toBe(1);
      expect(count(t, 'claims')).toBe(1);
      expect(count(t, 'attestations')).toBe(1);
      const row = t.raw
        .prepare(
          `SELECT claimed_at, origin, retired_at, retired_by, maintained_by
             FROM connector_evidenced_pairs WHERE id = 'e1'`,
        )
        .get() as Record<string, unknown>;
      // Existing pairs are AECi-seeded and unclaimed. `maintained_by = 'vendor'` is
      // untouched: that marker is not ownership (AECI-1003 decision 13).
      expect(row).toEqual({
        claimed_at: null,
        origin: 'aeci',
        retired_at: null,
        retired_by: null,
        maintained_by: 'vendor',
      });
    } finally {
      t.dispose();
    }
  });

  it('keeps the hand-written origin and retired_by CHECKs in the live DDL and enforces them', async () => {
    const t = await makeTestDb();
    try {
      // If this fails, a recreate of `connector_evidenced_pairs` regenerated the table
      // from `schema.ts` and dropped the column constraints, and it also DROPped every
      // claim and attestation on a pair. Re-add the CHECKs as column constraints and
      // read docs/migrations.md §3.3a before anything else.
      const ddl = ddlOf(t);
      expect(ddl).toMatch(/"origin" IN \('aeci', 'vendor'\)/);
      expect(ddl).toMatch(/"retired_by" IN \('owner', 'aeci'\)/);

      seedProducts(t);
      const run = (sql: string, ...args: unknown[]) => t.raw.prepare(sql).run(...args);
      // Each insert uses its own A, so the unique pair index is never what fails.
      run(
        `INSERT INTO connector_evidenced_pairs (id, connector_product_id, product_a_id, product_b_id, created_at, updated_at)
           VALUES ('e-default', 'p3', 'p1', 'p2', ?, ?)`,
        NOW,
        NOW,
      );
      expect(
        t.raw.prepare(`SELECT origin FROM connector_evidenced_pairs WHERE id = 'e-default'`).get(),
      ).toEqual({ origin: 'aeci' });
      const insert = (id: string, origin: string, retiredBy: string | null) =>
        run(
          `INSERT INTO connector_evidenced_pairs
             (id, connector_product_id, product_a_id, product_b_id, origin, retired_by, created_at, updated_at)
           VALUES (?, 'p3', 'p0', 'p2', ?, ?, ?, ?)`,
          id,
          origin,
          retiredBy,
          NOW,
          NOW,
        );
      expect(() => insert('e-bad-origin', 'curator', null)).toThrow(/CHECK constraint failed/);
      expect(() => insert('e-bad-retired', 'aeci', 'admin')).toThrow(/CHECK constraint failed/);
      insert('e-vendor-owner', 'vendor', 'owner');
      expect(count(t, 'connector_evidenced_pairs')).toBe(2);
    } finally {
      t.dispose();
    }
  });

  it('switches the ops lanes’ vendor-held guard on for this table', async () => {
    const before = await makeTestDb({ upToExclusive: MIGRATION });
    const after = await makeTestDb();
    try {
      const pre = ddlOf(before);
      expect(ddlHasColumn(pre, 'claimed_at')).toBe(false);
      expect(ddlHasColumn(pre, 'origin')).toBe(false);
      expect(notVendorHeldSql(pre)).toBe('');
      expect(vendorHeldColumnsSql('e', pre)).toBe('NULL AS claimedAt, NULL AS origin');

      const post = ddlOf(after);
      expect(ddlHasColumn(post, 'claimed_at')).toBe(true);
      expect(ddlHasColumn(post, 'origin')).toBe(true);
      expect(notVendorHeldSql(post)).toBe(` AND "claimed_at" IS NULL AND "origin" <> 'vendor'`);
      const projection = vendorHeldColumnsSql('e', post);
      expect(projection).toBe('e.claimed_at AS claimedAt, e.origin AS origin');
      // Both run against their own schema.
      expect(() =>
        after.raw.prepare(`SELECT ${projection} FROM connector_evidenced_pairs e`).all(),
      ).not.toThrow();
      expect(() =>
        after.raw
          .prepare(`DELETE FROM connector_evidenced_pairs WHERE id = 'x'${notVendorHeldSql(post)}`)
          .run(),
      ).not.toThrow();
    } finally {
      before.dispose();
      after.dispose();
    }
  });
});
