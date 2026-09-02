/**
 * Post-commit resolution of which touched trades are **published** (AECI-546).
 * The touched *set* itself is derived by `touchedTradeSlugs`
 * (`promote-cache-tags.ts`) — purely, from the response — and narrowed here.
 *
 * Trades are the one publication-gated taxonomy facet: a term is published once
 * at least `TRADE_PUBLISH_MIN_PRODUCTS` promoted products carry it
 * (`TRADES_VOCABULARY.md` §6). Consumers that advertise a URL to the outside
 * world — the sitemap, and the IndexNow ping — must respect
 * that floor, because a sub-floor `/trades/:slug` page renders `noindex` and
 * submitting a noindex'd URL to an indexing service is the same correctness bug
 * the `INDEXNOW_KEY`-absent gate exists to prevent.
 *
 * Why this lives in its own module rather than in `promote-indexnow-urls.ts`:
 * that deriver is deliberately **pure** over the promote response, and the floor
 * needs a per-term `product_count` the response does not carry. Keeping the read
 * here preserves that purity — the URL builder still takes plain data and stays
 * trivially testable, and the one DB round-trip is explicit at the call site.
 *
 * Ordering matters. `resolvePublishedTradeSlugs` must run **after** the promote's
 * `db.batch([...])` commits, or it counts the pre-promote world and a term that
 * just crossed the floor is missed.
 */

import { TRADE_PUBLISH_MIN_PRODUCTS } from '@aeci/shared';
import { count, eq, inArray } from 'drizzle-orm';

import type { Db } from '../db/client';
import { productTrades, taxonomyTrades } from '../db/schema';

/**
 * Of `slugs`, those whose CURRENT promoted-product count clears
 * `TRADE_PUBLISH_MIN_PRODUCTS`. One grouped count per call; returns `[]` for an
 * empty input without touching the DB.
 *
 * Unknown slugs simply don't come back — the vocabulary is closed and find-only,
 * so a slug reaching here always exists, but a caller passing a stale one gets
 * "not published" rather than an error, which is the safe direction.
 */
export async function resolvePublishedTradeSlugs(
  db: Db,
  slugs: readonly string[],
): Promise<string[]> {
  if (slugs.length === 0) return [];

  const rows = await db
    .select({ slug: taxonomyTrades.slug, productCount: count(productTrades.productId) })
    .from(taxonomyTrades)
    .leftJoin(productTrades, eq(productTrades.tradeId, taxonomyTrades.id))
    .where(inArray(taxonomyTrades.slug, [...slugs]))
    .groupBy(taxonomyTrades.id);

  return rows
    .filter((row) => row.productCount >= TRADE_PUBLISH_MIN_PRODUCTS)
    .map((row) => row.slug);
}
