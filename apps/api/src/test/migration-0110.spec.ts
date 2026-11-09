import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration } from './d1';

/**
 * AECI-533, phase one: `0110_daily_giant_girl.sql` is a hand-edited no-op. drizzle-kit
 * generated sixteen `DROP COLUMN`s when `schema.ts` stopped declaring the review app's
 * curation columns on `products` and `vendors`. They were replaced, because the Worker
 * deployed before this migration still names every one of them in each SELECT and INSERT
 * it builds (`docs/migrations.md` §3.2). The physical drop is AECI-1660, once this Worker
 * is live on every tier.
 *
 * Regenerating the file brings the drops back. This spec fails if it does.
 */
const MIGRATION = '0110_daily_giant_girl.sql';

const KEPT: Record<'products' | 'vendors', readonly string[]> = {
  products: [
    'tool_integration_check_notes',
    'research_notes',
    'priority_score',
    'score_computed_at',
    'search_volume_monthly',
    'search_checked_at',
    'reddit_mentions_24mo',
    'reddit_checked_at',
    'admin_notes',
    // Never in scope: each has a CHECK or an index, so a drop would be a recreate.
    'research_status',
    'priority_tier',
    'google_trends_index',
  ],
  vendors: [
    'source_url',
    'admin_notes',
    'vqs_credibility',
    'vqs_momentum',
    'vqs_fit',
    'vqs_total',
    'vqs_computed_at',
  ],
};

const withoutComments = (s: string) =>
  s
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim();

describe(`${MIGRATION} — a no-op until the Worker stops naming the curation columns`, () => {
  it('carries no DDL and no data change', () => {
    const statements = statementsForMigration(MIGRATION).map(withoutComments);
    expect(statements).toEqual(['SELECT 1;']);
  });

  it('leaves every undeclared column in place, and rebuilds neither table', async () => {
    const t = await makeTestDb({ upToExclusive: MIGRATION });
    try {
      const sqlBefore = (table: string) =>
        (
          t.raw
            .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
            .get(table) as {
            sql: string;
          }
        ).sql;
      const before = { products: sqlBefore('products'), vendors: sqlBefore('vendors') };

      for (const s of statementsForMigration(MIGRATION)) t.raw.prepare(s).run();

      for (const table of ['products', 'vendors'] as const) {
        const columns = t.raw.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{
          name: string;
        }>;
        const names = columns.map((c) => c.name);
        for (const column of KEPT[table]) expect(names, `${table}.${column}`).toContain(column);
        expect(sqlBefore(table), table).toBe(before[table]);
      }
    } finally {
      t.dispose();
    }
  });
});
