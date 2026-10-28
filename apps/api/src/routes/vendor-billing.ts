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
 *
 * ── THE STRIPE SUMMARY (E9.3, AECI-1501) ────────────────────────────────────────
 * `stripe` starts from D1: a fourth read in the same batch groups the live licenses
 * that carry a `stripe_subscription_id`. When one exists and a Stripe key is set, ONE
 * `retrieveSubscription` with a short timeout ({@link BILLING_READ_STRIPE_TIMEOUT_MS})
 * refines quantity, period end and the cancel flag, and the answer says
 * `synced: true`. Any failure answers the D1 view with `synced: false` and logs. A
 * Stripe outage never fails this read. No Stripe call happens for an account with
 * no live Stripe license.
 */

import {
  VENDOR_BILLING_LICENSES_MAX,
  VendorBillingResponseSchema,
  type VendorBillingLicense,
  type VendorBillingResponse,
  type VendorBillingStripe,
} from '@aeci/shared';
import { and, asc, desc, eq, isNull, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';

import { getDb, type Db } from '../db/client';
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
import {
  createStripeClient,
  subscriptionCurrentPeriodEnd,
  subscriptionInterval,
  subscriptionQuantity,
  type StripeClient,
} from '../lib/stripe';
import {
  liveStripeSubscriptionsSelect,
  stripeRoutesReady,
  toLiveStripeSubscriptions,
  type LiveStripeSubscription,
  type StripeClientFactory,
} from './vendor-billing-stripe';
import { requireSeatOwner, sessionVendorId, type VendorContext } from './vendor-shared';

/** The Billing read's Stripe timeout. Short: the read answers from D1 when it trips. */
export const BILLING_READ_STRIPE_TIMEOUT_MS = 3_000;

const readStripeFor: StripeClientFactory = (env) => {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  return secretKey
    ? createStripeClient({ secretKey, timeoutMs: BILLING_READ_STRIPE_TIMEOUT_MS })
    : null;
};

/**
 * Every license on the vendor's billing account(s), with its product and its open
 * early-unassign request. The caller adds the vendor filter. Shared with the E5.2
 * writes (`vendor-licenses.ts`), which answer with the one license they changed.
 */
export function vendorLicenseSelect(db: Db) {
  return (
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
  );
}

type VendorLicenseRow = Awaited<ReturnType<typeof vendorLicenseSelect>>[number];

/** One {@link vendorLicenseSelect} row as the owner sees it. */
export function toVendorBillingLicense(row: VendorLicenseRow): VendorBillingLicense {
  return {
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
  };
}

/** `GET /api/vendor/billing`. */
export function createVendorBillingHandler(
  dbFor: DbFactory = getDb,
  stripeFor: StripeClientFactory = readStripeFor,
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

    const [accountRows, licenseRows, assignableRows, stripeRows] = await db.batch([
      // One per vendor today (`billing_accounts_vendor_key`).
      db
        .select({
          id: billingAccounts.id,
          billingEmail: billingAccounts.billingEmail,
          stripeCustomerId: billingAccounts.stripeCustomerId,
        })
        .from(billingAccounts)
        .where(eq(billingAccounts.vendorId, vendorId))
        .orderBy(asc(billingAccounts.createdAt), asc(billingAccounts.id))
        .limit(1),
      vendorLicenseSelect(db)
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
      liveStripeSubscriptionsSelect(db, vendorId),
    ]);

    const account = accountRows[0] ?? null;

    const body: VendorBillingResponse = {
      billing_account: account ? { id: account.id, billing_email: account.billingEmail } : null,
      licenses: licenseRows.slice(0, VENDOR_BILLING_LICENSES_MAX).map(toVendorBillingLicense),
      licenses_truncated: licenseRows.length > VENDOR_BILLING_LICENSES_MAX,
      assignable_products: assignableRows,
      stripe: await stripeSummary(toLiveStripeSubscriptions(stripeRows)[0], stripeFor(c.env)),
      stripe_checkout_available: stripeRoutesReady(c.env),
      stripe_customer: account?.stripeCustomerId != null,
    };

    validateResponseInDev(c.env, () => VendorBillingResponseSchema.parse(body));
    return json(body);
  };
}

/**
 * The `stripe` block: the D1 view of the live subscription, refined by one Stripe read
 * when possible. Never throws: the client never does, and a failed read keeps the D1
 * view with `synced: false`.
 */
async function stripeSummary(
  live: LiveStripeSubscription | undefined,
  stripe: StripeClient | null,
): Promise<VendorBillingStripe | null> {
  if (!live) return null;
  const fromD1: VendorBillingStripe = {
    interval: live.interval,
    quantity: live.liveCount,
    current_period_end: live.latestEndsAt,
    cancel_at_period_end: live.cancelAtTermEnd,
    synced: false,
  };
  if (!stripe) return fromD1;

  const res = await stripe.retrieveSubscription(live.subscriptionId);
  if (!res.ok) {
    console.warn('billing read: stripe subscription read failed, answering from D1', {
      status: res.status,
      reason: res.reason,
      requestId: res.requestId,
    });
    return fromD1;
  }
  const interval = subscriptionInterval(res.data);
  const periodEnd = subscriptionCurrentPeriodEnd(res.data);
  return {
    interval: interval === 'year' || interval === 'month' ? interval : live.interval,
    quantity: subscriptionQuantity(res.data),
    current_period_end:
      periodEnd !== null ? new Date(periodEnd * 1000).toISOString() : live.latestEndsAt,
    cancel_at_period_end: res.data.cancel_at_period_end === true,
    synced: true,
  };
}
