/**
 * GET /api/products (list + detail) on the Drizzle/D1 path (ADR 0016 / AECI-253).
 * Runs the real handlers against the in-memory D1 harness (`makeTestDb`): seed
 * real rows, assert real query + mapper output. Replaces the retired Prisma-mock
 * suite.
 *
 * NOTE: public visibility filtering (`promotion_status = 'promoted'`, the RLS
 * replacement) is added systematically in Phase 3 (AECI-254); these tests seed
 * promoted rows and exercise the mechanical query/hydration/sort/filter behavior.
 */

import { ProductDetailSchema, ProductsListResponseSchema } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  attestations,
  claims,
  integrations,
  productAudiences,
  productCategories,
  productPhases,
  products,
  productTrades,
  productVendors,
  reviews,
  taxonomyAudiences,
  taxonomyCategories,
  taxonomyDataObjects,
  taxonomyPhases,
  taxonomyTrades,
  vendors,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createProductDetailHandler, createProductsListHandler } from './products';

// Valid UUIDs (the response schema validates `id` as a uuid; prod ids are real).
const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

const listApp = () =>
  buildAppWithHandler({
    method: 'get',
    path: '/api/products',
    handler: createProductsListHandler(t.factory),
  });
const detailApp = () =>
  buildAppWithHandler({
    method: 'get',
    path: '/api/products/:slug',
    handler: createProductDetailHandler(t.factory),
  });
const get = (app: ReturnType<typeof listApp>, url: string) =>
  app.request(url, {}, TEST_ENV, fakeExecutionContext());

async function seedVendor(id: string, slug: string, name: string) {
  await t.db.insert(vendors).values({ id, slug, companyName: name, promotionStatus: 'promoted' });
}
async function seedProduct(
  id: string,
  slug: string,
  name: string,
  extra: Partial<typeof products.$inferInsert> = {},
) {
  await t.db.insert(products).values({ id, slug, name, promotionStatus: 'promoted', ...extra });
}

describe('GET /api/products', () => {
  it('returns the paginated envelope with default sort (created DESC) + id tiebreak', async () => {
    await seedProduct(u(1), 'older', 'Older', { createdAt: '2026-01-01T00:00:00.000Z' });
    await seedProduct(u(2), 'newer', 'Newer', { createdAt: '2026-02-01T00:00:00.000Z' });

    const res = await get(listApp(), '/api/products');
    expect(res.status).toBe(200);
    const parsed = ProductsListResponseSchema.parse(await res.json());
    expect(parsed.page).toBe(1);
    expect(parsed.perPage).toBe(24);
    expect(parsed.total).toBe(2);
    expect(parsed.data.map((p) => p.slug)).toEqual(['newer', 'older']);
  });

  it('hydrates the primary vendor on each list row', async () => {
    await seedVendor(u(11), 'autodesk', 'Autodesk');
    await seedVendor(u(12), 'other', 'Other');
    await seedProduct(u(1), 'revit', 'Revit');
    await t.db
      .insert(productVendors)
      .values({ productId: u(1), vendorId: u(12), isPrimary: false });
    await t.db.insert(productVendors).values({ productId: u(1), vendorId: u(11), isPrimary: true });

    const parsed = ProductsListResponseSchema.parse(
      await (await get(listApp(), '/api/products')).json(),
    );
    expect(parsed.data[0]?.vendor).toMatchObject({ slug: 'autodesk', name: 'Autodesk' });
  });

  it('resolves primary_category to the lowest display_order (null vendor stays null)', async () => {
    await seedProduct(u(1), 'revit', 'Revit');
    await t.db.insert(taxonomyCategories).values([
      { id: u(21), slug: 'zeta', name: 'Zeta', displayOrder: 90 },
      { id: u(22), slug: 'alpha', name: 'Alpha', displayOrder: 10 },
    ]);
    await t.db.insert(productCategories).values([
      { productId: u(1), categoryId: u(21) },
      { productId: u(1), categoryId: u(22) },
    ]);

    const parsed = ProductsListResponseSchema.parse(
      await (await get(listApp(), '/api/products')).json(),
    );
    expect(parsed.data[0]?.primary_category?.slug).toBe('alpha');
    expect(parsed.data[0]?.vendor).toBeNull();
  });

  it('paginates and sorts by name', async () => {
    for (const [i, n] of ['Charlie', 'Alpha', 'Bravo'].entries()) {
      await seedProduct(u(i + 1), n.toLowerCase(), n);
    }
    const parsed = ProductsListResponseSchema.parse(
      await (await get(listApp(), '/api/products?sort=name&perPage=2&page=1')).json(),
    );
    expect(parsed.data.map((p) => p.name)).toEqual(['Alpha', 'Bravo']);
    expect(parsed.total).toBe(3);
  });

  it('sorts by review count desc (Most reviewed)', async () => {
    await seedProduct(u(1), 'few', 'Few', { reviewCount: 3 });
    await seedProduct(u(2), 'many', 'Many', { reviewCount: 12 });
    await seedProduct(u(3), 'none', 'None', { reviewCount: 0 });

    const parsed = ProductsListResponseSchema.parse(
      await (await get(listApp(), '/api/products?sort=reviews')).json(),
    );
    expect(parsed.data.map((p) => p.slug)).toEqual(['many', 'few', 'none']);
  });

  it('sorts by rating desc and ranks sub-5-review products last (Highest rated, §5.5 gate)', async () => {
    await seedProduct(u(1), 'good', 'Good', { reviewCount: 10, ratingOverallAvg: 4.0 });
    await seedProduct(u(2), 'best', 'Best', { reviewCount: 8, ratingOverallAvg: 4.8 });
    // 5.0 average but only 2 reviews — withheld by the §5.5 gate, so it ranks
    // last despite the highest raw average (statistically misleading otherwise).
    await seedProduct(u(3), 'hidden', 'Hidden', { reviewCount: 2, ratingOverallAvg: 5.0 });
    await seedProduct(u(4), 'ok', 'Ok', { reviewCount: 6, ratingOverallAvg: 3.0 });

    const parsed = ProductsListResponseSchema.parse(
      await (await get(listApp(), '/api/products?sort=rating')).json(),
    );
    expect(parsed.data.map((p) => p.slug)).toEqual(['best', 'good', 'ok', 'hidden']);
  });

  it('applies the §5.5 gate to list rows: withholds sub-5 averages, keeps ≥5', async () => {
    await seedProduct(u(1), 'shown', 'Shown', {
      reviewCount: 5,
      ratingOverallAvg: 4.2,
      ratingOnboardingAvg: 3.8,
    });
    await seedProduct(u(2), 'hidden', 'Hidden', {
      reviewCount: 4,
      ratingOverallAvg: 4.9,
      ratingOnboardingAvg: 4.7,
    });

    const parsed = ProductsListResponseSchema.parse(
      await (await get(listApp(), '/api/products?sort=name')).json(),
    );
    const bySlug = new Map(parsed.data.map((p) => [p.slug, p]));

    // ≥5 reviews → averages visible, so the card shows the same value the
    // detail page does.
    expect(bySlug.get('shown')?.rating_overall_avg).toBe(4.2);
    expect(bySlug.get('shown')?.rating_onboarding_avg).toBe(3.8);
    // <5 reviews → averages withheld (statistically misleading), but the
    // review_count itself stays truthful.
    expect(bySlug.get('hidden')?.rating_overall_avg).toBeNull();
    expect(bySlug.get('hidden')?.rating_onboarding_avg).toBeNull();
    expect(bySlug.get('hidden')?.review_count).toBe(4);
  });

  it('filters by category_id and by search', async () => {
    await seedProduct(u(1), 'revit', 'Revit');
    await seedProduct(u(2), 'autocad', 'AutoCAD');
    await t.db
      .insert(taxonomyCategories)
      .values({ id: u(21), slug: 'bim', name: 'BIM', displayOrder: 10 });
    await t.db.insert(productCategories).values({ productId: u(1), categoryId: u(21) });

    const byCat = ProductsListResponseSchema.parse(
      await (await get(listApp(), `/api/products?category_id=${u(21)}`)).json(),
    );
    expect(byCat.data.map((p) => p.slug)).toEqual(['revit']);

    const bySearch = ProductsListResponseSchema.parse(
      await (await get(listApp(), '/api/products?search=auto')).json(),
    );
    expect(bySearch.data.map((p) => p.slug)).toEqual(['autocad']);
  });

  // AECI-541 — `trade_id` is the fourth taxonomy dimension and carries the exact
  // AECI-223 semantics of the other three: OR within the dimension, AND across.
  describe('trade_id filtering (§5.5a)', () => {
    beforeEach(async () => {
      // accubid ∈ {electrical}; roofsnap ∈ {roofing}; procore ∈ {} (horizontal
      // platform — untagged by design); dual ∈ {electrical, roofing}.
      await seedProduct(u(1), 'accubid', 'Accubid');
      await seedProduct(u(2), 'roofsnap', 'RoofSnap');
      await seedProduct(u(3), 'procore', 'Procore');
      await seedProduct(u(4), 'dual', 'Dual Trade Tool');
      await t.db.insert(taxonomyTrades).values([
        {
          id: u(71),
          slug: 'electrical',
          name: 'Electrical',
          description: 'Power distribution.',
          displayOrder: 10,
        },
        {
          id: u(72),
          slug: 'roofing',
          name: 'Roofing',
          description: 'Roof systems.',
          displayOrder: 20,
        },
      ]);
      await t.db.insert(productTrades).values([
        { productId: u(1), tradeId: u(71) },
        { productId: u(2), tradeId: u(72) },
        { productId: u(4), tradeId: u(71) },
        { productId: u(4), tradeId: u(72) },
      ]);
    });

    const slugs = async (url: string) =>
      ProductsListResponseSchema.parse(await (await get(listApp(), url)).json())
        .data.map((p) => p.slug)
        .sort();

    it('filters to a single trade id', async () => {
      expect(await slugs(`/api/products?trade_id=${u(71)}`)).toEqual(['accubid', 'dual']);
    });

    it('ORs within the dimension for a comma-separated id list', async () => {
      expect(await slugs(`/api/products?trade_id=${u(71)},${u(72)}`)).toEqual([
        'accubid',
        'dual',
        'roofsnap',
      ]);
    });

    it('ANDs across dimensions when combined with another facet', async () => {
      await t.db
        .insert(taxonomyCategories)
        .values({ id: u(81), slug: 'estimating', name: 'Estimating', displayOrder: 10 });
      // Only accubid carries BOTH the electrical trade and the estimating category.
      await t.db.insert(productCategories).values([
        { productId: u(1), categoryId: u(81) },
        { productId: u(2), categoryId: u(81) },
      ]);

      expect(await slugs(`/api/products?trade_id=${u(71)}&category_id=${u(81)}`)).toEqual([
        'accubid',
      ]);
    });

    it('returns an empty page for a trade nothing carries, and the full list when omitted', async () => {
      await t.db.insert(taxonomyTrades).values({
        id: u(73),
        slug: 'paving-asphalt',
        name: 'Paving & Asphalt',
        description: 'Pavement.',
        displayOrder: 30,
      });
      const empty = ProductsListResponseSchema.parse(
        await (await get(listApp(), `/api/products?trade_id=${u(73)}`)).json(),
      );
      expect(empty.data).toEqual([]);
      expect(empty.total).toBe(0);

      // No `trade_id` → the untagged horizontal platform is still listed.
      expect(await slugs('/api/products')).toContain('procore');
    });

    it('rejects a malformed trade_id with a 400', async () => {
      expect((await get(listApp(), '/api/products?trade_id=not-a-uuid')).status).toBe(400);
    });
  });
});

describe('GET /api/products/:slug', () => {
  it('hydrates detail: taxonomy + both integration sides + approved reviews only', async () => {
    await seedProduct(u(1), 'revit', 'Revit', { reviewCount: 5, ratingOverallAvg: 4.2 });
    await seedProduct(u(2), 'navisworks', 'Navisworks');
    await t.db
      .insert(taxonomyCategories)
      .values({ id: u(21), slug: 'bim', name: 'BIM', displayOrder: 10 });
    await t.db
      .insert(taxonomyAudiences)
      .values({ id: u(31), slug: 'arch', name: 'Architecture', displayOrder: 10 });
    await t.db
      .insert(taxonomyPhases)
      .values({ id: u(41), slug: 'design', name: 'Design', displayOrder: 20 });
    await t.db.insert(taxonomyTrades).values({
      id: u(42),
      slug: 'electrical',
      name: 'Electrical',
      description: 'Power distribution.',
      displayOrder: 10,
    });
    await t.db.insert(productCategories).values({ productId: u(1), categoryId: u(21) });
    await t.db.insert(productAudiences).values({ productId: u(1), audienceId: u(31) });
    await t.db.insert(productPhases).values({ productId: u(1), phaseId: u(41) });
    await t.db.insert(productTrades).values({ productId: u(1), tradeId: u(42) });
    await t.db
      .insert(integrations)
      .values({ id: u(51), sourceProductId: u(1), targetProductId: u(2), mechanismKind: 'native' });
    await t.db.insert(reviews).values([
      {
        id: u(61),
        productId: u(1),
        ratingOverall: 5,
        ratingOnboarding: 4,
        title: 'Great',
        body: 'Yes',
        status: 'approved',
      },
      {
        id: u(62),
        productId: u(1),
        ratingOverall: 1,
        ratingOnboarding: 1,
        title: 'Pending',
        body: 'No',
        status: 'pending',
      },
    ]);

    const res = await get(detailApp(), '/api/products/revit');
    expect(res.status).toBe(200);
    const detail = ProductDetailSchema.parse(await res.json());
    expect(detail.categories.map((c) => c.slug)).toEqual(['bim']);
    expect(detail.audiences.map((a) => a.slug)).toEqual(['arch']);
    expect(detail.phases.map((p) => p.slug)).toEqual(['design']);
    expect(detail.trades.map((x) => x.slug)).toEqual(['electrical']);
    expect(detail.integrations_as_source.map((i) => i.id)).toEqual([u(51)]);
    // ≥5 approved reviews → averages visible; only the approved review is embedded.
    expect(detail.rating_overall_avg).toBe(4.2);
    expect(detail.reviews.map((r) => r.id)).toEqual([u(61)]);
  });

  it('returns trades: [] for an untagged horizontal platform (the sparse default, §5.5a)', async () => {
    await seedProduct(u(1), 'procore', 'Procore');
    await t.db.insert(taxonomyTrades).values({
      id: u(42),
      slug: 'electrical',
      name: 'Electrical',
      description: 'Power distribution.',
      displayOrder: 10,
    });

    const detail = ProductDetailSchema.parse(
      await (await get(detailApp(), '/api/products/procore')).json(),
    );
    expect(detail.trades).toEqual([]);
  });

  it('hydrates integrations_as_connector for a powered-by product (Stage 1.5 Addendum B)', async () => {
    await seedProduct(u(1), 'agave-erp-sync', 'Agave ERP Sync', { productRole: 'connector' });
    await seedProduct(u(2), 'procore', 'Procore');
    await seedProduct(u(3), 'sage-intacct', 'Sage Intacct');
    // The connector is the mechanism, NOT an endpoint of the edge.
    await t.db.insert(integrations).values({
      id: u(51),
      sourceProductId: u(2),
      targetProductId: u(3),
      mechanismKind: 'marketplace-app',
      poweredByProductId: u(1),
    });

    const connector = ProductDetailSchema.parse(
      await (await get(detailApp(), '/api/products/agave-erp-sync')).json(),
    );
    // The powered edge lands in the connector bucket with both endpoints hydrated…
    expect(connector.integrations_as_connector.map((i) => i.id)).toEqual([u(51)]);
    expect(connector.integrations_as_connector[0]?.source.slug).toBe('procore');
    expect(connector.integrations_as_connector[0]?.target.slug).toBe('sage-intacct');
    // …and NOT in the endpoint buckets (the connector terminates neither side).
    expect(connector.integrations_as_source).toEqual([]);
    expect(connector.integrations_as_target).toEqual([]);

    // The endpoints see the edge only as an endpoint edge — their connector
    // bucket stays empty.
    const endpoint = ProductDetailSchema.parse(
      await (await get(detailApp(), '/api/products/procore')).json(),
    );
    expect(endpoint.integrations_as_source.map((i) => i.id)).toEqual([u(51)]);
    expect(endpoint.integrations_as_connector).toEqual([]);
  });

  it('derives the table Direction from claims when the row direction is null (§3.2 — regression: table matched "–" while the pair page said "Syncs both ways")', async () => {
    await seedProduct(u(1), 'egnyte', 'Egnyte'); // context product (integration source)
    await seedProduct(u(2), 'procore', 'Procore'); // the other endpoint (target)
    // The reported bug's shape: a mechanism row with NO stored direction column...
    await t.db
      .insert(integrations)
      .values({ id: u(51), sourceProductId: u(1), targetProductId: u(2) });
    await t.db.insert(taxonomyDataObjects).values([
      { id: u(71), slug: 'drawings', name: 'Drawings' },
      { id: u(72), slug: 'rfis', name: 'RFIs' },
    ]);
    // ...but whose data_object claims all flow both ways (what the pair page reads).
    await t.db.insert(claims).values([
      { id: u(81), integrationId: u(51), dataObjectId: u(71), direction: 'both' },
      { id: u(82), integrationId: u(51), dataObjectId: u(72), direction: 'both' },
    ]);

    const detail = ProductDetailSchema.parse(
      await (await get(detailApp(), '/api/products/egnyte')).json(),
    );
    const row = detail.integrations_as_source[0];
    // Stored row direction is still null (unchanged — the mapper never rewrites it)...
    expect(row?.direction).toBeNull();
    // ...but the effective, claims-aware context direction is 'both' — so the
    // table now shows the same ⇄ the pair page does, not an em-dash.
    expect(row?.context_direction).toBe('both');
  });

  it('frames a one-way claim relative to the page product (outbound from source, inbound from target)', async () => {
    await seedProduct(u(1), 'egnyte', 'Egnyte');
    await seedProduct(u(2), 'procore', 'Procore');
    // source=egnyte, target=procore; a_to_b flows source→target.
    await t.db
      .insert(integrations)
      .values({ id: u(51), sourceProductId: u(1), targetProductId: u(2) });
    await t.db
      .insert(taxonomyDataObjects)
      .values({ id: u(71), slug: 'drawings', name: 'Drawings' });
    await t.db
      .insert(claims)
      .values({ id: u(81), integrationId: u(51), dataObjectId: u(71), direction: 'a_to_b' });

    // Viewed from egnyte (the source) → outbound.
    const fromSource = ProductDetailSchema.parse(
      await (await get(detailApp(), '/api/products/egnyte')).json(),
    );
    expect(fromSource.integrations_as_source[0]?.context_direction).toBe('outbound');

    // Viewed from procore (the target) → inbound (the mirror), same claim.
    const fromTarget = ProductDetailSchema.parse(
      await (await get(detailApp(), '/api/products/procore')).json(),
    );
    expect(fromTarget.integrations_as_target[0]?.context_direction).toBe('inbound');
  });

  // §4.3: once every voting vendor denies a flow, it must stop steering the
  // table's arrow — otherwise the table keeps asserting a direction the pair
  // page has already struck through (the §7.1 drift bug, in the other direction).
  it('drops a refuted claim from the effective context direction', async () => {
    await seedProduct(u(1), 'egnyte', 'Egnyte');
    await seedProduct(u(2), 'procore', 'Procore');
    await t.db.insert(vendors).values({ id: u(91), companyName: 'Acme', slug: 'acme' });
    // Stored direction null, so the claims are the only signal.
    await t.db
      .insert(integrations)
      .values({ id: u(51), sourceProductId: u(1), targetProductId: u(2) });
    await t.db.insert(taxonomyDataObjects).values([
      { id: u(71), slug: 'drawings', name: 'Drawings' },
      { id: u(72), slug: 'rfis', name: 'RFIs' },
    ]);
    await t.db.insert(claims).values([
      { id: u(81), integrationId: u(51), dataObjectId: u(71), direction: 'a_to_b' },
      { id: u(82), integrationId: u(51), dataObjectId: u(72), direction: 'b_to_a' },
    ]);
    // The b_to_a claim is denied by the only vendor that voted on it. Without
    // the filter the two opposing claims would aggregate to 'both'.
    await t.db.insert(attestations).values({
      id: u(85),
      claimId: u(82),
      source: 'vendor_a',
      asserted: false,
      attestedByVendorId: u(91),
    });

    const detail = ProductDetailSchema.parse(
      await (await get(detailApp(), '/api/products/egnyte')).json(),
    );
    expect(detail.integrations_as_source[0]?.context_direction).toBe('outbound');
  });

  it('falls back to the stored row direction when every claim is refuted', async () => {
    await seedProduct(u(1), 'egnyte', 'Egnyte');
    await seedProduct(u(2), 'procore', 'Procore');
    await t.db.insert(vendors).values({ id: u(91), companyName: 'Acme', slug: 'acme' });
    await t.db.insert(integrations).values({
      id: u(51),
      sourceProductId: u(1),
      targetProductId: u(2),
      direction: 'bidirectional',
    });
    await t.db
      .insert(taxonomyDataObjects)
      .values({ id: u(71), slug: 'drawings', name: 'Drawings' });
    await t.db
      .insert(claims)
      .values({ id: u(81), integrationId: u(51), dataObjectId: u(71), direction: 'a_to_b' });
    await t.db.insert(attestations).values({
      id: u(85),
      claimId: u(81),
      source: 'vendor_a',
      asserted: false,
      attestedByVendorId: u(91),
    });

    const detail = ProductDetailSchema.parse(
      await (await get(detailApp(), '/api/products/egnyte')).json(),
    );
    // The a_to_b claim is gone, so the stored `bidirectional` wins.
    expect(detail.integrations_as_source[0]?.context_direction).toBe('both');
  });

  // A retracted denial is a withdrawn assertion, not a live "no" — the claim
  // must go back to steering the arrow.
  it('ignores a retracted denial when computing the context direction', async () => {
    await seedProduct(u(1), 'egnyte', 'Egnyte');
    await seedProduct(u(2), 'procore', 'Procore');
    await t.db.insert(vendors).values({ id: u(91), companyName: 'Acme', slug: 'acme' });
    await t.db
      .insert(integrations)
      .values({ id: u(51), sourceProductId: u(1), targetProductId: u(2) });
    await t.db
      .insert(taxonomyDataObjects)
      .values({ id: u(71), slug: 'drawings', name: 'Drawings' });
    await t.db
      .insert(claims)
      .values({ id: u(81), integrationId: u(51), dataObjectId: u(71), direction: 'both' });
    await t.db.insert(attestations).values({
      id: u(85),
      claimId: u(81),
      source: 'vendor_a',
      asserted: false,
      attestedByVendorId: u(91),
      retractedAt: '2026-08-14T00:00:00.000Z',
    });

    const detail = ProductDetailSchema.parse(
      await (await get(detailApp(), '/api/products/egnyte')).json(),
    );
    expect(detail.integrations_as_source[0]?.context_direction).toBe('both');
  });

  it('withholds rating averages below the 5-review gate', async () => {
    await seedProduct(u(1), 'revit', 'Revit', { reviewCount: 4, ratingOverallAvg: 4.2 });
    const detail = ProductDetailSchema.parse(
      await (await get(detailApp(), '/api/products/revit')).json(),
    );
    expect(detail.rating_overall_avg).toBeNull();
  });

  it('404s an unknown slug', async () => {
    const res = await get(detailApp(), '/api/products/nope');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/products/:slug — maintenance marker (AECI-616)', () => {
  it('reports the unreviewed baseline: AECi attribution with no date', async () => {
    await seedProduct(u(1), 'revit', 'Revit');

    const body = ProductDetailSchema.parse(
      await (await get(detailApp(), '/api/products/revit')).json(),
    );
    // `null` here is the honest reading, not missing data — nothing was backfilled
    // from `created_at` / `updated_at` / `promoted_at`, deliberately.
    expect(body.maintenance).toEqual({ maintained_by: 'aeci', last_reviewed_at: null });
  });

  it('surfaces a real review date without touching updated_at', async () => {
    const reviewed = '2026-03-04T00:00:00.000Z';
    await seedProduct(u(1), 'revit', 'Revit', { lastReviewedAt: reviewed });

    const body = ProductDetailSchema.parse(
      await (await get(detailApp(), '/api/products/revit')).json(),
    );
    expect(body.maintenance).toEqual({ maintained_by: 'aeci', last_reviewed_at: reviewed });
    expect(body.updated_at).not.toBe(reviewed);
  });
});
