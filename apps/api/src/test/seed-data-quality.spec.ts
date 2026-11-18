/**
 * The local seed chain against the scheduled data-quality checks (AECI-1788).
 *
 * Seed fixtures have gone red at cron time twice because nobody ran the job over
 * them. This spec applies the SQL files of `db:seed:local`, in its order, to the
 * in-memory D1 harness and runs `runDataQualityChecks` itself. It compares the run
 * without `connector-lists-fixtures.sql` with the run after it: the fixture may add
 * no finding at any severity. The two `grant-*` steps of the chain are node scripts
 * that need local env, so they are not applied; they touch profiles only.
 *
 * The network checks stay skipped (no Algolia, review-app or browser deps), and the
 * logo probe gets a stub that answers 200, so the run is hermetic.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runDataQualityChecks, type DataQualityCheckResult } from '../lib/data-quality';

import { makeTestDb, type TestDb } from './d1';

/** `db:seed:local` without the fixture under test, in the chain's order. */
const CHAIN = [
  'taxonomy.sql',
  'data-objects.sql',
  'trades.sql',
  'catalog.sql',
  'phase2-fixtures.sql',
  'auth-fixtures.sql',
  'connector-fixtures.sql',
  'extension-fixtures.sql',
  'review-response-fixtures.sql',
  'review-update-fixtures.sql',
  'long-list-fixtures.sql',
];
const FIXTURE = 'connector-lists-fixtures.sql';

/** Apply one multi-statement seed file, as `applySeedFile` in d1.spec.ts does. */
function apply(t: TestDb, file: string): void {
  t.raw.exec(readFileSync(join(process.cwd(), 'seed', file), 'utf8'));
}

async function run(t: TestDb): Promise<DataQualityCheckResult[]> {
  return runDataQualityChecks({
    db: t.db,
    now: new Date('2026-11-18T00:00:00.000Z'),
    fetchImpl: (async () => new Response(null, { status: 200 })) as typeof fetch,
  });
}

/** Finding count per check id, and the total per severity. */
function summarise(results: DataQualityCheckResult[]) {
  const byCheck = Object.fromEntries(results.map((r) => [r.id, r.count]));
  const bySeverity = { error: 0, warn: 0, info: 0 };
  for (const r of results) bySeverity[r.severity] += r.count;
  return { byCheck, bySeverity };
}

const FIXTURE_NAMES =
  /fixture-(hybrid-via|connector-hub|connector-lists)|Zz Fixture (Hybrid|Connector|Hub|Partner)/;

describe('seed chain: connector-lists-fixtures.sql adds no data-quality finding (AECI-1788)', () => {
  it('runs every check without an exception, and the fixture changes no count', async () => {
    const t = await makeTestDb();
    try {
      for (const file of CHAIN) apply(t, file);
      const before = await run(t);
      apply(t, FIXTURE);
      const after = await run(t);

      // A check that threw is not a clean zero.
      expect(after.filter((r) => r.error).map((r) => `${r.id}: ${r.error}`)).toEqual([]);

      const b = summarise(before);
      const a = summarise(after);
      // Logged for the PR report: the counts by severity, with and without the fixture.
      console.info('data-quality by severity', JSON.stringify({ before: b, after: a }));
      expect(a.byCheck).toEqual(b.byCheck);
      expect(a.bySeverity).toEqual(b.bySeverity);
      // And no sample line names one of the fixture's rows.
      expect(after.flatMap((r) => r.sample).filter((l) => FIXTURE_NAMES.test(l))).toEqual([]);
    } finally {
      t.dispose();
    }
  });
});
