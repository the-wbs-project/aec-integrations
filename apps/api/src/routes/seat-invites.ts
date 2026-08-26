/**
 * The INVITEE half of vendor seat management (AECI-664 /
 * `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §11a):
 *
 *   GET  /api/seat-invites/:token         — what am I being invited to?
 *   POST /api/seat-invites/:token/accept  — redeem it.
 *
 * ── WHY NOT `/api/vendor/*` ─────────────────────────────────────────────────
 * The caller here is BY DEFINITION not a `vendor_admin` yet — that is the whole
 * point of the endpoint — so neither route can sit behind `requireVendor()`.
 * Guards are per-route in `index.ts`, so mounting a `requireAuth()` route under
 * the vendor prefix would work today and silently break the first time anyone
 * adds a prefix-level guard, which is exactly the kind of trap that is cheap to
 * avoid and expensive to debug. The owner-side endpoints stay on `/api/vendor/*`
 * where they belong.
 *
 * ── THE TOKEN IS NOT A CREDENTIAL ───────────────────────────────────────────
 * Both routes require a signed-in session (`requireAuth()`), and the accept path
 * additionally requires the session's VERIFIED email to equal the invited
 * address. So the token identifies an invite; it never authorizes one. A
 * forwarded link, a link in a shared inbox, a link pasted into a ticket — none of
 * them grant anything without control of that mailbox, proven through the
 * ordinary Supabase sign-in. This is why the token can safely live in a URL, and
 * why nothing on this path ever creates an account.
 *
 * ── WHY GET IS A READ AND ACCEPT IS A POST ──────────────────────────────────
 * The emailed link lands on a PAGE, and mail scanners, link-preview bots and
 * corporate URL rewriters all fetch what they are sent. A GET that redeemed
 * would be redeemed by the invitee's own security appliance before they ever
 * clicked. The GET therefore only describes; the mutation is a POST the page
 * makes after a human acts — the same confirm-then-POST discipline as
 * `/unsubscribe` (AECI-537).
 */

import {
  ApiErrorCode,
  AcceptSeatInviteResponseSchema,
  SeatInvitePreviewSchema,
  type AcceptSeatInviteResponse,
  type SeatInvitePreview,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import { profiles, vendors, vendorSeatInvites } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import type { BatchTuple } from '../lib/audit';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import { computeDomainMatch } from '../lib/domain-match';
import { acceptInviteStatements, inviteRedeemState } from '../lib/vendor-seat-invites';
import { afterVendorWrite } from './vendor-shared';

type InviteContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

/** The path's opaque token. Present by routing, but Hono types it optional —
 *  same guard shape as `versionIdParam` in `vendor-product-versions.ts`. */
function tokenParam(c: InviteContext): string {
  const token = c.req.param('token');
  if (!token) {
    throw new ApiError(400, ApiErrorCode.VALIDATION_FAILED, 'Missing invite token', {
      field: 'token',
    });
  }
  return token;
}

/**
 * One indexed read on the unique `token`, joined to its vendor for the display
 * name. Returns `null` for an unknown token — the caller turns that into a 404,
 * which is the same answer a revoked-then-forgotten token gets, so probing tells
 * an attacker nothing.
 */
async function loadInvite(db: ReturnType<DbFactory>['db'], token: string) {
  // An explicit `innerJoin`, not a relational `with:` — `vendorSeatInvites` has no
  // `relations()` entry, matching every other ops/ledger table here
  // (`vendor_entitlements`, `audit_log`, `vendor_requests`). One statement either
  // way; this one needs no schema surface.
  const [row] = await db
    .select({
      id: vendorSeatInvites.id,
      vendorId: vendorSeatInvites.vendorId,
      email: vendorSeatInvites.email,
      expiresAt: vendorSeatInvites.expiresAt,
      acceptedAt: vendorSeatInvites.acceptedAt,
      revokedAt: vendorSeatInvites.revokedAt,
      vendorSlug: vendors.slug,
      vendorName: vendors.companyName,
      // Not displayed anywhere — it feeds `computeDomainMatch` on the accept path
      // (see `work_email_verified` below). Free here: the join is already made.
      vendorWebsite: vendors.website,
    })
    .from(vendorSeatInvites)
    .innerJoin(vendors, eq(vendors.id, vendorSeatInvites.vendorId))
    .where(eq(vendorSeatInvites.token, token))
    .limit(1);
  return row ?? null;
}

// ─── GET /api/seat-invites/:token ────────────────────────────────────────────

export function createSeatInvitePreviewHandler(
  dbFor: DbFactory = getDb,
): (c: InviteContext) => Promise<Response> {
  return async (c) => {
    const { db } = dbFor(c.env);
    const invite = await loadInvite(db, tokenParam(c));
    if (!invite) throw notFoundError('seat_invite', {});

    const state = inviteRedeemState(invite, new Date().toISOString(), c.get('auth').email);

    const body: SeatInvitePreview = {
      vendor_name: invite.vendorName,
      email: invite.email,
      expires_at: invite.expiresAt,
      redeemable: state === 'ok',
      reason: state,
    };
    validateResponseInDev(c.env, () => SeatInvitePreviewSchema.parse(body));
    return json(body);
  };
}

// ─── POST /api/seat-invites/:token/accept ────────────────────────────────────

export function createAcceptSeatInviteHandler(
  dbFor: DbFactory = getDb,
): (c: InviteContext) => Promise<Response> {
  return async (c) => {
    const auth = c.get('auth');
    const { db } = dbFor(c.env);
    const invite = await loadInvite(db, tokenParam(c));
    // Deliberately no identifier in the 404 details: the token IS the identifier,
    // and echoing it would put a redeem handle into an error body that logs.
    if (!invite) throw notFoundError('seat_invite', {});

    const now = new Date().toISOString();
    // ONE source of the redeem verdict, shared with the preview above. If the two
    // ever computed it separately they would eventually disagree, and the
    // direction that fails is "the page said you could, the write says you can't".
    const state = inviteRedeemState(invite, now, auth.email);
    if (state !== 'ok') {
      // 422 for every non-`ok` state, including the mismatch: this is a
      // well-formed request against a real invite that is not redeemable BY THIS
      // CALLER. A 403 would invite a client to retry with different credentials,
      // which is not a thing that can help here.
      throw new ApiError(
        422,
        state === 'email_mismatch' ? ApiErrorCode.FORBIDDEN : ApiErrorCode.INVALID_STATE_TRANSITION,
        state === 'email_mismatch'
          ? 'This invite was sent to a different email address'
          : `This invite is no longer valid (${state})`,
      );
    }

    // Exclusivity, the same rule the §2 claim path enforces and for the same
    // reason: `role`/`vendor_id` are single-valued. A site admin never takes a
    // vendor seat (there is no impersonation at launch), and one account belongs
    // to one vendor — a multi-vendor person uses separate accounts. Both are
    // EXPLICIT errors, never a silent overwrite of an existing linkage.
    const before = await db.query.profiles.findFirst({
      columns: { role: true, vendorId: true, seatOwner: true, workEmailVerified: true },
      where: eq(profiles.id, auth.userId),
    });
    if (before?.role === 'admin') {
      throw new ApiError(
        409,
        ApiErrorCode.GRANT_CONFLICT,
        'A site admin account cannot hold a vendor seat',
      );
    }
    if (before?.vendorId != null && before.vendorId !== invite.vendorId) {
      throw new ApiError(
        409,
        ApiErrorCode.GRANT_CONFLICT,
        'This account is already linked to a different vendor',
      );
    }

    // `work_email_verified` is decided HERE rather than by the invite handler,
    // because since §11a.3 dropped the invite-time domain gate an invited address
    // may legitimately be off-domain (an agency, a subsidiary, a contractor). The
    // bit means "this account proved control of an address on the vendor's own
    // domain" and is read by a human on the §5 claim queue, so it has to track the
    // address actually redeemed — not the mere fact that a redeem happened.
    const domainMatched = computeDomainMatch(invite.email, invite.vendorWebsite) === 'match';

    const batch = acceptInviteStatements(db, {
      inviteId: invite.id,
      vendorId: invite.vendorId,
      email: invite.email,
      userId: auth.userId,
      actorType: auditActorType(auth),
      now,
      domainMatched,
      profileBefore: before
        ? {
            role: before.role,
            vendorId: before.vendorId,
            seatOwner: before.seatOwner,
            workEmailVerified: before.workEmailVerified,
          }
        : null,
    });
    await db.batch(batch.stmts as BatchTuple);
    // Post-commit forward (§26.5). No cache tags: a seat change renders on no
    // cacheable page — the portal is `private, no-store` by the fail-closed
    // classifier, and `vendors.verified` is untouched by design (§8.3(2)).
    afterVendorWrite(c, [], batch.auditEntry);

    const body: AcceptSeatInviteResponse = {
      vendor_slug: invite.vendorSlug,
      vendor_name: invite.vendorName,
    };
    validateResponseInDev(c.env, () => AcceptSeatInviteResponseSchema.parse(body));
    return json(body);
  };
}
