/**
 * The AECI-1092 reconciliation with AECI-989 (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11b.13,
 * "Reconciled with AECI-989"). A contest routes to, or returns to, the owner only when
 * the owner has an unbanned `vendor_admin` seat AND, on a connector-powered row, an
 * active entitlement. A `mechanism_kind` contest on a connector-powered row never goes
 * to the owner. What each block pins:
 *
 *   1. Submit: AECI-989's no-seat check combined with rulings A and E. The stamp
 *      (`owner_seat_lapsed_at`) is set only when the missing seat is the one reason.
 *   2. The seat return (unban, and a new seat grant): a stamped contest the owner may
 *      not decide stays with AECi and loses its stamp. Both anchor tables.
 *   3. The entitlement clear (ruling B): it also clears the stamp on the vendor's
 *      stamped AECi contests on connector-powered rows, so no later seat event can
 *      send them back, and leaves stamps on ordinary rows alone.
 *   4. An accept that makes a row connector-powered: the same stamp handling.
 *   5. The races: a return loses to a clear (409 VENDOR_SEATS_CHANGED, nothing
 *      written), and the clear's fingerprint moves when a seat event lands mid-clear.
 */

import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../posthog', async (importOriginal) => {
  const real = await importOriginal<typeof import('../posthog')>();
  return { ...real, logBatchToPosthog: vi.fn() };
});

import {
  auditLog,
  connectorEvidencedPairs,
  integrationFieldChallenges,
  integrations,
  productVendors,
  products,
  profiles,
  vendorEntitlements,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import type { BatchTuple } from '../lib/audit';
import type { resolveClaimantIdentity } from '../lib/claimant-identity';
import { isContestRaceError, planEntitlementClearReroute } from '../lib/integration-contests';
import { planSeatGrantReturn } from '../lib/vendor-handback';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { createModerateContestHandler } from './admin-contests';
import { createSetVendorEntitlementHandler } from './admin-entitlements';
import { createBanReviewerHandler } from './admin-reviewers';
import { createProvisionSeatHandler } from './admin-vendors';
import { createSubmitContestHandler } from './vendor-contests';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A owns endpoint A. B owns endpoint B and both integrations rows. T sells the
// connector and owns the evidenced pair.
const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const VENDOR_T = uuid(3);
const P_A = uuid(10);
const P_B = uuid(11);
const P_CONNECTOR = uuid(12);
const PAIR = uuid(30);
const I_POWERED = uuid(31); // iPaaS, claimed by B
const I_PLAIN = uuid(32); // native, claimed by B
const SEAT_A = uuid(100);
const SEAT_B = uuid(101);
const SEAT_T = uuid(102);
const SEAT_NEW = uuid(103);
const ADMIN = uuid(900);

const CLAIMED_AT = '2026-09-01T00:00:00.000Z';
const STAMP = '2026-09-20T00:00:00.000Z';
const BANNED_AT = '2026-09-19T00:00:00.000Z';

type Auth = AuthzVariables['auth'];
const AUTH_A: Auth = {
  userId: SEAT_A,
  email: 'a@example.test',
  role: 'vendor_admin',
  vendorId: VENDOR_A,
  entitlementTier: 'unclaimed',
  entitlement: null,
};
const AUTH_ADMIN: Auth = {
  userId: ADMIN,
  email: undefined,
  role: 'admin',
  vendorId: null,
  entitlementTier: 'unclaimed',
  entitlement: null,
};

let t: TestDb;
const fileIssue = vi.fn().mockResolvedValue({ status: 'created' });

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR_A, slug: 'autodesk', companyName: 'Autodesk' },
    { id: VENDOR_B, slug: 'bentley', companyName: 'Bentley' },
    { id: VENDOR_T, slug: 'syncezy', companyName: 'SyncEzy' },
  ]);
  await t.db.insert(products).values([
    { id: P_A, slug: 'revit', name: 'Revit' },
    { id: P_B, slug: 'procore', name: 'Procore' },
    { id: P_CONNECTOR, slug: 'syncezy-connect', name: 'SyncEzy Connect' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_A, vendorId: VENDOR_A, isPrimary: true },
    { productId: P_B, vendorId: VENDOR_B, isPrimary: true },
    { productId: P_CONNECTOR, vendorId: VENDOR_T, isPrimary: true },
  ]);
  await t.db.insert(connectorEvidencedPairs).values({
    id: PAIR,
    connectorProductId: P_CONNECTOR,
    productAId: P_A,
    productBId: P_B,
    name: 'Revit to Procore via SyncEzy',
    direction: 'a_to_b',
    builtByVendorId: VENDOR_T,
    claimedAt: CLAIMED_AT,
    maintainedBy: 'vendor',
  });
  const row = {
    sourceProductId: P_A,
    targetProductId: P_B,
    direction: 'a_to_b',
    builtByVendorId: VENDOR_B,
    claimedAt: CLAIMED_AT,
  };
  await t.db.insert(integrations).values([
    { id: I_POWERED, name: 'Powered', mechanismKind: 'iPaaS', ...row },
    { id: I_PLAIN, name: 'Plain', mechanismKind: 'native', ...row },
  ]);
  await t.db.insert(profiles).values([
    { id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR_A },
    { id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR_B },
    { id: SEAT_T, role: 'vendor_admin', vendorId: VENDOR_T },
    { id: ADMIN, role: 'admin' },
  ]);
});
afterEach(() => t.dispose());

const entitle = (vendorId: string) =>
  t.db.insert(vendorEntitlements).values({
    vendorId,
    tier: 'verified',
    status: 'active',
    grantedAt: CLAIMED_AT,
    createdAt: CLAIMED_AT,
    updatedAt: CLAIMED_AT,
  });
const banSeatDirectly = (seatId: string) =>
  t.db.update(profiles).set({ bannedAt: BANNED_AT }).where(eq(profiles.id, seatId));

let nextContest = 500;
/** A contest a seat lapse already moved to AECi for this owner: open, stamped. */
async function stampedContest(anchor: {
  integrationId?: string;
  evidencedPairId?: string;
  field?: string;
  owner?: string;
  stamp?: string | null;
}): Promise<string> {
  const id = uuid(nextContest++);
  await t.db.insert(integrationFieldChallenges).values({
    id,
    integrationId: anchor.integrationId ?? null,
    evidencedPairId: anchor.evidencedPairId ?? null,
    field: anchor.field ?? 'name',
    currentValue: 'Old',
    proposedValue: anchor.field === 'mechanism_kind' ? 'marketplace-app' : 'New',
    reason: 'r',
    // Not A: A files live contests in these tests, and one open contest per field per
    // vendor is a unique key.
    submitterVendorId: VENDOR_T,
    routedTo: 'aeci',
    ownerVendorId: anchor.owner ?? VENDOR_B,
    ownerSeatLapsedAt: anchor.stamp === undefined ? STAMP : anchor.stamp,
    createdAt: STAMP,
    updatedAt: STAMP,
  });
  return id;
}

const contest = async (id: string) =>
  (
    await t.db
      .select()
      .from(integrationFieldChallenges)
      .where(eq(integrationFieldChallenges.id, id))
  )[0]!;
const auditsFor = async (id: string) =>
  (await t.db.select().from(auditLog).where(eq(auditLog.entityId, id))).map((r) => ({
    action: r.action,
    reason: (r.metadata as { reason?: string } | null)?.reason,
  }));

function app(auth: Auth) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.post('/api/vendor/integrations/:id/contests', createSubmitContestHandler(t.factory));
  a.patch('/api/admin/contests/:id', createModerateContestHandler(t.factory, fileIssue));
  a.patch('/api/admin/vendors/:id/entitlement', createSetVendorEntitlementHandler(t.factory));
  a.patch('/api/admin/reviewers/:id', createBanReviewerHandler(t.factory));
  a.post(
    '/api/admin/vendors/:id/seats',
    createProvisionSeatHandler(t.factory, (async () => ({
      outcome: 'linked',
      userId: SEAT_NEW,
      email: 'new-seat@example.test',
      profile: null,
    })) as unknown as typeof resolveClaimantIdentity),
  );
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function call(
  auth: Auth,
  path: string,
  body: unknown,
  method = 'POST',
): Promise<{ status: number; body: JsonBody }> {
  const env: Env = {
    ...TEST_ENV,
    CACHE_PURGE_QUEUE: {
      send: vi.fn().mockResolvedValue(undefined),
    } as unknown as Env['CACHE_PURGE_QUEUE'],
  };
  const execCtx = fakeExecutionContext();
  const res = await app(auth).request(
    path,
    { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
    env,
    execCtx,
  );
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as JsonBody };
}

const submit = (id: string, field: string, proposed: string) =>
  call(AUTH_A, `/api/vendor/integrations/${id}/contests`, {
    field,
    proposed_value: proposed,
    reason: 'r',
  });
const unban = (seatId: string) =>
  call(AUTH_ADMIN, `/api/admin/reviewers/${seatId}`, { action: 'unban' }, 'PATCH');
const clearEntitlement = (vendorId: string) =>
  call(AUTH_ADMIN, `/api/admin/vendors/${vendorId}/entitlement`, { action: 'clear' }, 'PATCH');
const provisionSeat = (vendorId: string) =>
  call(AUTH_ADMIN, `/api/admin/vendors/${vendorId}/seats`, {
    email: 'new-seat@example.test',
    reason: 'pilot',
  });

// ─── 1. Submit ───────────────────────────────────────────────────────────────

describe('submit: a missing seat and the connector-row rules combine (AECI-1092 x AECI-989)', () => {
  it('stamps a contest on a connector-powered row whose entitled owner has no active seat', async () => {
    await entitle(VENDOR_B);
    await banSeatDirectly(SEAT_B);
    const res = await submit(I_POWERED, 'name', 'Powered 2');
    expect(res.status).toBe(201);
    const row = await contest(res.body.contest.id);
    expect(row.routedTo).toBe('aeci');
    expect(row.ownerSeatLapsedAt).not.toBeNull();
  });

  it('does NOT stamp one whose owner also holds no entitlement: ruling E sends it to AECi for good', async () => {
    await banSeatDirectly(SEAT_B);
    const res = await submit(I_POWERED, 'name', 'Powered 2');
    const row = await contest(res.body.contest.id);
    expect(row.routedTo).toBe('aeci');
    expect(row.ownerSeatLapsedAt).toBeNull();
  });

  it('does NOT stamp a mechanism_kind contest on a connector-powered row: ruling A', async () => {
    await entitle(VENDOR_B);
    await banSeatDirectly(SEAT_B);
    const res = await submit(I_POWERED, 'mechanism_kind', 'marketplace-app');
    const row = await contest(res.body.contest.id);
    expect(row.routedTo).toBe('aeci');
    expect(row.ownerSeatLapsedAt).toBeNull();
  });

  it('stamps a contest on an ordinary row with no active seat, as AECI-989 does', async () => {
    await banSeatDirectly(SEAT_B);
    const res = await submit(I_PLAIN, 'name', 'Plain 2');
    const row = await contest(res.body.contest.id);
    expect(row.routedTo).toBe('aeci');
    expect(row.ownerSeatLapsedAt).not.toBeNull();
  });

  it('routes to the entitled owner of a connector-powered row with an active seat', async () => {
    await entitle(VENDOR_B);
    const res = await submit(I_POWERED, 'name', 'Powered 2');
    const row = await contest(res.body.contest.id);
    expect(row.routedTo).toBe('owner');
    expect(row.ownerSeatLapsedAt).toBeNull();
  });
});

// ─── 2. The seat return ──────────────────────────────────────────────────────

describe('the seat return withholds what the owner may not decide', () => {
  beforeEach(() => banSeatDirectly(SEAT_B));

  it('returns a stamped contest on a connector-powered row to an entitled owner', async () => {
    await entitle(VENDOR_B);
    const id = await stampedContest({ integrationId: I_POWERED });
    expect((await unban(SEAT_B)).status).toBe(200);
    expect(await contest(id)).toMatchObject({ routedTo: 'owner', ownerSeatLapsedAt: null });
  });

  it('keeps a connector-row contest with AECi, unstamped, when the owner holds no entitlement', async () => {
    const powered = await stampedContest({ integrationId: I_POWERED });
    const plain = await stampedContest({ integrationId: I_PLAIN });
    expect((await unban(SEAT_B)).status).toBe(200);
    expect(await contest(powered)).toMatchObject({ routedTo: 'aeci', ownerSeatLapsedAt: null });
    expect(await auditsFor(powered)).toEqual([
      { action: 'integration.contest.seat_stamp_cleared', reason: 'owner-may-not-decide' },
    ]);
    // The ordinary row keeps the seat as its whole gate.
    expect(await contest(plain)).toMatchObject({ routedTo: 'owner', ownerSeatLapsedAt: null });
  });

  it('never returns a stamped mechanism_kind contest on a connector-powered row, entitled or not', async () => {
    await entitle(VENDOR_B);
    const id = await stampedContest({ integrationId: I_POWERED, field: 'mechanism_kind' });
    await unban(SEAT_B);
    expect(await contest(id)).toMatchObject({ routedTo: 'aeci', ownerSeatLapsedAt: null });
  });

  it('returns a stamped contest on an evidenced pair on a new seat grant, when the owner is entitled', async () => {
    await entitle(VENDOR_T);
    await banSeatDirectly(SEAT_T);
    const id = await stampedContest({ evidencedPairId: PAIR, owner: VENDOR_T });
    expect((await provisionSeat(VENDOR_T)).status).toBe(201);
    expect(await contest(id)).toMatchObject({ routedTo: 'owner', ownerSeatLapsedAt: null });
  });

  it('keeps a stamped evidenced-pair contest with AECi, unstamped, on a grant to an unentitled owner', async () => {
    await banSeatDirectly(SEAT_T);
    const id = await stampedContest({ evidencedPairId: PAIR, owner: VENDOR_T });
    expect((await provisionSeat(VENDOR_T)).status).toBe(201);
    expect(await contest(id)).toMatchObject({ routedTo: 'aeci', ownerSeatLapsedAt: null });
  });

  it('counts an entitlement the grant itself activates (the claim grant)', async () => {
    const id = await stampedContest({ integrationId: I_POWERED });
    const plan = await planSeatGrantReturn(
      t.db,
      { vendorId: VENDOR_B, actorId: ADMIN, actorType: 'admin', now: STAMP, source: 's' },
      SEAT_NEW,
      { entitledAfterBatch: true },
    );
    expect(plan?.entitlementGuarded).toBe(true);
    // The sentinel sits in the batch; with the entitlement in place the batch commits.
    await entitle(VENDOR_B);
    await t.db.batch(plan!.stmts as BatchTuple);
    expect(await contest(id)).toMatchObject({ routedTo: 'owner', ownerSeatLapsedAt: null });
  });
});

// ─── 3. The entitlement clear ────────────────────────────────────────────────

describe('the entitlement clear makes stamped connector-row contests AECi’s for good', () => {
  it('clears the stamp on connector rows only, so a later unban returns the ordinary one alone', async () => {
    await entitle(VENDOR_B);
    await banSeatDirectly(SEAT_B);
    const powered = await stampedContest({ integrationId: I_POWERED });
    const plain = await stampedContest({ integrationId: I_PLAIN });

    expect((await clearEntitlement(VENDOR_B)).status).toBe(200);
    expect(await contest(powered)).toMatchObject({ routedTo: 'aeci', ownerSeatLapsedAt: null });
    expect(await contest(plain)).toMatchObject({ routedTo: 'aeci', ownerSeatLapsedAt: STAMP });
    expect(await auditsFor(powered)).toEqual([
      { action: 'integration.contest.seat_stamp_cleared', reason: 'entitlement-cleared' },
    ]);

    // Re-entitling later does not bring it back either: the stamp is gone.
    await t.db
      .update(vendorEntitlements)
      .set({ status: 'active', tier: 'verified' })
      .where(eq(vendorEntitlements.vendorId, VENDOR_B));
    await unban(SEAT_B);
    expect((await contest(powered)).routedTo).toBe('aeci');
    expect((await contest(plain)).routedTo).toBe('owner');
  });

  it('clears the stamp on an evidenced-pair contest too', async () => {
    await entitle(VENDOR_T);
    const id = await stampedContest({ evidencedPairId: PAIR, owner: VENDOR_T });
    await clearEntitlement(VENDOR_T);
    expect(await contest(id)).toMatchObject({ routedTo: 'aeci', ownerSeatLapsedAt: null });
  });
});

// ─── 4. A row becoming connector-powered ─────────────────────────────────────

describe('an accept that makes a row connector-powered handles stamped contests the same way', () => {
  async function acceptToIpaas(): Promise<void> {
    const toIpaas = await submit(I_PLAIN, 'mechanism_kind', 'iPaaS');
    expect(toIpaas.body.contest.routed_to).toBe('aeci');
    const res = await call(
      AUTH_ADMIN,
      `/api/admin/contests/${toIpaas.body.contest.id}`,
      { decision: 'accept' },
      'PATCH',
    );
    expect(res.status).toBe(200);
  }

  it('clears every stamp on the row when the owner holds no entitlement', async () => {
    const name = await stampedContest({ integrationId: I_PLAIN });
    const kind = await stampedContest({ integrationId: I_PLAIN, field: 'mechanism_kind' });
    await acceptToIpaas();
    for (const id of [name, kind]) {
      expect(await contest(id)).toMatchObject({ routedTo: 'aeci', ownerSeatLapsedAt: null });
      expect(await auditsFor(id)).toEqual([
        { action: 'integration.contest.seat_stamp_cleared', reason: 'became-connector-powered' },
      ]);
    }
  });

  it('clears only the mechanism_kind stamp when the owner is entitled', async () => {
    await entitle(VENDOR_B);
    const name = await stampedContest({ integrationId: I_PLAIN });
    const kind = await stampedContest({ integrationId: I_PLAIN, field: 'mechanism_kind' });
    await acceptToIpaas();
    expect((await contest(name)).ownerSeatLapsedAt).toBe(STAMP);
    expect((await contest(kind)).ownerSeatLapsedAt).toBeNull();
  });
});

// ─── 5. Races ────────────────────────────────────────────────────────────────

describe('the reconciliation races', () => {
  it('a return that loses to a clear writes nothing and answers 409 VENDOR_SEATS_CHANGED', async () => {
    await entitle(VENDOR_B);
    await banSeatDirectly(SEAT_B);
    const id = await stampedContest({ integrationId: I_POWERED });
    // The clear commits between the unban's read and its batch.
    const original = t.db.batch.bind(t.db);
    vi.spyOn(t.db, 'batch').mockImplementationOnce((async (stmts: never) => {
      await t.db.delete(vendorEntitlements).where(eq(vendorEntitlements.vendorId, VENDOR_B));
      return original(stmts);
    }) as never);
    const res = await unban(SEAT_B);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VENDOR_SEATS_CHANGED');
    expect(await contest(id)).toMatchObject({ routedTo: 'aeci', ownerSeatLapsedAt: STAMP });
    const seat = (await t.db.select().from(profiles).where(eq(profiles.id, SEAT_B)))[0]!;
    expect(seat.bannedAt).toBe(BANNED_AT);
  });

  it('a seat grant that loses to a clear answers 409 VENDOR_SEATS_CHANGED too', async () => {
    await entitle(VENDOR_T);
    await banSeatDirectly(SEAT_T);
    const id = await stampedContest({ evidencedPairId: PAIR, owner: VENDOR_T });
    const original = t.db.batch.bind(t.db);
    vi.spyOn(t.db, 'batch').mockImplementationOnce((async (stmts: never) => {
      await t.db.delete(vendorEntitlements).where(eq(vendorEntitlements.vendorId, VENDOR_T));
      return original(stmts);
    }) as never);
    const res = await provisionSeat(VENDOR_T);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VENDOR_SEATS_CHANGED');
    expect((await contest(id)).routedTo).toBe('aeci');
  });

  it('the clear’s fingerprint moves when a stamped contest changes mid-clear', async () => {
    await entitle(VENDOR_B);
    const id = await stampedContest({ integrationId: I_PLAIN });
    const plan = await planEntitlementClearReroute(
      t.db,
      VENDOR_B,
      { actorId: ADMIN, actorType: 'admin' },
      STAMP,
    );
    // Another writer clears the stamp after the clear's read. The owner-routed set is
    // untouched, so only the stamped half of the fingerprint can catch it.
    await t.db
      .update(integrationFieldChallenges)
      .set({ ownerSeatLapsedAt: null })
      .where(and(eq(integrationFieldChallenges.id, id)));
    let error: unknown = null;
    try {
      await t.db.batch(plan.stmts as BatchTuple);
    } catch (e) {
      error = e;
    }
    expect(isContestRaceError(error)).toBe(true);
  });
});

// ─── A losing concurrent grant writes no phantom rows (review MINOR 4) ───────

describe('a seat grant that loses the contest to a concurrent grant writes nothing', () => {
  const rowsFor = async (id: string) =>
    (await t.db.select().from(auditLog).where(eq(auditLog.entityId, id))).length;

  it('a double grant: the loser answers 409 VENDOR_SEATS_CHANGED and writes no rerouted row', async () => {
    await banSeatDirectly(SEAT_B);
    const id = await stampedContest({ integrationId: I_PLAIN });
    // The first grant's return commits between the second grant's read and its batch.
    const original = t.db.batch.bind(t.db);
    vi.spyOn(t.db, 'batch').mockImplementationOnce((async (stmts: never) => {
      await t.db
        .update(integrationFieldChallenges)
        .set({ routedTo: 'owner', ownerSeatLapsedAt: null })
        .where(eq(integrationFieldChallenges.id, id));
      return original(stmts);
    }) as never);
    const res = await provisionSeat(VENDOR_B);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VENDOR_SEATS_CHANGED');
    expect(await rowsFor(id)).toBe(0);
    // Nothing of the grant landed either.
    const seat = (await t.db.select().from(profiles).where(eq(profiles.id, SEAT_NEW)))[0];
    expect(seat?.vendorId ?? null).not.toBe(VENDOR_B);
  });

  it('a withheld contest whose stamp another writer cleared first: no phantom seat_stamp_cleared row', async () => {
    await banSeatDirectly(SEAT_B);
    const id = await stampedContest({ integrationId: I_POWERED });
    const plan = await planSeatGrantReturn(
      t.db,
      { vendorId: VENDOR_B, actorId: ADMIN, actorType: 'admin', now: STAMP, source: 's' },
      SEAT_NEW,
    );
    expect(plan).not.toBeNull();
    await t.db
      .update(integrationFieldChallenges)
      .set({ ownerSeatLapsedAt: null })
      .where(eq(integrationFieldChallenges.id, id));
    let error: unknown = null;
    try {
      await t.db.batch(plan!.stmts as BatchTuple);
    } catch (e) {
      error = e;
    }
    expect(isContestRaceError(error)).toBe(true);
    expect(await rowsFor(id)).toBe(0);
  });
});

// ─── Ruling A's forward-looking half on the return (review MINOR 5) ──────────

describe('the seat return never hands the owner a contest that would make its row connector-powered', () => {
  it('keeps a stamped mechanism_kind → iPaaS contest on an ordinary row with AECi, unstamped', async () => {
    await entitle(VENDOR_B);
    await banSeatDirectly(SEAT_B);
    const id = await stampedContest({ integrationId: I_PLAIN, field: 'mechanism_kind' });
    await t.db
      .update(integrationFieldChallenges)
      .set({ proposedValue: 'iPaaS' })
      .where(eq(integrationFieldChallenges.id, id));
    expect((await unban(SEAT_B)).status).toBe(200);
    expect(await contest(id)).toMatchObject({ routedTo: 'aeci', ownerSeatLapsedAt: null });
    expect(await auditsFor(id)).toEqual([
      { action: 'integration.contest.seat_stamp_cleared', reason: 'owner-may-not-decide' },
    ]);
  });

  it('still returns a mechanism_kind contest on an ordinary row that keeps it ordinary', async () => {
    await banSeatDirectly(SEAT_B);
    const id = await stampedContest({ integrationId: I_PLAIN, field: 'mechanism_kind' });
    // proposed 'marketplace-app': not a connector kind.
    await unban(SEAT_B);
    expect(await contest(id)).toMatchObject({ routedTo: 'owner', ownerSeatLapsedAt: null });
  });
});
