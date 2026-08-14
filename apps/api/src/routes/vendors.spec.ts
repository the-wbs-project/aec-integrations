/**
 * GET /api/vendors (list + detail) on the Drizzle/D1 path (ADR 0016 / AECI-253),
 * against the in-memory D1 harness. Replaces the retired Prisma-mock suite.
 * Visibility filtering (`promotion_status`) is added in Phase 3 (AECI-254).
 */

import { VendorDetailSchema, VendorsListResponseSchema } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { integrations, products, productVendors, vendorEntitlements, vendors } from '../db/schema';
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

  it('?verified= reads the MIRROR, never vendor_entitlements (AECI-609 §2.5 / R9)', async () => {
    // The whole epic is additive because no read path touches the entitlement table:
    // `vendors.verified` is a denormalized mirror and this filter keeps reading it.
    // Seeding a DELIBERATELY DRIFTED pair is what makes that provable rather than
    // asserted — if someone "improves" the filter by joining vendor_entitlements so it
    // reads the truth, the expectation below flips and this test fails. That
    // improvement would defeat the entire denormalization (§2.5).
    await seedVendor(u(1), 'autodesk', 'Autodesk', { verified: true }); // no entitlement row
    await seedVendor(u(2), 'procore', 'Procore', { verified: false });
    await t.db.insert(vendorEntitlements).values({
      vendorId: u(2), // an ACTIVE entitlement whose mirror was never flipped
      tier: 'verified',
      status: 'active',
      grantedAt: '2026-01-01T00:00:00.000Z',
    });

    const res = VendorsListResponseSchema.parse(
      await (await get(listApp(), '/api/vendors?verified=true')).json(),
    );
    expect(res.data.map((v) => v.slug)).toEqual(['autodesk']);
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
