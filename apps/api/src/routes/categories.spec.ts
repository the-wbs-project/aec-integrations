import { CategoriesListResponseSchema } from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import { allCategoryRows, fieldManagementCategoryRow } from '../test/fixtures/taxonomy';
import {
  buildAppWithHandler,
  fakeExecutionContext,
  makeMockAcceleratedPrisma,
  TEST_ENV,
  type MockAcceleratedPrisma,
} from '../test/helpers';
import { createCategoriesListHandler } from './categories';

// The `/api/categories/:slug` detail endpoint is exercised in
// `taxonomy-detail.spec.ts` (shared factory). This file covers the list only.

function listApp(prisma: MockAcceleratedPrisma) {
  return buildAppWithHandler({
    method: 'get',
    path: '/api/categories',
    handler: createCategoriesListHandler(() => prisma as never),
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
