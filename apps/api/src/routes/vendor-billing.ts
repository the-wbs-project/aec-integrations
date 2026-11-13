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
 *
 * ── PENDING GRANTS (AECI-1615) ──────────────────────────────────────────────────
 * A fifth read in the batch: the vendor's `license_grants` rows still
 * `pending_acceptance`, which the tab shows as "waiting for you" with the accept box.
 */

import {
  VENDOR_BILLING_LICENSES_MAX,
  VendorBillingResponseSchema,
  type VendorPendingGrant,
  type VendorBillingLicense,
  type VendorBillingResponse,
  type VendorBillingStripe,
} from '@aeci/shared';
import { and, asc, desc, eq, gt, inArray, isNull, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';

import { getDb, type Db } from '../db/client';
import {
  billingAccounts,
  licenseGrants,
  licenseReleaseRequests,
  licenses,
  productVendors,
  products,
} from '../db/schema';
import { json } from '../http';
import { loadCheckoutSigner } from '../lib/agreement-acceptances';
import { textAsc } from '../lib/collation';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import { loadLegalInForce } from '../lib/legal-in-force';
import { grantItems, PENDING, type LicenseGrantRow } from '../lib/license-grants';
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
        // Aliased (AECI-1511): this read rides a `db.batch`, where D1 rebuilds rows from
        // column NAMES, so a second bare ``id`` collapses into the first and every later
        // field shifts.
        requestId: sql<string | null>`${licenseReleaseRequests.id}`.as('request_id'),
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

    const [accountRows, licenseRows, assignableRows, stripeRows, grantRows] = await db.batch([
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
      // AECI-1615: grants waiting for an owner's accept, oldest first.
      db
        .select()
        .from(licenseGrants)
        // Past its end it can no longer be accepted, even before the sweep marks it.
        .where(
          and(
            eq(licenseGrants.vendorId, vendorId),
            eq(licenseGrants.status, PENDING),
            gt(licenseGrants.endsAt, new Date().toISOString()),
          ),
        )
        .orderBy(asc(licenseGrants.createdAt), asc(licenseGrants.id)),
    ]);

    const account = accountRows[0] ?? null;
    // AECI-1625: the legal name a checkout records, and this seat's own claim title to
    // pre-fill the buy form's "Your title". The same rule the checkout route applies.
    const signer = await loadCheckoutSigner(db, auth.userId, vendorId);
    const pendingGrants = await toVendorPendingGrants(db, vendorId, grantRows);

    const body: VendorBillingResponse = {
      billing_account: account ? { id: account.id, billing_email: account.billingEmail } : null,
      licenses: licenseRows.slice(0, VENDOR_BILLING_LICENSES_MAX).map(toVendorBillingLicense),
      licenses_truncated: licenseRows.length > VENDOR_BILLING_LICENSES_MAX,
      assignable_products: assignableRows,
      stripe: await stripeSummary(toLiveStripeSubscriptions(stripeRows)[0], stripeFor(c.env)),
      stripe_checkout_available: stripeRoutesReady(c.env),
      stripe_customer: account?.stripeCustomerId != null,
      legal_name: signer.companyLegalName,
      checkout_signer_title: signer.title,
      pending_grants: pendingGrants,
    };

    validateResponseInDev(c.env, () => VendorBillingResponseSchema.parse(body));
    return json(body);
  };
}

/**
 * The pending grants as the owner sees them (AECI-1615). A ban-term item names its
 * product when the vendor still owns it; one extra read, only when an item exists.
 */
async function toVendorPendingGrants(
  db: Db,
  vendorId: string,
  rows: readonly LicenseGrantRow[],
): Promise<VendorPendingGrant[]> {
  // AECI-1689: "current" is the version in force now, a published upcoming one from its
  // moment. No D1 read unless one can matter, and none at all with no pending grant.
  const inForce = rows.length === 0 ? null : await loadLegalInForce(db, new Date());
  const itemsOf = new Map(rows.map((row) => [row.id, grantItems(row)]));
  const productIds = [...new Set([...itemsOf.values()].flat().map((item) => item.product_id))];
  const named =
    productIds.length === 0
      ? []
      : await db
          .select({ id: products.id, slug: products.slug, name: products.name })
          .from(productVendors)
          .innerJoin(products, eq(products.id, productVendors.productId))
          .where(
            and(
              eq(productVendors.vendorId, vendorId),
              inArray(productVendors.productId, productIds),
            ),
          );
  const byId = new Map(named.map((p) => [p.id, p]));
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as VendorPendingGrant['kind'],
    status: row.status as VendorPendingGrant['status'],
    quantity: row.quantity,
    source: row.source,
    starts_at: row.startsAt,
    ends_at: row.endsAt,
    reference: row.reference,
    terms_version: row.termsVersion,
    terms_version_current: row.termsVersion === inForce?.agreements.managed_plan,
    items: (itemsOf.get(row.id) ?? []).map((item) => ({
      product: byId.get(item.product_id) ?? null,
      product_id: item.product_id,
      ends_at: item.ends_at,
    })),
    created_at: row.createdAt,
  }));
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
