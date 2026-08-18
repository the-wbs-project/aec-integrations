/**
 * `resolvePublishedTradeSlugs` (AECI-546) — the publication floor that decides
 * which touched trade URLs the indexing pings may submit. Run against the
 * in-memory D1 harness so the grouped count is exercised as real SQL: an
 * off-by-one here submits a `noindex` page to Bing and Google.
 *
 * `touchedTradeSlugs` — the pure set derivation this narrows — lives in
 * `promote-cache-tags.ts` and is covered in `promote.spec.ts` alongside
 * `cacheTagsForPromote`, its other consumer.
 */

import { TRADE_PUBLISH_MIN_PRODUCTS } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { productTrades, products, taxonomyTrades } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { resolvePublishedTradeSlugs } from './promote-trade-publication';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => {
  t.dispose();
});

/** Seed a trade and link `productCount` distinct products to it. */
async function seedTrade(slug: string, productCount: number, seq: number): Promise<void> {
  const tradeId = uuid(900 + seq);
  await t.db.insert(taxonomyTrades).values({
    id: tradeId,
    slug,
    name: slug,
    // NOT NULL — `/trades/:slug` ships as an SEO landing page (TRADES_VOCABULARY.md §5).
    description: `${slug} work.`,
    aliases: [],
  });
  for (let i = 0; i < productCount; i += 1) {
    const productId = uuid(seq * 100 + i);
    await t.db
      .insert(products)
      .values({ id: productId, slug: `${slug}-p${i}`, name: `${slug} ${i}` });
    await t.db.insert(productTrades).values({ productId, tradeId });
  }
}

describe('resolvePublishedTradeSlugs', () => {
  it('returns only terms at or above the floor', async () => {
    await seedTrade('electrical', TRADE_PUBLISH_MIN_PRODUCTS, 1);
    await seedTrade('plumbing', TRADE_PUBLISH_MIN_PRODUCTS - 1, 2);

    const published = await resolvePublishedTradeSlugs(t.db, ['electrical', 'plumbing']);

    expect(published).toEqual(['electrical']);
  });

  // The floor is inclusive (`>=`). Off-by-one here is the difference between
  // publishing a page and withholding it, so pin both sides of the boundary.
  it('treats exactly TRADE_PUBLISH_MIN_PRODUCTS as published', async () => {
    await seedTrade('at-floor', TRADE_PUBLISH_MIN_PRODUCTS, 1);
    await seedTrade('below-floor', TRADE_PUBLISH_MIN_PRODUCTS - 1, 2);
    await seedTrade('above-floor', TRADE_PUBLISH_MIN_PRODUCTS + 1, 3);

    const published = await resolvePublishedTradeSlugs(t.db, [
      'at-floor',
      'below-floor',
      'above-floor',
    ]);

    expect(new Set(published)).toEqual(new Set(['at-floor', 'above-floor']));
  });

  // A trade with no products at all must not be dragged in by the LEFT JOIN as a
  // count of 1 — the classic `count(*)` mistake this query avoids by counting the
  // joined column, not the row.
  it('reports a trade with zero products as unpublished', async () => {
    await seedTrade('empty', 0, 1);

    expect(await resolvePublishedTradeSlugs(t.db, ['empty'])).toEqual([]);
  });

  it('only considers the slugs it was asked about', async () => {
    await seedTrade('electrical', TRADE_PUBLISH_MIN_PRODUCTS, 1);
    await seedTrade('roofing', TRADE_PUBLISH_MIN_PRODUCTS, 2);

    expect(await resolvePublishedTradeSlugs(t.db, ['electrical'])).toEqual(['electrical']);
  });

  // Trades are sparse by design, so the no-op path is the common one — it must not
  // cost a round-trip. Proven against a disposed DB: any query would throw.
  it('short-circuits an empty input without querying', async () => {
    const disposed = await makeTestDb();
    disposed.dispose();

    await expect(resolvePublishedTradeSlugs(disposed.db, [])).resolves.toEqual([]);
  });

  // The vocabulary is closed and find-only, so this shouldn't happen — but an
  // unknown slug must read as "not published", never as an error.
  it('ignores a slug with no matching term', async () => {
    await seedTrade('electrical', TRADE_PUBLISH_MIN_PRODUCTS, 1);

    expect(await resolvePublishedTradeSlugs(t.db, ['electrical', 'not-a-trade'])).toEqual([
      'electrical',
    ]);
  });
});
