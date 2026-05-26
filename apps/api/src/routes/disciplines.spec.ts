import { DisciplineDetailSchema } from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import { constructionDisciplineDetailRow } from '../test/fixtures/taxonomy';
import {
  buildAppWithHandler,
  fakeExecutionContext,
  makeMockAcceleratedPrisma,
  TEST_ENV,
  type MockAcceleratedPrisma,
} from '../test/helpers';
import { createDisciplineDetailHandler } from './disciplines';

function app(prisma: MockAcceleratedPrisma) {
  return buildAppWithHandler({
    method: 'get',
    path: '/api/disciplines/:slug',
    handler: createDisciplineDetailHandler(() => prisma as never),
  });
}

describe('GET /api/disciplines/:slug', () => {
  it('returns the detail shape with embedded products', async () => {
    const prisma = makeMockAcceleratedPrisma({
      taxonomyDiscipline: { findUnique: constructionDisciplineDetailRow },
    });
    const res = await app(prisma).request(
      '/api/disciplines/construction',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = DisciplineDetailSchema.parse(body);
    expect(parsed.slug).toBe('construction');
    expect(parsed.product_count).toBe(7);
    expect(parsed.products.map((p) => p.slug)).toEqual(['procore']);
  });

  it('returns 404 for an unknown slug with `details.resource = "discipline"`', async () => {
    const prisma = makeMockAcceleratedPrisma({ taxonomyDiscipline: { findUnique: null } });
    const res = await app(prisma).request(
      '/api/disciplines/no-such',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; details?: { resource?: string; slug?: string } };
    };
    expect(body.error.details).toEqual({ resource: 'discipline', slug: 'no-such' });
  });
});
