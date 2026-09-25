/**
 * `GET` / `PATCH` / `DELETE /api/account` (AECI-202 / Phase 5.11) — Drizzle/D1
 * (ADR 0016 / AECI-253, AECI-254).
 *
 * Auth-gated by `requireAuth()`; `c.get('auth')` is the verified session. `userId`
 * is the token `sub` — the id of both the `profiles` row (D1) and the `auth.users`
 * row (Supabase).
 *
 * ── The queue counts on the read shapes (AECI-617, AECI-922) ───────────────────
 * `GET`/`PATCH` return the three Operations queue counts for `role === 'admin'`
 * (`null` otherwise) so the header's role probe (`apps/web/.../auth/role-status.ts`)
 * gets role + badge counts in one round trip rather than chaining
 * `GET /api/admin/summary`. That second hop repeated the JWKS verify and the
 * `profiles` read, and its latency was the visible lag before the header's Admin
 * affordance appeared. `routes/admin-summary.ts` is unchanged in shape — it stays
 * the `/admin` SSR resolver's gate and the in-shell badge feed, and since
 * AECI-922 both endpoints read the SAME implementation
 * (`lib/admin-queue-counts.ts`), so the header badge and the console's Operations
 * badge cannot report different backlogs.
 *
 * That one probe also answers the vendor portal's door (`role === 'vendor_admin'`),
 * so a signed-in page load makes a single request here however many role-gated
 * affordances the header carries.
 *
 * ── Erasure (DELETE), split across the identity seam ────────────────────────────
 * `profiles(id)` has ten inbound FKs; five are NO ACTION, so they must be nulled
 * before the profile delete. Under D1 that erasure is ONE atomic `db.batch([...])`
 * (null the 10 refs + the PII-free `account.deleted` audit + delete the profile).
 * The `auth.users` row then goes via the GoTrue Admin API (seam #3,
 * `lib/supabase-admin.ts`) AFTER the batch commits — an HTTP call can't join the
 * D1 transaction. The D1 data erasure is the GDPR-load-bearing step; if the auth
 * delete fails it is logged (the orphaned auth row re-provisions a fresh empty
 * profile on next login) and does not fail the response.
 *
 * The `account.deleted` audit row MUST have `actorId: null` — the profile is
 * deleted in the same batch and `audit_log.actor_id` is NO ACTION.
 *
 * ── A vendor's last seat hands the record back (AECI-1106) ─────────────────────
 * A `vendor_admin` seat IS a `profiles` row, so erasing it is a seat loss, the same
 * as the admin revoke. When the erased seat is the vendor's last `vendor_admin`,
 * AECI-989's `planVendorHandback` joins the erasure batch. When only banned seats
 * remain, `planOwnerSeatLapse` does. The rows, audit set and purge tags are the
 * revoke's (`STAGE_2_ATTESTATIONS_SPEC.md` §13.9). Their audit and transition
 * actor is `null`, for the reason above. The race guards sit straight after the
 * profile delete. A lost race re-plans and retries a bounded number of times
 * rather than failing the erasure.
 */

import { UpdateAccountSchema } from '@aeci/shared';
import type { AccountProfileResponse, DeleteAccountResponse } from '@aeci/shared';
import { type AuditLogEntry } from '@aeci/shared/audit-log';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { getDb, type DbContext } from '../db/client';
import { forwardAuditBatch } from '../lib/moderation-forward';
import {
  auditLog,
  integrationFieldChallenges,
  profiles,
  reviews,
  vendorEntitlements,
  vendorRequests,
  vendorSeatInvites,
  workflowInstances,
  workflowTransitions,
} from '../db/schema';
import { logToPosthog } from '../posthog';
import type { Env } from '../env';
import { ApiError } from '../errors';
import { json } from '../http';
import { readAdminQueueCounts, type AdminQueueCounts } from '../lib/admin-queue-counts';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { VENDOR_ADMIN_ROLE } from '../lib/claimed-vendors';
import { sendAccountDeletionEmail } from '../lib/email';
import { writeDb, type DbFactory } from '../lib/handler-utils';
import { deleteAuthUser as deleteAuthUserDefault } from '../lib/supabase-admin';
import {
  isSeatsChangedError,
  planOwnerSeatLapse,
  planVendorHandback,
  seatLossOutcome,
  seatRaceSentinels,
  seatsChangedError,
  type HandbackBatch,
  type SeatLossOutcome,
} from '../lib/vendor-handback';
import { purgeTags } from './vendor-shared';

type AuthContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

async function parseJsonBody<T>(c: AuthContext, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
  }
  return schema.parse(raw);
}

// ─── GET /api/account ─────────────────────────────────────────────────────────

export function createGetAccountHandler(
  dbFor: DbFactory = getDb,
): (c: AuthContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const { db } = dbFor(c.env);

    const profile = await db.query.profiles.findFirst({
      columns: { displayName: true, listingViewPreference: true },
      where: eq(profiles.id, session.userId),
    });

    const body: AccountProfileResponse = {
      user_id: session.userId,
      email: session.email ?? null,
      display_name: profile?.displayName ?? null,
      listing_view_preference: profile?.listingViewPreference ?? null,
      role: session.role,
      ...(await queueCountsForSession(db, session.role)),
    };
    return json(body);
  };
}

/** The three counts as the account shapes carry them: real numbers for an admin,
 *  `null` for everyone else. Never a mix — a `0` here means an empty queue, and a
 *  `null` means "you are not an operator", which is a different fact. */
type AccountQueueCounts = {
  [K in keyof AdminQueueCounts]: number | null;
};

/** What a non-admin gets. Spread verbatim so the three keys are always present
 *  on the wire and a consumer never has to tell `undefined` from `null`. */
const NO_QUEUE_COUNTS: AccountQueueCounts = {
  pending_reviews: null,
  pending_requests: null,
  pending_claims: null,
  pending_reindex: null,
  pending_contests: null,
};

/**
 * The Operations queue counts for the header badge (AECI-617, widened to three
 * by AECI-922) — the same aggregates `routes/admin-summary.ts` serves, through
 * the same `lib/admin-queue-counts.ts` implementation, folded into the account
 * read so `AdminStatus` resolves role + counts in ONE round trip. Returns `null`s
 * for a non-admin without touching either table, so the extra columns cost a
 * reviewer nothing and leak no moderation state.
 *
 * `session.role` is the DB-refetched role from `requireAuth()` (`lib/authz.ts`
 * re-reads it every request per `AUTH_AND_RLS.md` §4.5), NOT a client claim — so
 * gating on it here is as trustworthy as the `requireAdmin()` gate itself.
 */
async function queueCountsForSession(
  db: DbContext['db'],
  role: string,
): Promise<AccountQueueCounts> {
  if (role !== 'admin') return NO_QUEUE_COUNTS;
  return readAdminQueueCounts(db);
}

// ─── PATCH /api/account ────────────────────────────────────────────────────────

export function createUpdateAccountHandler(
  dbFor: DbFactory = getDb,
): (c: AuthContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const { userId } = session;
    const payload = await parseJsonBody(c, UpdateAccountSchema);
    const { db } = writeDb(c, dbFor);

    const before = await db.query.profiles.findFirst({
      columns: { displayName: true, listingViewPreference: true },
      where: eq(profiles.id, userId),
    });

    // Present-key semantics (the schema guarantees at least one key): only the
    // fields the PATCH actually carries are written, so a listing-page toggle
    // click can persist `listing_view_preference` alone without re-sending the
    // display name — and an account-form save can't clobber the remembered
    // view with a stale client copy it never held.
    const updates: {
      displayName?: string | null;
      listingViewPreference?: 'cards' | 'table' | null;
    } = {};
    if (payload.display_name !== undefined) updates.displayName = payload.display_name;
    if (payload.listing_view_preference !== undefined)
      updates.listingViewPreference = payload.listing_view_preference;

    // The audit mirrors exactly the touched keys, with their before-values —
    // an untouched field never appears (so a toggle click doesn't log a no-op
    // display_name change).
    const beforeState: Record<string, unknown> = {};
    const afterState: Record<string, unknown> = {};
    if (payload.display_name !== undefined) {
      beforeState.display_name = before?.displayName ?? null;
      afterState.display_name = payload.display_name;
    }
    if (payload.listing_view_preference !== undefined) {
      beforeState.listing_view_preference = before?.listingViewPreference ?? null;
      afterState.listing_view_preference = payload.listing_view_preference;
    }

    const auditEntry: AuditLogEntry = {
      actorId: userId,
      actorType: auditActorType(session),
      action: 'profile.updated',
      entityType: 'profile',
      entityId: userId,
      beforeState,
      afterState,
      metadata: { source: 'account' },
    };

    await db.batch([
      db.update(profiles).set(updates).where(eq(profiles.id, userId)),
      auditInsert(db, auditEntry),
    ] as BatchTuple);

    forwardAuditBatch(c, [auditEntry], [], 'account');

    const body: AccountProfileResponse = {
      user_id: userId,
      email: session.email ?? null,
      // `!== undefined`, never `??`: an explicit `null` is a CLEAR (the schema's
      // documented way to drop the name), and `??` would treat it as "absent"
      // and echo back the name the row no longer holds.
      // `!== undefined`, never `??`: an explicit `null` is a CLEAR (the schema's
      // documented way to drop the name), and `??` would treat it as "absent"
      // and echo back the name the row no longer holds.
      display_name:
        payload.display_name !== undefined ? payload.display_name : (before?.displayName ?? null),
      listing_view_preference:
        payload.listing_view_preference !== undefined
          ? payload.listing_view_preference
          : (before?.listingViewPreference ?? null),
      role: session.role,
      ...(await queueCountsForSession(db, session.role)),
    };
    return json(body);
  };
}

// ─── DELETE /api/account (GDPR erasure) ────────────────────────────────────────

/** Attempts at the erasure batch when the AECI-989 seat guards abort it. */
export const ERASURE_SEAT_ATTEMPTS = 3;

/** What the erasure of a `vendor_admin` seat does to its vendor (AECI-1106). */
interface ErasureSeatPlan {
  vendorId: string;
  outcome: SeatLossOutcome;
  /** The hand-back or the lapse. `null` while an unbanned seat remains. */
  follow: HandbackBatch | null;
}

/**
 * `null` unless the profile being erased is a `vendor_admin` seat on a vendor.
 * Otherwise the same decision the admin revoke makes (`routes/admin-vendors.ts`):
 * no seat left hands the record back, only banned seats left moves the owner's
 * contests to AECi, an unbanned seat left changes nothing. The erased user cannot
 * be banned, because `requireAuth()` rejects a banned session. Read fresh on every
 * attempt, so a retry plans against the seats a lost race left behind.
 */
async function planErasureSeatLoss(
  db: DbContext['db'],
  userId: string,
  session: AuthzVariables['auth'],
): Promise<ErasureSeatPlan | null> {
  const profile = await db.query.profiles.findFirst({
    columns: { role: true, vendorId: true },
    where: eq(profiles.id, userId),
  });
  if (!profile || profile.role !== VENDOR_ADMIN_ROLE || !profile.vendorId) return null;
  const vendorId = profile.vendorId;
  const outcome = await seatLossOutcome(db, vendorId, userId);
  const params = {
    vendorId,
    actorId: null,
    actorType: auditActorType(session),
    now: new Date().toISOString(),
    source: 'account',
  };
  const follow =
    outcome === 'handback'
      ? await planVendorHandback(db, params)
      : outcome === 'lapse'
        ? await planOwnerSeatLapse(db, params)
        : null;
  return { vendorId, outcome, follow };
}

export function createDeleteAccountHandler(
  dbFor: DbFactory = getDb,
  deleteAuthUser: typeof deleteAuthUserDefault = deleteAuthUserDefault,
): (c: AuthContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const { userId } = session;
    // Capture the recipient BEFORE erasure — the auth.users row (the email's home)
    // is deleted below, so the §11.1 confirmation must read it up front.
    const recipientEmail = session.email;
    const { db } = writeDb(c, dbFor);

    const auditEntry: AuditLogEntry = {
      // actorId MUST be null — the profile is deleted in this same batch.
      actorId: null,
      actorType: auditActorType(session),
      action: 'account.deleted',
      entityType: 'profile',
      entityId: userId,
      metadata: { source: 'account', initiated_by_self: true },
    };

    // One atomic unit: null every inbound reference (five NO ACTION + the five SET NULL
    // refs — `reviews.reviewer_id`, `vendor_entitlements.granted_by`,
    // `vendor_seat_invites.invited_by_id` and the two contest columns — made explicit) → PII-free audit → delete
    // the profile.
    //
    // `page_views` is deliberately absent (AECI-585 / §13 D7). It used to be nulled
    // here, but `page_views.user_id` was never written by any code path and has now
    // been dropped along with `session_id` and `profile_role`. That strengthens this
    // handler rather than weakening it: the table can no longer hold user linkage at
    // all, so there is nothing here to erase (`AUTH_AND_RLS.md` §8).
    const erasureStmts = (): BatchStmt[] => [
      db
        .update(reviews)
        // Stamp `anonymized_at` in the same statement that nulls the reviewer ref
        // so the pair is atomic — a null `reviewer_id` always carries its
        // anonymization timestamp (the §23.1 / AECI-241 data-quality invariant).
        // Also null the free-text `reviewer_firm` (AECI-284): the firm is more
        // identifying than the generic role enum, so erasure clears it (and it
        // drops out of the contributing-firms count).
        .set({ reviewerId: null, reviewerFirm: null, anonymizedAt: new Date().toISOString() })
        .where(eq(reviews.reviewerId, userId)),
      db.update(reviews).set({ moderatedBy: null }).where(eq(reviews.moderatedBy, userId)),
      db
        .update(vendorRequests)
        .set({ resolvedById: null })
        .where(eq(vendorRequests.resolvedById, userId)),
      db
        .update(workflowInstances)
        .set({ initiatedBy: null })
        .where(eq(workflowInstances.initiatedBy, userId)),
      db
        .update(workflowTransitions)
        .set({ actorId: null })
        .where(eq(workflowTransitions.actorId, userId)),
      db.update(auditLog).set({ actorId: null }).where(eq(auditLog.actorId, userId)),
      // AECI-609 / R6: one of the ten inbound FKs to `profiles.id`
      // (`AUTH_AND_RLS.md` §8). It is `ON DELETE SET NULL`, so SQLite would cover it,
      // but it is nulled explicitly like `reviews.reviewer_id` so the erasure test
      // asserts it directly rather than trusting the cascade. The entitlement ROW
      // survives — only the granting admin's link is severed.
      db
        .update(vendorEntitlements)
        .set({ grantedBy: null })
        .where(eq(vendorEntitlements.grantedBy, userId)),
      // AECI-664: another of the ten (`AUTH_AND_RLS.md` §8), same treatment and same
      // reason. The INVITE survives its sender's erasure — a pending invite is the
      // invitee's to redeem, and deleting it would silently break a colleague's link
      // because someone else closed their account. Only the sender's link is severed.
      db
        .update(vendorSeatInvites)
        .set({ invitedById: null })
        .where(eq(vendorSeatInvites.invitedById, userId)),
      // AECI-1008: two more of the ten, both `ON DELETE SET NULL` and nulled
      // explicitly for the same reason. The CONTEST survives: it is a vendor's
      // record, not the person's. Only who filed or decided it is severed.
      db
        .update(integrationFieldChallenges)
        .set({ submittedBy: null })
        .where(eq(integrationFieldChallenges.submittedBy, userId)),
      db
        .update(integrationFieldChallenges)
        .set({ decidedBy: null })
        .where(eq(integrationFieldChallenges.decidedBy, userId)),
      // AECI-1009: three more on the same row, under the same rule. The PROTEST
      // survives; only who filed, replied to or decided it is severed.
      db
        .update(integrationFieldChallenges)
        .set({ protestedBy: null })
        .where(eq(integrationFieldChallenges.protestedBy, userId)),
      db
        .update(integrationFieldChallenges)
        .set({ protestRepliedBy: null })
        .where(eq(integrationFieldChallenges.protestRepliedBy, userId)),
      db
        .update(integrationFieldChallenges)
        .set({ protestDecidedBy: null })
        .where(eq(integrationFieldChallenges.protestDecidedBy, userId)),
      auditInsert(db, auditEntry),
      db.delete(profiles).where(eq(profiles.id, userId)),
    ];

    // AECI-1106: a vendor seat's erasure is a seat loss. Plan it, then run the batch
    // with the AECI-989 race guards straight after the profile delete. A lost race
    // re-plans against the seats that are really there: an erasure must not fail
    // because a colleague's seat changed at the same moment (§8). Only a race lost
    // on every attempt answers 409, and nothing is written then.
    let seat: ErasureSeatPlan | null;
    for (let attempt = 1; ; attempt += 1) {
      seat = await planErasureSeatLoss(db, userId, session);
      const stmts = [
        ...erasureStmts(),
        ...(seat
          ? [...seatRaceSentinels(db, seat.vendorId, seat.outcome), ...(seat.follow?.stmts ?? [])]
          : []),
      ];
      try {
        await db.batch(stmts as BatchTuple);
        break;
      } catch (error) {
        if (!seat || !isSeatsChangedError(error)) throw error;
        if (attempt >= ERASURE_SEAT_ATTEMPTS) throw seatsChangedError();
      }
    }

    // Seam #3: delete the auth.users row over the GoTrue Admin API. The D1 data is
    // already erased (GDPR-met); a failure here is logged, not fatal.
    const authResult = await deleteAuthUser(c.env, userId);
    if (!authResult.ok) {
      logToPosthog(c.executionCtx, c.env, c.req.raw, {
        level: 'warn',
        message: 'account.deleted: auth.users delete failed (D1 data already erased)',
        source: 'account',
        user_id: userId,
        status: authResult.status,
        reason: authResult.error,
      });
    }

    // §26.5 forward + the §11.1 deletion confirmation, fire-and-forget after the
    // erasure. The email fails open (absent key/email → silent skip) and never
    // affects the response — the data is already gone.
    // The seat hand-back adds an audit row and a transition per contest, so the
    // forwards go in ONE request. One `fetch` per row ran past the Worker's
    // connection limit on a vendor with many contests (AECI-666, AECI-1112).
    const follow = seat?.follow ?? null;
    forwardAuditBatch(
      c,
      [auditEntry, ...(follow?.audits ?? [])],
      follow?.transitions ?? [],
      'account',
    );
    c.executionCtx.waitUntil(sendAccountDeletionEmail(c, { to: recipientEmail }));
    // Only the hand-back returns tags: the pages whose maintenance marker flipped
    // (`CACHE_STRATEGY.md` (b1a)). A lapse re-routes contests and purges nothing.
    if (follow?.purgeTags.length) {
      c.executionCtx.waitUntil(purgeTags(c, follow.purgeTags, 'vendor'));
    }

    const body: DeleteAccountResponse = {
      message: 'Your account and personal data have been deleted.',
    };
    return json(body);
  };
}
