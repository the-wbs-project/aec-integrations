/**
 * Vendor seat-invite batch-builders + the pure redeem rules (AECI-664 /
 * `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §11a).
 *
 * Same shape and same reason as `lib/vendor-grant.ts`: D1 has no interactive
 * transactions, only atomic `db.batch([...])`, so each function RETURNS the
 * Drizzle statements plus the `AuditLogEntry` the caller forwards post-commit
 * (§26.5) rather than executing them. The seat write, the invite's state change,
 * and the `audit_log` row commit or roll back as ONE unit (§26.1 — no state
 * change without an audit row). The route handlers own HTTP, scoping and the
 * email send; this module is pure, so the batch shape is unit-testable with no
 * D1 harness and no Supabase.
 *
 * ── WHAT MAKES THIS SAFE ────────────────────────────────────────────────────
 * The invite row grants nothing. {@link inviteRedeemState} requires the
 * redeemer's VERIFIED JWT email to equal the invited address, so possession of a
 * token is not possession of a seat — a forwarded link still demands control of
 * that mailbox, proven through the ordinary Supabase sign-in. This is why no code
 * here (and nothing on the vendor-facing surface at all) calls `createAuthUser`:
 * the vendor never provisions an account, so this whole path needs no
 * `SUPABASE_SERVICE_ROLE_KEY` and works identically in local dev, on PR previews,
 * and in production — unlike the §3 admin grant, which 503s wherever that key is
 * absent.
 *
 * ── THIS MODULE NEVER TOUCHES `vendors` OR `vendor_entitlements` ────────────
 * Seat composition and paid state are orthogonal (§8.3(2)): adding or removing a
 * colleague must never flip `vendors.verified`, and — the direction people get
 * wrong — a LAPSED entitlement must never block removing a departed employee's
 * access. Seat management is deliberately NOT capability-gated; see §11a for why
 * that is a security position rather than an oversight.
 */

import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq, isNull } from 'drizzle-orm';

import type { Db } from '../db/client';
import { profiles, vendorSeatInvites } from '../db/schema';
import { auditInsert, type BatchStmt } from './audit';
import { VENDOR_ADMIN_ROLE } from './claimed-vendors';

/**
 * How long an invite stays redeemable. Long enough to survive a holiday, short
 * enough that a stale link in an old mailbox is not a standing grant. Deliberately
 * TS policy rather than a DB CHECK — a CHECK change on SQLite is a full table
 * rebuild (`STAGE_2_PAID_TIERS_SPEC.md` §1.2 / R1) and this is a number we may
 * well tune.
 */
export const INVITE_TTL_DAYS = 14;

/**
 * Per-vendor invites per rolling 24h. This endpoint sends mail on a customer's
 * command, which is the classic abuse amplifier; the cap is the rate limit and it
 * is enforced with a `COUNT` over the table we already have rather than a KV
 * counter or a new binding. Generous for the real case (onboarding a team) and
 * still bounded.
 */
export const INVITE_DAILY_LIMIT = 10;

/** `metadata.source` on every audit row this module writes — the vendor portal's
 *  own tag (`routes/vendor-shared.ts` `AUDIT_SOURCE`), NOT `admin-moderation`.
 *  `actor_type` is `'user'` for a reviewer and a vendor admin alike, so this is
 *  what makes "the vendor added a colleague" legible next to "AECi granted a
 *  claim" in the trail. */
export const SEAT_INVITE_AUDIT_SOURCE = 'vendor-portal';

/** GoTrue stores emails lowercased and the redeem comparison must be exact, so
 *  every address is normalized on the way in AND on the way out. Mirrors
 *  `normalizeEmail` in `lib/supabase-admin.ts` (private there, and duplicating
 *  two lines beats exporting a Supabase helper into a Supabase-free module). */
export function normalizeInviteEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** ISO-8601 expiry, {@link INVITE_TTL_DAYS} after `now`. */
export function inviteExpiryFrom(now: string): string {
  return new Date(new Date(now).getTime() + INVITE_TTL_DAYS * 86_400_000).toISOString();
}

/** The redeem verdict surfaced as `SeatInvitePreview.reason`. */
export type InviteRedeemState = 'ok' | 'expired' | 'revoked' | 'accepted' | 'email_mismatch';

/** The invite columns the redeem rules read. Structural, so the rules stay
 *  testable against a literal rather than a full row. */
export interface RedeemableInvite {
  email: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

/**
 * Can this invite be redeemed by this caller, right now?
 *
 * Pure, and the single source of the answer for BOTH the preview read and the
 * accept write — if the two ever computed it separately they would eventually
 * disagree, and the direction that disagreement fails is "the page says you can,
 * the write says you can't."
 *
 * Order is load-bearing. The terminal states are checked first so a spent invite
 * reports *why* it is spent rather than reporting a mismatch against whoever
 * happens to be signed in. `email_mismatch` is last, and an ABSENT session email
 * lands there too: `AuthenticatedSession.email` is optional (it comes off the
 * JWT), and a redeem we cannot bind to an address must fail CLOSED — the email
 * binding is the entire security control here, not the token.
 */
export function inviteRedeemState(
  invite: RedeemableInvite,
  now: string,
  signedInEmail: string | undefined,
): InviteRedeemState {
  if (invite.revokedAt !== null) return 'revoked';
  if (invite.acceptedAt !== null) return 'accepted';
  if (Date.parse(invite.expiresAt) <= Date.parse(now)) return 'expired';
  if (!signedInEmail) return 'email_mismatch';
  return normalizeInviteEmail(signedInEmail) === normalizeInviteEmail(invite.email)
    ? 'ok'
    : 'email_mismatch';
}

/** The statements + the audit entry the caller forwards post-commit. */
export interface SeatInviteBatch {
  stmts: BatchStmt[];
  auditEntry: AuditLogEntry;
}

export interface CreateInviteParams {
  inviteId: string;
  token: string;
  vendorId: string;
  /** Already normalized by the handler. */
  email: string;
  /** The owner seat sending it — the audit actor and `invited_by_id`. */
  actorId: string;
  actorType: AuditLogEntry['actorType'];
  now: string;
  expiresAt: string;
}

/**
 * Create a pending invite. One insert + its audit row.
 *
 * The `token` is supplied by the caller rather than left to the column's
 * `$defaultFn` because the handler needs the same value for the email it sends
 * post-commit, and reading it back would be a second round-trip against a row the
 * batch may still roll back.
 *
 * **The token is never in the audit metadata.** Audit rows are readable on the
 * admin surface and forwarded to PostHog Logs (§26.5); a redeem handle in either
 * is a credential in a log. The row `id` identifies the invite everywhere except
 * the one email that carries the link.
 */
export function createInviteStatements(db: Db, p: CreateInviteParams): SeatInviteBatch {
  const auditEntry: AuditLogEntry = {
    actorId: p.actorId,
    actorType: p.actorType,
    action: 'vendor_seat.invited',
    entityType: 'vendor_seat_invite',
    entityId: p.inviteId,
    afterState: { email: p.email, expires_at: p.expiresAt },
    metadata: {
      source: SEAT_INVITE_AUDIT_SOURCE,
      vendor_id: p.vendorId,
      invited_email: p.email,
    },
  };

  return {
    stmts: [
      db.insert(vendorSeatInvites).values({
        id: p.inviteId,
        token: p.token,
        vendorId: p.vendorId,
        email: p.email,
        invitedById: p.actorId,
        expiresAt: p.expiresAt,
        createdAt: p.now,
        updatedAt: p.now,
      }),
      auditInsert(db, auditEntry),
    ],
    auditEntry,
  };
}

export interface RevokeInviteParams {
  inviteId: string;
  vendorId: string;
  email: string;
  actorId: string;
  actorType: AuditLogEntry['actorType'];
  now: string;
}

/**
 * Revoke a pending invite — a SOFT delete (`revoked_at`), never a row delete, so
 * "who invited this address and who took it back" stays answerable.
 *
 * The UPDATE carries the full guard in its `WHERE` (vendor scope + still
 * pending), not just the id: the handler has already proven scope, but a guarded
 * predicate is what makes a concurrent double-revoke a no-op rather than a
 * second audit row claiming a state change that didn't happen.
 */
export function revokeInviteStatements(db: Db, p: RevokeInviteParams): SeatInviteBatch {
  const auditEntry: AuditLogEntry = {
    actorId: p.actorId,
    actorType: p.actorType,
    action: 'vendor_seat.invite_revoked',
    entityType: 'vendor_seat_invite',
    entityId: p.inviteId,
    beforeState: { revoked_at: null },
    afterState: { revoked_at: p.now },
    metadata: {
      source: SEAT_INVITE_AUDIT_SOURCE,
      vendor_id: p.vendorId,
      invited_email: p.email,
    },
  };

  return {
    stmts: [
      db
        .update(vendorSeatInvites)
        .set({ revokedAt: p.now, updatedAt: p.now })
        .where(
          and(
            eq(vendorSeatInvites.id, p.inviteId),
            eq(vendorSeatInvites.vendorId, p.vendorId),
            isNull(vendorSeatInvites.acceptedAt),
            isNull(vendorSeatInvites.revokedAt),
          ),
        ),
      auditInsert(db, auditEntry),
    ],
    auditEntry,
  };
}

export interface AcceptInviteParams {
  inviteId: string;
  vendorId: string;
  email: string;
  /** The REDEEMER — resolved from the verified JWT `sub`, never from the body. */
  userId: string;
  actorType: AuditLogEntry['actorType'];
  now: string;
  /** Is the invited address on the vendor's own registrable domain? The caller
   *  computes it with `computeDomainMatch`; it decides `work_email_verified` and
   *  nothing else — it is a signal, never a gate (docblock property 2). */
  domainMatched: boolean;
  /** The redeemer's `profiles` row before the write; `null` if they have none yet
   *  (possible even for a signed-in user — `profile-ensure` is non-fatal).
   *  `seatOwner` and `workEmailVerified` are read so redeeming can only ever ADD
   *  to a profile, never strip a bit it already earned — see properties 1 and 2. */
  profileBefore: {
    role: string;
    vendorId: string | null;
    seatOwner: boolean;
    workEmailVerified: boolean;
  } | null;
}

/**
 * Redeem an invite: attach the seat and spend the invite, atomically.
 *
 * Three properties worth stating because each is a bug if it drifts:
 *
 * 1. **A NEW invited seat is not an owner.** The insert sets `seatOwner: false`;
 *    without it a single AECi-reviewed human seeds an unbounded chain of seats
 *    that no reviewer ever saw, which is precisely the risk §11a's owner bit
 *    exists to bound. But redeeming must never DEMOTE: an existing owner who
 *    happens to redeem an invite (they were re-invited, or self-invited — the
 *    invite path cannot cheaply tell they already hold a seat) keeps their bit,
 *    so the conflict path preserves `profileBefore.seatOwner` rather than forcing
 *    it false. Forcing it false there could strip the only owner and leave the
 *    vendor unadministrable — the exact state the removal path's last-owner guard
 *    protects.
 * 2. **`workEmailVerified` follows the DOMAIN, not the redeem.** Redeeming proves
 *    control of the invited mailbox and nothing more; since the invite domain gate
 *    was removed (§11a.3) an owner may invite any address, so "they signed in" no
 *    longer implies "they work there". The caller therefore passes
 *    `domainMatched` — `computeDomainMatch(invite.email, vendors.website)`,
 *    evaluated at redeem time against the address actually being redeemed — and
 *    only a match writes the column. Setting it unconditionally would quietly
 *    corrupt the one place it is read: the §5 claim queue renders it to a human as
 *    "work email verified" while they decide whether a claimant really works
 *    there. Like `seatOwner` it is never cleared — a profile that already earned
 *    the bit keeps it.
 * 3. **The accept UPDATE is guarded on still-pending.** Redeeming is single-use,
 *    and two concurrent redeems of one token must produce one seat and one audit
 *    row, not two. The guard is what makes the second a no-op instead of a
 *    silent re-grant.
 *
 * The profile write is an upsert for the same reason `grantSeatStatements`' is:
 * a signed-in user may still have no `profiles` row (`profile-ensure` swallows
 * its failures), and a plain UPDATE would report success having changed nothing.
 */
export function acceptInviteStatements(db: Db, p: AcceptInviteParams): SeatInviteBatch {
  // A brand-new seat is never an owner; an EXISTING seat keeps whatever it had, so
  // redeeming can only ever add access, never strip an owner's management bit.
  const resultingSeatOwner = p.profileBefore?.seatOwner ?? false;
  // Same direction of travel: an on-domain redeem EARNS the bit, and an off-domain
  // one never takes back a bit the profile already had.
  const resultingWorkEmailVerified =
    p.domainMatched || (p.profileBefore?.workEmailVerified ?? false);

  const auditEntry: AuditLogEntry = {
    actorId: p.userId,
    actorType: p.actorType,
    action: 'vendor_seat.invite_accepted',
    entityType: 'profile',
    entityId: p.userId,
    beforeState: {
      role: p.profileBefore?.role ?? null,
      vendor_id: p.profileBefore?.vendorId ?? null,
    },
    afterState: {
      role: VENDOR_ADMIN_ROLE,
      vendor_id: p.vendorId,
      seat_owner: resultingSeatOwner,
      work_email_verified: resultingWorkEmailVerified,
    },
    metadata: {
      source: SEAT_INVITE_AUDIT_SOURCE,
      vendor_id: p.vendorId,
      invite_id: p.inviteId,
      invited_email: p.email,
      seat_created: p.profileBefore === null,
    },
  };

  return {
    stmts: [
      db
        .insert(profiles)
        .values({
          id: p.userId,
          role: VENDOR_ADMIN_ROLE,
          vendorId: p.vendorId,
          seatOwner: false,
          workEmailVerified: resultingWorkEmailVerified,
        })
        .onConflictDoUpdate({
          target: profiles.id,
          set: {
            role: VENDOR_ADMIN_ROLE,
            vendorId: p.vendorId,
            // Preserve, never demote — see property 1. Only a brand-new seat
            // (the insert branch) is forced to a non-owner.
            seatOwner: resultingSeatOwner,
            workEmailVerified: resultingWorkEmailVerified,
            updatedAt: p.now,
          },
        }),
      db
        .update(vendorSeatInvites)
        .set({ acceptedAt: p.now, updatedAt: p.now })
        .where(
          and(
            eq(vendorSeatInvites.id, p.inviteId),
            isNull(vendorSeatInvites.acceptedAt),
            isNull(vendorSeatInvites.revokedAt),
          ),
        ),
      auditInsert(db, auditEntry),
    ],
    auditEntry,
  };
}

/** The "is this address already invited here?" predicate — the pending partial
 *  index's exact shape, shared by the duplicate probe and the roster read so the
 *  two can never disagree about what "pending" means. */
export function pendingInvitesFor(vendorId: string) {
  return and(
    eq(vendorSeatInvites.vendorId, vendorId),
    isNull(vendorSeatInvites.acceptedAt),
    isNull(vendorSeatInvites.revokedAt),
  );
}
