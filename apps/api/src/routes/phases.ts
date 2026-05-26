/**
 * Phase 2.8 (AECI-54) phases endpoint.
 *
 *   GET /api/phases/:slug — single phase detail with embedded products.
 */

import { PhaseDetailSchema, type PhaseDetail } from '@aeci/shared';
import type { Context } from 'hono';

import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import {
  productListSelect,
  taxonomyDetailScalarSelect,
  toProductListItem,
  toTaxonomyTermWithCount,
  type RawProductListRow,
  type RawTaxonomyDetailRow,
} from '../lib/prisma-helpers';
import { getPrisma, type AcceleratedPrisma } from '../prisma';

type PrismaFactory = (env: Env) => AcceleratedPrisma;

function validateResponseInDev(env: Env, validate: () => void): void {
  if (env.ENV !== 'production') validate();
}

export function createPhaseDetailHandler(
  prismaFor: PrismaFactory = getPrisma,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const slug = c.req.param('slug');
    if (!slug) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing phase slug', { field: 'slug' });
    }

    const prisma = prismaFor(c.env);
    const row = (await prisma.taxonomyPhase.findUnique({
      where: { slug },
      select: {
        ...taxonomyDetailScalarSelect,
        _count: { select: { productPhases: true } },
        productPhases: { select: { product: { select: productListSelect } } },
      },
    })) as unknown as RawTaxonomyDetailRow | null;

    if (!row) throw notFoundError('phase', { slug });

    const products: RawProductListRow[] = (row.productPhases ?? []).map((r) => r.product);

    const body: PhaseDetail = {
      ...toTaxonomyTermWithCount(row, 'productPhases'),
      products: products.map(toProductListItem),
    };

    validateResponseInDev(c.env, () => {
      PhaseDetailSchema.parse(body);
    });

    return json(body);
  };
}
