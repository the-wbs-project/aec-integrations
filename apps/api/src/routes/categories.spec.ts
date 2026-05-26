import { CategoriesListResponseSchema, CategoryDetailSchema } from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import {
  allCategoryRows,
  fieldManagementCategoryRow,
  projectManagementCategoryDetailRow,
} from '../test/fixtures/taxonomy';
import {
  buildAppWithHandler,
  fakeExecutionContext,
  makeMockAcceleratedPrisma,
  TEST_ENV,
  type MockAcceleratedPrisma,
} from '../test/helpers';
import { createCategoriesListHandler, createCategoryDetailHandler } from './categories';

function listApp(prisma: MockAcceleratedPrisma) {
  return buildAppWithHandler({
    method: 'get',
    path: '/api/categories',
    handler: createCategoriesListHandler(() => prisma as never),
  });
}

function detailApp(prisma: MockAcceleratedPrisma) {
  return buildAppWithHandler({
    method: 'get',
    path: '/api/categories/:slug',
    handler: createCategoryDetailHandler(() => prisma as never),
  });
}

describe('GET /api/categories', () => {
  it('returns flat list with product_count per term; coalesces null displayOrder to 0', async () => {
    const prisma = makeMockAcceleratedPrisma({
      taxonomyCategory: { findMany: allCategoryRows },
    });
    const res = await listApp(prisma).request(
      '/api/categories',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = CategoriesListResponseSchema.parse(body);
    expect(parsed.data).toHaveLength(2);

    const fieldMgmt = parsed.data.find((t) => t.slug === fieldManagementCategoryRow.slug);
    expect(fieldMgmt?.display_order).toBe(0); // null in fixture → coalesced
    expect(fieldMgmt?.product_count).toBe(0);

    const projectMgmt = parsed.data.find((t) => t.slug === 'project-management');
    expect(projectMgmt?.product_count).toBe(5);
  });
});

describe('GET /api/categories/:slug', () => {
  it('returns the detail shape with embedded products', async () => {
    const prisma = makeMockAcceleratedPrisma({
      taxonomyCategory: { findUnique: projectManagementCategoryDetailRow },
    });
    const res = await detailApp(prisma).request(
      '/api/categories/project-management',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = CategoryDetailSchema.parse(body);
    expect(parsed.slug).toBe('project-management');
    expect(parsed.products.map((p) => p.slug)).toEqual(['procore']);
  });

  it('returns 404 for an unknown slug', async () => {
    const prisma = makeMockAcceleratedPrisma({ taxonomyCategory: { findUnique: null } });
    const res = await detailApp(prisma).request(
      '/api/categories/no-such',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; details?: { resource?: string; slug?: string } };
    };
    expect(body.error.details).toEqual({ resource: 'category', slug: 'no-such' });
  });
});
