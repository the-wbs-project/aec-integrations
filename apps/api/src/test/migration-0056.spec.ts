import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration } from './d1';

/**
 * AECI-1208 — `0056_hard_moondragon.sql`, the `user_activity_daily` per-user service
 * log (`DATABASE_SCHEMA.md` §9.11). Purely additive: one CREATE TABLE and two CREATE
 * INDEXes, touching no existing table, so there is no recreate and no cascade hazard
 * (`docs/migrations.md` §0). The tripwire is on that property.
 *
 * It also pins the DDL facts the writers rest on: the composite primary key is the
 * `ON CONFLICT(user_id, day)` target, and the table has no FK to `profiles`, so a
 * future `profiles` recreate cannot cascade into it and erasure stays explicit.
 */
const MIGRATION = '0056_hard_moondragon.sql';

describe(`${MIGRATION} — additive`, () => {
  it('only creates; it alters, drops and recreates nothing', () => {
    const statements = statementsForMigration(MIGRATION);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatch(/^CREATE TABLE `user_activity_daily`/);
    for (const s of statements.slice(1)) {
      expect(s).toMatch(/^CREATE INDEX `user_activity_daily_/);
    }
    for (const s of statements) {
      expect(s).not.toMatch(/DROP TABLE|ALTER TABLE|__new_|INSERT INTO|PRAGMA/i);
    }
  });

  it('keys on (user_id, day), has no FK and no CHECK', async () => {
    const t = await makeTestDb();
    try {
      const { sql } = t.raw
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get('user_activity_daily') as { sql: string };
      expect(sql).toMatch(/PRIMARY KEY\(`user_id`, `day`\)/);
      expect(sql).not.toMatch(/REFERENCES|CHECK/i);
      const fks = t.raw.prepare(`PRAGMA foreign_key_list('user_activity_daily')`).all();
      expect(fks).toEqual([]);
    } finally {
      t.dispose();
    }
  });
});
