import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration } from './d1';

/**
 * AECI-1362 — `0074_clumsy_justice.sql`, the `agreement_acceptances` table (E2.4,
 * `docs/VENDOR_SIGNUP_PROCESS.md` §4). This file is the tripwire on the generated body.
 *
 * The migration must stay purely additive: one `CREATE TABLE` and its indexes. A
 * drizzle-kit table recreate on D1 fires `ON DELETE CASCADE` on the dropped table's
 * children, and `PRAGMA defer_foreign_keys` does not stop it (`docs/migrations.md` §0).
 * If a later schema edit makes drizzle-kit regenerate this file as a recreate of an
 * existing table, the assertions below fail in that PR.
 */
const MIGRATION = '0074_clumsy_justice.sql';

describe(`${MIGRATION} — additive, not a recreate`, () => {
  const statements = statementsForMigration(MIGRATION).map((s) =>
    s
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .trim(),
  );

  it('carries only CREATE TABLE / CREATE INDEX for the new table', () => {
    expect(statements).toHaveLength(4);
    for (const s of statements) {
      expect(s).toMatch(/^CREATE (TABLE|(UNIQUE )?INDEX `[a-z_]+` ON) `agreement_acceptances`/);
      expect(s).not.toMatch(/__new_/);
      expect(s).not.toMatch(/DROP TABLE/i);
      expect(s).not.toMatch(/ALTER TABLE/i);
      expect(s).not.toMatch(/INSERT INTO/i);
      expect(s).not.toMatch(/CHECK/);
    }
  });

  it('applies on top of 0073 and leaves the table empty', async () => {
    const t = await makeTestDb();
    try {
      expect(t.raw.prepare(`SELECT count(*) AS n FROM "agreement_acceptances"`).get()).toEqual({
        n: 0,
      });
    } finally {
      t.dispose();
    }
  });

  // 0077 (AECI-1366) adds the third, listing_request_id; this reads the migrated schema.
  it('wires its foreign keys, and none to profiles or vendors', async () => {
    const t = await makeTestDb();
    try {
      const fks = t.raw
        .prepare(
          `SELECT f."from" AS col, f."table" AS target, f.on_delete
             FROM pragma_foreign_key_list('agreement_acceptances') f
            ORDER BY f."from"`,
        )
        .all();
      expect(fks).toEqual([
        { col: 'billing_account_id', target: 'billing_accounts', on_delete: 'NO ACTION' },
        { col: 'listing_request_id', target: 'listing_requests', on_delete: 'SET NULL' },
        { col: 'vendor_request_id', target: 'vendor_requests', on_delete: 'SET NULL' },
      ]);
    } finally {
      t.dispose();
    }
  });

  it('makes the Stripe session id unique only when present', async () => {
    const t = await makeTestDb();
    try {
      const insert = t.raw.prepare(
        `INSERT INTO agreement_acceptances
           (id, document, version, source, email, stripe_checkout_session_id, accepted_at, created_at)
         VALUES (?, 'managed_plan', '1.0', 'checkout', 'a@b.co', ?, '2026-10-15', '2026-10-15')`,
      );
      insert.run('a', null);
      insert.run('b', null);
      insert.run('c', 'cs_1');
      expect(() => insert.run('d', 'cs_1')).toThrow(/UNIQUE/);
    } finally {
      t.dispose();
    }
  });
});
