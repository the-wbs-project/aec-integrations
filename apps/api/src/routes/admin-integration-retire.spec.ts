/**
 * `POST /api/admin/integrations/:id/retire` and `/restore`, and
 * `GET /api/admin/vendors/:id/integrations` (AECI-1046).
 *
 * Real migrations on in-memory SQLite with `db.batch` shimmed onto one transaction, so
 * the guarded UPDATE, the race sentinel, the contest closes and the audit-in-batch rule
 * run for real. The batch itself is the owner retire's (`integration-retire-write.ts`),
 * whose own cases are `vendor-integration-retire.spec.ts`.
 */

import {
  AdminVendorIntegrationsResponseSchema,
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
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { NOTIFICATION_SENT_ACTION } from '../lib/attestation-notify';
import type { AuthzVariables } from '../lib/authz';
import { checkRetiredIntegrationsUnclaimed } from '../lib/data-quality';
import { INTEGRATION_RESTORED_ACTION, INTEGRATION_RETIRED_ACTION } from '../lib/integration-retire';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import {
  createAdminRestoreIntegrationHandler,
  createAdminRetireIntegrationHandler,
  createAdminVendorIntegrationsHandler,
} from './admin-integration-retire';
import { createListVendorIntegrationsHandler } from './vendor-attestations';
import {
  createRestoreIntegrationHandler,
  createRetireIntegrationHandler,
} from './vendor-integration-retire';
import { createListVendorNotificationsHandler } from './vendor-notifications';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A owns SOURCE, B owns TARGET and holds I_MAIN (claimed) and I_CREATED (vendor-created).
const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const P_SOURCE = uuid(10);
const P_TARGET = uuid(11);
const I_MAIN = uuid(20); // claimed by B
const I_CURATED = uuid(21); // AECi-held: B on file, never claimed
const I_CREATED = uuid(22); // origin 'vendor', claim cleared by a reassignment
const CONTEST = uuid(30);
const WORKFLOW = uuid(31);
const CLAIMED_AT = '2026-09-01T00:00:00.000Z';
const REASON = 'The listing names a product the vendor does not sell (Terms 7.2).';

const ADMIN: AuthzVariables['auth'] = {
  userId: uuid(90),
  email: 'admin@aeci.test',
  role: 'admin',
  vendorId: null,
  entitlementTier: 'unclaimed',
  entitlement: null,
};
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

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR_A, slug: 'autodesk', companyName: 'Autodesk' },
    { id: VENDOR_B, slug: 'bentley', companyName: 'Bentley' },
  ]);
  await t.db.insert(products).values([
    { id: P_SOURCE, slug: 'revit', name: 'Revit', promotionStatus: 'promoted' },
    { id: P_TARGET, slug: 'microstation', name: 'MicroStation', promotionStatus: 'promoted' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_SOURCE, vendorId: VENDOR_A, isPrimary: true },
    { productId: P_TARGET, vendorId: VENDOR_B, isPrimary: true },
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
      updatedAt: CLAIMED_AT,
    },
    {
      id: I_CURATED,
      name: 'Curated link',
      sourceProductId: P_SOURCE,
      targetProductId: P_TARGET,
      builtByVendorId: VENDOR_B,
    },
    {
      id: I_CREATED,
      name: 'Created link',
      sourceProductId: P_TARGET,
      targetProductId: P_SOURCE,
      builtByVendorId: VENDOR_B,
      origin: 'vendor',
    },
  ]);
  await t.db.insert(profiles).values([
    { id: ADMIN.userId, role: 'admin' },
    ...[AUTH_A, AUTH_B].map((auth) => ({
      id: auth.userId,
      role: 'vendor_admin',
      vendorId: auth.vendorId,
    })),
  ]);
});
afterEach(() => t.dispose());

function app(auth: AuthzVariables['auth']) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.post('/api/admin/integrations/:id/retire', createAdminRetireIntegrationHandler(t.factory));
  a.post('/api/admin/integrations/:id/restore', createAdminRestoreIntegrationHandler(t.factory));
  a.get('/api/admin/vendors/:id/integrations', createAdminVendorIntegrationsHandler(t.factory));
  a.post('/api/vendor/integrations/:id/retire', createRetireIntegrationHandler(t.factory));
  a.post('/api/vendor/integrations/:id/restore', createRestoreIntegrationHandler(t.factory));
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
  const init: RequestInit =
    body !== undefined
      ? { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
      : { method };
  const res = await app(auth).request(path, init, env, execCtx);
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return { status: res.status, body: (await res.json()) as JsonBody, send };
}

const adminRetire = (id: string, reason: unknown = REASON) =>
  call(ADMIN, `/api/admin/integrations/${id}/retire`, 'POST', { reason });
const adminRestore = (id: string, reason: unknown = REASON) =>
  call(ADMIN, `/api/admin/integrations/${id}/restore`, 'POST', { reason });

const row = async (id: string) =>
  (await t.db.query.integrations.findFirst({ where: eq(integrations.id, id) }))!;
const auditsFor = (action: string) =>
  t.db.select().from(auditLog).where(eq(auditLog.action, action));

describe('POST /api/admin/integrations/:id/retire', () => {
  it('retires a claimed row as AECi, keeps it, and answers the documented shape', async () => {
    const res = await adminRetire(I_MAIN);
    expect(res.status).toBe(200);
    expect(() => RetireIntegrationResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body.integration.retired_by).toBe('aeci');
    const after = await row(I_MAIN);
    expect(after.retiredAt).toBe(res.body.integration.retired_at);
    expect(after.retiredBy).toBe('aeci');
    // Not a delete, and not a content write.
    expect(after.claimedAt).toBe(CLAIMED_AT);
    expect(after.builtByVendorId).toBe(VENDOR_B);
    expect(after.maintainedBy).toBe('vendor');
  });

  it('records the admin and the reason, and tells the owner and the other endpoint vendor', async () => {
    const res = await adminRetire(I_MAIN);
    const [audit] = await auditsFor(INTEGRATION_RETIRED_ACTION);
    expect(audit).toMatchObject({ actorId: ADMIN.userId, entityId: I_MAIN });
    expect(audit!.metadata).toMatchObject({
      source: 'admin-moderation',
      reason: REASON,
      retiredBy: 'aeci',
    });
    expect(audit!.afterState).toMatchObject({ retired_by: 'aeci' });

    const notices = await auditsFor(NOTIFICATION_SENT_ACTION);
    expect(notices.map((n) => (n.metadata as { vendorId: string }).vendorId).sort()).toEqual(
      [VENDOR_A, VENDOR_B].sort(),
    );
    for (const n of notices) {
      expect(n.metadata).toMatchObject({ kind: 'integration_retire', retiredBy: 'aeci' });
    }

    // The owner's feed names AEC Integrations as the actor.
    const feed = await call(AUTH_B, '/api/vendor/notifications', 'GET');
    expect(() => ListVendorNotificationsResponseSchema.parse(feed.body)).not.toThrow();
    expect(feed.body.notifications[0]).toMatchObject({
      kind: 'integration_retire',
      event: 'retired',
      retired_by: 'aeci',
      integration_id: I_MAIN,
    });

    // Purged through the queue as an AECi write.
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'moderation',
        tags: expect.arrayContaining(['vendor:bentley', 'product:revit', 'product:microstation']),
      }),
    );
  });

  it('recomputes both endpoint counts in the batch', async () => {
    await adminRetire(I_MAIN);
    const source = await t.db.query.products.findFirst({ where: eq(products.id, P_SOURCE) });
    // I_CURATED and I_CREATED stay live; I_MAIN no longer counts.
    expect(source!.integrationCount).toBe(2);
  });

  it('closes an open contest as withdrawn and tells its submitter', async () => {
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
      reason: 'Out of date.',
      submitterVendorId: VENDOR_A,
      submittedBy: AUTH_A.userId,
      routedTo: 'owner',
      ownerVendorId: VENDOR_B,
      workflowId: WORKFLOW,
    });
    const res = await adminRetire(I_MAIN);
    expect(res.body.withdrawn_contest_ids).toEqual([CONTEST]);
    const contest = await t.db.query.integrationFieldChallenges.findFirst({
      where: eq(integrationFieldChallenges.id, CONTEST),
    });
    expect(contest!.status).toBe('withdrawn');
    expect(contest!.id).toBe(CONTEST);

    // The submitter is told AEC Integrations retired it, and no row but the
    // integration's own audit row carries the admin's reason.
    const notices = await auditsFor(NOTIFICATION_SENT_ACTION);
    const contestNotice = notices.find((n) => (n.metadata as { kind: string }).kind === 'contest');
    expect(contestNotice!.metadata).toMatchObject({
      vendorId: VENDOR_A,
      event: 'closed_by_retire',
      retiredBy: 'aeci',
    });
    expect(JSON.stringify(contestNotice!.metadata)).not.toContain(REASON);
    const [withdrawn] = await auditsFor('integration.contest.withdrawn');
    expect(JSON.stringify(withdrawn!.metadata)).not.toContain(REASON);
    for (const n of notices) expect(JSON.stringify(n.metadata)).not.toContain(REASON);

    const feed = await call(AUTH_A, '/api/vendor/notifications', 'GET');
    expect(() => ListVendorNotificationsResponseSchema.parse(feed.body)).not.toThrow();
    const row = (feed.body.notifications as { kind: string; retired_by?: string }[]).find(
      (n) => n.kind === 'contest',
    );
    expect(row).toMatchObject({ event: 'closed_by_retire', retired_by: 'aeci' });
  });

  it('retires a vendor-created row whose claim was cleared', async () => {
    const res = await adminRetire(I_CREATED);
    expect(res.status).toBe(200);
    // Still vendor-held, so the widened data-quality check stays quiet.
    expect((await checkRetiredIntegrationsUnclaimed(t.db)).lines).toEqual([]);
  });

  it('refuses an AECi-held row with 409 INTEGRATION_NOT_VENDOR_HELD and writes nothing', async () => {
    const res = await adminRetire(I_CURATED);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_NOT_VENDOR_HELD');
    expect((await row(I_CURATED)).retiredAt).toBeNull();
    expect(await auditsFor(INTEGRATION_RETIRED_ACTION)).toHaveLength(0);
  });

  it('refuses a retired row with 409 INTEGRATION_RETIRED', async () => {
    await call(AUTH_B, `/api/vendor/integrations/${I_MAIN}/retire`);
    const res = await adminRetire(I_MAIN);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_RETIRED');
    expect((await row(I_MAIN)).retiredBy).toBe('owner');
  });

  it.each([[''], ['   '], ['x'.repeat(1001)], [undefined]])(
    'refuses a missing or out-of-range reason (%#) with 400',
    async (reason) => {
      const res = await call(ADMIN, `/api/admin/integrations/${I_MAIN}/retire`, 'POST', {
        ...(reason === undefined ? {} : { reason }),
      });
      expect(res.status).toBe(400);
      expect((await row(I_MAIN)).retiredAt).toBeNull();
    },
  );

  it('refuses an unknown id with 404', async () => {
    expect((await adminRetire(uuid(99))).status).toBe(404);
  });
});

describe('POST /api/admin/integrations/:id/restore', () => {
  it('restores its own retire and clears retired_by', async () => {
    await adminRetire(I_MAIN);
    const res = await adminRestore(I_MAIN);
    expect(res.status).toBe(200);
    expect(res.body.integration).toMatchObject({ retired_at: null, retired_by: null });
    const after = await row(I_MAIN);
    expect(after.retiredAt).toBeNull();
    expect(after.retiredBy).toBeNull();
    const [audit] = await auditsFor(INTEGRATION_RESTORED_ACTION);
    expect(audit!.metadata).toMatchObject({ reason: REASON, retiredBy: 'aeci' });
  });

  it('never undoes an owner retire: 409 INTEGRATION_RETIRED_BY_OWNER', async () => {
    await call(AUTH_B, `/api/vendor/integrations/${I_MAIN}/retire`);
    const res = await adminRestore(I_MAIN);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_RETIRED_BY_OWNER');
    expect((await row(I_MAIN)).retiredAt).not.toBeNull();
    expect(await auditsFor(INTEGRATION_RESTORED_ACTION)).toHaveLength(0);
  });

  it('treats a pre-0046 retire (retired_by NULL) as the owner', async () => {
    t.raw
      .prepare(`UPDATE integrations SET retired_at = ?, retired_by = NULL WHERE id = ?`)
      .run(CLAIMED_AT, I_MAIN);
    expect((await adminRestore(I_MAIN)).body.error.code).toBe('INTEGRATION_RETIRED_BY_OWNER');
  });

  it('refuses a live row with 409 INTEGRATION_NOT_RETIRED', async () => {
    expect((await adminRestore(I_MAIN)).body.error.code).toBe('INTEGRATION_NOT_RETIRED');
  });

  it('keeps the owner off an admin retire: 403 INTEGRATION_RETIRED_BY_AECI', async () => {
    await adminRetire(I_MAIN);
    const res = await call(AUTH_B, `/api/vendor/integrations/${I_MAIN}/restore`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INTEGRATION_RETIRED_BY_AECI');
    expect((await row(I_MAIN)).retiredBy).toBe('aeci');
  });

  it('shows the owner who retired it on its integration list', async () => {
    await adminRetire(I_MAIN);
    const list = await call(AUTH_B, '/api/vendor/integrations', 'GET');
    const entry = (list.body.integrations as { id: string; retired_by: string | null }[]).find(
      (i) => i.id === I_MAIN,
    );
    expect(entry?.retired_by).toBe('aeci');
  });
});

describe('GET /api/admin/vendors/:id/integrations', () => {
  it('lists the vendor-held rows the vendor owns, live and retired, and no AECi-held row', async () => {
    await adminRetire(I_MAIN);
    const res = await call(ADMIN, `/api/admin/vendors/${VENDOR_B}/integrations`, 'GET');
    expect(res.status).toBe(200);
    expect(() => AdminVendorIntegrationsResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body.total).toBe(2);
    const ids = (res.body.data as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual([I_CREATED, I_MAIN]);
    expect(res.body.data[1]).toMatchObject({
      retired_by: 'aeci',
      origin: 'aeci',
      pair_path: '/products/microstation/integrations/revit',
    });
    expect(res.body.data[0]).toMatchObject({ origin: 'vendor', retired_by: null });
  });

  it('404s an unknown vendor', async () => {
    expect((await call(ADMIN, `/api/admin/vendors/${uuid(98)}/integrations`, 'GET')).status).toBe(
      404,
    );
  });
});
