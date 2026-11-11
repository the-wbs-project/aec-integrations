import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration } from './d1';

/**
 * AECI-534, PR A — `0110_acoustic_mastermind.sql` is a hand-edited no-op. drizzle-kit
 * generated a `DROP COLUMN` for `products.has_api_docs` when `schema.ts` stopped
 * declaring it. It was replaced, because the Worker deployed before this migration still
 * names the column in every SELECT and INSERT it builds (`docs/migrations.md` §3.2). The
 * physical drop is PR B, `0117_drop_has_api_docs.sql`.
 *
 * Regenerating the file brings the drop back. This spec fails if it does.
 */
const MIGRATION = '0110_acoustic_mastermind.sql';

const withoutComments = (s: string) =>
  s
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim();

describe(`${MIGRATION} — a no-op until the Worker stops naming has_api_docs`, () => {
  it('carries no DDL and no data change', () => {
    const statements = statementsForMigration(MIGRATION).map(withoutComments);
    expect(statements).toEqual(['SELECT 1;']);
  });

  it('leaves products.has_api_docs in place', async () => {
    const t = await makeTestDb({ upToExclusive: MIGRATION });
    try {
      for (const s of statementsForMigration(MIGRATION)) t.raw.prepare(s).run();
      const columns = t.raw
        .prepare(`SELECT name FROM pragma_table_info('products')`)
        .all() as Array<{ name: string }>;
      expect(columns.map((c) => c.name)).toContain('has_api_docs');
    } finally {
      t.dispose();
    }
  });
});
