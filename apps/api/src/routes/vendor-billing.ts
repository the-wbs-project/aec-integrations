/**
 * `GET /api/vendor/billing` (AECI-1387, E5.1 of AECI-1335): the owner's Billing tab
 * (`docs/VENDOR_SIGNUP_PROCESS.md` §2 decisions 10, 11, 16, 17). Contract:
 * `packages/shared/src/api/vendor-billing.ts`, `API_CONTRACTS.md` §6.14.
 *
 * ── GATES, IN ORDER ─────────────────────────────────────────────────────────────
 * `requireVendor()` at registration, then `requireSeatOwner()` here (billing is an
 * owner's act, so a member seat gets `403`), then the vendor filter on every read.
 * The vendor id comes from the session, never the request. No capability gate: the
 * fourth named exception of `API_CONTRACTS.md` §6.14 invariant 3, so a lapsed vendor
 * can still see its licenses.
 *
 * A read: no audit row, never rate-limited (ADR 0026), `private, no-store` from
 * `json()`.
 *
 * ── ONE ROUND TRIP ──────────────────────────────────────────────────────────────
 * One `db.batch` of three reads, the shapes of `admin-vendors-billing.ts`: the billing
 * account, every license on the vendor's account(s) with its product and its open
 * early-unassign request, and the assignable products. The batch is a round-trip
 * tool, not an atomicity one.
 *
 * ── ASSIGNABLE MEANS "NO LIVE LICENSE FROM ANYONE" ──────────────────────────────
 * A product the vendor co-owns may already hold a live license on the OTHER vendor's
 * account. The global partial unique index on `licenses.assigned_product_id` would
 * refuse a second one, so the list leaves it out rather than offering a choice the
 * assign route (E5.2) must turn down.
 */

import {
  VENDOR_BILLING_LICENSES_MAX,
  VendorBillingResponseSchema,
  type VendorBillingLicense,
  type VendorBillingResponse,
} from '@aeci/shared';
import { and, asc, desc, eq, isNull, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';

import { getDb } from '../db/client';
import {
  billingAccounts,
  licenseReleaseRequests,
  licenses,
  productVendors,
  products,
} from '../db/schema';
import { json } from '../http';
import { textAsc } from '../lib/collation';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import { requireSeatOwner, sessionVendorId, type VendorContext } from './vendor-shared';

/** `GET /api/vendor/billing`. */
export function createVendorBillingHandler(
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
      'Only a vendor account owner can see billing',
    );

    const liveOnProduct = alias(licenses, 'live_on_product');

    const [accountRows, licenseRows, assignableRows] = await db.batch([
      // One per vendor today (`billing_accounts_vendor_key`).
      db
        .select({ id: billingAccounts.id, billingEmail: billingAccounts.billingEmail })
        .from(billingAccounts)
        .where(eq(billingAccounts.vendorId, vendorId))
        .orderBy(asc(billingAccounts.createdAt), asc(billingAccounts.id))
        .limit(1),
      db
        .select({
          id: licenses.id,
          source: licenses.source,
          startsAt: licenses.startsAt,
          endsAt: licenses.endsAt,
          endedAt: licenses.endedAt,
          endReason: licenses.endReason,
          reference: licenses.reference,
          assignedProductId: licenses.assignedProductId,
          productSlug: products.slug,
          productName: products.name,
          assignedAt: licenses.assignedAt,
          releaseAtRenewal: licenses.releaseAtRenewal,
          cancelAtTermEnd: licenses.cancelAtTermEnd,
          requestId: licenseReleaseRequests.id,
          requestCreatedAt: licenseReleaseRequests.createdAt,
        })
        .from(licenses)
        .innerJoin(billingAccounts, eq(billingAccounts.id, licenses.billingAccountId))
        .leftJoin(products, eq(products.id, licenses.assignedProductId))
        // At most one open request per license (the partial unique index), so the
        // join never fans a license out.
        .leftJoin(
          licenseReleaseRequests,
          and(
            eq(licenseReleaseRequests.licenseId, licenses.id),
            eq(licenseReleaseRequests.status, 'open'),
          ),
        )
        .where(eq(billingAccounts.vendorId, vendorId))
        // The admin read's order: live first, oldest first; then ended, most
        // recently ended first. `id` breaks every tie.
        .orderBy(
          sql`${licenses.endedAt} IS NULL DESC`,
          desc(licenses.endedAt),
          asc(licenses.createdAt),
          asc(licenses.id),
        )
        .limit(VENDOR_BILLING_LICENSES_MAX + 1),
      db
        .select({ id: products.id, slug: products.slug, name: products.name })
        .from(productVendors)
        .innerJoin(products, eq(products.id, productVendors.productId))
        .where(
          and(
            eq(productVendors.vendorId, vendorId),
            notExists(
              db
                .select({ one: sql`1` })
                .from(liveOnProduct)
                .where(
                  and(
                    eq(liveOnProduct.assignedProductId, products.id),
                    isNull(liveOnProduct.endedAt),
                  ),
                ),
            ),
          ),
        )
        // Case-insensitive (AECI-825); `id` keeps the order total.
        .orderBy(textAsc(products.name), asc(products.id)),
    ]);

    const account = accountRows[0] ?? null;

    const body: VendorBillingResponse = {
      billing_account: account ? { id: account.id, billing_email: account.billingEmail } : null,
      licenses: licenseRows.slice(0, VENDOR_BILLING_LICENSES_MAX).map(
        (row): VendorBillingLicense => ({
          id: row.id,
          source: row.source as VendorBillingLicense['source'],
          starts_at: row.startsAt,
          ends_at: row.endsAt,
          ended_at: row.endedAt,
          end_reason: row.endReason,
          live: row.endedAt === null,
          reference: row.reference,
          assigned_product:
            row.assignedProductId && row.productSlug !== null && row.productName !== null
              ? { id: row.assignedProductId, slug: row.productSlug, name: row.productName }
              : null,
          assigned_at: row.assignedAt,
          release_at_renewal: row.releaseAtRenewal,
          cancel_at_term_end: row.cancelAtTermEnd,
          open_release_request:
            row.requestId !== null && row.requestCreatedAt !== null
              ? { id: row.requestId, created_at: row.requestCreatedAt }
              : null,
        }),
      ),
      licenses_truncated: licenseRows.length > VENDOR_BILLING_LICENSES_MAX,
      assignable_products: assignableRows,
    };

    validateResponseInDev(c.env, () => VendorBillingResponseSchema.parse(body));
    return json(body);
  };
}
