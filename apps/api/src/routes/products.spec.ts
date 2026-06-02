import { ProductDetailSchema, ProductsListResponseSchema } from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import {
  PROCORE_PRODUCT_ID,
  allProductRows,
  procoreProductDetailRow,
  procoreProductRow,
  reviztoProductRow,
} from '../test/fixtures/products';
import {
  buildAppWithHandler,
  fakeExecutionContext,
  makeMockAcceleratedPrisma,
  TEST_ENV,
  type MockAcceleratedPrisma,
} from '../test/helpers';
import { createProductDetailHandler, createProductsListHandler } from './products';

function listApp(prisma: MockAcceleratedPrisma) {
  return buildAppWithHandler({
    method: 'get',
    path: '/api/products',
    handler: createProductsListHandler(() => prisma as never),
  });
}

function detailApp(prisma: MockAcceleratedPrisma) {
  return buildAppWithHandler({
    method: 'get',
    path: '/api/products/:slug',
    handler: createProductDetailHandler(() => prisma as never),
  });
}

describe('GET /api/products', () => {
  it('returns the paginated list envelope with default sort + perPage', async () => {
    const prisma = makeMockAcceleratedPrisma({
      product: { findMany: allProductRows, count: allProductRows.length },
    });
    const res = await listApp(prisma).request(
      '/api/products',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = ProductsListResponseSchema.parse(body);
    expect(parsed.page).toBe(1);
    expect(parsed.perPage).toBe(24);
    expect(parsed.total).toBe(2);
    expect(parsed.data.map((p) => p.slug)).toEqual(['procore', 'revizto']);

    // Default sort `created DESC` per §7.4, with the AECI-99 `id` tiebreaker →
    // resolveProductSort emits `[{ createdAt: 'desc' }, { id: 'asc' }]`. Inspect
    // the orderBy arg the handler passed.
    const call = prisma.product.findMany.mock.calls[0][0] as { orderBy: unknown };
    expect(call.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'asc' }]);
  });

  it('hydrates `vendor` on each list row from the primary ProductVendor link', async () => {
    const prisma = makeMockAcceleratedPrisma({
      product: { findMany: [procoreProductRow], count: 1 },
    });
    const res = await listApp(prisma).request(
      '/api/products',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    const body = (await res.json()) as { data: Array<{ vendor: { slug: string; name: string } }> };
    expect(body.data[0].vendor).toMatchObject({ slug: 'procore', name: 'Procore Technologies' });
  });

  it('hydrates `primary_category` on each list row, lowest displayOrder wins', async () => {
    const prisma = makeMockAcceleratedPrisma({
      product: { findMany: [procoreProductRow], count: 1 },
    });
    const res = await listApp(prisma).request(
      '/api/products',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    const body = (await res.json()) as {
      data: Array<{ primary_category: { slug: string } | null }>;
    };
    expect(body.data[0].primary_category).toEqual({
      id: '00000000-0000-4000-8000-000000030001',
      name: 'Project Management',
      slug: 'project-management',
    });
  });

  it('maps `sort=name` to [{ name: "asc" }, { id: "asc" }]', async () => {
    const prisma = makeMockAcceleratedPrisma({
      product: { findMany: [], count: 0 },
    });
    await listApp(prisma).request('/api/products?sort=name', {}, TEST_ENV, fakeExecutionContext());

    const call = prisma.product.findMany.mock.calls[0][0] as { orderBy: unknown };
    expect(call.orderBy).toEqual([{ name: 'asc' }, { id: 'asc' }]);
  });

  it('builds the where clause from category_id + vendor_id filters', async () => {
    const prisma = makeMockAcceleratedPrisma({
      product: { findMany: [], count: 0 },
    });
    await listApp(prisma).request(
      '/api/products?category_id=00000000-0000-4000-8000-000000030001&vendor_id=00000000-0000-4000-8000-000000010001',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    const call = prisma.product.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(call.where).toMatchObject({
      productCategories: { some: { categoryId: '00000000-0000-4000-8000-000000030001' } },
      productVendors: { some: { vendorId: '00000000-0000-4000-8000-000000010001' } },
    });
  });

  it('caps perPage at 100 — perPage=200 returns 400 VALIDATION_FAILED', async () => {
    const prisma = makeMockAcceleratedPrisma();
    const res = await listApp(prisma).request(
      '/api/products?perPage=200',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; field?: string };
      trace_id: string;
    };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.field).toBe('perPage');
    expect(body.trace_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });

  it('rejects page=0 with 400 VALIDATION_FAILED on the `page` field', async () => {
    const prisma = makeMockAcceleratedPrisma();
    const res = await listApp(prisma).request(
      '/api/products?page=0',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; field?: string } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.field).toBe('page');
  });

  it('returns empty data when page > total/perPage (Prisma findMany returns [])', async () => {
    // Simulate `skip` past the end — Prisma returns []; count stays at the true total.
    const prisma = makeMockAcceleratedPrisma({
      product: { findMany: [], count: 2 },
    });
    const res = await listApp(prisma).request(
      '/api/products?page=99&perPage=10',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; page: number; total: number };
    expect(body.data).toEqual([]);
    expect(body.page).toBe(99);
    expect(body.total).toBe(2);
  });

  it('rejects an unknown sort value with 400 VALIDATION_FAILED on the `sort` field', async () => {
    const prisma = makeMockAcceleratedPrisma();
    const res = await listApp(prisma).request(
      '/api/products?sort=banana',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; field?: string } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.field).toBe('sort');
  });

  it("emits `Cache-Control: 'private, no-store'` on success (AECI-43)", async () => {
    const prisma = makeMockAcceleratedPrisma({
      product: { findMany: [], count: 0 },
    });
    const res = await listApp(prisma).request(
      '/api/products',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it("emits `Cache-Control: 'private, no-store'` on 4xx (AECI-43)", async () => {
    const prisma = makeMockAcceleratedPrisma();
    const res = await listApp(prisma).request(
      '/api/products?page=0',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});

describe('GET /api/products/:slug', () => {
  it('returns the full hydrated detail shape per §3.4', async () => {
    const prisma = makeMockAcceleratedPrisma({
      product: { findUnique: procoreProductDetailRow, findMany: [reviztoProductRow] },
    });
    const res = await detailApp(prisma).request(
      '/api/products/procore',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = ProductDetailSchema.parse(body);

    expect(parsed.slug).toBe('procore');
    expect(parsed.vendor.slug).toBe('procore');
    expect(parsed.categories.map((c) => c.slug)).toContain('project-management');
    expect(parsed.disciplines.map((d) => d.slug)).toContain('construction');
    expect(parsed.phases.map((p) => p.slug)).toContain('construction-phase');
    expect(parsed.related_products.map((p) => p.slug)).toEqual(['revizto']);
  });

  it('passes the row id to the related-products query (excludes self by id)', async () => {
    const prisma = makeMockAcceleratedPrisma({
      product: { findUnique: procoreProductDetailRow, findMany: [reviztoProductRow] },
    });
    await detailApp(prisma).request('/api/products/procore', {}, TEST_ENV, fakeExecutionContext());

    const findManyCall = prisma.product.findMany.mock.calls[0][0] as {
      where: { id: { not: string } };
    };
    expect(findManyCall.where.id).toEqual({ not: PROCORE_PRODUCT_ID });
  });

  it('returns the canonical 404 envelope when no product matches the slug', async () => {
    const prisma = makeMockAcceleratedPrisma({
      product: { findUnique: null },
    });
    const res = await detailApp(prisma).request(
      '/api/products/no-such',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; message: string; details?: { resource?: string; slug?: string } };
      trace_id: string;
    };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.details).toEqual({ resource: 'product', slug: 'no-such' });
    expect(body.trace_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('emits `Cache-Control: private, no-store` on the 200 detail response', async () => {
    const prisma = makeMockAcceleratedPrisma({
      product: { findUnique: procoreProductDetailRow, findMany: [] },
    });
    const res = await detailApp(prisma).request(
      '/api/products/procore',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('skips the related-products query when the product has no categories', async () => {
    const prisma = makeMockAcceleratedPrisma({
      product: {
        findUnique: { ...procoreProductDetailRow, productCategories: [] },
        findMany: [],
      },
    });
    await detailApp(prisma).request('/api/products/procore', {}, TEST_ENV, fakeExecutionContext());
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });
});
