import { VendorDetailSchema, VendorsListResponseSchema } from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import { allVendorRows, procoreVendorDetailRow } from '../test/fixtures/vendors';
import {
  buildAppWithHandler,
  fakeExecutionContext,
  makeMockAcceleratedPrisma,
  TEST_ENV,
  type MockAcceleratedPrisma,
} from '../test/helpers';
import { createVendorDetailHandler, createVendorsListHandler } from './vendors';

function listApp(prisma: MockAcceleratedPrisma) {
  return buildAppWithHandler({
    method: 'get',
    path: '/api/vendors',
    handler: createVendorsListHandler(() => prisma as never),
  });
}

function detailApp(prisma: MockAcceleratedPrisma) {
  return buildAppWithHandler({
    method: 'get',
    path: '/api/vendors/:slug',
    handler: createVendorDetailHandler(() => prisma as never),
  });
}

describe('GET /api/vendors', () => {
  it('returns the paginated list envelope with default sort (created DESC)', async () => {
    const prisma = makeMockAcceleratedPrisma({
      vendor: { findMany: allVendorRows, count: allVendorRows.length },
    });
    const res = await listApp(prisma).request('/api/vendors', {}, TEST_ENV, fakeExecutionContext());

    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = VendorsListResponseSchema.parse(body);
    expect(parsed.total).toBe(2);
    expect(parsed.data[0]).toMatchObject({
      slug: 'procore',
      company_name: 'Procore Technologies',
      product_count: 1,
      integration_count: 2,
    });
    const call = prisma.vendor.findMany.mock.calls[0][0] as { orderBy: unknown };
    expect(call.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('maps `sort=name` to `{ companyName: "asc" }` (no `name` column on vendors)', async () => {
    const prisma = makeMockAcceleratedPrisma({ vendor: { findMany: [], count: 0 } });
    await listApp(prisma).request('/api/vendors?sort=name', {}, TEST_ENV, fakeExecutionContext());

    const call = prisma.vendor.findMany.mock.calls[0][0] as { orderBy: unknown };
    expect(call.orderBy).toEqual({ companyName: 'asc' });
  });

  it('applies the `verified=true` filter as a where clause', async () => {
    const prisma = makeMockAcceleratedPrisma({ vendor: { findMany: [], count: 0 } });
    await listApp(prisma).request(
      '/api/vendors?verified=true',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    const call = prisma.vendor.findMany.mock.calls[0][0] as { where: { verified?: boolean } };
    expect(call.where.verified).toBe(true);
  });
});

describe('GET /api/vendors/:slug', () => {
  it('returns the full detail envelope, embedding products as ProductListItem[]', async () => {
    const prisma = makeMockAcceleratedPrisma({
      vendor: { findUnique: procoreVendorDetailRow },
    });
    const res = await detailApp(prisma).request(
      '/api/vendors/procore',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = VendorDetailSchema.parse(body);
    expect(parsed.slug).toBe('procore');
    expect(parsed.headquarters).toBe('Carpinteria, CA');
    expect(parsed.founded_year).toBe(2002);
    // Detail row in the fixture has an empty productVendors list, so the
    // schema's `products: ProductListItem[]` shows up empty here — the spec
    // requires the field to exist as an array even when empty.
    expect(Array.isArray(parsed.products)).toBe(true);
  });

  it('returns the canonical 404 envelope when no vendor matches', async () => {
    const prisma = makeMockAcceleratedPrisma({ vendor: { findUnique: null } });
    const res = await detailApp(prisma).request(
      '/api/vendors/no-such',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; details?: { resource?: string; slug?: string } };
      trace_id: string;
    };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.details).toEqual({ resource: 'vendor', slug: 'no-such' });
  });

  it("emits `Cache-Control: 'private, no-store'` on the 404 response", async () => {
    const prisma = makeMockAcceleratedPrisma({ vendor: { findUnique: null } });
    const res = await detailApp(prisma).request(
      '/api/vendors/no-such',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('passes the slug to findUnique', async () => {
    const prisma = makeMockAcceleratedPrisma({ vendor: { findUnique: procoreVendorDetailRow } });
    await detailApp(prisma).request('/api/vendors/procore', {}, TEST_ENV, fakeExecutionContext());
    const call = prisma.vendor.findUnique.mock.calls[0][0] as { where: { slug: string } };
    expect(call.where).toEqual({ slug: 'procore' });
  });
});
