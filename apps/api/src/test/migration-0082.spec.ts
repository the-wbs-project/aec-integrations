import { describe, expect, it } from 'vitest';

import { makeTestDb, migrationFiles, statementsForMigration } from './d1';

/**
 * AECI-1358 (E1.9) — `0082_lying_paper_doll.sql` drops `vendor_entitlements`, the
 * retired vendor-wide paid-tier row that licenses replaced
 * (`docs/VENDOR_SIGNUP_PROCESS.md` §2 decision 5). This file is the tripwire on the body.
 *
 * The migration must stay a single leaf `DROP TABLE`. In SQLite a `DROP TABLE` runs an
 * implicit DELETE that fires `ON DELETE` actions on the tables that reference the
 * dropped one, and `PRAGMA defer_foreign_keys` does not stop it (`docs/migrations.md`
 * §0). That hazard needs a child, and this table has none. The second test fails if one
 * is ever added before this migration. The table's own three FKs point outward
 * (`vendors` CASCADE, `profiles` SET NULL, `vendor_requests` NO ACTION), and the third
 * test proves dropping the child fires nothing on any of those parents.
 */
const MIGRATION = '0082_lying_paper_doll.sql';
const NOW = '2026-10-17T00:00:00.000Z';

const withoutComments = (s: string) =>
  s
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim();

describe(`${MIGRATION} — a leaf DROP TABLE`, () => {
  const statements = statementsForMigration(MIGRATION).map(withoutComments);

  it('carries exactly one DROP TABLE and nothing else', () => {
    expect(statements).toEqual(['DROP TABLE `vendor_entitlements`;']);
    for (const s of statements) {
      expect(s).not.toMatch(/__new_|CREATE|ALTER TABLE|INSERT INTO|PRAGMA/i);
    }
  });

  it('drops a table no earlier migration references, so the drop cascades nowhere', () => {
    const earlier = migrationFiles().filter((file) => file < MIGRATION);
    for (const file of earlier) {
      for (const s of statementsForMigration(file)) {
        expect(s, file).not.toMatch(/REFERENCES\s+[`"]?vendor_entitlements\b/i);
      }
    }
  });

  it('removes the table and keeps its vendor, grantor, claim and audit history', async () => {
    const t = await makeTestDb({ upToExclusive: MIGRATION });
    try {
      t.raw
        .prepare(
          `INSERT INTO vendors (id, slug, company_name, created_at, updated_at)
           VALUES ('v1', 'v', 'V', ?, ?)`,
        )
        .run(NOW, NOW);
      t.raw
        .prepare(
          `INSERT INTO profiles (id, role, created_at, updated_at)
           VALUES ('u1', 'admin', ?, ?)`,
        )
        .run(NOW, NOW);
      t.raw
        .prepare(
          `INSERT INTO vendor_requests
             (id, kind, target_type, target_id, submitter_email, body, created_at)
           VALUES ('r1', 'claim', 'vendor', 'v1', 'a@v.example', 'claim', ?)`,
        )
        .run(NOW);
      t.raw
        .prepare(
          `INSERT INTO vendor_entitlements
             (id, vendor_id, tier, status, granted_by, granted_at, source_request_id,
              created_at, updated_at)
           VALUES ('e1', 'v1', 'verified', 'active', 'u1', ?, 'r1', ?, ?)`,
        )
        .run(NOW, NOW, NOW);
      t.raw
        .prepare(
          `INSERT INTO audit_log (id, actor_type, action, entity_type, entity_id, created_at)
           VALUES ('a1', 'admin', 'vendor_entitlement.granted', 'vendor_entitlement', 'v1', ?)`,
        )
        .run(NOW);

      for (const s of statementsForMigration(MIGRATION)) t.raw.prepare(s).run();

      const table = t.raw
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get('vendor_entitlements');
      expect(table).toBeUndefined();
      const indexes = t.raw
        .prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'vendor_entitlements%'`)
        .all();
      expect(indexes).toEqual([]);
      expect(t.raw.prepare(`SELECT count(*) AS n FROM vendors`).get()).toEqual({ n: 1 });
      expect(t.raw.prepare(`SELECT count(*) AS n FROM profiles`).get()).toEqual({ n: 1 });
      expect(t.raw.prepare(`SELECT count(*) AS n FROM vendor_requests`).get()).toEqual({ n: 1 });
      expect(
        t.raw
          .prepare(`SELECT count(*) AS n FROM audit_log WHERE entity_type = 'vendor_entitlement'`)
          .get(),
      ).toEqual({ n: 1 });
    } finally {
      t.dispose();
    }
  });
});
