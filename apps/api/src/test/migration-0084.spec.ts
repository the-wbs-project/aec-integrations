import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration } from './d1';

/**
 * AECI-1416 (E6b.4) — `0084_superb_ted_forrester.sql` creates `product_proposals`
 * (ADR 0042, `DATABASE_SCHEMA.md` §8.6f). This file is the tripwire on the body.
 *
 * The migration must create the new table and its two indexes and touch nothing else.
 * A recreate of an existing table would fire its `ON DELETE` actions
 * (`docs/migrations.md` §0), so any other shape fails the first test.
 */
const MIGRATION = '0084_superb_ted_forrester.sql';
const NOW = '2026-10-19T00:00:00.000Z';

const withoutComments = (s: string) =>
  s
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim();

describe(`${MIGRATION} — product_proposals`, () => {
  const statements = statementsForMigration(MIGRATION).map(withoutComments);

  it('is one CREATE TABLE and two CREATE INDEX on the new table, and no recreate', () => {
    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatch(/^CREATE TABLE `product_proposals` \(/);
    expect(statements[1]).toMatch(
      /^CREATE UNIQUE INDEX `product_proposals_ref_key` ON `product_proposals` \(`ref`\);$/,
    );
    expect(statements[2]).toMatch(
      /^CREATE INDEX `product_proposals_vendor_open_idx` ON `product_proposals` .* WHERE "decision" IS NULL;$/,
    );
    for (const s of statements) {
      expect(s).not.toMatch(/__new_|DROP TABLE|ALTER TABLE|INSERT INTO|PRAGMA|^UPDATE|^DELETE/i);
    }
  });

  it('keys vendor_id NO ACTION, so a vendor delete is refused while a proposal exists', async () => {
    const t = await makeTestDb();
    try {
      const fks = t.raw
        .prepare(
          `SELECT "from" AS col, "table" AS target, on_delete AS onDelete
             FROM pragma_foreign_key_list('product_proposals')`,
        )
        .all();
      expect(fks).toEqual([{ col: 'vendor_id', target: 'vendors', onDelete: 'NO ACTION' }]);
      // Nothing references the new table, so a later recreate of it cascades into nothing.
      const inbound = t.raw
        .prepare(
          `SELECT m.name FROM sqlite_master m
            WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
              AND EXISTS (SELECT 1 FROM pragma_foreign_key_list(m.name) f
                           WHERE f."table" = 'product_proposals')`,
        )
        .all();
      expect(inbound).toEqual([]);

      t.raw
        .prepare(
          `INSERT INTO vendors (id, slug, company_name, created_at, updated_at) VALUES ('v1', 'v1', 'V1', ?, ?)`,
        )
        .run(NOW, NOW);
      t.raw
        .prepare(
          `INSERT INTO product_proposals (id, vendor_id, ref, payload, proposed_at, created_at, updated_at)
           VALUES ('pp1', 'v1', 'p:rec1', '{}', ?, ?, ?)`,
        )
        .run(NOW, NOW, NOW);
      expect(() => t.raw.prepare(`DELETE FROM vendors WHERE id = 'v1'`).run()).toThrow();
    } finally {
      t.dispose();
    }
  });

  it('refuses a second proposal for one ref and an unknown decision', async () => {
    const t = await makeTestDb();
    try {
      t.raw
        .prepare(
          `INSERT INTO vendors (id, slug, company_name, created_at, updated_at) VALUES ('v1', 'v1', 'V1', ?, ?)`,
        )
        .run(NOW, NOW);
      const insert = t.raw.prepare(
        `INSERT INTO product_proposals (id, vendor_id, ref, payload, proposed_at, decision, created_at, updated_at)
         VALUES (?, 'v1', ?, '{}', ?, ?, ?, ?)`,
      );
      insert.run('pp1', 'p:rec1', NOW, 'declined', NOW, NOW);
      expect(() => insert.run('pp2', 'p:rec1', NOW, null, NOW, NOW)).toThrow(
        /UNIQUE constraint failed: product_proposals\.ref/,
      );
      expect(() => insert.run('pp3', 'p:rec3', NOW, 'withdrawn', NOW, NOW)).toThrow(/CHECK/);
    } finally {
      t.dispose();
    }
  });
});
