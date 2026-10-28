/**
 * The daily Stripe reconcile (AECI-1503, E9.5 of the AECI-1339 epic;
 * `docs/STAGE_2_PAID_TIERS_SPEC.md` §7.6 point 2).
 *
 * The webhook (`routes/webhooks.ts`) keeps licenses in step with Stripe as events
 * arrive. This job is its backstop: once a day it re-reads Stripe and runs the same
 * sync (`runStripeSubscriptionSync`) for every subscription, so an event Stripe gave up
 * on, a disabled endpoint or a rotated secret costs at most a day. Any change it makes
 * means an event was missed, so it emails `SUPPORT_EMAIL`.
 *
 * ── THE STRIPE QUERY ────────────────────────────────────────────────────────────
 * Two reads, and nothing filtered by time:
 *  1. ONE paged walk of `GET /v1/subscriptions` with no `status`. Stripe's default is
 *     every subscription that is not canceled (active, past_due, trialing, unpaid,
 *     incomplete, paused), 100 a page. That finds a missed grant, renewal, quantity
 *     change or cancel flag.
 *  2. One `GET /v1/subscriptions/:id` for each subscription that still has a live
 *     license in D1 but was not in that walk. That is a canceled one (a missed
 *     `customer.subscription.deleted`), or one past the page cap. The sync then ends
 *     its licenses.
 * Stripe's list filters on `created`, not on when a subscription changed. A
 * `status=canceled&created[gte]=now-2d` walk would miss a two-year-old subscription
 * canceled yesterday, and it would add nothing step 2 does not already catch. A
 * canceled subscription with no live license needs nothing. So step 2 replaces it,
 * and it costs one request per subscription that actually needs ending, which is
 * normally zero.
 *
 * Only a subscription carrying our `billing_account_id` metadata (E9.3 writes it on
 * every Checkout session), or one D1 already holds licenses for, is synced. Anything
 * else on the Stripe account is not ours.
 *
 * ── THE BAN CANCEL ──────────────────────────────────────────────────────────────
 * Ruling on the E9.2 open question (2026-10-28): a ban sets `cancel_at_period_end`
 * with `metadata.aeci_ban_cancel = "true"` (`stripeBanCancelHook`). When the run reads a
 * live subscription carrying that marker and no live license on its billing account
 * still carries `vendor-banned`, the vendor is active again and the unban or seat-grant
 * hook was missed. The run clears that cancel and the marker first, then syncs. It never
 * clears a cancel without the marker, which is the vendor's own.
 *
 * The other way round: a live subscription with no marker and `cancel_at_period_end`
 * false, on a billing account where a live license still carries `vendor-banned`, means
 * the ban hook failed after the ban committed. The run calls the same hook
 * (`stripeBanCancelHook` with `ban: true`), which sets the cancel and the marker, then
 * syncs (`banCancelsApplied`). A hook failure fails that subscription, so the queue
 * retries it.
 *
 * ── THE ALERT ONLY WHERE WEBHOOKS ARRIVE ────────────────────────────────────────
 * Staging's webhook endpoint is unreachable by design (AECI-1503 ruling), so every
 * staging subscription looks like a missed webhook. The alert's registry entry is
 * `production-and-demo`, and the run asks the same rule before it sends
 * (`refusedByTierRule`): off those tiers the alert is `suppressed` and never built.
 * The counts still reach `job_runs` on every tier.
 *
 * ── THE MISSING CHECKOUT ACCEPTANCE ─────────────────────────────────────────────
 * A missed `checkout.session.completed` also loses the Managed plan agreement
 * acceptance. For each linked subscription the run checks D1 for a `checkout`
 * acceptance on the billing account at or after the subscription's `created`, less
 * {@link ACCEPTANCE_WINDOW_SECONDS}. The webhook stamps the event time, which is
 * after it. When there is none, one
 * `GET /v1/checkout/sessions?subscription=…&limit=1` finds the session, and the
 * acceptance is recorded as the webhook records it (`checkoutAcceptanceStatements`:
 * the metadata's version and `profile_id`), stamped with the subscription's `created`,
 * first in the sync's batch. A session that already has its row
 * (`stripe_checkout_session_id` is unique) is left alone, so a second run adds nothing.
 * A failed lookup warns and the sync goes on: the licenses matter more. A webhook
 * that records the same session between the read and the batch trips the unique key:
 * that subscription fails, the run throws, and the queue retry finds the row.
 *
 * ── RENEWALS ────────────────────────────────────────────────────────────────────
 * A missed `invoice.paid` renewal reaches the sync as an annual period end past the
 * licenses' `ends_at`. The sync binds the current agreement version then, as the
 * webhook's `subscription_cycle` path does (`annualPeriodMovedForward`).
 *
 * ── RETRIES ARE SAFE ────────────────────────────────────────────────────────────
 * The sync converges: it maps the subscription as Stripe has it now onto the rows, so
 * a second run on the same state writes nothing. The license ids are minted from the
 * subscription and ordinal, so a racing grant trips the primary key instead of granting
 * twice. A queue retry after a partial run therefore changes only what still differs,
 * and its alert is keyed per day and per subscription set, so it is not sent twice.
 *
 * Fan-out is bounded by `WORKER_CONNECTION_LIMIT` (`mapWithConcurrency`). The Stripe
 * client releases every body it does not read.
 */

import { mapWithConcurrency, WORKER_CONNECTION_LIMIT } from '@aeci/shared/concurrency';
import { and, eq, gte, isNotNull, isNull } from 'drizzle-orm';

import type { Db } from '../db/client';
import { agreementAcceptances, licenses } from '../db/schema';
import { logToPosthog } from '../posthog';
import type { SendLicensesGranted } from '../routes/admin-licenses';
import type { EmailContext, EmailOutcome, sendStripeReconcileAlert } from './email';
import { VENDOR_BANNED_CANCEL_REASON } from './license';
import { refusedByTierRule } from './notifications/delivery-policy';
import { getNotification } from './notifications/registry';
import type { StripeCheckoutSession, StripeClient, StripeSubscription } from './stripe';
import {
  BAN_CANCEL_METADATA_KEY,
  resolveSubscriptionTarget,
  runStripeSubscriptionSync,
  stripeBanCancelHook,
  stripeSyncMode,
  type SendManagedEnded,
  type StripeSubscriptionTarget,
  type StripeSyncRunOptions,
  type SyncPrefix,
} from './stripe-licenses';
import { checkoutAcceptanceStatements } from './stripe-webhook-events';
import type { FetchSeatEmails } from './vendor-seat-recipients';

/** `metadata.source` on every audit row the reconcile writes, and its log source. */
export const STRIPE_RECONCILE_SOURCE = 'stripe-reconcile';

/** The run heartbeat, tagged `trigger` and `outcome` (ok / failed / skipped). */
export const STRIPE_RECONCILE_RUN_METRIC = 'aeci.stripe.reconcile.run';

/** At most this many failures are named in the `job_runs` detail and the thrown error. */
const MAX_NAMED_FAILURES = 10;

/**
 * A `checkout` acceptance this long before the subscription's `created` still counts as
 * its checkout's. Slack for clock skew only: the webhook stamps the
 * `checkout.session.completed` event time, which is after the subscription exists.
 */
export const ACCEPTANCE_WINDOW_SECONDS = 3600;

export interface StripeReconcileDeps {
  /** `null` when `STRIPE_SECRET_KEY` is unset: the run is skipped. */
  stripe: StripeClient | null;
  now?: Date;
  fetchSeatEmails?: FetchSeatEmails;
  sendGranted?: SendLicensesGranted;
  sendEnded?: SendManagedEnded;
  sendAlert?: typeof sendStripeReconcileAlert;
}

/** One subscription the run changed. */
export interface StripeReconcileChange {
  subscriptionId: string;
  status: string;
  target: StripeSubscriptionTarget | null;
  granted: number;
  ended: number;
  banCancelCleared: boolean;
  /** The run set the ban's cancel the ban hook failed to set (the vendor is banned). */
  banCancelApplied: boolean;
  /** The run recorded the checkout's missing agreement acceptance. */
  acceptanceBackfilled: boolean;
}

/** The counts the run reports, and what `job_runs.detail` carries. */
export interface StripeReconcileCounts {
  /** Subscriptions the list walk returned. */
  listed: number;
  /** True when the walk stopped at the page cap with pages left. Step 2 still
   *  reaches every subscription D1 holds licenses for. */
  truncated: boolean;
  /** Subscriptions synced: listed ones that are ours, plus the step-2 retrievals. */
  synced: number;
  /** Of those, the ones retrieved by id in step 2. */
  retrieved: number;
  /** Subscriptions whose licenses or ban cancel the run changed. A webhook was missed. */
  changed: number;
  granted: number;
  ended: number;
  banCancelsCleared: number;
  /** Ban cancels the run set because the ban hook's never landed. */
  banCancelsApplied: number;
  /** Checkout acceptances the run recorded because the webhook's was missing. */
  acceptancesBackfilled: number;
  /** Synced, but no billing account matched. */
  unlinked: number;
  failed: number;
}

export type StripeReconcileResult =
  | { outcome: 'skipped'; reason: 'stripe_unconfigured' }
  | {
      outcome: 'ok';
      counts: StripeReconcileCounts;
      changes: StripeReconcileChange[];
      failures: { subscriptionId: string; reason: string }[];
      /** The alert's send outcome, or `null` when nothing changed. `suppressed` off
       *  production and demo, where the run never builds it. */
      alert: EmailOutcome | null;
    };

/** Thrown when one or more subscriptions could not be synced, after the rest were and
 *  the alert went out. The queue retries; the sync converges, so that is safe. */
export class StripeReconcileError extends Error {
  constructor(
    message: string,
    readonly result: Extract<StripeReconcileResult, { outcome: 'ok' }>,
  ) {
    super(message);
    this.name = 'StripeReconcileError';
  }
}

/** The alert's send-ledger key: one per day and set of subscriptions, independent of
 *  read order. Binary order on purpose: these are ids (`API_CONTRACTS.md` §3.2). */
export function stripeReconcileAlertKey(day: string, subscriptionIds: readonly string[]): string {
  const sorted = [...subscriptionIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `stripe-reconcile-alert:${day}:${sorted.join(',')}`;
}

/** Every Stripe subscription id a live license sits on. Reads `licenses_stripe_subscription_idx`. */
export async function loadLiveStripeSubscriptionIds(db: Db): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ id: licenses.stripeSubscriptionId })
    .from(licenses)
    .where(and(isNull(licenses.endedAt), isNotNull(licenses.stripeSubscriptionId)));
  return new Set(rows.flatMap((r) => (r.id ? [r.id] : [])));
}

/** Whether a live license on the billing account still carries the ban's flag. */
async function accountHasBanFlag(db: Db, billingAccountId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: licenses.id })
    .from(licenses)
    .where(
      and(
        eq(licenses.billingAccountId, billingAccountId),
        isNull(licenses.endedAt),
        eq(licenses.cancelReason, VENDOR_BANNED_CANCEL_REASON),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Whether the billing account holds a `checkout` acceptance from this subscription's
 *  checkout or later. Without `created`, any `checkout` acceptance on it counts. */
async function hasCheckoutAcceptance(
  db: Db,
  billingAccountId: string,
  created: number | undefined,
): Promise<boolean> {
  const since =
    created === undefined
      ? null
      : new Date((created - ACCEPTANCE_WINDOW_SECONDS) * 1000).toISOString();
  const [row] = await db
    .select({ id: agreementAcceptances.id })
    .from(agreementAcceptances)
    .where(
      and(
        eq(agreementAcceptances.billingAccountId, billingAccountId),
        eq(agreementAcceptances.source, 'checkout'),
        ...(since ? [gte(agreementAcceptances.acceptedAt, since)] : []),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** A checkout acceptance to record: the session that created the subscription. */
interface AcceptanceBackfill {
  session: StripeCheckoutSession;
  metadata: Record<string, string>;
  acceptedAt: string;
}

/**
 * The checkout acceptance the webhook should have recorded and did not, or `null`.
 * Never throws for Stripe: a failed lookup warns and the sync goes on without it.
 */
async function findMissingAcceptance(
  c: EmailContext,
  db: Db,
  stripe: StripeClient,
  sub: StripeSubscription,
  nowIso: string,
): Promise<AcceptanceBackfill | null> {
  const target = await resolveSubscriptionTarget(db, sub);
  if (!target) return null;
  if (await hasCheckoutAcceptance(db, target.billingAccountId, sub.created)) return null;
  const found = await stripe.findCheckoutSessionForSubscription(sub.id);
  if (!found.ok) {
    // `not_found`: a subscription made outside Checkout has no acceptance to record.
    if (found.reason !== 'not_found') {
      warn(c, 'aeci.stripe.reconcile.acceptance_lookup_failed', sub.id, found.message);
    }
    return null;
  }
  const session = found.data;
  const [recorded] = await db
    .select({ id: agreementAcceptances.id })
    .from(agreementAcceptances)
    .where(eq(agreementAcceptances.stripeCheckoutSessionId, session.id))
    .limit(1);
  if (recorded) return null;
  const at = sub.created ?? session.created;
  return {
    session,
    // As the webhook: the session's copy fills a key the subscription lacks.
    metadata: { ...(session.metadata ?? {}), ...(sub.metadata ?? {}) },
    acceptedAt: at === undefined ? nowIso : new Date(at * 1000).toISOString(),
  };
}

function warn(c: EmailContext, message: string, subscriptionId: string, reason: string): void {
  try {
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'warn',
      message,
      source: STRIPE_RECONCILE_SOURCE,
      stripe_subscription_id: subscriptionId,
      reason,
    });
  } catch {
    // Telemetry must never change the outcome.
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run the reconcile. Returns `skipped` with no Stripe key. Throws when the list walk
 * fails (nothing was synced) and {@link StripeReconcileError} when some subscriptions
 * failed (the rest were synced and the alert sent). The caller lets both reach the
 * queue, which retries.
 */
export async function runStripeReconcile(
  c: EmailContext,
  db: Db,
  deps: StripeReconcileDeps,
): Promise<StripeReconcileResult> {
  const { stripe } = deps;
  if (!stripe) return { outcome: 'skipped', reason: 'stripe_unconfigured' };
  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();

  const page = await stripe.listSubscriptions();
  if (!page.ok) {
    throw new Error(`list subscriptions: ${page.reason} ${page.status} ${page.message}`);
  }
  const listed = page.data.subscriptions;
  const liveIds = await loadLiveStripeSubscriptionIds(db);
  const listedIds = new Set(listed.map((s) => s.id));

  // Step 1: the listed subscriptions that are ours. Step 2: the ones D1 holds live
  // licenses for that the walk did not return, retrieved by id.
  const work: Array<{ sub: StripeSubscription } | { id: string }> = [
    ...listed
      .filter((s) => Boolean(s.metadata?.billing_account_id?.trim()) || liveIds.has(s.id))
      .map((sub) => ({ sub })),
    ...[...liveIds].filter((id) => !listedIds.has(id)).map((id) => ({ id })),
  ];

  const settled = await mapWithConcurrency(work, WORKER_CONNECTION_LIMIT, async (item) => {
    let sub: StripeSubscription;
    if ('sub' in item) {
      sub = item.sub;
    } else {
      const res = await stripe.retrieveSubscription(item.id);
      if (!res.ok) {
        throw new Error(`retrieve ${item.id}: ${res.reason} ${res.status} ${res.message}`);
      }
      sub = res.data;
    }

    // The ban's own cancel, left on a vendor that is active again: clear it first.
    let banCancelCleared = false;
    if (
      stripeSyncMode(sub.status) === 'live' &&
      sub.metadata?.[BAN_CANCEL_METADATA_KEY] === 'true'
    ) {
      const target = await resolveSubscriptionTarget(db, sub);
      if (target && !(await accountHasBanFlag(db, target.billingAccountId))) {
        const updated = await stripe.updateSubscription(
          sub.id,
          { cancel_at_period_end: false, metadata: { [BAN_CANCEL_METADATA_KEY]: '' } },
          `aeci-reconcile-unban-${sub.id}-${nowIso.slice(0, 10)}`,
        );
        if (!updated.ok) {
          throw new Error(`clear ban cancel ${sub.id}: ${updated.reason} ${updated.status}`);
        }
        sub = updated.data;
        banCancelCleared = true;
      }
    }

    // The ban's cancel the ban hook failed to set, on a vendor still banned: set it now.
    let banCancelApplied = false;
    if (
      stripeSyncMode(sub.status) === 'live' &&
      sub.metadata?.[BAN_CANCEL_METADATA_KEY] !== 'true' &&
      !sub.cancel_at_period_end
    ) {
      const target = await resolveSubscriptionTarget(db, sub);
      if (target && (await accountHasBanFlag(db, target.billingAccountId))) {
        const [outcome] = await stripeBanCancelHook(c, stripe, {
          vendorId: target.vendorId,
          subscriptionIds: [sub.id],
          ban: true,
          now: nowIso,
        });
        if (outcome === 'failed') throw new Error(`apply ban cancel ${sub.id}: hook failed`);
        if (outcome === 'set') {
          // The hook re-read and updated Stripe. Sync the state it left.
          sub = {
            ...sub,
            cancel_at_period_end: true,
            metadata: { ...(sub.metadata ?? {}), [BAN_CANCEL_METADATA_KEY]: 'true' },
          };
          banCancelApplied = true;
        }
      }
    }

    // The checkout's acceptance, when the webhook never recorded it: first in the batch.
    const backfill = await findMissingAcceptance(c, db, stripe, sub, nowIso);
    let acceptanceBackfilled = false;
    // Built once per attempt: a re-planned batch re-runs it on the fresh read.
    const prefix: StripeSyncRunOptions['prefix'] = backfill
      ? (p): SyncPrefix => {
          acceptanceBackfilled = false;
          if (!p.target || !p.vendorPlan) return { stmts: [], audits: [] };
          const built = checkoutAcceptanceStatements(db, {
            ...backfill,
            target: p.target,
            vendorPlan: p.vendorPlan,
          });
          if (built.skipped) {
            warn(c, 'aeci.stripe.reconcile.acceptance_skipped', sub.id, built.skipped);
          }
          acceptanceBackfilled = built.stmts.length > 0;
          return { stmts: built.stmts, audits: built.audits };
        }
      : undefined;

    const result = await runStripeSubscriptionSync(c, db, sub, {
      source: STRIPE_RECONCILE_SOURCE,
      now,
      prefix,
      fetchSeatEmails: deps.fetchSeatEmails,
      sendGranted: deps.sendGranted,
      sendEnded: deps.sendEnded,
    });
    return {
      retrieved: !('sub' in item),
      outcome: result.outcome,
      change: {
        subscriptionId: sub.id,
        status: sub.status,
        target: result.target,
        granted: result.granted.length,
        ended: result.ended.length,
        banCancelCleared,
        banCancelApplied,
        acceptanceBackfilled,
      } satisfies StripeReconcileChange,
    };
  });

  const counts: StripeReconcileCounts = {
    listed: listed.length,
    truncated: page.data.truncated,
    synced: 0,
    retrieved: 0,
    changed: 0,
    granted: 0,
    ended: 0,
    banCancelsCleared: 0,
    banCancelsApplied: 0,
    acceptancesBackfilled: 0,
    unlinked: 0,
    failed: 0,
  };
  const changes: StripeReconcileChange[] = [];
  const failures: { subscriptionId: string; reason: string }[] = [];
  settled.forEach((s, i) => {
    const item = work[i]!;
    if (s.status === 'rejected') {
      counts.failed++;
      failures.push({
        subscriptionId: 'sub' in item ? item.sub.id : item.id,
        reason: reasonOf(s.reason),
      });
      return;
    }
    const { retrieved, outcome, change } = s.value;
    counts.synced++;
    if (retrieved) counts.retrieved++;
    if (outcome === 'unlinked') counts.unlinked++;
    if (change.banCancelCleared) counts.banCancelsCleared++;
    if (change.banCancelApplied) counts.banCancelsApplied++;
    if (change.acceptanceBackfilled) counts.acceptancesBackfilled++;
    if (outcome === 'synced' || change.banCancelCleared || change.banCancelApplied) {
      counts.changed++;
      counts.granted += change.granted;
      counts.ended += change.ended;
      changes.push(change);
    }
  });

  let alert: EmailOutcome | null = null;
  // Only where webhooks are reachable (production and demo): the registry's tier rule.
  const alertRefused = refusedByTierRule(c.env, getNotification('stripe-reconcile-alert').envRule);
  if (changes.length > 0 && alertRefused) {
    alert = 'suppressed';
  } else if (changes.length > 0 && deps.sendAlert) {
    try {
      alert = await deps.sendAlert(c, {
        to: c.env.SUPPORT_EMAIL,
        rows: changes.map((ch) => ({
          subscriptionId: ch.subscriptionId,
          vendorName: ch.target?.vendorName ?? null,
          vendorId: ch.target?.vendorId ?? null,
          status: ch.status,
          granted: ch.granted,
          ended: ch.ended,
          banCancelCleared: ch.banCancelCleared,
          banCancelApplied: ch.banCancelApplied,
        })),
        dedupeKey: stripeReconcileAlertKey(
          nowIso.slice(0, 10),
          changes.map((ch) => ch.subscriptionId),
        ),
      });
    } catch {
      // The licenses already match Stripe; a lost alert leaves the job_runs row.
      alert = 'failed';
    }
  }

  const result = {
    outcome: 'ok' as const,
    counts,
    changes,
    failures: failures.slice(0, MAX_NAMED_FAILURES),
    alert,
  };
  if (counts.failed > 0) {
    const named = result.failures.map((f) => `${f.subscriptionId}: ${f.reason}`).join('; ');
    throw new StripeReconcileError(
      `${counts.failed} of ${work.length} Stripe subscriptions failed to reconcile (${named})`,
      result,
    );
  }
  return result;
}
