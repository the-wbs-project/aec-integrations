/**
 * `productAttributedViews` (AECI-929, reshaped by AECI-1484).
 *
 * AECI-1484 replaced the three `UNION ALL` arms over the CTE with one read of the
 * CTE fanned out over a two-row constant, so SQLite walks the `page_views` window
 * once instead of three times. These specs pin the new row multiset to the old
 * three-arm SQL on a fixture with every attribution kind, and pin the shape so a
 * refactor cannot quietly bring back the per-arm walks.
 */

import { count, eq, gte } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pageViews, products } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { productAttributedViews } from './product-attributed-views';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P1 = u(1);
const P2 = u(2);
const P3 = u(3);

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(products).values([
    { id: P1, slug: 'p1', name: 'P1' },
    { id: P2, slug: 'p2', name: 'P2' },
    { id: P3, slug: 'p3', name: 'P3' },
  ]);
  const at = (day: number) => `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`;
  await t.db.insert(pageViews).values([
    // A product page.
    { path: '/products/:slug', productId: P1, createdAt: at(10) },
    { path: '/products/:slug', productId: P1, createdAt: at(10) },
    // A pair page: once for EACH endpoint.
    { path: '/integrations/:pair', pairProductAId: P1, pairProductBId: P2, createdAt: at(11) },
    { path: '/integrations/:pair', pairProductAId: P2, pairProductBId: P3, createdAt: at(11) },
    // A row carrying both kinds: product_id wins, the pair arms do not add to it.
    {
      path: '/products/:slug',
      productId: P3,
      pairProductAId: P1,
      pairProductBId: P2,
      createdAt: at(12),
    },
    // Half-attributed pair rows: only the side that is set counts.
    { path: '/integrations/:pair', pairProductAId: P3, createdAt: at(12) },
    { path: '/integrations/:pair', pairProductBId: P1, createdAt: at(12) },
    // Attributed to nothing: a browse page.
    { path: '/browse', createdAt: at(12) },
    // Outside the caller's window.
    { path: '/products/:slug', productId: P2, createdAt: at(1) },
  ]);
});
afterEach(() => t.dispose());

const WINDOW_START = '2026-10-05T00:00:00.000Z';

/** The pre-AECI-1484 three-arm form, verbatim in shape. */
function legacyCounts(sinceIso: string): Record<string, number> {
  const rows = t.raw
    .prepare(
      `WITH attributable_views AS (
         SELECT product_id, pair_product_a_id, pair_product_b_id FROM page_views
         WHERE created_at >= ?
           AND (product_id IS NOT NULL OR pair_product_a_id IS NOT NULL OR pair_product_b_id IS NOT NULL)
       )
       SELECT attributed_product_id AS id, count(*) AS n FROM (
         SELECT product_id AS attributed_product_id FROM attributable_views WHERE product_id IS NOT NULL
         UNION ALL
         SELECT pair_product_a_id FROM attributable_views
           WHERE pair_product_a_id IS NOT NULL AND product_id IS NULL
         UNION ALL
         SELECT pair_product_b_id FROM attributable_views
           WHERE pair_product_b_id IS NOT NULL AND product_id IS NULL
       ) GROUP BY attributed_product_id`,
    )
    .all(sinceIso) as { id: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.id, r.n]));
}

async function currentCounts(sinceIso: string): Promise<Record<string, number>> {
  const av = productAttributedViews(t.db, gte(pageViews.createdAt, sinceIso));
  const rows = await t.db
    .with(av.cte)
    .select({ id: av.productId, n: count() })
    .from(av.views)
    .groupBy(av.productId);
  return Object.fromEntries(rows.map((r) => [r.id, r.n]));
}

describe('productAttributedViews', () => {
  it('yields the same per-product counts as the pre-AECI-1484 three-arm form', async () => {
    const legacy = legacyCounts(WINDOW_START);
    expect(await currentCounts(WINDOW_START)).toEqual(legacy);
    // Spelled out, so a regression shared by both shapes still fails.
    // P1: 2 product rows + pair (a) + half pair (b). P2: pair (b) + pair (a).
    // P3: pair (b) + the both-kinds row's product_id + half pair (a).
    expect(legacy).toEqual({ [P1]: 4, [P2]: 2, [P3]: 3 });
  });

  it('agrees with the legacy form with no window at all', async () => {
    expect(await currentCounts('1970-01-01T00:00:00.000Z')).toEqual(
      legacyCounts('1970-01-01T00:00:00.000Z'),
    );
  });

  it('joins to products the way the breakdown and digest do', async () => {
    const av = productAttributedViews(t.db, gte(pageViews.createdAt, WINDOW_START));
    const rows = await t.db
      .with(av.cte)
      .select({ slug: products.slug, views: count() })
      .from(av.views)
      .innerJoin(products, eq(av.productId, products.id))
      .groupBy(products.id);
    expect(Object.fromEntries(rows.map((r) => [r.slug, r.views]))).toEqual({
      p1: 4,
      p2: 2,
      p3: 3,
    });
  });

  it('reads the CTE once, with no UNION ALL arm over it', () => {
    const av = productAttributedViews(t.db, gte(pageViews.createdAt, WINDOW_START));
    const { sql } = t.db
      .with(av.cte)
      .select({ id: av.productId, n: count() })
      .from(av.views)
      .groupBy(av.productId)
      .toSQL();
    expect(sql.match(/from "attributable_views"/g)).toHaveLength(1);
    expect(sql).toContain('cross join');
    // The only compound SELECT is the two-row fan-out.
    expect(sql.match(/union all/gi)).toHaveLength(1);
    // And SQLite walks `page_views` once for it.
    const plan = t.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(WINDOW_START) as {
      detail: string;
    }[];
    expect(plan.filter((r) => /\bpage_views\b/.test(r.detail))).toHaveLength(1);
  });
});
