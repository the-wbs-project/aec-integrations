/**
 * `scripts/ops/2026-10-pair-page-view-backfill/` (AECI-929 / `ADMIN_PANEL_SPEC.md`
 * §7.3, §13 D25) against the in-memory D1 harness, migrated through 0067.
 *
 * The backfill re-derives the pair columns for rows written before ingest did. It
 * has to agree with ingest exactly, or a backfilled row and a live row for the same
 * view would attribute differently. So these specs hold it to ingest's rules:
 * `parsePairPagePath`'s shape, `canonicalPairIds`' order, NULL for a slug that does
 * not resolve, and nothing else touched. Plus the two properties only a backfill
 * needs: a re-run changes nothing, and the dry-run projection counts exactly the
 * rows the write changes.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalPairIds, parsePairPagePath } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pageViews, products } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';

const DIR = join(process.cwd(), '../../scripts/ops/2026-10-pair-page-view-backfill');
const strip = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.startsWith('--'))
    .join('\n');
const BACKFILL_SQL = strip(readFileSync(join(DIR, 'backfill.sql'), 'utf8'));
const PROJECTION_SQL = strip(readFileSync(join(DIR, 'projection.sql'), 'utf8'));

// Ids chosen so slug order and id order DISAGREE: 'zeta' has the lowest id.
const ZETA = '00000000-0000-4000-8000-000000000001';
const ALPHA = '00000000-0000-4000-8000-000000000002';
const PAIR_ROUTE = '/products/:contextSlug/integrations/:otherSlug';
const AT = '2026-09-01T00:00:00.000Z';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(products).values([
    { id: ZETA, slug: 'zeta', name: 'Zeta', promotionStatus: 'promoted' },
    { id: ALPHA, slug: 'alpha', name: 'Alpha', promotionStatus: 'promoted' },
  ]);
});
afterEach(() => t.dispose());

type Projection = {
  candidates: number;
  resolved_both: number;
  resolved_one: number;
  unresolved: number;
  first_created_at: string | null;
  last_created_at: string | null;
};

const project = () => t.raw.prepare(PROJECTION_SQL).get() as Projection;
const runBackfill = () => t.raw.prepare(BACKFILL_SQL).run().changes;

async function seed(
  concretePath: string | null,
  extra: Partial<typeof pageViews.$inferInsert> = {},
) {
  await t.db.insert(pageViews).values({ path: PAIR_ROUTE, concretePath, createdAt: AT, ...extra });
}

async function pairOf(concretePath: string) {
  const rows = await t.db.select().from(pageViews);
  const row = rows.find((r) => r.concretePath === concretePath)!;
  return [row.pairProductAId, row.pairProductBId];
}

describe('2026-10-pair-page-view-backfill', () => {
  it('shares one parse between the write and the dry-run projection', () => {
    const backfillCte = BACKFILL_SQL.slice(0, BACKFILL_SQL.indexOf('\nUPDATE '));
    expect(backfillCte.startsWith('WITH split AS (')).toBe(true);
    expect(backfillCte).toContain('resolved AS (');
    expect(PROJECTION_SQL.startsWith(`${backfillCte}\nSELECT `)).toBe(true);
  });

  it('attributes both orientations to the same canonical pair, lower id first', async () => {
    await seed('/products/zeta/integrations/alpha');
    await seed('/products/alpha/integrations/zeta');
    expect(runBackfill()).toBe(2);
    expect(await pairOf('/products/zeta/integrations/alpha')).toEqual([ZETA, ALPHA]);
    expect(await pairOf('/products/alpha/integrations/zeta')).toEqual([ZETA, ALPHA]);
  });

  it('agrees with ingest: the same parser and the same order, row for row', async () => {
    const paths = [
      '/products/zeta/integrations/alpha',
      '/products/alpha/integrations/zeta',
      '/products/ghost/integrations/alpha',
      '/products/zeta/integrations/zeta',
      '/products/zeta/integrations/alpha/',
      '/products/zeta/integrations/alpha/extra',
      '/products/zeta',
    ];
    for (const p of paths) await seed(p);
    runBackfill();
    const idBySlug = new Map([
      ['zeta', ZETA],
      ['alpha', ALPHA],
    ]);
    for (const p of paths) {
      const parsed = parsePairPagePath(p);
      const expected = parsed
        ? canonicalPairIds(idBySlug.get(parsed.a) ?? null, idBySlug.get(parsed.b) ?? null)
        : [null, null];
      expect(await pairOf(p), p).toEqual(expected);
    }
  });

  it('stores NULL for a slug that no longer resolves, and the resolved side in A', async () => {
    await seed('/products/ghost/integrations/alpha');
    await seed('/products/ghost/integrations/phantom');
    expect(project()).toMatchObject({
      candidates: 2,
      resolved_both: 0,
      resolved_one: 1,
      unresolved: 1,
    });
    expect(runBackfill()).toBe(1);
    expect(await pairOf('/products/ghost/integrations/alpha')).toEqual([ALPHA, null]);
    expect(await pairOf('/products/ghost/integrations/phantom')).toEqual([null, null]);
  });

  it('is idempotent: a re-run changes nothing and the projection drains to zero', async () => {
    await seed('/products/zeta/integrations/alpha', { createdAt: '2026-08-20T00:00:00.000Z' });
    await seed('/products/ghost/integrations/alpha', { createdAt: '2026-09-30T00:00:00.000Z' });
    const before = project();
    expect(before).toEqual({
      candidates: 2,
      resolved_both: 1,
      resolved_one: 1,
      unresolved: 0,
      first_created_at: '2026-08-20T00:00:00.000Z',
      last_created_at: '2026-09-30T00:00:00.000Z',
    });
    // The projection's resolved count is exactly what the write changes.
    expect(runBackfill()).toBe(before.resolved_both + before.resolved_one);
    const after = (await t.db.select().from(pageViews)).map((r) => [
      r.pairProductAId,
      r.pairProductBId,
    ]);
    expect(runBackfill()).toBe(0);
    expect(
      (await t.db.select().from(pageViews)).map((r) => [r.pairProductAId, r.pairProductBId]),
    ).toEqual(after);
    expect(project().candidates).toBe(0);
  });

  it('never overwrites a row ingest already attributed, and leaves non-pair rows alone', async () => {
    // A live row whose one-sided value must survive even though the slug that was
    // missing at ingest resolves today.
    await seed('/products/zeta/integrations/alpha', { pairProductAId: ALPHA });
    await t.db.insert(pageViews).values([
      { path: '/products/:slug', concretePath: '/products/zeta', productId: ZETA, createdAt: AT },
      { path: '/', concretePath: '/', createdAt: AT },
      // Pre-AECI-585: no concrete path, nothing to parse.
      { path: PAIR_ROUTE, concretePath: null, createdAt: AT },
    ]);
    const before = await t.db.select().from(pageViews);
    expect(runBackfill()).toBe(0);
    expect(await t.db.select().from(pageViews)).toEqual(before);
  });

  it('matches the path case-sensitively, like the ingest regex', async () => {
    // LIKE would match this; GLOB and the regex do not.
    await seed('/PRODUCTS/zeta/integrations/alpha');
    expect(runBackfill()).toBe(0);
    expect(await pairOf('/PRODUCTS/zeta/integrations/alpha')).toEqual([null, null]);
  });
});
