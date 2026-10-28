/**
 * What the Stripe webhook does with each event (AECI-1500, E9.2 of the AECI-1339 epic;
 * `API_CONTRACTS.md` §6.11). The route (`createStripeWebhookHandler` in
 * `routes/webhooks.ts`) verifies the signature and parses the envelope; this module
 * applies the event.
 *
 * ── EVERY SUBSCRIPTION EVENT RE-READS THE SUBSCRIPTION ─────────────────────────
 * The event payload is a snapshot from when Stripe sent it, and Stripe does not deliver
 * in order. So `checkout.session.completed`, `invoice.paid`,
 * `customer.subscription.updated` and `customer.subscription.deleted` each retrieve the
 * subscription and run the one sync (`runStripeSubscriptionSync`). A `deleted` that
 * arrives before its `completed` ends nothing (no license exists yet), and the late
 * `completed` then reads a canceled subscription and grants nothing.
 *
 * ── THE LEDGER ──────────────────────────────────────────────────────────────────
 * Every handled event writes one `stripe_events` row as the FIRST statement of its
 * batch. A replay trips the primary key, the batch rolls back whole, and the event
 * answers 200 `replay`. The ledger is also read before any Stripe call, so a plain
 * replay costs no API request. An ignored type writes no row.
 *
 * ── WHAT IS RETRIED ─────────────────────────────────────────────────────────────
 * Only transient failures answer 5xx, so Stripe retries them: the subscription re-read
 * timing out, failing on the network, or answering 5xx, 429, 401 or 403
 * (`StripeTransientError`, 503), a D1 error, or a batch that lost a race twice (500).
 * Anything that will fail the same way again answers 200 with an outcome that says so
 * (`unlinked`, `skipped`), because Stripe would otherwise retry it for three days and
 * then disable the endpoint. That includes a re-read Stripe answers with any other 4xx,
 * such as 404 `resource_missing` for a subscription deleted with its test clock.
 *
 * ── A LATE CHECKOUT EVENT ───────────────────────────────────────────────────────
 * The daily reconcile may record a Checkout acceptance before a delayed
 * `checkout.session.completed` arrives. `stripe_checkout_session_id` is unique, so the
 * webhook reads it first and leaves the acceptance out when the session has its row. A
 * reconcile that records it between that read and the batch trips the unique index;
 * the sync re-plans, the re-read finds the row, and the event still commits.
 */

import type { AuditLogEntry } from '@aeci/shared/audit-log';
import type { VendorPlanSnapshot } from '@aeci/shared/entitlements';
import { eq } from 'drizzle-orm';

import type { Db } from '../db/client';
import { agreementAcceptances, billingAccounts, stripeEvents } from '../db/schema';
import { ApiError } from '../errors';
import { logToPosthog } from '../posthog';
import type { SendLicensesGranted } from '../routes/admin-licenses';
import { agreementAcceptanceStatements } from './agreement-acceptances';
import type { BatchStmt, BatchTuple } from './audit';
import { billingEmailStatements, stripeCustomerLinkStatements } from './billing-account';
import type { EmailContext, sendPaymentFailedEmail } from './email';
import { recipientHash } from './hash';
import {
  billingAddresses,
  resolveSubscriptionTarget,
  runStripeSubscriptionSync,
  type SendManagedEnded,
  type StripeSubscriptionTarget,
  type StripeSyncOutcome,
  type SyncPrefix,
} from './stripe-licenses';
import {
  invoiceSubscriptionId,
  stripeId,
  type StripeCheckoutSession,
  type StripeClient,
  type StripeInvoice,
  type StripeSubscription,
} from './stripe';
import { fetchAuthUserEmails } from './supabase-admin';
import type { FetchSeatEmails } from './vendor-seat-recipients';

/** `metadata.source` on every audit row the webhook writes, and the log source. */
export const STRIPE_WEBHOOK_SOURCE = 'stripe-webhook';

/** The event types the webhook applies. Anything else answers 200 `ignored`. */
export const STRIPE_HANDLED_EVENT_TYPES = [
  'checkout.session.completed',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
] as const;
export type StripeHandledEventType = (typeof STRIPE_HANDLED_EVENT_TYPES)[number];

/**
 * `stripe_events.outcome`, plus the two answers that write no row. `notified`: a failed
 * payment, emailed and nothing else (decision 13).
 */
export type StripeEventOutcome = StripeSyncOutcome | 'notified' | 'replay' | 'ignored';

/** The envelope fields the webhook reads. */
export interface StripeEvent {
  id: string;
  type: string;
  /** Unix seconds. */
  created?: number;
  data: { object: Record<string, unknown> };
}

/** Parse the envelope. `null` when it is not a Stripe event. */
export function parseStripeEvent(value: unknown): StripeEvent | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const data = v.data as Record<string, unknown> | undefined;
  if (typeof v.id !== 'string' || !v.id || typeof v.type !== 'string' || !v.type) return null;
  if (!data || typeof data.object !== 'object' || data.object === null) return null;
  return {
    id: v.id,
    type: v.type,
    created: typeof v.created === 'number' ? v.created : undefined,
    data: { object: data.object as Record<string, unknown> },
  };
}

export function isHandledStripeEventType(type: string): type is StripeHandledEventType {
  return (STRIPE_HANDLED_EVENT_TYPES as readonly string[]).includes(type);
}

/** A Stripe API failure worth a retry: the route answers 503. */
export class StripeTransientError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'StripeTransientError';
  }
}

/** True for the primary-key failure a replayed event raises on `stripe_events`. */
export function isStripeEventReplay(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const message = String((current as { message?: unknown }).message ?? current);
    if (/UNIQUE constraint failed: stripe_events\.id/i.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export type SendPaymentFailed = typeof sendPaymentFailedEmail;

export interface StripeWebhookDeps {
  stripe: StripeClient | null;
  now?: Date;
  fetchSeatEmails?: FetchSeatEmails;
  sendGranted?: SendLicensesGranted;
  sendEnded?: SendManagedEnded;
  sendPaymentFailed?: SendPaymentFailed;
}

export interface StripeEventResult {
  outcome: StripeEventOutcome;
  subscriptionId: string | null;
}

/** The ledger INSERT. Always the first statement of the event's batch. */
function ledgerInsert(
  db: Db,
  event: StripeEvent,
  outcome: StripeEventOutcome,
  subscriptionId: string | null,
  now: string,
): BatchStmt {
  return db.insert(stripeEvents).values({
    id: event.id,
    type: event.type,
    receivedAt: now,
    outcome,
    subscriptionId,
  });
}

/** Whether the ledger already holds the event. The PK in the batch is the real guard. */
async function alreadyRecorded(db: Db, eventId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: stripeEvents.id })
    .from(stripeEvents)
    .where(eq(stripeEvents.id, eventId))
    .limit(1);
  return Boolean(row);
}

/** The 4xx answers a retry can change: rate limited, or a key Stripe refused. */
const RETRIABLE_4XX = new Set([401, 403, 429]);

/**
 * Retrieve the subscription. A transient failure throws {@link StripeTransientError}.
 * Any other 4xx (a subscription deleted with its test clock answers 404
 * `resource_missing`, a bad id 400) fails the same way on every redelivery, so it
 * returns `null` and the caller records the event `skipped`.
 */
async function retrieve(
  stripe: StripeClient | null,
  id: string,
  eventId: string,
): Promise<StripeSubscription | null> {
  if (!stripe) {
    throw new StripeTransientError('STRIPE_SECRET_KEY is not set', 'stripe_unconfigured');
  }
  const res = await stripe.retrieveSubscription(id);
  if (res.ok) return res.data;
  if (
    res.reason === 'http_error' &&
    res.status >= 400 &&
    res.status < 500 &&
    !RETRIABLE_4XX.has(res.status)
  ) {
    console.warn('aeci.stripe.webhook_permanent', {
      eventId,
      subscriptionId: id,
      status: res.status,
      code: res.code,
    });
    return null;
  }
  throw new StripeTransientError(
    `retrieve subscription ${id}: ${res.reason} ${res.status} ${res.message}`,
    res.reason,
  );
}

/**
 * Apply one verified event. Throws {@link StripeTransientError} (503), an `ApiError`, or
 * a D1 error (500). A replay returns `replay`.
 */
export async function handleStripeEvent(
  c: EmailContext,
  db: Db,
  event: StripeEvent,
  deps: StripeWebhookDeps,
): Promise<StripeEventResult> {
  const type = event.type;
  if (!isHandledStripeEventType(type)) return { outcome: 'ignored', subscriptionId: null };
  if (await alreadyRecorded(db, event.id)) return { outcome: 'replay', subscriptionId: null };
  try {
    return await apply(c, db, { ...event, type }, deps);
  } catch (error) {
    if (isStripeEventReplay(error)) return { outcome: 'replay', subscriptionId: null };
    throw error;
  }
}

async function apply(
  c: EmailContext,
  db: Db,
  event: StripeEvent & { type: StripeHandledEventType },
  deps: StripeWebhookDeps,
): Promise<StripeEventResult> {
  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();
  const object = event.data.object;
  const skip = async (subscriptionId: string | null): Promise<StripeEventResult> => {
    await db.batch([ledgerInsert(db, event, 'skipped', subscriptionId, nowIso)] as BatchTuple);
    return { outcome: 'skipped', subscriptionId };
  };

  switch (event.type) {
    case 'invoice.payment_failed':
      return paymentFailed(c, db, event, object as unknown as StripeInvoice, deps, nowIso);

    case 'checkout.session.completed': {
      const session = object as unknown as StripeCheckoutSession;
      const subscriptionId = stripeId(session.subscription);
      if (session.mode !== 'subscription' || !subscriptionId) return skip(subscriptionId);
      const fetched = await retrieve(deps.stripe, subscriptionId, event.id);
      if (!fetched) return skip(subscriptionId);
      // Checkout copies the metadata onto the subscription (`subscription_data`). The
      // session's own copy fills a key the subscription lacks.
      const sub: StripeSubscription = {
        ...fetched,
        metadata: { ...(session.metadata ?? {}), ...(fetched.metadata ?? {}) },
      };
      return sync(c, db, event, sub, deps, now, {
        prefix: (p) => checkoutPrefix(c, db, event, session, sub, p, nowIso),
      });
    }

    case 'invoice.paid': {
      const invoice = object as unknown as StripeInvoice;
      const subscriptionId = invoiceSubscriptionId(invoice);
      if (!subscriptionId) return skip(null);
      const sub = await retrieve(deps.stripe, subscriptionId, event.id);
      if (!sub) return skip(subscriptionId);
      // A renewal binds the CURRENT agreement version (ruling R1).
      return sync(c, db, event, sub, deps, now, {
        renewal: invoice.billing_reason === 'subscription_cycle',
        extraMetadata: { stripe_invoice_id: invoice.id },
      });
    }

    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscriptionId = typeof object.id === 'string' ? object.id : null;
      if (!subscriptionId) return skip(null);
      const sub = await retrieve(deps.stripe, subscriptionId, event.id);
      if (!sub) return skip(subscriptionId);
      return sync(c, db, event, sub, deps, now, {});
    }
  }
}

async function sync(
  c: EmailContext,
  db: Db,
  event: StripeEvent,
  sub: StripeSubscription,
  deps: StripeWebhookDeps,
  now: Date,
  extra: {
    renewal?: boolean;
    extraMetadata?: Record<string, unknown>;
    prefix?: Parameters<typeof runStripeSubscriptionSync>[3]['prefix'];
  },
): Promise<StripeEventResult> {
  const nowIso = now.toISOString();
  const result = await runStripeSubscriptionSync(c, db, sub, {
    source: STRIPE_WEBHOOK_SOURCE,
    now,
    renewal: extra.renewal,
    extraMetadata: { stripe_event_id: event.id, ...extra.extraMetadata },
    prefix:
      extra.prefix ??
      ((p) => ({ stmts: [ledgerInsert(db, event, p.outcome, sub.id, nowIso)], audits: [] })),
    fetchSeatEmails: deps.fetchSeatEmails ?? fetchAuthUserEmails,
    sendEnded: deps.sendEnded,
    sendGranted: deps.sendGranted,
  });
  return { outcome: result.outcome, subscriptionId: sub.id };
}

/** {@link checkoutAcceptanceStatements}' result. `skipped` names why nothing was built. */
export interface CheckoutAcceptance {
  stmts: BatchStmt[];
  audits: AuditLogEntry[];
  skipped: string | null;
}

/**
 * The Managed plan agreement acceptance a completed Checkout Session records (ruling R1):
 * the version the Checkout page showed (`terms_version` in the metadata, even if
 * superseded since), the owner's `profile_id` from the metadata, and the email Stripe
 * collected. Shared by the webhook's `checkout.session.completed` and the reconcile's
 * backfill (AECI-1503), so both record the same row. Builds nothing and names why
 * (`skipped`) when the version or email is missing or the version was never
 * published: the licenses are paid for either way. `stripe_checkout_session_id` is
 * unique, so a caller must not build it for a session that already has its row.
 */
export function checkoutAcceptanceStatements(
  db: Db,
  p: {
    session: StripeCheckoutSession;
    /** The session's metadata merged with the subscription's, the subscription winning. */
    metadata: Record<string, string>;
    target: Pick<StripeSubscriptionTarget, 'vendorId' | 'billingAccountId'>;
    vendorPlan: VendorPlanSnapshot;
    acceptedAt: string;
  },
): CheckoutAcceptance {
  const email = (p.session.customer_details?.email ?? p.session.customer_email ?? '').trim();
  const version = p.metadata.terms_version?.trim();
  if (!version || !email) {
    return { stmts: [], audits: [], skipped: 'no terms_version or email' };
  }
  try {
    const acceptance = agreementAcceptanceStatements(db, {
      document: 'managed_plan',
      version,
      allowSupersededVersion: true,
      source: 'checkout',
      email,
      profileId: p.metadata.profile_id?.trim() || null,
      vendorId: p.target.vendorId,
      billingAccountId: p.target.billingAccountId,
      stripeCheckoutSessionId: p.session.id,
      acceptedAt: p.acceptedAt,
      actorId: null,
      actorType: 'system',
      vendorPlan: p.vendorPlan,
    });
    return { stmts: acceptance.stmts, audits: [acceptance.auditEntry], skipped: null };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { stmts: [], audits: [], skipped: error.message };
  }
}

/**
 * `checkout.session.completed`'s own writes, before the sync's, in the same batch: the
 * ledger row, the Managed plan agreement acceptance (ruling R1: the version the
 * Checkout page showed, even if superseded), and the customer id and billing email
 * when the account has none yet (decision 16). An acceptance that cannot be recorded
 * (no version or email, or a version never published) is logged and left out: the
 * licenses are paid for either way, and a 4xx would only make Stripe retry. A session
 * that already has its acceptance (the reconcile backfilled it) gets none: the read is
 * repeated on every re-plan, so a row that lands mid-flight is found the second time.
 */
async function checkoutPrefix(
  c: EmailContext,
  db: Db,
  event: StripeEvent,
  session: StripeCheckoutSession,
  sub: StripeSubscription,
  p: Parameters<NonNullable<Parameters<typeof runStripeSubscriptionSync>[3]['prefix']>>[0],
  nowIso: string,
): Promise<SyncPrefix> {
  const stmts: BatchStmt[] = [ledgerInsert(db, event, p.outcome, sub.id, nowIso)];
  const audits: AuditLogEntry[] = [];
  const target = p.target;
  if (!target || !p.vendorPlan) return { stmts, audits };
  const actor = { actorId: null, actorType: 'system' as const };
  const email = (session.customer_details?.email ?? session.customer_email ?? '').trim();

  const [recorded] = await db
    .select({ id: agreementAcceptances.id })
    .from(agreementAcceptances)
    .where(eq(agreementAcceptances.stripeCheckoutSessionId, session.id))
    .limit(1);
  const acceptance: CheckoutAcceptance = recorded
    ? { stmts: [], audits: [], skipped: null }
    : checkoutAcceptanceStatements(db, {
        session,
        metadata: sub.metadata ?? {},
        target,
        vendorPlan: p.vendorPlan,
        acceptedAt: event.created ? new Date(event.created * 1000).toISOString() : nowIso,
      });
  stmts.push(...acceptance.stmts);
  audits.push(...acceptance.audits);
  if (acceptance.skipped) {
    try {
      logToPosthog(c.executionCtx, c.env, c.req.raw, {
        level: 'warn',
        message: 'aeci.stripe.checkout_acceptance_skipped',
        source: STRIPE_WEBHOOK_SOURCE,
        stripe_event_id: event.id,
        reason: acceptance.skipped,
      });
    } catch {
      // Telemetry must never change the outcome.
    }
  }

  const [account] = await db
    .select({
      stripeCustomerId: billingAccounts.stripeCustomerId,
      billingEmail: billingAccounts.billingEmail,
    })
    .from(billingAccounts)
    .where(eq(billingAccounts.id, target.billingAccountId))
    .limit(1);
  const customerId = stripeId(session.customer);
  if (account && !account.stripeCustomerId && customerId) {
    const link = stripeCustomerLinkStatements(db, {
      billingAccountId: target.billingAccountId,
      vendorId: target.vendorId,
      stripeCustomerId: customerId,
      now: nowIso,
      ...actor,
      vendorPlan: p.vendorPlan,
      source: STRIPE_WEBHOOK_SOURCE,
    });
    stmts.push(...link.stmts);
    audits.push(link.auditEntry);
  }
  if (account && !account.billingEmail && email) {
    const set = billingEmailStatements(db, {
      billingAccountId: target.billingAccountId,
      vendorId: target.vendorId,
      before: null,
      email,
      now: nowIso,
      ...actor,
      vendorPlan: p.vendorPlan,
      source: STRIPE_WEBHOOK_SOURCE,
    });
    stmts.push(...set.stmts);
    if (set.auditEntry) audits.push(set.auditEntry);
  }
  return { stmts, audits };
}

/**
 * `invoice.payment_failed` (decision 13): no license changes. The ledger row commits,
 * then `payment-failed` goes to the billing email and every unbanned seat, keyed on
 * the invoice, in `waitUntil`. The account is found from the invoice's subscription
 * metadata or its customer, with no Stripe call.
 */
async function paymentFailed(
  c: EmailContext,
  db: Db,
  event: StripeEvent,
  invoice: StripeInvoice,
  deps: StripeWebhookDeps,
  nowIso: string,
): Promise<StripeEventResult> {
  const subscriptionId = invoiceSubscriptionId(invoice);
  const target = await resolveSubscriptionTarget(db, {
    metadata: {
      ...(invoice.metadata ?? {}),
      ...(invoice.parent?.subscription_details?.metadata ?? {}),
    },
    customer: invoice.customer ?? '',
  });
  const outcome: StripeEventOutcome = target ? 'notified' : 'unlinked';
  await db.batch([ledgerInsert(db, event, outcome, subscriptionId, nowIso)] as BatchTuple);
  if (!target) return { outcome, subscriptionId };

  const send = deps.sendPaymentFailed;
  const fetchSeatEmails = deps.fetchSeatEmails ?? fetchAuthUserEmails;
  c.executionCtx.waitUntil(
    (async () => {
      try {
        const addresses = await billingAddresses(c, db, target, fetchSeatEmails);
        if (!send) return;
        // One at a time: the Worker's connection limit is six.
        for (const to of addresses) {
          await send(c, {
            to,
            vendorName: target.vendorName,
            vendorSlug: target.vendorSlug,
            dedupeKey: `payment-failed:${invoice.id}:${await recipientHash(to)}`,
            entity: { type: 'billing_account', id: target.billingAccountId },
          });
        }
      } catch (error) {
        try {
          logToPosthog(c.executionCtx, c.env, c.req.raw, {
            level: 'warn',
            message: 'aeci.stripe.payment_failed_email_failed',
            source: STRIPE_WEBHOOK_SOURCE,
            reason: error instanceof Error ? error.message : String(error),
          });
        } catch {
          // Telemetry must never change the outcome.
        }
      }
    })(),
  );
  return { outcome, subscriptionId };
}
