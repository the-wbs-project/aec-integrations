/**
 * `POST /api/vendor/integrations/:id/claim` (AECI-1005 / ADR 0035 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5).
 *
 * Real migrations on in-memory SQLite with `db.batch` shimmed onto one transaction,
 * so the guarded UPDATE, the race sentinel and the audit-in-batch rule run for real.
 */

import {
  ClaimIntegrationResponseSchema,
  ListVendorNotificationsResponseSchema,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, integrations, productVendors, products, profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { NOTIFICATION_SENT_ACTION } from '../lib/attestation-notify';
import type { AuthzVariables } from '../lib/authz';
import { INTEGRATION_CLAIMED_ACTION } from '../lib/integration-claims';
import { routeContest } from '../lib/integration-contests';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { createClaimIntegrationHandler } from './vendor-integration-claims';
import { createListVendorNotificationsHandler } from './vendor-notifications';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A owns SOURCE, B owns TARGET and is the recorded owner of I_MAIN. C owns an
// unrelated product. T is a third-party owner: it owns neither endpoint.
const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const VENDOR_C = uuid(3);
const VENDOR_T = uuid(4);

const P_SOURCE = uuid(10);
const P_TARGET = uuid(11);
const P_FOREIGN = uuid(12);
const P_CONNECTOR = uuid(13);

const I_MAIN = uuid(20); // SOURCE (A) → TARGET (B), owned by B
const I_NO_OWNER = uuid(21); // SOURCE (A) → TARGET (B), nobody on file
const I_THIRD_PARTY = uuid(22); // SOURCE (A) → TARGET (B), owned by T
const I_POWERED = uuid(23); // SOURCE (A) → CONNECTOR (B), Convention-A self-reference, owned by B

const seat = (n: number, vendorId: string): AuthzVariables['auth'] => ({
  userId: uuid(100 + n),
  email: `seat${n}@example.test`,
  role: 'vendor_admin',
  vendorId,
  // No entitlement at all: a seat is the whole gate (decision 15).
  entitlementTier: 'unclaimed',
  entitlement: null,
});
const AUTH_A = seat(1, VENDOR_A);
const AUTH_B = seat(2, VENDOR_B);
const AUTH_C = seat(3, VENDOR_C);
const AUTH_T = seat(4, VENDOR_T);

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR_A, slug: 'autodesk', companyName: 'Autodesk' },
    { id: VENDOR_B, slug: 'bentley', companyName: 'Bentley' },
    { id: VENDOR_C, slug: 'graphisoft', companyName: 'Graphisoft' },
    { id: VENDOR_T, slug: 'integrator', companyName: 'Integrator Co' },
  ]);
  await t.db.insert(products).values([
    { id: P_SOURCE, slug: 'revit', name: 'Revit' },
    { id: P_TARGET, slug: 'microstation', name: 'MicroStation' },
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
      lastReviewedAt: '2026-01-01T00:00:00.000Z',
    },
    { id: I_NO_OWNER, sourceProductId: P_SOURCE, targetProductId: P_TARGET },
    {
      id: I_THIRD_PARTY,
      sourceProductId: P_SOURCE,
      targetProductId: P_TARGET,
      builtByVendorId: VENDOR_T,
    },
    {
      id: I_POWERED,
      sourceProductId: P_SOURCE,
      targetProductId: P_CONNECTOR,
      mechanismKind: 'iPaaS',
      poweredByProductId: P_CONNECTOR,
      builtByVendorId: VENDOR_B,
    },
  ]);
  // `audit_log.actor_id` is an FK to `profiles`, so every seat needs its row.
  await t.db.insert(profiles).values(
    [AUTH_A, AUTH_B, AUTH_C, AUTH_T].map((auth) => ({
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
  a.post('/api/vendor/integrations/:id/claim', createClaimIntegrationHandler(t.factory));
  a.get('/api/vendor/notifications', createListVendorNotificationsHandler(t.factory));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function call(
  auth: AuthzVariables['auth'],
  path: string,
  method: 'GET' | 'POST' = 'POST',
): Promise<{ status: number; body: JsonBody; send: ReturnType<typeof vi.fn> }> {
  const send = vi.fn().mockResolvedValue(undefined);
  const env: Env = {
    ...TEST_ENV,
    CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'],
  };
  const execCtx = fakeExecutionContext();
  const res = await app(auth).request(path, { method }, env, execCtx);
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return { status: res.status, body: (await res.json()) as JsonBody, send };
}

const claim = (auth: AuthzVariables['auth'], id: string) =>
  call(auth, `/api/vendor/integrations/${id}/claim`);

const row = async (id: string) =>
  (await t.db.query.integrations.findFirst({ where: eq(integrations.id, id) }))!;
const auditRows = () => t.db.select().from(auditLog);
const claimAudits = () =>
  t.db.select().from(auditLog).where(eq(auditLog.action, INTEGRATION_CLAIMED_ACTION));
const notificationRows = () =>
  t.db.select().from(auditLog).where(eq(auditLog.action, NOTIFICATION_SENT_ACTION));

describe('POST /api/vendor/integrations/:id/claim — the owner claims', () => {
  it('stamps claimed_at and transfers maintenance, with no approval', async () => {
    const res = await claim(AUTH_B, I_MAIN);

    expect(res.status).toBe(200);
    expect(() => ClaimIntegrationResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body.integration).toMatchObject({
      id: I_MAIN,
      owner_vendor_id: VENDOR_B,
      maintained_by: 'vendor',
    });
    const after = await row(I_MAIN);
    expect(after.claimedAt).toBe(res.body.integration.claimed_at);
    expect(after.maintainedBy).toBe('vendor');
    expect(after.lastReviewedAt).toBe(res.body.integration.claimed_at);
    // The owner does not change, and the content is untouched.
    expect(after.builtByVendorId).toBe(VENDOR_B);
    expect(after.name).toBe('Revit for MicroStation');
    expect(after.origin).toBe('aeci');
  });

  it('writes the integration.claimed audit row in the same batch, marking the transfer', async () => {
    await claim(AUTH_B, I_MAIN);
    const [audit] = await claimAudits();
    expect(audit).toMatchObject({
      actorId: AUTH_B.userId,
      entityType: 'integration',
      entityId: I_MAIN,
    });
    expect(audit!.beforeState).toMatchObject({
      claimed_at: null,
      maintained_by: 'aeci',
      last_reviewed_at: '2026-01-01T00:00:00.000Z',
    });
    expect(audit!.afterState).toMatchObject({
      maintained_by: 'vendor',
      built_by_vendor_id: VENDOR_B,
    });
    expect(audit!.metadata).toMatchObject({
      source: 'vendor-portal',
      vendorId: VENDOR_B,
      reason: 'owner-claim',
      maintenanceTransfer: true,
    });
    expect(audit!.metadata).not.toHaveProperty('connectorPowered');
  });

  it('notifies the other endpoint vendor, and never the owner', async () => {
    await claim(AUTH_B, I_MAIN);
    const rows = await notificationRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: 'integration', entityId: I_MAIN });
    expect(rows[0]!.metadata).toMatchObject({
      kind: 'integration_claim',
      vendorId: VENDOR_A,
      ownerVendorId: VENDOR_B,
      ownerName: 'Bentley',
      integrationName: 'Revit for MicroStation',
      pairSlugs: ['microstation', 'revit'],
    });
  });

  it('surfaces the notification in the other vendor’s feed only', async () => {
    await claim(AUTH_B, I_MAIN);
    const feedA = await call(AUTH_A, '/api/vendor/notifications', 'GET');
    expect(() => ListVendorNotificationsResponseSchema.parse(feedA.body)).not.toThrow();
    expect(feedA.body.notifications).toEqual([
      expect.objectContaining({
        kind: 'integration_claim',
        integration_id: I_MAIN,
        owner_name: 'Bentley',
        pair_path: '/products/microstation/integrations/revit',
      }),
    ]);
    const feedB = await call(AUTH_B, '/api/vendor/notifications', 'GET');
    expect(feedB.body.notifications).toEqual([]);
  });

  it('purges the pair page and both product pages', async () => {
    const res = await claim(AUTH_B, I_MAIN);
    expect(res.send).toHaveBeenCalledWith({
      tags: ['pair:microstation__revit', 'product:revit', 'product:microstation'],
      source: 'vendor',
    });
  });

  it('lets a third-party owner claim, and notifies BOTH endpoint vendors', async () => {
    const res = await claim(AUTH_T, I_THIRD_PARTY);
    expect(res.status).toBe(200);
    const recipients = (await notificationRows())
      .map((r) => (r.metadata as { vendorId: string }).vendorId)
      .sort();
    expect(recipients).toEqual([VENDOR_A, VENDOR_B].sort());
  });

  it('allows a connector-powered row to be claimed, and records that it is one (decision 9)', async () => {
    const res = await claim(AUTH_B, I_POWERED);
    expect(res.status).toBe(200);
    const [audit] = await claimAudits();
    expect(audit!.metadata).toMatchObject({ connectorPowered: true });
  });
});

describe('POST /api/vendor/integrations/:id/claim — refusals', () => {
  it('refuses a second claim with 409 and writes nothing', async () => {
    await claim(AUTH_B, I_MAIN);
    const before = (await auditRows()).length;
    const res = await claim(AUTH_B, I_MAIN);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_ALREADY_CLAIMED');
    expect(await auditRows()).toHaveLength(before);
  });

  it('answers 403 to an endpoint vendor that is not the owner', async () => {
    const res = await claim(AUTH_A, I_MAIN);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INTEGRATION_NOT_OWNER');
    expect((await row(I_MAIN)).claimedAt).toBeNull();
    expect(await auditRows()).toHaveLength(0);
  });

  it('answers 409 INTEGRATION_OWNER_UNKNOWN when nobody is on file', async () => {
    const res = await claim(AUTH_A, I_NO_OWNER);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_OWNER_UNKNOWN');
    expect(await auditRows()).toHaveLength(0);
  });

  it('answers the same 404 for a row the caller cannot see and for an unknown id', async () => {
    const hidden = await claim(AUTH_C, I_MAIN);
    const unknown = await claim(AUTH_C, uuid(999));
    expect(hidden.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(hidden.body.error.code).toBe(unknown.body.error.code);
    // Nor may an unrelated vendor learn that a row has no owner.
    expect((await claim(AUTH_C, I_NO_OWNER)).status).toBe(404);
    expect(await auditRows()).toHaveLength(0);
  });

  it('lets exactly one of two racing claims win, and the loser writes nothing', async () => {
    const [first, second] = await Promise.all([claim(AUTH_B, I_MAIN), claim(AUTH_B, I_MAIN)]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(await claimAudits()).toHaveLength(1);
    expect(await notificationRows()).toHaveLength(1);
  });

  it('refuses the old owner when promote re-pointed the owner before the batch ran', async () => {
    // The guarded UPDATE is also keyed on `built_by_vendor_id`, so a claim planned
    // against a stale owner aborts at the sentinel rather than claiming for them.
    const factory = t.factory;
    let flipped = false;
    const racing = createClaimIntegrationHandler((env, opts) => {
      const ctx = factory(env, opts);
      if (!flipped) {
        const batch = ctx.db.batch.bind(ctx.db);
        (ctx.db as unknown as { batch: typeof batch }).batch = (async (stmts: never) => {
          flipped = true;
          t.raw
            .prepare(`UPDATE integrations SET built_by_vendor_id = ? WHERE id = ?`)
            .run(VENDOR_A, I_MAIN);
          return batch(stmts);
        }) as typeof batch;
      }
      return ctx;
    });
    const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    a.onError(errorHandler());
    a.use('*', async (c, next) => {
      c.set('auth', AUTH_B);
      await next();
    });
    a.post('/api/vendor/integrations/:id/claim', racing);
    const res = await a.request(
      `/api/vendor/integrations/${I_MAIN}/claim`,
      { method: 'POST' },
      TEST_ENV,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(403);
    expect((await row(I_MAIN)).claimedAt).toBeNull();
    expect(await claimAudits()).toHaveLength(0);
  });
});

describe('contest routing once claimed (the isIntegrationClaimed stub, replaced)', () => {
  it('routes a content contest to the owner and an owner contest to AECi', async () => {
    await claim(AUTH_B, I_MAIN);
    const claimed = await row(I_MAIN);
    expect(routeContest(claimed, 'listing_url').routedTo).toBe('owner');
    expect(routeContest(claimed, 'owner').routedTo).toBe('aeci');
    // An unclaimed row with an owner on file still routes to AECi.
    expect(routeContest(await row(I_THIRD_PARTY), 'listing_url').routedTo).toBe('aeci');
  });
});
