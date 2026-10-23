/**
 * Account erasure of a vendor seat (AECI-1106 / `STAGE_2_ATTESTATIONS_SPEC.md`
 * §13.9), against the real-SQLite harness. A `vendor_admin` seat IS a `profiles`
 * row, so `DELETE /api/account` is a seat loss, and it must do what the admin
 * revoke does (`vendor-handback.spec.ts`):
 *
 *  - the last seat FREEZES the record (AECI-1415): ownership, markers and claims
 *    stay, and the owner contests move to AECi, stamped, in the erasure batch;
 *  - a seat erased while an unbanned seat remains changes nothing else;
 *  - a seat erased while only banned seats remain moves the owner contests to AECi;
 *  - a non-vendor account erases exactly as before;
 *  - the AECI-531 skip of the `auth.users` delete is untouched;
 *  - a lost seat race re-plans instead of failing the erasure.
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  integrationFieldChallenges,
  integrations,
  productVendors,
  products,
  profiles,
  taxonomyDataObjects,
  vendors,
  workflowInstances,
  workflowTransitions,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthenticatedSession, AuthzVariables } from '../lib/authz';
import { SEAT_LAPSE_REASON } from '../lib/vendor-handback';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { logBatchToPosthog, logToPosthog } from '../posthog';
import { createDeleteAccountHandler, ERASURE_SEAT_ATTEMPTS } from './account';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));
vi.mock('../lib/email', () => ({
  sendAccountDeletionEmail: vi.fn(() => Promise.resolve('sent')),
}));

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const VENDOR = u(10); // the erased seat's vendor
const OTHER = u(11); // the other endpoint's vendor, unseated
const CO_OWNER = u(12); // a second vendor, seated by someone else
const SEAT_A = u(20); // the seat being erased
const SEAT_B = u(21); // a colleague's seat, added per case
const SEAT_CO = u(23); // CO_OWNER's seat
const P_MINE = u(30);
const P_SHARED = u(31); // co-owned with CO_OWNER
const P_THEIRS = u(32);
const P_CO = u(33); // CO_OWNER's own product
const I_OWNED = u(40); // VENDOR owns + claimed
const I_CO = u(44); // CO_OWNER owns + claimed
const CONTEST = u(50);
const WORKFLOW = u(51);
const DATA_OBJECT = u(60);

const REVIEWED = '2026-09-01T00:00:00.000Z';
const CLAIMED_AT = '2026-09-02T00:00:00.000Z';

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    {
      id: VENDOR,
      slug: 'bentley',
      companyName: 'Bentley',
      promotionStatus: 'promoted',
      maintainedBy: 'vendor',
      lastReviewedAt: REVIEWED,
      ownedAt: REVIEWED,
    },
    { id: OTHER, slug: 'autodesk', companyName: 'Autodesk', promotionStatus: 'promoted' },
    {
      id: CO_OWNER,
      slug: 'trimble',
      companyName: 'Trimble',
      promotionStatus: 'promoted',
      maintainedBy: 'vendor',
    },
  ]);
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
    },
    { id: P_THEIRS, slug: 'revit', name: 'Revit', promotionStatus: 'promoted' },
    {
      id: P_CO,
      slug: 'tekla',
      name: 'Tekla',
      promotionStatus: 'promoted',
      maintainedBy: 'vendor',
    },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_MINE, vendorId: VENDOR, isPrimary: true },
    { productId: P_SHARED, vendorId: VENDOR, isPrimary: true },
    { productId: P_SHARED, vendorId: CO_OWNER, isPrimary: false },
    { productId: P_THEIRS, vendorId: OTHER, isPrimary: true },
    { productId: P_CO, vendorId: CO_OWNER, isPrimary: true },
  ]);
  await t.db.insert(integrations).values([
    {
      id: I_OWNED,
      name: 'Owned',
      mechanismKind: 'native',
      sourceProductId: P_THEIRS,
      targetProductId: P_MINE,
      builtByVendorId: VENDOR,
      maintainedBy: 'vendor',
      lastReviewedAt: REVIEWED,
      claimedAt: CLAIMED_AT,
    },
    {
      id: I_CO,
      name: 'Co',
      mechanismKind: 'api',
      sourceProductId: P_THEIRS,
      targetProductId: P_CO,
      builtByVendorId: CO_OWNER,
      maintainedBy: 'vendor',
      claimedAt: CLAIMED_AT,
    },
  ]);
  await t.db
    .insert(taxonomyDataObjects)
    .values({ id: DATA_OBJECT, slug: 'rfis', name: 'RFIs', displayOrder: 10 });
  await t.db.insert(workflowInstances).values({
    id: WORKFLOW,
    workflowType: 'correction_request',
    entityId: CONTEST,
    currentState: 'open',
  });
  await t.db.insert(integrationFieldChallenges).values({
    id: CONTEST,
    integrationId: I_OWNED,
    field: 'name',
    reason: 'r',
    submitterVendorId: OTHER,
    routedTo: 'owner',
    ownerVendorId: VENDOR,
    workflowId: WORKFLOW,
  });
  await t.db.insert(profiles).values([
    { id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true },
    { id: SEAT_CO, role: 'vendor_admin', vendorId: CO_OWNER },
  ]);
});
afterEach(() => t.dispose());

function sessionFor(userId: string, vendorId: string | null): AuthenticatedSession {
  return {
    userId,
    email: 'seat@bentley.example',
    role: vendorId ? 'vendor_admin' : 'reviewer',
    vendorId,
    entitlementTier: 'unclaimed',
    entitlement: null,
  } as unknown as AuthenticatedSession;
}

type AuthResult = { ok: boolean; skipped?: boolean; status?: number; error?: string };

async function erase(
  userId = SEAT_A,
  vendorId: string | null = VENDOR,
  authResult: AuthResult = { ok: true },
) {
  const send = vi.fn().mockResolvedValue(undefined);
  const order: string[] = [];
  const deleteAuthUser = vi.fn(async () => {
    const stillThere = await t.db.query.profiles.findFirst({ where: eq(profiles.id, userId) });
    order.push(stillThere ? 'auth-delete-before-batch' : 'auth-delete-after-batch');
    return authResult;
  });
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.use('*', async (c, next) => {
    c.set('auth', sessionFor(userId, vendorId));
    await next();
  });
  app.delete(
    '/api/account',
    createDeleteAccountHandler(t.factory, deleteAuthUser as never) as never,
  );
  const env: Env = {
    ...TEST_ENV,
    // Only production reaches seam #3 (AECI-1468), and these tests pin its order.
    ENV: 'production',
    CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'],
  };
  const execCtx = fakeExecutionContext();
  const res = await app.request('/api/account', { method: 'DELETE' }, env, execCtx);
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return { status: res.status, send, deleteAuthUser, order };
}

const integration = async (id: string) =>
  (await t.db.query.integrations.findFirst({ where: eq(integrations.id, id) }))!;
const vendorRow = async (id = VENDOR) =>
  (await t.db.query.vendors.findFirst({ where: eq(vendors.id, id) }))!;
const product = async (id: string) =>
  (await t.db.query.products.findFirst({ where: eq(products.id, id) }))!;
const contest = async () =>
  (await t.db.query.integrationFieldChallenges.findFirst({
    where: eq(integrationFieldChallenges.id, CONTEST),
  }))!;
const audits = () => t.db.select().from(auditLog);
const profileExists = async (id: string) =>
  (await t.db.query.profiles.findFirst({ where: eq(profiles.id, id) })) !== undefined;

describe('DELETE /api/account on a vendor seat (AECI-1106)', () => {
  it('forwards the erasure and every re-route row in ONE batched request (AECI-1112)', async () => {
    // Seven more owner-routed contests, so the lapse carries eight contest rows
    // and eight transitions: past the Worker's ~6 open connections (AECI-666). One
    // open contest per (row, field, submitter), so each takes its own field.
    const fields = [
      'mechanism_name',
      'direction',
      'description',
      'listing_url',
      'docs_url',
      'website',
      'maturity',
    ];
    for (const [i, field] of fields.entries()) {
      const workflowId = u(70 + i);
      await t.db.insert(workflowInstances).values({
        id: workflowId,
        workflowType: 'correction_request',
        entityId: u(80 + i),
        currentState: 'open',
      });
      await t.db.insert(integrationFieldChallenges).values({
        id: u(80 + i),
        integrationId: I_OWNED,
        field,
        reason: 'r',
        submitterVendorId: OTHER,
        routedTo: 'owner',
        ownerVendorId: VENDOR,
        workflowId,
      });
    }
    vi.mocked(logBatchToPosthog).mockClear();
    vi.mocked(logToPosthog).mockClear();

    const { status } = await erase();
    expect(status).toBe(200);

    expect(logBatchToPosthog).toHaveBeenCalledTimes(1);
    const events = vi.mocked(logBatchToPosthog).mock.calls[0]![3] as {
      message: string;
      source: string;
    }[];
    const messages = events.map((e) => e.message);
    expect(messages.filter((m) => m.startsWith('audit account.deleted'))).toHaveLength(1);
    expect(
      messages.filter((m) => m.startsWith('audit integration.contest.rerouted ')),
    ).toHaveLength(8);
    expect(messages.filter((m) => m.startsWith('workflow '))).toHaveLength(8);
    // Every D1 audit row is in the forward, and nothing forwards one row at a time.
    expect(messages.filter((m) => m.startsWith('audit '))).toHaveLength((await audits()).length);
    expect(events.every((e) => e.source === 'account')).toBe(true);
    const perRow = vi
      .mocked(logToPosthog)
      .mock.calls.filter((call) =>
        /^(audit|workflow) /.test(String((call[3] as { message?: string }).message ?? '')),
      );
    expect(perRow).toEqual([]);
  });

  it('erasing the last seat freezes the record in the erasure batch (AECI-1415)', async () => {
    const before = {
      vendor: await vendorRow(),
      products: await t.db.select().from(products),
      integrations: await t.db.select().from(integrations),
    };
    const batchSpy = vi.spyOn(t.db, 'batch');
    const { status, send } = await erase();
    expect(status).toBe(200);

    // One batch carries the erasure AND the re-route, audit rows included (§26.1).
    const writes = batchSpy.mock.calls.filter(([stmts]) => stmts.length > 0);
    expect(writes).toHaveLength(1);
    batchSpy.mockRestore();

    expect(await profileExists(SEAT_A)).toBe(false);
    // Seat loss never moves ownership: the record stays the vendor's, frozen.
    expect(await vendorRow()).toEqual(before.vendor);
    expect(await t.db.select().from(products)).toEqual(before.products);
    expect(await t.db.select().from(integrations)).toEqual(before.integrations);
    const moved = await contest();
    expect(moved.routedTo).toBe('aeci');
    expect(moved.ownerSeatLapsedAt).not.toBeNull();

    // Every audit row has a null actor: the actor's profile is gone (§8 step 3).
    const rows = await audits();
    expect(rows.every((r) => r.actorId === null)).toBe(true);
    expect(rows.map((r) => r.action).sort()).toEqual([
      'account.deleted',
      'integration.contest.rerouted',
    ]);
    const rerouted = rows.find((r) => r.action === 'integration.contest.rerouted')!;
    expect(rerouted.metadata).toMatchObject({ source: 'account', reason: SEAT_LAPSE_REASON });

    // The contest's open → open transition, with a null actor.
    const [transition] = await t.db
      .select()
      .from(workflowTransitions)
      .where(eq(workflowTransitions.workflowId, WORKFLOW));
    expect(transition).toMatchObject({ fromState: 'open', toState: 'open', actorId: null });

    // No rendered page changed, so nothing is purged.
    expect(send).not.toHaveBeenCalled();
  });

  it('leaves the other vendor alone when the erased seat was the last on its own vendor', async () => {
    await erase();
    expect((await vendorRow(CO_OWNER)).maintainedBy).toBe('vendor');
    expect((await product(P_CO)).maintainedBy).toBe('vendor');
    expect((await integration(I_CO)).claimedAt).toBe(CLAIMED_AT);
    expect(await profileExists(SEAT_CO)).toBe(true);
  });

  it('changes nothing else while an unbanned seat remains', async () => {
    await t.db.insert(profiles).values({ id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR });
    const { status, send } = await erase();
    expect(status).toBe(200);
    expect(await profileExists(SEAT_A)).toBe(false);
    expect((await vendorRow()).maintainedBy).toBe('vendor');
    expect((await integration(I_OWNED)).claimedAt).toBe(CLAIMED_AT);
    expect((await contest()).routedTo).toBe('owner');
    expect((await audits()).map((r) => r.action)).toEqual(['account.deleted']);
    expect(send).not.toHaveBeenCalled();
  });

  it('moves the owner contests to AECi, stamped, when only banned seats remain', async () => {
    await t.db.insert(profiles).values({
      id: SEAT_B,
      role: 'vendor_admin',
      vendorId: VENDOR,
      bannedAt: '2026-09-10T00:00:00.000Z',
    });
    const { status, send } = await erase();
    expect(status).toBe(200);
    // A lapse hands nothing back.
    expect((await vendorRow()).maintainedBy).toBe('vendor');
    expect((await integration(I_OWNED)).claimedAt).toBe(CLAIMED_AT);
    const moved = await contest();
    expect(moved.routedTo).toBe('aeci');
    expect(moved.ownerSeatLapsedAt).not.toBeNull();
    const rerouted = (await audits()).find((r) => r.action === 'integration.contest.rerouted');
    expect(rerouted?.actorId).toBeNull();
    expect(rerouted?.metadata).toMatchObject({ source: 'account', reason: SEAT_LAPSE_REASON });
    expect(send).not.toHaveBeenCalled();
  });

  it('erases an account with no seat exactly as before', async () => {
    const READER = u(90);
    await t.db.insert(profiles).values({ id: READER, role: 'reviewer' });
    const { status, send } = await erase(READER, null);
    expect(status).toBe(200);
    expect(await profileExists(READER)).toBe(false);
    expect((await vendorRow()).maintainedBy).toBe('vendor');
    expect((await integration(I_OWNED)).claimedAt).toBe(CLAIMED_AT);
    expect((await audits()).map((r) => r.action)).toEqual(['account.deleted']);
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps the AECI-531 skip: the auth.users delete still runs after the batch, and a skip is not an error', async () => {
    const { status, deleteAuthUser, order } = await erase(SEAT_A, VENDOR, {
      ok: true,
      skipped: true,
    });
    expect(status).toBe(200);
    expect(deleteAuthUser).toHaveBeenCalledTimes(1);
    expect(deleteAuthUser).toHaveBeenCalledWith(expect.anything(), SEAT_A);
    expect(order).toEqual(['auth-delete-after-batch']);
    // The re-route committed regardless of the skipped auth delete.
    expect((await contest()).routedTo).toBe('aeci');
  });
});

describe('an erasure that loses a seat race re-plans instead of failing', () => {
  it('a seat provisioned mid-erasure: the retry plans "none" and moves nothing', async () => {
    const original = t.db.batch.bind(t.db);
    const spy = vi.spyOn(t.db, 'batch').mockImplementationOnce((async (stmts: never) => {
      await t.db.insert(profiles).values({ id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR });
      return original(stmts);
    }) as never);
    const { status, deleteAuthUser } = await erase();
    spy.mockRestore();
    expect(status).toBe(200);
    expect(await profileExists(SEAT_A)).toBe(false);
    expect(await profileExists(SEAT_B)).toBe(true);
    expect((await vendorRow()).maintainedBy).toBe('vendor');
    expect((await integration(I_OWNED)).claimedAt).toBe(CLAIMED_AT);
    // Only the committed attempt's audit row exists.
    expect((await audits()).map((r) => r.action)).toEqual(['account.deleted']);
    expect(deleteAuthUser).toHaveBeenCalledTimes(1);
  });

  it(`answers 409 and writes nothing after ${ERASURE_SEAT_ATTEMPTS} lost races`, async () => {
    // Flip a colleague's seat in and out before every batch, so each plan is stale.
    const original = t.db.batch.bind(t.db);
    const spy = vi.spyOn(t.db, 'batch').mockImplementation((async (stmts: never) => {
      if (await profileExists(SEAT_B)) await t.db.delete(profiles).where(eq(profiles.id, SEAT_B));
      else
        await t.db.insert(profiles).values({ id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR });
      return original(stmts);
    }) as never);
    const { status, deleteAuthUser } = await erase();
    const attempts = spy.mock.calls.length;
    spy.mockRestore();
    expect(attempts).toBe(ERASURE_SEAT_ATTEMPTS);
    expect(status).toBe(409);
    expect(await profileExists(SEAT_A)).toBe(true);
    expect(await audits()).toEqual([]);
    expect((await integration(I_OWNED)).claimedAt).toBe(CLAIMED_AT);
    expect(deleteAuthUser).not.toHaveBeenCalled();
  });
});
