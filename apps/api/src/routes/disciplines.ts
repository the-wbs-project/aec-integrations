/**
 * Phase 2.8 (AECI-54) disciplines endpoint.
 *
 *   GET /api/disciplines/:slug — single discipline detail with embedded products.
 *
 * No list endpoint per Phase 2 Spec §7.1 — disciplines are read via
 * `GET /api/taxonomy` when the SSR Worker needs the whole tree.
 */

import { DisciplineDetailSchema, type DisciplineDetail } from '@aeci/shared';
import type { Context } from 'hono';

import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { validateResponseInDev, type PrismaFactory } from '../lib/handler-utils';
import {
  disciplineDetailSelect,
  toProductListItem,
  toTaxonomyTermWithCount,
  type RawProductListRow,
} from '../lib/prisma-helpers';
import { getPrisma } from '../prisma';

export function createDisciplineDetailHandler(
  prismaFor: PrismaFactory = getPrisma,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const slug = c.req.param('slug');
    if (!slug) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing discipline slug', { field: 'slug' });
    }

    const prisma = prismaFor(c.env);
    const row = await prisma.taxonomyDiscipline.findUnique({
      where: { slug },
      select: disciplineDetailSelect,
    });

    if (!row) throw notFoundError('discipline', { slug });

    const products: RawProductListRow[] = row.productDisciplines.map((r) => r.product);

    const body: DisciplineDetail = {
      ...toTaxonomyTermWithCount(row, 'productDisciplines'),
      products: products.map(toProductListItem),
    };

    validateResponseInDev(c.env, () => {
      DisciplineDetailSchema.parse(body);
    });

    return json(body);
  };
}
