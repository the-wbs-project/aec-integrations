/**
 * Phase 2.8 (AECI-54) integrations endpoints — Drizzle/D1 (ADR 0016 / AECI-253).
 *
 *   GET /api/integrations       — paginated, filterable (search,
 *                                 sourceProductId, targetProductId,
 *                                 mechanism_kind, direction), sortable list.
 *   GET /api/integrations/:id   — single integration detail with vendor/connector
 *                                 hydration.
 *
 * Default sort is `name ASC` (§7.4). `search` expands to an OR across the explicit
 * `name` column AND both product-name columns (rows without an explicit name have
 * their display name synthesised from source/target at the API layer, so a plain
 * `name LIKE` would miss them) — expressed as `product_id IN (subquery)`.
 */

import {
  IntegrationDetailSchema,
  IntegrationsListQuerySchema,
  IntegrationsListResponseSchema,
  type IntegrationDetail,
  type IntegrationsListResponse,
} from '@aeci/shared';
import { and, count, eq, inArray, like, or, type SQL } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import { integrations, products } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import {
  integrationDetailConfig,
  integrationListConfig,
  toIntegrationDetail,
  toIntegrationListItem,
} from '../lib/drizzle-helpers';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import { resolveIntegrationOrderBy } from '../lib/sort';

export function createIntegrationsListHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const query = IntegrationsListQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );

    const { db } = dbFor(c.env);
    const conds: SQL[] = [];
    if (query.search) {
      const term = `%${query.search}%`;
      const matchByProductName = () =>
        db.select({ id: products.id }).from(products).where(like(products.name, term));
      conds.push(
        or(
          like(integrations.name, term),
          inArray(integrations.sourceProductId, matchByProductName()),
          inArray(integrations.targetProductId, matchByProductName()),
        )!,
      );
    }
    if (query.sourceProductId) conds.push(eq(integrations.sourceProductId, query.sourceProductId));
    if (query.targetProductId) conds.push(eq(integrations.targetProductId, query.targetProductId));
    if (query.mechanism_kind) conds.push(eq(integrations.mechanismKind, query.mechanism_kind));
    if (query.direction) conds.push(eq(integrations.direction, query.direction));
    const where = conds.length ? and(...conds) : undefined;

    const [rows, countRows] = await Promise.all([
      db.query.integrations.findMany({
        ...integrationListConfig,
        where,
        orderBy: resolveIntegrationOrderBy(query.sort),
        limit: query.perPage,
        offset: (query.page - 1) * query.perPage,
      }),
      db.select({ value: count() }).from(integrations).where(where),
    ]);

    const body: IntegrationsListResponse = {
      data: rows.map(toIntegrationListItem),
      page: query.page,
      perPage: query.perPage,
      total: countRows[0]?.value ?? 0,
    };

    validateResponseInDev(c.env, () => {
      IntegrationsListResponseSchema.parse(body);
    });

    return json(body);
  };
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createIntegrationDetailHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const id = c.req.param('id');
    if (!id) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing integration id', { field: 'id' });
    }
    if (!UUID_REGEX.test(id)) {
      throw notFoundError('integration', { id });
    }

    const { db } = dbFor(c.env);
    const row = await db.query.integrations.findFirst({
      ...integrationDetailConfig,
      where: eq(integrations.id, id),
    });

    if (!row) throw notFoundError('integration', { id });

    const body: IntegrationDetail = toIntegrationDetail(row);

    validateResponseInDev(c.env, () => {
      IntegrationDetailSchema.parse(body);
    });

    return json(body);
  };
}
