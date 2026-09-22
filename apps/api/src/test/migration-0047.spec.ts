import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration, type TestDb } from './d1';

/**
 * AECI-1009 — `0047_quick_makkari.sql`, the protest columns on
 * `integration_field_challenges` (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11b.12).
 *
 * The table is a cascade child of `integrations`, so a recreate of it is the same
 * data-loss shape `docs/migrations.md` §3.3a warns about. The body is hand-authored
 * because drizzle-kit's `ADD … REFERENCES` drops `ON DELETE SET NULL` and a CHECK in
 * `schema.ts` would render a recreate. These tests hold all three decisions:
 *
 *   1. The file is fifteen `ADD`s and one `CREATE INDEX`, nothing else.
 *   2. Applied to a seeded pre-0047 database, every contest survives unchanged.
 *   3. Both column CHECKs are in the live DDL and enforced, and deleting a profile
 *      nulls each of the three new profile columns rather than failing.
 */
const MIGRATION = '0047_quick_makkari.sql';
const NOW = '2026-09-22T00:00:00.000Z';

function seed(t: TestDb): void {
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
    `INSERT INTO integrations (id, source_product_id, target_product_id, created_at, updated_at)
       VALUES ('i1','p1','p2',?,?)`,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO integration_field_challenges
       (id, integration_id, field, current_value, proposed_value, reason, submitter_vendor_id,
        routed_to, status, created_at, updated_at)
     VALUES ('f1','i1','name','Old','New','r','v1','owner','declined',?,?)`,
    NOW,
    NOW,
  );
}

const stripComments = (s: string): string =>
  s
    .split('\n')
    .filter((line) => !line.startsWith('--'))
    .join('\n')
    .trim();

describe(`${MIGRATION} — additive`, () => {
  it('is fifteen ADDs on integration_field_challenges plus one index, nothing else', () => {
    const statements = statementsForMigration(MIGRATION).map(stripComments);
    expect(statements).toHaveLength(16);
    for (const sql of statements.slice(0, 15)) {
      expect(sql).toMatch(/^ALTER TABLE `integration_field_challenges` ADD `protest/);
    }
    expect(statements[15]).toMatch(/^CREATE INDEX `integration_field_challenges_protest_idx`/);
    for (const sql of statements) {
      expect(sql).not.toMatch(/DROP TABLE|CREATE TABLE|__new_|INSERT INTO|RENAME/i);
    }
    // Every FK keeps its ON DELETE clause (drizzle-kit's generated form had none).
    const fks = statements.filter((s) => s.includes('REFERENCES'));
    expect(fks).toHaveLength(4);
    for (const s of fks) expect(s).toMatch(/ON DELETE SET NULL/);
  });

  it('keeps every existing contest unchanged when applied to seeded data', async () => {
    const t = await makeTestDb({ upToExclusive: MIGRATION });
    try {
      seed(t);
      t.applyMigration(MIGRATION);
      const row = t.raw
        .prepare(
          `SELECT status, current_value, proposed_value, protest_status, protest_basis
             FROM integration_field_challenges WHERE id = 'f1'`,
        )
        .get() as Record<string, unknown>;
      expect(row).toEqual({
        status: 'declined',
        current_value: 'Old',
        proposed_value: 'New',
        protest_status: null,
        protest_basis: null,
      });
    } finally {
      t.dispose();
    }
  });

  it('enforces both column CHECKs', async () => {
    const t = await makeTestDb();
    try {
      seed(t);
      const set = (col: string, value: string) =>
        t.raw
          .prepare(`UPDATE integration_field_challenges SET ${col} = ? WHERE id = 'f1'`)
          .run(value);
      expect(() => set('protest_status', 'open')).not.toThrow();
      expect(() => set('protest_status', 'upheld')).not.toThrow();
      expect(() => set('protest_status', 'pending')).toThrow(/CHECK/);
      expect(() => set('protest_basis', 'silence')).not.toThrow();
      expect(() => set('protest_basis', 'late')).toThrow(/CHECK/);
    } finally {
      t.dispose();
    }
  });

  it('nulls the three profile columns when the profile is deleted', async () => {
    const t = await makeTestDb();
    try {
      seed(t);
      t.raw
        .prepare(
          `INSERT INTO profiles (id, created_at, updated_at) VALUES ('u1', ?, ?)`,
        )
        .run(NOW, NOW);
      t.raw
        .prepare(
          `UPDATE integration_field_challenges
             SET protested_by = 'u1', protest_replied_by = 'u1', protest_decided_by = 'u1'
           WHERE id = 'f1'`,
        )
        .run();
      t.raw.prepare(`DELETE FROM profiles WHERE id = 'u1'`).run();
      const row = t.raw
        .prepare(
          `SELECT protested_by, protest_replied_by, protest_decided_by
             FROM integration_field_challenges WHERE id = 'f1'`,
        )
        .get();
      expect(row).toEqual({
        protested_by: null,
        protest_replied_by: null,
        protest_decided_by: null,
      });
    } finally {
      t.dispose();
    }
  });
});
