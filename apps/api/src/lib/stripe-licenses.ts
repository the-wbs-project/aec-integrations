/**
 * Stripe subscription → license sync (AECI-1500, E9.2 of the AECI-1339 epic;
 * `docs/VENDOR_SIGNUP_PROCESS.md` §2 decision 13, §3 steps 4 and 9;
 * `docs/STAGE_2_PAID_TIERS_SPEC.md` §7.6 points 2 and 9).
 *
 * ── ONE FUNCTION OWNS LICENSE TRUTH ─────────────────────────────────────────────
 * A Stripe subscription of quantity N is N `licenses` rows sharing
 * `stripe_subscription_id`. {@link syncSubscriptionLicensesStatements} maps one
 * subscription object onto those rows, and `syncStripeLicensesStatements` in
 * `lib/license.ts` (the one license writer) builds the batch. Every webhook event and
 * the daily reconcile (E9.5) re-read the subscription from Stripe and call it, so the
 * order Stripe delivers events in does not matter: the sync converges on the
 * subscription as it is now.
 *
 * ── THE ENTRY POINT ─────────────────────────────────────────────────────────────
 * {@link runStripeSubscriptionSync} is the one caller-facing function. It resolves the
 * billing account, reads the vendor's licenses, plans the batch, the carry-over
 * pre-check and the last-license contest re-route, commits ONE `db.batch`, re-plans
 * once on a lost race, and schedules the post-commit work in `waitUntil`: one audit
 * forward, one cache purge, and the `managed-ended`, `licenses-granted` and
 * `renewal-cancelled` emails.
 * A caller can put statements FIRST in that batch (`prefix`): the webhook's
 * `stripe_events` ledger INSERT, the checkout acceptance and the customer link.
 *
 * ── THE BAN (AECI-1589, ruled 2026-11-03) ──────────────────────────────────────
 * A termination (AECI-1623) ends every license at once
 * (`end_reason = 'banned'`), then {@link stripeBanCancelNowHook} cancels now, with no
 * proration (`DELETE /v1/subscriptions/:id`), every subscription on the vendor's Stripe
 * customer, live license or not, and expires its open Checkout sessions. Post-commit,
 * best-effort, under a 15 s deadline: a failure warns. Every status but `canceled` and `incomplete_expired` is
 * cancelled ({@link isStripeSubscriptionCancellable}): an `unpaid`, `paused` or
 * `incomplete` subscription can still be paid through Stripe's hosted invoice. A
 * subscription the cancel missed reads "ban-dead": not yet cancelled in Stripe while its
 * vendor is terminated and fully banned (`vendorBanDead`), or while its licenses ended `banned` and
 * none is live. {@link runStripeSubscriptionSync} never grants on one. It cancels
 * it instead (outcome `ban-dead`), so a `subscription.updated` that lands between the
 * ban and its cancel, and the daily reconcile, both repair a cancel that failed. A sync
 * that read before the ban carries batch sentinels ({@link bannedSubscriptionSentinel},
 * and `unbannedSeatExistsSentinel` on a grant) and re-plans into that branch. Stripe's own `deleted` / `updated(canceled)` events
 * after the cancel find nothing live and change nothing (`no_change`): no
 * `managed-ended`, no purge.
 */

import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { LEGAL_AGREEMENT_CURRENT_VERSIONS } from '@aeci/shared';
import { licensePlanSnapshot, type VendorPlanSnapshot } from '@aeci/shared/entitlements';
import { and, eq, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { billingAccounts, licenses, vendors } from '../db/schema';
import type { Env } from '../env';
import { logToPosthog } from '../posthog';
import { emailLicensesGranted, type SendLicensesGranted } from '../routes/admin-licenses';
import { auditInsert, type BatchStmt, type BatchTuple } from './audit';
import { loadBillingEmails, mergeRecipientAddresses } from './billing-recipients';
import type { EmailContext, sendManagedEndedEmail, sendRenewalCancelledEmail } from './email';
import { recipientHash } from './hash';
import { planLastLicenseReroute, type LastLicenseReroutePlan } from './integration-contests';
import {
  loadVendorLicenses,
  syncStripeLicensesStatements,
  toIsoTimestamp,
  type LicenseBefore,
  type StripeSyncBatch,
  type StripeSyncMode,
} from './license';
import {
  loadNoCarryProducts,
  loadProductNames,
  purgeLicenseDrops,
  withRaceSentinels,
} from './license-lapse';
import { isReleaseRaceError } from './license-release-requests';
import { forwardAuditBatch } from './moderation-forward';
import {
  stripeId,
  subscriptionCurrentPeriodEnd,
  subscriptionInterval,
  subscriptionQuantity,
  StripeTransientError,
  type StripeClient,
  type StripeSubscription,
  type StripeSubscriptionStatus,
} from './stripe';
import { fetchAuthUserEmails } from './supabase-admin';
import { uuidv5 } from './uuidv5';
import { vendorBanDead, vendorNotBanDeadSentinel } from './vendor-handback';
import { loadVendorSeatRecipients, type FetchSeatEmails } from './vendor-seat-recipients';

/** The Stripe sync is the system's write: no admin and no vendor acts. */
const STRIPE_ACTOR = { actorId: null, actorType: 'system' } as const;

/**
 * The namespace every Stripe license id is minted under:
 * `uuidv5('https://aecintegrations.com/stripe/licenses', URL_NAMESPACE)`. Pinned as a
 * literal so a refactor cannot re-mint the ids. `stripe-licenses.spec.ts` re-derives it.
 */
export const STRIPE_LICENSE_NAMESPACE = '253c3f87-443e-58be-b20a-9dd3076536bf';

/**
 * The ids of a subscription's licenses `from + 1` to `from + count`, where `from` is
 * how many rows the subscription already has, live or ended:
 * `uuidv5('stripe-license:{subscriptionId}:{n}')`.
 *
 * The name holds the subscription and the ordinal, not the invoice. Two syncs that
 * read the same rows mint the same ids whatever event started them, so the second
 * batch trips the primary key and re-plans from a fresh read instead of granting
 * twice. An ended row keeps its ordinal, so a new grant never reuses an id.
 */
export function stripeLicenseIds(
  subscriptionId: string,
  from: number,
  count: number,
): Promise<string[]> {
  return Promise.all(
    Array.from({ length: count }, (_, i) =>
      uuidv5(`stripe-license:${subscriptionId}:${from + i + 1}`, STRIPE_LICENSE_NAMESPACE),
    ),
  );
}

/**
 * What a subscription status does to its licenses. `null`: nothing, for `incomplete`
 * (the first payment has not gone through) and `paused`.
 */
export function stripeSyncMode(status: StripeSubscriptionStatus): StripeSyncMode | null {
  switch (status) {
    case 'active':
    case 'trialing':
    case 'past_due':
      return 'live';
    case 'canceled':
    case 'unpaid':
    case 'incomplete_expired':
      return 'terminal';
    default:
      return null;
  }
}

/**
 * Whether Stripe can still bill `status`, so the ban must cancel it (AECI-1589): every
 * status but the two terminal ones, `canceled` and `incomplete_expired`. Wider than
 * `stripeSyncMode(...) === 'live'` on purpose: an `unpaid`, `paused` or `incomplete`
 * subscription grants no license, yet its open invoice can still be paid.
 */
export function isStripeSubscriptionCancellable(status: StripeSubscriptionStatus): boolean {
  return status !== 'canceled' && status !== 'incomplete_expired';
}

/** The billing account a subscription bills, and its vendor. */
export interface StripeSubscriptionTarget {
  billingAccountId: string;
  vendorId: string;
  vendorSlug: string;
  vendorName: string;
  vendorVerified: boolean;
}

/**
 * Find the billing account a subscription belongs to. The subscription metadata's
 * `billing_account_id` (E9.3 writes it on every Checkout session), checked against
 * `vendor_id` when that is set too. Else the account whose `stripe_customer_id` is the
 * subscription's customer. `null` when neither resolves: the event cannot be applied.
 */
export async function resolveSubscriptionTarget(
  db: Db,
  sub: Pick<StripeSubscription, 'metadata' | 'customer'>,
): Promise<StripeSubscriptionTarget | null> {
  const select = () =>
    db
      .select({
        billingAccountId: billingAccounts.id,
        vendorId: vendors.id,
        vendorSlug: vendors.slug,
        vendorName: vendors.companyName,
        vendorVerified: vendors.verified,
      })
      .from(billingAccounts)
      .innerJoin(vendors, eq(vendors.id, billingAccounts.vendorId));
  const accountId = sub.metadata?.billing_account_id?.trim();
  const vendorId = sub.metadata?.vendor_id?.trim();
  if (accountId) {
    const [row] = await select()
      .where(
        and(
          eq(billingAccounts.id, accountId),
          ...(vendorId ? [eq(billingAccounts.vendorId, vendorId)] : []),
        ),
      )
      .limit(1);
    if (row) return row;
  }
  const customerId = stripeId(sub.customer);
  if (!customerId) return null;
  const [row] = await select().where(eq(billingAccounts.stripeCustomerId, customerId)).limit(1);
  return row ?? null;
}

/** What {@link syncSubscriptionLicensesStatements} needs besides the subscription. */
export interface SubscriptionSyncContext {
  vendorId: string;
  billingAccountId: string;
  /** Every license of the vendor, as pre-read (`loadVendorLicenses`). */
  vendorLicenses: readonly LicenseBefore[];
  vendorWasVerified: boolean;
  now: string | Date;
  /** `metadata.source` on every audit row. */
  source: string;
  /** A renewal (`invoice.paid`, `subscription_cycle`): bind the current Managed plan
   *  agreement version to every license kept (ruling R1). The sync also treats an
   *  annual period end moving forward as one ({@link annualPeriodMovedForward}). */
  renewal?: boolean;
  /** `stripeLicenseIds` for the delta. */
  grantLicenseIds: readonly string[];
  noCarryProductIds?: ReadonlySet<string>;
  extraMetadata?: Record<string, unknown>;
}

/** How many licenses a sync of `sub` grants against `vendorLicenses`. */
export function grantDelta(
  sub: StripeSubscription,
  vendorLicenses: readonly LicenseBefore[],
): number {
  if (stripeSyncMode(sub.status) !== 'live') return 0;
  const live = vendorLicenses.filter(
    (l) => l.endedAt === null && l.stripeSubscriptionId === sub.id,
  ).length;
  return Math.max(0, subscriptionQuantity(sub) - live);
}

/** The scheduled end a subscription gives its licenses: the period end when annual,
 *  `null` when monthly (renews until cancelled). */
export function subscriptionEndsAt(sub: StripeSubscription): string | null {
  if (subscriptionInterval(sub) !== 'year') return null;
  const end = subscriptionCurrentPeriodEnd(sub);
  return end === null ? null : toIsoTimestamp(new Date(end * 1000));
}

/**
 * Whether an annual subscription's period end has moved past the `ends_at` of a live
 * license on it: Stripe renewed it, and the licenses still carry the old term. Monthly
 * licenses carry no `ends_at`, so only `invoice.paid` (`subscription_cycle`) marks a
 * monthly renewal.
 */
export function annualPeriodMovedForward(
  subscriptionId: string,
  endsAt: string | null,
  vendorLicenses: readonly LicenseBefore[],
): boolean {
  if (endsAt === null) return false;
  const next = Date.parse(endsAt);
  return vendorLicenses.some(
    (l) =>
      l.endedAt === null &&
      l.stripeSubscriptionId === subscriptionId &&
      l.endsAt !== null &&
      Date.parse(l.endsAt) < next,
  );
}

/**
 * The batch for one subscription (P0 of the epic plan). Pure: the caller pre-reads.
 * `null` when the status changes nothing (`incomplete`, `paused`).
 */
export function syncSubscriptionLicensesStatements(
  db: Db,
  sub: StripeSubscription,
  ctx: SubscriptionSyncContext,
): StripeSyncBatch | null {
  const mode = stripeSyncMode(sub.status);
  if (mode === null) return null;
  const current = LEGAL_AGREEMENT_CURRENT_VERSIONS.managed_plan;
  const metadataVersion = sub.metadata?.terms_version?.trim() || null;
  const endsAt = subscriptionEndsAt(sub);
  // A renewal binds the current version. The webhook says so on `invoice.paid`
  // (`subscription_cycle`); any other caller (the reconcile, a `subscription.updated`)
  // sees it as an annual period end moving forward (AECI-1503).
  const renewal =
    ctx.renewal === true ||
    (mode === 'live' && annualPeriodMovedForward(sub.id, endsAt, ctx.vendorLicenses));
  return syncStripeLicensesStatements(db, {
    vendorId: ctx.vendorId,
    now: ctx.now,
    ...STRIPE_ACTOR,
    vendorLicenses: ctx.vendorLicenses,
    vendorWasVerified: ctx.vendorWasVerified,
    source: ctx.source,
    extraMetadata: { stripe_subscription_id: sub.id, ...ctx.extraMetadata },
    billingAccountId: ctx.billingAccountId,
    stripeSubscriptionId: sub.id,
    mode,
    quantity: subscriptionQuantity(sub),
    endsAt,
    termsVersion: renewal ? current : metadataVersion,
    ...(renewal ? { renewalTermsVersion: current } : {}),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    grantLicenseIds: ctx.grantLicenseIds,
    noCarryProductIds: ctx.noCarryProductIds,
  });
}

// ─── The entry point ─────────────────────────────────────────────────────────

/** What a run did. */
export type StripeSyncOutcome =
  /** Licenses changed. */
  | 'synced'
  /** The subscription and the licenses already agreed. */
  | 'no_change'
  /** No billing account matched the subscription. Nothing was written but the prefix. */
  | 'unlinked'
  /** The status changes nothing (`incomplete`, `paused`). */
  | 'skipped'
  /** A not-yet-cancelled subscription whose licenses a ban ended (AECI-1589). Nothing
   *  was granted; the run cancelled it in Stripe. Nothing was written but the prefix. */
  | 'ban-dead';

/** Statements to put FIRST in the sync's batch, and their audit rows. */
export interface SyncPrefix {
  stmts: BatchStmt[];
  audits: AuditLogEntry[];
}

export type SendManagedEnded = typeof sendManagedEndedEmail;
export type SendRenewalCancelled = typeof sendRenewalCancelledEmail;

export interface StripeSyncRunOptions {
  /** `metadata.source` on every audit row, and the log source. */
  source: string;
  now?: Date;
  /** See {@link SubscriptionSyncContext.renewal}. */
  renewal?: boolean;
  extraMetadata?: Record<string, unknown>;
  /**
   * Built once the outcome and the target are known, and re-built on a re-plan. The
   * webhook returns its `stripe_events` INSERT first, so a replay trips the primary key
   * before any license write.
   */
  prefix?: (p: {
    outcome: StripeSyncOutcome;
    target: StripeSubscriptionTarget | null;
    vendorPlan: VendorPlanSnapshot | null;
    vendorLicenses: readonly LicenseBefore[];
  }) => SyncPrefix | Promise<SyncPrefix>;
  fetchSeatEmails?: FetchSeatEmails;
  sendEnded?: SendManagedEnded;
  sendGranted?: SendLicensesGranted;
  sendRenewalCancelled?: SendRenewalCancelled;
  /**
   * The client that cancels a ban-dead subscription ({@link isBanDeadSubscription}).
   * Absent or `null` while the subscription is ban-dead: the run throws
   * `StripeTransientError`, so the caller retries rather than grant to a banned vendor.
   */
  stripe?: StripeClient | null;
}

export interface StripeSyncRunResult {
  outcome: StripeSyncOutcome;
  target: StripeSubscriptionTarget | null;
  granted: string[];
  ended: StripeSyncBatch['ended'];
  carried: StripeSyncBatch['carried'];
  reroutedContests: number;
  verifiedFlipped: boolean;
  /** The prefix's audit rows plus the sync's, as committed. */
  auditEntries: AuditLogEntry[];
}

const noopSendEnded: SendManagedEnded = async () => 'skipped';
const noopSendGranted: SendLicensesGranted = async () => 'skipped';
const noopSendRenewalCancelled: SendRenewalCancelled = async () => 'skipped';

/**
 * Whether `subscriptionId` is ban-dead in `vendorLicenses` (AECI-1589): some license on
 * it ended `banned` and none is live. A cancellable Stripe status on it
 * ({@link isStripeSubscriptionCancellable}) means the termination's cancel has not landed yet,
 * and a sync must cancel, never grant.
 */
export function isBanDeadSubscription(
  subscriptionId: string,
  vendorLicenses: readonly LicenseBefore[],
): boolean {
  const onSub = vendorLicenses.filter((l) => l.stripeSubscriptionId === subscriptionId);
  return onSub.some((l) => l.endReason === 'banned') && onSub.every((l) => l.endedAt !== null);
}

/**
 * Aborts the sync's batch when any license on `subscriptionId` has ended `banned` at
 * that point in the batch (AECI-1589). A sync that read before a termination, and
 * plans only INSERTs, would otherwise land live licenses on a banned vendor.
 * `json(...)` on a non-JSON string is malformed JSON, so the whole batch rolls back and
 * `isReleaseRaceError` sends the run to its one re-plan, which reads the subscription as
 * ban-dead and cancels it. Reads only.
 */
export function bannedSubscriptionSentinel(db: Db, subscriptionId: string): BatchStmt {
  const banned = sql`EXISTS (SELECT 1 FROM ${licenses} WHERE ${licenses.stripeSubscriptionId} = ${subscriptionId} AND ${licenses.endReason} = 'banned')`;
  return db
    .select({ guard: sql`CASE WHEN ${banned} THEN json('stripe-subscription-banned') END` })
    .from(sql`(SELECT 1)`);
}

/** A grant that lost a race to an identical one: the minted ids already exist. */
export function isStripeLicenseIdConflict(error: unknown): boolean {
  return causeMatches(error, /UNIQUE constraint failed: licenses\.id/i);
}

/**
 * A checkout acceptance that lost a race to the same session's: the webhook and the
 * reconcile both recorded it (`agreement_acceptances_stripe_session_key`). A re-plan
 * re-reads, and the caller's prefix leaves the acceptance out the second time.
 */
export function isCheckoutAcceptanceConflict(error: unknown): boolean {
  return causeMatches(
    error,
    /UNIQUE constraint failed: agreement_acceptances\.stripe_checkout_session_id/i,
  );
}

function causeMatches(error: unknown, pattern: RegExp): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (pattern.test(String((current as { message?: unknown }).message ?? current))) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Sync one subscription's licenses and run the post-commit work. The entry point for
 * the webhook (`routes/webhooks.ts`) and the E9.5 reconcile job.
 *
 * Throws on a D1 error, including a primary-key failure in the caller's `prefix` (the
 * webhook reads that as a replay), and when a re-planned batch loses a race a second
 * time. The webhook answers those with a 500, so Stripe retries. Nothing after the
 * commit throws: the post-commit work runs in `c.executionCtx.waitUntil`.
 */
export async function runStripeSubscriptionSync(
  c: EmailContext,
  db: Db,
  sub: StripeSubscription,
  opts: StripeSyncRunOptions,
): Promise<StripeSyncRunResult> {
  const nowIso = (opts.now ?? new Date()).toISOString();
  const target = await resolveSubscriptionTarget(db, sub);
  const empty: Omit<StripeSyncRunResult, 'outcome' | 'auditEntries'> = {
    target,
    granted: [],
    ended: [],
    carried: [],
    reroutedContests: 0,
    verifiedFlipped: false,
  };

  if (!target) {
    const prefix = await opts.prefix?.({
      outcome: 'unlinked',
      target: null,
      vendorPlan: null,
      vendorLicenses: [],
    });
    if (prefix && prefix.stmts.length > 0) await db.batch(prefix.stmts as BatchTuple);
    warn(c, opts.source, 'aeci.stripe.sync.unlinked', sub.id);
    if (prefix) forwardAuditBatch(c, prefix.audits, [], opts.source);
    return { ...empty, outcome: 'unlinked', auditEntries: prefix?.audits ?? [] };
  }

  // Every attempt assigns all four before the loop can exit.
  let batch: StripeSyncBatch | null;
  let reroute: LastLicenseReroutePlan['reroute'];
  let prefix: SyncPrefix;
  let outcome: StripeSyncOutcome;
  // At most two attempts, as the lapse and the revoke do: a lost race re-reads once.
  for (let attempt = 1; ; attempt++) {
    const [vendorLicenses, vendorRow, banDead] = await Promise.all([
      loadVendorLicenses(db, target.vendorId),
      db.query.vendors.findFirst({
        columns: { verified: true },
        where: eq(vendors.id, target.vendorId),
      }),
      vendorBanDead(db, target.vendorId),
    ]);
    const wasVerified = vendorRow?.verified ?? false;
    const mode = stripeSyncMode(sub.status);
    // AECI-1589, AECI-1623: the vendor was terminated and every seat is still banned, or a
    // termination ended this subscription's licenses, and the cancel has not landed. A
    // vendor left with only banned seats by a revoke is not this: it got no notice and no
    // refund, so its billing carries on. Grant nothing: cancel it now and record
    // the event. Any status Stripe can still bill counts, not only a live one: an
    // `unpaid` subscription whose licenses lapsed before the ban, and an `incomplete`
    // first payment, carry no `banned` row and are ban-dead all the same.
    if (
      isStripeSubscriptionCancellable(sub.status) &&
      (banDead || isBanDeadSubscription(sub.id, vendorLicenses))
    ) {
      return banDeadRun(c, db, sub, target, vendorLicenses, nowIso, opts, empty);
    }
    const fromOrdinal = vendorLicenses.filter((l) => l.stripeSubscriptionId === sub.id).length;
    const grantLicenseIds = await stripeLicenseIds(
      sub.id,
      fromOrdinal,
      grantDelta(sub, vendorLicenses),
    );
    // The carry-over pre-check reads only when something can end.
    const mayEnd =
      mode === 'terminal' ||
      (mode === 'live' &&
        vendorLicenses.filter((l) => l.endedAt === null && l.stripeSubscriptionId === sub.id)
          .length > subscriptionQuantity(sub));
    const noCarryProductIds = mayEnd
      ? await loadNoCarryProducts(db, {
          vendorId: target.vendorId,
          billingAccountId: target.billingAccountId,
          endingLicenseIds: new Set(
            vendorLicenses
              .filter((l) => l.endedAt === null && l.stripeSubscriptionId === sub.id)
              .map((l) => l.id),
          ),
          vendorLicenses,
        })
      : new Set<string>();

    batch = syncSubscriptionLicensesStatements(db, sub, {
      vendorId: target.vendorId,
      billingAccountId: target.billingAccountId,
      vendorLicenses,
      vendorWasVerified: wasVerified,
      now: nowIso,
      source: opts.source,
      renewal: opts.renewal,
      grantLicenseIds,
      noCarryProductIds,
      extraMetadata: opts.extraMetadata,
    });
    outcome = batch === null ? 'skipped' : batch.stmts.length > 0 ? 'synced' : 'no_change';

    // Ruling B (§11b.13): an end that leaves the vendor no live license moves its open
    // owner-routed contests on connector-powered rows to AECi, in this batch.
    reroute = null;
    let remainsGuard: BatchStmt | null = null;
    if (batch && batch.ended.length > 0) {
      const plan = await planLastLicenseReroute(db, {
        vendorId: target.vendorId,
        actor: STRIPE_ACTOR,
        now: nowIso,
        vendorLicenses,
        endingLicenseIds: new Set(batch.ended.map((e) => e.licenseId)),
        extra: {
          source: opts.source,
          billing_account_id: target.billingAccountId,
          stripe_subscription_id: sub.id,
        },
      });
      reroute = plan.reroute;
      remainsGuard = plan.remainsGuard;
    }

    prefix = (await opts.prefix?.({
      outcome,
      target,
      vendorPlan: licensePlanSnapshot(vendorLicenses, nowIso),
      vendorLicenses,
    })) ?? { stmts: [], audits: [] };

    // AECI-1589: a ban that commits between the read above and this batch would leave
    // this plan's grants live on a banned vendor (an INSERT has no row to lose a race
    // on). The sentinel aborts, and the re-plan reads the subscription as ban-dead. Left
    // off when the read already saw a `banned` row here: that plan knows of the ban.
    const sawBan = vendorLicenses.some(
      (l) => l.stripeSubscriptionId === sub.id && l.endReason === 'banned',
    );
    // A batch that grants also aborts when the vendor is ban-dead at batch time: a
    // terminate of a vendor with no license on this subscription writes no `banned` row
    // the sentinel above could see.
    const grants = batch !== null && mode === 'live' && batch.granted.length > 0;
    const stmts: BatchStmt[] = [
      ...prefix.stmts,
      ...(batch && batch.stmts.length > 0 ? withRaceSentinels(db, batch) : []),
      ...(batch && batch.stmts.length > 0 && !sawBan
        ? [bannedSubscriptionSentinel(db, sub.id)]
        : []),
      ...(grants ? [vendorNotBanDeadSentinel(db, target.vendorId)] : []),
      ...(remainsGuard ? [remainsGuard] : []),
      ...(reroute?.stmts ?? []),
      ...(reroute?.audits ?? []).map((entry) => auditInsert(db, entry)),
    ];
    if (stmts.length === 0) break;
    try {
      await db.batch(stmts as BatchTuple);
      break;
    } catch (error) {
      // The license, contest, live-license and banned-subscription sentinels raise the
      // same malformed-JSON abort, a grant that lost to an identical one trips `licenses.id`, and a checkout
      // acceptance the webhook and the reconcile both recorded trips its session key.
      // All re-plan from a fresh read once, and the prefix is rebuilt on that read.
      // Anything else (a replayed ledger row) throws.
      const raced =
        isReleaseRaceError(error) ||
        isStripeLicenseIdConflict(error) ||
        isCheckoutAcceptanceConflict(error);
      if (attempt >= 2 || !raced) throw error;
    }
  }

  const committed = batch;
  const audits = [...prefix.audits, ...(committed?.auditEntries ?? []), ...(reroute?.audits ?? [])];
  forwardAuditBatch(c, audits, [], opts.source);

  const result: StripeSyncRunResult = {
    outcome,
    target,
    granted: committed?.granted ?? [],
    ended: committed?.ended ?? [],
    carried: committed?.carried ?? [],
    reroutedContests: reroute?.rerouted ?? 0,
    verifiedFlipped: committed?.verifiedFlipped ?? false,
    auditEntries: audits,
  };
  if (committed && committed.stmts.length > 0) {
    c.executionCtx.waitUntil(afterCommit(c, db, sub, target, committed, opts));
  }
  return result;
}

/**
 * The ban-dead branch of {@link runStripeSubscriptionSync}: cancel the subscription now,
 * then commit only the caller's prefix (the webhook's ledger row). A cancel that fails
 * throws `StripeTransientError` before anything is written, so the webhook answers 503
 * and Stripe retries, and
 * the reconcile counts a failure and the queue retries. A refusal on a subscription
 * that is canceled by then counts as done.
 */
async function banDeadRun(
  c: EmailContext,
  db: Db,
  sub: StripeSubscription,
  target: StripeSubscriptionTarget,
  vendorLicenses: readonly LicenseBefore[],
  nowIso: string,
  opts: StripeSyncRunOptions,
  empty: Omit<StripeSyncRunResult, 'outcome' | 'auditEntries'>,
): Promise<StripeSyncRunResult> {
  const outcome = await cancelNow(opts.stripe ?? null, sub.id);
  if (outcome === 'failed') {
    throw new StripeTransientError(
      `ban-dead subscription ${sub.id}: the cancel failed`,
      opts.stripe ? 'ban_dead_cancel_failed' : 'stripe_unconfigured',
    );
  }
  const prefix = (await opts.prefix?.({
    outcome: 'ban-dead',
    target,
    vendorPlan: licensePlanSnapshot(vendorLicenses, nowIso),
    vendorLicenses,
  })) ?? { stmts: [], audits: [] };
  if (prefix.stmts.length > 0) await db.batch(prefix.stmts as BatchTuple);
  forwardAuditBatch(c, prefix.audits, [], opts.source);
  warn(c, opts.source, 'aeci.stripe.sync.ban_dead_cancelled', sub.id);
  return { ...empty, outcome: 'ban-dead', auditEntries: prefix.audits };
}

/** The purge and the emails. Never throws: the licenses have changed whatever happens. */
async function afterCommit(
  c: EmailContext,
  db: Db,
  sub: StripeSubscription,
  target: StripeSubscriptionTarget,
  batch: StripeSyncBatch,
  opts: StripeSyncRunOptions,
): Promise<void> {
  const carried = new Set(batch.carried.map((x) => x.productId));
  const byCause = { lapsed: [] as string[], released: [] as string[] };
  for (const e of batch.ended) {
    if (e.productId && !carried.has(e.productId)) byCause[e.cause].push(e.productId);
  }
  const dropped = [...byCause.lapsed, ...byCause.released];

  let names = new Map<string, { slug: string; name: string }>();
  try {
    names = await loadProductNames(db, dropped);
  } catch (error) {
    warn(c, opts.source, 'aeci.stripe.sync.product_read_failed', sub.id, error);
  }
  try {
    if (dropped.length > 0 || batch.verifiedFlipped) {
      await purgeLicenseDrops(c, db, dropped, names, [
        { id: target.vendorId, slug: target.vendorSlug, verified: target.vendorVerified },
      ]);
    }
  } catch (error) {
    warn(c, opts.source, 'aeci.stripe.sync.purge_failed', sub.id, error);
  }

  const fetchSeatEmails = opts.fetchSeatEmails ?? fetchAuthUserEmails;
  try {
    const short = new Set(batch.shortProductIds);
    const notices = (['lapsed', 'released'] as const)
      .filter((cause) => byCause[cause].length > 0)
      .map((cause) => ({
        cause,
        productIds: byCause[cause],
        firstLicenseId: batch.ended.find((e) => e.cause === cause)!.licenseId,
        fewerLicenses:
          short.size > 0 && byCause[cause].every((id) => short.has(id)) && cause === 'lapsed',
      }));
    if (notices.length > 0) {
      const addresses = await billingAddresses(c, db, target, fetchSeatEmails);
      const send = opts.sendEnded ?? noopSendEnded;
      for (const notice of notices) {
        const products = notice.productIds.flatMap((id) => {
          const named = names.get(id);
          return named ? [named] : [];
        });
        if (products.length === 0) continue;
        for (const to of addresses) {
          await send(c, {
            to,
            vendorName: target.vendorName,
            products,
            cause: notice.cause,
            reason: null,
            fewerLicenses: notice.fewerLicenses,
            dedupeKey: `managed-ended:stripe:${sub.id}:${notice.firstLicenseId}:${notice.cause}:${await recipientHash(to)}`,
            entity: { type: 'billing_account', id: target.billingAccountId },
          });
        }
      }
    }
  } catch (error) {
    warn(c, opts.source, 'aeci.stripe.sync.email_failed', sub.id, error);
  }

  // AECI-1596: both cancel routes (the portal, an operator after an email) arrive here
  // as `cancel_at_period_end`, and so does a cancel the webhook missed, from the reconcile.
  if (batch.cancelFlagged.length > 0) {
    try {
      await emailRenewalCancelled(c, db, sub, target, batch, opts, fetchSeatEmails);
    } catch (error) {
      warn(c, opts.source, 'aeci.stripe.sync.email_failed', sub.id, error);
    }
  }

  if (batch.granted.length > 0) {
    await emailLicensesGranted(
      c,
      db,
      {
        grantId: `stripe:${sub.id}:${batch.granted[0]}`,
        vendorId: target.vendorId,
        vendorName: target.vendorName,
        billingAccountId: target.billingAccountId,
        count: batch.granted.length,
        source: 'stripe',
        endsAt: subscriptionEndsAt(sub),
        reference: null,
      },
      fetchSeatEmails,
      opts.sendGranted ?? noopSendGranted,
    );
  }
}

/** `renewal-cancelled`, one email per address per cancel request. */
async function emailRenewalCancelled(
  c: EmailContext,
  db: Db,
  sub: StripeSubscription,
  target: StripeSubscriptionTarget,
  batch: StripeSyncBatch,
  opts: StripeSyncRunOptions,
  fetchSeatEmails: FetchSeatEmails,
): Promise<void> {
  const periodEnd = subscriptionCurrentPeriodEnd(sub);
  // The email's whole point is the date. Without one, say nothing rather than guess.
  if (periodEnd === null) {
    warn(c, opts.source, 'aeci.stripe.sync.renewal_cancelled_no_period_end', sub.id);
    return;
  }
  const send = opts.sendRenewalCancelled ?? noopSendRenewalCancelled;
  // `canceled_at` moves with each cancel request, so a cancel after an undo sends again.
  const cancelRequest = sub.canceled_at ?? periodEnd;
  const addresses = await billingAddresses(c, db, target, fetchSeatEmails);
  for (const to of addresses) {
    await send(c, {
      to,
      vendorName: target.vendorName,
      vendorSlug: target.vendorSlug,
      endDay: toIsoTimestamp(new Date(periodEnd * 1000)).slice(0, 10),
      licenseCount: batch.cancelFlagged.length,
      interval: subscriptionInterval(sub) === 'year' ? 'year' : 'month',
      pastDue: sub.status === 'past_due',
      dedupeKey: `renewal-cancelled:${sub.id}:${cancelRequest}:${await recipientHash(to)}`,
      entity: { type: 'billing_account', id: target.billingAccountId },
    });
  }
}

/**
 * Every unbanned seat and the billing email, each address once (decision 16). Shared
 * with the webhook's `payment-failed` email.
 */
export async function billingAddresses(
  c: EmailContext,
  db: Db,
  target: Pick<StripeSubscriptionTarget, 'vendorId' | 'billingAccountId'>,
  fetchSeatEmails: FetchSeatEmails,
): Promise<string[]> {
  const [seats, billingEmails] = await Promise.all([
    loadVendorSeatRecipients(db, c.env, [target.vendorId], fetchSeatEmails),
    loadBillingEmails(db, [target.billingAccountId]),
  ]);
  return mergeRecipientAddresses(
    (seats.get(target.vendorId) ?? []).map((s) => s.email),
    billingEmails.get(target.billingAccountId),
  );
}

function warn(
  c: EmailContext,
  source: string,
  message: string,
  subscriptionId: string,
  error?: unknown,
): void {
  try {
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'warn',
      message,
      source,
      stripe_subscription_id: subscriptionId,
      ...(error !== undefined
        ? { reason: error instanceof Error ? error.message : String(error) }
        : {}),
    });
  } catch {
    // Telemetry must never change the outcome.
  }
}

// ─── The ban's cancel (AECI-1589) ────────────────────────────────────────────

/** The live Stripe subscriptions a vendor's licenses sit on. */
export function liveStripeSubscriptionIds(vendorLicenses: readonly LicenseBefore[]): string[] {
  return [
    ...new Set(
      vendorLicenses
        .filter((l) => l.endedAt === null && l.stripeSubscriptionId)
        .map((l) => l.stripeSubscriptionId as string),
    ),
  ];
}

/** One subscription the termination's cancel changed or left alone. */
export type BanCancelOutcome = 'cancelled' | 'unchanged' | 'failed';

/**
 * Cancel one subscription now. `unchanged` when Stripe refuses and a re-read shows it is
 * no longer cancellable (it was canceled first, by the vendor or a second request). `failed`
 * when there is no client, or the cancel failed and the subscription may still be live.
 * Never throws.
 */
async function cancelNow(
  stripe: StripeClient | null,
  subscriptionId: string,
): Promise<BanCancelOutcome> {
  if (!stripe) return 'failed';
  try {
    const res = await stripe.cancelSubscriptionNow(subscriptionId);
    if (res.ok) return 'cancelled';
    const again = await stripe.retrieveSubscription(subscriptionId);
    return again.ok && !isStripeSubscriptionCancellable(again.data.status) ? 'unchanged' : 'failed';
  } catch {
    return 'failed';
  }
}

/** A subscription the ban pre-read, or only its id when that read failed. */
export interface BanSubscription {
  id: string;
  /** Stripe's status at the termination's pre-read. Absent: the read failed, so the hook
   *  re-reads before it cancels. */
  status?: StripeSubscriptionStatus;
}

/**
 * The ban's whole Stripe pass gives up after this long (AECI-1589). Each Stripe call has
 * its own 10 s timeout, so three slow calls would hold the `vendor-banned` email for
 * 30 s or more. Past the deadline every subscription not yet settled reports `failed`
 * and the email says it will be cancelled within a day: the ban-dead rule repairs it.
 */
export const BAN_CANCEL_DEADLINE_MS = 15_000;

/** What the termination's Stripe pass is told to clean up. */
export interface BanCancelParams {
  vendorId: string;
  /** The live licenses' subscriptions, as the ban pre-read them. */
  subscriptions: readonly BanSubscription[];
  /**
   * The vendor's billing accounts' Stripe customers. Each one's subscriptions are listed
   * and every cancellable one is cancelled too, live license or not: an `unpaid` one
   * whose licenses lapsed, an `incomplete` first payment. Each one's open Checkout
   * sessions are expired, so none can be paid after the ban.
   */
  customerIds?: readonly string[];
  /** Defaults to {@link BAN_CANCEL_DEADLINE_MS}. */
  deadlineMs?: number;
}

/**
 * After a termination commits (AECI-1589, AECI-1623): cancel each
 * subscription now, with no proration and no final invoice. The set is the pre-read
 * subscriptions plus every subscription listed on the vendor's Stripe customers
 * ({@link BanCancelParams.customerIds}). Every status but `canceled` and
 * `incomplete_expired` is cancelled ({@link isStripeSubscriptionCancellable}), since
 * an `unpaid`, `paused` or `incomplete` one can still be paid. A terminal pre-read
 * status is left alone (`unchanged`). One the pre-read missed is re-read first. Then
 * each customer's open Checkout sessions are expired. A failure warns
 * (`aeci.stripe.ban_cancel_now_failed`, `aeci.stripe.ban_checkout_expire_failed`); the
 * next `subscription.updated` or the daily reconcile cancels a subscription the pass
 * missed (the ban-dead rule: the vendor is terminated and fully banned).
 *
 * The whole pass stops at {@link BanCancelParams.deadlineMs}: a subscription not yet
 * settled reports `failed`, and no further Stripe call starts.
 *
 * Post-commit on purpose. A cancel before the batch, followed by a lost D1 race, would
 * let Stripe's `deleted` event end the licenses `lapsed` with a `managed-ended` email,
 * which is the wrong story. Sequential, one call at a time (a Worker holds about six
 * connections; the client discards every unread body). Never throws. Run it in
 * `waitUntil`. Returns one outcome per subscription, pre-read ones first.
 */
export async function stripeBanCancelNowHook(
  c: EmailContext,
  stripe: StripeClient | null,
  p: BanCancelParams,
): Promise<BanCancelOutcome[]> {
  const subs: BanSubscription[] = [...p.subscriptions];
  const outcomes: (BanCancelOutcome | undefined)[] = [];
  let stopped = false;
  const banWarn = (message: string, fields: Record<string, unknown>) => {
    try {
      logToPosthog(c.executionCtx, c.env, c.req.raw, {
        level: 'warn',
        message,
        source: 'stripe-ban-cancel',
        vendor_id: p.vendorId,
        ...fields,
      });
    } catch {
      // Telemetry must never change the outcome.
    }
  };

  const work = async () => {
    const customers = [...new Set(p.customerIds ?? [])];
    // 1. Every subscription on the vendor's Stripe customers, not only those a live
    // license sits on.
    for (const customer of customers) {
      if (stopped || !stripe) break;
      try {
        // One page of 100: far more than one account ever holds.
        const listed = await stripe.listSubscriptions({ customer, maxPages: 1 });
        if (!listed.ok) {
          banWarn('aeci.stripe.ban_cancel_now_failed', {
            stripe_customer_id: customer,
            reason: `list ${listed.reason} ${listed.status}`,
          });
          continue;
        }
        for (const sub of listed.data.subscriptions) {
          if (
            isStripeSubscriptionCancellable(sub.status) &&
            !subs.some((known) => known.id === sub.id)
          ) {
            subs.push({ id: sub.id, status: sub.status });
          }
        }
      } catch (error) {
        banWarn('aeci.stripe.ban_cancel_now_failed', {
          stripe_customer_id: customer,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 2. The cancels.
    for (let i = 0; i < subs.length; i++) {
      if (stopped) break;
      const sub = subs[i]!;
      let status = sub.status;
      let failure: string | null = null;
      try {
        if (status === undefined && stripe) {
          const read = await stripe.retrieveSubscription(sub.id);
          if (read.ok) status = read.data.status;
        }
        if (status !== undefined && !isStripeSubscriptionCancellable(status)) {
          outcomes[i] = 'unchanged';
          continue;
        }
        const outcome = await cancelNow(stripe, sub.id);
        outcomes[i] = outcome;
        if (outcome === 'failed') failure = stripe ? 'cancel failed' : 'no Stripe client';
      } catch (error) {
        outcomes[i] = 'failed';
        failure = error instanceof Error ? error.message : String(error);
      }
      if (failure !== null) {
        banWarn('aeci.stripe.ban_cancel_now_failed', {
          stripe_subscription_id: sub.id,
          reason: failure,
        });
      }
    }

    // 3. An open Checkout page stays payable for 24 h. Expire it, so the banned vendor
    // cannot start a new subscription. A failure warns: a subscription it creates reads
    // ban-dead and is cancelled by the next sync.
    for (const customer of customers) {
      if (stopped || !stripe) break;
      try {
        const open = await stripe.listOpenCheckoutSessions(customer);
        if (!open.ok) {
          banWarn('aeci.stripe.ban_checkout_expire_failed', {
            stripe_customer_id: customer,
            reason: `list ${open.reason} ${open.status}`,
          });
          continue;
        }
        for (const session of open.data) {
          if (stopped) break;
          const expired = await stripe.expireCheckoutSession(
            session.id,
            `aeci-ban-expire-${session.id}`,
          );
          if (!expired.ok) {
            banWarn('aeci.stripe.ban_checkout_expire_failed', {
              stripe_customer_id: customer,
              stripe_checkout_session_id: session.id,
              reason: `${expired.reason} ${expired.status}`,
            });
          }
        }
      } catch (error) {
        banWarn('aeci.stripe.ban_checkout_expire_failed', {
          stripe_customer_id: customer,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const deadlineMs = p.deadlineMs ?? BAN_CANCEL_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), deadlineMs);
  });
  const finished = await Promise.race([
    work().then(
      () => 'done' as const,
      () => 'done' as const,
    ),
    deadline,
  ]);
  clearTimeout(timer);
  if (finished === 'deadline') {
    stopped = true;
    const unsettled = subs.filter((_, i) => outcomes[i] === undefined).map((s) => s.id);
    banWarn('aeci.stripe.ban_cancel_now_failed', {
      reason: `deadline ${deadlineMs} ms`,
      stripe_subscription_ids: unsettled,
    });
  }
  return subs.map((_, i) => outcomes[i] ?? 'failed');
}

/** The Stripe client a caller uses, injected so specs never reach Stripe. */
export type StripeClientFor = (env: Env) => StripeClient | null;
