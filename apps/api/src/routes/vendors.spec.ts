/**
 * GET /api/vendors (list + detail) on the Drizzle/D1 path (ADR 0016 / AECI-253),
 * against the in-memory D1 harness. Replaces the retired Prisma-mock suite.
 * Visibility filtering (`promotion_status`) is added in Phase 3 (AECI-254).
 */

import { VendorDetailSchema, VendorsListResponseSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fieldOverrides, integrations, products, productVendors, vendors } from '../db/schema';
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

  it('filters by search', async () => {
    await seedVendor(u(1), 'autodesk', 'Autodesk');
    await seedVendor(u(2), 'bentley', 'Bentley Systems');

    const bySearch = VendorsListResponseSchema.parse(
      await (await get(listApp(), '/api/vendors?search=bentley')).json(),
    );
    expect(bySearch.data.map((v) => v.slug)).toEqual(['bentley']);
  });

  // AECI-1266: the `?verified=` filter listed the vendors on a paid plan. It is
  // retired. A stale param is ignored, not rejected, and no row carries the mirror.
  it('ignores ?verified= and returns the unfiltered list with no plan mirror', async () => {
    await seedVendor(u(1), 'autodesk', 'Autodesk', { verified: true });
    await seedVendor(u(2), 'bentley', 'Bentley Systems', { verified: false });

    for (const query of ['?verified=true', '?verified=false']) {
      const res = await get(listApp(), `/api/vendors${query}&sort=name`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Record<string, unknown>[] };
      expect(body.data.map((v) => v['slug'])).toEqual(['autodesk', 'bentley']);
      for (const row of body.data) expect(row).not.toHaveProperty('verified');
    }
  });
});

describe('GET /api/vendors/:slug', () => {
  it('lists the vendor products A to Z by name, ignoring case (AECI-1242)', async () => {
    await seedVendor(u(1), 'autodesk', 'Autodesk');
    await t.db.insert(products).values([
      { id: u(11), slug: 'forma', name: 'Forma for Buildings', promotionStatus: 'promoted' },
      { id: u(12), slug: 'autocad-mep', name: 'AutoCAD MEP', promotionStatus: 'promoted' },
      { id: u(13), slug: 'civil-3d', name: 'civil 3D', promotionStatus: 'promoted' },
      { id: u(14), slug: 'autocad', name: 'AutoCAD', promotionStatus: 'promoted' },
    ]);
    await t.db
      .insert(productVendors)
      .values([11, 12, 13, 14].map((n) => ({ productId: u(n), vendorId: u(1), isPrimary: true })));

    const detail = VendorDetailSchema.parse(
      await (await get(detailApp(), '/api/vendors/autodesk')).json(),
    );
    expect(detail.products.map((p) => p.slug)).toEqual([
      'autocad',
      'autocad-mep',
      'civil-3d',
      'forma',
    ]);
  });

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

describe('GET /api/vendors/:slug — corrections (AECI-1614)', () => {
  const correction = {
    entityType: 'vendor',
    entityId: u(1),
    field: 'website',
    reason: 'SECRET-REASON',
    internalNote: 'SECRET-NOTE',
    setBy: 'SECRET-ADMIN',
    vendorId: 'SECRET-VENDOR',
    setAt: '2026-06-01T00:00:00.000Z',
  };

  it('shows a correction still true, lifted or not, and no private field', async () => {
    await seedVendor(u(1), 'autodesk', 'Autodesk', { website: 'https://right.example' });
    await t.db.insert(fieldOverrides).values({
      ...correction,
      id: u(50),
      value: 'https://right.example',
      sourceUrl: 'https://source.example',
      liftedAt: '2026-07-01T00:00:00.000Z',
      liftReason: 'SECRET-LIFT',
    });
    const res = await get(detailApp(), '/api/vendors/autodesk');
    const text = await res.text();
    expect(text).not.toContain('SECRET');
    expect(VendorDetailSchema.parse(JSON.parse(text)).corrections).toEqual([
      {
        field: 'website',
        date: correction.setAt,
        source_url: 'https://source.example',
        cleared: false,
      },
    ]);
  });

  it('drops a correction once the value moved on', async () => {
    await seedVendor(u(1), 'autodesk', 'Autodesk', { website: 'https://vendor.example' });
    await t.db
      .insert(fieldOverrides)
      .values({ ...correction, id: u(50), value: 'https://right.example' });
    const res = await get(detailApp(), '/api/vendors/autodesk');
    expect(VendorDetailSchema.parse(await res.json()).corrections).toEqual([]);
  });

  it('still answers 404 for an unknown slug inside the batch', async () => {
    expect((await get(detailApp(), '/api/vendors/nobody')).status).toBe(404);
  });

  it('captions a logo replacement and marks a removal as cleared (AECI-1628)', async () => {
    await seedVendor(u(1), 'autodesk', 'Autodesk', {
      logoUrl: 'https://logo.example/mark.png',
      headquarters: null,
    });
    await t.db.insert(fieldOverrides).values([
      {
        ...correction,
        id: u(50),
        field: 'logo_url',
        value: 'https://logo.example/mark.png',
        sourceUrl: 'https://brand.example/kit',
        liftedAt: correction.setAt,
        liftReason: 'record-only',
      },
      { ...correction, id: u(51), field: 'headquarters', value: null },
    ]);
    const res = await get(detailApp(), '/api/vendors/autodesk');
    expect(VendorDetailSchema.parse(await res.json()).corrections).toEqual([
      { field: 'headquarters', date: correction.setAt, source_url: null, cleared: true },
      {
        field: 'logo_url',
        date: correction.setAt,
        source_url: 'https://brand.example/kit',
        cleared: false,
      },
    ]);
  });

  it('drops a logo correction once the vendor replaced the logo', async () => {
    await seedVendor(u(1), 'autodesk', 'Autodesk', { logoUrl: 'https://vendor.example/new.png' });
    await t.db.insert(fieldOverrides).values({
      ...correction,
      id: u(50),
      field: 'logo_url',
      value: 'https://logo.example/mark.png',
      liftedAt: correction.setAt,
    });
    const res = await get(detailApp(), '/api/vendors/autodesk');
    expect(VendorDetailSchema.parse(await res.json()).corrections).toEqual([]);
  });
});

describe('GET /api/vendors/:slug — maintenance marker (AECI-616)', () => {
  it('reports the unreviewed baseline: AECi attribution with no date', async () => {
    await seedVendor(u(1), 'autodesk', 'Autodesk');

    const res = await get(detailApp(), '/api/vendors/autodesk');
    const detail = VendorDetailSchema.parse(await res.json());
    expect(detail.maintenance).toEqual({ maintained_by: 'aeci', last_reviewed_at: null });
  });

  it('surfaces a real review date, and never the plan mirror (AECI-1266)', async () => {
    const reviewed = '2026-03-04T00:00:00.000Z';
    await seedVendor(u(1), 'autodesk', 'Autodesk', { lastReviewedAt: reviewed, verified: true });

    const res = await get(detailApp(), '/api/vendors/autodesk');
    const body = (await res.json()) as Record<string, unknown>;
    // `maintenance` is who maintains the catalog record. The plan mirror is never
    // public, even for a vendor whose mirror is set.
    expect(body).not.toHaveProperty('verified');
    const detail = VendorDetailSchema.parse(body);
    expect(detail.maintenance).toEqual({ maintained_by: 'aeci', last_reviewed_at: reviewed });
  });

  it('reports the VENDOR branch once a vendor save has taken the record (AECI-981)', async () => {
    // The state `PATCH /api/vendor/profile` now writes — see the product sibling.
    const updated = '2026-09-16T00:00:00.000Z';
    await seedVendor(u(1), 'autodesk', 'Autodesk', {
      maintainedBy: 'vendor',
      lastReviewedAt: updated,
    });

    const res = await get(detailApp(), '/api/vendors/autodesk');
    const detail = VendorDetailSchema.parse(await res.json());
    expect(detail.maintenance).toEqual({ maintained_by: 'vendor', last_reviewed_at: updated });
  });
});

describe('GET /api/vendors/:slug — company facts (AECI-1310)', () => {
  it('applies the display rule, and keeps facts off the list response', async () => {
    const id = '00000000-0000-4000-8000-000000000a10';
    await seedVendor(id, 'facts-co', 'Facts Co');
    await t.db
      .update(vendors)
      .set({
        companySize: '51-200',
        companySizeSourceUrl: 'https://facts.example/about',
        companySizeCheckedAt: '2026-11-04T00:00:00.000Z',
        parentCompany: 'Unsourced Holdings',
      })
      .where(eq(vendors.id, id));

    const detail = VendorDetailSchema.parse(
      await (await get(detailApp(), '/api/vendors/facts-co')).json(),
    );
    expect(detail.company_facts.company_size).toEqual({
      value: '51-200',
      source: {
        set_by: 'aeci',
        date: '2026-11-04T00:00:00.000Z',
        url: 'https://facts.example/about',
      },
    });
    expect(detail.company_facts.parent_company).toBeNull();

    const list = (await (await get(listApp(), '/api/vendors')).json()) as { data: object[] };
    expect(JSON.stringify(list.data)).not.toContain('company_facts');
    expect(JSON.stringify(list.data)).not.toContain('Unsourced Holdings');
  });

  it('names the vendor on an owned record, and AECi on a corrected field (AECI-1614)', async () => {
    const id = '00000000-0000-4000-8000-000000000a11';
    const ownedAt = '2026-10-01T00:00:00.000Z';
    await seedVendor(id, 'owned-co', 'Owned Co');
    await t.db
      .update(vendors)
      .set({ ownedAt, parentCompany: 'Parent Co', fundingStage: 'Seed' })
      .where(eq(vendors.id, id));
    await t.db.insert(fieldOverrides).values({
      entityType: 'vendor',
      entityId: id,
      field: 'funding_stage',
      value: 'Seed',
      reason: 'Corrected',
      sourceUrl: 'https://registry.example/owned-co',
      setAt: '2026-11-02T00:00:00.000Z',
    });

    const detail = VendorDetailSchema.parse(
      await (await get(detailApp(), '/api/vendors/owned-co')).json(),
    );
    expect(detail.company_facts.parent_company?.source.set_by).toBe('vendor');
    expect(detail.company_facts.funding_stage?.source).toEqual({
      set_by: 'aeci',
      date: '2026-11-02T00:00:00.000Z',
      url: 'https://registry.example/owned-co',
    });
  });
});
