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
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { createAcceptSeatInviteHandler, createSeatInvitePreviewHandler } from './seat-invites';
import {
  createRemoveSeatHandler,
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
): Promise<{ status: number; body: JsonBody }> {
  const req = new Request(`http://x${path}`, init) as Request & { __auth?: AuthzVariables['auth'] };
  req.__auth = auth;
  const execCtx = fakeExecutionContext();
  const res = await app().fetch(req, TEST_ENV, execCtx);
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  const body = res.status === 204 ? {} : await res.json();
  return { status: res.status, body: body as JsonBody };
}

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

  it('REFUSES a non-matching domain, writing nothing and sending nothing', async () => {
    const res = await invite('dana@gmail.com');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVITE_DOMAIN_MISMATCH');
    expect(await t.db.select().from(vendorSeatInvites)).toHaveLength(0);
    expect(sent).not.toHaveBeenCalled();
  });

  it('refuses when the vendor has no website to match against', async () => {
    await t.db.update(vendors).set({ website: null }).where(eq(vendors.id, VENDOR));
    // `computeDomainMatch` returns `manual_review`, which is NOT `match` — the
    // fallback is the human claim queue, not a guess.
    expect((await invite('dana@acme.com')).status).toBe(422);
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
