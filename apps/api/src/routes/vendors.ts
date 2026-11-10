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
import { and, count, eq, inArray, like, type SQL } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import { fieldHides, vendors } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import {
  toVendorDetail,
  toVendorListItem,
  vendorDetailConfig,
  vendorListConfig,
} from '../lib/drizzle-helpers';
import { vendorCorrectionsQuery } from '../lib/field-corrections';
import { maskVendorDetail, maskVendorListItem } from '../lib/field-hide-mask';
import { groupHides, vendorHidesQuery } from '../lib/field-hides';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import { visibleVendorWhere } from '../lib/listing-visibility';
import { resolveVendorOrderBy } from '../lib/sort';

export function createVendorsListHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const query = VendorsListQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));

    const { db } = dbFor(c.env);
    // AECI-1238: a hidden company is in no list and no count.
    const conds: SQL[] = [visibleVendorWhere];
    if (query.search) conds.push(like(vendors.companyName, `%${query.search}%`));
    const where = and(...conds);

    const [rows, countRows, hideRows] = await Promise.all([
      db.query.vendors.findMany({
        ...vendorListConfig,
        where,
        orderBy: resolveVendorOrderBy(query.sort),
        limit: query.perPage,
        offset: (query.page - 1) * query.perPage,
      }),
      db.select({ value: count() }).from(vendors).where(where),
      // AECI-1238 (§11d.7): the two facts a card shows, when AECi hid them. Scoped by the
      // list's own filter and the two fields, not the page's ids: active hides are a
      // handful of admin rows, so this binds no id list and stays well under D1's cap.
      vendorHidesQuery(db, and(where, inArray(fieldHides.field, ['headquarters', 'founded_year']))),
    ]);
    const hides = groupHides(hideRows);

    const body: VendorsListResponse = {
      data: rows.map((row) => maskVendorListItem(toVendorListItem(row), hides)),
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
    // One round trip. `findMany` with `limit: 1`, never `findFirst`: an empty `findFirst`
    // result throws inside a D1 batch (`routes/products.ts`).
    const [[row], corrections, hideRows] = await db.batch([
      db.query.vendors.findMany({
        ...vendorDetailConfig,
        // AECI-1238: a hidden company 404s, exactly like an unknown slug.
        where: and(eq(vendors.slug, slug), visibleVendorWhere),
        limit: 1,
      }),
      // AECi's corrections on this company record (AECI-1614).
      vendorCorrectionsQuery(db, eq(vendors.slug, slug)),
      // AECi's active value hides on it (AECI-1238 §11d.7): masked below.
      vendorHidesQuery(db, eq(vendors.slug, slug)),
    ]);

    if (!row) throw notFoundError('vendor', { slug });

    const body: VendorDetail = maskVendorDetail(
      toVendorDetail(row, corrections),
      groupHides(hideRows),
    );

    validateResponseInDev(c.env, () => {
      VendorDetailSchema.parse(body);
    });

    return json(body);
  };
}
