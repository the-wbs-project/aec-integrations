/**
 * The owner's Stripe routes on the Billing tab (AECI-1501, E9.3 of the AECI-1339 epic;
 * `docs/VENDOR_SIGNUP_PROCESS.md` §2 decisions 7 to 10 and 13, §3 steps 4 and 7).
 * Contract: `packages/shared/src/api/vendor-billing.ts`, `API_CONTRACTS.md` §6.14.
 *
 *   POST /api/vendor/billing/checkout        a Checkout Session for a new subscription
 *   POST /api/vendor/billing/licenses/add    raise the subscription's quantity
 *   POST /api/vendor/billing/portal          a Customer Portal session, also for a
 *                                            lapsed customer (invoices and receipts)
 *
 * ── GATES, IN ORDER ─────────────────────────────────────────────────────────────
 * `requireVendor()` then `rateLimit('write')` at registration, the order of every
 * Billing write. Then `requireSeatOwner()` here: billing is an owner's act (decision
 * 10), so a member seat gets `403`. Then the tier gate: `503 STRIPE_UNAVAILABLE`
 * unless {@link stripeRoutesReady}. No capability gate (the fourth named exception of
 * `API_CONTRACTS.md` §6.14 invariant 3).
 *
 * ── LICENSES ARE WEBHOOK-OWNED ──────────────────────────────────────────────────
 * None of these routes writes a license. Checkout and add only ask Stripe for money.
 * The licenses land when `POST /api/webhooks/stripe` (E9.2) syncs the subscription,
 * so the tab re-reads `GET /api/vendor/billing` after the redirect back. The one D1
 * write here is the Stripe customer id on the billing account, with its audit row.
 *
 * ── WHAT "A LIVE STRIPE SUBSCRIPTION" MEANS ─────────────────────────────────────
 * Live licenses (`ended_at IS NULL`) on the account carrying a `stripe_subscription_id`
 * ({@link loadLiveStripeSubscriptions}). The interval comes from the rows: monthly rows
 * have `ends_at` NULL, annual rows carry the period end (epic plan P0). A subscription
 * Stripe holds but the webhook has not yet synced is invisible here; the reconcile job
 * (E9.5) closes that gap.
 *
 * ── IDEMPOTENCY KEYS ────────────────────────────────────────────────────────────
 *   - customer: `aeci-customer-<billing account id>`. Two racing first checkouts get the
 *     same customer. The params carry only account data, so the key never sees two
 *     different bodies.
 *   - checkout: account, owner, interval, quantity and the UTC minute. A double click
 *     returns the same session. A new click a minute later gets a new one.
 *   - add: subscription, the quantity Stripe reported, and the delta. A double click
 *     reads the same quantity, so Stripe replays the first update. A later click reads
 *     the raised quantity and adds again, which is what the owner asked for.
 *   - portal: account and the UTC minute.
 *
 * ── STATEMENT DESCRIPTOR (R3, 2026-10-28) ───────────────────────────────────────
 * Subscription-mode Checkout takes no statement descriptor suffix. Stripe documents
 * `statement_descriptor_suffix` only under `payment_intent_data` (payment mode), and
 * `subscription_data.invoice_settings` holds only `issuer` and `rendering`. Stripe
 * creates subscription charges itself, so the card statement reads the account
 * descriptor, or a Product's `statement_descriptor` if one is set in the dashboard.
 * Nothing is sent here.
 */

import {
  AddStripeLicensesRequestSchema,
  AddStripeLicensesResponseSchema,
  ApiErrorCode,
  LEGAL_AGREEMENT_CURRENT_VERSIONS,
  StripeCheckoutRequestSchema,
  StripeRedirectResponseSchema,
  type AddStripeLicensesResponse,
  type StripeBillingInterval,
  type StripeRedirectResponse,
} from '@aeci/shared';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { getDb } from '../db/client';
import { auditLog, billingAccounts, licenses, vendors } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import type { BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { stripeCustomerLinkStatements } from '../lib/billing-account';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { publicSiteBase } from '../lib/public-urls';
import {
  stripeCheckoutAvailable,
  stripeClientFromEnv,
  stripePortalConfigFor,
  subscriptionInterval,
  subscriptionQuantity,
  type StripeClient,
  type StripeFailure,
} from '../lib/stripe';
import {
  afterVendorWrite,
  AUDIT_SOURCE,
  parseJsonBody,
  requireSeatOwner,
  sessionVendorId,
  sessionVendorPlan,
  type VendorContext,
} from './vendor-shared';

/** Builds the Stripe client for a request. Injected so specs pass a fake. */
export type StripeClientFactory = (env: Env) => StripeClient | null;

const defaultStripeFor: StripeClientFactory = (env) => stripeClientFromEnv(env);

/** The Stripe price lookup key per interval (epic ruling: prices resolve by lookup key). */
export const STRIPE_PRICE_LOOKUP_KEYS: Record<StripeBillingInterval, string> = {
  year: 'managed_annual',
  month: 'managed_monthly',
};

/**
 * Whether the three Stripe routes can run on this tier: the `STRIPE_CHECKOUT_ENABLED`
 * flag and the secret key (`stripeCheckoutAvailable`), plus `PUBLIC_SITE_URL`, without
 * which no return URL can be built. `GET /api/vendor/billing` reports this as
 * `stripe_checkout_available`. The portal additionally needs its interval's config id,
 * checked in its handler.
 */
export function stripeRoutesReady(env: Env): boolean {
  return stripeCheckoutAvailable(env) && publicSiteBase(env) !== null;
}

/** One live Stripe subscription as D1 sees it. */
export interface LiveStripeSubscription {
  subscriptionId: string;
  /** Live licenses carrying the id. */
  liveCount: number;
  /** Monthly rows have `ends_at` NULL; annual rows carry the period end. */
  interval: StripeBillingInterval;
  /** The latest `ends_at` of the rows, or `null` (monthly). */
  latestEndsAt: string | null;
  /** Any of the rows is flagged to end at term end. */
  cancelAtTermEnd: boolean;
}

/**
 * The live Stripe subscriptions on the vendor's billing account(s), oldest first. One in practice:
 * checkout refuses a second. Shared with `GET /api/vendor/billing`.
 */
export function liveStripeSubscriptionsSelect(db: Db, vendorId: string) {
  return db
    .select({
      subscriptionId: licenses.stripeSubscriptionId,
      liveCount: sql<number>`count(*)`.mapWith(Number),
      // NULL when every row is monthly: SQLite's max() skips NULLs.
      latestEndsAt: sql<string | null>`max(${licenses.endsAt})`,
      anyNullEndsAt: sql<number>`max(${licenses.endsAt} IS NULL)`.mapWith(Number),
      anyCancel: sql<number>`max(${licenses.cancelAtTermEnd})`.mapWith(Number),
    })
    .from(licenses)
    .innerJoin(billingAccounts, eq(billingAccounts.id, licenses.billingAccountId))
    .where(
      and(
        eq(billingAccounts.vendorId, vendorId),
        isNull(licenses.endedAt),
        isNotNull(licenses.stripeSubscriptionId),
      ),
    )
    .groupBy(licenses.stripeSubscriptionId)
    .orderBy(sql`min(${licenses.createdAt})`, asc(licenses.stripeSubscriptionId));
}

type LiveStripeRow = Awaited<ReturnType<typeof liveStripeSubscriptionsSelect>>[number];

/** Map {@link liveStripeSubscriptionsSelect} rows. */
export function toLiveStripeSubscriptions(rows: LiveStripeRow[]): LiveStripeSubscription[] {
  return rows
    .filter((r): r is LiveStripeRow & { subscriptionId: string } => r.subscriptionId !== null)
    .map((r) => ({
      subscriptionId: r.subscriptionId,
      liveCount: r.liveCount,
      interval: r.anyNullEndsAt ? 'month' : 'year',
      latestEndsAt: r.latestEndsAt,
      cancelAtTermEnd: r.anyCancel === 1,
    }));
}

/** The account a Stripe route works on, with its vendor slug for the return URL. */
interface StripeAccount {
  id: string;
  name: string;
  stripeCustomerId: string | null;
  vendorSlug: string;
  subscriptions: LiveStripeSubscription[];
}

async function loadStripeAccount(db: Db, vendorId: string): Promise<StripeAccount> {
  const [accountRows, subscriptionRows] = await db.batch([
    db
      .select({
        id: billingAccounts.id,
        name: billingAccounts.name,
        stripeCustomerId: billingAccounts.stripeCustomerId,
        vendorSlug: vendors.slug,
      })
      .from(billingAccounts)
      .innerJoin(vendors, eq(vendors.id, billingAccounts.vendorId))
      .where(eq(billingAccounts.vendorId, vendorId))
      .orderBy(asc(billingAccounts.createdAt), asc(billingAccounts.id))
      .limit(1),
    liveStripeSubscriptionsSelect(db, vendorId),
  ]);
  const account = accountRows[0];
  // An E1 back-fill defect, not a caller error; the GET reports `billing_account: null`.
  if (!account) throw notFoundError('billing_account', { id: vendorId });
  return { ...account, subscriptions: toLiveStripeSubscriptions(subscriptionRows) };
}

/** The Billing tab, absolute: `<site>/vendor/<slug>/billing`. */
function billingTabUrl(base: string, vendorSlug: string): string {
  return `${base}/vendor/${encodeURIComponent(vendorSlug)}/billing`;
}

/** The UTC minute, for idempotency keys that should absorb a double click only. */
function minuteBucket(now: Date): number {
  return Math.floor(now.getTime() / 60_000);
}

function unavailable(): ApiError {
  return new ApiError(
    503,
    ApiErrorCode.STRIPE_UNAVAILABLE,
    'Buying licenses online is not available right now',
  );
}

/** A Stripe call failed. Logged with Stripe's request id, answered as a retryable 503. */
function stripeFailed(step: string, failure: StripeFailure): ApiError {
  console.warn('stripe call failed', {
    step,
    status: failure.status,
    reason: failure.reason,
    code: failure.code,
    requestId: failure.requestId,
  });
  return new ApiError(503, ApiErrorCode.DEPENDENCY_FAILURE, 'Stripe did not answer. Try again');
}

/** The tier gate shared by the three routes. Returns the client and the site base. */
function requireStripe(
  c: VendorContext,
  stripeFor: StripeClientFactory,
): { stripe: StripeClient; base: string } {
  const base = publicSiteBase(c.env);
  const stripe = stripeRoutesReady(c.env) ? stripeFor(c.env) : null;
  if (!stripe || !base) throw unavailable();
  return { stripe, base };
}

/**
 * The text beside Stripe's required terms box (`custom_text.terms_of_service_acceptance`,
 * Markdown links allowed). The same words as the claim form's box (decision 3), naming
 * the Managed plan agreement (decision 9).
 */
export function managedPlanAgreementMessage(base: string): string {
  return `I accept the [Managed plan agreement](${base}/legal/managed-plan-agreement) for these licenses.`;
}

/** `POST /api/vendor/billing/checkout`. */
export function createStripeCheckoutHandler(
  dbFor: DbFactory = getDb,
  stripeFor: StripeClientFactory = defaultStripeFor,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const { db } = writeDb(c, dbFor);

    // 1. Owner seats only (decision 10). 2. The tier sells through Stripe. 3. Shape.
    await requireSeatOwner(
      db,
      session.userId,
      vendorId,
      'Only a vendor account owner can buy licenses',
    );
    const { stripe, base } = requireStripe(c, stripeFor);
    const payload = await parseJsonBody(c, StripeCheckoutRequestSchema);

    // 4. One subscription per account, one interval per account.
    const account = await loadStripeAccount(db, vendorId);
    const existing = account.subscriptions[0];
    if (existing) {
      if (existing.interval !== payload.interval) {
        throw new ApiError(
          409,
          ApiErrorCode.LICENSE_INTERVAL_MISMATCH,
          'Your licenses are billed on another interval. Add licenses to that subscription',
          { details: { interval: existing.interval } },
        );
      }
      throw new ApiError(
        409,
        ApiErrorCode.STRIPE_SUBSCRIPTION_EXISTS,
        'You already have a subscription. Add licenses to it instead',
        { details: { interval: existing.interval } },
      );
    }

    // 5. The price, by lookup key, and a sanity check on its interval.
    const price = await stripe.getPriceByLookupKey(STRIPE_PRICE_LOOKUP_KEYS[payload.interval]);
    if (!price.ok) throw stripeFailed('price', price);
    if (price.data.recurring?.interval !== payload.interval) {
      console.warn('stripe price interval does not match its lookup key', {
        lookupKey: STRIPE_PRICE_LOOKUP_KEYS[payload.interval],
        priceId: price.data.id,
      });
      throw unavailable();
    }

    // 6. The Stripe customer, created once per account and recorded BEFORE Checkout.
    const now = new Date();
    const customerId =
      account.stripeCustomerId ?? (await linkCustomer(c, db, stripe, account, now));

    // 7. The Checkout Session.
    const tab = billingTabUrl(base, account.vendorSlug);
    const metadata = {
      billing_account_id: account.id,
      vendor_id: vendorId,
      profile_id: session.userId,
      terms_version: LEGAL_AGREEMENT_CURRENT_VERSIONS.managed_plan,
    };
    const checkout = await stripe.createCheckoutSession(
      {
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price: price.data.id, quantity: payload.quantity }],
        success_url: `${tab}?checkout=success`,
        cancel_url: `${tab}?checkout=cancelled`,
        client_reference_id: account.id,
        metadata,
        subscription_data: { metadata },
        consent_collection: { terms_of_service: 'required' },
        custom_text: {
          terms_of_service_acceptance: { message: managedPlanAgreementMessage(base) },
        },
        automatic_tax: { enabled: true },
        tax_id_collection: { enabled: true },
        billing_address_collection: 'required',
        customer_update: { address: 'auto', name: 'auto' },
        allow_promotion_codes: true,
      },
      [
        'aeci-checkout',
        account.id,
        session.userId,
        payload.interval,
        payload.quantity,
        minuteBucket(now),
      ].join('-'),
    );
    if (!checkout.ok) throw stripeFailed('checkout', checkout);
    // A replayed key for a session already completed or expired has no page.
    if (!checkout.data.url) throw stripeFailed('checkout', noUrl(checkout.data.id));

    const body: StripeRedirectResponse = { url: checkout.data.url };
    validateResponseInDev(c.env, () => StripeRedirectResponseSchema.parse(body));
    return json(body);
  };
}

function noUrl(id: string): StripeFailure {
  return { ok: false, status: 200, reason: 'invalid_response', message: `${id} has no url` };
}

/**
 * Create the account's Stripe customer and record its id with its audit row, in one
 * batch, guarded on the column still being empty. Returns the id now stored, which is
 * another writer's when this one lost the race.
 */
async function linkCustomer(
  c: VendorContext,
  db: Db,
  stripe: StripeClient,
  account: StripeAccount,
  now: Date,
): Promise<string> {
  const vendorId = sessionVendorId(c);
  const customer = await stripe.createCustomer(
    { name: account.name, metadata: { billing_account_id: account.id, vendor_id: vendorId } },
    `aeci-customer-${account.id}`,
  );
  if (!customer.ok) throw stripeFailed('customer', customer);

  const session = c.get('auth');
  const batch = stripeCustomerLinkStatements(db, {
    billingAccountId: account.id,
    vendorId,
    stripeCustomerId: customer.data.id,
    now: now.toISOString(),
    actorId: session.userId,
    actorType: auditActorType(session),
    vendorPlan: sessionVendorPlan(c, now),
    source: AUDIT_SOURCE,
  });
  await db.batch(batch.stmts as BatchTuple);

  const [stored, landed] = await db.batch([
    db
      .select({ id: billingAccounts.stripeCustomerId })
      .from(billingAccounts)
      .where(eq(billingAccounts.id, account.id)),
    db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.id, batch.auditEntry.id!)),
  ]);
  // Forward the audit row only when the guard let it land. No cache tag: no page reads it.
  if (landed.length > 0) afterVendorWrite(c, [], batch.auditEntry);
  return stored[0]?.id ?? customer.data.id;
}

function subscriptionRequired(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.STRIPE_SUBSCRIPTION_REQUIRED,
    'You have no subscription yet. Buy licenses first',
  );
}

/** The live subscription, or `409 STRIPE_SUBSCRIPTION_REQUIRED`. */
function requireSubscription(account: StripeAccount): LiveStripeSubscription {
  const sub = account.subscriptions[0];
  if (!sub) throw subscriptionRequired();
  return sub;
}

/** `POST /api/vendor/billing/licenses/add`. */
export function createAddStripeLicensesHandler(
  dbFor: DbFactory = getDb,
  stripeFor: StripeClientFactory = defaultStripeFor,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const { db } = writeDb(c, dbFor);

    await requireSeatOwner(
      db,
      session.userId,
      vendorId,
      'Only a vendor account owner can add licenses',
    );
    const { stripe } = requireStripe(c, stripeFor);
    const payload = await parseJsonBody(c, AddStripeLicensesRequestSchema);

    const account = await loadStripeAccount(db, vendorId);
    const live = requireSubscription(account);

    // Stripe's quantity is the base, not the D1 count: an earlier add may not have
    // landed its licenses yet, and adding to the D1 count would undo it.
    const sub = await stripe.retrieveSubscription(live.subscriptionId);
    if (!sub.ok) throw stripeFailed('retrieve', sub);
    const item = sub.data.items?.data?.[0];
    if (!item || !['active', 'trialing', 'past_due'].includes(sub.data.status)) {
      throw new ApiError(
        409,
        ApiErrorCode.STRIPE_SUBSCRIPTION_REQUIRED,
        'Your subscription is not active. Buy licenses again',
        { details: { status: sub.data.status } },
      );
    }
    const current = subscriptionQuantity(sub.data);
    const updated = await stripe.updateSubscription(
      live.subscriptionId,
      {
        item: { id: item.id, quantity: current + payload.quantity },
        proration_behavior: 'always_invoice',
      },
      ['aeci-add', live.subscriptionId, current, payload.quantity].join('-'),
    );
    if (!updated.ok) throw stripeFailed('update', updated);

    const body: AddStripeLicensesResponse = { ok: true, pending: true };
    validateResponseInDev(c.env, () => AddStripeLicensesResponseSchema.parse(body));
    return json(body);
  };
}

/** `POST /api/vendor/billing/portal`. */
export function createStripePortalHandler(
  dbFor: DbFactory = getDb,
  stripeFor: StripeClientFactory = defaultStripeFor,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const { db } = writeDb(c, dbFor);

    await requireSeatOwner(
      db,
      session.userId,
      vendorId,
      'Only a vendor account owner can manage billing',
    );
    const { stripe, base } = requireStripe(c, stripeFor);

    const account = await loadStripeAccount(db, vendorId);
    const live = account.subscriptions[0];
    if (!account.stripeCustomerId) {
      // No Stripe customer: nothing in the portal is theirs yet.
      if (!live) throw subscriptionRequired();
      // A live Stripe license on an account with no customer id is a sync defect.
      console.warn('stripe subscription on an account with no customer id', {
        billingAccountId: account.id,
      });
      throw unavailable();
    }

    // A lapsed customer (a customer id, no live subscription) still has invoices and
    // receipts. The annual config has cancel off, so it offers nothing to cancel.
    let interval: StripeBillingInterval = 'year';
    if (live) {
      // Stripe's interval decides the config. D1's view is the fallback only for a
      // subscription item Stripe reports without one.
      const sub = await stripe.retrieveSubscription(live.subscriptionId);
      if (!sub.ok) throw stripeFailed('retrieve', sub);
      const stripeInterval = subscriptionInterval(sub.data);
      interval =
        stripeInterval === 'year' || stripeInterval === 'month' ? stripeInterval : live.interval;
    }
    const configuration = stripePortalConfigFor(c.env, interval);
    if (!configuration) throw unavailable();

    const portal = await stripe.createPortalSession(
      {
        customer: account.stripeCustomerId,
        configuration,
        return_url: billingTabUrl(base, account.vendorSlug),
      },
      ['aeci-portal', account.id, minuteBucket(new Date())].join('-'),
    );
    if (!portal.ok) throw stripeFailed('portal', portal);

    const body: StripeRedirectResponse = { url: portal.data.url };
    validateResponseInDev(c.env, () => StripeRedirectResponseSchema.parse(body));
    return json(body);
  };
}
