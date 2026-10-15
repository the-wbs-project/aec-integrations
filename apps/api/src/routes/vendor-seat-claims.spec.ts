/**
 * The owner's decision on a routed claim (AECI-1368 / §11a.10): accept, decline,
 * and the `pending_claims` read on `GET /api/vendor/seats`. Real handlers over one
 * real D1, with `c.set('auth', …)` stubbed the way `seat-invites.spec.ts` does.
 *
 * Most of this file is refusals, because the claim rows carry a stranger's contact
 * details: a member seat may neither see nor decide them, and a claim on another
 * vendor, an unrouted claim or a decided claim is a 404.
 */

import { ApiErrorCode, ListVendorSeatsResponseSchema } from '@aeci/shared';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  products,
  profiles,
  vendorRequests,
  vendorSeatInvites,
  vendors,
  workflowInstances,
  workflowTransitions,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { INVITE_DAILY_LIMIT } from '../lib/vendor-seat-invites';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { createVendorSeatsHandler } from './vendor';
import { createAcceptSeatClaimHandler, createDeclineSeatClaimHandler } from './vendor-seat-claims';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const VENDOR = uuid(1);
const OTHER_VENDOR = uuid(2);
const PRODUCT = uuid(3);
const OWNER = uuid(100);
const MEMBER = uuid(101);
const CLAIM = uuid(500);

let t: TestDb;
const sentInvite = vi.fn();
const sentDeclined = vi.fn();

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
  sentInvite.mockReset().mockResolvedValue(undefined);
  sentDeclined.mockReset().mockResolvedValue(undefined);
  await t.db.insert(vendors).values([
    { id: VENDOR, slug: 'acme', companyName: 'Acme', website: 'https://acme.com' },
    { id: OTHER_VENDOR, slug: 'globex', companyName: 'Globex' },
  ]);
  await t.db.insert(products).values({ id: PRODUCT, slug: 'acme-build', name: 'Acme Build' });
  await t.db.insert(profiles).values([
    { id: OWNER, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true, displayName: 'Dana' },
    { id: MEMBER, role: 'vendor_admin', vendorId: VENDOR, seatOwner: false, displayName: 'Sam' },
  ]);
});
afterEach(() => t.dispose());

async function seedClaim(over: Partial<typeof vendorRequests.$inferInsert> = {}) {
  await t.db.insert(vendorRequests).values({
    id: CLAIM,
    kind: 'claim',
    status: 'open',
    targetType: 'vendor',
    targetId: VENDOR,
    submitterEmail: 'Casey@Acme.com',
    submitterName: 'Casey',
    submitterRole: 'Product manager',
    submitterLinkedinUrl: 'https://www.linkedin.com/in/casey',
    contextProductId: PRODUCT,
    domainMatch: 'match',
    body: 'I run the integrations team.',
    createdAt: '2026-10-14T10:00:00.000Z',
    routedToOwnersAt: '2026-10-14T10:00:00.000Z',
    ...over,
  });
}

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
  a.post(
    '/api/vendor/seats/claims/:id/accept',
    createAcceptSeatClaimHandler(t.factory, sentInvite),
  );
  a.post(
    '/api/vendor/seats/claims/:id/decline',
    createDeclineSeatClaimHandler(t.factory, sentDeclined),
  );
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

const accept = (id = CLAIM, auth = OWNER_SESSION) =>
  call(`/api/vendor/seats/claims/${id}/accept`, { method: 'POST' }, auth);
const decline = (id = CLAIM, auth = OWNER_SESSION) =>
  call(`/api/vendor/seats/claims/${id}/decline`, { method: 'POST' }, auth);
const claimRow = () => t.db.query.vendorRequests.findFirst({ where: eq(vendorRequests.id, CLAIM) });

describe('GET /api/vendor/seats → pending_claims (AECI-1368)', () => {
  it('lists a routed claim to an owner seat, with the claimant details', async () => {
    await seedClaim();
    const { status, body } = await call('/api/vendor/seats');
    expect(status).toBe(200);
    expect(ListVendorSeatsResponseSchema.parse(body).pending_claims).toEqual([
      {
        id: CLAIM,
        submitter_name: 'Casey',
        submitter_role: 'Product manager',
        submitter_email: 'Casey@Acme.com',
        submitter_linkedin_url: 'https://www.linkedin.com/in/casey',
        comments: 'I run the integrations team.',
        created_at: '2026-10-14T10:00:00.000Z',
        routed_to_owners_at: '2026-10-14T10:00:00.000Z',
        context_product_name: 'Acme Build',
      },
    ]);
  });

  it('returns an empty list to a member seat', async () => {
    await seedClaim();
    const { body } = await call('/api/vendor/seats', {}, MEMBER_SESSION);
    expect(body.pending_claims).toEqual([]);
  });

  it('leaves out unrouted, decided and other-vendor claims', async () => {
    await seedClaim({ routedToOwnersAt: null });
    await seedClaim({ id: uuid(501), status: 'rejected' });
    await seedClaim({ id: uuid(502), targetId: OTHER_VENDOR });
    const { body } = await call('/api/vendor/seats');
    expect(body.pending_claims).toEqual([]);
  });
});

describe('POST /api/vendor/seats/claims/:id/accept (AECI-1368)', () => {
  it('issues an invite to the claimant, resolves the claim as the owner and sends the invite email', async () => {
    await seedClaim();
    const { status, body } = await accept();
    expect(status).toBe(201);
    expect(body.invite).toMatchObject({ email: 'casey@acme.com', invited_by: 'Dana' });
    expect(body.invite_sent).toBe(true);

    const invites = await t.db.select().from(vendorSeatInvites);
    expect(invites).toHaveLength(1);
    expect(invites[0]).toMatchObject({
      vendorId: VENDOR,
      email: 'casey@acme.com',
      invitedById: OWNER,
    });

    expect(await claimRow()).toMatchObject({ status: 'resolved', resolvedById: OWNER });
    const wf = await t.db.query.workflowInstances.findFirst({
      where: eq(workflowInstances.entityId, CLAIM),
    });
    expect(wf).toMatchObject({ currentState: 'resolved', finalOutcome: 'completed' });
    expect(await t.db.select().from(workflowTransitions)).toHaveLength(1);

    const actions = (await t.db.select().from(auditLog)).map((a) => a.action).sort();
    expect(actions).toEqual(['vendor_claim.owner_accepted', 'vendor_seat.invited']);

    expect(sentInvite).toHaveBeenCalledOnce();
    expect(sentInvite.mock.calls[0]![1]).toMatchObject({
      notification: 'vendor-seat-invite',
      to: 'casey@acme.com',
      vendorName: 'Acme',
      invitedByName: 'Dana',
    });
    // Accept writes no seat: the claimant attaches by redeeming the invite.
    const seat = await t.db.query.profiles.findMany({
      where: and(eq(profiles.vendorId, VENDOR)),
    });
    expect(seat).toHaveLength(2);
  });

  it('reuses a live invite for the same address and sends no second email', async () => {
    await seedClaim();
    await t.db.insert(vendorSeatInvites).values({
      id: uuid(900),
      vendorId: VENDOR,
      email: 'casey@acme.com',
      token: 'tok-1',
      invitedById: OWNER,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    const { status, body } = await accept();
    expect(status).toBe(201);
    expect(body.invite.id).toBe(uuid(900));
    expect(body.invite_sent).toBe(false);
    expect(await t.db.select().from(vendorSeatInvites)).toHaveLength(1);
    expect(sentInvite).not.toHaveBeenCalled();
    expect((await claimRow())?.status).toBe('resolved');
  });

  it('respects the daily invite cap with a 429 and leaves the claim open', async () => {
    await seedClaim();
    const now = new Date().toISOString();
    await t.db.insert(vendorSeatInvites).values(
      Array.from({ length: INVITE_DAILY_LIMIT }, (_, i) => ({
        id: uuid(1000 + i),
        vendorId: VENDOR,
        email: `x${i}@acme.com`,
        token: `tok-${i}`,
        invitedById: OWNER,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        createdAt: now,
      })),
    );
    const { status } = await accept();
    expect(status).toBe(429);
    expect((await claimRow())?.status).toBe('open');
  });

  it('403s a member seat', async () => {
    await seedClaim();
    expect((await accept(CLAIM, MEMBER_SESSION)).status).toBe(403);
    expect((await claimRow())?.status).toBe('open');
  });

  it.each([
    ['another vendor', { targetId: OTHER_VENDOR }],
    ['not routed', { routedToOwnersAt: null }],
    ['already decided', { status: 'rejected' }],
  ])('404s a claim that is %s', async (_label, over) => {
    await seedClaim(over as Partial<typeof vendorRequests.$inferInsert>);
    expect((await accept()).status).toBe(404);
    expect(await t.db.select().from(vendorSeatInvites)).toHaveLength(0);
  });
});

describe('POST /api/vendor/seats/claims/:id/decline (AECI-1368)', () => {
  it('rejects the claim with the owner as actor and sends the neutral email', async () => {
    await seedClaim();
    const { status } = await decline();
    expect(status).toBe(204);
    expect(await claimRow()).toMatchObject({ status: 'rejected', resolvedById: OWNER });
    const [audit] = await t.db.select().from(auditLog);
    expect(audit).toMatchObject({ action: 'vendor_claim.rejected', actorId: OWNER });
    expect((audit!.metadata as Record<string, unknown>).source).toBe('vendor-portal');
    expect(sentDeclined).toHaveBeenCalledWith(expect.anything(), {
      to: 'Casey@Acme.com',
      vendorName: 'Acme',
    });
    expect(await t.db.select().from(vendorSeatInvites)).toHaveLength(0);
  });

  it('403s a member seat', async () => {
    await seedClaim();
    expect((await decline(CLAIM, MEMBER_SESSION)).status).toBe(403);
  });

  it("404s another vendor's claim", async () => {
    await seedClaim({ targetId: OTHER_VENDOR });
    expect((await decline()).status).toBe(404);
    expect(sentDeclined).not.toHaveBeenCalled();
  });
});

// ─── The decision race (AECI-1333) ───────────────────────────────────────────
//
// Each case lets the handler pass its read, then commits a competing decision
// right before its batch runs. The batch's first statement is
// `claimUndecidedSentinel`, so the loser answers 409 and writes and sends nothing.

/** Run `first` right before the next `db.batch`, then let that batch run. */
function beforeNextBatch(first: () => Promise<unknown>) {
  const batch = t.db.batch.bind(t.db);
  vi.spyOn(t.db, 'batch').mockImplementationOnce((async (stmts: Parameters<typeof batch>[0]) => {
    await first();
    return batch(stmts);
  }) as unknown as typeof batch);
}

const auditActions = async () => (await t.db.select().from(auditLog)).map((a) => a.action).sort();

describe('owner decisions lose a race with 409 and write nothing (AECI-1333)', () => {
  it('accept after another owner declined: no invite, no second audit or transition, no email', async () => {
    await seedClaim();
    beforeNextBatch(() => decline());

    const { status, body } = await accept();

    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.CLAIM_ALREADY_DECIDED);
    expect(body.error.details).toEqual({ status: 'rejected' });
    expect(await claimRow()).toMatchObject({ status: 'rejected', resolvedById: OWNER });
    expect(await auditActions()).toEqual(['vendor_claim.rejected']);
    expect(await t.db.select().from(workflowTransitions)).toHaveLength(1);
    expect(await t.db.select().from(vendorSeatInvites)).toHaveLength(0);
    expect(sentInvite).not.toHaveBeenCalled();
    expect(sentDeclined).toHaveBeenCalledOnce();
  });

  it('decline after another owner accepted: the claim stays resolved, no decline row, no email', async () => {
    await seedClaim();
    beforeNextBatch(() => accept());

    const { status, body } = await decline();

    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.CLAIM_ALREADY_DECIDED);
    expect(await claimRow()).toMatchObject({ status: 'resolved' });
    expect(await auditActions()).toEqual(['vendor_claim.owner_accepted', 'vendor_seat.invited']);
    expect(await t.db.select().from(workflowTransitions)).toHaveLength(1);
    expect(await t.db.select().from(vendorSeatInvites)).toHaveLength(1);
    expect(await t.db.select().from(profiles)).toHaveLength(2);
    expect(sentDeclined).not.toHaveBeenCalled();
    expect(sentInvite).toHaveBeenCalledOnce();
  });

  it.each([
    ['accept', () => accept()],
    ['decline', () => decline()],
  ])('%s after the 7-day fallback took the claim back to AECi', async (_label, decide) => {
    await seedClaim();
    beforeNextBatch(() =>
      t.db
        .update(vendorRequests)
        .set({ routedToOwnersAt: null, ownerFallbackAt: '2026-10-21T10:00:00.000Z' })
        .where(eq(vendorRequests.id, CLAIM)),
    );

    const { status, body } = await decide();

    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.CLAIM_ALREADY_DECIDED);
    expect(body.error.details).toEqual({ status: 'open' });
    expect(await claimRow()).toMatchObject({ status: 'open', resolvedById: null });
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect(await t.db.select().from(workflowTransitions)).toHaveLength(0);
    expect(await t.db.select().from(workflowInstances)).toHaveLength(0);
    expect(await t.db.select().from(vendorSeatInvites)).toHaveLength(0);
    expect(sentInvite).not.toHaveBeenCalled();
    expect(sentDeclined).not.toHaveBeenCalled();
  });
});
