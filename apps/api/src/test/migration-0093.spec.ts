import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration } from './d1';

/**
 * AECI-1397, PR A — `0093_absent_black_bolt.sql` is a hand-edited no-op. drizzle-kit
 * generated two `DROP COLUMN`s for `plan_interest` when `schema.ts` stopped declaring
 * it. They were replaced, because the Worker deployed before this migration still names
 * the column in every SELECT and INSERT it builds (`docs/migrations.md` §3.2). The
 * physical drop is `0094`, once this Worker is live on every tier.
 *
 * Regenerating the file brings the drops back. This spec fails if it does.
 */
const MIGRATION = '0093_absent_black_bolt.sql';

const withoutComments = (s: string) =>
  s
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim();

describe(`${MIGRATION} — a no-op until the Worker stops naming plan_interest`, () => {
  it('carries no DDL and no data change', () => {
    const statements = statementsForMigration(MIGRATION).map(withoutComments);
    expect(statements).toEqual(['SELECT 1;']);
  });

  it('leaves both plan_interest columns in place', async () => {
    const t = await makeTestDb({ upToExclusive: MIGRATION });
    try {
      for (const s of statementsForMigration(MIGRATION)) t.raw.prepare(s).run();
      for (const table of ['vendor_requests', 'listing_requests']) {
        const columns = t.raw.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{
          name: string;
        }>;
        expect(
          columns.map((c) => c.name),
          table,
        ).toContain('plan_interest');
      }
    } finally {
      t.dispose();
    }
  });
});
