import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration } from './d1';

/**
 * AECI-1210 — `0057_even_stark_industries.sql`, the `vendor_activity_daily` daily
 * per-vendor snapshot (`DATABASE_SCHEMA.md` §9.12). Purely additive: one CREATE
 * TABLE and one CREATE INDEX, touching no existing table, so there is no recreate
 * and no cascade hazard (`docs/migrations.md` §0). The tripwire is on that property.
 *
 * It also pins the DDL facts the job rests on: the composite primary key is the
 * `ON CONFLICT(day, vendor_id)` target that makes a same-day rerun replace rows,
 * and the table has no FK to `vendors`, so a vendor delete or a `vendors` recreate
 * cannot cascade the history away.
 */
const MIGRATION = '0057_even_stark_industries.sql';

describe(`${MIGRATION} — additive`, () => {
  it('only creates; it alters, drops and recreates nothing', () => {
    const statements = statementsForMigration(MIGRATION);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^CREATE TABLE `vendor_activity_daily`/);
    expect(statements[1]).toMatch(/^CREATE INDEX `vendor_activity_daily_vendor_day_idx`/);
    for (const s of statements) {
      expect(s).not.toMatch(/DROP TABLE|ALTER TABLE|__new_|INSERT INTO|PRAGMA/i);
    }
  });

  it('keys on (day, vendor_id), has no FK and no CHECK', async () => {
    const t = await makeTestDb();
    try {
      const { sql } = t.raw
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get('vendor_activity_daily') as { sql: string };
      expect(sql).toMatch(/PRIMARY KEY\(`day`, `vendor_id`\)/);
      expect(sql).not.toMatch(/REFERENCES|CHECK/i);
      const fks = t.raw.prepare(`PRAGMA foreign_key_list('vendor_activity_daily')`).all();
      expect(fks).toEqual([]);
    } finally {
      t.dispose();
    }
  });
});
