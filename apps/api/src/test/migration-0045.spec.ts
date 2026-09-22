import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration, type TestDb } from './d1';

/**
 * AECI-1007 — `0045_ambitious_carlie_cooper.sql`, the per-side integration links
 * table (`integration_vendor_links`; ADR 0035 decision 6).
 *
 * The migration only CREATEs, so it cannot lose data by itself. What it changes is
 * the NEXT recreate of `integrations`: the new table is a third cascade child, and a
 * recreate in drizzle-kit's generated order would empty it along with `claims`,
 * `attestations` and `integration_field_challenges` (`docs/migrations.md` §3.3a).
 * These tests hold three things:
 *
 *   1. The file is one CREATE TABLE and one CREATE UNIQUE INDEX, and nothing that
 *      recreates, drops or rewrites an existing table.
 *   2. Applied to a SEEDED pre-0045 database, every existing child row survives.
 *   3. The constraints behave: the kind CHECK, one link per side and kind, the
 *      cascade from `integrations`, and SET NULL from `vendors`.
 */
const MIGRATION = '0045_ambitious_carlie_cooper.sql';
const NOW = '2026-09-22T00:00:00.000Z';

const count = (t: TestDb, table: string): number =>
  (t.raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

function seed(t: TestDb): void {
  const run = (sql: string, ...args: unknown[]) => t.raw.prepare(sql).run(...args);
  run(
    `INSERT INTO vendors (id, slug, company_name, created_at, updated_at) VALUES ('v1','v','V',?,?)`,
    NOW,
    NOW,
  );
  for (const [id, slug] of [
    ['p1', 'a'],
    ['p2', 'b'],
  ]) {
    run(
      `INSERT INTO products (id, slug, name, created_at, updated_at) VALUES (?,?,?,?,?)`,
      id,
      slug,
      slug.toUpperCase(),
      NOW,
      NOW,
    );
  }
  run(
    `INSERT INTO taxonomy_data_objects (id, slug, name, display_order, created_at, updated_at)
       VALUES ('do1','rfis','RFIs',10,?,?)`,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO integrations (id, source_product_id, target_product_id, built_by_vendor_id, created_at, updated_at)
       VALUES ('i1','p1','p2','v1',?,?)`,
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
}

const insertLink = (t: TestDb, id: string, kind: string, productId = 'p1', vendorId = 'v1') =>
  t.raw
    .prepare(
      `INSERT INTO integration_vendor_links (id, integration_id, product_id, kind, url, vendor_id, created_at, updated_at)
         VALUES (?, 'i1', ?, ?, 'https://example.com/x', ?, ?, ?)`,
    )
    .run(id, productId, kind, vendorId, NOW, NOW);

describe(`${MIGRATION} — additive`, () => {
  it('is one CREATE TABLE plus its unique index, and touches no existing table', () => {
    const statements = statementsForMigration(MIGRATION).map((s) =>
      s
        .split('\n')
        .filter((line) => !line.startsWith('--'))
        .join('\n')
        .trim(),
    );
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^CREATE TABLE `integration_vendor_links`/);
    expect(statements[1]).toMatch(
      /^CREATE UNIQUE INDEX `integration_vendor_links_side_kind_key` ON `integration_vendor_links`/,
    );
    for (const sql of statements) {
      expect(sql).not.toMatch(/DROP TABLE|ALTER TABLE|__new_|INSERT INTO|RENAME/i);
    }
  });

  it('keeps every existing cascade child of integrations when applied to seeded data', async () => {
    const t = await makeTestDb({ upToExclusive: MIGRATION });
    try {
      seed(t);
      t.applyMigration(MIGRATION);
      expect(count(t, 'integrations')).toBe(1);
      expect(count(t, 'claims')).toBe(1);
      expect(count(t, 'attestations')).toBe(1);
      expect(count(t, 'integration_field_challenges')).toBe(1);
      expect(count(t, 'integration_vendor_links')).toBe(0);
    } finally {
      t.dispose();
    }
  });

  it('enforces the kind vocabulary and one link per side and kind', async () => {
    const t = await makeTestDb();
    try {
      seed(t);
      insertLink(t, 'l1', 'listing');
      insertLink(t, 'l2', 'docs');
      // The other side may set its own listing link on the same row.
      insertLink(t, 'l3', 'listing', 'p2');
      expect(() => insertLink(t, 'l4', 'listing')).toThrow(/UNIQUE constraint failed/);
      expect(() => insertLink(t, 'l5', 'pricing')).toThrow(/CHECK constraint failed/);
    } finally {
      t.dispose();
    }
  });

  it('cascades from integrations and detaches from vendors', async () => {
    const t = await makeTestDb();
    try {
      seed(t);
      insertLink(t, 'l1', 'listing');
      t.raw.prepare(`DELETE FROM integration_field_challenges`).run();
      t.raw.prepare(`UPDATE integrations SET built_by_vendor_id = NULL`).run();
      t.raw.prepare(`DELETE FROM vendors WHERE id = 'v1'`).run();
      const link = t.raw
        .prepare(`SELECT vendor_id FROM integration_vendor_links WHERE id = 'l1'`)
        .get() as { vendor_id: string | null };
      expect(link.vendor_id).toBeNull();

      t.raw.prepare(`DELETE FROM integrations WHERE id = 'i1'`).run();
      expect(count(t, 'integration_vendor_links')).toBe(0);
    } finally {
      t.dispose();
    }
  });
});
