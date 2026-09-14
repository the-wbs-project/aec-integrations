/**
 * Seat invite/accept/remove handler coverage (AECI-664 / §11a) — real handlers
 * over one real D1, with `c.set('auth', …)` stubbed the way `vendor.spec.ts`
 * does.
 *
 * The cases that earn their keep are the refusals. An invite flow that works is
 * easy; an invite flow that cannot be turned into unauthorized access is the
 * product, so most of this file is about what must NOT happen: a non-owner
 * writing, a wrong-address redeem, a second redeem, a cross-vendor id, and the
 * guards that stop an account being stranded without an administrator.
 */

import { ListVendorSeatsResponseSchema } from '@aeci/shared';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, profiles, vendorSeatInvites, vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { INVITE_MAX_SENDS } from '../lib/vendor-seat-invites';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { createAcceptSeatInviteHandler, createSeatInvitePreviewHandler } from './seat-invites';
import {
  createRemoveSeatHandler,
  createResendSeatInviteHandler,
  createRevokeSeatInviteHandler,
  createSeatInviteHandler,
} from './vendor-seat-invites';
import { createVendorSeatsHandler } from './vendor';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const VENDOR = uuid(1);
const OTHER_VENDOR = uuid(2);
const OWNER = uuid(100);
const MEMBER = uuid(101);
const OWNER_2 = uuid(102);
const OUTSIDER = uuid(200);

let t: TestDb;
const sent = vi.fn();

const session = (over: Partial<AuthzVariables['auth']> = {}): AuthzVariables['auth'] => ({
  userId: OWNER,
  email: 'owner@acme.com',
  role: 'vendor_admin',
  vendorId: VENDOR,
  entitlementTier: 'verified',
  entitlement: { status: 'active', periodEnd: null },
  ...over,
});

const OWNER_SESSION = session();
const MEMBER_SESSION = session({ userId: MEMBER, email: 'member@acme.com' });

beforeEach(async () => {
  t = await makeTestDb();
  sent.mockReset();
  sent.mockResolvedValue(undefined);

  await t.db.insert(vendors).values([
    { id: VENDOR, slug: 'acme', companyName: 'Acme', website: 'https://www.acme.com/' },
    { id: OTHER_VENDOR, slug: 'globex', companyName: 'Globex', website: 'https://globex.com' },
  ]);
  await t.db.insert(profiles).values([
    { id: OWNER, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true, displayName: 'Dana' },
    { id: MEMBER, role: 'vendor_admin', vendorId: VENDOR, seatOwner: false, displayName: 'Sam' },
    { id: OUTSIDER, role: 'reviewer', vendorId: null },
  ]);
});
afterEach(() => t.dispose());

function app() {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set(
      'auth',
      (c.req.raw as Request & { __auth?: AuthzVariables['auth'] }).__auth ?? OWNER_SESSION,
    );
    await next();
  });
  a.get(
    '/api/vendor/seats',
    createVendorSeatsHandler(t.factory, async () => new Map()),
  );
  a.post('/api/vendor/seats/invites', createSeatInviteHandler(t.factory, sent));
  a.post('/api/vendor/seats/invites/:id/resend', createResendSeatInviteHandler(t.factory, sent));
  a.delete('/api/vendor/seats/invites/:id', createRevokeSeatInviteHandler(t.factory));
  a.delete('/api/vendor/seats/:userId', createRemoveSeatHandler(t.factory));
  a.get('/api/seat-invites/:token', createSeatInvitePreviewHandler(t.factory));
  a.post('/api/seat-invites/:token/accept', createAcceptSeatInviteHandler(t.factory));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function call(
  path: string,
  init: RequestInit = {},
  auth: AuthzVariables['auth'] = OWNER_SESSION,
): Promise<{ status: number; body: JsonBody; headers: Headers }> {
  const req = new Request(`http://x${path}`, init) as Request & { __auth?: AuthzVariables['auth'] };
  req.__auth = auth;
  const execCtx = fakeExecutionContext();
  const res = await app().fetch(req, TEST_ENV, execCtx);
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  const body = res.status === 204 ? {} : await res.json();
  // `headers` is here for the one assertion that needs it: `Retry-After` is a
  // HEADER, never a body field (`errors.ts` — one field, one formatting site).
  return { status: res.status, body: body as JsonBody, headers: res.headers };
}

const resend = (inviteId: string, auth = OWNER_SESSION) =>
  call(`/api/vendor/seats/invites/${inviteId}/resend`, { method: 'POST' }, auth);

const invite = (email: string, auth = OWNER_SESSION) =>
  call(
    '/api/vendor/seats/invites',
    {
      method: 'POST',
      body: JSON.stringify({ email }),
      headers: { 'content-type': 'application/json' },
    },
    auth,
  );

async function seedInvite(over: Partial<typeof vendorSeatInvites.$inferInsert> = {}) {
  const row = {
    id: uuid(900),
    vendorId: VENDOR,
    email: 'dana@acme.com',
    token: 'tok-1',
    invitedById: OWNER,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...over,
  };
  await t.db.insert(vendorSeatInvites).values(row);
  return row;
}

describe('POST /api/vendor/seats/invites', () => {
  it('an owner invites a same-domain colleague and the mail is sent post-commit', async () => {
    const res = await invite('Dana@ACME.com');
    expect(res.status).toBe(201);
    // Normalized on the way in — the redeem comparison is exact.
    expect(res.body.invite.email).toBe('dana@acme.com');
    expect(res.body.invite.invited_by).toBe('Dana');

    const rows = await t.db.select().from(vendorSeatInvites);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.acceptedAt).toBeNull();
    expect(sent).toHaveBeenCalledOnce();
    // The token goes to the mail and nowhere else — never to the response body.
    expect(sent.mock.calls[0]![1].token).toBe(rows[0]!.token);
    expect(JSON.stringify(res.body)).not.toContain(rows[0]!.token);
  });

  it('writes its audit row in the same batch (§26.1)', async () => {
    await invite('dana@acme.com');
    const rows = await t.db.select().from(auditLog);
    expect(rows.map((r) => r.action)).toContain('vendor_seat.invited');
    expect((rows[0]!.metadata as { source: string }).source).toBe('vendor-portal');
  });

  it('invites an OFF-DOMAIN address — the domain gate was removed (§11a.3)', async () => {
    // The case the gate used to refuse: an agency, a contractor, a subsidiary, or
    // simply someone whose mail is not on the corporate domain. The owner is the
    // one who knows who maintains the listing.
    const res = await invite('dana@gmail.com');
    expect(res.status).toBe(201);
    expect(res.body.invite.email).toBe('dana@gmail.com');
    expect(sent).toHaveBeenCalledOnce();
  });

  it('invites even when the vendor has no website on file', async () => {
    await t.db.update(vendors).set({ website: null }).where(eq(vendors.id, VENDOR));
    // Used to be a 422 (`manual_review` is not `match`), which punished a vendor
    // for a gap in OUR catalog data.
    expect((await invite('dana@acme.com')).status).toBe(201);
  });

  it('REFUSES a non-owner seat (403), not just hides the button', async () => {
    const res = await invite('dana@acme.com', MEMBER_SESSION);
    expect(res.status).toBe(403);
    expect(await t.db.select().from(vendorSeatInvites)).toHaveLength(0);
  });

  it('refuses a second live invite for one address (409)', async () => {
    await seedInvite();
    const res = await invite('dana@acme.com');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('GRANT_CONFLICT');
  });

  it('allows a re-invite once the previous one is revoked', async () => {
    await seedInvite({ revokedAt: new Date().toISOString() });
    expect((await invite('dana@acme.com')).status).toBe(201);
  });

  it('allows a re-invite once the previous one EXPIRED (AECI-927 regression)', async () => {
    // The defect: the duplicate probe used `pendingInvitesFor`, which is blind to
    // expiry, while the roster has always hidden expired rows. So a lapsed invite
    // 409'd every future invite to that address while being invisible — the owner
    // could not see it, revoke it, or re-send it. Permanently stuck.
    await seedInvite({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect((await invite('dana@acme.com')).status).toBe(201);
    expect(await t.db.select().from(vendorSeatInvites)).toHaveLength(2);
  });

  it('rate-limits per vendor per day (429)', async () => {
    for (let i = 0; i < 10; i++) {
      await seedInvite({ id: uuid(800 + i), token: `t${i}`, email: `p${i}@acme.com` });
    }
    const res = await invite('new@acme.com');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(sent).not.toHaveBeenCalled();
  });

  it('does not count another vendor toward this vendor’s limit', async () => {
    for (let i = 0; i < 10; i++) {
      await seedInvite({
        id: uuid(700 + i),
        token: `o${i}`,
        vendorId: OTHER_VENDOR,
        email: `p${i}@globex.com`,
      });
    }
    expect((await invite('dana@acme.com')).status).toBe(201);
  });
});

describe('POST /api/vendor/seats/invites/:id/resend (AECI-927)', () => {
  /** Past the 5-minute cooldown, so the default seed is re-sendable. */
  const COOLED = () => new Date(Date.now() - 10 * 60_000).toISOString();

  it('re-sends the SAME token, refreshes expiry, and counts the send', async () => {
    const seeded = await seedInvite({ createdAt: COOLED(), sendCount: 1 });
    const before = seeded.expiresAt;

    const res = await resend(seeded.id);
    expect(res.status).toBe(200);

    // The token is NOT rotated: the invitee may already be holding that link, and
    // the redeem is bound to their mailbox rather than to the token's secrecy.
    expect(sent).toHaveBeenCalledOnce();
    expect(sent.mock.calls[0]![1].token).toBe('tok-1');
    // ...and it still never reaches the response body.
    expect(JSON.stringify(res.body)).not.toContain('tok-1');

    const [row] = await t.db.select().from(vendorSeatInvites);
    expect(row!.token).toBe('tok-1');
    expect(row!.sendCount).toBe(2);
    expect(row!.lastSentAt).not.toBeNull();
    // Expiry moves forward, or an invite re-sent on day 13 is barely worth sending.
    expect(Date.parse(row!.expiresAt)).toBeGreaterThan(Date.parse(before));
    expect(res.body.invite.expires_at).toBe(row!.expiresAt);
    // Just sent, so the surface's control must come back disabled.
    expect(res.body.invite.resend_state).toBe('cooling_down');
  });

  it('writes its audit row in the same batch (§26.1)', async () => {
    const seeded = await seedInvite({ createdAt: COOLED() });
    await resend(seeded.id);

    const rows = await t.db.select().from(auditLog);
    const entry = rows.find((r) => r.action === 'vendor_seat.invite_resent');
    expect(entry).toBeDefined();
    expect(entry!.entityType).toBe('vendor_seat_invite');
    expect(entry!.entityId).toBe(seeded.id);
    expect((entry!.metadata as { source: string }).source).toBe('vendor-portal');
    // The transition, not just the result — one send is legible from the row alone.
    expect(entry!.beforeState).toMatchObject({ send_count: 1 });
    expect(entry!.afterState).toMatchObject({ send_count: 2 });
  });

  it('names the ORIGINAL sender in the mail, not whoever pressed the button', async () => {
    const seeded = await seedInvite({ createdAt: COOLED(), invitedById: OWNER });
    // A second owner does the re-send; the recipient should still see the name
    // they saw on the first copy.
    await t.db
      .update(profiles)
      .set({ seatOwner: true, displayName: 'Kim' })
      .where(eq(profiles.id, MEMBER));
    await resend(seeded.id, MEMBER_SESSION);

    expect(sent.mock.calls[0]![1].invitedByName).toBe('Dana');
  });

  it('REFUSES a non-owner seat (403) and sends nothing', async () => {
    const seeded = await seedInvite({ createdAt: COOLED() });
    const res = await resend(seeded.id, MEMBER_SESSION);
    expect(res.status).toBe(403);
    expect(sent).not.toHaveBeenCalled();
    expect((await t.db.select().from(vendorSeatInvites))[0]!.sendCount).toBe(1);
  });

  it('429s inside the cooldown, with an EXACT Retry-After', async () => {
    // Sent one minute ago against a five-minute cooldown: ~240s remaining.
    const seeded = await seedInvite({
      createdAt: COOLED(),
      lastSentAt: new Date(Date.now() - 60_000).toISOString(),
      sendCount: 2,
    });
    const res = await resend(seeded.id);

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    // Exact rather than the full window — the last send is a column on this row.
    // The create route's daily cap can only offer a flat 86400 here.
    const retryAfter = Number(res.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThan(200);
    expect(retryAfter).toBeLessThanOrEqual(240);
    expect(sent).not.toHaveBeenCalled();
  });

  it('422s — not 429 — once the lifetime send cap is reached', async () => {
    // A 429 promises that waiting helps. Here it never does, so the status has to
    // agree with the copy, which points at revoke-and-re-invite.
    const seeded = await seedInvite({ createdAt: COOLED(), sendCount: INVITE_MAX_SENDS });
    const res = await resend(seeded.id);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(sent).not.toHaveBeenCalled();
  });

  it('404s a cross-vendor invite, indistinguishable from an unknown id', async () => {
    const seeded = await seedInvite({ createdAt: COOLED(), vendorId: OTHER_VENDOR });
    expect((await resend(seeded.id)).status).toBe(404);
    expect((await resend(uuid(999))).status).toBe(404);
  });

  it('404s a spent invite (accepted or revoked)', async () => {
    const accepted = await seedInvite({
      createdAt: COOLED(),
      acceptedAt: new Date().toISOString(),
    });
    expect((await resend(accepted.id)).status).toBe(404);

    const revoked = await seedInvite({
      id: uuid(901),
      token: 'tok-2',
      email: 'other@acme.com',
      createdAt: COOLED(),
      revokedAt: new Date().toISOString(),
    });
    expect((await resend(revoked.id)).status).toBe(404);
  });

  it('404s an EXPIRED invite rather than reviving it', async () => {
    // Reviving would contradict the roster, which does not show it, and would let
    // an owner park an address indefinitely by re-sending on every expiry — a way
    // around the lifetime cap. A fresh invite is the answer, under the daily cap.
    const seeded = await seedInvite({
      createdAt: COOLED(),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect((await resend(seeded.id)).status).toBe(404);
    expect(sent).not.toHaveBeenCalled();
  });
});

describe('GET/POST /api/seat-invites/:token', () => {
  const redeemer = session({
    userId: uuid(300),
    email: 'dana@acme.com',
    role: 'reviewer',
    vendorId: null,
  });

  it('previews without redeeming — a scanner prefetch must not spend the invite', async () => {
    await seedInvite();
    const res = await call('/api/seat-invites/tok-1', {}, redeemer);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ vendor_name: 'Acme', redeemable: true, reason: 'ok' });

    const [row] = await t.db.select().from(vendorSeatInvites);
    expect(row!.acceptedAt).toBeNull();
  });

  it('accepts, attaching a NON-owner seat and spending the invite', async () => {
    // `dana@acme.com` IS on `https://www.acme.com`, so this redeem earns
    // `work_email_verified` — see the off-domain case below for the other half.
    await seedInvite();
    const res = await call('/api/seat-invites/tok-1/accept', { method: 'POST' }, redeemer);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ vendor_slug: 'acme', vendor_name: 'Acme' });

    const [seat] = await t.db.select().from(profiles).where(eq(profiles.id, redeemer.userId));
    expect(seat).toMatchObject({
      role: 'vendor_admin',
      vendorId: VENDOR,
      seatOwner: false,
      workEmailVerified: true,
    });
    const [row] = await t.db.select().from(vendorSeatInvites);
    expect(row!.acceptedAt).not.toBeNull();
  });

  it('an OFF-DOMAIN redeem does NOT set work_email_verified', async () => {
    // The bit is a signal a human reads on the §5 claim queue ("does this person
    // really work there?"), so it has to track the address actually redeemed. With
    // no invite-time domain gate, setting it on every redeem would make it mean
    // "someone accepted an invite" — which is not a claim about employment.
    await seedInvite({ email: 'dana@gmail.com' });
    const outside = session({
      userId: uuid(320),
      email: 'dana@gmail.com',
      role: 'reviewer',
      vendorId: null,
    });
    expect((await call('/api/seat-invites/tok-1/accept', { method: 'POST' }, outside)).status).toBe(
      200,
    );

    const [seat] = await t.db.select().from(profiles).where(eq(profiles.id, outside.userId));
    expect(seat).toMatchObject({
      role: 'vendor_admin',
      vendorId: VENDOR,
      workEmailVerified: false,
    });
  });

  it('an off-domain redeem never CLEARS a bit the profile already earned', async () => {
    await seedInvite({ email: 'dana@gmail.com' });
    const known = uuid(321);
    await t.db
      .insert(profiles)
      .values({ id: known, role: 'reviewer', vendorId: null, workEmailVerified: true });
    expect(
      (
        await call(
          '/api/seat-invites/tok-1/accept',
          { method: 'POST' },
          session({ userId: known, email: 'dana@gmail.com', role: 'reviewer', vendorId: null }),
        )
      ).status,
    ).toBe(200);

    const [seat] = await t.db.select().from(profiles).where(eq(profiles.id, known));
    expect(seat!.workEmailVerified).toBe(true);
  });

  it('an existing owner who redeems keeps their owner bit (never demotes)', async () => {
    await seedInvite();
    const ownerId = uuid(310);
    await t.db
      .insert(profiles)
      .values({ id: ownerId, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true });
    const res = await call(
      '/api/seat-invites/tok-1/accept',
      { method: 'POST' },
      session({ userId: ownerId, email: 'dana@acme.com', role: 'vendor_admin', vendorId: VENDOR }),
    );
    expect(res.status).toBe(200);
    const [seat] = await t.db.select().from(profiles).where(eq(profiles.id, ownerId));
    expect(seat).toMatchObject({ role: 'vendor_admin', vendorId: VENDOR, seatOwner: true });
  });

  it('REFUSES a redeem by a different address — the security control', async () => {
    await seedInvite();
    const wrong = session({
      userId: uuid(301),
      email: 'someone.else@acme.com',
      role: 'reviewer',
      vendorId: null,
    });
    const res = await call('/api/seat-invites/tok-1/accept', { method: 'POST' }, wrong);
    expect(res.status).toBe(422);
    expect(await t.db.select().from(profiles).where(eq(profiles.id, wrong.userId))).toHaveLength(0);
  });

  it('is single-use', async () => {
    await seedInvite();
    expect(
      (await call('/api/seat-invites/tok-1/accept', { method: 'POST' }, redeemer)).status,
    ).toBe(200);
    const second = await call('/api/seat-invites/tok-1/accept', { method: 'POST' }, redeemer);
    expect(second.status).toBe(422);
  });

  it('refuses an expired invite', async () => {
    await seedInvite({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const res = await call('/api/seat-invites/tok-1/accept', { method: 'POST' }, redeemer);
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('expired');
  });

  it('refuses an account already linked to another vendor (409)', async () => {
    await seedInvite();
    const elsewhere = uuid(302);
    await t.db
      .insert(profiles)
      .values({ id: elsewhere, role: 'vendor_admin', vendorId: OTHER_VENDOR, seatOwner: true });
    const res = await call(
      '/api/seat-invites/tok-1/accept',
      { method: 'POST' },
      session({ userId: elsewhere, email: 'dana@acme.com', vendorId: OTHER_VENDOR }),
    );
    expect(res.status).toBe(409);
  });

  it('refuses a site admin (409)', async () => {
    await seedInvite();
    const admin = uuid(303);
    await t.db.insert(profiles).values({ id: admin, role: 'admin', vendorId: null });
    const res = await call(
      '/api/seat-invites/tok-1/accept',
      { method: 'POST' },
      session({ userId: admin, email: 'dana@acme.com', role: 'admin', vendorId: null }),
    );
    expect(res.status).toBe(409);
  });

  it('404s an unknown token with no identifier echoed back', async () => {
    const res = await call('/api/seat-invites/nope/accept', { method: 'POST' }, redeemer);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('nope');
  });
});

describe('DELETE /api/vendor/seats/invites/:id', () => {
  it('an owner revokes; the row soft-deletes rather than disappearing', async () => {
    const row = await seedInvite();
    expect((await call(`/api/vendor/seats/invites/${row.id}`, { method: 'DELETE' })).status).toBe(
      204,
    );
    const [after] = await t.db.select().from(vendorSeatInvites);
    expect(after!.revokedAt).not.toBeNull();
  });

  it('404s a cross-vendor invite — indistinguishable from a missing one', async () => {
    const row = await seedInvite({ vendorId: OTHER_VENDOR, email: 'x@globex.com' });
    expect((await call(`/api/vendor/seats/invites/${row.id}`, { method: 'DELETE' })).status).toBe(
      404,
    );
  });

  it('403s a non-owner', async () => {
    const row = await seedInvite();
    expect(
      (await call(`/api/vendor/seats/invites/${row.id}`, { method: 'DELETE' }, MEMBER_SESSION))
        .status,
    ).toBe(403);
  });
});

describe('DELETE /api/vendor/seats/:userId', () => {
  it('an owner removes a member seat and it loses portal access', async () => {
    expect((await call(`/api/vendor/seats/${MEMBER}`, { method: 'DELETE' })).status).toBe(204);
    const [after] = await t.db.select().from(profiles).where(eq(profiles.id, MEMBER));
    expect(after).toMatchObject({ role: 'reviewer', vendorId: null, seatOwner: false });
  });

  it('leaves vendors.verified untouched (§8.3(2))', async () => {
    await t.db.update(vendors).set({ verified: true }).where(eq(vendors.id, VENDOR));
    await call(`/api/vendor/seats/${MEMBER}`, { method: 'DELETE' });
    const [v] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR));
    expect(v!.verified).toBe(true);
  });

  it('tags the audit row as vendor-portal, not admin-moderation', async () => {
    await call(`/api/vendor/seats/${MEMBER}`, { method: 'DELETE' });
    const rows = await t.db.select().from(auditLog);
    const revoke = rows.find((r) => r.action === 'vendor_claim.seat_revoked');
    expect((revoke!.metadata as { source: string }).source).toBe('vendor-portal');
  });

  it('refuses self-removal', async () => {
    const res = await call(`/api/vendor/seats/${OWNER}`, { method: 'DELETE' });
    expect(res.status).toBe(422);
    const [after] = await t.db.select().from(profiles).where(eq(profiles.id, OWNER));
    expect(after!.role).toBe('vendor_admin');
  });

  // The handler's explicit last-owner guard is currently unreachable (only an
  // owner may remove, and no one may remove themselves, so removing an owner
  // proves a second exists). This asserts the INVARIANT the guard names, rather
  // than pretending to exercise the dead branch.
  it('one owner can remove another, leaving the vendor administrable', async () => {
    await t.db
      .insert(profiles)
      .values({ id: OWNER_2, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true });
    expect((await call(`/api/vendor/seats/${OWNER_2}`, { method: 'DELETE' })).status).toBe(204);

    const remaining = await t.db
      .select()
      .from(profiles)
      .where(and(eq(profiles.vendorId, VENDOR), eq(profiles.seatOwner, true)));
    expect(remaining).toHaveLength(1);
  });

  it('404s a seat on another vendor', async () => {
    const foreign = uuid(400);
    await t.db
      .insert(profiles)
      .values({ id: foreign, role: 'vendor_admin', vendorId: OTHER_VENDOR, seatOwner: true });
    expect((await call(`/api/vendor/seats/${foreign}`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('GET /api/vendor/seats', () => {
  it('ships pending invites and the caller’s own manage bit', async () => {
    await seedInvite();
    const owner = await call('/api/vendor/seats');
    ListVendorSeatsResponseSchema.parse(owner.body);
    expect(owner.body.can_manage_seats).toBe(true);
    expect(owner.body.pending_invites).toHaveLength(1);
    expect(owner.body.pending_invites[0]).toMatchObject({
      email: 'dana@acme.com',
      invited_by: 'Dana',
    });
    // The redeem handle is never on a surface every seat can read.
    expect(JSON.stringify(owner.body)).not.toContain('tok-1');

    const member = await call('/api/vendor/seats', {}, MEMBER_SESSION);
    expect(member.body.can_manage_seats).toBe(false);
  });

  it('hides spent and expired invites', async () => {
    await seedInvite({
      id: uuid(901),
      token: 'a',
      email: 'a@acme.com',
      acceptedAt: new Date().toISOString(),
    });
    await seedInvite({
      id: uuid(902),
      token: 'b',
      email: 'b@acme.com',
      revokedAt: new Date().toISOString(),
    });
    await seedInvite({
      id: uuid(903),
      token: 'c',
      email: 'c@acme.com',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const res = await call('/api/vendor/seats');
    expect(res.body.pending_invites).toHaveLength(0);
  });
});
