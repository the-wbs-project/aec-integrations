/**
 * Phase 2.8 (AECI-54) vendors endpoints — Drizzle/D1 (ADR 0016 / AECI-253).
 *
 *   GET /api/vendors        — paginated, filterable, sortable list.
 *   GET /api/vendors/:slug  — single vendor detail with embedded products.
 *
 * Contracts:
 *   - Query: `VendorsListQuerySchema` from `@aeci/shared`.
 *   - Response: `VendorsListResponseSchema` / `VendorDetailSchema`.
 *   - Sort: public `name` key maps to `company_name` server-side (§7.4, `lib/sort.ts`).
 *   - 404 envelope: `errors.ts` `notFoundError('vendor', { slug })`.
 */

import {
  VendorDetailSchema,
  VendorsListQuerySchema,
  VendorsListResponseSchema,
  type VendorDetail,
  type VendorsListResponse,
} from '@aeci/shared';
import { and, count, eq, like, type SQL } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import { vendors } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import {
  toVendorDetail,
  toVendorListItem,
  vendorDetailConfig,
  vendorListConfig,
} from '../lib/drizzle-helpers';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import { resolveVendorOrderBy } from '../lib/sort';

export function createVendorsListHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const query = VendorsListQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));

    const { db } = dbFor(c.env);
    const conds: SQL[] = [];
    if (query.search) conds.push(like(vendors.companyName, `%${query.search}%`));
    if (query.verified !== undefined) conds.push(eq(vendors.verified, query.verified));
    const where = conds.length ? and(...conds) : undefined;

    const [rows, countRows] = await Promise.all([
      db.query.vendors.findMany({
        ...vendorListConfig,
        where,
        orderBy: resolveVendorOrderBy(query.sort),
        limit: query.perPage,
        offset: (query.page - 1) * query.perPage,
      }),
      db.select({ value: count() }).from(vendors).where(where),
    ]);

    const body: VendorsListResponse = {
      data: rows.map(toVendorListItem),
      page: query.page,
      perPage: query.perPage,
      total: countRows[0]?.value ?? 0,
    };

    validateResponseInDev(c.env, () => {
      VendorsListResponseSchema.parse(body);
    });

    return json(body);
  };
}

export function createVendorDetailHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const slug = c.req.param('slug');
    if (!slug) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing vendor slug', { field: 'slug' });
    }

    const { db } = dbFor(c.env);
    const row = await db.query.vendors.findFirst({
      ...vendorDetailConfig,
      where: eq(vendors.slug, slug),
    });

    if (!row) throw notFoundError('vendor', { slug });

    const body: VendorDetail = toVendorDetail(row);

    validateResponseInDev(c.env, () => {
      VendorDetailSchema.parse(body);
    });

    return json(body);
  };
}
