/**
 * The seat hand-back (AECI-989 / `STAGE_2_ATTESTATIONS_SPEC.md` §13.9), driven
 * through the two admin writers that remove or disable a seat, against the
 * real-SQLite harness:
 *
 *  - `DELETE /api/admin/vendors/:id/seats/:userId` (`admin-vendors.ts`): the last
 *    seat hands the record back; a revoke leaving only banned seats re-routes
 *    contests; a revoke leaving an active seat changes nothing.
 *  - `PATCH /api/admin/reviewers/:id` (`admin-reviewers.ts`): a ban of the last
 *    active seat re-routes contests and hands nothing back; the unban routes them
 *    back.
 *
 * The promotability assertion runs the real promote ingest after the revoke,
 * because "claimed_at is NULL" is only the mechanism. The contract is that the
 * review app can write the row again.
 */

import { PromotePayloadSchema } from '@aeci/shared';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  attestations,
  auditLog,
  claims,
  connectorEvidencedPairs,
  integrationFieldChallenges,
  integrations,
  productVendors,
  products,
  profiles,
  taxonomyDataObjects,
  vendorEntitlements,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthenticatedSession, AuthzVariables } from '../lib/authz';
import type { DbFactory } from '../lib/handler-utils';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createBanReviewerHandler } from './admin-reviewers';
import { createAdminRevokeSeatHandler, createProvisionSeatHandler } from './admin-vendors';
import type { resolveClaimantIdentity } from '../lib/claimant-identity';
import { REFUSED_CLAIMED_INTEGRATION, runPromoteIngest, type PromoteRunCtx } from './promote';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const ADMIN = u(1);
const VENDOR = u(10); // the vendor losing its seats
const OTHER = u(11); // the other endpoint vendor, unseated so promote reaches the edge
const CO_OWNER = u(12); // co-owns one product, seated
const SEAT_A = u(20);
const SEAT_B = u(21);
const SEAT_CO = u(23);
const P_MINE = u(30);
const P_SHARED = u(31); // co-owned with CO_OWNER
const P_THEIRS = u(32);
const I_OWNED = u(40); // owned + claimed, no vendor attestation
const I_ATTESTED = u(41); // owned + claimed, a live vendor attestation
const I_CREATED = u(42); // vendor-created, claimed
const I_RETIRED = u(43); // owned + claimed, retired
const CONTEST = u(50);
const DATA_OBJECT = u(60);
const CLAIM = u(61);

const REVIEWED = '2026-09-01T00:00:00.000Z';
const CLAIMED_AT = '2026-09-02T00:00:00.000Z';

const ADMIN_SESSION = {
  userId: ADMIN,
  email: 'admin@aecintegrations.com',
  role: 'admin',
  vendorId: null,
  entitlementTier: 'unclaimed',
  entitlement: null,
} as unknown as AuthenticatedSession;

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(profiles).values({ id: ADMIN, role: 'admin' });
  await t.db.insert(vendors).values([
    {
      id: VENDOR,
      slug: 'bentley',
      companyName: 'Bentley',
      verified: true,
      promotionStatus: 'promoted',
      maintainedBy: 'vendor',
      lastReviewedAt: REVIEWED,
    },
    { id: OTHER, slug: 'autodesk', companyName: 'Autodesk', promotionStatus: 'promoted' },
    { id: CO_OWNER, slug: 'trimble', companyName: 'Trimble', promotionStatus: 'promoted' },
  ]);
  await t.db.insert(vendorEntitlements).values({
    id: u(70),
    vendorId: VENDOR,
    tier: 'verified',
    status: 'active',
  });
  await t.db.insert(products).values([
    {
      id: P_MINE,
      slug: 'microstation',
      name: 'MicroStation',
      promotionStatus: 'promoted',
      maintainedBy: 'vendor',
      lastReviewedAt: REVIEWED,
    },
    {
      id: P_SHARED,
      slug: 'synchro',
      name: 'Synchro',
      promotionStatus: 'promoted',
      maintainedBy: 'vendor',
      lastReviewedAt: REVIEWED,
    },
    { id: P_THEIRS, slug: 'revit', name: 'Revit', promotionStatus: 'promoted' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_MINE, vendorId: VENDOR, isPrimary: true },
    { productId: P_SHARED, vendorId: VENDOR, isPrimary: true },
    { productId: P_SHARED, vendorId: CO_OWNER, isPrimary: false },
    { productId: P_THEIRS, vendorId: OTHER, isPrimary: true },
  ]);
  const owned = {
    sourceProductId: P_THEIRS,
    targetProductId: P_MINE,
    builtByVendorId: VENDOR,
    maintainedBy: 'vendor',
    lastReviewedAt: REVIEWED,
    claimedAt: CLAIMED_AT,
  };
  await t.db.insert(integrations).values([
    { id: I_OWNED, name: 'Owner name', mechanismKind: 'native', ...owned },
    { id: I_ATTESTED, name: 'Attested', mechanismKind: 'api', ...owned },
    {
      id: I_CREATED,
      name: 'Created',
      mechanismKind: 'marketplace-app',
      origin: 'vendor',
      ...owned,
    },
    {
      id: I_RETIRED,
      name: 'Retired',
      mechanismKind: 'webhook',
      retiredAt: CLAIMED_AT,
      retiredBy: 'owner',
      ...owned,
    },
  ]);
  await t.db
    .insert(taxonomyDataObjects)
    .values({ id: DATA_OBJECT, slug: 'rfis', name: 'RFIs', displayOrder: 10 });
  await t.db.insert(claims).values({
    id: CLAIM,
    integrationId: I_ATTESTED,
    dataObjectId: DATA_OBJECT,
    direction: 'a_to_b',
  });
  await t.db
    .insert(attestations)
    .values({ id: u(62), claimId: CLAIM, source: 'vendor_b', asserted: true });
  await t.db.insert(integrationFieldChallenges).values({
    id: CONTEST,
    integrationId: I_OWNED,
    field: 'name',
    reason: 'r',
    submitterVendorId: OTHER,
    routedTo: 'owner',
    ownerVendorId: VENDOR,
  });
  await t.db.insert(profiles).values([
    { id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true },
    { id: SEAT_CO, role: 'vendor_admin', vendorId: CO_OWNER },
  ]);
});
afterEach(() => t.dispose());

type App = Hono<{ Bindings: Env; Variables: AuthzVariables }>;

function adminApp(): App {
  const app: App = new Hono();
  app.onError(errorHandler());
  app.use('*', async (c, next) => {
    c.set('auth', ADMIN_SESSION);
    await next();
  });
  app.delete('/api/admin/vendors/:id/seats/:userId', createAdminRevokeSeatHandler(t.factory));
  app.patch('/api/admin/reviewers/:id', createBanReviewerHandler(t.factory));
  app.post(
    '/api/admin/vendors/:id/seats',
    createProvisionSeatHandler(t.factory, (async () => ({
      outcome: 'linked',
      userId: SEAT_B,
      email: 'new-seat@bentley.example',
      profile: null,
    })) as unknown as typeof resolveClaimantIdentity),
  );
  return app;
}

async function call(
  path: string,
  method: 'DELETE' | 'PATCH' | 'POST',
  payload?: unknown,
): Promise<{ status: number; send: ReturnType<typeof vi.fn> }> {
  const send = vi.fn().mockResolvedValue(undefined);
  const env: Env = {
    ...TEST_ENV,
    CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'],
  };
  const execCtx = fakeExecutionContext();
  const init: RequestInit =
    payload === undefined
      ? { method }
      : { method, body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } };
  const res = await adminApp().request(path, init, env, execCtx);
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return { status: res.status, send };
}

const revoke = (userId: string) => call(`/api/admin/vendors/${VENDOR}/seats/${userId}`, 'DELETE');
const ban = (userId: string) =>
  call(`/api/admin/reviewers/${userId}`, 'PATCH', { action: 'ban', reason: 'abuse' });
const unban = (userId: string) =>
  call(`/api/admin/reviewers/${userId}`, 'PATCH', { action: 'unban' });

const integration = async (id: string) =>
  (await t.db.query.integrations.findFirst({ where: eq(integrations.id, id) }))!;
const contest = async () =>
  (await t.db.query.integrationFieldChallenges.findFirst({
    where: eq(integrationFieldChallenges.id, CONTEST),
  }))!;
const vendorRow = async () =>
  (await t.db.query.vendors.findFirst({ where: eq(vendors.id, VENDOR) }))!;
const product = async (id: string) =>
  (await t.db.query.products.findFirst({ where: eq(products.id, id) }))!;
const auditActions = async () =>
  (await t.db.select({ action: auditLog.action }).from(auditLog)).map((r) => r.action).sort();

async function catalogSnapshot() {
  return {
    vendor: await vendorRow(),
    products: await t.db.select().from(products),
    integrations: await t.db.select().from(integrations),
    claims: await t.db.select().from(claims),
    attestations: await t.db.select().from(attestations),
    contests: await t.db.select().from(integrationFieldChallenges),
  };
}

// ─── The last seat ───────────────────────────────────────────────────────────

describe('revoking the LAST seat hands the record back (AECI-989)', () => {
  it('returns the vendor and its solely-owned products to AECi, keeping last_reviewed_at', async () => {
    expect((await revoke(SEAT_A)).status).toBe(204);

    const vendor = await vendorRow();
    expect(vendor.maintainedBy).toBe('aeci');
    expect(vendor.lastReviewedAt).toBe(REVIEWED);
    // Seat and entitlement are orthogonal (PAID_TIERS §5.2).
    expect(vendor.verified).toBe(true);
    const [ent] = await t.db
      .select()
      .from(vendorEntitlements)
      .where(eq(vendorEntitlements.vendorId, VENDOR));
    expect(ent.status).toBe('active');

    const mine = await product(P_MINE);
    expect(mine.maintainedBy).toBe('aeci');
    expect(mine.lastReviewedAt).toBe(REVIEWED);
    // A co-owner still holds a seat, so AECI-520 still blocks promote on it.
    expect((await product(P_SHARED)).maintainedBy).toBe('vendor');
  });

  it('un-claims every live owned integration, and flips the marker only where no vendor attestation survives', async () => {
    await revoke(SEAT_A);

    const owned = await integration(I_OWNED);
    expect(owned.claimedAt).toBeNull();
    expect(owned.maintainedBy).toBe('aeci');
    expect(owned.lastReviewedAt).toBe(REVIEWED);
    expect(owned.builtByVendorId).toBe(VENDOR);

    // §13.4: a live vendor attestation keeps the row vendor-maintained.
    const attested = await integration(I_ATTESTED);
    expect(attested.claimedAt).toBeNull();
    expect(attested.maintainedBy).toBe('vendor');

    // Vendor-created: the claim clears, `origin` stays, so the fence still holds.
    const created = await integration(I_CREATED);
    expect(created.claimedAt).toBeNull();
    expect(created.origin).toBe('vendor');

    // Retired: keeps its claim, so a re-seated vendor can restore it.
    const retired = await integration(I_RETIRED);
    expect(retired.claimedAt).toBe(CLAIMED_AT);
    expect(retired.retiredAt).toBe(CLAIMED_AT);
  });

  it('keeps every claim and attestation, and deletes nothing', async () => {
    const before = await catalogSnapshot();
    await revoke(SEAT_A);
    const after = await catalogSnapshot();
    expect(after.claims).toEqual(before.claims);
    expect(after.attestations).toEqual(before.attestations);
    expect(after.integrations).toHaveLength(before.integrations.length);
    expect(after.contests).toHaveLength(before.contests.length);
  });

  it('re-routes the open owner contest to AECi for good, unstamped', async () => {
    await revoke(SEAT_A);
    const row = await contest();
    expect(row.routedTo).toBe('aeci');
    expect(row.ownerSeatLapsedAt).toBeNull();
    expect(row.status).toBe('open');
  });

  it('writes every audit row in the revoke batch, with the maintenance-marker reason on each flip', async () => {
    const batchSpy = vi.spyOn(t.db, 'batch');
    await revoke(SEAT_A);
    const writes = batchSpy.mock.calls.filter(([stmts]) => stmts.length > 0);
    expect(writes).toHaveLength(1);
    batchSpy.mockRestore();

    expect(await auditActions()).toEqual(
      [
        'vendor_claim.seat_revoked',
        'vendor.updated', // vendor marker
        'product.updated', // P_MINE marker
        'integration.updated', // I_OWNED un-claim
        'integration.updated', // I_OWNED marker
        'integration.updated', // I_ATTESTED un-claim
        'integration.updated', // I_CREATED un-claim
        'integration.updated', // I_CREATED marker
        'integration.contest.rerouted',
      ].sort(),
    );
    const flips = (await t.db.select().from(auditLog)).filter(
      (row) => (row.afterState as { maintained_by?: string } | null)?.maintained_by === 'aeci',
    );
    expect(flips).toHaveLength(4);
    for (const row of flips) {
      expect(row.metadata).toMatchObject({
        reason: 'maintenance-marker',
        cause: 'owner-seat-revoked',
      });
    }
  });

  it('purges the vendor page, the product page and each pair page whose marker changed', async () => {
    const { send } = await revoke(SEAT_A);
    expect(send).toHaveBeenCalledTimes(1);
    const { tags, source } = send.mock.calls[0]![0] as { tags: string[]; source: string };
    expect(source).toBe('moderation');
    expect(tags).toEqual(
      expect.arrayContaining([
        'vendor:bentley',
        'product:microstation',
        'index:products',
        'pair:microstation__revit',
        'product:revit',
      ]),
    );
    expect(tags).not.toContain('product:synchro');
  });

  it('lets promote write the handed-back integration again (the AECI-1005 fence lifts)', async () => {
    const promote = (name: string) =>
      runPromoteIngest(
        {
          env: { ENV: 'preview' } as Env,
          request: new Request('http://localhost:8787/api/promote'),
          waitUntil: () => {},
          bookmark: () => null,
        } satisfies PromoteRunCtx,
        PromotePayloadSchema.parse({
          vendors: [],
          product: { ref: 'p1', supabaseId: P_THEIRS, name: 'Revit' },
          integrations: [
            {
              ref: 'i1',
              supabaseId: I_OWNED,
              sourceProduct: { ref: 'p1' },
              targetProduct: { supabaseId: P_MINE },
              name,
              mechanismKind: 'native',
              claims: [],
            },
          ],
        }),
        {
          dbFor: t.factory as DbFactory,
          syncAlgolia: async () => {},
          notifyIndexNow: async () => {},
          refreshHomeStats: async () => {},
        },
        {},
      );

    // Fenced while the seat stands.
    const fenced = await promote('Curated before');
    expect(fenced.response.skipped).toContainEqual({
      ref: 'i1',
      kind: 'integration',
      reason: REFUSED_CLAIMED_INTEGRATION,
    });
    expect((await integration(I_OWNED)).name).toBe('Owner name');

    await revoke(SEAT_A);

    const written = await promote('Curated after');
    expect(written.response.skipped.filter((s) => s.ref === 'i1')).toEqual([]);
    expect(written.response.integrations.map((i) => i.id)).toContain(I_OWNED);
    expect((await integration(I_OWNED)).name).toBe('Curated after');
  });

  it('is a no-op beyond the seat when nothing is vendor-maintained or claimed', async () => {
    await t.db.update(vendors).set({ maintainedBy: 'aeci' }).where(eq(vendors.id, VENDOR));
    await t.db.update(products).set({ maintainedBy: 'aeci' });
    await t.db.update(integrations).set({ claimedAt: null, maintainedBy: 'aeci' });
    await t.db.delete(integrationFieldChallenges);

    const { send } = await revoke(SEAT_A);
    expect(await auditActions()).toEqual(['vendor_claim.seat_revoked']);
    expect(send).not.toHaveBeenCalled();
  });
});

// ─── Not the last seat ───────────────────────────────────────────────────────

describe('revoking a seat while an active one remains changes nothing else', () => {
  it('leaves every marker, claim and contest as it was', async () => {
    await t.db.insert(profiles).values({ id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR });
    const before = await catalogSnapshot();
    const { send } = await revoke(SEAT_A);
    expect(await catalogSnapshot()).toEqual(before);
    expect(await auditActions()).toEqual(['vendor_claim.seat_revoked']);
    expect(send).not.toHaveBeenCalled();
  });

  it('re-routes contests but hands nothing back when only a BANNED seat remains', async () => {
    await t.db.insert(profiles).values({
      id: SEAT_B,
      role: 'vendor_admin',
      vendorId: VENDOR,
      bannedAt: CLAIMED_AT,
    });
    await revoke(SEAT_A);
    expect((await vendorRow()).maintainedBy).toBe('vendor');
    expect((await integration(I_OWNED)).claimedAt).toBe(CLAIMED_AT);
    const row = await contest();
    expect(row.routedTo).toBe('aeci');
    expect(row.ownerSeatLapsedAt).not.toBeNull();
  });
});

// ─── Ban and unban ───────────────────────────────────────────────────────────

describe('a ban of the last active seat (AECI-989, ruled 2026-09-23)', () => {
  it('hands nothing back, and moves the open owner contest to AECi, stamped', async () => {
    const before = await catalogSnapshot();
    expect((await ban(SEAT_A)).status).toBe(200);

    const after = await catalogSnapshot();
    expect(after.vendor.maintainedBy).toBe('vendor');
    expect(after.integrations).toEqual(before.integrations);
    expect(after.products).toEqual(before.products);

    const row = await contest();
    expect(row.routedTo).toBe('aeci');
    expect(row.ownerSeatLapsedAt).not.toBeNull();
    const rerouted = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'integration.contest.rerouted'));
    expect(rerouted).toHaveLength(1);
    expect(rerouted[0].metadata).toMatchObject({ reason: 'owner-seat-lapsed' });
  });

  it('does not re-route while another active seat remains', async () => {
    await t.db.insert(profiles).values({ id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR });
    await ban(SEAT_A);
    expect((await contest()).routedTo).toBe('owner');
  });

  it('routes the contest back to the owner on unban, and clears the stamp', async () => {
    await ban(SEAT_A);
    expect((await unban(SEAT_A)).status).toBe(200);
    const row = await contest();
    expect(row.routedTo).toBe('owner');
    expect(row.ownerSeatLapsedAt).toBeNull();
    const reasons = (
      await t.db.select().from(auditLog).where(eq(auditLog.action, 'integration.contest.rerouted'))
    ).map((r) => (r.metadata as { reason: string }).reason);
    expect(reasons.sort()).toEqual(['owner-seat-lapsed', 'owner-seat-restored']);
  });

  it('never routes back a contest AECi has already decided', async () => {
    await ban(SEAT_A);
    await t.db
      .update(integrationFieldChallenges)
      .set({ status: 'declined' })
      .where(eq(integrationFieldChallenges.id, CONTEST));
    await unban(SEAT_A);
    expect(await contest()).toMatchObject({ routedTo: 'aeci', status: 'declined' });
  });

  it('never routes back a contest a hand-back took, even after the owner re-claims', async () => {
    // Ban, then the banned seat is revoked (the hand-back), then a fresh seat, a
    // re-claim, a ban and an unban. The contest stayed with AECi throughout.
    await ban(SEAT_A);
    await revoke(SEAT_A);
    await t.db.insert(profiles).values({ id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR });
    await t.db
      .update(integrations)
      .set({ claimedAt: '2099-01-01T00:00:00.000Z' })
      .where(and(eq(integrations.id, I_OWNED)));
    await ban(SEAT_B);
    await unban(SEAT_B);
    expect((await contest()).routedTo).toBe('aeci');
  });
});

// ─── Races ───────────────────────────────────────────────────────────────────

describe('a seat write that loses a race writes nothing (409 VENDOR_SEATS_CHANGED)', () => {
  /** Run `interleave` between the handler's reads and its batch. */
  function interleaveBeforeBatch(interleave: () => Promise<unknown>) {
    const original = t.db.batch.bind(t.db);
    return vi.spyOn(t.db, 'batch').mockImplementationOnce((async (stmts: never) => {
      await interleave();
      return original(stmts);
    }) as never);
  }

  it('a double-click revoke: the loser commits no hand-back audit rows', async () => {
    interleaveBeforeBatch(() =>
      t.db
        .update(profiles)
        .set({ role: 'reviewer', vendorId: null })
        .where(eq(profiles.id, SEAT_A)),
    );
    expect((await revoke(SEAT_A)).status).toBe(409);
    expect(await auditActions()).toEqual([]);
    expect((await integration(I_OWNED)).claimedAt).toBe(CLAIMED_AT);
    expect((await vendorRow()).maintainedBy).toBe('vendor');
  });

  it('a seat provisioned while the last-seat revoke ran: no hand-back', async () => {
    interleaveBeforeBatch(() =>
      t.db.insert(profiles).values({ id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR }),
    );
    expect((await revoke(SEAT_A)).status).toBe(409);
    const [seat] = await t.db.select().from(profiles).where(eq(profiles.id, SEAT_A));
    expect(seat.role).toBe('vendor_admin');
    expect((await integration(I_OWNED)).claimedAt).toBe(CLAIMED_AT);
  });

  it('two seats revoked at once: the one that planned "none" rolls back', async () => {
    await t.db.insert(profiles).values({ id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR });
    interleaveBeforeBatch(() =>
      t.db
        .update(profiles)
        .set({ role: 'reviewer', vendorId: null })
        .where(eq(profiles.id, SEAT_B)),
    );
    expect((await revoke(SEAT_A)).status).toBe(409);
    // A retry now sees the last seat and hands back.
    expect((await revoke(SEAT_A)).status).toBe(204);
    expect((await integration(I_OWNED)).claimedAt).toBeNull();
  });
});

// ─── A new seat returns ban-moved contests (ruled 2026-09-23) ────────────────

describe('a new seat grant returns the contests a ban moved to AECi', () => {
  const provision = () =>
    call(`/api/admin/vendors/${VENDOR}/seats`, 'POST', { email: 'new-seat@bentley.example' });

  it('routes the stamped contest back to the owner when a fresh seat is provisioned', async () => {
    await ban(SEAT_A);
    expect((await contest()).routedTo).toBe('aeci');

    expect((await provision()).status).toBe(201);
    const row = await contest();
    expect(row.routedTo).toBe('owner');
    expect(row.ownerSeatLapsedAt).toBeNull();
    const restored = (
      await t.db.select().from(auditLog).where(eq(auditLog.action, 'integration.contest.rerouted'))
    ).filter((r) => (r.metadata as { reason: string }).reason === 'owner-seat-restored');
    expect(restored).toHaveLength(1);
  });

  it('returns nothing when the profile getting the new seat is banned', async () => {
    await ban(SEAT_A);
    await t.db
      .insert(profiles)
      .values({ id: SEAT_B, role: 'reviewer', bannedAt: CLAIMED_AT, banReason: 'abuse' });
    await provision();
    expect((await contest()).routedTo).toBe('aeci');
  });
});

// ─── Evidenced pairs (AECI-1089) ─────────────────────────────────────────────

describe('revoking the LAST seat hands back claimed evidenced pairs too (AECI-1089)', () => {
  const P_CONNECTOR = u(33);
  const P_OTHER_CONNECTOR = u(34);
  const EP_OWNED = u(80); // owned + claimed, no vendor attestation
  const EP_ATTESTED = u(81); // owned + claimed, a live vendor attestation on the pair
  const EP_RETIRED = u(82); // owned + claimed, retired
  const PAIR_CLAIM = u(83);

  const pair = async (id: string) =>
    (await t.db.query.connectorEvidencedPairs.findFirst({
      where: eq(connectorEvidencedPairs.id, id),
    }))!;

  beforeEach(async () => {
    await t.db.insert(products).values([
      { id: P_CONNECTOR, slug: 'zapier', name: 'Zapier', promotionStatus: 'promoted' },
      { id: P_OTHER_CONNECTOR, slug: 'make', name: 'Make', promotionStatus: 'promoted' },
    ]);
    const ownedPair = {
      productAId: P_MINE,
      productBId: P_THEIRS,
      builtByVendorId: VENDOR,
      maintainedBy: 'vendor',
      lastReviewedAt: REVIEWED,
      claimedAt: CLAIMED_AT,
    };
    await t.db.insert(connectorEvidencedPairs).values([
      { id: EP_OWNED, connectorProductId: P_CONNECTOR, name: 'Pair owned', ...ownedPair },
      {
        id: EP_ATTESTED,
        connectorProductId: P_OTHER_CONNECTOR,
        name: 'Pair attested',
        ...ownedPair,
      },
      {
        id: EP_RETIRED,
        connectorProductId: P_CONNECTOR,
        name: 'Pair retired',
        ...ownedPair,
        productAId: P_SHARED,
        retiredAt: CLAIMED_AT,
        retiredBy: 'owner',
      },
    ]);
    await t.db.insert(claims).values({
      id: PAIR_CLAIM,
      connectorEvidencedPairId: EP_ATTESTED,
      dataObjectId: DATA_OBJECT,
      direction: 'a_to_b',
    });
    await t.db
      .insert(attestations)
      .values({ id: u(84), claimId: PAIR_CLAIM, source: 'vendor_a', asserted: true });
  });

  it('un-claims every live owned pair, and flips the marker only where no vendor attestation survives', async () => {
    expect((await revoke(SEAT_A)).status).toBe(204);

    const owned = await pair(EP_OWNED);
    expect(owned.claimedAt).toBeNull();
    expect(owned.maintainedBy).toBe('aeci');
    expect(owned.origin).toBe('aeci');
    expect(owned.builtByVendorId).toBe(VENDOR);
    expect(owned.lastReviewedAt).toBe(REVIEWED);

    // §13.4: a live vendor attestation keeps the pair vendor-maintained.
    const attested = await pair(EP_ATTESTED);
    expect(attested.claimedAt).toBeNull();
    expect(attested.maintainedBy).toBe('vendor');

    // Retired: keeps its claim, so a re-seated vendor can restore it.
    const retired = await pair(EP_RETIRED);
    expect(retired.claimedAt).toBe(CLAIMED_AT);
    expect(retired.retiredAt).toBe(CLAIMED_AT);
  });

  it('keeps the pair claims and attestations, and deletes no pair', async () => {
    const before = {
      pairs: await t.db.select().from(connectorEvidencedPairs),
      claims: await t.db.select().from(claims),
      attestations: await t.db.select().from(attestations),
    };
    await revoke(SEAT_A);
    expect(await t.db.select().from(connectorEvidencedPairs)).toHaveLength(before.pairs.length);
    expect(await t.db.select().from(claims)).toEqual(before.claims);
    expect(await t.db.select().from(attestations)).toEqual(before.attestations);
  });

  it('writes the pair audit rows in the revoke batch, on the pair entity with the evidenced anchor', async () => {
    const batchSpy = vi.spyOn(t.db, 'batch');
    await revoke(SEAT_A);
    expect(batchSpy.mock.calls.filter(([stmts]) => stmts.length > 0)).toHaveLength(1);
    batchSpy.mockRestore();

    const rows = (await t.db.select().from(auditLog)).filter(
      (row) => row.entityType === 'connector_evidenced_pair',
    );
    // EP_OWNED un-claim + marker, EP_ATTESTED un-claim. EP_RETIRED writes nothing.
    expect(rows.map((r) => r.entityId).sort()).toEqual([EP_OWNED, EP_OWNED, EP_ATTESTED].sort());
    for (const row of rows) {
      expect(row.action).toBe('integration.updated');
      expect(row.metadata).toMatchObject({
        anchor: 'evidenced_pair',
        integrationId: row.entityId,
        vendor_id: VENDOR,
      });
    }
    const flip = rows.find(
      (row) => (row.afterState as { maintained_by?: string } | null)?.maintained_by === 'aeci',
    );
    expect(flip?.metadata).toMatchObject({
      reason: 'maintenance-marker',
      cause: 'owner-seat-revoked',
    });
  });

  it("purges the flipped pair's page, both endpoints and its connector's page", async () => {
    const { send } = await revoke(SEAT_A);
    const { tags } = send.mock.calls[0]![0] as { tags: string[] };
    expect(tags).toEqual(
      expect.arrayContaining([
        'pair:microstation__revit',
        'product:microstation',
        'product:revit',
        'product:zapier',
      ]),
    );
    // EP_ATTESTED kept its marker, so its connector's page does not move.
    expect(tags).not.toContain('product:make');
  });

  it('writes nothing to the pairs when a seat lands between the plan and the batch (409 VENDOR_SEATS_CHANGED)', async () => {
    const original = t.db.batch.bind(t.db);
    vi.spyOn(t.db, 'batch').mockImplementationOnce((async (stmts: never) => {
      await t.db.insert(profiles).values({ id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR });
      return original(stmts);
    }) as never);
    const { status } = await revoke(SEAT_A);
    expect(status).toBe(409);
    const owned = await pair(EP_OWNED);
    expect(owned.claimedAt).toBe(CLAIMED_AT);
    expect(owned.maintainedBy).toBe('vendor');
  });

  it('leaves the pairs alone when an active seat remains', async () => {
    await t.db.insert(profiles).values({ id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR });
    await revoke(SEAT_A);
    expect((await pair(EP_OWNED)).claimedAt).toBe(CLAIMED_AT);
    expect((await pair(EP_ATTESTED)).claimedAt).toBe(CLAIMED_AT);
  });
});
