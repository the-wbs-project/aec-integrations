/**
 * Every product a given product shares an integration-PAIR page with (AECI-944).
 *
 * ─── Why this read exists ─────────────────────────────────────────────────────
 *
 * A pair page is `/products/{a}/integrations/{b}`, and its URL is built from two
 * product slugs. A caller that has one product and needs the pages it appears on
 * therefore needs the OTHER slug of every pair, which is not derivable from the
 * product row — it is an edge.
 *
 * The product-version writes are the caller. A `product_versions` row renders on
 * the pair page and nowhere else (`routes/integrations.ts` loads it for both
 * endpoints of a pair; no product-detail read touches the table), so a version
 * write changes a set of pages the product's own slug cannot name.
 *
 * ─── The delivered tier spans TWO tables, and both are required ───────────────
 *
 * A pair page renders from `integrations` **and** `connector_evidenced_pairs`
 * (§13.1 / AECI-721) — 19 production pairs live only in the second one. Reading
 * `integrations` alone would silently omit them, which is the same defect the
 * pair-page read and the sitemap each had to fix.
 *
 * The two tables store orientation differently and the query has to respect it:
 * `integrations` may hold the edge either way round, so both orientations are
 * unioned; `connector_evidenced_pairs` is canonical by CHECK
 * (`product_a_id < product_b_id`), but the product we hold can be on either
 * side of that ordering, so it also needs both.
 *
 * Four `unionAll` terms, which is inside D1's five-term compound-SELECT ceiling
 * (the in-memory harness allows more, so this limit is a review fact rather than
 * a test failure).
 *
 * ─── It returns a SUPERSET, deliberately ──────────────────────────────────────
 *
 * The pair page only renders version selectors when some live attestation on
 * that pair is version-stamped (`hasVersionStamps`), so a few of these pages do
 * not visibly change. Narrowing to the stamped set would mean a second, heavier
 * read that has to stay in lockstep with that predicate. The superset matches
 * what `versionEditTags` already purges — `product:{slug}` repaints every pair
 * page the product appears on — and over-emitting costs a tier-4 worklist row
 * and a free IndexNow URL.
 */

import { and, eq } from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/sqlite-core';

import type { Db } from '../db/client';
import { connectorEvidencedPairs, integrations, products } from '../db/schema';
import { liveIntegrationWhere } from './live-integration';

/**
 * The slugs of every product that `productId` shares a pair page with, deduped.
 *
 * Returns `[]` for a product with no edges, without special-casing it — the
 * union simply matches nothing.
 */
export async function readPairCounterpartSlugs(db: Db, productId: string): Promise<string[]> {
  const rows = await unionAll(
    db
      .select({ slug: products.slug })
      .from(integrations)
      .innerJoin(products, eq(products.id, integrations.targetProductId))
      .where(and(eq(integrations.sourceProductId, productId), liveIntegrationWhere)),
    db
      .select({ slug: products.slug })
      .from(integrations)
      .innerJoin(products, eq(products.id, integrations.sourceProductId))
      .where(and(eq(integrations.targetProductId, productId), liveIntegrationWhere)),
    db
      .select({ slug: products.slug })
      .from(connectorEvidencedPairs)
      .innerJoin(products, eq(products.id, connectorEvidencedPairs.productBId))
      .where(eq(connectorEvidencedPairs.productAId, productId)),
    db
      .select({ slug: products.slug })
      .from(connectorEvidencedPairs)
      .innerJoin(products, eq(products.id, connectorEvidencedPairs.productAId))
      .where(eq(connectorEvidencedPairs.productBId, productId)),
  );

  // Deduped here rather than with `union`, because two rows CAN legitimately
  // repeat: a pair may hold several `integrations` edges, and the same two
  // products may appear in both tables. They name one page either way.
  return [...new Set(rows.map((row) => row.slug))];
}
