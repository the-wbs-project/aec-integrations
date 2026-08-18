/**
 * GET /api/vendors (list + detail) on the Drizzle/D1 path (ADR 0016 / AECI-253),
 * against the in-memory D1 harness. Replaces the retired Prisma-mock suite.
 * Visibility filtering (`promotion_status`) is added in Phase 3 (AECI-254).
 */

import { VendorDetailSchema, VendorsListResponseSchema } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { integrations, products, productVendors, vendors } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createVendorDetailHandler, createVendorsListHandler } from './vendors';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

const listApp = () =>
  buildAppWithHandler({
    method: 'get',
    path: '/api/vendors',
    handler: createVendorsListHandler(t.factory),
  });
const detailApp = () =>
  buildAppWithHandler({
    method: 'get',
    path: '/api/vendors/:slug',
    handler: createVendorDetailHandler(t.factory),
  });
const get = (app: ReturnType<typeof listApp>, url: string) =>
  app.request(url, {}, TEST_ENV, fakeExecutionContext());

async function seedVendor(
  id: string,
  slug: string,
  name: string,
  extra: Partial<typeof vendors.$inferInsert> = {},
) {
  await t.db
    .insert(vendors)
    .values({ id, slug, companyName: name, promotionStatus: 'promoted', ...extra });
}

describe('GET /api/vendors', () => {
  it('returns the envelope and derives product/integration counts via extras subqueries', async () => {
    await seedVendor(u(1), 'autodesk', 'Autodesk');
    await t.db.insert(products).values([
      { id: u(11), slug: 'revit', name: 'Revit', promotionStatus: 'promoted' },
      { id: u(12), slug: 'autocad', name: 'AutoCAD', promotionStatus: 'promoted' },
    ]);
    await t.db.insert(productVendors).values([
      { productId: u(11), vendorId: u(1), isPrimary: true },
      { productId: u(12), vendorId: u(1), isPrimary: true },
    ]);
    await t.db
      .insert(integrations)
      .values({ id: u(21), sourceProductId: u(11), targetProductId: u(12), builtByVendorId: u(1) });

    const parsed = VendorsListResponseSchema.parse(
      await (await get(listApp(), '/api/vendors')).json(),
    );
    expect(parsed.total).toBe(1);
    expect(parsed.data[0]?.product_count).toBe(2);
    expect(parsed.data[0]?.integration_count).toBe(1);
  });

  it('filters by search and by verified', async () => {
    await seedVendor(u(1), 'autodesk', 'Autodesk', { verified: true });
    await seedVendor(u(2), 'bentley', 'Bentley Systems', { verified: false });

    const bySearch = VendorsListResponseSchema.parse(
      await (await get(listApp(), '/api/vendors?search=bentley')).json(),
    );
    expect(bySearch.data.map((v) => v.slug)).toEqual(['bentley']);

    const byVerified = VendorsListResponseSchema.parse(
      await (await get(listApp(), '/api/vendors?verified=true')).json(),
    );
    expect(byVerified.data.map((v) => v.slug)).toEqual(['autodesk']);
  });
});

describe('GET /api/vendors/:slug', () => {
  it('hydrates detail: embedded products + github_url derived from the org handle', async () => {
    await seedVendor(u(1), 'autodesk', 'Autodesk', { githubOrg: 'Autodesk' });
    await t.db
      .insert(products)
      .values({ id: u(11), slug: 'revit', name: 'Revit', promotionStatus: 'promoted' });
    await t.db.insert(productVendors).values({ productId: u(11), vendorId: u(1), isPrimary: true });

    const res = await get(detailApp(), '/api/vendors/autodesk');
    expect(res.status).toBe(200);
    const detail = VendorDetailSchema.parse(await res.json());
    expect(detail.products.map((p) => p.slug)).toEqual(['revit']);
  });

  it('404s an unknown slug', async () => {
    expect((await get(detailApp(), '/api/vendors/nope')).status).toBe(404);
  });
});

describe('GET /api/vendors/:slug — maintenance marker (AECI-616)', () => {
  it('reports the unreviewed baseline: AECi attribution with no date', async () => {
    await seedVendor(u(1), 'autodesk', 'Autodesk');

    const res = await get(detailApp(), '/api/vendors/autodesk');
    const detail = VendorDetailSchema.parse(await res.json());
    expect(detail.maintenance).toEqual({ maintained_by: 'aeci', last_reviewed_at: null });
  });

  it('surfaces a real review date, distinct from the verified ACCOUNT bit', async () => {
    const reviewed = '2026-03-04T00:00:00.000Z';
    await seedVendor(u(1), 'autodesk', 'Autodesk', { lastReviewedAt: reviewed, verified: false });

    const res = await get(detailApp(), '/api/vendors/autodesk');
    const detail = VendorDetailSchema.parse(await res.json());
    // Two different signals on one page: `verified` is an AECi-verified vendor
    // ACCOUNT, `maintenance` is who maintains the catalog record.
    expect(detail.verified).toBe(false);
    expect(detail.maintenance).toEqual({ maintained_by: 'aeci', last_reviewed_at: reviewed });
  });
});
