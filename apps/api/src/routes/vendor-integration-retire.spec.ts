/**
 * `POST /api/vendor/integrations/:id/retire` and `/restore` (AECI-1010 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.6).
 *
 * Real migrations on in-memory SQLite with `db.batch` shimmed onto one transaction,
 * so the guarded UPDATE, the race sentinels, the contest closes and the
 * audit-in-batch rule all run for real. The read side (a retired row counts nowhere)
 * is `lib/count-lockstep.spec.ts`.
 */

import {
  ListVendorNotificationsResponseSchema,
  RetireIntegrationResponseSchema,
} from '@aeci/shared';
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
  vendors,
  workflowInstances,
  workflowTransitions,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { NOTIFICATION_SENT_ACTION } from '../lib/attestation-notify';
import type { AuthzVariables } from '../lib/authz';
import {
  INTEGRATION_RESTORED_ACTION,
  INTEGRATION_RETIRED_ACTION,
  RETIRE_CLOSED_CONTEST_REASON,
} from '../lib/integration-retire';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { createListVendorIntegrationsHandler } from './vendor-attestations';
import { createSubmitContestHandler } from './vendor-contests';
import {
  createRestoreIntegrationHandler,
  createRetireIntegrationHandler,
} from './vendor-integration-retire';
import { createListVendorNotificationsHandler } from './vendor-notifications';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A owns SOURCE, B owns TARGET and CLAIMED I_MAIN. C owns an unrelated product.
const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const VENDOR_C = uuid(3);

const P_SOURCE = uuid(10);
const P_TARGET = uuid(11);
const P_FOREIGN = uuid(12);
const P_CONNECTOR = uuid(13);

const I_MAIN = uuid(20); // claimed by B
const I_UNCLAIMED = uuid(21); // B on file, not claimed
const I_POWERED = uuid(22); // claimed by B, connector-powered
const CONTEST = uuid(30);
const WORKFLOW = uuid(31);

const CLAIMED_AT = '2026-09-01T00:00:00.000Z';

const seat = (n: number, vendorId: string): AuthzVariables['auth'] => ({
  userId: uuid(100 + n),
  email: `seat${n}@example.test`,
  role: 'vendor_admin',
  vendorId,
  entitlementTier: 'unclaimed',
  entitlement: null,
});
const AUTH_A = seat(1, VENDOR_A);
const AUTH_B = seat(2, VENDOR_B);
const AUTH_C = seat(3, VENDOR_C);

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR_A, slug: 'autodesk', companyName: 'Autodesk' },
    { id: VENDOR_B, slug: 'bentley', companyName: 'Bentley' },
    { id: VENDOR_C, slug: 'graphisoft', companyName: 'Graphisoft' },
  ]);
  await t.db.insert(products).values([
    { id: P_SOURCE, slug: 'revit', name: 'Revit', promotionStatus: 'promoted' },
    { id: P_TARGET, slug: 'microstation', name: 'MicroStation', promotionStatus: 'promoted' },
    { id: P_FOREIGN, slug: 'archicad', name: 'ArchiCAD' },
    { id: P_CONNECTOR, slug: 'bentley-connect', name: 'Bentley Connect', productRole: 'connector' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_SOURCE, vendorId: VENDOR_A, isPrimary: true },
    { productId: P_TARGET, vendorId: VENDOR_B, isPrimary: true },
    { productId: P_FOREIGN, vendorId: VENDOR_C, isPrimary: true },
    { productId: P_CONNECTOR, vendorId: VENDOR_B, isPrimary: true },
  ]);
  await t.db.insert(integrations).values([
    {
      id: I_MAIN,
      name: 'Revit for MicroStation',
      sourceProductId: P_SOURCE,
      targetProductId: P_TARGET,
      mechanismKind: 'native',
      builtByVendorId: VENDOR_B,
      claimedAt: CLAIMED_AT,
      maintainedBy: 'vendor',
      lastReviewedAt: CLAIMED_AT,
      updatedAt: CLAIMED_AT,
    },
    {
      id: I_UNCLAIMED,
      sourceProductId: P_SOURCE,
      targetProductId: P_TARGET,
      builtByVendorId: VENDOR_B,
    },
    {
      id: I_POWERED,
      sourceProductId: P_SOURCE,
      targetProductId: P_CONNECTOR,
      mechanismKind: 'iPaaS',
      poweredByProductId: P_CONNECTOR,
      builtByVendorId: VENDOR_B,
      claimedAt: CLAIMED_AT,
    },
  ]);
  await t.db.insert(profiles).values(
    [AUTH_A, AUTH_B, AUTH_C].map((auth) => ({
      id: auth.userId,
      role: 'vendor_admin',
      vendorId: auth.vendorId,
    })),
  );
});
afterEach(() => t.dispose());

function app(auth: AuthzVariables['auth']) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.post('/api/vendor/integrations/:id/retire', createRetireIntegrationHandler(t.factory));
  a.post('/api/vendor/integrations/:id/restore', createRestoreIntegrationHandler(t.factory));
  a.post('/api/vendor/integrations/:id/contests', createSubmitContestHandler(t.factory));
  a.get('/api/vendor/notifications', createListVendorNotificationsHandler(t.factory));
  a.get('/api/vendor/integrations', createListVendorIntegrationsHandler(t.factory));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function call(
  auth: AuthzVariables['auth'],
  path: string,
  method: 'GET' | 'POST' = 'POST',
  body?: unknown,
): Promise<{ status: number; body: JsonBody; send: ReturnType<typeof vi.fn> }> {
  const send = vi.fn().mockResolvedValue(undefined);
  const env: Env = {
    ...TEST_ENV,
    CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'],
  };
  const execCtx = fakeExecutionContext();
  const init: RequestInit = body
    ? { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
    : { method };
  const res = await app(auth).request(path, init, env, execCtx);
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return { status: res.status, body: (await res.json()) as JsonBody, send };
}

const retire = (auth: AuthzVariables['auth'], id: string) =>
  call(auth, `/api/vendor/integrations/${id}/retire`);
const restore = (auth: AuthzVariables['auth'], id: string) =>
  call(auth, `/api/vendor/integrations/${id}/restore`);

const row = async (id: string) =>
  (await t.db.query.integrations.findFirst({ where: eq(integrations.id, id) }))!;
const auditsFor = (action: string) =>
  t.db.select().from(auditLog).where(eq(auditLog.action, action));

async function seedOpenContest(): Promise<void> {
  await t.db.insert(workflowInstances).values({
    id: WORKFLOW,
    workflowType: 'correction_request',
    entityId: CONTEST,
    currentState: 'open',
    initiatedBy: AUTH_A.userId,
  });
  await t.db.insert(integrationFieldChallenges).values({
    id: CONTEST,
    integrationId: I_MAIN,
    field: 'name',
    currentValue: 'Revit for MicroStation',
    proposedValue: 'Revit Link',
    reason: 'The name on record is out of date.',
    submitterVendorId: VENDOR_A,
    submittedBy: AUTH_A.userId,
    routedTo: 'owner',
    ownerVendorId: VENDOR_B,
    workflowId: WORKFLOW,
  });
}

describe('POST /api/vendor/integrations/:id/retire — the owner retires', () => {
  it('stamps retired_at and updated_at, keeps the row, and answers the documented shape', async () => {
    const res = await retire(AUTH_B, I_MAIN);
    expect(res.status).toBe(200);
    expect(() => RetireIntegrationResponseSchema.parse(res.body)).not.toThrow();
    const after = await row(I_MAIN);
    expect(after.retiredAt).toBe(res.body.integration.retired_at);
    // `updated_at` moves: that is what puts the row in the Algolia window and moves
    // the freshness cursor.
    expect(after.updatedAt).toBe(res.body.integration.updated_at);
    expect(after.updatedAt > CLAIMED_AT).toBe(true);
    // Retire is not retract: ownership and content are untouched.
    expect(after.claimedAt).toBe(CLAIMED_AT);
    expect(after.name).toBe('Revit for MicroStation');
    expect(after.lastReviewedAt).toBe(CLAIMED_AT);
    expect(res.body.withdrawn_contest_ids).toEqual([]);
  });

  it('writes the audit row and tells the other endpoint vendor, in the same batch', async () => {
    await retire(AUTH_B, I_MAIN);
    const [audit] = await auditsFor(INTEGRATION_RETIRED_ACTION);
    expect(audit).toMatchObject({ actorId: AUTH_B.userId, entityId: I_MAIN });
    expect(audit!.beforeState).toEqual({ retired_at: null });

    const notices = await auditsFor(NOTIFICATION_SENT_ACTION);
    expect(notices.map((n) => (n.metadata as { vendorId: string }).vendorId)).toEqual([VENDOR_A]);
    expect(notices[0]!.metadata).toMatchObject({ kind: 'integration_retire', event: 'retired' });

    const feed = await call(AUTH_A, '/api/vendor/notifications', 'GET');
    expect(() => ListVendorNotificationsResponseSchema.parse(feed.body)).not.toThrow();
    expect(feed.body.notifications[0]).toMatchObject({
      kind: 'integration_retire',
      event: 'retired',
      integration_id: I_MAIN,
      owner_name: 'Bentley',
      pair_path: '/products/microstation/integrations/revit',
    });
  });

  it('recomputes both endpoints and purges every surface that counted the row', async () => {
    await t.db.update(products).set({ integrationCount: 5 });
    const res = await retire(AUTH_B, I_MAIN);
    // Only the unclaimed row is live between the two endpoints now.
    expect(
      (await t.db.query.products.findFirst({ where: eq(products.id, P_SOURCE) }))!.integrationCount,
    ).toBe(2);
    expect(
      (await t.db.query.products.findFirst({ where: eq(products.id, P_TARGET) }))!.integrationCount,
    ).toBe(1);
    const tags = res.send.mock.calls.flatMap((c) => (c[0] as { tags: string[] }).tags);
    expect(tags.sort()).toEqual(
      [
        'pair:microstation__revit',
        'product:microstation',
        'product:revit',
        'vendor:bentley',
        'index:products',
        'taxonomy',
        'sitemap',
      ].sort(),
    );
  });

  it('closes open contests as withdrawn in the same batch, and restore does not reopen them', async () => {
    await seedOpenContest();
    const res = await retire(AUTH_B, I_MAIN);
    expect(res.body.withdrawn_contest_ids).toEqual([CONTEST]);

    const contest = await t.db.query.integrationFieldChallenges.findFirst({
      where: eq(integrationFieldChallenges.id, CONTEST),
    });
    expect(contest!.status).toBe('withdrawn');
    const instance = await t.db.query.workflowInstances.findFirst({
      where: eq(workflowInstances.id, WORKFLOW),
    });
    expect(instance).toMatchObject({ currentState: 'withdrawn', finalOutcome: 'cancelled' });
    const [transition] = await t.db.select().from(workflowTransitions);
    expect(transition).toMatchObject({
      toState: 'withdrawn',
      reason: RETIRE_CLOSED_CONTEST_REASON,
    });
    expect(await auditsFor('integration.contest.withdrawn')).toHaveLength(1);

    await restore(AUTH_B, I_MAIN);
    const after = await t.db.query.integrationFieldChallenges.findFirst({
      where: eq(integrationFieldChallenges.id, CONTEST),
    });
    expect(after!.status).toBe('withdrawn');
  });

  it('refuses a second retire with 409 INTEGRATION_RETIRED and writes nothing', async () => {
    await retire(AUTH_B, I_MAIN);
    const again = await retire(AUTH_B, I_MAIN);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INTEGRATION_RETIRED');
    expect(await auditsFor(INTEGRATION_RETIRED_ACTION)).toHaveLength(1);
  });

  it('answers the other endpoint vendor 403, a stranger 404, and an unknown id 404', async () => {
    const other = await retire(AUTH_A, I_MAIN);
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe('INTEGRATION_NOT_OWNER');
    expect((await retire(AUTH_C, I_MAIN)).status).toBe(404);
    expect((await retire(AUTH_B, uuid(99))).status).toBe(404);
    expect((await row(I_MAIN)).retiredAt).toBeNull();
  });

  it('refuses the owner of an unclaimed row with 409 INTEGRATION_NOT_CLAIMED', async () => {
    const res = await retire(AUTH_B, I_UNCLAIMED);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_NOT_CLAIMED');
  });

  it('refuses a connector-powered row with 403, after ownership', async () => {
    const res = await retire(AUTH_B, I_POWERED);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INTEGRATION_CONNECTOR_POWERED');
    // A non-owner still gets the ownership answer.
    expect((await retire(AUTH_A, I_POWERED)).body.error.code).toBe('INTEGRATION_NOT_OWNER');
  });

  it('refuses a new contest on a retired row with 409 INTEGRATION_RETIRED', async () => {
    await retire(AUTH_B, I_MAIN);
    const res = await call(AUTH_A, `/api/vendor/integrations/${I_MAIN}/contests`, 'POST', {
      field: 'name',
      proposed_value: 'Revit Link',
      reason: 'The name on record is out of date.',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_RETIRED');
  });
});

describe('GET /api/vendor/integrations — a retired row stays listed (ruled 2026-09-22)', () => {
  it('lists it for the owner AND the other endpoint vendor, marked retired', async () => {
    await retire(AUTH_B, I_MAIN);
    for (const auth of [AUTH_A, AUTH_B]) {
      const { body } = await call(auth, '/api/vendor/integrations', 'GET');
      const entry = body.integrations.find((i: JsonBody) => i.id === I_MAIN);
      expect(entry, String(auth.vendorId)).toMatchObject({ claimed_at: CLAIMED_AT });
      expect(entry.retired_at).not.toBeNull();
      expect(entry.is_owner).toBe(auth === AUTH_B);
    }
  });
});

describe('POST /api/vendor/integrations/:id/restore — the owner restores', () => {
  it('clears retired_at, bumps updated_at, audits and notifies', async () => {
    const retired = await retire(AUTH_B, I_MAIN);
    const res = await restore(AUTH_B, I_MAIN);
    expect(res.status).toBe(200);
    expect(res.body.integration.retired_at).toBeNull();
    const after = await row(I_MAIN);
    expect(after.retiredAt).toBeNull();
    expect(after.updatedAt >= retired.body.integration.updated_at).toBe(true);
    const [audit] = await auditsFor(INTEGRATION_RESTORED_ACTION);
    expect(audit!.afterState).toEqual({ retired_at: null });
    const notices = await auditsFor(NOTIFICATION_SENT_ACTION);
    expect(notices.map((n) => (n.metadata as { event: string }).event).sort()).toEqual([
      'restored',
      'retired',
    ]);
  });

  it('refuses a live row with 409 INTEGRATION_NOT_RETIRED and writes nothing', async () => {
    const res = await restore(AUTH_B, I_MAIN);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_NOT_RETIRED');
    expect(await auditsFor(INTEGRATION_RESTORED_ACTION)).toHaveLength(0);
  });

  it('is owner only', async () => {
    await retire(AUTH_B, I_MAIN);
    expect((await restore(AUTH_A, I_MAIN)).body.error.code).toBe('INTEGRATION_NOT_OWNER');
    expect((await row(I_MAIN)).retiredAt).not.toBeNull();
  });
});
