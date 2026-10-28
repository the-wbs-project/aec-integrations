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
 * forward, one cache purge, and the `managed-ended` and `licenses-granted` emails.
 * A caller can put statements FIRST in that batch (`prefix`): the webhook's
 * `stripe_events` ledger INSERT, the checkout acceptance and the customer link.
 *
 * ── THE BAN HOOK (M1) ───────────────────────────────────────────────────────────
 * {@link stripeBanCancelHook}: the ban of a vendor's last unbanned seat sets
 * `cancel_at_period_end` on its live Stripe subscriptions, marked
 * `metadata.aeci_ban_cancel = "true"`, and the unban clears only a cancel that marker
 * says the ban set. Post-commit, best-effort: a failure warns, and the reconcile
 * catches it.
 */

import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { LEGAL_AGREEMENT_CURRENT_VERSIONS } from '@aeci/shared';
import { licensePlanSnapshot, type VendorPlanSnapshot } from '@aeci/shared/entitlements';
import { and, eq } from 'drizzle-orm';

import type { Db } from '../db/client';
import { billingAccounts, vendors } from '../db/schema';
import type { Env } from '../env';
import { logToPosthog } from '../posthog';
import { emailLicensesGranted, type SendLicensesGranted } from '../routes/admin-licenses';
import { auditInsert, type BatchStmt, type BatchTuple } from './audit';
import { loadBillingEmails, mergeRecipientAddresses } from './billing-recipients';
import type { EmailContext, sendManagedEndedEmail } from './email';
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
  type StripeClient,
  type StripeSubscription,
  type StripeSubscriptionStatus,
} from './stripe';
import { fetchAuthUserEmails } from './supabase-admin';
import { uuidv5 } from './uuidv5';
import { loadVendorSeatRecipients, type FetchSeatEmails } from './vendor-seat-recipients';

/** The Stripe sync is the system's write: no admin and no vendor acts. */
const STRIPE_ACTOR = { actorId: null, actorType: 'system' } as const;

/**
 * The namespace every Stripe license id is minted under:
 * `uuidv5('https://aecintegrations.com/stripe/licenses', URL_NAMESPACE)`. Pinned as a
 * literal so a refactor cannot re-mint the ids. `stripe-licenses.spec.ts` re-derives it.
 */
export const STRIPE_LICENSE_NAMESPACE = '253c3f87-443e-58be-b20a-9dd3076536bf';

/** The subscription metadata key the ban hook marks its own cancel with. */
export const BAN_CANCEL_METADATA_KEY = 'aeci_ban_cancel';

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
   *  agreement version to every license kept (ruling R1). */
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
 * The batch for one subscription (P0 of the epic plan). Pure: the caller pre-reads.
 * `null` when the status changes nothing (`incomplete`, `paused`). A cancel the ban
 * hook set (`metadata.aeci_ban_cancel`) is the ban's, already on the licenses as
 * `vendor-banned`, so the sync leaves the cancel flags alone while that marker stands.
 */
export function syncSubscriptionLicensesStatements(
  db: Db,
  sub: StripeSubscription,
  ctx: SubscriptionSyncContext,
): StripeSyncBatch | null {
  const mode = stripeSyncMode(sub.status);
  if (mode === null) return null;
  const banCancel = sub.metadata?.[BAN_CANCEL_METADATA_KEY] === 'true';
  const current = LEGAL_AGREEMENT_CURRENT_VERSIONS.managed_plan;
  const metadataVersion = sub.metadata?.terms_version?.trim() || null;
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
    endsAt: subscriptionEndsAt(sub),
    termsVersion: ctx.renewal ? current : metadataVersion,
    ...(ctx.renewal ? { renewalTermsVersion: current } : {}),
    // While the ban's marker stands, the cancel is the ban's: leave every flag alone.
    cancelAtPeriodEnd: banCancel ? null : sub.cancel_at_period_end,
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
  | 'skipped';

/** Statements to put FIRST in the sync's batch, and their audit rows. */
export interface SyncPrefix {
  stmts: BatchStmt[];
  audits: AuditLogEntry[];
}

export type SendManagedEnded = typeof sendManagedEndedEmail;

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

/** A grant that lost a race to an identical one: the minted ids already exist. */
export function isStripeLicenseIdConflict(error: unknown): boolean {
  return causeMatches(error, /UNIQUE constraint failed: licenses\.id/i);
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
    const [vendorLicenses, vendorRow] = await Promise.all([
      loadVendorLicenses(db, target.vendorId),
      db.query.vendors.findFirst({
        columns: { verified: true },
        where: eq(vendors.id, target.vendorId),
      }),
    ]);
    const wasVerified = vendorRow?.verified ?? false;
    const fromOrdinal = vendorLicenses.filter((l) => l.stripeSubscriptionId === sub.id).length;
    const grantLicenseIds = await stripeLicenseIds(
      sub.id,
      fromOrdinal,
      grantDelta(sub, vendorLicenses),
    );
    // The carry-over pre-check reads only when something can end.
    const mode = stripeSyncMode(sub.status);
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

    const stmts: BatchStmt[] = [
      ...prefix.stmts,
      ...(batch && batch.stmts.length > 0 ? withRaceSentinels(db, batch) : []),
      ...(remainsGuard ? [remainsGuard] : []),
      ...(reroute?.stmts ?? []),
      ...(reroute?.audits ?? []).map((entry) => auditInsert(db, entry)),
    ];
    if (stmts.length === 0) break;
    try {
      await db.batch(stmts as BatchTuple);
      break;
    } catch (error) {
      // The license, contest and live-license sentinels raise the same malformed-JSON
      // abort, and a grant that lost to an identical one trips `licenses.id`. Both
      // re-plan from a fresh read once. Anything else (a replayed ledger row) throws.
      const raced = isReleaseRaceError(error) || isStripeLicenseIdConflict(error);
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

// ─── The ban hook (M1) ───────────────────────────────────────────────────────

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

/** One subscription the hook changed or left alone, for the caller's log and specs. */
export type BanHookOutcome = 'set' | 'cleared' | 'unchanged' | 'failed';

/**
 * M1 of the epic's plan check. `ban: true`, after the ban of a vendor's last unbanned
 * seat commits: set `cancel_at_period_end` on each live subscription, with
 * `metadata.aeci_ban_cancel = "true"`. A subscription already set to cancel (the
 * owner's own cancel) keeps it and gets no marker, so the unban cannot undo the
 * owner's choice. `ban: false`, after the unban: clear it only where the marker says
 * the ban set it, and drop the marker.
 *
 * Sequential, one subscription at a time (a Worker holds about six connections; the
 * client discards every unread body). Never throws: a failure warns, and the daily
 * reconcile (E9.5) catches what was missed. Run it in `waitUntil`.
 */
export async function stripeBanCancelHook(
  c: EmailContext,
  stripe: StripeClient | null,
  p: { vendorId: string; subscriptionIds: readonly string[]; ban: boolean; now: string },
): Promise<BanHookOutcome[]> {
  const outcomes: BanHookOutcome[] = [];
  if (!stripe || p.subscriptionIds.length === 0) return outcomes;
  for (const id of p.subscriptionIds) {
    try {
      const sub = await stripe.retrieveSubscription(id);
      if (!sub.ok) throw new Error(`retrieve ${sub.reason} ${sub.status}`);
      if (stripeSyncMode(sub.data.status) !== 'live') {
        outcomes.push('unchanged');
        continue;
      }
      const marked = sub.data.metadata?.[BAN_CANCEL_METADATA_KEY] === 'true';
      if (p.ban ? sub.data.cancel_at_period_end : !marked) {
        outcomes.push('unchanged');
        continue;
      }
      const updated = await stripe.updateSubscription(
        id,
        p.ban
          ? { cancel_at_period_end: true, metadata: { [BAN_CANCEL_METADATA_KEY]: 'true' } }
          : { cancel_at_period_end: false, metadata: { [BAN_CANCEL_METADATA_KEY]: '' } },
        `aeci-${p.ban ? 'ban' : 'unban'}-${id}-${p.now}`,
      );
      if (!updated.ok) throw new Error(`update ${updated.reason} ${updated.status}`);
      outcomes.push(p.ban ? 'set' : 'cleared');
    } catch (error) {
      outcomes.push('failed');
      warn(c, 'stripe-ban-hook', 'aeci.stripe.ban_hook_failed', id, error);
    }
  }
  return outcomes;
}

/** The Stripe client a caller uses, injected so specs never reach Stripe. */
export type StripeClientFor = (env: Env) => StripeClient | null;
