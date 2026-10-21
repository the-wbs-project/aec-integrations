/**
 * Seat loss and the return to AECi (AECI-989, reworked by AECI-1415 / ADR 0042;
 * `STAGE_2_ATTESTATIONS_SPEC.md` §13.9), driven through the admin writers against
 * the real-SQLite harness:
 *
 *  - `DELETE /api/admin/vendors/:id/seats/:userId` (`admin-vendors.ts`): the last
 *    seat FREEZES the record. Ownership, markers and claims stay; the open owner
 *    contests move to AECi, stamped. A revoke leaving an active seat changes nothing.
 *  - `PATCH /api/admin/reviewers/:id` (`admin-reviewers.ts`): a ban of the last
 *    active seat re-routes contests and hands nothing back; the unban routes them
 *    back.
 *  - `POST /api/admin/vendors/:id/return-to-aeci` (`admin-vendors.ts`): "Return
 *    records to AECi", the one action that hands records back, refused while any
 *    seat remains.
 *
 * The promotability assertions run the real promote ingest, because "claimed_at is
 * NULL" is only the mechanism. The contract is whether the review app can write the
 * row again.
 */

import { PromotePayloadSchema } from '@aeci/shared';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  attestations,
  auditLog,
  billingAccounts,
  claims,
  connectorEvidencedPairs,
  integrationFieldChallenges,
  integrations,
  licenses,
  productProposals,
  productVendors,
  products,
  profiles,
  taxonomyDataObjects,
  vendorSeatInvites,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthenticatedSession, AuthzVariables } from '../lib/authz';
import type { DbFactory } from '../lib/handler-utils';
import { makeTestDb, type TestDb } from '../test/d1';
import { FLAGS_AFTER_GRANT, readCancelFlags, seedCancelFlags, seedLicense } from '../test/licenses';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createBanReviewerHandler } from './admin-reviewers';
import {
  createAdminRevokeSeatHandler,
  createProvisionSeatHandler,
  createReturnRecordsHandler,
} from './admin-vendors';
import type { resolveClaimantIdentity } from '../lib/claimant-identity';
import { runPromoteIngest, type PromoteRunCtx } from './promote';
import { logBatchToPosthog, logToPosthog } from '../posthog';
import { planSeatGrantReturn, planVendorHandback } from '../lib/vendor-handback';

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
const OWNED_AT = '2026-08-30T00:00:00.000Z';

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
      ownedAt: OWNED_AT,
    },
    { id: OTHER, slug: 'autodesk', companyName: 'Autodesk', promotionStatus: 'promoted' },
    // Seated, so owned (AECI-1415): promote refuses P_SHARED through it too (Q3).
    {
      id: CO_OWNER,
      slug: 'trimble',
      companyName: 'Trimble',
      promotionStatus: 'promoted',
      ownedAt: OWNED_AT,
    },
  ]);
  // AECI-1351: the post-back-fill state, so a provision writes no account row.
  await t.db.insert(billingAccounts).values({ id: u(71), vendorId: VENDOR, name: 'Bentley' });
  // AECI-1355: the plan snapshot and the owner checks read licenses.
  await seedLicense(t.db, VENDOR);
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
  app.post('/api/admin/vendors/:id/return-to-aeci', createReturnRecordsHandler(t.factory));
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
): Promise<{
  status: number;
  code: string | null;
  send: ReturnType<typeof vi.fn>;
  body: Record<string, unknown> | null;
}> {
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
  const body = (await res.json().catch(() => null)) as
    | ({ error?: { code?: string } } & Record<string, unknown>)
    | null;
  return { status: res.status, code: body?.error?.code ?? null, send, body };
}

const revoke = (userId: string) =>
  call(`/api/admin/vendors/${VENDOR}/seats/${userId}`, 'DELETE', { reason: 'Left the company' });
const ban = (userId: string) =>
  call(`/api/admin/reviewers/${userId}`, 'PATCH', { action: 'ban', reason: 'abuse' });
const unban = (userId: string) =>
  call(`/api/admin/reviewers/${userId}`, 'PATCH', { action: 'unban' });
const returnRecords = (payload: unknown = { reason: 'Approved by mistake' }) =>
  call(`/api/admin/vendors/${VENDOR}/return-to-aeci`, 'POST', payload);
/** Revoke the last seat (the freeze), then return the records (the hand-back). */
async function handBack() {
  expect((await revoke(SEAT_A)).status).toBe(204);
  const returned = await returnRecords();
  expect(returned.status).toBe(200);
  return returned;
}

/** The review app's push of Revit, restating I_OWNED under a new name. */
const promoteRevit = (name: string) =>
  runPromoteIngest(
    {
      env: { ENV: 'staging' } as Env,
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

// ─── The last seat: it freezes (AECI-1415) ──────────────────────────────────

describe('revoking the LAST seat freezes the record and hands nothing back (AECI-1415)', () => {
  it('keeps ownership, every marker and every claim', async () => {
    const before = await catalogSnapshot();
    expect((await revoke(SEAT_A)).status).toBe(204);
    const after = await catalogSnapshot();
    expect(after.vendor.ownedAt).toBe(OWNED_AT);
    expect(after.vendor.maintainedBy).toBe('vendor');
    expect(after.products).toEqual(before.products);
    expect(after.integrations).toEqual(before.integrations);
    expect(after.claims).toEqual(before.claims);
    expect(after.attestations).toEqual(before.attestations);
    // Seat and plan are orthogonal (PAID_TIERS §5.2): the license stays live.
    const held = await t.db.select().from(licenses);
    expect(held.every((l) => l.endedAt === null)).toBe(true);
  });

  it('moves the open owner contest to AECi, stamped, so a new seat gets it back', async () => {
    await revoke(SEAT_A);
    const row = await contest();
    expect(row.routedTo).toBe('aeci');
    expect(row.ownerSeatLapsedAt).not.toBeNull();
    const [rerouted] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'integration.contest.rerouted'));
    expect(rerouted!.metadata).toMatchObject({ reason: 'owner-seat-lapsed' });
  });

  it('writes the seat row and the re-route only, and purges nothing', async () => {
    const { send } = await revoke(SEAT_A);
    expect(await auditActions()).toEqual(
      ['vendor_claim.seat_revoked', 'integration.contest.rerouted'].sort(),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('promote still refuses the frozen records', async () => {
    await revoke(SEAT_A);
    const { response } = await promoteRevit('Curated after the revoke');
    expect(response.skipped.map((s) => s.ref)).toContain('i1');
    expect((await integration(I_OWNED)).name).toBe('Owner name');
  });
});

// ─── The return to AECi (AECI-1415) ──────────────────────────────────────────

describe('returning the records to AECi hands them back (AECI-1415)', () => {
  it('clears ownership and returns the vendor and its solely-owned products to AECi', async () => {
    await handBack();

    const vendor = await vendorRow();
    expect(vendor.ownedAt).toBeNull();
    expect(vendor.maintainedBy).toBe('aeci');
    expect(vendor.lastReviewedAt).toBe(REVIEWED);
    expect(vendor.verified).toBe(true);
    const held = await t.db.select().from(licenses);
    expect(held.length).toBeGreaterThan(0);
    expect(held.every((l) => l.endedAt === null)).toBe(true);

    const mine = await product(P_MINE);
    expect(mine.maintainedBy).toBe('aeci');
    expect(mine.lastReviewedAt).toBe(REVIEWED);
    // An owned co-owner still holds it (Q3), so promote still refuses it.
    expect((await product(P_SHARED)).maintainedBy).toBe('vendor');
  });

  it('un-claims every live owned integration, and flips the marker only where no vendor attestation survives', async () => {
    await handBack();

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

  it('answers with what it handed back', async () => {
    const { body } = await handBack();
    expect(body).toEqual({
      vendor_id: VENDOR,
      owned_at: null,
      product_ids: [P_MINE],
      integration_ids: expect.arrayContaining([I_OWNED, I_ATTESTED, I_CREATED]),
      evidenced_pair_ids: [],
      contests_rerouted: 0,
      discarded_proposal_ids: [],
    });
    expect((body!.integration_ids as string[]).length).toBe(3);
  });

  it('keeps every claim and attestation, and deletes nothing', async () => {
    const before = await catalogSnapshot();
    await handBack();
    const after = await catalogSnapshot();
    expect(after.claims).toEqual(before.claims);
    expect(after.attestations).toEqual(before.attestations);
    expect(after.integrations).toHaveLength(before.integrations.length);
    expect(after.contests).toHaveLength(before.contests.length);
  });

  it('keeps the contest the freeze moved with AECi, for good', async () => {
    await handBack();
    const row = await contest();
    expect(row.routedTo).toBe('aeci');
    expect(row.status).toBe('open');
    // A later seat and a re-claim do not bring it back: the re-claim is newer.
    await t.db.insert(profiles).values({ id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR });
    await t.db
      .update(integrations)
      .set({ claimedAt: '2099-01-01T00:00:00.000Z' })
      .where(eq(integrations.id, I_OWNED));
    await ban(SEAT_B);
    await unban(SEAT_B);
    expect((await contest()).routedTo).toBe('aeci');
  });

  it('re-routes a contest still routed to the owner to AECi, unstamped', async () => {
    await revoke(SEAT_A);
    // A contest filed and routed to the owner while it had a seat, left as it was.
    await t.db
      .update(integrationFieldChallenges)
      .set({ routedTo: 'owner', ownerSeatLapsedAt: null })
      .where(eq(integrationFieldChallenges.id, CONTEST));
    expect((await returnRecords()).status).toBe(200);
    const row = await contest();
    expect(row.routedTo).toBe('aeci');
    expect(row.ownerSeatLapsedAt).toBeNull();
  });

  it('writes every row in ONE return batch, with the reason on the return row', async () => {
    await revoke(SEAT_A);
    const batchSpy = vi.spyOn(t.db, 'batch');
    await returnRecords();
    const writes = batchSpy.mock.calls.filter(([stmts]) => stmts.length > 0);
    expect(writes).toHaveLength(1);
    batchSpy.mockRestore();

    expect(await auditActions()).toEqual(
      [
        'vendor_claim.seat_revoked',
        'integration.contest.rerouted', // the freeze
        'vendor.records_returned',
        'vendor.updated', // vendor marker
        'product.updated', // P_MINE marker
        'integration.updated', // I_OWNED un-claim
        'integration.updated', // I_OWNED marker
        'integration.updated', // I_ATTESTED un-claim
        'integration.updated', // I_CREATED un-claim
        'integration.updated', // I_CREATED marker
      ].sort(),
    );
    const [returned] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'vendor.records_returned'));
    expect(returned).toMatchObject({
      entityType: 'vendor',
      entityId: VENDOR,
      vendorId: VENDOR,
      actorId: ADMIN,
      beforeState: { owned_at: OWNED_AT },
      afterState: { owned_at: null },
    });
    expect(returned!.metadata).toMatchObject({
      reason: 'Approved by mistake',
      product_count: 1,
      integration_count: 3,
    });
    const flips = (await t.db.select().from(auditLog)).filter(
      (row) => (row.afterState as { maintained_by?: string } | null)?.maintained_by === 'aeci',
    );
    expect(flips).toHaveLength(4);
    for (const row of flips) {
      expect(row.metadata).toMatchObject({
        reason: 'maintenance-marker',
        cause: 'records-returned-to-aeci',
      });
    }
  });

  it('purges the vendor page, the product page and each pair page whose marker changed', async () => {
    const { send } = await handBack();
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

  it('lets promote write the returned integration again (the fences lift)', async () => {
    // Refused while the vendor owns its record, with or without a seat.
    const fenced = await promoteRevit('Curated before');
    expect(fenced.response.skipped.map((s) => s.ref)).toContain('i1');
    expect((await integration(I_OWNED)).name).toBe('Owner name');

    await handBack();

    const written = await promoteRevit('Curated after');
    expect(written.response.skipped.filter((s) => s.ref === 'i1')).toEqual([]);
    expect(written.response.integrations.map((i) => i.id)).toContain(I_OWNED);
    expect((await integration(I_OWNED)).name).toBe('Curated after');
  });

  it('is the return row alone when nothing is vendor-maintained or claimed', async () => {
    await t.db.update(vendors).set({ maintainedBy: 'aeci' }).where(eq(vendors.id, VENDOR));
    await t.db.update(products).set({ maintainedBy: 'aeci' });
    await t.db.update(integrations).set({ claimedAt: null, maintainedBy: 'aeci' });
    await t.db.delete(integrationFieldChallenges);

    const { send } = await handBack();
    expect(await auditActions()).toEqual(
      ['vendor.records_returned', 'vendor_claim.seat_revoked'].sort(),
    );
    expect(send).not.toHaveBeenCalled();
    expect((await vendorRow()).ownedAt).toBeNull();
  });

  it('revokes a live seat invite in the same batch', async () => {
    await revoke(SEAT_A);
    await t.db.insert(vendorSeatInvites).values({
      id: u(90),
      vendorId: VENDOR,
      email: 'colleague@bentley.example',
      token: 'tok-return-records',
      invitedById: null,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect((await returnRecords()).status).toBe(200);
    const [invite] = await t.db.select().from(vendorSeatInvites);
    expect(invite!.revokedAt).not.toBeNull();
    expect(await auditActions()).toContain('vendor_seat.invite_revoked');
  });
});

describe('the return to AECi discards the open product proposals (AECI-1416, ruled 2026-10-19)', () => {
  const proposal = (id: string, ref: string, decision: 'accepted' | 'declined' | null) => ({
    id,
    vendorId: VENDOR,
    ref,
    payload: { version: 1, product: { ref, name: ref }, vendors: [] },
    proposedAt: OWNED_AT,
    decision,
    decidedAt: decision ? OWNED_AT : null,
  });

  it('deletes the open ones in the return batch, keeps the decided ones, and records the ids', async () => {
    await t.db
      .insert(productProposals)
      .values([
        proposal(u(95), 'p:recOpen00001', null),
        proposal(u(96), 'p:recDeclined1', 'declined'),
        proposal(u(97), 'p:recAccepted1', 'accepted'),
      ]);
    const { body } = await handBack();
    expect(body!.discarded_proposal_ids).toEqual([u(95)]);
    const left = await t.db.select().from(productProposals).orderBy(productProposals.id);
    expect(left.map((r) => r.id)).toEqual([u(96), u(97)]);
    const row = (await t.db.select().from(auditLog)).find(
      (r) => r.action === 'vendor.records_returned',
    );
    expect(row!.metadata).toMatchObject({
      proposals_discarded: 1,
      discarded_proposal_ids: [u(95)],
    });
  });

  it('lets a re-send of a discarded ref create the product normally', async () => {
    await t.db.insert(productProposals).values(proposal(u(95), 'p:recOpen00001', null));
    await handBack();
    const { response } = await runPromoteIngest(
      {
        env: { ENV: 'staging' } as Env,
        request: new Request('http://localhost:8787/api/promote'),
        waitUntil: () => {},
        bookmark: () => null,
      } satisfies PromoteRunCtx,
      PromotePayloadSchema.parse({
        vendors: [{ ref: 'v1', supabaseId: VENDOR, companyName: 'Bentley' }],
        product: { ref: 'p:recOpen00001', name: 'OpenRoads' },
      }),
      {
        dbFor: t.factory,
        syncAlgolia: async () => {},
        notifyIndexNow: async () => {},
        refreshHomeStats: async () => {},
      },
    );
    expect(response.product?.operation).toBe('created');
    expect(await t.db.select().from(productProposals)).toEqual([]);
  });

  it('refuses with 409 VENDOR_PROPOSALS_CHANGED when a proposal lands after the read', async () => {
    await revoke(SEAT_A);
    const original = t.db.batch.bind(t.db);
    vi.spyOn(t.db, 'batch').mockImplementationOnce((async (stmts: never) => {
      await t.db.insert(productProposals).values(proposal(u(98), 'p:recLate00001', null));
      return original(stmts);
    }) as never);
    expect(await returnRecords()).toMatchObject({ status: 409, code: 'VENDOR_PROPOSALS_CHANGED' });
    expect((await vendorRow()).ownedAt).toBe(OWNED_AT);
    expect((await t.db.select().from(productProposals)).map((r) => r.id)).toEqual([u(98)]);
  });
});

describe('the return to AECi refuses, and writes nothing', () => {
  it('while an unbanned seat remains (409 VENDOR_HAS_SEATS)', async () => {
    const before = await catalogSnapshot();
    const res = await returnRecords();
    expect(res).toMatchObject({ status: 409, code: 'VENDOR_HAS_SEATS' });
    expect(await catalogSnapshot()).toEqual(before);
    expect(await auditActions()).toEqual([]);
  });

  it('while only a BANNED seat remains: an unban would re-seat an AECi record', async () => {
    await t.db.update(profiles).set({ bannedAt: CLAIMED_AT }).where(eq(profiles.id, SEAT_A));
    expect(await returnRecords()).toMatchObject({ status: 409, code: 'VENDOR_HAS_SEATS' });
    expect((await vendorRow()).ownedAt).toBe(OWNED_AT);
  });

  it('when AECi owns the records already (409 VENDOR_NOT_OWNED)', async () => {
    await handBack();
    expect(await returnRecords()).toMatchObject({ status: 409, code: 'VENDOR_NOT_OWNED' });
  });

  it('without a reason (400)', async () => {
    await revoke(SEAT_A);
    expect((await returnRecords({})).status).toBe(400);
    expect((await vendorRow()).ownedAt).toBe(OWNED_AT);
  });

  it('when a seat lands between the read and the batch (409 VENDOR_SEATS_CHANGED)', async () => {
    await revoke(SEAT_A);
    const original = t.db.batch.bind(t.db);
    vi.spyOn(t.db, 'batch').mockImplementationOnce((async (stmts: never) => {
      await t.db.insert(profiles).values({ id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR });
      return original(stmts);
    }) as never);
    expect(await returnRecords()).toMatchObject({ status: 409, code: 'VENDOR_SEATS_CHANGED' });
    expect((await vendorRow()).ownedAt).toBe(OWNED_AT);
    expect((await integration(I_OWNED)).claimedAt).toBe(CLAIMED_AT);
  });
});

// ─── Not the last seat ───────────────────────────────────────────────────────

describe('revoking a seat while an active one remains changes nothing else', () => {
  it('leaves every marker, claim and contest as it was', async () => {
    await t.db.insert(profiles).values({ id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR });
    const before = await catalogSnapshot();
    const { send } = await revoke(SEAT_A);
    expect(await catalogSnapshot()).toEqual(before);
    // AECI-1159: the remaining seat is told, with the reason. Nothing else is written.
    expect((await auditActions()).sort()).toEqual([
      'notification.sent',
      'vendor_claim.seat_revoked',
    ]);
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
    expect(after.vendor.ownedAt).toBe(OWNED_AT);
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

  it('never routes back a contest a return took, even after the owner re-claims', async () => {
    // Ban, then the banned seat is revoked and the records returned to AECi, then a
    // fresh seat, a re-claim, a ban and an unban. The contest stayed with AECi.
    await ban(SEAT_A);
    await revoke(SEAT_A);
    expect((await returnRecords()).status).toBe(200);
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

// ─── Billing (AECI-1374, decision 15) ────────────────────────────────────────

describe('a seat revoke writes nothing in billing, the last seat included (decision 15)', () => {
  it('planVendorHandback names no `licenses` or `billing_accounts` statement', async () => {
    const batch = await planVendorHandback(t.db, {
      vendorId: VENDOR,
      actorId: ADMIN,
      actorType: 'admin',
      now: '2026-10-05T00:00:00.000Z',
      source: 'admin-moderation',
    });
    expect(batch.stmts.length).toBeGreaterThan(0);
    const sqlOf = (stmt: unknown) => (stmt as { toSQL(): { sql: string } }).toSQL().sql;
    expect(
      batch.stmts.map(sqlOf).filter((sql) => /"licenses"|"billing_accounts"/.test(sql)),
    ).toEqual([]);
  });

  it('the last-seat revoke leaves every license row byte-identical', async () => {
    const before = await t.db.select().from(licenses);
    expect((await revoke(SEAT_A)).status).toBe(204);
    expect(await t.db.select().from(licenses)).toEqual(before);
    expect((await auditActions()).filter((a) => a.startsWith('license.'))).toEqual([]);
  });

  it('a ban of the last seat flags the live license; the unban clears it', async () => {
    await ban(SEAT_A);
    const [flagged] = await t.db.select().from(licenses);
    expect(flagged).toMatchObject({
      cancelAtTermEnd: true,
      cancelReason: 'vendor-banned',
      endedAt: null,
    });
    await unban(SEAT_A);
    const [cleared] = await t.db.select().from(licenses);
    expect(cleared).toMatchObject({ cancelAtTermEnd: false, cancelReason: null, endedAt: null });
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

  it('a double-click revoke: the loser commits no re-route audit rows', async () => {
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

  it('a seat provisioned while the last-seat revoke ran: nothing re-routed', async () => {
    interleaveBeforeBatch(() =>
      t.db.insert(profiles).values({ id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR }),
    );
    expect((await revoke(SEAT_A)).status).toBe(409);
    const [seat] = await t.db.select().from(profiles).where(eq(profiles.id, SEAT_A));
    expect(seat.role).toBe('vendor_admin');
    expect((await contest()).routedTo).toBe('owner');
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
    expect((await contest()).routedTo).toBe('owner');
    // A retry now sees the last seat and freezes: the contest moves, the claim stays.
    expect((await revoke(SEAT_A)).status).toBe(204);
    expect((await contest()).routedTo).toBe('aeci');
    expect((await integration(I_OWNED)).claimedAt).toBe(CLAIMED_AT);
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

// ─── A new seat clears the vendor-banned license flags (ruled 2026-10-15) ────

describe('a new seat grant clears the vendor-banned license flags, as an unban does', () => {
  const provision = () =>
    call(`/api/admin/vendors/${VENDOR}/seats`, 'POST', { email: 'new-seat@bentley.example' });
  const grantParams = {
    vendorId: VENDOR,
    actorId: ADMIN,
    actorType: 'admin' as const,
    now: '2026-10-15T00:00:00.000Z',
    source: 'admin-moderation',
  };

  it('the provision clears the flags the last-seat ban set, in its own batch', async () => {
    await ban(SEAT_A);
    expect((await t.db.select().from(licenses))[0]).toMatchObject({
      cancelReason: 'vendor-banned',
    });
    const batch = vi.spyOn(t.db, 'batch');
    expect((await provision()).status).toBe(201);
    expect(batch).toHaveBeenCalledTimes(1);
    const [row] = await t.db.select().from(licenses);
    expect(row).toMatchObject({ cancelAtTermEnd: false, cancelReason: null, endedAt: null });
    const cleared = (await t.db.select().from(auditLog)).filter(
      (a) => a.action === 'license.cancel_at_term_end_cleared',
    );
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({
      actorId: ADMIN,
      entityType: 'billing_account',
      entityId: u(71),
      vendorId: VENDOR,
    });
    expect(cleared[0]!.metadata).toMatchObject({
      source: 'admin-moderation',
      seat_user_id: SEAT_B,
      license_id: row!.id,
    });
  });

  it('clears only live vendor-banned flags: another reason and an ended license stay', async () => {
    const seeds = await seedCancelFlags(t.db, VENDOR);
    expect((await provision()).status).toBe(201);
    expect(await readCancelFlags(t.db, seeds)).toEqual(FLAGS_AFTER_GRANT);
  });

  it('a seat for a banned profile clears nothing', async () => {
    const seeds = await seedCancelFlags(t.db, VENDOR);
    await t.db
      .insert(profiles)
      .values({ id: SEAT_B, role: 'reviewer', bannedAt: CLAIMED_AT, banReason: 'abuse' });
    // A banned seat does not make the vendor active, so the flag sentinel stays quiet.
    expect((await provision()).status).toBe(201);
    expect((await readCancelFlags(t.db, seeds)).banned).toEqual({
      cancelAtTermEnd: true,
      cancelReason: 'vendor-banned',
    });
  });

  // AECI-1374 E4.5 (ruled 2026-10-16): the provision reads the flags before its batch.
  // A last-seat ban that commits in between flags the license after that read, so the
  // provision plans no clear. `vendorBannedFlagsRaceSentinel` rolls the batch back.
  it('a last-seat ban between the read and the batch rolls the provision back (409)', async () => {
    const original = t.db.batch.bind(t.db);
    vi.spyOn(t.db, 'batch').mockImplementationOnce((async (stmts: never) => {
      expect((await ban(SEAT_A)).status).toBe(200);
      return original(stmts);
    }) as never);

    const res = await provision();
    expect(res.status).toBe(409);
    expect(res.code).toBe('VENDOR_SEATS_CHANGED');

    expect(await t.db.query.profiles.findFirst({ where: eq(profiles.id, SEAT_B) })).toBeUndefined();
    const [row] = await t.db.select().from(licenses);
    expect(row).toMatchObject({ cancelAtTermEnd: true, cancelReason: 'vendor-banned' });
    const actions = await auditActions();
    expect(actions).not.toContain('vendor_seat.provisioned');
    expect(actions).not.toContain('license.cancel_at_term_end_cleared');

    // The retry re-reads the flags and clears them with the seat.
    expect((await provision()).status).toBe(201);
    expect((await t.db.select().from(licenses))[0]).toMatchObject({
      cancelAtTermEnd: false,
      cancelReason: null,
    });
  });

  it('planSeatGrantReturn is null when nothing is stamped and nothing is flagged', async () => {
    expect(await planSeatGrantReturn(t.db, grantParams, SEAT_B)).toBeNull();
  });

  it('planSeatGrantReturn carries the license statements and audits when only a flag is set', async () => {
    await seedCancelFlags(t.db, VENDOR);
    const batch = await planSeatGrantReturn(t.db, grantParams, SEAT_B);
    expect(batch).not.toBeNull();
    expect(batch!.audits.map((a) => a.action)).toEqual(['license.cancel_at_term_end_cleared']);
    expect(batch!.transitions).toEqual([]);
    expect(batch!.purgeTags).toEqual([]);
    const sqlOf = (stmt: unknown) => (stmt as { toSQL(): { sql: string } }).toSQL().sql;
    const licenseUpdates = batch!.stmts.map(sqlOf).filter((q) => /^update "licenses"/.test(q));
    expect(licenseUpdates).toHaveLength(1);
    expect(licenseUpdates[0]).toContain('"cancel_reason" = ?');
  });
});

// ─── The plan stamp: passed in, or read once (AECI-1192 review) ──────────────

describe("the return stamps the caller's plan, or reads it when none is passed", () => {
  const params = {
    vendorId: VENDOR,
    actorId: ADMIN,
    actorType: 'admin' as const,
    now: '2026-10-05T00:00:00.000Z',
    source: 'admin-moderation',
  };

  it('stamps a passed vendorPlan as-is, without reading the entitlement', async () => {
    // A plan the table does not hold: only the caller's value can produce it.
    const vendorPlan = { tier: 'caller-tier', status: 'active' };
    const batch = await planVendorHandback(t.db, { ...params, vendorPlan });
    expect(batch.audits.length).toBeGreaterThan(0);
    for (const a of batch.audits) {
      if (a.action === 'notification.sent') continue;
      expect(a).toMatchObject({ vendorId: VENDOR, vendorPlan });
    }
  });

  it('reads the entitlement when no vendorPlan is passed', async () => {
    const batch = await planVendorHandback(t.db, params);
    expect(batch.audits.length).toBeGreaterThan(0);
    for (const a of batch.audits) {
      if (a.action === 'notification.sent') continue;
      expect(a).toMatchObject({
        vendorId: VENDOR,
        vendorPlan: { tier: 'verified', status: 'active' },
      });
    }
  });

  it('the revoke and the return stamp their rows with the plan the seat row carries', async () => {
    await handBack();
    const rows = await t.db
      .select({
        action: auditLog.action,
        tier: auditLog.vendorTier,
        status: auditLog.vendorEntitlementStatus,
      })
      .from(auditLog)
      .where(eq(auditLog.vendorId, VENDOR));
    expect(rows.length).toBeGreaterThan(1);
    expect(new Set(rows.map((r) => `${r.tier}/${r.status}`))).toEqual(new Set(['verified/active']));
  });
});

// ─── Evidenced pairs (AECI-1089) ─────────────────────────────────────────────

describe('the return hands back claimed evidenced pairs too (AECI-1089, AECI-1415)', () => {
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

  it('the freeze leaves every pair claimed and vendor-maintained', async () => {
    const before = await t.db.select().from(connectorEvidencedPairs);
    await revoke(SEAT_A);
    expect(await t.db.select().from(connectorEvidencedPairs)).toEqual(before);
  });

  it('un-claims every live owned pair, and flips the marker only where no vendor attestation survives', async () => {
    const { body } = await handBack();
    expect((body!.evidenced_pair_ids as string[]).sort()).toEqual([EP_OWNED, EP_ATTESTED].sort());

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
    await handBack();
    expect(await t.db.select().from(connectorEvidencedPairs)).toHaveLength(before.pairs.length);
    expect(await t.db.select().from(claims)).toEqual(before.claims);
    expect(await t.db.select().from(attestations)).toEqual(before.attestations);
  });

  it('writes the pair audit rows in the return batch, on the pair entity with the evidenced anchor', async () => {
    await revoke(SEAT_A);
    const batchSpy = vi.spyOn(t.db, 'batch');
    await returnRecords();
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
        vendorId: VENDOR,
      });
      // AECI-1192: `sealed()` names the vendor that held the pair.
      expect(row.vendorId).toBe(VENDOR);
    }
    const flip = rows.find(
      (row) => (row.afterState as { maintained_by?: string } | null)?.maintained_by === 'aeci',
    );
    expect(flip?.metadata).toMatchObject({
      reason: 'maintenance-marker',
      cause: 'records-returned-to-aeci',
    });
  });

  it("purges the flipped pair's page, both endpoints and its connector's page", async () => {
    const { send } = await handBack();
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
    await revoke(SEAT_A);
    const original = t.db.batch.bind(t.db);
    vi.spyOn(t.db, 'batch').mockImplementationOnce((async (stmts: never) => {
      await t.db.insert(profiles).values({ id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR });
      return original(stmts);
    }) as never);
    const { status } = await returnRecords();
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

// ─── Telemetry: one batched forward per seat write (connection limit) ────────

describe('each seat write forwards its audit rows and transitions in ONE request', () => {
  const auditForwardsPerRow = () =>
    vi
      .mocked(logToPosthog)
      .mock.calls.filter((call) =>
        String((call[3] as { message?: string }).message ?? '').startsWith('audit '),
      );
  const batchedMessages = () =>
    (vi.mocked(logBatchToPosthog).mock.calls[0]![3] as { message: string }[]).map((e) => e.message);

  beforeEach(() => {
    vi.mocked(logBatchToPosthog).mockClear();
    vi.mocked(logToPosthog).mockClear();
  });

  it('the last-seat revoke: the seat row and the contest re-route', async () => {
    await revoke(SEAT_A);
    expect(logBatchToPosthog).toHaveBeenCalledTimes(1);
    expect(batchedMessages().filter((m) => m.startsWith('audit '))).toHaveLength(2);
    expect(batchedMessages().filter((m) => m.startsWith('workflow '))).toHaveLength(0);
    expect(auditForwardsPerRow()).toEqual([]);
  });

  it('the return: the return row and every hand-back row', async () => {
    await revoke(SEAT_A);
    vi.mocked(logBatchToPosthog).mockClear();
    await returnRecords();
    expect(logBatchToPosthog).toHaveBeenCalledTimes(1);
    // records_returned, vendor, product and 5 integration rows.
    expect(batchedMessages().filter((m) => m.startsWith('audit '))).toHaveLength(8);
    expect(auditForwardsPerRow()).toEqual([]);
  });

  it('a ban and an unban: the ban row, its transition, each re-route and license flag', async () => {
    await ban(SEAT_A);
    expect(logBatchToPosthog).toHaveBeenCalledTimes(1);
    // The ban row, the re-route and the one live license's cancel flag (AECI-1374).
    expect(batchedMessages().filter((m) => m.startsWith('audit '))).toHaveLength(3);
    vi.mocked(logBatchToPosthog).mockClear();
    await unban(SEAT_A);
    expect(logBatchToPosthog).toHaveBeenCalledTimes(1);
    expect(batchedMessages().filter((m) => m.startsWith('audit '))).toHaveLength(3);
    expect(auditForwardsPerRow()).toEqual([]);
  });

  it('a new seat grant that returns contests', async () => {
    await ban(SEAT_A);
    vi.mocked(logBatchToPosthog).mockClear();
    expect(
      (
        await call(`/api/admin/vendors/${VENDOR}/seats`, 'POST', {
          email: 'new-seat@bentley.example',
          reason: 'pilot',
        })
      ).status,
    ).toBe(201);
    expect(logBatchToPosthog).toHaveBeenCalledTimes(1);
    // The provision row, the returned contest's re-route and the one live license's
    // cleared vendor-banned flag (ruled 2026-10-15).
    expect(batchedMessages().filter((m) => m.startsWith('audit '))).toHaveLength(3);
    expect(auditForwardsPerRow()).toEqual([]);
  });
});

// ─── A connector-powered integrations row (review MINOR 3) ───────────────────

describe('the return of a connector-powered integrations row', () => {
  const P_POWERED_BY = u(35);
  const I_POWERED = u(44);

  beforeEach(async () => {
    await t.db
      .insert(products)
      .values({ id: P_POWERED_BY, slug: 'workato', name: 'Workato', promotionStatus: 'promoted' });
    await t.db.insert(integrations).values({
      id: I_POWERED,
      name: 'Via Workato',
      mechanismKind: 'native',
      poweredByProductId: P_POWERED_BY,
      sourceProductId: P_THEIRS,
      targetProductId: P_MINE,
      builtByVendorId: VENDOR,
      maintainedBy: 'vendor',
      lastReviewedAt: REVIEWED,
      claimedAt: CLAIMED_AT,
    });
  });

  it("purges the powered_by product's page when the marker flips", async () => {
    const { send } = await handBack();
    const { tags } = send.mock.calls[0]![0] as { tags: string[] };
    expect(tags).toContain('product:workato');
  });

  it('marks both of its audit rows with the carve-out markers, and no ordinary row', async () => {
    await handBack();
    const rows = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'integration.updated'));
    const powered = rows.filter((r) => r.entityId === I_POWERED);
    expect(powered).toHaveLength(2);
    for (const row of powered) {
      expect(row.metadata).toMatchObject({ connectorPowered: true, anchor: 'integration' });
    }
    const ordinary = rows.find((r) => r.entityId === I_OWNED)!;
    expect(ordinary.metadata).not.toHaveProperty('connectorPowered');
  });
});
