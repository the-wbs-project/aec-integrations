import { CategoryDetailSchema, DisciplineDetailSchema, PhaseDetailSchema } from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import {
  constructionDisciplineDetailRow,
  constructionPhaseDetailRow,
  projectManagementCategoryDetailRow,
} from '../test/fixtures/taxonomy';
import {
  buildAppWithHandler,
  fakeExecutionContext,
  makeMockAcceleratedPrisma,
  TEST_ENV,
  type MockAcceleratedPrisma,
} from '../test/helpers';
import { createTaxonomyDetailHandler, type TaxonomyDetailConfig } from './taxonomy-detail';

/**
 * One factory (`createTaxonomyDetailHandler`) backs all three taxonomy detail
 * endpoints (AECI-120 A6), so the per-kind handler tests collapse into this
 * parametrised suite. The category *list* endpoint keeps its own
 * `categories.spec.ts`.
 */
interface Case {
  /** URL segment + 404 `details.resource`. */
  resource: 'category' | 'discipline' | 'phase';
  /** Path segment (`categories` / `disciplines` / `phases`). */
  segment: string;
  config: TaxonomyDetailConfig;
  /** Mock keyed by the model the factory's `delegate` selects. */
  mock: (findUnique: unknown) => MockAcceleratedPrisma;
  detailRow: unknown;
  slug: string;
  productCount: number;
}

const CASES: Case[] = [
  {
    resource: 'category',
    segment: 'categories',
    config: {
      delegate: (p) => p.taxonomyCategory,
      relationKey: 'productCategories',
      resource: 'category',
      schema: CategoryDetailSchema,
    },
    mock: (findUnique) => makeMockAcceleratedPrisma({ taxonomyCategory: { findUnique } }),
    detailRow: projectManagementCategoryDetailRow,
    slug: 'project-management',
    productCount: 5,
  },
  {
    resource: 'discipline',
    segment: 'disciplines',
    config: {
      delegate: (p) => p.taxonomyDiscipline,
      relationKey: 'productDisciplines',
      resource: 'discipline',
      schema: DisciplineDetailSchema,
    },
    mock: (findUnique) => makeMockAcceleratedPrisma({ taxonomyDiscipline: { findUnique } }),
    detailRow: constructionDisciplineDetailRow,
    slug: 'construction',
    productCount: 7,
  },
  {
    resource: 'phase',
    segment: 'phases',
    config: {
      delegate: (p) => p.taxonomyPhase,
      relationKey: 'productPhases',
      resource: 'phase',
      schema: PhaseDetailSchema,
    },
    mock: (findUnique) => makeMockAcceleratedPrisma({ taxonomyPhase: { findUnique } }),
    detailRow: constructionPhaseDetailRow,
    slug: 'construction-phase',
    productCount: 4,
  },
];

function app(c: Case, prisma: MockAcceleratedPrisma) {
  return buildAppWithHandler({
    method: 'get',
    path: `/api/${c.segment}/:slug`,
    handler: createTaxonomyDetailHandler(c.config, () => prisma as never),
  });
}

describe('createTaxonomyDetailHandler', () => {
  for (const c of CASES) {
    describe(`GET /api/${c.segment}/:slug`, () => {
      it('returns the detail shape with embedded products and product_count', async () => {
        const res = await app(c, c.mock(c.detailRow)).request(
          `/api/${c.segment}/${c.slug}`,
          {},
          TEST_ENV,
          fakeExecutionContext(),
        );

        expect(res.status).toBe(200);
        const parsed = c.config.schema.parse(await res.json()) as {
          slug: string;
          product_count: number;
          products: { slug: string }[];
        };
        expect(parsed.slug).toBe(c.slug);
        expect(parsed.product_count).toBe(c.productCount);
        expect(parsed.products.map((p) => p.slug)).toEqual(['procore']);
      });

      it(`returns 404 with details.resource = "${c.resource}" for an unknown slug`, async () => {
        const res = await app(c, c.mock(null)).request(
          `/api/${c.segment}/no-such`,
          {},
          TEST_ENV,
          fakeExecutionContext(),
        );

        expect(res.status).toBe(404);
        const body = (await res.json()) as {
          error: { code: string; details?: { resource?: string; slug?: string } };
        };
        expect(body.error.details).toEqual({ resource: c.resource, slug: 'no-such' });
      });
    });
  }
});
