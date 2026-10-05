/**
 * The AECi field correction with a lock (AECI-1237, ADR 0039, §11d.5).
 *
 *   POST /api/admin/field-overrides, POST /api/admin/field-overrides/:id/lift,
 *   GET  /api/admin/vendors/:id/field-overrides
 *
 * and the lock's effect on every vendor writer: the profile and product PATCH, the
 * integration PATCH on both anchor tables, and the contest submit and owner accept.
 *
 * Real migrations on in-memory SQLite with `db.batch` shimmed onto one transaction,
 * so the lock row, the column write, the audit row and the notice commit or roll back
 * together, and the partial unique index and the sentinels run for real.
 */

import {
  AdminFieldOverrideResponseSchema,
  AdminFieldOverridesResponseSchema,
  ListVendorIntegrationsResponseSchema,
  ListVendorNotificationsResponseSchema,
  VendorMeResponseSchema,
} from '@aeci/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  connectorEvidencedPairs,
  fieldOverrides,
  integrationFieldChallenges,
  integrations,
  productVendors,
  products,
  profiles,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { NOTIFICATION_SENT_ACTION } from '../lib/attestation-notify';
import type { AuthzVariables } from '../lib/authz';
import type { DbFactory } from '../lib/handler-utils';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import {
  createAdminVendorFieldOverridesHandler,
  createLiftFieldOverrideHandler,
  createSetFieldOverrideHandler,
} from './admin-field-overrides';
import {
  createUpdateVendorProductHandler,
  createUpdateVendorProfileHandler,
  createVendorMeHandler,
} from './vendor';
import { createListVendorIntegrationsHandler } from './vendor-attestations';
import { createDecideContestHandler, createSubmitContestHandler } from './vendor-contests';
import { createUpdateVendorIntegrationHandler } from './vendor-integration-edits';
import { createListVendorNotificationsHandler } from './vendor-notifications';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A owns REVIT; B owns MICROSTATION, holds I_MAIN (claimed) and PAIR (claimed).
// C owns ORPHAN and has no seat, so nothing of C's is vendor-held.
const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const VENDOR_C = uuid(3);
const P_REVIT = uuid(10);
const P_MICRO = uuid(11);
const P_CONN = uuid(12);
const P_ORPHAN = uuid(13);
const I_MAIN = uuid(20);
const I_UNCLAIMED = uuid(21);
const PAIR = uuid(30);
const CONTEST = uuid(40);
const CLAIMED_AT = '2026-09-01T00:00:00.000Z';
const REASON = 'The number on file reaches a different company.';
const NOTE = 'Checked against the company register on 2026-10-03.';

type Auth = AuthzVariables['auth'];
const ADMIN: Auth = {
  userId: uuid(90),
  email: 'admin@aeci.test',
  role: 'admin',
  vendorId: null,
  entitlementTier: 'unclaimed',
  entitlement: null,
};
const seat = (n: number, vendorId: string): Auth =>
  ({
    userId: uuid(100 + n),
    email: `seat${n}@example.test`,
    role: 'vendor_admin',
    vendorId,
    entitlementTier: 'verified',
    entitlement: { status: 'active', periodEnd: null },
  }) as Auth;
const AUTH_A = seat(1, VENDOR_A);
const AUTH_B = seat(2, VENDOR_B);

let t: TestDb;
let factory: DbFactory;

beforeEach(async () => {
  t = await makeTestDb();
  factory = t.factory;
  await t.db.insert(vendors).values([
    { id: VENDOR_A, slug: 'autodesk', companyName: 'Autodesk', phoneNumber: '+1 555 0000' },
    { id: VENDOR_B, slug: 'bentley', companyName: 'Bentley' },
    { id: VENDOR_C, slug: 'nobody', companyName: 'Nobody', phoneNumber: '+1 555 0001' },
  ]);
  await t.db.insert(products).values([
    { id: P_REVIT, slug: 'revit', name: 'Revit', website: 'https://revit.example' },
    { id: P_MICRO, slug: 'microstation', name: 'MicroStation' },
    { id: P_CONN, slug: 'agave', name: 'Agave', productRole: 'connector' },
    { id: P_ORPHAN, slug: 'orphan', name: 'Orphan' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_REVIT, vendorId: VENDOR_A, isPrimary: true },
    { productId: P_MICRO, vendorId: VENDOR_B, isPrimary: true },
    { productId: P_ORPHAN, vendorId: VENDOR_C, isPrimary: true },
  ]);
  await t.db.insert(integrations).values([
    {
      id: I_MAIN,
      name: 'Revit for MicroStation',
      sourceProductId: P_REVIT,
      targetProductId: P_MICRO,
      mechanismKind: 'native',
      docsUrl: 'https://docs.example/old',
      builtByVendorId: VENDOR_B,
      claimedAt: CLAIMED_AT,
      maintainedBy: 'vendor',
    },
    {
      id: I_UNCLAIMED,
      name: 'Curated',
      sourceProductId: P_REVIT,
      targetProductId: P_MICRO,
      builtByVendorId: VENDOR_B,
    },
  ]);
  await t.db.insert(connectorEvidencedPairs).values({
    id: PAIR,
    connectorProductId: P_CONN,
    productAId: P_REVIT,
    productBId: P_MICRO,
    name: 'Revit and MicroStation via Agave',
    direction: 'a_to_b',
    builtByVendorId: VENDOR_B,
    claimedAt: CLAIMED_AT,
  });
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

function app(auth: Auth) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.post('/api/admin/field-overrides', createSetFieldOverrideHandler(factory));
  a.post('/api/admin/field-overrides/:id/lift', createLiftFieldOverrideHandler(factory));
  a.get('/api/admin/vendors/:id/field-overrides', createAdminVendorFieldOverridesHandler(factory));
  a.get('/api/vendor/me', createVendorMeHandler(factory));
  a.patch('/api/vendor/profile', createUpdateVendorProfileHandler(factory));
  a.patch('/api/vendor/products/:id', createUpdateVendorProductHandler(factory));
  a.patch('/api/vendor/integrations/:id', createUpdateVendorIntegrationHandler(factory));
  a.get('/api/vendor/integrations', createListVendorIntegrationsHandler(factory));
  a.get('/api/vendor/notifications', createListVendorNotificationsHandler(factory));
  a.post('/api/vendor/integrations/:id/contests', createSubmitContestHandler(factory));
  a.post('/api/vendor/contests/:id/decision', createDecideContestHandler(factory));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function call(
  auth: Auth,
  path: string,
  method: 'GET' | 'POST' | 'PATCH' = 'POST',
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

const correct = (body: Record<string, unknown>) =>
  call(ADMIN, '/api/admin/field-overrides', 'POST', { reason: REASON, ...body });
const lift = (id: string, reason = 'The vendor sent the registry extract.') =>
  call(ADMIN, `/api/admin/field-overrides/${id}/lift`, 'POST', { reason });
const auditsFor = (action: string) =>
  t.db.select().from(auditLog).where(eq(auditLog.action, action));
const activeLocks = () => t.db.select().from(fieldOverrides).where(isNull(fieldOverrides.liftedAt));

describe('POST /api/admin/field-overrides', () => {
  it('writes the column, the lock, the audit row and the notice, and purges', async () => {
    const res = await correct({
      entityType: 'vendor',
      entityId: VENDOR_A,
      field: 'phone_number',
      value: '+1 555 0100',
      internalNote: NOTE,
    });
    expect(res.status).toBe(201);
    expect(() => AdminFieldOverrideResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body.override).toMatchObject({
      entity_type: 'vendor',
      field: 'phone_number',
      value: '+1 555 0100',
      vendor_id: VENDOR_A,
      lifted_at: null,
    });

    const vendor = await t.db.query.vendors.findFirst({ where: eq(vendors.id, VENDOR_A) });
    expect(vendor!.phoneNumber).toBe('+1 555 0100');
    // An AECi write: no maintenance transfer.
    expect(vendor!.maintainedBy).toBe('aeci');

    const [audit] = await auditsFor('vendor.field_overridden');
    expect(audit).toMatchObject({
      actorId: ADMIN.userId,
      entityType: 'vendor',
      entityId: VENDOR_A,
      vendorId: VENDOR_A,
      vendorTier: 'none',
      vendorEntitlementStatus: 'none',
      beforeState: { phone_number: '+1 555 0000' },
      afterState: { phone_number: '+1 555 0100' },
    });
    expect(audit!.metadata).toMatchObject({
      source: 'admin-moderation',
      reason: REASON,
      reasonVisibility: 'vendor',
      internalNote: NOTE,
      overrideId: res.body.override.id,
    });

    const [notice] = await auditsFor(NOTIFICATION_SENT_ACTION);
    expect(notice).toMatchObject({ vendorId: VENDOR_A });
    expect(notice!.metadata).toMatchObject({
      kind: 'aeci_override',
      event: 'field_corrected',
      notificationId: 'portal-field-corrected-by-aeci',
      reason: REASON,
      value: '+1 555 0100',
    });
    expect(JSON.stringify(notice!.metadata)).not.toContain(NOTE);

    const feed = await call(AUTH_A, '/api/vendor/notifications', 'GET');
    expect(() => ListVendorNotificationsResponseSchema.parse(feed.body)).not.toThrow();
    expect(feed.body.notifications[0]).toMatchObject({
      kind: 'aeci_override',
      event: 'field_corrected',
      field: 'phone_number',
      value: '+1 555 0100',
      reason: REASON,
      record_subject: { type: 'vendor', slug: 'autodesk', name: 'Autodesk' },
    });

    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'moderation', tags: ['vendor:autodesk'] }),
    );
  });

  it('corrects a product link and an integration field, naming the holder', async () => {
    const product = await correct({
      entityType: 'product',
      entityId: P_REVIT,
      field: 'website',
      value: 'https://www.autodesk.com/revit',
    });
    expect(product.status).toBe(201);
    const [productAudit] = await auditsFor('product.field_overridden');
    expect(productAudit).toMatchObject({ vendorId: VENDOR_A, productId: P_REVIT });

    const edge = await correct({
      entityType: 'integration',
      entityId: I_MAIN,
      field: 'direction',
      value: 'b_to_a',
    });
    expect(edge.status).toBe(201);
    const row = await t.db.query.integrations.findFirst({ where: eq(integrations.id, I_MAIN) });
    expect(row!.direction).toBe('b_to_a');
    const [edgeAudit] = await auditsFor('integration.field_overridden');
    expect(edgeAudit).toMatchObject({ vendorId: VENDOR_B, entityType: 'integration' });
    expect(edge.send).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: expect.arrayContaining(['product:revit', 'product:microstation']),
      }),
    );
  });

  it('refuses a record no vendor holds, a field off the list and a bad value', async () => {
    const unheldVendor = await correct({
      entityType: 'vendor',
      entityId: VENDOR_C,
      field: 'phone_number',
      value: '+1 555 0102',
    });
    expect(unheldVendor.status).toBe(409);
    expect(unheldVendor.body.error.code).toBe('FIELD_OVERRIDE_NOT_VENDOR_HELD');
    const unheldEdge = await correct({
      entityType: 'integration',
      entityId: I_UNCLAIMED,
      field: 'name',
      value: 'Renamed',
    });
    expect(unheldEdge.body.error.code).toBe('FIELD_OVERRIDE_NOT_VENDOR_HELD');

    const offList = await correct({
      entityType: 'vendor',
      entityId: VENDOR_A,
      field: 'description',
      value: 'Anything',
    });
    expect(offList.status).toBe(400);
    expect(offList.body.error.field).toBe('field');

    const pairKind = await correct({
      entityType: 'connector_evidenced_pair',
      entityId: PAIR,
      field: 'mechanism_kind',
      value: 'native',
    });
    expect(pairKind.status).toBe(400);

    const badValue = await correct({
      entityType: 'product',
      entityId: P_REVIT,
      field: 'website',
      value: 'not a url',
    });
    expect(badValue.status).toBe(400);
    expect(badValue.body.error.field).toBe('value');

    const noReason = await call(ADMIN, '/api/admin/field-overrides', 'POST', {
      entityType: 'vendor',
      entityId: VENDOR_A,
      field: 'phone_number',
      value: '+1 555 0100',
    });
    expect(noReason.status).toBe(400);
    expect(await activeLocks()).toEqual([]);
    expect(await auditsFor(NOTIFICATION_SENT_ACTION)).toEqual([]);
  });

  it('refuses a second correction while a lock stands', async () => {
    const body = {
      entityType: 'vendor',
      entityId: VENDOR_A,
      field: 'phone_number',
      value: '+1 555 0100',
    };
    expect((await correct(body)).status).toBe(201);
    const again = await correct({ ...body, value: '+1 555 0200' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('FIELD_OVERRIDE_ACTIVE');
    const vendor = await t.db.query.vendors.findFirst({ where: eq(vendors.id, VENDOR_A) });
    expect(vendor!.phoneNumber).toBe('+1 555 0100');
  });

  it('writes nothing when a racing lock lands between the read and the batch', async () => {
    // The column write and the audit row ride the lock insert's batch: when the
    // partial unique index refuses the lock, none of them commit.
    factory = (env) => {
      const handle = t.factory(env);
      const batch = handle.db.batch.bind(handle.db);
      handle.db.batch = (async (stmts: Parameters<typeof batch>[0]) => {
        await t.db.insert(fieldOverrides).values({
          entityType: 'vendor',
          entityId: VENDOR_A,
          field: 'phone_number',
          value: '+1 555 0300',
          reason: 'racing',
          setAt: CLAIMED_AT,
        });
        return batch(stmts);
      }) as unknown as typeof handle.db.batch;
      return handle;
    };
    const res = await correct({
      entityType: 'vendor',
      entityId: VENDOR_A,
      field: 'phone_number',
      value: '+1 555 0100',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FIELD_OVERRIDE_ACTIVE');
    const vendor = await t.db.query.vendors.findFirst({ where: eq(vendors.id, VENDOR_A) });
    expect(vendor!.phoneNumber).toBe('+1 555 0000');
    expect(await auditsFor('vendor.field_overridden')).toEqual([]);
    expect(await auditsFor(NOTIFICATION_SENT_ACTION)).toEqual([]);
  });
});

describe('the lock on vendor writes', () => {
  it('refuses a profile edit of the locked field, and drops one that resends it', async () => {
    await correct({
      entityType: 'vendor',
      entityId: VENDOR_A,
      field: 'phone_number',
      value: '+1 555 0100',
    });
    const refused = await call(AUTH_A, '/api/vendor/profile', 'PATCH', {
      phone_number: '+1 555 9999',
      headquarters: 'San Francisco',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('FIELD_LOCKED_BY_AECI');
    expect(refused.body.error.details).toEqual({ fields: ['phone_number'] });
    const unchanged = await t.db.query.vendors.findFirst({ where: eq(vendors.id, VENDOR_A) });
    expect(unchanged!.headquarters).toBeNull();

    const resent = await call(AUTH_A, '/api/vendor/profile', 'PATCH', {
      phone_number: '+1 555 0100',
      headquarters: 'San Francisco',
    });
    expect(resent.status).toBe(200);
    expect(resent.body.vendor.locked_fields).toEqual([
      expect.objectContaining({ field: 'phone_number', reason: REASON }),
    ]);
    const [edit] = await auditsFor('vendor.updated');
    expect((edit!.metadata as { fields: string[] }).fields).toEqual(['headquarters']);
  });

  it('refuses a product edit of a locked link and shows the lock on /me', async () => {
    await correct({
      entityType: 'product',
      entityId: P_REVIT,
      field: 'website',
      value: 'https://www.autodesk.com/revit',
    });
    const refused = await call(AUTH_A, `/api/vendor/products/${P_REVIT}`, 'PATCH', {
      website: 'https://revit.example',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('FIELD_LOCKED_BY_AECI');

    const me = await call(AUTH_A, '/api/vendor/me', 'GET');
    expect(() => VendorMeResponseSchema.parse(me.body)).not.toThrow();
    expect(me.body.vendor.locked_fields).toEqual([]);
    expect(me.body.products[0].locked_fields).toEqual([
      expect.objectContaining({ field: 'website', reason: REASON }),
    ]);
  });

  it('refuses an owner edit of a locked integration field, on both anchor tables', async () => {
    await correct({
      entityType: 'integration',
      entityId: I_MAIN,
      field: 'docs_url',
      value: 'https://docs.example/new',
    });
    const edge = await call(AUTH_B, `/api/vendor/integrations/${I_MAIN}`, 'PATCH', {
      docs_url: 'https://docs.example/mine',
    });
    expect(edge.status).toBe(409);
    expect(edge.body.error.code).toBe('FIELD_LOCKED_BY_AECI');
    // Another field still saves.
    const other = await call(AUTH_B, `/api/vendor/integrations/${I_MAIN}`, 'PATCH', {
      maturity: 'GA',
    });
    expect(other.status).toBe(200);

    await correct({
      entityType: 'connector_evidenced_pair',
      entityId: PAIR,
      field: 'name',
      value: 'Revit and MicroStation through Agave',
    });
    const pair = await call(AUTH_B, `/api/vendor/integrations/${PAIR}`, 'PATCH', {
      name: 'Something else',
    });
    expect(pair.status).toBe(409);
    expect(pair.body.error.code).toBe('FIELD_LOCKED_BY_AECI');

    const list = await call(AUTH_B, '/api/vendor/integrations', 'GET');
    expect(() => ListVendorIntegrationsResponseSchema.parse(list.body)).not.toThrow();
    const entry = list.body.integrations.find((i: JsonBody) => i.id === I_MAIN);
    expect(entry.locked_fields).toEqual([expect.objectContaining({ field: 'docs_url' })]);
    const owned = list.body.owned.find((i: JsonBody) => i.id === PAIR);
    expect(owned.locked_fields).toEqual([expect.objectContaining({ field: 'name' })]);
  });

  it('aborts a vendor save when the lock lands between its read and its batch', async () => {
    factory = (env) => {
      const handle = t.factory(env);
      const batch = handle.db.batch.bind(handle.db);
      handle.db.batch = (async (stmts: Parameters<typeof batch>[0]) => {
        await t.db.insert(fieldOverrides).values({
          entityType: 'vendor',
          entityId: VENDOR_A,
          field: 'phone_number',
          value: '+1 555 0100',
          reason: REASON,
          setAt: CLAIMED_AT,
        });
        return batch(stmts);
      }) as unknown as typeof handle.db.batch;
      return handle;
    };
    const res = await call(AUTH_A, '/api/vendor/profile', 'PATCH', { phone_number: '+1 555 9999' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FIELD_LOCKED_BY_AECI');
    const vendor = await t.db.query.vendors.findFirst({ where: eq(vendors.id, VENDOR_A) });
    expect(vendor!.phoneNumber).toBe('+1 555 0000');
  });

  it('refuses a contest on a locked field, and an owner accept that would write one', async () => {
    await t.db.insert(integrationFieldChallenges).values({
      id: CONTEST,
      integrationId: I_MAIN,
      field: 'docs_url',
      currentValue: 'https://docs.example/old',
      proposedValue: 'https://docs.example/contested',
      reason: 'The docs moved.',
      submitterVendorId: VENDOR_A,
      routedTo: 'owner',
      ownerVendorId: VENDOR_B,
    });
    await correct({
      entityType: 'integration',
      entityId: I_MAIN,
      field: 'docs_url',
      value: 'https://docs.example/new',
    });

    const accept = await call(AUTH_B, `/api/vendor/contests/${CONTEST}/decision`, 'POST', {
      decision: 'accept',
    });
    expect(accept.status).toBe(409);
    expect(accept.body.error.code).toBe('FIELD_LOCKED_BY_AECI');
    const contest = await t.db.query.integrationFieldChallenges.findFirst({
      where: eq(integrationFieldChallenges.id, CONTEST),
    });
    expect(contest!.status).toBe('open');

    const submit = await call(AUTH_A, `/api/vendor/integrations/${I_MAIN}/contests`, 'POST', {
      field: 'docs_url',
      proposed_value: 'https://docs.example/other',
      reason: 'Still wrong.',
    });
    expect(submit.status).toBe(409);
    expect(submit.body.error.code).toBe('FIELD_LOCKED_BY_AECI');
  });
});

describe('POST /api/admin/field-overrides/:id/lift', () => {
  it('lifts the lock with a reason, tells the vendor, and the vendor can edit again', async () => {
    const set = await correct({
      entityType: 'vendor',
      entityId: VENDOR_A,
      field: 'phone_number',
      value: '+1 555 0100',
    });
    const res = await lift(set.body.override.id);
    expect(res.status).toBe(200);
    expect(res.body.override).toMatchObject({
      lifted_by: ADMIN.userId,
      lift_reason: 'The vendor sent the registry extract.',
    });
    // The column keeps AECi's value.
    const vendor = await t.db.query.vendors.findFirst({ where: eq(vendors.id, VENDOR_A) });
    expect(vendor!.phoneNumber).toBe('+1 555 0100');

    const [audit] = await auditsFor('vendor.override_lifted');
    expect(audit).toMatchObject({ vendorId: VENDOR_A, actorId: ADMIN.userId });
    expect(audit!.metadata).toMatchObject({
      reason: 'The vendor sent the registry extract.',
      reasonVisibility: 'vendor',
    });
    const feed = await call(AUTH_A, '/api/vendor/notifications', 'GET');
    expect(feed.body.notifications[0]).toMatchObject({
      event: 'field_lock_lifted',
      field: 'phone_number',
      value: null,
    });

    const edit = await call(AUTH_A, '/api/vendor/profile', 'PATCH', {
      phone_number: '+1 555 9999',
    });
    expect(edit.status).toBe(200);
    expect(edit.body.vendor.locked_fields).toEqual([]);

    const again = await lift(set.body.override.id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('FIELD_OVERRIDE_LIFTED');

    // And the field can be locked again, under a new row.
    const relock = await correct({
      entityType: 'vendor',
      entityId: VENDOR_A,
      field: 'phone_number',
      value: '+1 555 0100',
    });
    expect(relock.status).toBe(201);
    const rows = await t.db
      .select()
      .from(fieldOverrides)
      .where(and(eq(fieldOverrides.entityId, VENDOR_A), eq(fieldOverrides.field, 'phone_number')));
    expect(rows).toHaveLength(2);
  });

  it('answers 404 for an unknown lock', async () => {
    const res = await lift(uuid(999));
    expect(res.status).toBe(404);
  });
});

describe('GET /api/admin/vendors/:id/field-overrides', () => {
  it("lists the vendor's active locks across its records, with names", async () => {
    await correct({ entityType: 'vendor', entityId: VENDOR_B, field: 'x_url', value: null });
    await correct({
      entityType: 'integration',
      entityId: I_MAIN,
      field: 'maturity',
      value: 'beta',
    });
    const res = await call(ADMIN, `/api/admin/vendors/${VENDOR_B}/field-overrides`, 'GET');
    expect(res.status).toBe(200);
    expect(() => AdminFieldOverridesResponseSchema.parse(res.body)).not.toThrow();
    expect(
      res.body.overrides.map((o: JsonBody) => [o.entity_type, o.entity_name, o.field]).sort(),
    ).toEqual([
      ['integration', 'Revit for MicroStation', 'maturity'],
      ['vendor', 'Bentley', 'x_url'],
    ]);
    // Never another vendor's locks.
    const other = await call(ADMIN, `/api/admin/vendors/${VENDOR_A}/field-overrides`, 'GET');
    expect(other.body.overrides).toEqual([]);
  });
});
