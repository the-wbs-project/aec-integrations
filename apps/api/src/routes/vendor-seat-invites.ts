/**
 * The OWNER half of vendor seat management (AECI-664 /
 * `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §11a) — invite, un-invite, remove:
 *
 *   POST   /api/vendor/seats/invites      — invite a colleague (201).
 *   DELETE /api/vendor/seats/invites/:id  — revoke a pending invite (204).
 *   DELETE /api/vendor/seats/:userId      — remove a seat (204).
 *
 * The INVITEE half is `routes/seat-invites.ts`, and it lives on a different path
 * prefix for a load-bearing reason: a redeemer is not a `vendor_admin` yet, so it
 * cannot sit behind `requireVendor()`. Guards are per-route here, so a
 * `requireAuth()` route under `/api/vendor/*` would work — and would be a trap the
 * next person to add a prefix-level guard falls into.
 *
 * ── THE THREE GATES, IN ORDER ───────────────────────────────────────────────
 * 1. `requireVendor()` — establishes WHICH vendor is calling (`c.get('auth')`).
 * 2. `requireSeatOwner()` — `profiles.seat_owner`, re-read from D1 this request
 *    (never trusted from the client, never cached on the token). Non-owners 403.
 * 3. A `vendor_id` filter on every statement. There is no RLS (ADR 0016), so this
 *    IS the authorization, not a belt on top of one.
 *
 * ── DELIBERATELY NOT ENTITLEMENT-GATED ──────────────────────────────────────
 * No `requireCapability` call anywhere in this file. Seats are not a paid feature
 * — there is no seat capability in the frozen registry and no seat cap — and §3
 * already establishes that clearing an entitlement does not revoke seats. Gating
 * removal on a live entitlement would mean a lapsed vendor cannot revoke a
 * departed employee's access, which is a security regression wearing a billing
 * lever's clothes. See §11a.
 */

import {
  ApiErrorCode,
  CreateSeatInviteSchema,
  CreateSeatInviteResponseSchema,
  type CreateSeatInviteResponse,
} from '@aeci/shared';
import { and, count, eq, gte } from 'drizzle-orm';

import { getDb } from '../db/client';
import { profiles, vendorSeatInvites, vendors } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditActorType } from '../lib/authz';
import { computeDomainMatch } from '../lib/domain-match';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import { VENDOR_ADMIN_ROLE } from '../lib/claimed-vendors';
import {
  createInviteStatements,
  inviteExpiryFrom,
  normalizeInviteEmail,
  pendingInvitesFor,
  revokeInviteStatements,
  INVITE_DAILY_LIMIT,
} from '../lib/vendor-seat-invites';
import { revokeSeatStatements } from '../lib/vendor-grant';
import type { BatchTuple } from '../lib/audit';
import { afterVendorWrite, sessionVendorId, type VendorContext } from './vendor-shared';

/** Injected send seam (the `SendClaimDecisionEmail` shape, AECI-519/528): the
 *  in-handler default is a no-op so the handler is unit-testable with no Resend,
 *  and `index.ts` injects the real sender at route registration. */
export type SendSeatInviteEmail = (
  c: VendorContext,
  opts: {
    to: string;
    vendorName: string;
    invitedByName: string | null;
    token: string;
    expiresAt: string;
  },
) => Promise<void>;

const noopSendSeatInviteEmail: SendSeatInviteEmail = async () => {};

/** A required path param. Present by routing, but Hono types it optional — the
 *  `versionIdParam` guard shape from `vendor-product-versions.ts`. */
function requiredParam(c: VendorContext, name: string): string {
  const value = c.req.param(name);
  if (!value) {
    throw new ApiError(400, ApiErrorCode.VALIDATION_FAILED, `Missing ${name}`, { field: name });
  }
  return value;
}

/**
 * Gate 2. Re-reads `seat_owner` from D1 rather than reading anything off the
 * session, for the same reason `createAuthzMiddleware` re-reads `banned_at` every
 * request: a demotion has to take effect on the caller's NEXT call, not whenever
 * their token happens to expire.
 *
 * Returns the owner's `display_name` because the invite email names the sender
 * and this read is already paid for.
 */
async function requireSeatOwner(
  db: ReturnType<DbFactory>['db'],
  userId: string,
  vendorId: string,
): Promise<{ displayName: string | null }> {
  const row = await db.query.profiles.findFirst({
    columns: { displayName: true, seatOwner: true },
    where: and(
      eq(profiles.id, userId),
      eq(profiles.vendorId, vendorId),
      eq(profiles.role, VENDOR_ADMIN_ROLE),
    ),
  });
  if (!row?.seatOwner) {
    throw new ApiError(403, ApiErrorCode.FORBIDDEN, 'Only a vendor account owner can manage seats');
  }
  return { displayName: row.displayName };
}

// ─── POST /api/vendor/seats/invites ──────────────────────────────────────────

export function createSeatInviteHandler(
  dbFor: DbFactory = getDb,
  sendEmail: SendSeatInviteEmail = noopSendSeatInviteEmail,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const auth = c.get('auth');
    const vendorId = sessionVendorId(c);
    const { db } = dbFor(c.env);

    const owner = await requireSeatOwner(db, auth.userId, vendorId);
    const input = CreateSeatInviteSchema.parse(await c.req.json().catch(() => null));
    const email = normalizeInviteEmail(input.email);

    const vendor = await db.query.vendors.findFirst({
      columns: { id: true, companyName: true, website: true },
      where: eq(vendors.id, vendorId),
    });
    // The guard proved the session's `vendor_id`; a missing row here is a broken
    // FK, not a caller error.
    if (!vendor) throw notFoundError('vendor', { id: vendorId });

    // ── The domain gate (§11a). `match` is the ONLY self-serve outcome. ──────
    // `no_match` and `manual_review` (a freemail address, an agency, a subsidiary,
    // or a vendor with no `website` on file) both fall back to the existing §5
    // claim queue, where a human already weighs exactly this question. Refusing
    // here writes NO row and sends NO mail, so a rejected attempt leaves nothing
    // behind to clean up.
    if (computeDomainMatch(email, vendor.website) !== 'match') {
      throw new ApiError(
        422,
        ApiErrorCode.INVITE_DOMAIN_MISMATCH,
        'Seat invites are limited to email addresses on your own company domain',
      );
    }

    // A second LIVE invite for one address is a no-op dressed as an action.
    //
    // Note what is deliberately NOT checked: whether that address already holds a
    // seat. Seats are keyed by `auth.users` id, and the only email→id lookup is
    // the GoTrue seam, which needs `SUPABASE_SERVICE_ROLE_KEY` — the one
    // dependency this whole path exists to avoid. Re-inviting an existing
    // colleague is harmless anyway: the accept upsert lands on the same values it
    // already has, and the owner can see who is on the roster right above the
    // form. Buying a redundant check with a hard dependency on a key that is
    // absent in local dev and on every PR preview is the wrong trade.
    const existingInvite = await db.query.vendorSeatInvites.findFirst({
      columns: { id: true },
      where: and(pendingInvitesFor(vendorId), eq(vendorSeatInvites.email, email)),
    });

    if (existingInvite) {
      throw new ApiError(
        409,
        ApiErrorCode.GRANT_CONFLICT,
        'That address already has a pending invite for this vendor',
      );
    }

    // Rate limit: per-vendor invites in the rolling 24h, counted over the table we
    // already have rather than a KV counter or a new binding. This endpoint sends
    // mail on a customer's command, which is the classic abuse amplifier.
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const [recent] = await db
      .select({ value: count() })
      .from(vendorSeatInvites)
      .where(
        and(eq(vendorSeatInvites.vendorId, vendorId), gte(vendorSeatInvites.createdAt, since)),
      );
    if ((recent?.value ?? 0) >= INVITE_DAILY_LIMIT) {
      throw new ApiError(
        429,
        ApiErrorCode.RATE_LIMITED,
        'Too many invites sent today. Try again tomorrow.',
      );
    }

    const now = new Date().toISOString();
    const expiresAt = inviteExpiryFrom(now);
    const inviteId = crypto.randomUUID();
    const token = crypto.randomUUID();

    const batch = createInviteStatements(db, {
      inviteId,
      token,
      vendorId,
      email,
      actorId: auth.userId,
      actorType: auditActorType(auth),
      now,
      expiresAt,
    });
    await db.batch(batch.stmts as BatchTuple);

    // Post-commit, best-effort. A send failure must never un-create a committed
    // invite: the owner can revoke and re-send, and the roster shows it pending
    // either way. No cache purge — nothing on this path renders on a cached page.
    afterVendorWrite(c, [], batch.auditEntry);
    c.executionCtx.waitUntil(
      sendEmail(c, {
        to: email,
        vendorName: vendor.companyName,
        invitedByName: owner.displayName,
        token,
        expiresAt,
      }),
    );

    const body: CreateSeatInviteResponse = {
      invite: {
        id: inviteId,
        email,
        invited_by: owner.displayName,
        expires_at: expiresAt,
        created_at: now,
      },
    };
    validateResponseInDev(c.env, () => CreateSeatInviteResponseSchema.parse(body));
    return json(body, { status: 201 });
  };
}

// ─── DELETE /api/vendor/seats/invites/:id ────────────────────────────────────

export function createRevokeSeatInviteHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const auth = c.get('auth');
    const vendorId = sessionVendorId(c);
    const { db } = dbFor(c.env);
    await requireSeatOwner(db, auth.userId, vendorId);

    const inviteId = requiredParam(c, 'id');
    const invite = await db.query.vendorSeatInvites.findFirst({
      columns: { id: true, email: true, acceptedAt: true, revokedAt: true },
      where: and(pendingInvitesFor(vendorId), eq(vendorSeatInvites.id, inviteId)),
    });
    // A spent or cross-vendor invite is a 404, not a 403 — the vendor-portal rule
    // (`routes/vendor.ts`): a miss never reveals that the id exists elsewhere.
    if (!invite) throw notFoundError('seat_invite', { id: inviteId });

    const now = new Date().toISOString();
    const batch = revokeInviteStatements(db, {
      inviteId,
      vendorId,
      email: invite.email,
      actorId: auth.userId,
      actorType: auditActorType(auth),
      now,
    });
    await db.batch(batch.stmts as BatchTuple);
    afterVendorWrite(c, [], batch.auditEntry);

    return new Response(null, { status: 204 });
  };
}

// ─── DELETE /api/vendor/seats/:userId ────────────────────────────────────────

/**
 * Remove a seat — the vendor-side counterpart to AECi's ban action, and the first
 * HTTP surface `revokeSeatStatements` has ever had (AECI-524 shipped it unwired).
 *
 * Two refusals, both about not stranding the account:
 *
 * - **You cannot remove yourself.** Mirrors the admin ban guardrail. Someone
 *   leaving hands over first; self-removal is a support conversation, not a
 *   button that can silently orphan a vendor.
 * - **You cannot remove the last owner.** Every vendor must retain at least one
 *   seat that can manage seats, or the account becomes unadministrable and only
 *   an AECi grant can rescue it.
 *
 * Note that the second guard is **currently unreachable, and kept deliberately**.
 * The invariant it protects is already implied by the other two rules: only an
 * owner may remove, and no one may remove themselves — so any removal of an owner
 * proves a second owner exists. It stays because it is the invariant stated
 * DIRECTLY rather than as an emergent property of two unrelated rules; the day
 * self-removal is allowed (a plausible feature: "leave this vendor"), this is the
 * line that keeps the account administrable, and its absence would be found in
 * production rather than in review.
 */
export function createRemoveSeatHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const auth = c.get('auth');
    const vendorId = sessionVendorId(c);
    const { db } = dbFor(c.env);
    await requireSeatOwner(db, auth.userId, vendorId);

    const targetId = requiredParam(c, 'userId');
    if (targetId === auth.userId) {
      throw new ApiError(422, ApiErrorCode.FORBIDDEN, 'You cannot remove your own seat');
    }

    const target = await db.query.profiles.findFirst({
      columns: { id: true, role: true, vendorId: true, seatOwner: true },
      where: and(
        eq(profiles.id, targetId),
        eq(profiles.vendorId, vendorId),
        eq(profiles.role, VENDOR_ADMIN_ROLE),
      ),
    });
    if (!target) throw notFoundError('seat', { id: targetId });

    if (target.seatOwner) {
      const [owners] = await db
        .select({ value: count() })
        .from(profiles)
        .where(
          and(
            eq(profiles.vendorId, vendorId),
            eq(profiles.role, VENDOR_ADMIN_ROLE),
            eq(profiles.seatOwner, true),
          ),
        );
      if ((owners?.value ?? 0) <= 1) {
        throw new ApiError(
          422,
          ApiErrorCode.FORBIDDEN,
          'This is the last owner seat — it cannot be removed',
        );
      }
    }

    const now = new Date().toISOString();
    const batch = revokeSeatStatements(db, {
      userId: targetId,
      vendorId,
      actorId: auth.userId,
      actorType: auditActorType(auth),
      now,
      profileBefore: { role: target.role, vendorId: target.vendorId },
      source: 'vendor-portal',
    });

    // No invite sweep is needed here, and its absence is deliberate rather than an
    // omission: an invite this seat REDEEMED is already `accepted_at`-stamped (so
    // no longer pending), and the duplicate probe above prevents a second live
    // invite for an address. Invites this seat SENT survive on purpose — they
    // belong to the invitees, not to whoever happened to type them.
    await db.batch(batch.stmts as BatchTuple);
    afterVendorWrite(c, [], batch.auditEntry);

    return new Response(null, { status: 204 });
  };
}
