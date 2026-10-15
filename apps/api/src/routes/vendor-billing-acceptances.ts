/**
 * `GET /api/vendor/billing/acceptances` (AECI-1362, E2.4): the agreement acceptances
 * of the caller's vendor, for the Billing tab's "acceptance records" (decision 17 of
 * `docs/VENDOR_SIGNUP_PROCESS.md` §2). Contract: `API_CONTRACTS.md` §6.14, table
 * `DATABASE_SCHEMA.md` §8.6d.
 *
 * Three gates, in the seat-management order (`vendor-seat-invites.ts`):
 * `requireVendor()` at registration, then `requireSeatOwner()` (owner seats only, as
 * the whole Billing tab is), then the vendor filter in `listVendorAcceptances`. The
 * vendor id comes from the session, never the request.
 *
 * A read: no audit row, never rate-limited, `private, no-store` from `json()`. The
 * response never carries `ip` or `user_agent`; those are AECi's evidence and only
 * `GET /api/admin/vendors/:id/acceptances` returns them.
 */

import {
  VendorAgreementAcceptancesResponseSchema,
  type VendorAgreementAcceptance,
  type VendorAgreementAcceptancesResponse,
} from '@aeci/shared';

import { getDb } from '../db/client';
import { json } from '../http';
import { listVendorAcceptances, type AgreementAcceptanceRow } from '../lib/agreement-acceptances';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import { requireSeatOwner, sessionVendorId, type VendorContext } from './vendor-shared';

/** The vendor's view of a row. The evidence columns are dropped here, by name. */
export function toVendorAcceptance(row: AgreementAcceptanceRow): VendorAgreementAcceptance {
  return {
    id: row.id,
    document: row.document as VendorAgreementAcceptance['document'],
    version: row.version,
    source: row.source as VendorAgreementAcceptance['source'],
    email: row.email,
    profile_id: row.profileId,
    billing_account_id: row.billingAccountId,
    vendor_request_id: row.vendorRequestId,
    stripe_checkout_session_id: row.stripeCheckoutSessionId,
    accepted_at: row.acceptedAt,
  };
}

export function createVendorBillingAcceptancesHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const auth = c.get('auth');
    const vendorId = sessionVendorId(c);
    const { db } = dbFor(c.env);

    await requireSeatOwner(
      db,
      auth.userId,
      vendorId,
      'Only a vendor account owner can see billing records',
    );

    const rows = await listVendorAcceptances(db, vendorId);
    const body: VendorAgreementAcceptancesResponse = {
      acceptances: rows.map(toVendorAcceptance),
    };
    validateResponseInDev(c.env, () => VendorAgreementAcceptancesResponseSchema.parse(body));
    return json(body);
  };
}
