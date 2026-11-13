/**
 * Terminate a suspended vendor (AECI-1623, ruling 1 of 2026-11-05). The D1 side and the
 * post-commit steps of AECI-1589's last-seat ban, moved here when that ban was refused,
 * plus the seat bans and the refund.
 *
 * One batch: every unbanned seat is banned, the records return to AECi as ADR 0042's
 * return does, pending invites are revoked, open proposals discarded, every live license
 * ends `banned`, the suspension closes with its statement, and the refund rows land
 * `pending`. `vendors.owned_at` is an operational lock, so clearing it is not a transfer
 * of the text: the vendor keeps ownership of what it wrote (ruling 5). `usefulness_source`
 * and `logo_source` stay `vendor` in this batch. The claim ends in it (AECI-1618), so the
 * daily removal job then clears the vendor-set logos (`lib/brand-asset-removal.ts`).
 *
 * After commit, in order: ownership message and purge, the Stripe cancel, the refunds
 * (each under its row id as the idempotency key, so a retry cannot pay twice), then the
 * `vendor-terminated` email, which states what those steps really did.
 */

import type { TerminationStatement } from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { mapWithConcurrency, WORKER_CONNECTION_LIMIT } from '@aeci/shared/concurrency';
import { licensePlanSnapshot } from '@aeci/shared/entitlements';
import type { WorkflowTransitionEntry } from '@aeci/shared/workflow-transition';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { Context } from 'hono';

import type { Db } from '../db/client';
import {
  billingAccounts,
  productProposals,
  profiles,
  vendors,
  vendorSeatInvites,
  vendorSuspensions,
  vendorTerminationRefunds,
  workflowInstances,
} from '../db/schema';
import type { Env } from '../env';
import { logToPosthog } from '../posthog';
import { auditInsert, workflowTransitionInsert, type BatchStmt } from './audit';
import type { AuthzVariables } from './authz';
import { loadVendorBillingEmails, mergeRecipientAddresses } from './billing-recipients';
import { sendVendorTerminatedEmail } from './email';
import { recipientHash } from './hash';
import {
  endLicensesStatements,
  loadOwnedProductLicenseState,
  noLiveLicenseSentinel,
  toIsoTimestamp,
  type LicenseBefore,
} from './license';
import { loadProductNames, purgeLicenseDrops, withRaceSentinels } from './license-lapse';
import { forwardAuditBatch } from './moderation-forward';
import { dispatchOwnershipSync } from './ownership-sync';
import { openProposalsFor, openProposalsUnchangedSentinel } from './product-proposals';
import {
  stripeId,
  subscriptionCurrentPeriodEnd,
  invoiceSubscriptionId,
  type StripeClient,
} from './stripe';
import {
  liveStripeSubscriptionIds,
  stripeBanCancelNowHook,
  type BanCancelOutcome,
  type BanSubscription,
  type StripeClientFor,
} from './stripe-licenses';
import {
  noUnbannedSeatLeftSentinel,
  pendingInviteRaceSentinel,
  planVendorHandback,
  RECORDS_RETURNED_ACTION,
  seatRaceSentinels,
  type VendorReturnBatch,
} from './vendor-handback';
import { liveInvitesFor, revokeInviteStatements } from './vendor-seat-invites';
import { loadVendorSeatRecipients, type FetchSeatEmails } from './vendor-seat-recipients';
import type { RefundablePayment, RefundAllocation } from './vendor-termination-refund';

export type TerminationContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

/** `metadata.cause` on Terminate's `vendor.records_returned` row. */
export const VENDOR_TERMINATED_CAUSE = 'vendor-terminated';

/** What a seat sees in the 403 once it is banned by a termination. */
export const TERMINATED_SEAT_BAN_REASON = "This company's vendor account has ended.";

/** The refund pass gives up after this long. Anything left stays `pending` for the retry. */
export const TERMINATION_REFUND_DEADLINE_MS = 15_000;

/** A paid invoice is read back this far. The longest term sold is one year. */
const REFUND_LOOKBACK_SECONDS = 400 * 86_400;

export type SendVendorTerminated = typeof sendVendorTerminatedEmail;

function warn(c: TerminationContext, message: string, vendorId: string, error: unknown): void {
  try {
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'warn',
      source: 'admin-moderation',
      message,
      vendor_id: vendorId,
      reason: error instanceof Error ? error.message : String(error),
    });
  } catch {
    // Telemetry must never change the outcome.
  }
}

/** Every Stripe customer the vendor's billing accounts carry. */
export async function loadVendorStripeCustomerIds(db: Db, vendorId: string): Promise<string[]> {
  const rows = await db
    .select({ customerId: billingAccounts.stripeCustomerId })
    .from(billingAccounts)
    .where(
      and(eq(billingAccounts.vendorId, vendorId), isNotNull(billingAccounts.stripeCustomerId)),
    );
  return [...new Set(rows.flatMap((r) => (r.customerId ? [r.customerId] : [])))];
}

/**
 * The paid term end of each live license with no `ends_at` on a live Stripe subscription,
 * read from Stripe before the batch. A failed read leaves those licenses out
 * (`paid_term_end_source: 'unknown'`) and warns.
 */
export async function readTermEnds(
  c: TerminationContext,
  stripe: StripeClient | null,
  vendorId: string,
  live: readonly LicenseBefore[],
): Promise<{ termEndById: Map<string, string>; subscriptions: BanSubscription[] }> {
  const ids = liveStripeSubscriptionIds(live);
  const termEndById = new Map<string, string>();
  const subscriptions: BanSubscription[] = ids.map((id) => ({ id }));
  if (ids.length === 0) return { termEndById, subscriptions };
  const unavailable = (id: string, reason: string) => {
    try {
      logToPosthog(c.executionCtx, c.env, c.req.raw, {
        level: 'warn',
        source: 'admin-moderation',
        message: 'aeci.stripe.ban_period_end_unavailable',
        vendor_id: vendorId,
        stripe_subscription_id: id,
        reason,
      });
    } catch {
      // Telemetry must never change the outcome.
    }
  };
  if (!stripe) {
    for (const id of ids) unavailable(id, 'no Stripe client');
    return { termEndById, subscriptions };
  }
  const settled = await mapWithConcurrency(ids, WORKER_CONNECTION_LIMIT, (id) =>
    stripe.retrieveSubscription(id),
  );
  settled.forEach((result, i) => {
    const id = ids[i]!;
    if (result.status === 'rejected') {
      unavailable(id, String(result.reason));
      return;
    }
    const read = result.value;
    if (!read.ok) {
      unavailable(id, `${read.reason} ${read.status}`);
      return;
    }
    const sub = read.data;
    subscriptions[i] = { id, status: sub.status };
    const end = subscriptionCurrentPeriodEnd(sub);
    if (end === null) return;
    const endsAt = toIsoTimestamp(new Date(end * 1000));
    for (const l of live) {
      if (l.stripeSubscriptionId === id && l.endsAt === null) termEndById.set(l.id, endsAt);
    }
  });
  return { termEndById, subscriptions };
}

/** Why the payments could not be read. Terminate refuses: the refund needs the amount. */
export class StripePaymentsUnavailable extends Error {}

/**
 * The vendor's refundable card payments: each paid payment on a subscription invoice with
 * a line period still running at the suspension date. `paidCents` is net of anything
 * already refunded on it. Throws {@link StripePaymentsUnavailable} on anything it cannot
 * read in full, because a refund worked out from part of the payments would be wrong.
 * Sequential: a handful of calls, and a Worker holds about six connections.
 */
export async function readRefundablePayments(
  stripe: StripeClient | null,
  customerIds: readonly string[],
  suspendedAtSeconds: number,
): Promise<{ payments: RefundablePayment[]; currency: string }> {
  const payments: RefundablePayment[] = [];
  const currencies = new Set<string>();
  if (customerIds.length === 0) return { payments, currency: 'usd' };
  if (!stripe) throw new StripePaymentsUnavailable('no Stripe client');
  for (const customer of customerIds) {
    const listed = await stripe.listPaidInvoices(
      customer,
      suspendedAtSeconds - REFUND_LOOKBACK_SECONDS,
    );
    if (!listed.ok) {
      throw new StripePaymentsUnavailable(`invoices ${listed.reason} ${listed.status}`);
    }
    for (const invoice of listed.data) {
      const subscriptionId = invoiceSubscriptionId(invoice);
      if (!subscriptionId) continue;
      if (invoice.lines.has_more || invoice.payments?.has_more || !invoice.payments) {
        throw new StripePaymentsUnavailable(`invoice ${invoice.id} is not fully listed`);
      }
      if (!invoice.lines.data.some((l) => l.period.end > suspendedAtSeconds)) continue;
      const lines = invoice.lines.data.map((l) => ({
        amountCents: l.amount,
        periodStart: l.period.start,
        periodEnd: l.period.end,
      }));
      for (const payment of invoice.payments.data) {
        if (payment.status !== 'paid' || payment.payment.type !== 'payment_intent') continue;
        const paymentIntentId = stripeId(payment.payment.payment_intent);
        if (!paymentIntentId) continue;
        const intent = await stripe.retrievePaymentIntent(paymentIntentId);
        if (!intent.ok) {
          throw new StripePaymentsUnavailable(`payment ${intent.reason} ${intent.status}`);
        }
        const charge = intent.data.latest_charge;
        const refunded = charge && typeof charge === 'object' ? charge.amount_refunded : 0;
        currencies.add(invoice.currency.toLowerCase());
        payments.push({
          key: `${invoice.id}:${paymentIntentId}`,
          source: 'stripe',
          paidCents: Math.max(0, (payment.amount_paid ?? 0) - refunded),
          lines,
          stripeSubscriptionId: subscriptionId,
          stripeInvoiceId: invoice.id,
          stripePaymentIntentId: paymentIntentId,
        });
      }
    }
  }
  if (currencies.size > 1) throw new StripePaymentsUnavailable('more than one currency');
  return { payments, currency: [...currencies][0] ?? 'usd' };
}

/** What Terminate read before its batch, kept for the post-commit work. */
export interface TerminationPlan {
  stmts: BatchStmt[];
  audits: AuditLogEntry[];
  transitions: WorkflowTransitionEntry[];
  vendor: { id: string; slug: string; companyName: string; verified: boolean };
  ending: LicenseBefore[];
  handback: VendorReturnBatch;
  subscriptions: BanSubscription[];
  stripeCustomerIds: string[];
  openProposalIds: string[];
  refundRowIds: string[];
}

/** Plans Terminate's one batch. Runs after every refusal, and writes nothing itself. */
export async function planTermination(
  db: Db,
  p: {
    vendor: TerminationPlan['vendor'];
    suspensionId: string;
    actor: { actorId: string; actorType: AuditLogEntry['actorType'] };
    now: string;
    vendorLicenses: LicenseBefore[];
    ownedAtBefore: string | null;
    termEndById: Map<string, string>;
    subscriptions: BanSubscription[];
    stripeCustomerIds: string[];
    openProposalIds: string[];
    allocations: readonly RefundAllocation[];
    statement: TerminationStatement;
    vendorPlan: AuditLogEntry['vendorPlan'];
  },
): Promise<TerminationPlan> {
  const { vendor, actor, now, vendorLicenses } = p;
  const vendorId = vendor.id;
  const source = 'admin-moderation';

  const seats = await db.query.profiles.findMany({
    columns: { id: true, bannedAt: true, banReason: true },
    where: and(eq(profiles.vendorId, vendorId), eq(profiles.role, 'vendor_admin')),
  });
  const unbanned = seats.filter((s) => s.bannedAt === null);
  const [existingWorkflows, liveInviteRows, handback] = await Promise.all([
    unbanned.length > 0
      ? db.query.workflowInstances.findMany({
          columns: { id: true, entityId: true },
          where: and(
            eq(workflowInstances.workflowType, 'reviewer_ban'),
            inArray(
              workflowInstances.entityId,
              unbanned.map((s) => s.id),
            ),
          ),
        })
      : Promise.resolve([]),
    db
      .select({ id: vendorSeatInvites.id, email: vendorSeatInvites.email })
      .from(vendorSeatInvites)
      .where(liveInvitesFor(vendorId, now)),
    planVendorHandback(db, {
      vendorId,
      ...actor,
      now,
      source,
      claimEndCause: VENDOR_TERMINATED_CAUSE,
      ...(p.vendorPlan ? { vendorPlan: p.vendorPlan } : {}),
    }),
  ]);
  const workflowBySeat = new Map(existingWorkflows.map((w) => [w.entityId, w.id]));

  const stmts: BatchStmt[] = [];
  const audits: AuditLogEntry[] = [];
  const transitions: WorkflowTransitionEntry[] = [];

  // The suspension closes first: a lost race (a lift or a second terminate) aborts here.
  stmts.push(
    db
      .update(vendorSuspensions)
      .set({
        resolution: 'terminated',
        resolvedAt: now,
        resolvedBy: actor.actorId,
        statement: p.statement,
        updatedAt: now,
      })
      .where(and(eq(vendorSuspensions.id, p.suspensionId), isNull(vendorSuspensions.resolvedAt))),
    ...seatRaceSentinels(db, vendorId, null),
  );

  // Every unbanned seat is banned, each with its own audit row and reversible workflow.
  for (const seat of unbanned) {
    const workflowId = workflowBySeat.get(seat.id) ?? crypto.randomUUID();
    const metadata = { source, cause: VENDOR_TERMINATED_CAUSE, suspension_id: p.suspensionId };
    const entry: AuditLogEntry = {
      ...actor,
      action: 'vendor_admin.banned',
      entityType: 'profile',
      entityId: seat.id,
      vendorId,
      vendorPlan: p.vendorPlan,
      beforeState: { banned_at: null, ban_reason: seat.banReason },
      afterState: { banned_at: now, ban_reason: TERMINATED_SEAT_BAN_REASON },
      metadata,
    };
    const transition: WorkflowTransitionEntry = {
      workflowId,
      fromState: 'active',
      toState: 'banned',
      actorId: actor.actorId,
      reason: TERMINATED_SEAT_BAN_REASON,
      metadata,
    };
    stmts.push(
      db
        .update(profiles)
        .set({ bannedAt: now, banReason: TERMINATED_SEAT_BAN_REASON })
        .where(and(eq(profiles.id, seat.id), isNull(profiles.bannedAt))),
      auditInsert(db, entry),
      workflowBySeat.has(seat.id)
        ? db
            .update(workflowInstances)
            .set({ currentState: 'banned' })
            .where(eq(workflowInstances.id, workflowId))
        : db.insert(workflowInstances).values({
            id: workflowId,
            workflowType: 'reviewer_ban',
            entityId: seat.id,
            currentState: 'banned',
          }),
      workflowTransitionInsert(db, transition),
    );
    audits.push(entry);
    transitions.push(transition);
  }
  stmts.push(noUnbannedSeatLeftSentinel(db, vendorId));

  // Pending invites go too: one must not mint an unbanned seat on an ended vendor.
  const inviteRevokes = liveInviteRows.map((invite) =>
    revokeInviteStatements(db, {
      vendorPlan: licensePlanSnapshot(vendorLicenses, now),
      inviteId: invite.id,
      vendorId,
      email: invite.email,
      ...actor,
      now,
      source,
      extraMetadata: { reason: VENDOR_TERMINATED_CAUSE, suspension_id: p.suspensionId },
    }),
  );

  const ending = vendorLicenses.filter((l) => l.endedAt === null);
  const licenseBatch = endLicensesStatements(db, {
    vendorId,
    now,
    ...actor,
    vendorLicenses,
    vendorWasVerified: vendor.verified,
    source,
    extraMetadata: { suspension_id: p.suspensionId },
    target: { licenseIds: ending.map((l) => l.id) },
    endReason: 'banned',
    termEndById: p.termEndById,
  });

  const { returned } = handback;
  const returnEntry: AuditLogEntry = {
    ...actor,
    action: RECORDS_RETURNED_ACTION,
    vendorId,
    vendorPlan: p.vendorPlan,
    entityType: 'vendor',
    entityId: vendorId,
    beforeState: { owned_at: p.ownedAtBefore },
    afterState: { owned_at: null },
    metadata: {
      source,
      cause: VENDOR_TERMINATED_CAUSE,
      vendorId,
      suspension_id: p.suspensionId,
      product_count: returned.productIds.length,
      integration_count: returned.integrationIds.length,
      evidenced_pair_count: returned.evidencedPairIds.length,
      contests_rerouted: returned.contestsRerouted,
      invites_revoked: liveInviteRows.length,
      proposals_discarded: p.openProposalIds.length,
      discarded_proposal_ids: p.openProposalIds,
      licenses_ended: ending.length,
      stripe_subscriptions: p.subscriptions.map((s) => s.id),
    },
  };

  const refundRows = p.allocations
    .filter((a) => a.refundCents > 0)
    .map((a) => ({
      id: crypto.randomUUID(),
      suspensionId: p.suspensionId,
      licenseId: a.payment.licenseId ?? null,
      stripeSubscriptionId: a.payment.stripeSubscriptionId ?? null,
      stripeInvoiceId: a.payment.stripeInvoiceId ?? null,
      stripePaymentIntentId: a.payment.stripePaymentIntentId ?? null,
      paidCents: a.payment.paidCents,
      grossCents: a.grossCents,
      costAppliedCents: a.costAppliedCents,
      refundCents: a.refundCents,
      currency: p.statement.currency,
      status: a.payment.source === 'invoice' ? 'manual' : 'pending',
    }));

  const terminatedEntry: AuditLogEntry = {
    ...actor,
    action: 'vendor.terminated',
    vendorId,
    vendorPlan: p.vendorPlan,
    entityType: 'vendor',
    entityId: vendorId,
    beforeState: { suspension_id: p.suspensionId, resolution: null },
    afterState: { suspension_id: p.suspensionId, resolution: 'terminated' },
    metadata: {
      source,
      suspension_id: p.suspensionId,
      gross_cents: p.statement.gross_cents,
      cost_total_cents: p.statement.cost_total_cents,
      cost_applied_cents: p.statement.cost_applied_cents,
      refund_cents: p.statement.refund_cents,
      seats_banned: unbanned.length,
    },
  };

  stmts.push(
    ...(p.ownedAtBefore !== null
      ? [
          db
            .update(vendors)
            .set({ ownedAt: null })
            .where(and(eq(vendors.id, vendorId), isNotNull(vendors.ownedAt))),
        ]
      : []),
    ...inviteRevokes.flatMap((r) => r.stmts),
    pendingInviteRaceSentinel(db, vendorId, now),
    ...handback.stmts,
    openProposalsUnchangedSentinel(db, vendorId, p.openProposalIds.length),
    db.delete(productProposals).where(openProposalsFor(vendorId)),
    ...withRaceSentinels(db, licenseBatch),
    noLiveLicenseSentinel(db, vendorId),
    auditInsert(db, returnEntry),
    ...(refundRows.length > 0 ? [db.insert(vendorTerminationRefunds).values(refundRows)] : []),
    auditInsert(db, terminatedEntry),
  );
  audits.push(
    ...inviteRevokes.map((r) => r.auditEntry),
    ...handback.audits,
    ...licenseBatch.auditEntries,
    returnEntry,
    terminatedEntry,
  );
  transitions.push(...handback.transitions);

  return {
    stmts,
    audits,
    transitions,
    vendor,
    ending,
    handback,
    subscriptions: p.subscriptions,
    stripeCustomerIds: p.stripeCustomerIds,
    openProposalIds: p.openProposalIds,
    refundRowIds: refundRows.map((r) => r.id),
  };
}

/** The products Terminate dropped to Free, with their names. */
export interface TerminationDrops {
  dropped: string[];
  names: Map<string, { slug: string; name: string }>;
}

/** The purge, after commit and BEFORE the Stripe cancel: a hung Stripe must not hold it. */
export async function purgeAfterTermination(
  c: TerminationContext,
  db: Db,
  plan: TerminationPlan,
): Promise<TerminationDrops> {
  const vendorId = plan.vendor.id;
  const endedProducts = [
    ...new Set(plan.ending.flatMap((l) => (l.assignedProductId ? [l.assignedProductId] : []))),
  ];
  let names = new Map<string, { slug: string; name: string }>();
  let dropped = endedProducts;
  try {
    const [state, read] = await Promise.all([
      loadOwnedProductLicenseState(db, vendorId),
      loadProductNames(db, endedProducts),
    ]);
    const stillLicensed = new Set(state.filter((s) => s.licensed).map((s) => s.productId));
    dropped = endedProducts.filter((pid) => !stillLicensed.has(pid));
    names = read;
  } catch (error) {
    warn(c, 'aeci.moderation.terminate_product_read_failed', vendorId, error);
  }
  try {
    await purgeLicenseDrops(
      c,
      db,
      dropped,
      names,
      [{ id: vendorId, slug: plan.vendor.slug, verified: plan.vendor.verified }],
      plan.handback.purgeTags,
    );
  } catch (error) {
    warn(c, 'aeci.moderation.terminate_purge_failed', vendorId, error);
  }
  return { dropped, names };
}

/**
 * Pays every unsettled refund of a suspension, one at a time. Each result updates its row
 * with its audit row in one batch. A lookup by row id comes first, and the row id is also
 * the idempotency key, so a retry after a lost response cannot pay twice, however late. Stops at the deadline and leaves the rest `pending`.
 * Never throws. Run it after the cancel.
 */
export async function settleTerminationRefunds(
  c: TerminationContext,
  db: Db,
  stripe: StripeClient | null,
  p: {
    vendorId: string;
    suspensionId: string;
    actor: { actorId: string; actorType: AuditLogEntry['actorType'] };
    deadlineMs?: number;
  },
): Promise<void> {
  const deadline = Date.now() + (p.deadlineMs ?? TERMINATION_REFUND_DEADLINE_MS);
  const rows = await db.query.vendorTerminationRefunds.findMany({
    where: and(
      eq(vendorTerminationRefunds.suspensionId, p.suspensionId),
      inArray(vendorTerminationRefunds.status, ['pending', 'failed']),
    ),
  });
  for (const row of rows) {
    if (Date.now() >= deadline) break;
    let refundId: string | null = null;
    let failure: string | null = null;
    try {
      if (!stripe) failure = 'no Stripe client';
      else if (!row.stripePaymentIntentId) failure = 'no payment intent';
      else {
        // Stripe may drop an idempotency key after 24 hours. A first call that took the
        // refund but lost its response would otherwise pay twice on a later retry. A
        // lookup that cannot answer pays nothing: the row stays failed for the next retry.
        const existing = await stripe.listRefunds(row.stripePaymentIntentId);
        if (!existing.ok) {
          failure = `refund lookup ${existing.reason} ${existing.status}`;
        } else {
          const paid = existing.data.find(
            (r) =>
              r.metadata?.aeci_refund_id === row.id &&
              r.status !== 'failed' &&
              r.status !== 'canceled',
          );
          if (paid) refundId = paid.id;
        }
        if (!failure && !refundId) {
          const res = await stripe.createRefund(
            {
              payment_intent: row.stripePaymentIntentId,
              amount: row.refundCents,
              metadata: { aeci_suspension_id: p.suspensionId, aeci_refund_id: row.id },
            },
            `aeci-termination-refund-${row.id}`,
          );
          if (res.ok) refundId = res.data.id;
          else failure = `${res.reason} ${res.status}`;
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    const status = refundId ? 'succeeded' : 'failed';
    const entry: AuditLogEntry = {
      ...p.actor,
      action: refundId ? 'vendor.termination_refund_paid' : 'vendor.termination_refund_failed',
      vendorId: p.vendorId,
      entityType: 'vendor_suspension',
      entityId: p.suspensionId,
      beforeState: { refund_id: row.id, status: row.status },
      afterState: { refund_id: row.id, status, stripe_refund_id: refundId },
      metadata: {
        source: 'admin-moderation',
        refund_cents: row.refundCents,
        ...(failure ? { reason: failure } : {}),
      },
    };
    try {
      await db.batch([
        db
          .update(vendorTerminationRefunds)
          .set({ status, stripeRefundId: refundId, updatedAt: new Date().toISOString() })
          .where(eq(vendorTerminationRefunds.id, row.id)),
        auditInsert(db, entry),
      ]);
      forwardAuditBatch(c, [entry], []);
    } catch (error) {
      warn(c, 'aeci.stripe.termination_refund_record_failed', p.vendorId, error);
    }
    if (failure) {
      warn(c, 'aeci.stripe.termination_refund_failed', p.vendorId, failure);
    }
  }
}

/** One `vendor-terminated` per address: every seat, banned ones included, and billing. */
export async function emailAfterTermination(
  c: TerminationContext,
  db: Db,
  p: {
    vendorId: string;
    vendorName: string;
    suspensionId: string;
    statement: TerminationStatement;
    products: readonly { slug: string; name: string }[];
    subscriptionOutcomes: readonly BanCancelOutcome[];
    fetchSeatEmails: FetchSeatEmails;
    send: SendVendorTerminated;
  },
): Promise<void> {
  try {
    const [seats, billingEmails, refunds] = await Promise.all([
      loadVendorSeatRecipients(db, c.env, [p.vendorId], p.fetchSeatEmails, { includeBanned: true }),
      loadVendorBillingEmails(db, p.vendorId),
      db.query.vendorTerminationRefunds.findMany({
        columns: { status: true, refundCents: true },
        where: eq(vendorTerminationRefunds.suspensionId, p.suspensionId),
      }),
    ]);
    const addresses = mergeRecipientAddresses(
      [...(seats.get(p.vendorId) ?? []).map((s) => s.email), ...billingEmails],
      null,
    );
    const statuses = refunds.map((r) => r.status);
    const refund =
      statuses.length === 0
        ? 'none'
        : statuses.some((s) => s === 'pending' || s === 'failed')
          ? 'pending'
          : statuses.some((s) => s === 'succeeded')
            ? 'paid'
            : 'manual';
    for (const to of addresses) {
      await p.send(c, {
        to,
        vendorName: p.vendorName,
        products: p.products,
        subscriptionOutcomes: p.subscriptionOutcomes,
        statement: p.statement,
        refund,
        manualRefundCents: refunds
          .filter((r) => r.status === 'manual')
          .reduce((sum, r) => sum + r.refundCents, 0),
        dedupeKey: `vendor-terminated:${p.suspensionId}:${refund}:${await recipientHash(to)}`,
        entity: { type: 'vendor', id: p.vendorId },
      });
    }
  } catch (error) {
    warn(c, 'aeci.moderation.terminate_email_failed', p.vendorId, error);
  }
}

/** Everything after Terminate's commit. Run it in `waitUntil`. Never throws. */
export function runTerminationFollowups(
  c: TerminationContext,
  db: Db,
  plan: TerminationPlan,
  p: {
    suspensionId: string;
    statement: TerminationStatement;
    actor: { actorId: string; actorType: AuditLogEntry['actorType'] };
    stripeFor: StripeClientFor;
    fetchSeatEmails: FetchSeatEmails;
    send: SendVendorTerminated;
  },
): void {
  dispatchOwnershipSync(c, plan.vendor.id, 'records_returned');
  const purged = purgeAfterTermination(c, db, plan);
  c.executionCtx.waitUntil(purged);
  c.executionCtx.waitUntil(
    (async () => {
      const stripe = p.stripeFor(c.env);
      const outcomes =
        plan.subscriptions.length > 0 || plan.stripeCustomerIds.length > 0
          ? await stripeBanCancelNowHook(c, stripe, {
              vendorId: plan.vendor.id,
              subscriptions: plan.subscriptions,
              customerIds: plan.stripeCustomerIds,
            })
          : [];
      await settleTerminationRefunds(c, db, stripe, {
        vendorId: plan.vendor.id,
        suspensionId: p.suspensionId,
        actor: p.actor,
      });
      const { dropped, names } = await purged;
      await emailAfterTermination(c, db, {
        vendorId: plan.vendor.id,
        vendorName: plan.vendor.companyName,
        suspensionId: p.suspensionId,
        statement: p.statement,
        products: dropped.flatMap((pid) => {
          const named = names.get(pid);
          return named ? [named] : [];
        }),
        subscriptionOutcomes: outcomes,
        fetchSeatEmails: p.fetchSeatEmails,
        send: p.send,
      });
    })().catch((error: unknown) =>
      warn(c, 'aeci.moderation.terminate_followup_failed', plan.vendor.id, error),
    ),
  );
}
