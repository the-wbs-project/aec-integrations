import { CategoriesListResponseSchema } from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import {
  allAudienceRows,
  allCategoryRows,
  allPhaseRows,
  fieldManagementCategoryRow,
} from '../test/fixtures/taxonomy';
import {
  buildAppWithHandler,
  fakeExecutionContext,
  makeMockAcceleratedPrisma,
  TEST_ENV,
  type MockAcceleratedPrisma,
} from '../test/helpers';

import { createTaxonomyListHandler, type TaxonomyListKind } from './taxonomy-list';

// The `/api/{categories|audiences|phases}/:slug` detail endpoints are exercised
// in `taxonomy-detail.spec.ts` (shared factory); the aggregate tree in
// `taxonomy.spec.ts`. This file covers the three flat list endpoints.

function listApp(path: string, kind: TaxonomyListKind, prisma: MockAcceleratedPrisma) {
  return buildAppWithHandler({
    method: 'get',
    path,
    handler: createTaxonomyListHandler(kind, () => prisma as never),
  });
}

interface ListCase {
  kind: TaxonomyListKind;
  path: string;
  mock: () => MockAcceleratedPrisma;
  length: number;
  slug: string;
  count: number;
}

const CASES: ListCase[] = [
  {
    kind: 'categories',
    path: '/api/categories',
    mock: () => makeMockAcceleratedPrisma({ taxonomyCategory: { findMany: allCategoryRows } }),
    length: 2,
    slug: 'project-management',
    count: 5,
  },
  {
    kind: 'audiences',
    path: '/api/audiences',
    mock: () => makeMockAcceleratedPrisma({ taxonomyAudience: { findMany: allAudienceRows } }),
    length: 1,
    slug: 'construction',
    count: 7,
  },
  {
    kind: 'phases',
    path: '/api/phases',
    mock: () => makeMockAcceleratedPrisma({ taxonomyPhase: { findMany: allPhaseRows } }),
    length: 1,
    slug: 'construction-phase',
    count: 4,
  },
];

describe('taxonomy list endpoints', () => {
  it.each(CASES)(
    'GET $path returns a flat list with product_count per term',
    async ({ kind, path, mock, length, slug, count }) => {
      const res = await listApp(path, kind, mock()).request(
        path,
        {},
        TEST_ENV,
        fakeExecutionContext(),
      );

      expect(res.status).toBe(200);
      const parsed = CategoriesListResponseSchema.parse(await res.json());
      expect(parsed.data).toHaveLength(length);
      expect(parsed.data.find((t) => t.slug === slug)?.product_count).toBe(count);
    },
  );

  it('coalesces a null displayOrder to 0', async () => {
    const prisma = makeMockAcceleratedPrisma({ taxonomyCategory: { findMany: allCategoryRows } });
    const res = await listApp('/api/categories', 'categories', prisma).request(
      '/api/categories',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    const parsed = CategoriesListResponseSchema.parse(await res.json());
    expect(parsed.data.find((t) => t.slug === fieldManagementCategoryRow.slug)?.display_order).toBe(
      0,
    );
  });
});
