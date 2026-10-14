import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration } from './d1';

/**
 * AECI-1350 — `0073_brown_moon_knight.sql`, the `billing_accounts` and `licenses`
 * tables (E1.1, `docs/VENDOR_SIGNUP_PROCESS.md` §5). This file is the tripwire on the
 * generated body.
 *
 * The migration must stay purely additive: two `CREATE TABLE`s and their indexes. A
 * drizzle-kit table recreate on D1 fires `ON DELETE CASCADE` on the dropped table's
 * children, and `PRAGMA defer_foreign_keys` does not stop it (`docs/migrations.md` §0).
 * If a later schema edit makes drizzle-kit regenerate this file as a recreate of an
 * existing table, the assertions below fail in that PR.
 */
const MIGRATION = '0073_brown_moon_knight.sql';

describe(`${MIGRATION} — additive, not a recreate`, () => {
  const statements = statementsForMigration(MIGRATION).map((s) =>
    s
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .trim(),
  );

  it('carries only CREATE TABLE / CREATE INDEX for the two new tables', () => {
    expect(statements).toHaveLength(8);
    for (const s of statements) {
      expect(s).toMatch(
        /^CREATE (TABLE|(UNIQUE )?INDEX `[a-z_]+` ON) `(billing_accounts|licenses)`/,
      );
      expect(s).not.toMatch(/__new_/);
      expect(s).not.toMatch(/DROP TABLE/i);
      expect(s).not.toMatch(/ALTER TABLE/i);
      expect(s).not.toMatch(/INSERT INTO/i);
    }
  });

  it('applies on top of 0072 and leaves both tables empty', async () => {
    const t = await makeTestDb();
    try {
      for (const table of ['billing_accounts', 'licenses']) {
        expect(t.raw.prepare(`SELECT count(*) AS n FROM "${table}"`).get()).toEqual({ n: 0 });
      }
    } finally {
      t.dispose();
    }
  });

  it('wires the three foreign keys with the actions the issue specifies', async () => {
    const t = await makeTestDb();
    try {
      const fks = t.raw
        .prepare(
          `SELECT m.name, f."from" AS col, f."table" AS target, f.on_delete
             FROM sqlite_master m, pragma_foreign_key_list(m.name) f
            WHERE m.type = 'table' AND m.name IN ('billing_accounts', 'licenses')
            ORDER BY m.name, f."from"`,
        )
        .all();
      expect(fks).toEqual([
        { name: 'billing_accounts', col: 'vendor_id', target: 'vendors', on_delete: 'NO ACTION' },
        {
          name: 'licenses',
          col: 'assigned_product_id',
          target: 'products',
          on_delete: 'SET NULL',
        },
        {
          name: 'licenses',
          col: 'billing_account_id',
          target: 'billing_accounts',
          on_delete: 'NO ACTION',
        },
      ]);
    } finally {
      t.dispose();
    }
  });
});
