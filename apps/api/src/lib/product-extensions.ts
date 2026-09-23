/**
 * The `product_extensions` read for product detail (AECI-710 / Stage 1.5 §13.3b).
 *
 * An extension is a product built INSIDE a host: a Revit add-in, a Dynamics 365
 * vertical. There is no boundary for data to cross, so the relation is not an
 * integration edge. It never joins `integrations_as_*`, and it never reaches
 * `integration_count` or any §13.5 lockstep site. This module is its only reader.
 */
import { asc, eq, inArray } from 'drizzle-orm';

import type { Db } from '../db/client';
import { productExtensions, products } from '../db/schema';

import { textAsc } from './collation';
import { productListConfig, type ProductExtensionRows } from './drizzle-helpers';

/**
 * Both directions for `productId`, each sorted by name through `textAsc` with the
 * `id` tiebreaker (`API_CONTRACTS.md` §3.2). Two queries in parallel, each a
 * subquery on the `product_extensions` primary key or its host index.
 *
 * Unbounded on purpose. Production's largest host lists three extensions
 * (2026-09-23), and a silent cap would render an incomplete list with no way to
 * see the rest.
 */
export async function productExtensionRows(
  db: Db,
  productId: string,
): Promise<ProductExtensionRows> {
  const orderBy = [textAsc(products.name), asc(products.id)];
  const [hosts, extensions] = await Promise.all([
    db.query.products.findMany({
      ...productListConfig,
      where: inArray(
        products.id,
        db
          .select({ id: productExtensions.hostProductId })
          .from(productExtensions)
          .where(eq(productExtensions.productId, productId)),
      ),
      orderBy,
    }),
    db.query.products.findMany({
      ...productListConfig,
      where: inArray(
        products.id,
        db
          .select({ id: productExtensions.productId })
          .from(productExtensions)
          .where(eq(productExtensions.hostProductId, productId)),
      ),
      orderBy,
    }),
  ]);
  return { hosts, extensions };
}

/**
 * Slugs of the hosts `productId` names NOW, for the promote cache-purge hook
 * (`CACHE_STRATEGY.md` §3 rule 7). Read post-commit, so it is the pushed set.
 */
export async function extensionHostSlugs(db: Db, productId: string): Promise<string[]> {
  const rows = await db
    .select({ slug: products.slug })
    .from(productExtensions)
    .innerJoin(products, eq(products.id, productExtensions.hostProductId))
    .where(eq(productExtensions.productId, productId));
  return rows.map((r) => r.slug);
}
