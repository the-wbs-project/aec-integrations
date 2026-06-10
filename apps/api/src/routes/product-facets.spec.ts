import { ProductFacetsResponseSchema } from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import {
  CONSTRUCTION_AUDIENCE_ID,
  PROJECT_MGMT_CATEGORY_ID,
  allAudienceRows,
  allCategoryRows,
  allPhaseRows,
} from '../test/fixtures/taxonomy';
import {
  buildAppWithHandler,
  fakeExecutionContext,
  makeMockAcceleratedPrisma,
  TEST_ENV,
  type MockAcceleratedPrisma,
} from '../test/helpers';

import { createProductFacetsHandler } from './product-facets';

function facetsApp(prisma: MockAcceleratedPrisma) {
  return buildAppWithHandler({
    method: 'get',
    path: '/api/products/facets',
    handler: createProductFacetsHandler(() => prisma as never),
  });
}

/** A prisma mock wired with the full three-facet term fixtures. */
function allTermsPrisma(): MockAcceleratedPrisma {
  return makeMockAcceleratedPrisma({
    taxonomyCategory: { findMany: allCategoryRows },
    taxonomyAudience: { findMany: allAudienceRows },
    taxonomyPhase: { findMany: allPhaseRows },
  });
}

/** Pull the `where.product` filter passed into a model's filtered `_count`. */
function countWhere(
  call: unknown,
  relation: 'productCategories' | 'productAudiences' | 'productPhases',
): Record<string, unknown> {
  const args = call as {
    select: { _count: { select: Record<string, { where: { product: unknown } }> } };
  };
  return args.select._count.select[relation].where.product as Record<string, unknown>;
}

describe('GET /api/products/facets', () => {
  it('returns category/audience/phase groups each with product_count per term', async () => {
    const res = await facetsApp(allTermsPrisma()).request(
      '/api/products/facets',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(200);
    const parsed = ProductFacetsResponseSchema.parse(await res.json());
    expect(parsed.categories.map((t) => t.slug)).toEqual([
      'project-management',
      'field-management',
    ]);
    expect(parsed.categories.find((t) => t.slug === 'project-management')?.product_count).toBe(5);
    expect(parsed.audiences[0]?.product_count).toBe(7);
    expect(parsed.phases[0]?.product_count).toBe(4);
  });

  it('with no filters builds an empty product `where` for every dimension', async () => {
    const prisma = allTermsPrisma();
    await facetsApp(prisma).request('/api/products/facets', {}, TEST_ENV, fakeExecutionContext());

    expect(
      countWhere(prisma.taxonomyCategory.findMany.mock.calls[0][0], 'productCategories'),
    ).toEqual({});
    expect(
      countWhere(prisma.taxonomyAudience.findMany.mock.calls[0][0], 'productAudiences'),
    ).toEqual({});
    expect(countWhere(prisma.taxonomyPhase.findMany.mock.calls[0][0], 'productPhases')).toEqual({});
  });

  it('computes each dimension disjunctively — its own filter is excluded, the others apply', async () => {
    const prisma = allTermsPrisma();
    await facetsApp(prisma).request(
      `/api/products/facets?category_id=${PROJECT_MGMT_CATEGORY_ID}&audience_id=${CONSTRUCTION_AUDIENCE_ID}`,
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    // categories group: own (category) clause dropped; audience clause applies.
    expect(
      countWhere(prisma.taxonomyCategory.findMany.mock.calls[0][0], 'productCategories'),
    ).toEqual({
      productAudiences: { some: { audienceId: CONSTRUCTION_AUDIENCE_ID } },
    });

    // audiences group: own (audience) clause dropped; category clause applies.
    expect(
      countWhere(prisma.taxonomyAudience.findMany.mock.calls[0][0], 'productAudiences'),
    ).toEqual({
      productCategories: { some: { categoryId: PROJECT_MGMT_CATEGORY_ID } },
    });

    // phases group: neither own — both category + audience clauses apply.
    expect(countWhere(prisma.taxonomyPhase.findMany.mock.calls[0][0], 'productPhases')).toEqual({
      productCategories: { some: { categoryId: PROJECT_MGMT_CATEGORY_ID } },
      productAudiences: { some: { audienceId: CONSTRUCTION_AUDIENCE_ID } },
    });
  });

  it('applies a locked {kind}_id (browse page scope) to the other dimensions', async () => {
    // A `/categories/:slug` page sends its locked category_id with no cross-filter.
    const prisma = allTermsPrisma();
    await facetsApp(prisma).request(
      `/api/products/facets?category_id=${PROJECT_MGMT_CATEGORY_ID}`,
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    // The locked dimension is excluded from its own counts (the sidebar hides it).
    expect(
      countWhere(prisma.taxonomyCategory.findMany.mock.calls[0][0], 'productCategories'),
    ).toEqual({});
    // …and applied to the other two so their counts are scoped to the category.
    expect(
      countWhere(prisma.taxonomyAudience.findMany.mock.calls[0][0], 'productAudiences'),
    ).toEqual({
      productCategories: { some: { categoryId: PROJECT_MGMT_CATEGORY_ID } },
    });
    expect(countWhere(prisma.taxonomyPhase.findMany.mock.calls[0][0], 'productPhases')).toEqual({
      productCategories: { some: { categoryId: PROJECT_MGMT_CATEGORY_ID } },
    });
  });

  it('orders each dimension by displayOrder then name', async () => {
    const prisma = allTermsPrisma();
    await facetsApp(prisma).request('/api/products/facets', {}, TEST_ENV, fakeExecutionContext());

    const call = prisma.taxonomyCategory.findMany.mock.calls[0][0] as { orderBy: unknown };
    expect(call.orderBy).toEqual([{ displayOrder: 'asc' }, { name: 'asc' }]);
  });

  it('rejects a non-uuid category_id with 400 VALIDATION_FAILED', async () => {
    const prisma = allTermsPrisma();
    const res = await facetsApp(prisma).request(
      '/api/products/facets?category_id=not-a-uuid',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; field?: string } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.field).toBe('category_id');
    expect(prisma.taxonomyCategory.findMany).not.toHaveBeenCalled();
  });

  it("emits `Cache-Control: 'private, no-store'` (request-scoped, not edge-cached)", async () => {
    const res = await facetsApp(allTermsPrisma()).request(
      '/api/products/facets',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});
