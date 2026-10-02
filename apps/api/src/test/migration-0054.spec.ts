import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration } from './d1';

/**
 * AECI-1202 — `0054_smooth_black_panther.sql`, the `notification_sends` send ledger
 * (`DATABASE_SCHEMA.md` §9.9). Purely additive: one CREATE TABLE and three CREATE
 * INDEXes, touching no existing table, so there is no recreate and no cascade hazard
 * (`docs/migrations.md` §0). The tripwire is on that property.
 *
 * It also pins the two DDL facts the ledger's semantics rest on: `outcome` has no
 * CHECK (the vocabulary grows without a recreate), and the dedupe index is UNIQUE and
 * NOT partial, because `ON CONFLICT(dedupe_key)` needs a non-partial conflict target.
 */
const MIGRATION = '0054_smooth_black_panther.sql';

describe(`${MIGRATION} — additive`, () => {
  it('only creates; it alters, drops and recreates nothing', () => {
    const statements = statementsForMigration(MIGRATION);
    expect(statements).toHaveLength(4);
    expect(statements[0]).toMatch(/^CREATE TABLE `notification_sends`/);
    for (const s of statements.slice(1)) {
      expect(s).toMatch(/^CREATE (UNIQUE )?INDEX `notification_sends_/);
    }
    for (const s of statements) {
      expect(s).not.toMatch(/DROP TABLE|ALTER TABLE|__new_|INSERT INTO|PRAGMA/i);
    }
  });

  it('has no CHECK on outcome, and a non-partial UNIQUE dedupe index', async () => {
    const t = await makeTestDb();
    try {
      const sql = (type: string, name: string) =>
        (
          t.raw
            .prepare(`SELECT sql FROM sqlite_master WHERE type = ? AND name = ?`)
            .get(type, name) as { sql: string }
        ).sql;
      expect(sql('table', 'notification_sends')).not.toMatch(/CHECK/i);
      const index = sql('index', 'notification_sends_dedupe_key_idx');
      expect(index).toMatch(/^CREATE UNIQUE INDEX/);
      expect(index).not.toMatch(/WHERE/i);
    } finally {
      t.dispose();
    }
  });
});
