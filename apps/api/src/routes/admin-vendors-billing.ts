/**
 * `GET /api/admin/vendors/:id/billing` (AECI-1372, E4.3; `docs/VENDOR_SIGNUP_PROCESS.md`
 * decision 17 and §3): the read-only Billing tab on `/admin/vendors/:id`
 * (`ADMIN_PANEL_SPEC.md` §5.7). Contract: `packages/shared/src/api/admin-vendor-billing.ts`,
 * `API_CONTRACTS.md` §6.10.
 *
 * Behind `requireAdmin()` at registration. A read: no audit row, never rate-limited
 * (ADR 0026), `private, no-store` from `json()`.
 *
 * ── ONE ROUND TRIP ──────────────────────────────────────────────────────────────
 * One `db.batch` of six reads: the vendor (the 404 gate), its billing account, its
 * owner seats, every license on its account(s) with the assigned product, its
 * early-unassign requests, and its agreement acceptances (`listVendorAcceptances`, the reader behind
 * `GET /api/admin/vendors/:id/acceptances`). The batch is the round-trip tool here, not
 * an atomicity one, as in `createAdminVendorDetailHandler`. The owner-seat emails are
 * one bounded GoTrue lookup after it, so the seat labels follow the AECI-1277 rule.
 *
 * ── NO ACCOUNT IS A 200 ─────────────────────────────────────────────────────────
 * A vendor without a billing account is an E1 back-fill defect, not a 404: the tab
 * says so. `billing_account: null`, `licenses: []`, acceptances still read (a claim
 * acceptance names the vendor directly).
 *
 * ── BOUNDED ─────────────────────────────────────────────────────────────────────
 * Each list reads its cap plus one, to set `*_truncated` without a count query. Live
 * licenses sort first, so the cap drops old ended rows before any live one.
 *
 * `release_requests` (AECI-1373) is the vendor's early-unassign requests: open first,
 * then decided, newest first within each, capped at `ADMIN_BILLING_RELEASE_REQUESTS_MAX`.
 * A sixth read in the same batch, through the queue's own joined select
 * (`lib/license-release-requests.ts`), so the tab and `/admin/requests` show one shape.
 */

import {
  ADMIN_BILLING_ACCEPTANCES_MAX,
  ADMIN_BILLING_LICENSES_MAX,
  ADMIN_BILLING_RELEASE_REQUESTS_MAX,
  AdminVendorBillingResponseSchema,
  ApiErrorCode,
  type AdminBillingLicense,
  type AdminVendorBillingResponse,
} from '@aeci/shared';
import { asc, desc, eq, sql } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import {
  billingAccounts,
  licenseReleaseRequests,
  licenses,
  products,
  profiles,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { listVendorAcceptances } from '../lib/agreement-acceptances';
import {
  releaseRequestSelect,
  toAdminLicenseReleaseRequest,
} from '../lib/license-release-requests';
import type { AuthzVariables } from '../lib/authz';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import { fetchAuthUserEmailsResult } from '../lib/supabase-admin';
import { toAdminAcceptance } from './admin-vendor-acceptances';
import type { FetchAuthEmails } from './admin-vendors';
import { ownerSeatsOf } from './vendor-shared';

type AdminContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

export function createAdminVendorBillingHandler(
  dbFor: DbFactory = getDb,
  fetchEmails: FetchAuthEmails = fetchAuthUserEmailsResult,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const vendorId = c.req.param('id');
    if (!vendorId) {
      throw new ApiError(400, ApiErrorCode.VALIDATION_FAILED, 'Missing id', { field: 'id' });
    }
    const { db } = dbFor(c.env);

    const [vendorRows, accountRows, ownerRows, licenseRows, acceptanceRows, releaseRows] =
      await db.batch([
        db.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, vendorId)).limit(1),
        // One per vendor today (`billing_accounts_vendor_key`).
        db
          .select({
            id: billingAccounts.id,
            name: billingAccounts.name,
            billingEmail: billingAccounts.billingEmail,
            stripeCustomerId: billingAccounts.stripeCustomerId,
            createdAt: billingAccounts.createdAt,
          })
          .from(billingAccounts)
          .where(eq(billingAccounts.vendorId, vendorId))
          .orderBy(asc(billingAccounts.createdAt), asc(billingAccounts.id))
          .limit(1),
        // Banned owners included and flagged: a last-seat ban is what sets
        // `cancel_at_term_end` (E4.5), so the operator needs to see it here.
        db
          .select({
            id: profiles.id,
            displayName: profiles.displayName,
            bannedAt: profiles.bannedAt,
          })
          .from(profiles)
          .where(ownerSeatsOf(vendorId))
          .orderBy(asc(profiles.createdAt), asc(profiles.id)),
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
            cancelReason: licenses.cancelReason,
            stripeSubscriptionId: licenses.stripeSubscriptionId,
            termsVersion: licenses.termsVersion,
            grantedBy: licenses.grantedBy,
            createdAt: licenses.createdAt,
          })
          .from(licenses)
          .innerJoin(billingAccounts, eq(billingAccounts.id, licenses.billingAccountId))
          .leftJoin(products, eq(products.id, licenses.assignedProductId))
          .where(eq(billingAccounts.vendorId, vendorId))
          // Live first, oldest first (the order decision 12 keeps licenses in); then
          // ended, most recently ended first. `id` breaks every tie.
          .orderBy(
            sql`${licenses.endedAt} IS NULL DESC`,
            desc(licenses.endedAt),
            asc(licenses.createdAt),
            asc(licenses.id),
          )
          .limit(ADMIN_BILLING_LICENSES_MAX + 1),
        listVendorAcceptances(db, vendorId).limit(ADMIN_BILLING_ACCEPTANCES_MAX + 1),
        // AECI-1373: open first, then decided, newest first within each.
        releaseRequestSelect(db)
          .where(eq(licenseReleaseRequests.vendorId, vendorId))
          .orderBy(
            sql`${licenseReleaseRequests.status} = 'open' DESC`,
            desc(licenseReleaseRequests.createdAt),
            asc(licenseReleaseRequests.id),
          )
          .limit(ADMIN_BILLING_RELEASE_REQUESTS_MAX),
      ]);

    if (vendorRows.length === 0) throw notFoundError('vendor', { id: vendorId });

    const account = accountRows[0] ?? null;

    // One bounded GoTrue lookup, after the batch so it never widens the D1 hop. Only
    // when there is an account to show the seats on.
    const lookup =
      account && ownerRows.length > 0
        ? await fetchEmails(
            c.env,
            ownerRows.map((row) => row.id),
          )
        : { available: true, emails: new Map<string, string>() };

    const body: AdminVendorBillingResponse = {
      vendor_id: vendorId,
      billing_account: account
        ? {
            id: account.id,
            name: account.name,
            billing_email: account.billingEmail,
            stripe_customer_id: account.stripeCustomerId,
            created_at: account.createdAt,
            owner_seats: ownerRows.map((row) => ({
              user_id: row.id,
              display_name: row.displayName,
              email: lookup.emails.get(row.id) ?? null,
              banned: row.bannedAt !== null,
            })),
            seat_emails_available: lookup.available,
          }
        : null,
      licenses: licenseRows.slice(0, ADMIN_BILLING_LICENSES_MAX).map(
        (row): AdminBillingLicense => ({
          id: row.id,
          source: row.source,
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
          cancel_reason: row.cancelReason,
          stripe_subscription_id: row.stripeSubscriptionId,
          terms_version: row.termsVersion,
          granted_by: row.grantedBy,
          created_at: row.createdAt,
        }),
      ),
      licenses_truncated: licenseRows.length > ADMIN_BILLING_LICENSES_MAX,
      acceptances: acceptanceRows.slice(0, ADMIN_BILLING_ACCEPTANCES_MAX).map(toAdminAcceptance),
      acceptances_truncated: acceptanceRows.length > ADMIN_BILLING_ACCEPTANCES_MAX,
      release_requests: releaseRows.map(toAdminLicenseReleaseRequest),
    };

    validateResponseInDev(c.env, () => AdminVendorBillingResponseSchema.parse(body));
    return json(body);
  };
}
