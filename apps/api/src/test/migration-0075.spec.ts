import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration } from './d1';

/**
 * AECI-1377 — `0075_legal_aqueduct.sql`, the `product_requests` table
 * (`docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7.6, `DATABASE_SCHEMA.md` §8.1b). This file
 * is the tripwire on the generated body.
 *
 * The migration must stay purely additive: one `CREATE TABLE` and its two indexes. A
 * drizzle-kit table recreate on D1 fires `ON DELETE CASCADE` on the dropped table's
 * children, and `PRAGMA defer_foreign_keys` does not stop it (`docs/migrations.md` §0).
 */
const MIGRATION = '0075_legal_aqueduct.sql';

describe(`${MIGRATION} — additive, not a recreate`, () => {
  const statements = statementsForMigration(MIGRATION).map((s) =>
    s
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .trim(),
  );

  it('carries exactly the CREATE TABLE and its two CREATE INDEX statements', () => {
    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatch(/^CREATE TABLE `product_requests`/);
    expect(statements[1]).toMatch(
      /^CREATE INDEX `product_requests_status_created_idx` ON `product_requests` \(`status`,`created_at`\)/,
    );
    expect(statements[2]).toMatch(
      /^CREATE INDEX `product_requests_vendor_created_idx` ON `product_requests` \(`vendor_id`,`created_at`\)/,
    );
    for (const s of statements) {
      expect(s).not.toMatch(/__new_/);
      expect(s).not.toMatch(/DROP TABLE/i);
      expect(s).not.toMatch(/ALTER TABLE/i);
      expect(s).not.toMatch(/INSERT INTO/i);
    }
  });

  it('has no foreign key and no CHECK, the listing_requests precedent', () => {
    expect(statements[0]).not.toMatch(/FOREIGN KEY/i);
    expect(statements[0]).not.toMatch(/CHECK/i);
  });

  it('applies on top of 0073 and leaves the table empty, with body and status defaults', async () => {
    const t = await makeTestDb();
    try {
      expect(t.raw.prepare(`SELECT count(*) AS n FROM "product_requests"`).get()).toEqual({
        n: 0,
      });
      const cols = t.raw
        .prepare(`SELECT name, "notnull", dflt_value FROM pragma_table_info('product_requests')`)
        .all() as { name: string; notnull: number; dflt_value: string | null }[];
      expect(cols.map((c) => c.name)).toEqual([
        'id',
        'vendor_id',
        'requested_by',
        'context_product_id',
        'name',
        'maker',
        'website',
        'body',
        'status',
        'resolved_product_id',
        'decline_reason',
        'created_at',
        'resolved_at',
        'resolved_by',
      ]);
      const byName = new Map(cols.map((c) => [c.name, c]));
      expect(byName.get('body')).toMatchObject({ notnull: 1, dflt_value: "''" });
      expect(byName.get('status')).toMatchObject({ notnull: 1, dflt_value: "'open'" });
      expect(byName.get('website')!.notnull).toBe(0);
    } finally {
      t.dispose();
    }
  });
});
