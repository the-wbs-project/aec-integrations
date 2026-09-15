import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration } from './d1';

/**
 * AECI-978 — `0039_late_mysterio.sql` carries DATA, and this file is what notices
 * if a regeneration takes it away.
 *
 * The migration creates `slug_redirects` and seeds the two production rows the
 * issue exists for. drizzle-kit writes only the `CREATE TABLE`; the two INSERTs are
 * hand-added. A regeneration therefore produces a file that applies perfectly
 * cleanly, passes every other test, and leaves both redirects dead — which is the
 * exact failure mode `docs/migrations.md` §3.3a warns about, minus the abort that
 * usually makes it loud. There is no constraint violation to trip here, so the
 * assertion below is the whole tripwire.
 *
 * Unlike the 0027/0033/0034 migration specs this one does NOT test a destructive
 * recreate, because there isn't one: the table is new, has no cascade children, and
 * the file is additive end to end.
 */
const MIGRATION = '0039_late_mysterio.sql';

describe(`${MIGRATION} — the seeded redirects`, () => {
  it('seeds both production rows', async () => {
    const t = await makeTestDb();
    try {
      const rows = t.raw
        .prepare('SELECT entity, from_slug, to_slug FROM slug_redirects ORDER BY entity, from_slug')
        .all();
      expect(rows).toEqual([
        {
          entity: 'product',
          from_slug: 'autodesk-construction-cloud',
          to_slug: 'autodesk-forma',
        },
        { entity: 'vendor', from_slug: 'bluebeam', to_slug: 'nemetschek-group' },
      ]);
    } finally {
      t.dispose();
    }
  });

  it('still carries its INSERT statements in the committed file', async () => {
    // Asserted on the FILE, not only on the applied result, so the failure names
    // the cause. A regenerated file loses these two statements silently.
    const statements = statementsForMigration(MIGRATION);
    const inserts = statements.filter((s) => /INSERT INTO `slug_redirects`/.test(s));
    expect(inserts).toHaveLength(2);
  });
});
