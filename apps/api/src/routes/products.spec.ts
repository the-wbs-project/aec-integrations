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
  integrations,
  productAudiences,
  productCategories,
  productPhases,
  products,
  productVendors,
  reviews,
  taxonomyAudiences,
  taxonomyCategories,
  taxonomyPhases,
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
    await t.db.insert(productCategories).values({ productId: u(1), categoryId: u(21) });
    await t.db.insert(productAudiences).values({ productId: u(1), audienceId: u(31) });
    await t.db.insert(productPhases).values({ productId: u(1), phaseId: u(41) });
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
    expect(detail.integrations_as_source.map((i) => i.id)).toEqual([u(51)]);
    // ≥5 approved reviews → averages visible; only the approved review is embedded.
    expect(detail.rating_overall_avg).toBe(4.2);
    expect(detail.reviews.map((r) => r.id)).toEqual([u(61)]);
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
