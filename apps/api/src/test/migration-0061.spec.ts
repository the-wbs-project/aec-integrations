import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration } from './d1';

/**
 * AECI-1183 — `0061_good_thanos.sql`, the `recrawl_submissions` search-engine
 * submission log (`DATABASE_SCHEMA.md` §9.6a). Purely additive: one CREATE TABLE
 * and three CREATE INDEXes, touching no existing table, so there is no recreate and
 * no cascade hazard (`docs/migrations.md` §0). The tripwire is on that property.
 *
 * It also pins the DDL facts the log rests on: no FK, so a retracted vendor or a
 * future recreate elsewhere cannot cascade evidence away, and the two CHECKs hold
 * the channel and outcome vocabularies.
 */
const MIGRATION = '0061_good_thanos.sql';

describe(`${MIGRATION} — additive`, () => {
  it('only creates; it alters, drops and recreates nothing', () => {
    const statements = statementsForMigration(MIGRATION);
    expect(statements).toHaveLength(4);
    expect(statements[0]).toMatch(/^CREATE TABLE `recrawl_submissions`/);
    for (const s of statements.slice(1)) {
      expect(s).toMatch(/^CREATE INDEX `recrawl_submissions_/);
    }
    for (const s of statements) {
      expect(s).not.toMatch(/DROP TABLE|ALTER TABLE|__new_|INSERT INTO|PRAGMA/i);
    }
  });

  it('has no FK, and its CHECKs refuse an unknown channel or outcome', async () => {
    const t = await makeTestDb();
    try {
      const fks = t.raw.prepare(`PRAGMA foreign_key_list('recrawl_submissions')`).all();
      expect(fks).toEqual([]);

      const insert = t.raw.prepare(
        `INSERT INTO recrawl_submissions (url, channel, outcome, http_status, batch_id, priority, submitted_at)
         VALUES (?, ?, ?, ?, 'b1', 1, '2026-10-04T00:05:00.000Z')`,
      );
      insert.run('https://x.test/a', 'indexnow', 'accepted', 200);
      insert.run('https://x.test/b', 'gsc_manual', 'requested', null);
      expect(() => insert.run('https://x.test/c', 'bing', 'accepted', 200)).toThrow(/CHECK/);
      expect(() => insert.run('https://x.test/d', 'indexnow', 'indexed', 200)).toThrow(/CHECK/);
    } finally {
      t.dispose();
    }
  });
});
