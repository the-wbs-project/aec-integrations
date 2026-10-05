import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration } from './d1';

/**
 * AECI-1184 — `0062_youthful_sauron.sql`, the two cause tables
 * (`DATABASE_SCHEMA.md` §9.6b): the transient `recrawl_queue_causes` and the
 * permanent `recrawl_submission_causes`. Purely additive: two CREATE TABLEs and
 * three CREATE INDEXes, touching no existing table, so there is no recreate and no
 * cascade hazard (`docs/migrations.md` §0). The tripwire is on that property.
 *
 * It also pins the DDL facts the linkage rests on: no FK on either table, so a
 * retracted vendor cannot cascade evidence away, and the transient table's two
 * CHECKs hold the channel and source vocabularies.
 */
const MIGRATION = '0062_youthful_sauron.sql';

describe(`${MIGRATION} — additive`, () => {
  it('only creates; it alters, drops and recreates nothing', () => {
    const statements = statementsForMigration(MIGRATION);
    expect(statements).toHaveLength(5);
    expect(statements[0]).toMatch(/^CREATE TABLE `recrawl_queue_causes`/);
    expect(statements[1]).toMatch(/^CREATE INDEX `recrawl_queue_causes_channel_url_idx`/);
    expect(statements[2]).toMatch(/^CREATE TABLE `recrawl_submission_causes`/);
    for (const s of statements.slice(3)) {
      expect(s).toMatch(/^CREATE INDEX `recrawl_submission_causes_/);
    }
    for (const s of statements) {
      expect(s).not.toMatch(/DROP TABLE|ALTER TABLE|__new_|INSERT INTO|PRAGMA|REFERENCES/i);
    }
  });

  it('has no FK on either table, and the queue-cause CHECKs refuse unknown values', async () => {
    const t = await makeTestDb();
    try {
      for (const table of ['recrawl_queue_causes', 'recrawl_submission_causes']) {
        expect(t.raw.prepare(`PRAGMA foreign_key_list('${table}')`).all()).toEqual([]);
      }

      const insert = t.raw.prepare(
        `INSERT INTO recrawl_queue_causes (channel, url, source, queued_at)
         VALUES (?, 'https://x.test/a', ?, '2026-10-04T00:00:00.000Z')`,
      );
      insert.run('indexnow', 'vendor');
      insert.run('gsc', 'promote');
      insert.run('gsc', 'admin');
      expect(() => insert.run('gsc_manual', 'vendor')).toThrow(/CHECK/);
      expect(() => insert.run('indexnow', 'cron')).toThrow(/CHECK/);

      // The permanent table points at a submission id that need not exist.
      t.raw
        .prepare(
          `INSERT INTO recrawl_submission_causes (submission_id, source, queued_at)
           VALUES (999, 'vendor', '2026-10-04T00:00:00.000Z')`,
        )
        .run();
    } finally {
      t.dispose();
    }
  });
});
