/**
 * Phase 2.8 (AECI-54) integrations endpoints.
 *
 *   GET /api/integrations       — paginated, filterable (search,
 *                                 sourceProductId, targetProductId,
 *                                 mechanism_kind, direction), sortable list.
 *   GET /api/integrations/:id   — single integration detail with vendor/connector
 *                                 hydration.
 *
 * Filter fields use the camelCase names from the Phase 2 Spec §7.1 example
 * query (`sourceProductId`, `targetProductId`); enum filters keep snake_case
 * to match the underlying columns. Default sort is `name ASC` (§7.4) — since
 * integration names render as "Source → Target", alphabetical groups by
 * source product, which is useful for browsing.
 */

import {
  IntegrationDetailSchema,
  IntegrationsListQuerySchema,
  IntegrationsListResponseSchema,
  type IntegrationDetail,
  type IntegrationsListResponse,
} from '@aeci/shared';
import type { Context } from 'hono';

import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { validateResponseInDev, type PrismaFactory } from '../lib/handler-utils';
import {
  integrationDetailSelect,
  integrationListSelect,
  toIntegrationDetail,
  toIntegrationListItem,
  type RawIntegrationDetailRow,
  type RawIntegrationListRow,
} from '../lib/prisma-helpers';
import { resolveIntegrationSort } from '../lib/sort';
import { getPrisma } from '../prisma';

export function createIntegrationsListHandler(
  prismaFor: PrismaFactory = getPrisma,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const query = IntegrationsListQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );

    const where: {
      sourceProductId?: string;
      targetProductId?: string;
      mechanismKind?: string;
      direction?: string;
      // `name` is nullable on the integration row — rows without an explicit
      // name have their display name synthesised from source/target product
      // names at the API layer. A plain `name: { contains }` filter would
      // silently miss all those rows, so we expand `search` into an OR that
      // covers the explicit name column AND both product-name columns.
      OR?: Array<{
        name?: { contains: string; mode: 'insensitive' };
        sourceProduct?: { name: { contains: string; mode: 'insensitive' } };
        targetProduct?: { name: { contains: string; mode: 'insensitive' } };
      }>;
    } = {};
    if (query.search) {
      const term = { contains: query.search, mode: 'insensitive' as const };
      where.OR = [
        { name: term },
        { sourceProduct: { name: term } },
        { targetProduct: { name: term } },
      ];
    }
    if (query.sourceProductId) where.sourceProductId = query.sourceProductId;
    if (query.targetProductId) where.targetProductId = query.targetProductId;
    if (query.mechanism_kind) where.mechanismKind = query.mechanism_kind;
    if (query.direction) where.direction = query.direction;

    const prisma = prismaFor(c.env);
    const [rows, total] = await Promise.all([
      prisma.integration.findMany({
        where,
        orderBy: resolveIntegrationSort(query.sort),
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
        select: integrationListSelect,
      }) as unknown as Promise<RawIntegrationListRow[]>,
      prisma.integration.count({ where }),
    ]);

    const body: IntegrationsListResponse = {
      data: rows.map(toIntegrationListItem),
      page: query.page,
      perPage: query.perPage,
      total,
    };

    validateResponseInDev(c.env, () => {
      IntegrationsListResponseSchema.parse(body);
    });

    return json(body);
  };
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createIntegrationDetailHandler(
  prismaFor: PrismaFactory = getPrisma,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const id = c.req.param('id');
    if (!id) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing integration id', { field: 'id' });
    }
    if (!UUID_REGEX.test(id)) {
      // Treat as not-found rather than 500ing inside Prisma on a malformed UUID.
      throw notFoundError('integration', { id });
    }

    const prisma = prismaFor(c.env);
    const row = (await prisma.integration.findUnique({
      where: { id },
      select: integrationDetailSelect,
    })) as unknown as RawIntegrationDetailRow | null;

    if (!row) throw notFoundError('integration', { id });

    const body: IntegrationDetail = toIntegrationDetail(row);

    validateResponseInDev(c.env, () => {
      IntegrationDetailSchema.parse(body);
    });

    return json(body);
  };
}
