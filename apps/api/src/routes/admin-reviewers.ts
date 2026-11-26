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
 * ── THE LAST SEAT (AECI-1623, ruling 1 of 2026-11-05) ─────────────────────────────
 * A ban of a vendor's last unbanned seat is refused, `409 VENDOR_LAST_SEAT_USE_SUSPEND`,
 * and writes nothing. Ending a vendor needs notice and a refund, so it is Suspend then
 * Terminate from the vendor page (`routes/admin-vendor-suspension.ts`). A ban here never
 * starts a suspension: the operator chooses that. Terminate bans every seat itself.
 *
 * ── REJECT PENDING (AECI-1949, `ADMIN_PANEL_SPEC.md` §5.8) ──────────────────────────
 * A ban with `reject_pending: true` also rejects the person's pending reviews, review
 * updates and the pending replies they wrote, in the SAME batch, after the ban's own
 * statements (`lib/ban-reject-pending.ts`). Each item uses its manual reject builder,
 * with a fixed reason and its own audit row pointing at the ban's (`ban_audit_id`).
 * Above `BAN_REJECT_MAX_ITEMS` the ban is refused, `422 BAN_REJECT_TOO_MANY`. An item
 * that moved between the read and the batch aborts everything; a re-read then answers
 * `409 BAN_PENDING_CHANGED`. No review email (ruling 1 of 2026-11-26). Each update
 * sends `review-update-rejected` post-commit (ruling 1a). Each reply keeps its portal
 * notice. Nothing pending was public, so nothing is recomputed or purged.
 *
 * The unban lifts the seat ban and re-stamps `owned_at` when Terminate cleared it. It
 * grants no license: the operator grants complimentary licenses for the ban term from
 * the vendor's Billing section. The contests Terminate moved stay with AECi, because they
 * went unstamped. It still clears any legacy `vendor-banned` license flags.
 */

import {
  ApiErrorCode,
  BAN_REJECTION_REASON,
  BAN_REJECT_MAX_ITEMS,
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
import type { WorkflowTransitionEntry } from '@aeci/shared/workflow-transition';
import { and, asc, count, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { getDb } from '../db/client';
import { profiles, vendors, workflowInstances } from '../db/schema';
import { forwardAuditBatch } from '../lib/moderation-forward';
import { submitCount } from '../posthog';
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
import {
  NO_PENDING_ITEMS,
  NO_REJECTED,
  banRejectStatements,
  countBanPendingItems,
  loadBanPendingItems,
  pendingFingerprint,
  rejectedCounts,
  totalItems,
  type BanPendingItems,
} from '../lib/ban-reject-pending';
import { stampOwnershipStatements } from '../lib/claimed-vendors';
import { sendReviewUpdateRejectedEmail } from '../lib/email';
import { purgeTags } from './vendor-shared';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { clearVendorBannedFlagsStatements, type LicenseBatch } from '../lib/license';
import { dispatchOwnershipSync } from '../lib/ownership-sync';
import { fetchAuthUserEmails } from '../lib/supabase-admin';
import {
  isSeatsChangedError,
  planOwnerSeatReturn,
  seatLossOutcome,
  seatRaceSentinels,
  seatsChangedError,
  type HandbackBatch,
} from '../lib/vendor-handback';
import type { FetchReviewerEmails } from './admin-reviews';
import { reviewUpdateDecisionKey } from './admin-review-updates';
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

/** AECI-1949: one count per kind a ban rejected, value = items. A sibling of
 *  `aeci.moderation.ban`, so that metric's tags stay bounded. Emitted only for a
 *  kind with at least one item. */
function emitBanRejected(
  c: AdminContext,
  role: 'reviewer' | 'vendor_admin',
  items: BanPendingItems,
) {
  const counts = rejectedCounts(items);
  for (const [kind, value] of [
    ['review', counts.reviews],
    ['review_update', counts.review_updates],
    ['review_response', counts.review_responses],
  ] as const) {
    if (value > 0) {
      submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.moderation.ban_rejected', value, [
        `kind:${kind}`,
        `role:${role}`,
      ]);
    }
  }
}

/** Post-commit: the `review-update-rejected` email for every update the ban rejected
 *  (ruling 1a of 2026-11-26), on the manual reject's dedupe key. Fail-open. */
async function emailRejectedUpdates(
  c: AdminContext,
  fetchEmails: FetchReviewerEmails,
  profileId: string,
  updates: BanPendingItems['updates'],
): Promise<void> {
  let to: string | undefined;
  try {
    to = (await fetchEmails(c.env, [profileId])).get(profileId);
  } catch (error) {
    console.warn('admin-reviewers: reviewer email lookup failed', error);
    return;
  }
  await mapWithConcurrency(updates, WORKER_CONNECTION_LIMIT, async (update) => {
    try {
      await sendReviewUpdateRejectedEmail(c, {
        to,
        productName: update.productName,
        reason: BAN_REJECTION_REASON,
        afterBan: true,
        dedupeKey: reviewUpdateDecisionKey(update.id),
        entity: { type: 'review_update', id: update.id },
      });
    } catch (error) {
      console.warn('admin-reviewers: update-rejected email failed', error);
    }
  });
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
  fetchEmails: FetchReviewerEmails = fetchAuthUserEmails,
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

    // AECI-1623: the target stays a (banned) profile, so any outcome but `none` means
    // this would leave no unbanned seat. Refused: ending a vendor is Suspend then
    // Terminate. Nothing is written and no suspension starts.
    if (
      ban &&
      handbackParams &&
      (await seatLossOutcome(db, handbackParams.vendorId, id)) !== 'none'
    ) {
      emitBanAction(c, payload.action, seatRole, 'invalid_state');
      throw new ApiError(
        409,
        ApiErrorCode.VENDOR_LAST_SEAT_USE_SUSPEND,
        "This is the vendor's last unbanned seat. To end a vendor, suspend it from its vendor page.",
        { details: { vendor_id: handbackParams.vendorId } },
      );
    }
    const planned = handbackParams && ban ? ('none' as const) : null;

    // AECI-1949: the person's pending items, when the operator asked to reject them.
    // Counted first, so an oversized set is refused before anything is loaded.
    const rejectPending = ban && payload.reject_pending === true;
    let pending: BanPendingItems = NO_PENDING_ITEMS;
    if (rejectPending) {
      const counts = await countBanPendingItems(db, id);
      if (totalItems(counts) > BAN_REJECT_MAX_ITEMS) {
        emitBanAction(c, payload.action, seatRole, 'invalid_state');
        throw new ApiError(
          422,
          ApiErrorCode.BAN_REJECT_TOO_MANY,
          `This person has ${totalItems(counts)} pending items, more than one ban can reject (${BAN_REJECT_MAX_ITEMS}). Reject some from the review queues filtered to this person, then ban again.`,
          { details: { ...counts, max: BAN_REJECT_MAX_ITEMS } },
        );
      }
      pending = await loadBanPendingItems(db, id);
    }

    // AECI-1589: the unban re-stamps ownership that Terminate cleared.
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
      // Minted here so each rejected item's audit row can name it (AECI-1949).
      id: crypto.randomUUID(),
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
    const claimPurgeTags: string[] = [];

    if (handbackParams && !ban) {
      // The unban: stamped contests come back (`planOwnerSeatReturn`). The ban's moved
      // none of those: they went unstamped and stay with AECi (ruling 6).
      const follow: HandbackBatch = await planOwnerSeatReturn(db, handbackParams);
      stmts.push(...follow.stmts);
      extraAudits.push(...follow.audits);
      claimPurgeTags.push(...follow.purgeTags);
      extraTransitions.push(...follow.transitions);
      if (ownershipStamped)
        stmts.push(...stampOwnershipStatements(db, handbackParams.vendorId, now));
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
    }

    // AECI-1949: the rejects ride the ban's batch, after its own statements.
    if (rejectPending) {
      const rejects = await banRejectStatements(db, pending, {
        actor,
        now,
        banAuditId: auditEntry.id!,
      });
      stmts.push(...rejects.stmts);
      extraAudits.push(...rejects.audits);
      extraTransitions.push(...rejects.transitions);
    }

    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      // Every sentinel fails as "malformed JSON", so the error alone cannot say which
      // one fired. A re-read can: the pending set moved, or the seats did.
      if (rejectPending && isSeatsChangedError(error)) {
        const current = pendingFingerprint(await loadBanPendingItems(db, id));
        if (current !== pendingFingerprint(pending)) {
          emitBanAction(c, payload.action, seatRole, 'invalid_state');
          throw new ApiError(
            409,
            ApiErrorCode.BAN_PENDING_CHANGED,
            "This person's pending items changed while the ban ran, so nothing was saved. Check the counts and confirm again.",
          );
        }
        if (handbackParams) throw seatsChangedError();
        throw error;
      }
      if (isSeatsChangedError(error)) {
        throw seatsChangedError();
      }
      throw error;
    }

    emitBanAction(c, payload.action, seatRole, 'ok');
    if (rejectPending) emitBanRejected(c, seatRole, pending);
    // Post-commit, fail-open: the update emails (ruling 1a). No review email.
    if (pending.updates.length > 0) {
      c.executionCtx.waitUntil(emailRejectedUpdates(c, fetchEmails, id, pending.updates));
    }
    // ONE batched forward: a vendor seat's unban adds rows per contest and license.
    forwardAuditBatch(c, [auditEntry, ...extraAudits], [workflowEntry, ...extraTransitions]);

    // AECI-1618: an unban that brings the claim back repaints the public pages.
    if (claimPurgeTags.length) {
      c.executionCtx.waitUntil(purgeTags(c, claimPurgeTags, 'moderation'));
    }
    if (handbackParams && ownershipStamped) {
      // AECI-1418: the review app learns the vendor owns its records again.
      dispatchOwnershipSync(c, handbackParams.vendorId, 'seat_provisioned');
    }
    const body: BanReviewerResponse = {
      reviewer_id: id,
      banned_at: bannedAt,
      ban_reason: reason,
      rejected: rejectPending ? rejectedCounts(pending) : NO_REJECTED,
    };

    validateResponseInDev(c.env, () => {
      BanReviewerResponseSchema.parse(body);
    });

    return json(body);
  };
}
