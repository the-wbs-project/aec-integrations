/**
 * The value hide's third way out (AECI-1238 §11d.7): every vendor writer of a hideable
 * field ends an active hide on a field it CHANGES, in its own batch, and the vendor reads
 * carry `hidden_fields`.
 *
 *   - `PATCH /api/vendor/profile`, `PATCH /api/vendor/products/:id`;
 *   - `PATCH /api/vendor/integrations/:id`, both anchor tables;
 *   - the owner's contest accept (`POST /api/vendor/contests/:id/decision`);
 *   - the AECi contest accept on a claimed row (`PATCH /api/admin/contests/:id`), which
 *     clears as `corrected` and tells the vendor named on the hide.
 *
 * The removal election's clear is in `vendor-removal-election.spec.ts`.
 *
 * Real migrations on in-memory SQLite with `db.batch` shimmed onto one transaction, so
 * the guarded audit row, the guarded UPDATE and the writer's own statements commit or
 * roll back together.
 */

import { ListVendorIntegrationsResponseSchema, VendorMeResponseSchema } from '@aeci/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  connectorEvidencedPairs,
  fieldHides,
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
import { racingFactory } from '../test/racing-factory';
import { createModerateContestHandler } from './admin-contests';
import {
  createUpdateVendorProductHandler,
  createUpdateVendorProfileHandler,
  createVendorMeHandler,
} from './vendor';
import { createListVendorIntegrationsHandler } from './vendor-attestations';
import { createDecideContestHandler } from './vendor-contests';
import { createUpdateVendorIntegrationHandler } from './vendor-integration-edits';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A owns REVIT; B owns MICROSTATION, holds I_MAIN (claimed) and PAIR (claimed).
const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const P_REVIT = uuid(10);
const P_MICRO = uuid(11);
const P_CONN = uuid(12);
const I_MAIN = uuid(20);
const PAIR = uuid(30);
const CONTEST = uuid(40);
const CLAIMED_AT = '2026-09-01T00:00:00.000Z';
const HIDE_REASON = 'A reader sent a registry page that shows another number.';
const HIDE_SOURCE = 'https://example.com/registry';
const HIDE_NOTE = 'INTERNAL: requester is a competitor.';

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
let hideSeq = 0;

beforeEach(async () => {
  t = await makeTestDb();
  factory = t.factory;
  hideSeq = 0;
  await t.db.insert(vendors).values([
    {
      id: VENDOR_A,
      slug: 'autodesk',
      companyName: 'Autodesk',
      phoneNumber: '+1 555 0000',
      description: 'The design company.',
      ownedAt: CLAIMED_AT,
    },
    { id: VENDOR_B, slug: 'bentley', companyName: 'Bentley', ownedAt: CLAIMED_AT },
  ]);
  await t.db.insert(products).values([
    {
      id: P_REVIT,
      slug: 'revit',
      name: 'Revit',
      website: 'https://revit.example',
      description: 'BIM authoring.',
    },
    { id: P_MICRO, slug: 'microstation', name: 'MicroStation' },
    { id: P_CONN, slug: 'agave', name: 'Agave', productRole: 'connector' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_REVIT, vendorId: VENDOR_A, isPrimary: true },
    { productId: P_MICRO, vendorId: VENDOR_B, isPrimary: true },
  ]);
  await t.db.insert(integrations).values({
    id: I_MAIN,
    name: 'Revit for MicroStation',
    sourceProductId: P_REVIT,
    targetProductId: P_MICRO,
    mechanismKind: 'native',
    docsUrl: 'https://docs.example/old',
    builtByVendorId: VENDOR_B,
    claimedAt: CLAIMED_AT,
    maintainedBy: 'vendor',
  });
  await t.db.insert(connectorEvidencedPairs).values({
    id: PAIR,
    connectorProductId: P_CONN,
    productAId: P_REVIT,
    productBId: P_MICRO,
    name: 'Revit and MicroStation via Agave',
    description: 'Syncs models.',
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

function app(auth: Auth, dbFor: DbFactory = factory) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.get('/api/vendor/me', createVendorMeHandler(dbFor));
  a.patch('/api/vendor/profile', createUpdateVendorProfileHandler(dbFor));
  a.patch('/api/vendor/products/:id', createUpdateVendorProductHandler(dbFor));
  a.patch('/api/vendor/integrations/:id', createUpdateVendorIntegrationHandler(dbFor));
  a.get('/api/vendor/integrations', createListVendorIntegrationsHandler(dbFor));
  a.post('/api/vendor/contests/:id/decision', createDecideContestHandler(dbFor));
  a.patch(
    '/api/admin/contests/:id',
    createModerateContestHandler(dbFor, vi.fn().mockResolvedValue(null)),
  );
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function call(
  auth: Auth,
  path: string,
  method: 'GET' | 'POST' | 'PATCH' = 'PATCH',
  body?: unknown,
  dbFor?: DbFactory,
): Promise<{ status: number; body: JsonBody }> {
  const env: Env = {
    ...TEST_ENV,
    CACHE_PURGE_QUEUE: { send: vi.fn() } as unknown as Env['CACHE_PURGE_QUEUE'],
  };
  const execCtx = fakeExecutionContext();
  const init: RequestInit =
    body !== undefined
      ? { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
      : { method };
  const res = await app(auth, dbFor).request(path, init, env, execCtx);
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return { status: res.status, body: (await res.json()) as JsonBody };
}

/** Seed one active hide, as `POST /api/admin/field-hides` leaves it. */
async function hide(
  entityType: 'vendor' | 'product' | 'integration' | 'connector_evidenced_pair',
  entityId: string,
  field: string,
  vendorId: string,
): Promise<string> {
  const id = uuid(500 + ++hideSeq);
  await t.db.insert(fieldHides).values({
    id,
    entityType,
    entityId,
    field,
    reason: HIDE_REASON,
    internalNote: HIDE_NOTE,
    sourceUrl: HIDE_SOURCE,
    receivedAt: '2026-11-02',
    vendorId,
    setBy: ADMIN.userId,
    setAt: `2026-11-03T00:00:0${hideSeq}.000Z`,
  });
  return id;
}

const hideRow = async (id: string) =>
  (await t.db.select().from(fieldHides).where(eq(fieldHides.id, id)))[0]!;
const auditsFor = (action: string) =>
  t.db.select().from(auditLog).where(eq(auditLog.action, action));
const hideNotices = async () =>
  (await auditsFor(NOTIFICATION_SENT_ACTION)).filter(
    (row) => (row.metadata as { event?: string }).event === 'field_hide_cleared',
  );

describe('PATCH /api/vendor/profile', () => {
  it('ends the hide on a changed field in its batch, with the vendor stamp and no notice', async () => {
    const id = await hide('vendor', VENDOR_A, 'phone_number', VENDOR_A);
    const res = await call(AUTH_A, '/api/vendor/profile', 'PATCH', {
      phone_number: '+1 555 0199',
    });
    expect(res.status).toBe(200);
    expect(res.body.vendor.hidden_fields).toEqual([]);

    expect(await hideRow(id)).toMatchObject({
      clearKind: 'vendor_edit',
      clearedBy: AUTH_A.userId,
      clearReason: null,
    });
    expect((await hideRow(id)).clearedAt).not.toBeNull();
    const [audit] = await auditsFor('vendor.field_hide_cleared');
    expect(audit).toMatchObject({
      entityType: 'vendor',
      entityId: VENDOR_A,
      actorId: AUTH_A.userId,
      vendorId: VENDOR_A,
    });
    expect(audit!.metadata).toMatchObject({
      field: 'phone_number',
      fieldHideId: id,
      clearKind: 'vendor_edit',
    });
    expect(await hideNotices()).toEqual([]);
  });

  it('ends a hidden description, which is hideable though not lockable', async () => {
    const id = await hide('vendor', VENDOR_A, 'description', VENDOR_A);
    const res = await call(AUTH_A, '/api/vendor/profile', 'PATCH', {
      description: 'A rewritten description.',
    });
    expect(res.status).toBe(200);
    expect((await hideRow(id)).clearKind).toBe('vendor_edit');
  });

  it('keeps the hide on a resend of the stored value', async () => {
    const id = await hide('vendor', VENDOR_A, 'phone_number', VENDOR_A);
    const res = await call(AUTH_A, '/api/vendor/profile', 'PATCH', {
      phone_number: '+1 555 0000',
      headquarters: 'San Francisco',
    });
    expect(res.status).toBe(200);
    expect((await hideRow(id)).clearedAt).toBeNull();
    expect(await auditsFor('vendor.field_hide_cleared')).toEqual([]);
    expect(res.body.vendor.hidden_fields).toEqual([
      expect.objectContaining({ field: 'phone_number' }),
    ]);
  });

  it('keeps the hide on a field the save does not touch', async () => {
    const id = await hide('vendor', VENDOR_A, 'phone_number', VENDOR_A);
    const res = await call(AUTH_A, '/api/vendor/profile', 'PATCH', {
      headquarters: 'San Francisco',
    });
    expect(res.status).toBe(200);
    expect((await hideRow(id)).clearedAt).toBeNull();
  });
});

describe('PATCH /api/vendor/products/:id', () => {
  it('ends the hide on a changed link, and keeps the description hide', async () => {
    const website = await hide('product', P_REVIT, 'website', VENDOR_A);
    const description = await hide('product', P_REVIT, 'description', VENDOR_A);
    const res = await call(AUTH_A, `/api/vendor/products/${P_REVIT}`, 'PATCH', {
      website: 'https://www.autodesk.com/revit',
    });
    expect(res.status).toBe(200);
    expect((await hideRow(website)).clearKind).toBe('vendor_edit');
    expect((await hideRow(description)).clearedAt).toBeNull();
    expect(res.body.product.hidden_fields).toEqual([
      expect.objectContaining({ field: 'description' }),
    ]);
    const [audit] = await auditsFor('product.field_hide_cleared');
    expect(audit).toMatchObject({ entityId: P_REVIT, productId: P_REVIT, vendorId: VENDOR_A });
  });
});

describe('PATCH /api/vendor/integrations/:id', () => {
  it('ends the hide on a changed integrations-row field', async () => {
    const id = await hide('integration', I_MAIN, 'docs_url', VENDOR_B);
    const res = await call(AUTH_B, `/api/vendor/integrations/${I_MAIN}`, 'PATCH', {
      docs_url: 'https://docs.example/new',
    });
    expect(res.status).toBe(200);
    expect((await hideRow(id)).clearKind).toBe('vendor_edit');
    const [audit] = await auditsFor('integration.field_hide_cleared');
    expect(audit).toMatchObject({
      entityType: 'integration',
      entityId: I_MAIN,
      vendorId: VENDOR_B,
    });
    expect(await hideNotices()).toEqual([]);
  });

  it('ends the hide on a changed evidenced-pair field', async () => {
    const id = await hide('connector_evidenced_pair', PAIR, 'description', VENDOR_B);
    const res = await call(AUTH_B, `/api/vendor/integrations/${PAIR}`, 'PATCH', {
      description: 'Syncs models both ways.',
    });
    expect(res.status).toBe(200);
    expect((await hideRow(id)).clearKind).toBe('vendor_edit');
    const [audit] = await auditsFor('integration.field_hide_cleared');
    expect(audit).toMatchObject({ entityType: 'connector_evidenced_pair', entityId: PAIR });
  });

  it('rolls the clear back with a save that loses its race', async () => {
    const id = await hide('integration', I_MAIN, 'docs_url', VENDOR_B);
    // The claim ends between the handler's read and its batch: the owner-write
    // sentinel aborts the batch, and the clear with it.
    const racing = racingFactory(factory, () => {
      t.raw.prepare('UPDATE integrations SET claimed_at = NULL WHERE id = ?').run(I_MAIN);
    });
    const res = await call(
      AUTH_B,
      `/api/vendor/integrations/${I_MAIN}`,
      'PATCH',
      { docs_url: 'https://docs.example/new' },
      racing,
    );
    expect(res.status).toBe(409);
    expect((await hideRow(id)).clearedAt).toBeNull();
    expect(await auditsFor('integration.field_hide_cleared')).toEqual([]);
  });

  it('writes no second row for a hide an admin cleared in the same instant', async () => {
    const id = await hide('integration', I_MAIN, 'docs_url', VENDOR_B);
    const racing = racingFactory(factory, () => {
      t.raw
        .prepare(
          "UPDATE field_hides SET cleared_at = '2026-11-04T00:00:00.000Z', clear_kind = 'restored' WHERE id = ?",
        )
        .run(id);
    });
    const res = await call(
      AUTH_B,
      `/api/vendor/integrations/${I_MAIN}`,
      'PATCH',
      { docs_url: 'https://docs.example/new' },
      racing,
    );
    expect(res.status).toBe(200);
    expect((await hideRow(id)).clearKind).toBe('restored');
    expect(await auditsFor('integration.field_hide_cleared')).toEqual([]);
  });
});

describe('contest accepts', () => {
  async function fileContest(routedTo: 'owner' | 'aeci') {
    await t.db.insert(integrationFieldChallenges).values({
      id: CONTEST,
      integrationId: I_MAIN,
      field: 'docs_url',
      currentValue: 'https://docs.example/old',
      proposedValue: 'https://docs.example/contested',
      reason: 'The docs moved.',
      submitterVendorId: VENDOR_A,
      routedTo,
      ownerVendorId: routedTo === 'owner' ? VENDOR_B : null,
    });
  }

  it("ends the hide as the owner's edit when the owner accepts", async () => {
    const id = await hide('integration', I_MAIN, 'docs_url', VENDOR_B);
    await fileContest('owner');
    const res = await call(AUTH_B, `/api/vendor/contests/${CONTEST}/decision`, 'POST', {
      decision: 'accept',
    });
    expect(res.status).toBe(200);
    expect(await hideRow(id)).toMatchObject({ clearKind: 'vendor_edit', clearedBy: AUTH_B.userId });
    const [audit] = await auditsFor('integration.field_hide_cleared');
    expect(audit).toMatchObject({ entityId: I_MAIN, vendorId: VENDOR_B });
    expect(await hideNotices()).toEqual([]);
  });

  it('ends the hide as a correction when AECi accepts on a claimed row, and tells the vendor', async () => {
    const id = await hide('integration', I_MAIN, 'docs_url', VENDOR_B);
    await fileContest('aeci');
    const note = 'The vendor page moved; the new link is correct.';
    const res = await call(ADMIN, `/api/admin/contests/${CONTEST}`, 'PATCH', {
      decision: 'accept',
      note,
      sourceUrl: 'https://docs.example/contested',
    });
    expect(res.status).toBe(200);
    expect(await hideRow(id)).toMatchObject({
      clearKind: 'corrected',
      clearedBy: ADMIN.userId,
      clearReason: note,
    });
    const [audit] = await auditsFor('integration.field_hide_cleared');
    expect(audit).toMatchObject({ actorId: ADMIN.userId, vendorId: VENDOR_B });
    expect(audit!.metadata).toMatchObject({ clearKind: 'corrected', source: 'admin-moderation' });
    const [notice] = await hideNotices();
    expect(notice).toMatchObject({ vendorId: VENDOR_B, entityId: I_MAIN });
    expect(notice!.metadata).toMatchObject({
      notificationId: 'portal-field-hide-cleared-by-aeci',
      field: 'docs_url',
      fieldHideId: id,
      hideClearKind: 'corrected',
      reason: note,
      reasonVisibility: 'vendor',
    });
    expect(JSON.stringify(notice!.metadata)).not.toContain(HIDE_NOTE);
  });
});

describe('the vendor reads carry hidden_fields', () => {
  it('on the company and each product, with the reason and source, never the note', async () => {
    await hide('vendor', VENDOR_A, 'description', VENDOR_A);
    await hide('product', P_REVIT, 'website', VENDOR_A);
    const me = await call(AUTH_A, '/api/vendor/me', 'GET');
    expect(me.status).toBe(200);
    expect(() => VendorMeResponseSchema.parse(me.body)).not.toThrow();
    expect(me.body.vendor.hidden_fields).toEqual([
      {
        field: 'description',
        reason: HIDE_REASON,
        set_at: expect.any(String),
        source_url: HIDE_SOURCE,
      },
    ]);
    expect(me.body.products[0].hidden_fields).toEqual([
      expect.objectContaining({ field: 'website', source_url: HIDE_SOURCE }),
    ]);
    expect(JSON.stringify(me.body)).not.toContain(HIDE_NOTE);
  });

  it('on the integration entries of both anchor tables', async () => {
    await hide('integration', I_MAIN, 'docs_url', VENDOR_B);
    await hide('connector_evidenced_pair', PAIR, 'description', VENDOR_B);
    const list = await call(AUTH_B, '/api/vendor/integrations', 'GET');
    expect(list.status).toBe(200);
    expect(() => ListVendorIntegrationsResponseSchema.parse(list.body)).not.toThrow();
    const entry = list.body.integrations.find((i: JsonBody) => i.id === I_MAIN);
    expect(entry.hidden_fields).toEqual([
      expect.objectContaining({ field: 'docs_url', reason: HIDE_REASON }),
    ]);
    const owned = list.body.owned.find((i: JsonBody) => i.id === PAIR);
    expect(owned.hidden_fields).toEqual([expect.objectContaining({ field: 'description' })]);
    expect(JSON.stringify(list.body)).not.toContain(HIDE_NOTE);
  });

  it('lists no cleared hide', async () => {
    const id = await hide('vendor', VENDOR_A, 'description', VENDOR_A);
    await t.db
      .update(fieldHides)
      .set({ clearedAt: '2026-11-04T00:00:00.000Z', clearKind: 'restored' })
      .where(and(eq(fieldHides.id, id), isNull(fieldHides.clearedAt)));
    const me = await call(AUTH_A, '/api/vendor/me', 'GET');
    expect(me.body.vendor.hidden_fields).toEqual([]);
  });
});
