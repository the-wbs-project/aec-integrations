import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration, type TestDb } from './d1';

/**
 * AECI-1154 — `0052_sticky_gamma_corps.sql`, the owner's pricing page link,
 * `pricing_url`, on `integrations` and `connector_evidenced_pairs`
 * (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.17.11, `DATABASE_SCHEMA.md` §4.3 / §9a.6).
 *
 * Both tables are cascade parents. `integrations` owns `claims`, their
 * `attestations`, `integration_field_challenges` and `integration_vendor_links`;
 * `connector_evidenced_pairs` owns its own claims and contests. A drizzle-kit
 * recreate of either DROPs the table, and the DROP takes the children two levels
 * deep (`docs/migrations.md` §0 and §3.3a). So:
 *
 *   1. The file is two plain `ADD COLUMN`s, nullable, with no CHECK and nothing else.
 *   2. Applied to a SEEDED pre-0052 database, every child row survives.
 *   3. The contest CHECK `integration_field_challenges_field_check` is untouched:
 *      `pricing_url` is not contestable.
 */
const MIGRATION = '0052_sticky_gamma_corps.sql';
const NOW = '2026-09-28T00:00:00.000Z';
const STATEMENT =
  /^ALTER TABLE `(integrations|connector_evidenced_pairs)` ADD `pricing_url` text;?$/;

const count = (t: TestDb, table: string): number =>
  (t.raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

const ddl = (t: TestDb, table: string): string =>
  (
    t.raw.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as {
      sql: string;
    }
  ).sql;

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
  run(
    `INSERT INTO taxonomy_data_objects (id, slug, name, display_order, created_at, updated_at)
       VALUES ('do1','rfis','RFIs',10,?,?)`,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO integrations (id, source_product_id, target_product_id, pricing_model, created_at, updated_at)
       VALUES ('i1','p1','p2','Subscription',?,?)`,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO connector_evidenced_pairs (id, connector_product_id, product_a_id, product_b_id, created_at, updated_at)
       VALUES ('e1','p3','p1','p2',?,?)`,
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
    `INSERT INTO claims (id, connector_evidenced_pair_id, data_object_id, direction, created_at, updated_at)
       VALUES ('c2','e1','do1','a_to_b',?,?)`,
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
       (id, integration_id, field, reason, submitter_vendor_id, routed_to, created_at, updated_at)
     VALUES ('f1','i1','website','r','v1','aeci',?,?)`,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO integration_vendor_links (id, integration_id, product_id, kind, url, created_at, updated_at)
       VALUES ('l1','i1','p1','listing','https://a.example',?,?)`,
    NOW,
    NOW,
  );
  return t;
}

describe(`${MIGRATION} — additive`, () => {
  it('is two plain ADD COLUMNs of pricing_url, and nothing else', () => {
    const statements = statementsForMigration(MIGRATION);
    expect(statements).toHaveLength(2);
    const tables: string[] = [];
    for (const s of statements) {
      const sql = s
        .split('\n')
        .filter((line) => !line.startsWith('--'))
        .join('\n')
        .trim();
      const match = sql.match(STATEMENT);
      expect(match, sql).not.toBeNull();
      tables.push(match![1]!);
      expect(sql).not.toMatch(/DROP TABLE|CREATE TABLE|__new_|INSERT INTO|RENAME|UPDATE |CHECK/i);
    }
    expect(tables.sort()).toEqual(['connector_evidenced_pairs', 'integrations']);
  });

  it('keeps every child row, and leaves the contest CHECK alone, on seeded data', async () => {
    const t = await seedPreMigration();
    try {
      const contestDdl = ddl(t, 'integration_field_challenges');
      t.applyMigration(MIGRATION);
      expect(count(t, 'integrations')).toBe(1);
      expect(count(t, 'connector_evidenced_pairs')).toBe(1);
      expect(count(t, 'claims')).toBe(2);
      expect(count(t, 'attestations')).toBe(1);
      expect(count(t, 'integration_field_challenges')).toBe(1);
      expect(count(t, 'integration_vendor_links')).toBe(1);
      expect(ddl(t, 'integration_field_challenges')).toBe(contestDdl);
      expect(contestDdl).not.toContain('pricing_url');
      const row = t.raw
        .prepare(`SELECT pricing_url, pricing_model FROM integrations WHERE id = 'i1'`)
        .get();
      expect(row).toEqual({ pricing_url: null, pricing_model: 'Subscription' });
      expect(
        t.raw.prepare(`SELECT pricing_url FROM connector_evidenced_pairs WHERE id = 'e1'`).get(),
      ).toEqual({ pricing_url: null });
    } finally {
      t.dispose();
    }
  });
});
