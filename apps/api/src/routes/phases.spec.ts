import { PhaseDetailSchema } from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import { constructionPhaseDetailRow } from '../test/fixtures/taxonomy';
import {
  buildAppWithHandler,
  fakeExecutionContext,
  makeMockAcceleratedPrisma,
  TEST_ENV,
  type MockAcceleratedPrisma,
} from '../test/helpers';
import { createPhaseDetailHandler } from './phases';

function app(prisma: MockAcceleratedPrisma) {
  return buildAppWithHandler({
    method: 'get',
    path: '/api/phases/:slug',
    handler: createPhaseDetailHandler(() => prisma as never),
  });
}

describe('GET /api/phases/:slug', () => {
  it('returns the detail shape with embedded products', async () => {
    const prisma = makeMockAcceleratedPrisma({
      taxonomyPhase: { findUnique: constructionPhaseDetailRow },
    });
    const res = await app(prisma).request(
      '/api/phases/construction-phase',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = PhaseDetailSchema.parse(body);
    expect(parsed.slug).toBe('construction-phase');
    expect(parsed.product_count).toBe(4);
    expect(parsed.products.map((p) => p.slug)).toEqual(['procore']);
  });

  it('returns 404 with `details.resource = "phase"` for unknown slug', async () => {
    const prisma = makeMockAcceleratedPrisma({ taxonomyPhase: { findUnique: null } });
    const res = await app(prisma).request(
      '/api/phases/no-such',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; details?: { resource?: string; slug?: string } };
    };
    expect(body.error.details).toEqual({ resource: 'phase', slug: 'no-such' });
  });
});
