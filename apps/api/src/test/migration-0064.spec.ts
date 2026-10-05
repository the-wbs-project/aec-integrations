import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration, type TestDb } from './d1';

/**
 * AECI-1236 — `0064_robust_hawkeye.sql`, the URL Inspection columns on
 * `gsc_recrawl_queue` (`DATABASE_SCHEMA.md` §9.8).
 *
 * `gsc_recrawl_queue` has no children, so a recreate would not cascade. It would
 * still drop and copy every queued row, which is work nobody can re-derive
 * (ADR 0031 §3). So:
 *
 *   1. The file is five nullable `ADD COLUMN`s, one index and one backfill
 *      `UPDATE`. No recreate, no CHECK.
 *   2. Applied to a seeded pre-0064 table, every row survives.
 *   3. `last_changed_at` is backfilled with the migration's run time, NOT
 *      `queued_at`: a row re-enqueued before 0064 kept its first `queued_at`,
 *      which can predate the real last change, and backfilling from it would
 *      let the first run close a row whose latest edit Google never saw. The
 *      inspection columns start NULL ("never inspected").
 */
const MIGRATION = '0064_robust_hawkeye.sql';

const strip = (stmt: string) =>
  stmt
    .split('\n')
    .filter((line) => !line.startsWith('--'))
    .join('\n')
    .trim();

async function seedPreMigration(): Promise<TestDb> {
  const t = await makeTestDb({ upToExclusive: MIGRATION });
  const insert = t.raw.prepare(
    `INSERT INTO gsc_recrawl_queue (url, priority, reason, source, queued_at) VALUES (?, ?, ?, ?, ?)`,
  );
  insert.run(
    'https://www.aecintegrations.com/products/a',
    1,
    'product.created',
    'promote',
    '2026-09-20T00:00:00.000Z',
  );
  insert.run(
    'https://www.aecintegrations.com/vendors/b',
    3,
    'vendor.updated',
    'vendor',
    '2026-09-21T00:00:00.000Z',
  );
  return t;
}

describe(`${MIGRATION} — additive`, () => {
  it('is ADD COLUMNs, one index and one backfill UPDATE, and nothing destructive', () => {
    const statements = statementsForMigration(MIGRATION).map(strip);
    const adds = statements.filter((s) =>
      /^ALTER TABLE `gsc_recrawl_queue` ADD `\w+` text;?$/.test(s),
    );
    expect(adds).toHaveLength(5);
    expect(statements.filter((s) => s.startsWith('CREATE INDEX'))).toHaveLength(1);
    expect(statements.filter((s) => s.startsWith('UPDATE'))).toHaveLength(1);
    expect(statements).toHaveLength(7);
    expect(statements.join('\n')).not.toMatch(
      /DROP TABLE|CREATE TABLE|__new_|INSERT INTO|RENAME|CHECK/i,
    );
  });

  it('keeps every row, backfills last_changed_at with the run time (not queued_at), and starts inspection columns NULL', async () => {
    const t = await seedPreMigration();
    try {
      const before = Date.now();
      t.applyMigration(MIGRATION);
      const rows = t.raw
        .prepare(
          `SELECT queued_at, last_changed_at, inspected_at, last_crawl_at, coverage_state, inspect_reason
             FROM gsc_recrawl_queue ORDER BY id`,
        )
        .all() as Record<string, string | null>[];
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.last_changed_at).not.toBe(row.queued_at);
        expect(row.last_changed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(Date.parse(row.last_changed_at!)).toBeGreaterThanOrEqual(before - 1_000);
        expect(row.inspected_at).toBeNull();
        expect(row.last_crawl_at).toBeNull();
        expect(row.coverage_state).toBeNull();
        expect(row.inspect_reason).toBeNull();
      }
    } finally {
      t.dispose();
    }
  });
});
