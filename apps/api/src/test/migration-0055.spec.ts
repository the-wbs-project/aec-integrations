import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration } from './d1';

/**
 * AECI-1204 — `0055_boring_hardball.sql`, the `notification_preferences` table
 * (`DATABASE_SCHEMA.md` §9.10). Purely additive: one CREATE TABLE and one CREATE
 * UNIQUE INDEX. It touches no existing table, so `profiles` is not recreated and
 * nothing cascades (`docs/migrations.md` §0). The tripwire is on that property.
 */
const MIGRATION = '0055_boring_hardball.sql';

describe(`${MIGRATION} — additive`, () => {
  it('only creates; it alters, drops and recreates nothing', () => {
    const statements = statementsForMigration(MIGRATION);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^CREATE TABLE `notification_preferences`/);
    expect(statements[1]).toMatch(/^CREATE UNIQUE INDEX `notification_preferences_mute_token_key`/);
    for (const s of statements) {
      expect(s).not.toMatch(/DROP TABLE|ALTER TABLE|__new_|INSERT INTO|PRAGMA/i);
    }
  });

  it('cascades from profiles, so a deleted seat leaves no orphan token', async () => {
    const t = await makeTestDb();
    try {
      t.raw
        .prepare(
          `INSERT INTO profiles (id, role, created_at, updated_at) VALUES ('p1', 'reviewer', 'x', 'x')`,
        )
        .run();
      t.raw
        .prepare(
          `INSERT INTO notification_preferences (profile_id, mute_token, created_at, updated_at) VALUES ('p1', 'tok', 'x', 'x')`,
        )
        .run();
      t.raw.prepare(`DELETE FROM profiles WHERE id = 'p1'`).run();
      const row = t.raw.prepare(`SELECT COUNT(*) AS n FROM notification_preferences`).get() as {
        n: number;
      };
      expect(row.n).toBe(0);
    } finally {
      t.dispose();
    }
  });
});
