/**
 * `page_views` rows expanded to one row per PRODUCT they are attributed to
 * (AECI-929 / `ADMIN_PANEL_SPEC.md` §13 D25).
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 *
 * A product's attention lives in three columns. A product page names it in
 * `product_id`. An integration pair page names it in `pair_product_a_id` or
 * `pair_product_b_id`, and leaves `product_id` NULL. Every per-product reader
 * (home trending, the `/admin` product breakdown, the digest's top products)
 * used to group on `product_id` alone, so a pair-page view counted for neither
 * endpoint. This helper is the one place that knows the three columns, so the
 * three readers cannot disagree on what "a view of this product" means.
 *
 * A pair row counts once for EACH endpoint, and never twice for one product: the
 * parser refuses `a = b`, and a pair column is read only when `product_id` is
 * NULL, so a row that somehow carried both kinds of attribution still counts once
 * per product.
 *
 * ─── Why a CTE under the UNION ALL, not the caller's predicate in every arm ──
 *
 * The obvious shape is three `UNION ALL` arms over `page_views`, each carrying
 * the caller's `WHERE`. It is correct in SQL: each arm reads `page_views`
 * unaliased, so `NOT_INTERNAL`'s correlated subquery still correlates. It is
 * wrong on D1, because it binds the caller's parameters three times. When this
 * shipped the digest's predicate carried up to 2 × `SWARM_MAX_CANDIDATES` more
 * parameters for the automation exclusion, so three copies crossed D1's
 * 100-parameter cap on a busy day. AECI-1460 replaced that exclusion with a
 * three-parameter class filter, and the CTE still keeps the count from scaling
 * with the arms. The better-sqlite3 harness has no such cap, so every spec would
 * pass (`TESTING_STRATEGY.md` §6.3).
 *
 * So the caller's predicate runs ONCE, inside a CTE over unaliased `page_views`
 * (which keeps the correlated subqueries in `NOT_INTERNAL` and the class filter
 * correlating exactly as every other reader applies them).
 *
 * ─── Why the CTE is read once, through a two-row fan-out (AECI-1484) ────────
 *
 * Until AECI-1484 three `UNION ALL` arms each picked one column out of the CTE.
 * SQLite does not materialize a CTE that sits under a compound SELECT: it
 * flattened the CTE into each arm, so every call walked the `page_views` window
 * three times. The `/admin` product breakdown calls this up to three times per
 * request, so six to nine walks, over all time when traffic is "all". Drizzle's
 * `$with` cannot emit `AS MATERIALIZED`.
 *
 * So the CTE is read once and `CROSS JOIN`ed to a two-row constant (`arm` 0 and
 * 1). Arm 0 yields `coalesce(product_id, pair_product_a_id)`: the product page's
 * product, else the pair page's first endpoint. Arm 1 yields `pair_product_b_id`
 * when `product_id` is NULL. Rows where the arm yields NULL are dropped. That is
 * the same multiset the three arms produced: arm 0 is the old first two arms
 * (disjoint on `product_id IS NULL`), arm 1 is the old third. `CROSS JOIN` is
 * load-bearing: SQLite keeps its left side as the outer loop, so `page_views` is
 * walked once and the constant is re-read per row. The fan-out is a two-term
 * compound SELECT, inside D1's five-term ceiling.
 *
 * Usage, because the CTE has to be attached to the OUTER statement:
 *
 *     const av = productAttributedViews(db, where);
 *     await db.with(av.cte).select({ id: av.productId, n: count() })
 *       .from(av.views).groupBy(av.productId);
 *
 * `page_views` is log-class, so nothing here writes an audit row.
 */

import { and, isNotNull, or, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import { pageViews } from '../db/schema';

export function productAttributedViews(db: Db, where: SQL | undefined) {
  const cte = db.$with('attributable_views').as(
    db
      .select({
        productId: pageViews.productId,
        pairProductAId: pageViews.pairProductAId,
        pairProductBId: pageViews.pairProductBId,
      })
      .from(pageViews)
      .where(
        and(
          where,
          or(
            isNotNull(pageViews.productId),
            isNotNull(pageViews.pairProductAId),
            isNotNull(pageViews.pairProductBId),
          ),
        ),
      ),
  );
  const arm = sql<number>`"fanout"."arm"`;
  const attributed = sql<
    string | null
  >`case ${arm} when 0 then coalesce(${cte.productId}, ${cte.pairProductAId}) else case when ${cte.productId} is null then ${cte.pairProductBId} end end`;
  const views = db
    .select({ productId: sql<string>`${attributed}`.as('attributed_product_id') })
    .from(cte)
    .crossJoin(sql`(select 0 as "arm" union all select 1 as "arm") as "fanout"`)
    .where(isNotNull(attributed))
    .as('attributed_views');
  // The same column as a plain `SQL`, because `groupBy` takes no aliased field.
  const productId = sql<string>`${views.productId}`;
  return { cte, views, productId };
}
