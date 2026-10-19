/**
 * The owner's decision on a claim routed to their company (AECI-1368 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11a.10):
 *
 *   POST /api/vendor/seats/claims/:id/accept  — invite the claimant (201).
 *   POST /api/vendor/seats/claims/:id/decline — reject the claim (204).
 *
 * A claim on a company that already has an unbanned owner seat is stored with
 * `routed_to_owners_at` set and lists under "Wants to join" in the owners' Seats
 * section (`GET /api/vendor/seats` `pending_claims`). These two routes are how an
 * owner decides it. AECi can still decide it from `/admin/claims` at any time, and
 * takes it over after 7 days (`lib/claim-owner-fallback.ts`).
 *
 * ── THE GATES, IN ORDER (the seat-management order, `vendor-seat-invites.ts`) ──
 * 1. `requireVendor()` establishes which vendor is calling.
 * 2. `rateLimit('write', { by: 'vendor' })`, registered in `index.ts`: both routes
 *    send mail, so they share the per-vendor bucket the invite routes use.
 * 3. `requireSeatOwner()` here: only an owner seat decides. A member seat gets 403.
 * 4. The claim must be on THIS vendor, routed, and undecided (`routedClaimsOf`). Any
 *    other id is a 404, never a 403, so a miss never reveals that the id exists.
 *
 * ── ACCEPT ISSUES AN INVITE, NOT A SEAT ─────────────────────────────────────
 * Accept writes no `profiles` row. It issues a `vendor_seat_invites` row to the
 * claim's `submitter_email` (invited by the owner) and resolves the claim, in ONE
 * `db.batch` with both audit rows. The claimant takes the seat by redeeming the
 * invite, which proves they control that address and makes them a member seat,
 * never an owner (`acceptInviteStatements`). So this path needs no Supabase key and
 * creates no account, and the invite rules hold: the per-vendor daily cap
 * (`assertInviteDailyCap`), and one live invite per address. When the address already
 * has a live invite, accept resolves the claim against that invite and sends no
 * second email.
 *
 * ── THE ACCOUNT GUARD ON ACCEPT (AECI-1420) ─────────────────────────────────
 * One account belongs to one company. The submit already rejects a claim from an
 * address that holds a seat on another vendor, but a claim can get through when the
 * lookup was unavailable at submit. So Accept checks again, lookup-only, before it
 * writes anything. On a conflict the SYSTEM rejects the claim (null actor, `system`
 * source, the same metadata as the submit-time reject), the claimant gets the reasoned
 * `claim-rejected`, and the owner gets the existing `409 CLAIM_ALREADY_DECIDED` with
 * `details.status: 'rejected'`. The roster re-reads the seats scope on that 409
 * (`vendor-seat-roster.ts`). No invite is issued. When the check cannot run, Accept
 * answers `503 DEPENDENCY_FAILURE` and writes nothing, so the owner can retry.
 *
 * ── DECLINE IS THE NEUTRAL REJECT ───────────────────────────────────────────
 * Decline runs `rejectClaimStatements` with the owner as actor and the
 * `vendor-portal` source, then sends the same `claim-rejected` email AECi's reject
 * sends, which never carries a reviewer's reason. The claimant is not told who
 * declined.
 */

import {
  AcceptSeatClaimResponseSchema,
  ApiErrorCode,
  type AcceptSeatClaimResponse,
} from '@aeci/shared';
import { and, eq } from 'drizzle-orm';

import { getDb } from '../db/client';
import { vendorRequests, vendorSeatInvites, vendors, workflowInstances } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import type { BatchStmt, BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import {
  ACCOUNT_CONFLICT_REASON,
  SYSTEM_CLAIM_SOURCE,
  accountConflictEmailReason,
  accountConflictMetadata,
  checkClaimAccount,
  resolveClaimantIdentity,
} from '../lib/claimant-identity';
import type { ClaimRejectionReason } from '../lib/email';
import { routedClaimsOf } from '../lib/claim-owner-routing';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { forwardAuditBatch } from '../lib/moderation-forward';
import {
  claimDecisionRaceError,
  isClaimDecidedAbort,
  ownerAcceptClaimStatements,
  rejectClaimStatements,
} from '../lib/vendor-grant';
import {
  createInviteStatements,
  inviteExpiryFrom,
  inviteResendState,
  liveInvitesFor,
  normalizeInviteEmail,
  SEAT_INVITE_AUDIT_SOURCE,
} from '../lib/vendor-seat-invites';
import { assertInviteDailyCap, type SendSeatInviteEmail } from './vendor-seat-invites';
import {
  afterVendorWrite,
  requireSeatOwner,
  sessionVendorId,
  sessionVendorPlan,
  type VendorContext,
} from './vendor-shared';

/** The `claim-rejected` seam, for the owner decline and the Accept guard. A no-op
 *  default keeps the handlers unit-testable; `index.ts` injects the real sender.
 *  `reason` is set only by the Accept guard's system reject (AECI-1420); a decline
 *  sends none, so the claimant is not told who declined or why. */
export type SendSeatClaimDeclinedEmail = (
  c: VendorContext,
  opts: { to: string; vendorName: string; reason?: ClaimRejectionReason },
) => Promise<void>;

const noopSendInvite: SendSeatInviteEmail = async () => {};
const noopSendDeclined: SendSeatClaimDeclinedEmail = async () => {};

/** The routed, undecided claim on the caller's vendor, or a 404. */
async function loadRoutedClaim(
  c: VendorContext,
  db: ReturnType<DbFactory>['db'],
  vendorId: string,
) {
  const id = c.req.param('id');
  if (!id) {
    throw new ApiError(400, ApiErrorCode.VALIDATION_FAILED, 'Missing id', { field: 'id' });
  }
  const claim = await db.query.vendorRequests.findFirst({
    columns: { id: true, status: true, submitterEmail: true },
    where: and(eq(vendorRequests.id, id), routedClaimsOf(vendorId)),
  });
  if (!claim) throw notFoundError('vendor_request', { id });
  return claim;
}

/** The `vendor_claim` workflow instance id, found or minted up front (a batch
 *  cannot find-or-create). The `findClaimWorkflow` shape from `admin-claims.ts`. */
async function claimWorkflow(
  db: ReturnType<DbFactory>['db'],
  requestId: string,
): Promise<{ workflowId: string; existingWf: boolean }> {
  const wf = await db.query.workflowInstances.findFirst({
    columns: { id: true },
    where: and(
      eq(workflowInstances.workflowType, 'vendor_claim'),
      eq(workflowInstances.entityId, requestId),
    ),
  });
  return wf
    ? { workflowId: wf.id, existingWf: true }
    : { workflowId: crypto.randomUUID(), existingWf: false };
}

/**
 * Run an owner decision batch. When it rolls back on `claimUndecidedSentinel`
 * (AECI-1333), answer `409 CLAIM_ALREADY_DECIDED`: AECi or another owner decided the
 * claim, or the fallback took it back, after `loadRoutedClaim` read it. The caller
 * sends its email only after this returns, so an abort sends nothing.
 */
async function runOwnerDecision(
  db: ReturnType<DbFactory>['db'],
  requestId: string,
  stmts: BatchStmt[],
): Promise<void> {
  try {
    await db.batch(stmts as BatchTuple);
  } catch (error) {
    const decided = isClaimDecidedAbort(error)
      ? await claimDecisionRaceError(db, requestId, { requireRouted: true })
      : null;
    throw decided ?? error;
  }
}

async function vendorName(db: ReturnType<DbFactory>['db'], vendorId: string): Promise<string> {
  const vendor = await db.query.vendors.findFirst({
    columns: { companyName: true },
    where: eq(vendors.id, vendorId),
  });
  // The guard proved the session's `vendor_id`; a missing row is a broken FK.
  if (!vendor) throw notFoundError('vendor', { id: vendorId });
  return vendor.companyName;
}

// ─── POST /api/vendor/seats/claims/:id/accept ────────────────────────────────

export function createAcceptSeatClaimHandler(
  dbFor: DbFactory = getDb,
  sendInvite: SendSeatInviteEmail = noopSendInvite,
  sendRejected: SendSeatClaimDeclinedEmail = noopSendDeclined,
  resolveIdentity: typeof resolveClaimantIdentity = resolveClaimantIdentity,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const auth = c.get('auth');
    const vendorId = sessionVendorId(c);
    const { db } = writeDb(c, dbFor);
    const owner = await requireSeatOwner(db, auth.userId, vendorId);
    const claim = await loadRoutedClaim(c, db, vendorId);

    const email = normalizeInviteEmail(claim.submitterEmail);
    const now = new Date().toISOString();
    const company = await vendorName(db, vendorId);

    // AECI-1420: the account guard, before anything is written. See the header.
    const account = await checkClaimAccount(
      db,
      c.env,
      { email: claim.submitterEmail, vendorId },
      resolveIdentity,
    );
    if (account.outcome === 'unavailable') {
      throw new ApiError(
        503,
        ApiErrorCode.DEPENDENCY_FAILURE,
        "We could not check the claimant's account, so nothing was saved. Try again in a few minutes.",
      );
    }
    if (account.outcome === 'conflict') {
      const { workflowId, existingWf } = await claimWorkflow(db, claim.id);
      const batch = rejectClaimStatements(db, {
        requestId: claim.id,
        actorId: null,
        actorType: 'system',
        resolvedAt: now,
        fromStatus: claim.status,
        workflowId,
        existingWf,
        reason: ACCOUNT_CONFLICT_REASON,
        targetType: 'vendor',
        targetId: vendorId,
        source: SYSTEM_CLAIM_SOURCE,
        vendorId,
        extraMetadata: accountConflictMetadata(account),
        // A decision or the fallback landing first wins, as for a decline.
        requireRouted: true,
      });
      // A lost race throws its own 409 here and sends nothing.
      await runOwnerDecision(db, claim.id, batch.stmts);

      // The system decided it, not the owner: no vendor-origin labelling.
      forwardAuditBatch(c, [batch.auditEntry], [batch.workflowEntry], SYSTEM_CLAIM_SOURCE);
      c.executionCtx.waitUntil(
        sendRejected(c, {
          to: claim.submitterEmail,
          vendorName: company,
          reason: accountConflictEmailReason(account),
        }).catch(() => undefined),
      );
      // The owner sees the claim as decided, with no detail about the other company.
      throw new ApiError(
        409,
        ApiErrorCode.CLAIM_ALREADY_DECIDED,
        'This claim was declined automatically, so nothing else was saved. Reload to see where it stands.',
        { details: { status: 'rejected' } },
      );
    }

    // One live invite per address (the create route's rule). An address that
    // already has one is not mailed again: the claim resolves against that invite.
    const live = await db.query.vendorSeatInvites.findFirst({
      columns: {
        id: true,
        email: true,
        expiresAt: true,
        createdAt: true,
        lastSentAt: true,
        sendCount: true,
      },
      where: and(liveInvitesFor(vendorId, now), eq(vendorSeatInvites.email, email)),
    });
    if (!live) await assertInviteDailyCap(db, vendorId, now);

    const inviteId = live?.id ?? crypto.randomUUID();
    const token = crypto.randomUUID();
    const expiresAt = live?.expiresAt ?? inviteExpiryFrom(now);
    const actorType = auditActorType(auth);
    const vendorPlan = sessionVendorPlan(c);

    const invite = live
      ? null
      : createInviteStatements(db, {
          inviteId,
          token,
          vendorId,
          email,
          actorId: auth.userId,
          actorType,
          vendorPlan,
          now,
          expiresAt,
        });
    const { workflowId, existingWf } = await claimWorkflow(db, claim.id);
    const resolve = ownerAcceptClaimStatements(db, {
      requestId: claim.id,
      actorId: auth.userId,
      actorType,
      vendorId,
      resolvedAt: now,
      fromStatus: claim.status,
      workflowId,
      existingWf,
      inviteId,
      inviteCreated: invite !== null,
    });
    // The resolve statements go FIRST: they open with the decision-race sentinel
    // (AECI-1333), so a lost race commits no invite either.
    const stmts: BatchStmt[] = [...resolve.stmts, ...(invite?.stmts ?? [])];
    await runOwnerDecision(db, claim.id, stmts);

    // Post-commit, best-effort: a send failure must not un-resolve the claim. The
    // owner can re-send the invite from the roster, where it now shows as pending.
    afterVendorWrite(
      c,
      [],
      invite ? [invite.auditEntry, resolve.auditEntry] : [resolve.auditEntry],
    );
    forwardAuditBatch(c, [], [resolve.workflowEntry], SEAT_INVITE_AUDIT_SOURCE);
    if (invite) {
      c.executionCtx.waitUntil(
        sendInvite(c, {
          notification: 'vendor-seat-invite',
          to: email,
          vendorName: company,
          invitedByName: owner.displayName,
          token,
          expiresAt,
        }),
      );
    }

    const body: AcceptSeatClaimResponse = {
      invite: live
        ? {
            id: live.id,
            email: live.email,
            invited_by: owner.displayName,
            expires_at: live.expiresAt,
            created_at: live.createdAt,
            last_sent_at: live.lastSentAt,
            resend_state: inviteResendState(live, now),
          }
        : {
            id: inviteId,
            email,
            invited_by: owner.displayName,
            expires_at: expiresAt,
            created_at: now,
            last_sent_at: null,
            resend_state: inviteResendState(
              { lastSentAt: null, createdAt: now, sendCount: 1 },
              now,
            ),
          },
      // AECI-1333: `false` when the live invite was reused and nothing was mailed.
      invite_sent: invite !== null,
    };
    validateResponseInDev(c.env, () => AcceptSeatClaimResponseSchema.parse(body));
    return json(body, { status: 201 });
  };
}

// ─── POST /api/vendor/seats/claims/:id/decline ───────────────────────────────

export function createDeclineSeatClaimHandler(
  dbFor: DbFactory = getDb,
  sendDeclined: SendSeatClaimDeclinedEmail = noopSendDeclined,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const auth = c.get('auth');
    const vendorId = sessionVendorId(c);
    const { db } = writeDb(c, dbFor);
    await requireSeatOwner(db, auth.userId, vendorId);
    const claim = await loadRoutedClaim(c, db, vendorId);
    const company = await vendorName(db, vendorId);

    const now = new Date().toISOString();
    const { workflowId, existingWf } = await claimWorkflow(db, claim.id);
    const batch = rejectClaimStatements(db, {
      requestId: claim.id,
      actorId: auth.userId,
      actorType: auditActorType(auth),
      resolvedAt: now,
      fromStatus: claim.status,
      workflowId,
      existingWf,
      reason: null,
      targetType: 'vendor',
      targetId: vendorId,
      source: SEAT_INVITE_AUDIT_SOURCE,
      vendorId,
      // AECI-1333: the fallback taking the claim back to AECi also loses the race.
      requireRouted: true,
    });
    await runOwnerDecision(db, claim.id, batch.stmts);

    afterVendorWrite(c, [], batch.auditEntry);
    forwardAuditBatch(c, [], [batch.workflowEntry], SEAT_INVITE_AUDIT_SOURCE);
    // The plain `claim-rejected`: no reason, and the claimant is not told who declined.
    c.executionCtx.waitUntil(
      sendDeclined(c, { to: claim.submitterEmail, vendorName: company }).catch(() => undefined),
    );

    return new Response(null, { status: 204 });
  };
}
