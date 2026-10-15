/**
 * `GET /api/admin/vendors/:id/acceptances` (AECI-1362, E2.4): every agreement
 * acceptance of one vendor, with the evidence columns (`ip`, `user_agent`) the vendor
 * read omits. The admin panel's read-only half of decision 17
 * (`docs/VENDOR_SIGNUP_PROCESS.md` §2). Contract: `API_CONTRACTS.md`, table
 * `DATABASE_SCHEMA.md` §8.6d.
 *
 * Behind `requireAdmin()` at registration. A read: no audit row, never rate-limited,
 * `private, no-store` from `json()`. An unknown vendor id is a 404, the
 * `createAdminVendorAuditHandler` gate: an empty 200 would read as "this vendor
 * accepted nothing".
 */

import {
  AdminAgreementAcceptancesResponseSchema,
  ApiErrorCode,
  type AdminAgreementAcceptance,
  type AdminAgreementAcceptancesResponse,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import { vendors } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { listVendorAcceptances, type AgreementAcceptanceRow } from '../lib/agreement-acceptances';
import type { AuthzVariables } from '../lib/authz';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import { toVendorAcceptance } from './vendor-billing-acceptances';

type AdminContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

/** AECi's view of a row: the vendor view plus the evidence columns. */
export function toAdminAcceptance(row: AgreementAcceptanceRow): AdminAgreementAcceptance {
  return {
    ...toVendorAcceptance(row),
    vendor_id: row.vendorId,
    ip: row.ip,
    user_agent: row.userAgent,
    created_at: row.createdAt,
  };
}

export function createAdminVendorAcceptancesHandler(
  dbFor: DbFactory = getDb,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const vendorId = c.req.param('id');
    if (!vendorId) {
      throw new ApiError(400, ApiErrorCode.VALIDATION_FAILED, 'Missing id', { field: 'id' });
    }
    const { db } = dbFor(c.env);

    const exists = await db.query.vendors.findFirst({
      columns: { id: true },
      where: eq(vendors.id, vendorId),
    });
    if (!exists) throw notFoundError('vendor', { id: vendorId });

    const rows = await listVendorAcceptances(db, vendorId);
    const body: AdminAgreementAcceptancesResponse = {
      acceptances: rows.map(toAdminAcceptance),
    };
    validateResponseInDev(c.env, () => AdminAgreementAcceptancesResponseSchema.parse(body));
    return json(body);
  };
}
