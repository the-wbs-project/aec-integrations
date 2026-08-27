/**
 * Unit tests for the AECI-178 home-stats compute core on the Drizzle/D1 path
 * (ADR 0016 / AECI-253). The in-memory D1 harness (`makeTestDb`) seeds real rows
 * — products, integrations, page_views, categories — and each test exercises a
 * compute function or the `runHomeStats` orchestration against actual queries +
 * mapper output: every written value is validated against its
 * `statsCacheValueSchemas` schema, empty `page_views` yields `[]` without
 * throwing, and one failing key never aborts the others.
 */

import { statsCacheValueSchemas } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  integrations,
  pageViews,
  productCategories,
  products,
  reviews,
  statsCache,
  taxonomyCategories,
  vendors,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  computeIntegrationsAdded30d,
  computeMostActiveCategory,
  computeMostIntegratedProduct,
  computeRecentIntegrations,
  computeRecentlyAddedProducts,
  computeTotalContributingFirms,
  computeTotalIntegrations,
  computeTotalProducts,
  computeTotalReviews,
  computeTotalVendors,
  computeTrendingProducts,
  runHomeStats,
} from './home-stats';

const NOW = new Date('2026-06-10T00:00:00.000Z');
const within7d = '2026-06-08T00:00:00.000Z'; // inside both windows
const within30d = '2026-05-20T00:00:00.000Z'; // inside 30d, outside 7d
const old = '2026-01-01T00:00:00.000Z'; // outside both windows

// Real UUIDs everywhere: the orchestration validates every written value against
// its `statsCacheValueSchemas` schema, and those schemas require `id` to be a
// UUID (`LinkRefSchema` / `ProductListItemSchema` / `IntegrationListItemSchema`).
const U = {
  p1: '11111111-1111-4111-8111-111111111111',
  p2: '22222222-2222-4222-8222-222222222222',
  p3: '33333333-3333-4333-8333-333333333333',
  i1: '44444444-4444-4444-8444-444444444444',
  i2: '55555555-5555-4555-8555-555555555555',
  c1: '66666666-6666-4666-8666-666666666666',
  c2: '77777777-7777-4777-8777-777777777777',
};

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

// ── Seed helpers ─────────────────────────────────────────────────────────────

type ProductSeed = {
  id: string;
  slug?: string;
  name?: string;
  integrationCount?: number;
  createdAt?: string;
};

/** Insert a product (defaults fill the non-null columns the schema requires). */
async function seedProduct(over: ProductSeed): Promise<void> {
  await t.db.insert(products).values({
    id: over.id,
    slug: over.slug ?? over.id,
    name: over.name ?? over.id,
    integrationCount: over.integrationCount ?? 0,
    createdAt: over.createdAt ?? within30d,
    updatedAt: over.createdAt ?? within30d,
  });
}

type IntegrationSeed = {
  id: string;
  sourceProductId: string;
  targetProductId: string;
  createdAt?: string;
};

async function seedIntegration(over: IntegrationSeed): Promise<void> {
  await t.db.insert(integrations).values({
    id: over.id,
    sourceProductId: over.sourceProductId,
    targetProductId: over.targetProductId,
    createdAt: over.createdAt ?? within30d,
    updatedAt: over.createdAt ?? within30d,
  });
}

async function seedCategory(id: string, name: string, slug: string): Promise<void> {
  await t.db.insert(taxonomyCategories).values({ id, name, slug });
}

async function linkCategory(productId: string, categoryId: string): Promise<void> {
  await t.db.insert(productCategories).values({ productId, categoryId });
}

async function seedPageView(
  productId: string | null,
  createdAt: string,
  isBot?: boolean,
): Promise<void> {
  await t.db.insert(pageViews).values({ path: '/x', productId, createdAt, isBot });
}

async function seedVendor(id: string): Promise<void> {
  await t.db.insert(vendors).values({ id, slug: id, companyName: id });
}

/** Insert a review for a product. `reviewerId` stays null (no uniqueness clash),
 *  so any number of reviews can be seeded per product. `reviewerFirm` is optional
 *  (AECI-284 contributing-firms count). */
async function seedReview(
  id: string,
  productId: string,
  status: string,
  reviewerFirm: string | null = null,
): Promise<void> {
  await t.db.insert(reviews).values({
    id,
    productId,
    ratingOverall: 4,
    ratingOnboarding: 4,
    title: 't',
    body: 'b',
    status,
    reviewerFirm,
  });
}

// ── Per-key compute functions ────────────────────────────────────────────────

describe('computeTotalIntegrations', () => {
  it('counts every integration', async () => {
    await seedProduct({ id: U.p1 });
    await seedProduct({ id: U.p2 });
    await seedIntegration({ id: U.i1, sourceProductId: U.p1, targetProductId: U.p2 });
    await seedIntegration({ id: U.i2, sourceProductId: U.p2, targetProductId: U.p1 });
    expect(await computeTotalIntegrations(t.db)).toBe(2);
  });

  it('returns 0 on an empty DB', async () => {
    expect(await computeTotalIntegrations(t.db)).toBe(0);
  });
});

describe('computeIntegrationsAdded30d', () => {
  it('counts only integrations created within the last 30 days', async () => {
    await seedProduct({ id: U.p1 });
    await seedProduct({ id: U.p2 });
    await seedIntegration({
      id: U.i1,
      sourceProductId: U.p1,
      targetProductId: U.p2,
      createdAt: within7d,
    });
    await seedIntegration({
      id: U.i2,
      sourceProductId: U.p2,
      targetProductId: U.p1,
      createdAt: within30d,
    });
    await seedIntegration({
      id: U.c1, // any unique uuid for the stale row
      sourceProductId: U.p1,
      targetProductId: U.p2,
      createdAt: old,
    });
    expect(await computeIntegrationsAdded30d(t.db, NOW)).toBe(2);
  });
});

describe('computeTotalProducts', () => {
  it('counts every product (no filter)', async () => {
    await seedProduct({ id: U.p1 });
    await seedProduct({ id: U.p2 });
    await seedProduct({ id: U.p3 });
    expect(await computeTotalProducts(t.db)).toBe(3);
  });

  it('returns 0 on an empty DB', async () => {
    expect(await computeTotalProducts(t.db)).toBe(0);
  });
});

describe('computeTotalVendors', () => {
  it('counts every vendor (no filter)', async () => {
    await seedVendor(U.c1);
    await seedVendor(U.c2);
    expect(await computeTotalVendors(t.db)).toBe(2);
  });

  it('returns 0 on an empty DB', async () => {
    expect(await computeTotalVendors(t.db)).toBe(0);
  });
});

describe('computeTotalReviews', () => {
  it('counts only approved reviews, ignoring pending / rejected / archived', async () => {
    await seedProduct({ id: U.p1 });
    await seedReview(U.i1, U.p1, 'approved');
    await seedReview(U.i2, U.p1, 'approved');
    await seedReview('99999999-9999-4999-8999-999999999999', U.p1, 'pending');
    await seedReview('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', U.p1, 'rejected');
    await seedReview('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', U.p1, 'archived');
    expect(await computeTotalReviews(t.db)).toBe(2);
  });

  it('returns 0 when there are no approved reviews', async () => {
    await seedProduct({ id: U.p1 });
    await seedReview(U.i1, U.p1, 'pending');
    expect(await computeTotalReviews(t.db)).toBe(0);
  });
});

describe('computeTotalContributingFirms', () => {
  it('counts distinct firms (case/whitespace-insensitive) among approved reviews only', async () => {
    await seedProduct({ id: U.p1 });
    // Three spellings of one firm → one distinct firm after lower(trim()).
    await seedReview('firm-r1', U.p1, 'approved', 'Acme Architects');
    await seedReview('firm-r2', U.p1, 'approved', 'acme architects');
    await seedReview('firm-r3', U.p1, 'approved', '  Acme Architects  ');
    // A genuinely different firm → second distinct.
    await seedReview('firm-r4', U.p1, 'approved', 'Beacon Structural');
    // Same firms but NOT approved → excluded.
    await seedReview('firm-r5', U.p1, 'pending', 'Cornerstone Eng');
    await seedReview('firm-r6', U.p1, 'rejected', 'Delta Build');
    expect(await computeTotalContributingFirms(t.db)).toBe(2);
  });

  it('excludes null and blank/whitespace-only firms', async () => {
    await seedProduct({ id: U.p1 });
    await seedReview('firm-r1', U.p1, 'approved', null);
    await seedReview('firm-r2', U.p1, 'approved', '');
    await seedReview('firm-r3', U.p1, 'approved', '   ');
    await seedReview('firm-r4', U.p1, 'approved', 'Real Firm');
    expect(await computeTotalContributingFirms(t.db)).toBe(1);
  });

  it('returns 0 when no approved review carries a firm', async () => {
    await seedProduct({ id: U.p1 });
    await seedReview('firm-r1', U.p1, 'approved', null);
    await seedReview('firm-r2', U.p1, 'pending', 'Pending Firm');
    expect(await computeTotalContributingFirms(t.db)).toBe(0);
  });
});

describe('computeMostIntegratedProduct', () => {
  it('returns the product with the highest integration_count', async () => {
    await seedProduct({ id: U.p1, name: 'Procore', slug: 'procore', integrationCount: 7 });
    await seedProduct({ id: U.p2, name: 'Revit', slug: 'revit', integrationCount: 42 });
    const result = await computeMostIntegratedProduct(t.db);
    expect(result).toEqual({
      product: { id: U.p2, name: 'Revit', slug: 'revit', logo_url: null },
      integration_count: 42,
    });
  });

  it('breaks ties on integration_count by name ascending', async () => {
    await seedProduct({ id: U.p1, name: 'Bravo', slug: 'bravo', integrationCount: 5 });
    await seedProduct({ id: U.p2, name: 'Alpha', slug: 'alpha', integrationCount: 5 });
    const result = await computeMostIntegratedProduct(t.db);
    expect(result?.product.name).toBe('Alpha');
  });

  it('returns null on an empty DB (skips the key)', async () => {
    expect(await computeMostIntegratedProduct(t.db)).toBeNull();
  });
});

describe('computeMostActiveCategory', () => {
  beforeEach(async () => {
    await seedCategory(U.c1, 'Project Management', 'project-management');
    await seedCategory(U.c2, 'Design', 'design');
  });

  it('counts distinct integrations whose source OR target is in the category', async () => {
    // Four products so each integration endpoint is a distinct, existing row.
    await seedProduct({ id: U.p1 });
    await seedProduct({ id: U.p2 });
    await seedProduct({ id: U.p3 });
    const p4 = '88888888-8888-4888-8888-888888888888';
    await seedProduct({ id: p4 });
    // i-1: source in c-1, target in c-2 (union counts each once).
    await linkCategory(U.p1, U.c1);
    await linkCategory(U.p2, U.c2);
    await seedIntegration({ id: U.i1, sourceProductId: U.p1, targetProductId: U.p2 });
    // i-2: both endpoints in c-1 (counts c-1 once, not twice).
    await linkCategory(U.p3, U.c1);
    await linkCategory(p4, U.c1);
    await seedIntegration({ id: U.i2, sourceProductId: U.p3, targetProductId: p4 });

    // c-1 touched by i-1 + i-2 = 2; c-2 touched by i-1 = 1 → c-1 wins.
    expect(await computeMostActiveCategory(t.db)).toEqual({
      category: { id: U.c1, name: 'Project Management', slug: 'project-management' },
      integration_count: 2,
    });
  });

  it('breaks ties alphabetically by category name', async () => {
    await seedProduct({ id: U.p1 });
    await seedProduct({ id: U.p2 });
    await linkCategory(U.p1, U.c1);
    await linkCategory(U.p2, U.c2);
    await seedIntegration({ id: U.i1, sourceProductId: U.p1, targetProductId: U.p2 });
    // c-1 and c-2 each count 1 → "Design" (c-2) sorts before "Project Management".
    expect(await computeMostActiveCategory(t.db)).toEqual({
      category: { id: U.c2, name: 'Design', slug: 'design' },
      integration_count: 1,
    });
  });

  it('returns null when there are no integrations (skips the key)', async () => {
    expect(await computeMostActiveCategory(t.db)).toBeNull();
  });
});

describe('computeRecentIntegrations', () => {
  it('returns the newest integrations as IntegrationListItems (synthesized name)', async () => {
    await seedProduct({ id: U.p1, name: 'Source', slug: 'source' });
    await seedProduct({ id: U.p2, name: 'Target', slug: 'target' });
    await seedIntegration({
      id: U.i1,
      sourceProductId: U.p1,
      targetProductId: U.p2,
      createdAt: within7d,
    });
    await seedIntegration({
      id: U.i2,
      sourceProductId: U.p2,
      targetProductId: U.p1,
      createdAt: old,
    });
    const result = await computeRecentIntegrations(t.db);
    expect(result.map((r) => r.id)).toEqual([U.i1, U.i2]);
    expect(result[0]!.name).toBe('Source → Target'); // null name synthesized by the mapper
  });
});

describe('computeTrendingProducts', () => {
  it('ranks products clearing the min-views floor by page views (last 7d), reordered to the ranking', async () => {
    await seedProduct({ id: U.p1, slug: 'a', name: 'A' });
    await seedProduct({ id: U.p2, slug: 'b', name: 'B' });
    // p-2 has 4 views, p-1 has 3 — both clear the TRENDING_MIN_VIEWS (3) floor.
    await seedPageView(U.p1, within7d);
    await seedPageView(U.p1, within7d);
    await seedPageView(U.p1, within7d);
    await seedPageView(U.p2, within7d);
    await seedPageView(U.p2, within7d);
    await seedPageView(U.p2, within7d);
    await seedPageView(U.p2, within7d);
    await seedPageView(U.p1, old); // outside the 7d window — ignored
    await seedPageView(null, within7d); // no product — excluded by the null filter
    const result = await computeTrendingProducts(t.db, NOW);
    expect(result.map((r) => r.id)).toEqual([U.p2, U.p1]);
  });

  it('excludes products below the min-views floor — 1–2 views never trend (AECI-280)', async () => {
    await seedProduct({ id: U.p1, slug: 'a', name: 'A' });
    await seedProduct({ id: U.p2, slug: 'b', name: 'B' });
    // p-1 clears the floor (3 views); p-2 sits just below it (2 views) → only p-1 ranks.
    await seedPageView(U.p1, within7d);
    await seedPageView(U.p1, within7d);
    await seedPageView(U.p1, within7d);
    await seedPageView(U.p2, within7d);
    await seedPageView(U.p2, within7d);
    const result = await computeTrendingProducts(t.db, NOW);
    expect(result.map((r) => r.id)).toEqual([U.p1]);
  });

  it('returns [] when no product clears the floor (all 1–2 views → recently-added fallback territory)', async () => {
    await seedProduct({ id: U.p1, slug: 'a', name: 'A' });
    await seedProduct({ id: U.p2, slug: 'b', name: 'B' });
    await seedPageView(U.p1, within7d);
    await seedPageView(U.p1, within7d); // 2 views — below the floor
    await seedPageView(U.p2, within7d); // 1 view — below the floor
    await expect(computeTrendingProducts(t.db, NOW)).resolves.toEqual([]);
  });

  it('returns [] when there are no page views (does not throw)', async () => {
    await seedProduct({ id: U.p1 });
    await expect(computeTrendingProducts(t.db, NOW)).resolves.toEqual([]);
  });

  // AECI-582. Crawlers out-view humans by an order of magnitude, so without this the
  // card ranks products by how hard they are being scraped. Bot views must not count
  // toward the floor either — otherwise one crawler promotes a product nobody read.
  it('ignores bot views entirely — they neither rank nor clear the floor', async () => {
    await seedProduct({ id: U.p1, slug: 'a', name: 'A' });
    await seedProduct({ id: U.p2, slug: 'b', name: 'B' });
    // p-1: 3 human views → trends. p-2: 9 bot views + 1 human → must not trend.
    await seedPageView(U.p1, within7d, false);
    await seedPageView(U.p1, within7d, false);
    await seedPageView(U.p1, within7d, false);
    for (let i = 0; i < 9; i++) await seedPageView(U.p2, within7d, true);
    await seedPageView(U.p2, within7d, false);
    const result = await computeTrendingProducts(t.db, NOW);
    expect(result.map((r) => r.id)).toEqual([U.p1]);
  });

  // §13 D13. D12 recorded this query as immune to the `/admin/*` exclusion because
  // an admin-path row carries no `product_id` — true, and it does NOT extend to an
  // operator SESSION, which lands on the product page and carries the FK. The floor
  // is no defence: TRENDING_MIN_VIEWS is 3.
  it('ignores operator-session views — they neither rank nor clear the floor', async () => {
    await seedProduct({ id: U.p1, slug: 'a', name: 'A' });
    await seedProduct({ id: U.p2, slug: 'b', name: 'B' });
    // p-1: 3 genuine human views → trends.
    await seedPageView(U.p1, within7d, false);
    await seedPageView(U.p1, within7d, false);
    await seedPageView(U.p1, within7d, false);
    // p-2: 5 views from the operator re-checking their own work → must not trend,
    // even though it out-views p-1.
    for (let i = 0; i < 5; i++) {
      await t.db.insert(pageViews).values({
        path: '/x',
        productId: U.p2,
        createdAt: within7d,
        isBot: false,
        isOperator: true,
      });
    }
    const result = await computeTrendingProducts(t.db, NOW);
    expect(result.map((r) => r.id)).toEqual([U.p1]);
  });

  // AECI-683. The public card is the surface where the operator-pair leak does
  // real damage: `TRENDING_MIN_VIEWS` is 3 against a human population of roughly
  // 2,100 all-time views, so a handful of self-checks during a lapsed session put
  // a product on the home page for everyone.
  it('excludes operator views that a LAPSED session left unflagged (AECI-683)', async () => {
    await seedProduct({ id: U.p1, slug: 'a', name: 'A' });
    await seedProduct({ id: U.p2, slug: 'b', name: 'B' });
    for (let i = 0; i < 3; i++) await seedPageView(U.p1, within7d, false);
    // One verified operator row anchors the pair...
    await t.db.insert(pageViews).values({
      path: '/x',
      productId: U.p2,
      createdAt: within7d,
      isBot: false,
      userAgentHash: 'operator-ua',
      cfAsn: 23700,
      isOperator: true,
    });
    // ...and four more from the same browser and network, unflagged because the
    // token had expired. Without the retro-join these clear the floor and p-2
    // out-ranks the real product.
    for (let i = 0; i < 4; i++) {
      await t.db.insert(pageViews).values({
        path: '/x',
        productId: U.p2,
        createdAt: within7d,
        isBot: false,
        userAgentHash: 'operator-ua',
        cfAsn: 23700,
        isOperator: false,
      });
    }
    const result = await computeTrendingProducts(t.db, NOW);
    expect(result.map((r) => r.id)).toEqual([U.p1]);
  });

  // The digest's NULL-safe `is_bot IS NOT 1`: rows captured before the classifier
  // existed still count, so the card did not go blank the day the filter landed.
  it('still counts unclassified (null is_bot) views as human', async () => {
    await seedProduct({ id: U.p1, slug: 'a', name: 'A' });
    await seedPageView(U.p1, within7d); // is_bot null
    await seedPageView(U.p1, within7d);
    await seedPageView(U.p1, within7d);
    const result = await computeTrendingProducts(t.db, NOW);
    expect(result.map((r) => r.id)).toEqual([U.p1]);
  });
});

describe('computeRecentlyAddedProducts', () => {
  it('returns products created in the last 30 days, newest first', async () => {
    await seedProduct({ id: U.p1, slug: 'fresh', name: 'Fresh', createdAt: within7d });
    await seedProduct({ id: U.p2, slug: 'recent', name: 'Recent', createdAt: within30d });
    await seedProduct({ id: U.p3, slug: 'stale', name: 'Stale', createdAt: old });
    const result = await computeRecentlyAddedProducts(t.db, NOW);
    expect(result.map((r) => r.id)).toEqual([U.p1, U.p2]);
  });
});

// ── runHomeStats orchestration ───────────────────────────────────────────────

/** Seed the full home-page corpus: two categorized products + two uncategorized
 *  ones, one in-window integration touching both categories and one stale
 *  uncategorized integration, one page view.
 *
 *  Categories are linked to *products* (the relational reality), not per
 *  integration as the old Prisma fake could fake — so `i-2`'s endpoints are two
 *  distinct *uncategorized* products. That keeps c-1 and c-2 each touched once
 *  (by `i-1` only) → tie → "Design" wins with integration_count 1, preserving the
 *  original assertion. (Reusing p-1/p-2 for `i-2` would let it touch both
 *  categories transitively, giving each count 2.) */
async function seedFullFixture(): Promise<void> {
  const p3 = U.p3;
  const p4 = '88888888-8888-4888-8888-888888888888';
  await seedCategory(U.c1, 'Project Management', 'project-management');
  await seedCategory(U.c2, 'Design', 'design');
  await seedProduct({ id: U.p1, slug: 'a', name: 'A', integrationCount: 5, createdAt: within7d });
  await seedProduct({ id: U.p2, slug: 'b', name: 'B', integrationCount: 9, createdAt: within30d });
  await seedProduct({ id: p3, slug: 'c', name: 'C', createdAt: old });
  await seedProduct({ id: p4, slug: 'd', name: 'D', createdAt: old });
  await linkCategory(U.p1, U.c1);
  await linkCategory(U.p2, U.c2);
  // i-1 in-window: source→c-1, target→c-2 (each category counts 1).
  await seedIntegration({
    id: U.i1,
    sourceProductId: U.p1,
    targetProductId: U.p2,
    createdAt: within7d,
  });
  // i-2 stale (outside 30d), uncategorized endpoints — touches no category.
  await seedIntegration({
    id: U.i2,
    sourceProductId: p3,
    targetProductId: p4,
    createdAt: old,
  });
  await seedPageView(U.p1, within7d);
}

/** Read back a written `stats_cache` value by key (null if absent). */
async function cached(key: string): Promise<unknown> {
  const [row] = await t.db.select().from(statsCache).where(eq(statsCache.key, key));
  return row?.value ?? null;
}

async function hasCached(key: string): Promise<boolean> {
  const rows = await t.db.select().from(statsCache).where(eq(statsCache.key, key));
  return rows.length > 0;
}

describe('runHomeStats', () => {
  it('writes all eleven home.* keys with values that pass their own schema', async () => {
    await seedFullFixture();
    // Coverage counts (AECI-271 + AECI-284): the fixture has 4 products, 0 vendors,
    // and 0 reviews — add two approved reviews (each with a distinct firm) + one
    // vendor so the scalars are non-zero.
    await seedVendor(U.c1);
    await seedReview(U.i1, U.p1, 'approved', 'Acme Architects');
    await seedReview(U.i2, U.p1, 'approved', 'Beacon Structural');

    const result = await runHomeStats(t.db, NOW);

    const written = result.keys.filter((k) => k.status === 'written').map((k) => k.key);
    expect(written).toEqual([
      'home.total_integrations',
      'home.integrations_added_30d',
      'home.total_products',
      'home.total_vendors',
      'home.total_reviews',
      'home.total_contributing_firms',
      'home.most_integrated_product',
      'home.most_active_category',
      'home.recent_integrations',
      'home.trending_products',
      'home.recently_added_products',
    ]);

    // Every cached value round-trips its source-of-truth schema (the §10 contract).
    const rows = await t.db.select().from(statsCache);
    for (const { key, value } of rows) {
      const schema = statsCacheValueSchemas[key as keyof typeof statsCacheValueSchemas];
      expect(schema.safeParse(value).success, `${key} failed its schema`).toBe(true);
    }

    expect(await cached('home.total_integrations')).toBe(2);
    expect(await cached('home.integrations_added_30d')).toBe(1);
    expect(await cached('home.total_products')).toBe(4);
    expect(await cached('home.total_vendors')).toBe(1);
    expect(await cached('home.total_reviews')).toBe(2);
    expect(await cached('home.total_contributing_firms')).toBe(2);
    expect(await cached('home.most_integrated_product')).toMatchObject({ integration_count: 9 });
    expect(await cached('home.most_active_category')).toMatchObject({ integration_count: 1 });
  });

  it('skips most_integrated_product / most_active_category on an empty DB (no throw)', async () => {
    const result = await runHomeStats(t.db, NOW); // empty DB

    const byKey = new Map(result.keys.map((k) => [k.key, k.status]));
    expect(byKey.get('home.most_integrated_product')).toBe('skipped');
    expect(byKey.get('home.most_active_category')).toBe('skipped');
    // Scalar / list keys still write — 0 and [] are valid values.
    expect(await cached('home.total_integrations')).toBe(0);
    expect(await cached('home.total_products')).toBe(0);
    expect(await cached('home.total_vendors')).toBe(0);
    expect(await cached('home.total_reviews')).toBe(0);
    expect(await cached('home.total_contributing_firms')).toBe(0);
    expect(await cached('home.trending_products')).toEqual([]);
    expect(await hasCached('home.most_integrated_product')).toBe(false);
  });

  it('empty page_views → home.trending_products = [] without throwing', async () => {
    await seedFullFixture();
    // Drop the seeded page view so trending resolves to [].
    await t.db.delete(pageViews);

    const result = await runHomeStats(t.db, NOW);

    expect(result.keys.find((k) => k.key === 'home.trending_products')?.status).toBe('written');
    expect(await cached('home.trending_products')).toEqual([]);
  });

  it('isolates a failing key — the rest still write (partial failure)', async () => {
    await seedFullFixture();
    // Force the most_integrated_product producer to throw: stub the relational
    // query builder's products.findFirst (the only call that path makes).
    const original = t.db.query.products.findFirst;
    const spy = vi.spyOn(t.db.query.products, 'findFirst').mockImplementationOnce(() => {
      throw new Error('findFirst boom');
    });

    const result = await runHomeStats(t.db, NOW);
    spy.mockRestore();
    expect(t.db.query.products.findFirst).toBe(original);

    const failed = result.keys.find((k) => k.key === 'home.most_integrated_product');
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toContain('findFirst boom');
    expect(await hasCached('home.most_integrated_product')).toBe(false);
    // The ten other keys still wrote despite the one failure (total_contributing_firms
    // writes a valid 0 when the fixture has no firmed reviews).
    expect(result.keys.filter((k) => k.status === 'written')).toHaveLength(10);
  });

  it('never throws and always returns an outcome per key', async () => {
    await seedFullFixture();
    const result = await runHomeStats(t.db, NOW);
    expect(result.keys).toHaveLength(11);
  });

  it('records a non-negative per-key durationMs for every key (AECI-180)', async () => {
    await seedFullFixture();
    const result = await runHomeStats(t.db, NOW);
    expect(result.keys.every((k) => typeof k.durationMs === 'number' && k.durationMs >= 0)).toBe(
      true,
    );
  });
});
