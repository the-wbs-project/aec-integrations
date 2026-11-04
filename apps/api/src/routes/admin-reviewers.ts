/**
 * Reviewer ban-management API (AECI-218 / Phase 6.11) — Drizzle/D1 (ADR 0016 /
 * AECI-253, AECI-254).
 *
 *   GET   /api/admin/reviewers      — the currently-banned reviewers, paginated.
 *   PATCH /api/admin/reviewers/:id  — ban / unban a reviewer (a `profiles` row).
 *
 * Mirrors `admin-reviews`: a preload-gate then one atomic `db.batch` (guarded
 * `UPDATE … WHERE` + audit + the lean workflow history). The `reviewer_ban`
 * workflow is REVERSIBLE, so it only toggles `current_state` (`active ↔ banned`)
 * — never `completed_at`/`final_outcome`. `reviewer_email` comes from the GoTrue
 * Admin API (seam #2). Admins (and the acting admin) can't be banned here.
 *
 * AECI-524 (Stage 2 moderation escalation, `STAGE_2_VENDOR_PORTAL_SPEC.md` §7):
 * the ban mechanism is role-agnostic, so this same action bans a `vendor_admin`
 * SEAT (a `profiles` row) — a banned seat then fails every `/api/vendor/*` call
 * via the §4 guard's per-request ban check. The audit action + `aeci.moderation.ban`
 * metric are role-aware (`vendor_admin.banned` vs `reviewer.banned`). A ban that
 * leaves the vendor another unbanned seat touches that one `profiles` row only.
 *
 * ── THE LAST-SEAT BAN ENDS EVERYTHING (AECI-1589, ruled 2026-11-03) ──────────────
 * "Ban a vendor" is the ban of its last unbanned seat (`VENDOR_SIGNUP_PROCESS.md` §2
 * decision 15). In ONE batch it also:
 *  - returns the vendor's records to AECi as ADR 0042's return does, although the
 *    banned seat remains: `vendors.owned_at = NULL`, the markers back to `aeci`, the
 *    claimed integrations and pairs un-claimed, every open owner contest to AECi
 *    UNSTAMPED (`planVendorHandback`), and the open product proposals deleted;
 *  - revokes every pending seat invite;
 *  - ends every live license now, `end_reason = 'banned'`. A row keeps `ends_at` as the
 *    paid term end; a monthly Stripe row takes Stripe's `current_period_end`, read
 *    before the batch, or stays NULL (`paid_term_end_source: 'unknown'`) when Stripe
 *    cannot be read. The ban goes ahead either way;
 *  - writes one `vendor.records_returned` row with `cause: 'vendor-banned'`.
 * After commit: the ownership message to the review app, then one cache purge in its
 * own `waitUntil`, then ONE `waitUntil` chain: every subscription Stripe can still bill
 * on the vendor's Stripe customers is cancelled now with no refund, and their open
 * Checkout sessions expired (`stripeBanCancelNowHook`, which gives up after 15 s), then
 * one `vendor-banned` email to every seat, banned ones included, and the billing email.
 * The email states each cancel's real outcome. No `managed-ended` is sent.
 *
 * The unban lifts the seat ban and re-stamps `owned_at` when the ban cleared it. It
 * grants no license: the operator grants complimentary licenses for the ban term from
 * the vendor's Billing section. The contests the ban moved stay with AECi, because they
 * went unstamped. It still clears any legacy `vendor-banned` license flags.
 */

import {
  ApiErrorCode,
  BanReviewerResponseSchema,
  BanReviewerSchema,
  ListBannedReviewersQuerySchema,
  ListBannedReviewersResponseSchema,
  type BanReviewerResponse,
  type BannedReviewer,
  type ListBannedReviewersResponse,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { mapWithConcurrency, WORKER_CONNECTION_LIMIT } from '@aeci/shared/concurrency';
import { licensePlanSnapshot } from '@aeci/shared/entitlements';
import type { WorkflowTransitionEntry } from '@aeci/shared/workflow-transition';
import { and, asc, count, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { getDb, type Db } from '../db/client';
import {
  billingAccounts,
  productProposals,
  profiles,
  vendorSeatInvites,
  vendors,
  workflowInstances,
} from '../db/schema';
import { forwardAuditBatch } from '../lib/moderation-forward';
import { logToPosthog, submitCount } from '../posthog';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import {
  auditInsert,
  workflowTransitionInsert,
  type BatchStmt,
  type BatchTuple,
} from '../lib/audit';
import { mergeRecipientAddresses } from '../lib/billing-recipients';
import { stampOwnershipStatement } from '../lib/claimed-vendors';
import { sendVendorBannedEmail } from '../lib/email';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { recipientHash } from '../lib/hash';
import {
  clearVendorBannedFlagsStatements,
  endLicensesStatements,
  loadOwnedProductLicenseState,
  loadVendorLicenses,
  noLiveLicenseSentinel,
  toIsoTimestamp,
  type LicenseBatch,
  type LicenseBefore,
} from '../lib/license';
import { loadProductNames, purgeLicenseDrops, withRaceSentinels } from '../lib/license-lapse';
import { dispatchOwnershipSync } from '../lib/ownership-sync';
import {
  loadOpenProposalIds,
  openProposalsFor,
  openProposalsUnchangedSentinel,
} from '../lib/product-proposals';
import { stripeClientFromEnv, subscriptionCurrentPeriodEnd } from '../lib/stripe';
import {
  liveStripeSubscriptionIds,
  stripeBanCancelNowHook,
  type BanCancelOutcome,
  type BanSubscription,
  type StripeClientFor,
} from '../lib/stripe-licenses';
import { fetchAuthUserEmails } from '../lib/supabase-admin';
import {
  isSeatsChangedError,
  pendingInviteRaceSentinel,
  planOwnerSeatReturn,
  planVendorHandback,
  RECORDS_RETURNED_ACTION,
  seatLossOutcome,
  seatRaceSentinels,
  seatsChangedError,
  type HandbackBatch,
  type VendorReturnBatch,
} from '../lib/vendor-handback';
import { liveInvitesFor, revokeInviteStatements } from '../lib/vendor-seat-invites';
import { loadVendorSeatRecipients, type FetchSeatEmails } from '../lib/vendor-seat-recipients';
import type { FetchReviewerEmails } from './admin-reviews';
import { NO_VENDOR_STAMP, vendorAuditStamp } from '../lib/audit-vendor';

type AdminContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function parseJsonBody<T>(c: AdminContext, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
  }
  return schema.parse(raw);
}

function emitBanAction(
  c: AdminContext,
  action: 'ban' | 'unban',
  role: 'reviewer' | 'vendor_admin',
  outcome: 'ok' | 'invalid_state' | 'forbidden',
): void {
  submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.moderation.ban', 1, [
    `action:${action}`,
    `role:${role}`,
    `outcome:${outcome}`,
  ]);
}

// ─── GET /api/admin/reviewers ──────────────────────────────────────────────────

export function createBannedReviewersListHandler(
  dbFor: DbFactory = getDb,
  fetchEmails: FetchReviewerEmails = fetchAuthUserEmails,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const query = ListBannedReviewersQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );

    const { db } = dbFor(c.env);
    const where = isNotNull(profiles.bannedAt);

    const [rows, countRows] = await Promise.all([
      db.query.profiles.findMany({
        columns: { id: true, bannedAt: true, banReason: true },
        where,
        orderBy: [desc(profiles.bannedAt), asc(profiles.id)],
        limit: query.perPage,
        offset: (query.page - 1) * query.perPage,
      }),
      db.select({ value: count() }).from(profiles).where(where),
    ]);

    const emailByReviewerId = await fetchEmails(
      c.env,
      rows.map((row) => row.id),
    );

    const body: ListBannedReviewersResponse = {
      data: rows.map(
        (row): BannedReviewer => ({
          reviewer_id: row.id,
          reviewer_email: emailByReviewerId.get(row.id) ?? null,
          banned_at: row.bannedAt ?? '',
          ban_reason: row.banReason,
        }),
      ),
      page: query.page,
      perPage: query.perPage,
      total: countRows[0]?.value ?? 0,
    };

    validateResponseInDev(c.env, () => {
      ListBannedReviewersResponseSchema.parse(body);
    });

    return json(body);
  };
}

// ─── PATCH /api/admin/reviewers/:id ────────────────────────────────────────────

/** `metadata.cause` on the last-seat ban's `vendor.records_returned` row (AECI-1589). */
export const VENDOR_BANNED_CAUSE = 'vendor-banned';

/** The `vendor-banned` sender, injected so specs record sends. */
export type SendVendorBanned = typeof sendVendorBannedEmail;

/** What the last-seat ban read before its batch, kept for the post-commit work. */
interface LastSeatBan {
  vendor: { id: string; slug: string; companyName: string; verified: boolean };
  /** The live licenses the batch ends. */
  ending: LicenseBefore[];
  handback: VendorReturnBatch;
  /** The live Stripe subscriptions, with their pre-read status when Stripe answered. */
  subscriptions: BanSubscription[];
  /** The vendor's billing accounts' Stripe customers: the hook cancels every
   *  subscription on them and expires their open Checkout sessions. */
  stripeCustomerIds: string[];
  openProposalIds: string[];
}

/**
 * The paid term end of each live license with no `ends_at` on a live Stripe
 * subscription, read from Stripe before the batch (AECI-1589 ruling 3). A null client
 * or a failed read leaves those licenses out (`paid_term_end_source: 'unknown'`) and
 * warns; the ban goes ahead. Bounded fan-out; the client discards unread bodies.
 */
async function readBanTermEnds(
  c: AdminContext,
  stripeFor: StripeClientFor,
  vendorId: string,
  live: readonly LicenseBefore[],
): Promise<{ termEndById: Map<string, string>; subscriptions: BanSubscription[] }> {
  const ids = liveStripeSubscriptionIds(live);
  const termEndById = new Map<string, string>();
  const subscriptions: BanSubscription[] = ids.map((id) => ({ id }));
  if (ids.length === 0) return { termEndById, subscriptions };
  const stripe = stripeFor(c.env);
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

/** Every Stripe customer the vendor's billing accounts carry. */
async function loadVendorStripeCustomerIds(db: Db, vendorId: string): Promise<string[]> {
  const rows = await db
    .select({ customerId: billingAccounts.stripeCustomerId })
    .from(billingAccounts)
    .where(
      and(eq(billingAccounts.vendorId, vendorId), isNotNull(billingAccounts.stripeCustomerId)),
    );
  return [...new Set(rows.flatMap((r) => (r.customerId ? [r.customerId] : [])))];
}

/** Every billing email the vendor's accounts carry. */
async function loadVendorBillingEmails(db: Db, vendorId: string): Promise<string[]> {
  const rows = await db
    .select({ billingEmail: billingAccounts.billingEmail })
    .from(billingAccounts)
    .where(eq(billingAccounts.vendorId, vendorId));
  return rows.flatMap((r) => (r.billingEmail ? [r.billingEmail] : []));
}

export function createBanReviewerHandler(
  dbFor: DbFactory = getDb,
  stripeFor: StripeClientFor = (env) => stripeClientFromEnv(env),
  fetchSeatEmails: FetchSeatEmails = fetchAuthUserEmails,
  sendBanned: SendVendorBanned = sendVendorBannedEmail,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const { userId } = session;

    const id = c.req.param('id');
    if (!id) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing reviewer id', { field: 'id' });
    }

    const payload = await parseJsonBody(c, BanReviewerSchema);
    const ban = payload.action === 'ban';
    const { db } = writeDb(c, dbFor);

    const existing = await db.query.profiles.findFirst({
      columns: { id: true, role: true, vendorId: true, bannedAt: true, banReason: true },
      where: eq(profiles.id, id),
    });
    if (!existing) throw notFoundError('profile', { id });

    // The moderated seat's role drives the audit action + metric so a
    // `vendor_admin` ban is recorded as `vendor_admin.banned`, not
    // `reviewer.banned` (AECI-524 / STAGE_2_VENDOR_PORTAL_SPEC.md §7). The ban
    // MECHANISM is role-agnostic — this endpoint bans any non-admin `profiles`
    // row (the guardrail below only blocks admins + self); only the labeling is
    // role-aware.
    const seatRole = existing.role === 'vendor_admin' ? 'vendor_admin' : 'reviewer';

    // Guardrail: never ban an admin or the acting admin themselves.
    if (ban && (existing.role === 'admin' || id === userId)) {
      emitBanAction(c, payload.action, seatRole, 'forbidden');
      throw new ApiError(
        403,
        ApiErrorCode.FORBIDDEN,
        id === userId ? 'You cannot ban yourself.' : 'Admin accounts cannot be banned.',
      );
    }

    // Toggle guard (preload): ban needs an un-banned target; unban a banned one.
    const alreadyInTargetState = ban ? existing.bannedAt !== null : existing.bannedAt === null;
    if (alreadyInTargetState) {
      emitBanAction(c, payload.action, seatRole, 'invalid_state');
      throw new ApiError(
        422,
        ApiErrorCode.INVALID_STATE_TRANSITION,
        ban ? 'Reviewer is already banned.' : 'Reviewer is not banned.',
      );
    }

    const reason = ban ? (payload.reason as string).trim() : null;
    const now = new Date().toISOString();
    const bannedAt = ban ? now : null;
    const fromState = ban ? 'active' : 'banned';
    const toState = ban ? 'banned' : 'active';
    const actor = { actorId: userId, actorType: auditActorType(session) };

    const existingWf = await db.query.workflowInstances.findFirst({
      columns: { id: true },
      where: and(
        eq(workflowInstances.workflowType, 'reviewer_ban'),
        eq(workflowInstances.entityId, id),
      ),
    });
    const workflowId = existingWf?.id ?? crypto.randomUUID();

    // AECI-1192 / AECI-1193: a vendor seat's ban is about the vendor the seat is on,
    // so the row carries that vendor and its plan. A reviewer's ban carries neither.
    const seatVendorId = seatRole === 'vendor_admin' ? existing.vendorId : null;
    const stamp = seatVendorId ? await vendorAuditStamp(db, seatVendorId) : NO_VENDOR_STAMP;
    const handbackParams = seatVendorId
      ? {
          vendorId: seatVendorId,
          ...actor,
          now,
          source: 'admin-moderation',
          // The ban row's own stamp already read the plan. `sealed()` reuses it.
          ...(stamp.vendorPlan ? { vendorPlan: stamp.vendorPlan } : {}),
        }
      : null;

    // What the ban leaves: the target stays a (banned) profile, so any outcome but
    // `none` means no unbanned seat is left: the last-seat ban.
    const planned = !handbackParams
      ? null
      : ban
        ? (await seatLossOutcome(db, handbackParams.vendorId, id)) === 'none'
          ? ('none' as const)
          : ('lapse' as const)
        : null;

    // AECI-1589 (ruling 1): the unban re-stamps ownership the ban cleared.
    const ownedAtBefore = handbackParams
      ? ((
          await db.query.vendors.findFirst({
            columns: { ownedAt: true },
            where: eq(vendors.id, handbackParams.vendorId),
          })
        )?.ownedAt ?? null)
      : null;
    const ownershipStamped = Boolean(handbackParams && !ban && ownedAtBefore === null);

    const metadata = {
      source: 'admin-moderation',
      ...(reason ? { reason } : {}),
      ...(ownershipStamped ? { ownership_stamped: true } : {}),
    };
    const auditEntry: AuditLogEntry = {
      ...actor,
      action: ban ? `${seatRole}.banned` : `${seatRole}.unbanned`,
      entityType: 'profile',
      entityId: id,
      ...stamp,
      beforeState: { banned_at: existing.bannedAt ?? null, ban_reason: existing.banReason },
      afterState: { banned_at: bannedAt, ban_reason: reason },
      metadata,
    };
    const workflowEntry: WorkflowTransitionEntry = {
      workflowId,
      fromState,
      toState,
      actorId: userId,
      reason,
      metadata,
    };

    // The guarded update (`WHERE banned_at IS [NOT] NULL`) makes the toggle safe
    // under a concurrent action; audit + workflow are atomic with it.
    const stmts: BatchStmt[] = [
      db
        .update(profiles)
        .set({ bannedAt, banReason: reason })
        .where(
          and(eq(profiles.id, id), ban ? isNull(profiles.bannedAt) : isNotNull(profiles.bannedAt)),
        ),
      // Straight after the profile UPDATE: a lost race rolls the batch back whole.
      ...(handbackParams ? seatRaceSentinels(db, handbackParams.vendorId, planned) : []),
      auditInsert(db, auditEntry),
      existingWf
        ? db
            .update(workflowInstances)
            .set({ currentState: toState })
            .where(eq(workflowInstances.id, workflowId))
        : db.insert(workflowInstances).values({
            id: workflowId,
            workflowType: 'reviewer_ban',
            entityId: id,
            currentState: toState,
          }),
      workflowTransitionInsert(db, workflowEntry),
    ];

    const extraAudits: AuditLogEntry[] = [];
    const extraTransitions: WorkflowTransitionEntry[] = [];
    let lastSeat: LastSeatBan | null = null;

    if (handbackParams && !ban) {
      // The unban: stamped contests come back (`planOwnerSeatReturn`). The ban's moved
      // none of those: they went unstamped and stay with AECi (ruling 6).
      const follow: HandbackBatch = await planOwnerSeatReturn(db, handbackParams);
      stmts.push(...follow.stmts);
      extraAudits.push(...follow.audits);
      extraTransitions.push(...follow.transitions);
      if (ownershipStamped) stmts.push(stampOwnershipStatement(db, handbackParams.vendorId, now));
      // Legacy `vendor-banned` flags written before AECI-1589. No ban writes them now.
      const flags: LicenseBatch = await clearVendorBannedFlagsStatements(db, {
        vendorId: handbackParams.vendorId,
        now,
        ...actor,
        source: 'admin-moderation',
        extraMetadata: { seat_user_id: id },
      });
      stmts.push(...flags.stmts);
      extraAudits.push(...flags.auditEntries);
    } else if (handbackParams && planned === 'lapse') {
      const vendorId = handbackParams.vendorId;
      const [vendorLicenses, vendorRow, liveInviteRows, openProposalIds, stripeCustomerIds] =
        await Promise.all([
          loadVendorLicenses(db, vendorId),
          db.query.vendors.findFirst({
            columns: { id: true, slug: true, companyName: true, verified: true },
            where: eq(vendors.id, vendorId),
          }),
          db
            .select({ id: vendorSeatInvites.id, email: vendorSeatInvites.email })
            .from(vendorSeatInvites)
            .where(liveInvitesFor(vendorId, now)),
          loadOpenProposalIds(db, vendorId),
          loadVendorStripeCustomerIds(db, vendorId),
        ]);
      if (!vendorRow) throw notFoundError('vendor', { id: vendorId });
      const vendorPlan = stamp.vendorPlan ?? licensePlanSnapshot(vendorLicenses, now);
      // The return instead of the seat lapse: the handback already moves every open
      // owner contest to AECi, so running both would write each row twice.
      const handback = await planVendorHandback(db, handbackParams);
      const ending = vendorLicenses.filter((l) => l.endedAt === null);
      const { termEndById, subscriptions } = await readBanTermEnds(c, stripeFor, vendorId, ending);

      // The same ban revokes every pending invite, one audit row each (ruled
      // 2026-10-16): a pre-ban invite must not mint an unbanned seat on a banned vendor.
      const invitePlan = licensePlanSnapshot(vendorLicenses, now);
      const inviteRevokes = liveInviteRows.map((invite) =>
        revokeInviteStatements(db, {
          vendorPlan: invitePlan,
          inviteId: invite.id,
          vendorId,
          email: invite.email,
          ...actor,
          now,
          source: 'admin-moderation',
          extraMetadata: { reason: VENDOR_BANNED_CAUSE, seat_user_id: id },
        }),
      );

      const licenseBatch = endLicensesStatements(db, {
        vendorId,
        now,
        ...actor,
        vendorLicenses,
        vendorWasVerified: vendorRow.verified,
        source: 'admin-moderation',
        extraMetadata: { seat_user_id: id },
        target: { licenseIds: ending.map((l) => l.id) },
        endReason: 'banned',
        termEndById,
      });

      const { returned } = handback;
      const returnEntry: AuditLogEntry = {
        ...actor,
        action: RECORDS_RETURNED_ACTION,
        vendorId,
        vendorPlan,
        entityType: 'vendor',
        entityId: vendorId,
        beforeState: { owned_at: ownedAtBefore },
        afterState: { owned_at: null },
        metadata: {
          source: 'admin-moderation',
          cause: VENDOR_BANNED_CAUSE,
          vendorId,
          seat_user_id: id,
          product_count: returned.productIds.length,
          integration_count: returned.integrationIds.length,
          evidenced_pair_count: returned.evidencedPairIds.length,
          contests_rerouted: returned.contestsRerouted,
          invites_revoked: liveInviteRows.length,
          proposals_discarded: openProposalIds.length,
          discarded_proposal_ids: openProposalIds,
          licenses_ended: ending.length,
          stripe_subscriptions: subscriptions.map((s) => s.id),
        },
      };

      stmts.push(
        // Ruling 1: the ban returns the records although the banned seat remains.
        // `updated_at` is kept, as `stampOwnershipStatement` keeps it.
        ...(ownedAtBefore !== null
          ? [
              db
                .update(vendors)
                .set({ ownedAt: null })
                .where(and(eq(vendors.id, vendorId), isNotNull(vendors.ownedAt))),
            ]
          : []),
        ...inviteRevokes.flatMap((r) => r.stmts),
        // An invite created between the read above and this batch would survive the ban.
        pendingInviteRaceSentinel(db, vendorId, now),
        ...handback.stmts,
        // The open proposals go with the ownership (AECI-1416). Decided ones stay.
        openProposalsUnchangedSentinel(db, vendorId, openProposalIds.length),
        db.delete(productProposals).where(openProposalsFor(vendorId)),
        // A `changedOneRowSentinel` after each license UPDATE: a lapse or a Stripe
        // `deleted` that ended one after the read leaves its guarded UPDATE matching no
        // row, and the batch aborts (409) rather than write a `license.banned` row for it.
        ...withRaceSentinels(db, licenseBatch),
        // A grant that committed after the read would leave a live license on a banned
        // vendor: abort, and the route answers 409.
        noLiveLicenseSentinel(db, vendorId),
        auditInsert(db, returnEntry),
      );
      extraAudits.push(
        ...inviteRevokes.map((r) => r.auditEntry),
        ...handback.audits,
        ...licenseBatch.auditEntries,
        returnEntry,
      );
      extraTransitions.push(...handback.transitions);
      lastSeat = {
        vendor: vendorRow,
        ending,
        handback,
        subscriptions,
        stripeCustomerIds,
        openProposalIds,
      };
    }

    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      if (isSeatsChangedError(error)) {
        // Every sentinel raises the same error. Re-read the one that is not about
        // seats, as the admin return does. The batch rolled back, so this is current.
        if (lastSeat) {
          const current = await loadOpenProposalIds(db, lastSeat.vendor.id);
          if (current.join() !== lastSeat.openProposalIds.join()) {
            throw new ApiError(
              409,
              ApiErrorCode.VENDOR_PROPOSALS_CHANGED,
              'A new product proposal for this vendor arrived while the request ran, so nothing was saved. Reload and try again.',
            );
          }
        }
        throw seatsChangedError();
      }
      throw error;
    }

    emitBanAction(c, payload.action, seatRole, 'ok');
    // ONE batched forward: a vendor seat's ban or unban adds rows per contest, license,
    // invite and returned record.
    forwardAuditBatch(c, [auditEntry, ...extraAudits], [workflowEntry, ...extraTransitions]);

    if (handbackParams && ownershipStamped) {
      // AECI-1418: the review app learns the vendor owns its records again.
      dispatchOwnershipSync(c, handbackParams.vendorId, 'seat_provisioned');
    }
    if (lastSeat) {
      const done = lastSeat;
      // AECI-1418: the review app learns the records are AECi's again.
      dispatchOwnershipSync(c, done.vendor.id, 'records_returned');
      // The purge goes first, in its own waitUntil: a hung Stripe must not hold it.
      const purged = purgeAfterLastSeatBan(c, db, done);
      c.executionCtx.waitUntil(purged);
      // Then the cancel, and the email after it, so the email states what the cancel
      // actually did. The hook never throws and gives up after BAN_CANCEL_DEADLINE_MS.
      c.executionCtx.waitUntil(
        (async () => {
          const outcomes =
            done.subscriptions.length > 0 || done.stripeCustomerIds.length > 0
              ? await stripeBanCancelNowHook(c, stripeFor(c.env), {
                  vendorId: done.vendor.id,
                  subscriptions: done.subscriptions,
                  customerIds: done.stripeCustomerIds,
                })
              : [];
          await emailAfterLastSeatBan(
            c,
            db,
            done,
            now,
            await purged,
            outcomes,
            fetchSeatEmails,
            sendBanned,
          );
        })().catch((error: unknown) =>
          warnBan(c, 'aeci.moderation.ban_followup_failed', done.vendor.id, error),
        ),
      );
    }

    const body: BanReviewerResponse = {
      reviewer_id: id,
      banned_at: bannedAt,
      ban_reason: reason,
    };

    validateResponseInDev(c.env, () => {
      BanReviewerResponseSchema.parse(body);
    });

    return json(body);
  };
}

function warnBan(c: AdminContext, message: string, vendorId: string, error: unknown): void {
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

/** The products the last-seat ban dropped to Free, with their names. */
interface BanDrops {
  dropped: string[];
  names: Map<string, { slug: string; name: string }>;
}

/**
 * The last-seat ban's purge, after commit and BEFORE the Stripe cancel, in its own
 * `waitUntil`. ONE purge message: the products that dropped to Free (a product another
 * live license still holds did not), the vendor's tags and the records-return tags.
 * Resolves to the dropped products for the email. Each step is caught; never throws.
 */
async function purgeAfterLastSeatBan(c: AdminContext, db: Db, ban: LastSeatBan): Promise<BanDrops> {
  const vendorId = ban.vendor.id;
  const endedProducts = [
    ...new Set(ban.ending.flatMap((l) => (l.assignedProductId ? [l.assignedProductId] : []))),
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
    warnBan(c, 'aeci.moderation.ban_product_read_failed', vendorId, error);
  }
  try {
    await purgeLicenseDrops(
      c,
      db,
      dropped,
      names,
      [{ id: vendorId, slug: ban.vendor.slug, verified: ban.vendor.verified }],
      ban.handback.purgeTags,
    );
  } catch (error) {
    warnBan(c, 'aeci.moderation.ban_purge_failed', vendorId, error);
  }
  return { dropped, names };
}

/**
 * The last-seat ban's email, after the Stripe cancel: one `vendor-banned` email per
 * address, every seat, banned ones included, and the billing email.
 * `subscriptionOutcomes` is the cancel hook's result, one per subscription, so the email
 * never says a subscription was cancelled when its cancel failed or ran out of time.
 * Never throws.
 */
async function emailAfterLastSeatBan(
  c: AdminContext,
  db: Db,
  ban: LastSeatBan,
  bannedAt: string,
  { dropped, names }: BanDrops,
  subscriptionOutcomes: readonly BanCancelOutcome[],
  fetchSeatEmails: FetchSeatEmails,
  sendBanned: SendVendorBanned,
): Promise<void> {
  const vendorId = ban.vendor.id;
  try {
    const [seats, billingEmails] = await Promise.all([
      loadVendorSeatRecipients(db, c.env, [vendorId], fetchSeatEmails, { includeBanned: true }),
      loadVendorBillingEmails(db, vendorId),
    ]);
    const addresses = mergeRecipientAddresses(
      [...(seats.get(vendorId) ?? []).map((s) => s.email), ...billingEmails],
      null,
    );
    // The products that dropped to Free: a co-owned product another vendor's live
    // license still holds keeps its plan, so the email does not name it.
    const products = dropped.flatMap((pid) => {
      const named = names.get(pid);
      return named ? [named] : [];
    });
    // One at a time: a handful of addresses, and the Worker holds about six connections.
    for (const to of addresses) {
      await sendBanned(c, {
        to,
        vendorName: ban.vendor.companyName,
        products,
        subscriptionOutcomes,
        dedupeKey: `vendor-banned:${vendorId}:${bannedAt}:${await recipientHash(to)}`,
        entity: { type: 'vendor', id: vendorId },
      });
    }
  } catch (error) {
    warnBan(c, 'aeci.moderation.ban_email_failed', vendorId, error);
  }
}
