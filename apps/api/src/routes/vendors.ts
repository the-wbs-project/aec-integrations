/**
 * Phase 2.8 (AECI-54) vendors endpoints.
 *
 *   GET /api/vendors        — paginated, filterable, sortable list.
 *   GET /api/vendors/:slug  — single vendor detail with embedded products.
 *
 * Contracts:
 *   - Query: `VendorsListQuerySchema` from `@aeci/shared`.
 *   - Response: `VendorsListResponseSchema` / `VendorDetailSchema`.
 *   - Sort: public `name` key maps to `company_name` server-side (Phase 2 Spec §7.4
 *     handled in `lib/sort.ts`).
 *   - 404 envelope: `errors.ts` `notFoundError('vendor', { slug })`.
 */

import {
  VendorDetailSchema,
  VendorsListQuerySchema,
  VendorsListResponseSchema,
  type VendorDetail,
  type VendorsListResponse,
} from '@aeci/shared';
import type { Context } from 'hono';

import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { validateResponseInDev, type PrismaFactory } from '../lib/handler-utils';
import {
  toVendorDetail,
  toVendorListItem,
  vendorDetailSelect,
  vendorListSelect,
} from '../lib/prisma-helpers';
import { resolveVendorSort } from '../lib/sort';
import { getPrisma } from '../prisma';

export function createVendorsListHandler(
  prismaFor: PrismaFactory = getPrisma,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const query = VendorsListQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));

    const where: { companyName?: { contains: string; mode: 'insensitive' }; verified?: boolean } =
      {};
    if (query.search) where.companyName = { contains: query.search, mode: 'insensitive' };
    if (query.verified !== undefined) where.verified = query.verified;

    const prisma = prismaFor(c.env);
    const [rows, total] = await Promise.all([
      prisma.vendor.findMany({
        where,
        orderBy: resolveVendorSort(query.sort),
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
        select: vendorListSelect,
      }),
      prisma.vendor.count({ where }),
    ]);

    const body: VendorsListResponse = {
      data: rows.map(toVendorListItem),
      page: query.page,
      perPage: query.perPage,
      total,
    };

    validateResponseInDev(c.env, () => {
      VendorsListResponseSchema.parse(body);
    });

    return json(body);
  };
}

export function createVendorDetailHandler(
  prismaFor: PrismaFactory = getPrisma,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const slug = c.req.param('slug');
    if (!slug) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing vendor slug', { field: 'slug' });
    }

    const prisma = prismaFor(c.env);
    const row = await prisma.vendor.findUnique({
      where: { slug },
      select: vendorDetailSelect,
    });

    if (!row) throw notFoundError('vendor', { slug });

    const body: VendorDetail = toVendorDetail(row);

    validateResponseInDev(c.env, () => {
      VendorDetailSchema.parse(body);
    });

    return json(body);
  };
}
