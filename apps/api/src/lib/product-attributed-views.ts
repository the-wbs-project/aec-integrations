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
 * parser refuses `a = b`, and the two pair arms require `product_id IS NULL`, so
 * a row that somehow carried both kinds of attribution still counts once per
 * product.
 *
 * ─── Why a CTE under the UNION ALL, not the caller's predicate in every arm ──
 *
 * The obvious shape is three `UNION ALL` arms over `page_views`, each carrying
 * the caller's `WHERE`. It is correct in SQL: each arm reads `page_views`
 * unaliased, so `NOT_INTERNAL`'s correlated subquery still correlates. It is
 * wrong on D1, because it binds the caller's parameters three times. The
 * digest's predicate alone is about 10 parameters before `notFlagged` adds up to
 * 2 × `SWARM_MAX_CANDIDATES` more, so three copies cross D1's 100-parameter cap
 * on a busy day. The better-sqlite3 harness has no such cap, so every spec would
 * pass (`TESTING_STRATEGY.md` §6.3).
 *
 * So the caller's predicate runs ONCE, inside a CTE over unaliased `page_views`
 * (which keeps `NOT_INTERNAL` and `notFlagged` exactly as every other reader
 * applies them), and the three arms only pick a column out of the CTE. Three
 * compound terms, inside D1's five-term ceiling.
 *
 * Usage, because the CTE has to be attached to the OUTER statement:
 *
 *     const av = productAttributedViews(db, where);
 *     await db.with(av.cte).select({ id: av.productId, n: count() })
 *       .from(av.views).groupBy(av.productId);
 *
 * `page_views` is log-class, so nothing here writes an audit row.
 */

import { and, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { unionAll, type SQLiteColumn } from 'drizzle-orm/sqlite-core';

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
  const arm = (column: SQLiteColumn, extra?: SQL) =>
    db
      .select({ productId: sql<string>`${column}`.as('attributed_product_id') })
      .from(cte)
      .where(and(isNotNull(column), extra));
  const views = unionAll(
    arm(cte.productId),
    arm(cte.pairProductAId, isNull(cte.productId)),
    arm(cte.pairProductBId, isNull(cte.productId)),
  ).as('attributed_views');
  // The same column as a plain `SQL`, because `groupBy` takes no aliased field.
  const productId = sql<string>`${views.productId}`;
  return { cte, views, productId };
}
