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
 * metric are role-aware (`vendor_admin.banned` vs `reviewer.banned`). Ban is
 * per-seat: it touches one `profiles` row and never `vendors.verified` (§8.3(2)).
 * Unbanning restores portal access without re-granting the seat.
 *
 * AECI-989: a ban never hands a vendor's record back to AECi, because a ban is
 * reversible. When it leaves the vendor with no unbanned `vendor_admin`, the
 * vendor's open owner contests move to AECi's queue in the same batch, and an
 * unban moves them back (`lib/vendor-handback.ts`). `claimed_at` and the
 * maintenance marker are untouched either way.
 *
 * AECI-1374 (E4.5, `VENDOR_SIGNUP_PROCESS.md` decision 15, ruled 2026-10-14): "ban a
 * vendor" is the ban of its last unbanned seat. That ban also flags every live license
 * on the vendor's billing accounts `cancel_at_term_end`, reason `vendor-banned`, in the
 * same batch. Nothing ends now: no plan change, no purge, no email. The unban clears
 * only the `vendor-banned` flags, and so does any new unbanned seat grant (ruled
 * 2026-10-15, `planSeatGrantReturn`). A seat REVOKE writes nothing in billing.
 * The same last-seat ban revokes the vendor's pending seat invites (ruled 2026-10-16),
 * so a pre-ban invite cannot mint the unbanned seat that would clear those flags. The
 * unban restores no invite.
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
import { licensePlanSnapshot } from '@aeci/shared/entitlements';
import type { WorkflowTransitionEntry } from '@aeci/shared/workflow-transition';
import { and, asc, count, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { getDb } from '../db/client';
import { profiles, vendorSeatInvites, vendors, workflowInstances } from '../db/schema';
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
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import {
  clearVendorBannedFlagsStatements,
  loadVendorLicenses,
  setCancelAtTermEndStatements,
  VENDOR_BANNED_CANCEL_REASON,
  type LicenseBatch,
} from '../lib/license';
import { stripeClientFromEnv } from '../lib/stripe';
import {
  liveStripeSubscriptionIds,
  stripeBanCancelHook,
  type StripeClientFor,
} from '../lib/stripe-licenses';
import { fetchAuthUserEmails } from '../lib/supabase-admin';
import {
  isSeatsChangedError,
  pendingInviteRaceSentinel,
  planOwnerSeatLapse,
  planOwnerSeatReturn,
  seatLossOutcome,
  seatRaceSentinels,
  seatsChangedError,
} from '../lib/vendor-handback';
import { liveInvitesFor, revokeInviteStatements } from '../lib/vendor-seat-invites';
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

export function createBanReviewerHandler(
  dbFor: DbFactory = getDb,
  stripeFor: StripeClientFor = (env) => stripeClientFromEnv(env),
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
    // role-aware. A banned `vendor_admin` then fails every `/api/vendor/*` call
    // via the §4 guard's per-request ban check (AECI-520).
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
    const bannedAt = ban ? new Date().toISOString() : null;
    const fromState = ban ? 'active' : 'banned';
    const toState = ban ? 'banned' : 'active';
    const metadata = { source: 'admin-moderation', ...(reason ? { reason } : {}) };

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
    const stamp =
      seatRole === 'vendor_admin' ? await vendorAuditStamp(db, existing.vendorId) : NO_VENDOR_STAMP;
    const auditEntry: AuditLogEntry = {
      actorId: userId,
      actorType: auditActorType(session),
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
    // AECI-989: a ban hands nothing back, but a vendor with no unbanned seat left
    // cannot answer a contest. Its open owner contests go to AECi until an unban
    // routes them back. `claimed_at` and the maintenance marker are untouched.
    const seatVendorId = seatRole === 'vendor_admin' ? existing.vendorId : null;
    const contestParams = seatVendorId
      ? {
          vendorId: seatVendorId,
          actorId: userId,
          actorType: auditActorType(session),
          now: bannedAt ?? new Date().toISOString(),
          source: 'admin-moderation',
          // The ban row's own stamp already read the plan. `sealed()` reuses it.
          ...(stamp.vendorPlan ? { vendorPlan: stamp.vendorPlan } : {}),
        }
      : null;
    // What the ban leaves: the target stays a (banned) profile, so any outcome but
    // `none` means no active seat is left, which is a lapse.
    const planned = !contestParams
      ? null
      : ban
        ? (await seatLossOutcome(db, contestParams.vendorId, id)) === 'none'
          ? ('none' as const)
          : ('lapse' as const)
        : null;
    const follow = !contestParams
      ? null
      : !ban
        ? await planOwnerSeatReturn(db, contestParams)
        : planned === 'lapse'
          ? await planOwnerSeatLapse(db, contestParams)
          : null;
    if (contestParams) {
      // Straight after the profile UPDATE: a lost race rolls the batch back whole.
      stmts.splice(1, 0, ...seatRaceSentinels(db, contestParams.vendorId, planned));
    }
    if (follow) stmts.push(...follow.stmts);

    // AECI-1374 (decision 15): the ban of the last unbanned seat flags every live
    // license, any source, to cancel at term end. A license already flagged keeps its
    // own reason, so the unban cannot clear a cancel someone else set. The unban
    // clears only `vendor-banned` flags, through the helper every new seat grant also
    // uses (`clearVendorBannedFlagsStatements`, ruled 2026-10-15). Nothing ends now;
    // the reconcile the builder appends cannot move `verified`, because no license ends.
    let licenseBatch: LicenseBatch | null = null;
    const inviteAudits: AuditLogEntry[] = [];
    // M1 of the Stripe epic (AECI-1500): the live Stripe subscriptions the ban's license
    // flags cover. After commit their `cancel_at_period_end` is set too.
    let banSubscriptionIds: string[] = [];
    if (contestParams && !ban) {
      licenseBatch = await clearVendorBannedFlagsStatements(db, {
        vendorId: contestParams.vendorId,
        now: contestParams.now,
        actorId: userId,
        actorType: auditActorType(session),
        source: 'admin-moderation',
        extraMetadata: { seat_user_id: id },
      });
      stmts.push(...licenseBatch.stmts);
    } else if (contestParams && planned === 'lapse') {
      const [vendorLicenses, vendorRow, liveInviteRows] = await Promise.all([
        loadVendorLicenses(db, contestParams.vendorId),
        db.query.vendors.findFirst({
          columns: { verified: true },
          where: eq(vendors.id, contestParams.vendorId),
        }),
        db
          .select({ id: vendorSeatInvites.id, email: vendorSeatInvites.email })
          .from(vendorSeatInvites)
          .where(liveInvitesFor(contestParams.vendorId, contestParams.now)),
      ]);
      // AECI-1374 (ruled 2026-10-16): the same ban revokes every pending invite, one
      // audit row each. Otherwise a banned owner could redeem a pre-ban invite at a
      // second address, and that new unbanned seat would clear the `vendor-banned`
      // flags and pull the contests back with no AECi action. An unban restores none.
      const invitePlan = licensePlanSnapshot(vendorLicenses, contestParams.now);
      for (const invite of liveInviteRows) {
        const revoke = revokeInviteStatements(db, {
          vendorPlan: invitePlan,
          inviteId: invite.id,
          vendorId: contestParams.vendorId,
          email: invite.email,
          actorId: userId,
          actorType: auditActorType(session),
          now: contestParams.now,
          source: 'admin-moderation',
          extraMetadata: { reason: VENDOR_BANNED_CANCEL_REASON, seat_user_id: id },
        });
        stmts.push(...revoke.stmts);
        inviteAudits.push(revoke.auditEntry);
      }
      // An invite created between the read above and this batch would survive the ban.
      stmts.push(pendingInviteRaceSentinel(db, contestParams.vendorId, contestParams.now));
      banSubscriptionIds = liveStripeSubscriptionIds(vendorLicenses);
      licenseBatch = setCancelAtTermEndStatements(db, {
        vendorId: contestParams.vendorId,
        now: contestParams.now,
        actorId: userId,
        actorType: auditActorType(session),
        vendorLicenses,
        vendorWasVerified: vendorRow?.verified ?? false,
        source: 'admin-moderation',
        extraMetadata: { seat_user_id: id },
        licenseIds: vendorLicenses
          .filter((l) => l.endedAt === null && !l.cancelAtTermEnd)
          .map((l) => l.id),
        cancel: true,
        cancelReason: VENDOR_BANNED_CANCEL_REASON,
        ifCancelReason: null,
      });
      stmts.push(...licenseBatch.stmts);
    }

    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      if (isSeatsChangedError(error)) throw seatsChangedError();
      throw error;
    }

    emitBanAction(c, payload.action, seatRole, 'ok');
    // M1 (AECI-1500): mirror the ban's license flags onto Stripe after commit, so the
    // subscription stops renewing too, and the unban takes back only a cancel the ban set
    // (`stripeBanCancelHook`). Best-effort in `waitUntil`: a failure warns and the daily
    // reconcile catches it. The unban reads the subscriptions after commit.
    if (contestParams && (ban ? planned === 'lapse' : true)) {
      const hookVendorId = contestParams.vendorId;
      const hookNow = contestParams.now;
      c.executionCtx.waitUntil(
        (async () => {
          const subscriptionIds = ban
            ? banSubscriptionIds
            : liveStripeSubscriptionIds(await loadVendorLicenses(db, hookVendorId));
          if (subscriptionIds.length === 0) return;
          await stripeBanCancelHook(c, stripeFor(c.env), {
            vendorId: hookVendorId,
            subscriptionIds,
            ban,
            now: hookNow,
          });
        })().catch((error: unknown) => {
          // The hook never throws; the license read may. Warn, and the reconcile catches it.
          try {
            logToPosthog(c.executionCtx, c.env, c.req.raw, {
              level: 'warn',
              source: 'stripe-ban-hook',
              message: 'aeci.stripe.ban_hook_failed',
              vendor_id: hookVendorId,
              reason: error instanceof Error ? error.message : String(error),
            });
          } catch {
            // Telemetry must never change the outcome.
          }
        }),
      );
    }
    // ONE batched forward: a ban or unban of a vendor seat adds a row and a
    // transition per re-routed contest.
    forwardAuditBatch(
      c,
      [
        auditEntry,
        ...(follow?.audits ?? []),
        ...(licenseBatch?.auditEntries ?? []),
        ...inviteAudits,
      ],
      [workflowEntry, ...(follow?.transitions ?? [])],
    );

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
