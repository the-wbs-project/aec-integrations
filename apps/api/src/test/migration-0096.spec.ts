import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration } from './d1';

/**
 * AECI-1258, PR A — `0096_motionless_captain_cross.sql` is a hand-edited no-op.
 * drizzle-kit generated a `DROP COLUMN` for `reviews.verified_work_email` when
 * `schema.ts` stopped declaring it. It was replaced, because the Worker deployed before
 * this migration still names the column in every SELECT and INSERT it builds
 * (`docs/migrations.md` §3.2). The physical drop is `0097` (AECI-1533), once this Worker
 * is live on every tier.
 *
 * Regenerating the file brings the drop back. This spec fails if it does.
 */
const MIGRATION = '0096_motionless_captain_cross.sql';

const withoutComments = (s: string) =>
  s
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim();

describe(`${MIGRATION} — a no-op until the Worker stops naming verified_work_email`, () => {
  it('carries no DDL and no data change', () => {
    const statements = statementsForMigration(MIGRATION).map(withoutComments);
    expect(statements).toEqual(['SELECT 1;']);
  });

  it('leaves reviews.verified_work_email in place', async () => {
    const t = await makeTestDb({ upToExclusive: MIGRATION });
    try {
      for (const s of statementsForMigration(MIGRATION)) t.raw.prepare(s).run();
      const columns = t.raw
        .prepare(`SELECT name FROM pragma_table_info(?)`)
        .all('reviews') as Array<{
        name: string;
      }>;
      expect(columns.map((c) => c.name)).toContain('verified_work_email');
    } finally {
      t.dispose();
    }
  });
});
