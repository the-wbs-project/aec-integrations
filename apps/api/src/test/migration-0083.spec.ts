import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration } from './d1';

/**
 * AECI-1415 (E6b.3) — `0083_moaning_betty_brant.sql` adds `vendors.owned_at` (record
 * ownership, ADR 0042) and backfills it from the seat-based "claimed" definition it
 * replaces. This file is the tripwire on the body.
 *
 * The migration must stay a plain ADD COLUMN plus one UPDATE. A drizzle-kit table
 * recreate on `vendors` would fire `ON DELETE CASCADE` on every child of `vendors`
 * (`docs/migrations.md` §0), so the first test fails on any recreate shape.
 */
const MIGRATION = '0083_moaning_betty_brant.sql';
const NOW = '2026-10-19T00:00:00.000Z';

const withoutComments = (s: string) =>
  s
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim();

describe(`${MIGRATION} — vendors.owned_at`, () => {
  const statements = statementsForMigration(MIGRATION).map(withoutComments);

  it('is one ADD COLUMN and one UPDATE, and no table recreate', () => {
    expect(statements).toHaveLength(2);
    expect(statements[0]).toBe('ALTER TABLE `vendors` ADD `owned_at` text;');
    expect(statements[1]).toMatch(/^UPDATE `vendors`/);
    for (const s of statements) {
      expect(s).not.toMatch(/__new_|CREATE TABLE|DROP TABLE|INSERT INTO|PRAGMA/i);
    }
  });

  it('backfills every vendor with a vendor_admin seat, banned or not, from the earliest grant row', async () => {
    const t = await makeTestDb({ upToExclusive: MIGRATION });
    try {
      const vendor = t.raw.prepare(
        `INSERT INTO vendors (id, slug, company_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const id of ['granted', 'legacy', 'nogrant', 'banned', 'reviewer', 'none']) {
        vendor.run(id, id, id, NOW, NOW);
      }
      const seat = t.raw.prepare(
        `INSERT INTO profiles (id, role, vendor_id, banned_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      seat.run('s1', 'vendor_admin', 'granted', null, NOW, NOW);
      seat.run('s2', 'vendor_admin', 'legacy', null, NOW, NOW);
      seat.run('s3', 'vendor_admin', 'nogrant', null, NOW, NOW);
      seat.run('s4', 'vendor_admin', 'banned', NOW, NOW, NOW);
      seat.run('s5', 'reviewer', 'reviewer', null, NOW, NOW);
      const audit = t.raw.prepare(
        `INSERT INTO audit_log (id, actor_type, action, vendor_id, metadata, created_at) VALUES (?, 'admin', ?, ?, ?, ?)`,
      );
      // Two grants on `granted`: the earlier one wins.
      audit.run('a1', 'vendor_claim.granted', 'granted', null, '2026-09-02T00:00:00.000Z');
      audit.run('a2', 'vendor_seat.invite_accepted', 'granted', null, '2026-09-01T00:00:00.000Z');
      // A pre-AECI-1192 row: no `vendor_id` column, the vendor in metadata.
      audit.run(
        'a3',
        'vendor_seat.provisioned',
        null,
        JSON.stringify({ vendor_id: 'legacy' }),
        '2026-08-01T00:00:00.000Z',
      );
      // Not a grant, so it does not count.
      audit.run('a4', 'vendor_claim.seat_revoked', 'nogrant', null, '2026-07-01T00:00:00.000Z');
      // The banned vendor's only seat was granted before the ban (ruled 2026-10-19).
      audit.run('a5', 'vendor_claim.granted', 'banned', null, '2026-06-01T00:00:00.000Z');

      for (const s of statementsForMigration(MIGRATION)) t.raw.prepare(s).run();

      const owned = Object.fromEntries(
        (
          t.raw.prepare(`SELECT id, owned_at FROM vendors ORDER BY id`).all() as Array<{
            id: string;
            owned_at: string | null;
          }>
        ).map((r) => [r.id, r.owned_at]),
      );
      expect(owned.granted).toBe('2026-09-01T00:00:00.000Z');
      expect(owned.legacy).toBe('2026-08-01T00:00:00.000Z');
      // A seat with no grant row: stamped at migration time.
      expect(owned.nogrant).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(owned.nogrant).not.toBe('2026-07-01T00:00:00.000Z');
      // A ban never moves ownership (Q1), so a banned-only vendor is owned too.
      expect(owned.banned).toBe('2026-06-01T00:00:00.000Z');
      expect(owned.reviewer).toBeNull();
      expect(owned.none).toBeNull();
    } finally {
      t.dispose();
    }
  });
});
