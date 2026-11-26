import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { crawledPathsQuery } from '../lib/seo-queue';
import { makeTestDb, statementsForMigration, type TestDb } from './d1';

/**
 * AECI-818 — `0130_crawl_path_index.sql` adds the partial covering index
 * `page_views_crawl_path_idx` behind the search console's crawled-path read.
 *
 * Two tripwires. The body must stay ONE `CREATE INDEX`: `page_views` is the hottest
 * table in the app, and a drizzle-kit recreate (`__new_page_views`) would copy every
 * row through a `DROP TABLE` that fires ON DELETE CASCADE (`docs/migrations.md` §0).
 * And the read must actually use the index. A partial index is chosen only when the
 * query's WHERE implies the index's WHERE, so a refactor that binds `is_bot = ?` or
 * drops `concrete_path IS NOT NULL` would silently fall back to a range scan of
 * every bot row on `page_views_bot_idx`.
 */
const MIGRATION = '0130_crawl_path_index.sql';

const withoutComments = (s: string) =>
  s
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim();

describe(`${MIGRATION} — one partial CREATE INDEX`, () => {
  it('carries exactly the one CREATE INDEX and nothing else', () => {
    const statements = statementsForMigration(MIGRATION).map(withoutComments);
    expect(statements).toEqual([
      'CREATE INDEX `page_views_crawl_path_idx` ON `page_views` (`bot_name`,`concrete_path`,`created_at`,`cf_verified_bot_category`) WHERE "is_bot" = 1 AND "concrete_path" IS NOT NULL;',
    ]);
    expect(statements[0]).not.toMatch(/__new_|DROP|INSERT INTO|PRAGMA|ALTER/i);
  });
});

describe('the crawled-path read uses page_views_crawl_path_idx', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await makeTestDb();
  });
  afterEach(() => t.dispose());

  const plan = (toIso: string): string => {
    const { sql, params } = crawledPathsQuery(t.db, toIso).toSQL();
    const rows = t.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[];
    return rows.map((r) => r.detail).join('\n');
  };

  it('on a queue request, whose window ends now', () => {
    const detail = plan('2026-11-24T12:00:00.000Z');
    expect(detail).toMatch(/USING COVERING INDEX page_views_crawl_path_idx/);
    expect(detail).not.toMatch(/page_views_bot_idx/);
  });

  it('on the 00:15 snapshot, whose window ends at the end of the filed day', () => {
    const detail = plan('2026-11-24T00:00:00.000Z');
    expect(detail).toMatch(/USING COVERING INDEX page_views_crawl_path_idx/);
    expect(detail).not.toMatch(/page_views_bot_idx/);
  });
});
