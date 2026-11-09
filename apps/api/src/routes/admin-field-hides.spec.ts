/**
 * The single-value hide, "under review" (AECI-1238 section B, §11d.7).
 *
 *   POST /api/admin/field-hides, POST /api/admin/field-hides/:id/restore,
 *   POST /api/admin/field-hides/:id/status-reply, GET /api/admin/vendors/:id/field-hides
 *
 * plus the AECi correction that ends a hide (`POST /api/admin/field-overrides`), the
 * business-day dues and the `field_hide_decision_overdue` check. The vendor-writer clears
 * have their own spec. Route registration (the admin guard, then the write limiter) is
 * `admin-field-hides.registration.spec.ts`.
 *
 * Real migrations on in-memory SQLite with `db.batch` shimmed onto one transaction, so
 * the hide row, the audit row and the notice commit or roll back together, and the
 * partial unique index and the sentinels run for real.
 */

import {
  AdminFieldHideResponseSchema,
  AdminFieldHidesResponseSchema,
  ListVendorNotificationsResponseSchema,
} from '@aeci/shared';
import { eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  connectorEvidencedPairs,
  fieldHides,
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
import { checkFieldHideDecisionOverdue, CHECKS } from '../lib/data-quality';
import { fieldHideDues, receivedInstant } from '../lib/field-hide-dues';
import type { DbFactory } from '../lib/handler-utils';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import {
  createAdminVendorFieldHidesHandler,
  createFieldHideStatusReplyHandler,
  createRestoreFieldHideHandler,
  createSetFieldHideHandler,
} from './admin-field-hides';
import { createSetFieldOverrideHandler } from './admin-field-overrides';
import { createListVendorNotificationsHandler } from './vendor-notifications';

const { syncSpy } = vi.hoisted(() => ({ syncSpy: vi.fn() }));
vi.mock('./integration-retire-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./integration-retire-write')>();
  return {
    ...actual,
    syncOwnerWriteSearch: (...args: Parameters<typeof actual.syncOwnerWriteSearch>) => {
      syncSpy(args[2]);
      return Promise.resolve();
    },
  };
});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A owns REVIT; B owns MICROSTATION and holds I_MAIN and PAIR (claimed). A and B own
// their records. C owns ORPHAN but is not owned, so nothing of C's is vendor-held.
const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const VENDOR_C = uuid(3);
const P_REVIT = uuid(10);
const P_MICRO = uuid(11);
const P_CONN = uuid(12);
const P_ORPHAN = uuid(13);
const I_MAIN = uuid(20);
const PAIR = uuid(30);
const CLAIMED_AT = '2026-09-01T00:00:00.000Z';
const REASON = 'A public registry lists a different number for this company.';
const SOURCE_URL = 'https://example.com/registry-extract';
const NOTE = 'Requester emailed on 2026-11-06.';
// A Friday. Nov 11 is Veterans Day, so it is not a business day.
const RECEIVED = '2026-11-06';

type Auth = AuthzVariables['auth'];
const ADMIN: Auth = {
  userId: uuid(90),
  email: 'admin@aeci.test',
  role: 'admin',
  vendorId: null,
  entitlementTier: 'unclaimed',
  entitlement: null,
};
const AUTH_A = {
  userId: uuid(101),
  email: 'seat1@example.test',
  role: 'vendor_admin',
  vendorId: VENDOR_A,
  entitlementTier: 'verified',
  entitlement: { status: 'active', periodEnd: null },
} as Auth;

let t: TestDb;
let factory: DbFactory;

beforeEach(async () => {
  syncSpy.mockReset();
  t = await makeTestDb();
  factory = t.factory;
  await t.db.insert(vendors).values([
    {
      id: VENDOR_A,
      slug: 'autodesk',
      companyName: 'Autodesk',
      phoneNumber: '+1 555 0000',
      description: 'Design software.',
      ownedAt: CLAIMED_AT,
    },
    { id: VENDOR_B, slug: 'bentley', companyName: 'Bentley', ownedAt: CLAIMED_AT },
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
    direction: 'a_to_b',
    builtByVendorId: VENDOR_B,
    claimedAt: CLAIMED_AT,
  });
  await t.db.insert(profiles).values([
    { id: ADMIN.userId, role: 'admin' },
    { id: AUTH_A.userId, role: 'vendor_admin', vendorId: VENDOR_A },
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
  a.post('/api/admin/field-hides', createSetFieldHideHandler(factory));
  a.post('/api/admin/field-hides/:id/restore', createRestoreFieldHideHandler(factory));
  a.post('/api/admin/field-hides/:id/status-reply', createFieldHideStatusReplyHandler(factory));
  a.get('/api/admin/vendors/:id/field-hides', createAdminVendorFieldHidesHandler(factory));
  a.post('/api/admin/field-overrides', createSetFieldOverrideHandler(factory));
  a.get('/api/vendor/notifications', createListVendorNotificationsHandler(factory));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function call(
  auth: Auth,
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

const hide = (body: Record<string, unknown>) =>
  call(ADMIN, '/api/admin/field-hides', 'POST', {
    reason: REASON,
    sourceUrl: SOURCE_URL,
    receivedAt: RECEIVED,
    ...body,
  });
const restore = (id: string, reason = 'The registry was out of date. The value stands.') =>
  call(ADMIN, `/api/admin/field-hides/${id}/restore`, 'POST', { reason });
const statusReply = (id: string, note = 'Told the requester we are still checking.') =>
  call(ADMIN, `/api/admin/field-hides/${id}/status-reply`, 'POST', { note });
const auditsFor = (action: string) =>
  t.db.select().from(auditLog).where(eq(auditLog.action, action));
const activeHides = () => t.db.select().from(fieldHides).where(isNull(fieldHides.clearedAt));
const purgedTags = (send: ReturnType<typeof vi.fn>) =>
  send.mock.calls.flatMap((c) => (c[0] as { tags?: string[] }).tags ?? []);

describe('the business-day dues', () => {
  it('counts two and five New York business days from a bare received date', () => {
    // Fri Nov 6: Mon 9 and Tue 10 are the two days, so the hide is due by the end of
    // Tue 10. Wed 11 is Veterans Day, so the five days are 9, 10, 12, 13 and Mon 16.
    expect(fieldHideDues(RECEIVED)).toEqual({
      hideDue: '2026-11-11T05:00:00.000Z',
      decideDue: '2026-11-17T05:00:00.000Z',
    });
  });

  it('reads a bare date as that New York day, not the evening before', () => {
    expect(receivedInstant(RECEIVED)).toBe('2026-11-06T17:00:00.000Z');
    expect(receivedInstant('2026-11-06T03:00:00.000Z')).toBe('2026-11-06T03:00:00.000Z');
  });
});

describe('POST /api/admin/field-hides', () => {
  it('writes the hide, the audit row and the notice in one batch, then purges and syncs', async () => {
    const res = await hide({
      entityType: 'vendor',
      entityId: VENDOR_A,
      field: 'phone_number',
      internalNote: NOTE,
    });
    expect(res.status).toBe(201);
    expect(() => AdminFieldHideResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body.hide).toMatchObject({
      entity_type: 'vendor',
      entity_id: VENDOR_A,
      entity_name: 'Autodesk',
      field: 'phone_number',
      reason: REASON,
      internal_note: NOTE,
      source_url: SOURCE_URL,
      received_at: RECEIVED,
      vendor_id: VENDOR_A,
      set_by: ADMIN.userId,
      cleared_at: null,
      clear_kind: null,
      hide_due: '2026-11-11T05:00:00.000Z',
      decide_due: '2026-11-17T05:00:00.000Z',
      last_status_reply: null,
    });

    // The value itself is untouched: the hide is a mask, not an edit.
    const vendor = await t.db.query.vendors.findFirst({ where: eq(vendors.id, VENDOR_A) });
    expect(vendor!.phoneNumber).toBe('+1 555 0000');

    const [audit] = await auditsFor('vendor.field_hidden');
    expect(audit).toMatchObject({
      actorId: ADMIN.userId,
      entityType: 'vendor',
      entityId: VENDOR_A,
      vendorId: VENDOR_A,
    });
    expect(audit!.metadata).toMatchObject({
      source: 'admin-moderation',
      field: 'phone_number',
      fieldHideId: res.body.hide.id,
      sourceUrl: SOURCE_URL,
      receivedAt: RECEIVED,
      hideDue: '2026-11-11T05:00:00.000Z',
      decideDue: '2026-11-17T05:00:00.000Z',
      reason: REASON,
      reasonVisibility: 'vendor',
      internalNote: NOTE,
    });

    const [notice] = await auditsFor(NOTIFICATION_SENT_ACTION);
    expect(notice).toMatchObject({ vendorId: VENDOR_A });
    expect(notice!.metadata).toMatchObject({
      kind: 'aeci_override',
      notificationId: 'portal-field-hidden-by-aeci',
      event: 'field_hidden',
      field: 'phone_number',
      fieldHideId: res.body.hide.id,
      reason: REASON,
      recordSubject: { type: 'vendor', slug: 'autodesk', name: 'Autodesk' },
    });
    // The internal note never reaches the vendor's row.
    expect(JSON.stringify(notice!.metadata)).not.toContain(NOTE);

    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'moderation', tags: ['vendor:autodesk'] }),
    );
    expect(syncSpy).toHaveBeenCalledWith({ products: [], vendors: [VENDOR_A], integrations: [] });
  });

  it('hides a product description, stamping the product', async () => {
    const res = await hide({ entityType: 'product', entityId: P_REVIT, field: 'description' });
    expect(res.status).toBe(201);
    const [audit] = await auditsFor('product.field_hidden');
    expect(audit).toMatchObject({ vendorId: VENDOR_A, productId: P_REVIT });
    expect(purgedTags(res.send)).toEqual(
      expect.arrayContaining(['product:revit', 'index:products']),
    );
    expect(syncSpy).toHaveBeenCalledWith({ products: [P_REVIT], vendors: [], integrations: [] });
  });

  it('hides an integration field and a pair field, naming the row on the notice', async () => {
    const edge = await hide({ entityType: 'integration', entityId: I_MAIN, field: 'docs_url' });
    expect(edge.status).toBe(201);
    const pair = await hide({
      entityType: 'connector_evidenced_pair',
      entityId: PAIR,
      field: 'description',
    });
    expect(pair.status).toBe(201);
    expect((await auditsFor('integration.field_hidden')).map((r) => r.entityType).sort()).toEqual([
      'connector_evidenced_pair',
      'integration',
    ]);
    const notices = await auditsFor(NOTIFICATION_SENT_ACTION);
    expect(notices.map((n) => n.metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'field_hidden',
          integrationId: I_MAIN,
          integrationName: 'Revit for MicroStation',
          pairSlugs: ['microstation', 'revit'],
        }),
      ]),
    );
    expect(purgedTags(edge.send)).toEqual(
      expect.arrayContaining(['product:revit', 'product:microstation']),
    );
    expect(purgedTags(pair.send)).toEqual(expect.arrayContaining(['product:agave']));
  });

  it('refuses a record no vendor holds, writing nothing', async () => {
    const res = await hide({ entityType: 'vendor', entityId: VENDOR_C, field: 'phone_number' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FIELD_HIDE_NOT_VENDOR_HELD');
    const product = await hide({ entityType: 'product', entityId: P_ORPHAN, field: 'website' });
    expect(product.body.error.code).toBe('FIELD_HIDE_NOT_VENDOR_HELD');
    expect(await activeHides()).toEqual([]);
    expect(await t.db.select().from(auditLog)).toEqual([]);
  });

  it('refuses a second hide of the same field', async () => {
    await hide({ entityType: 'vendor', entityId: VENDOR_A, field: 'phone_number' });
    const res = await hide({ entityType: 'vendor', entityId: VENDOR_A, field: 'phone_number' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FIELD_HIDE_ACTIVE');
    expect(await activeHides()).toHaveLength(1);
  });

  it('answers FIELD_HIDE_ACTIVE when a racing hide wins after the pre-read', async () => {
    await hide({ entityType: 'vendor', entityId: VENDOR_A, field: 'phone_number' });
    // The pre-read misses the first hide, so the partial unique index has to catch it.
    const spy = vi
      .spyOn(t.db.query.fieldHides, 'findFirst')
      .mockResolvedValueOnce(undefined as never);
    const res = await hide({ entityType: 'vendor', entityId: VENDOR_A, field: 'phone_number' });
    // The handler read through the stubbed pre-read, so the index made the refusal.
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FIELD_HIDE_ACTIVE');
    expect(await activeHides()).toHaveLength(1);
    // The loser's audit row and notice rolled back with its hide row.
    expect(await auditsFor('vendor.field_hidden')).toHaveLength(1);
    expect(await auditsFor(NOTIFICATION_SENT_ACTION)).toHaveLength(1);
  });

  it.each([
    ['a product facet', 'product', P_REVIT, 'category_slugs'],
    ['a required integration field', 'integration', I_MAIN, 'name'],
    ['the integration direction', 'integration', I_MAIN, 'direction'],
    ['a field off every list', 'vendor', VENDOR_A, 'company_name'],
  ])('refuses %s with a 400 naming field', async (_label, entityType, entityId, field) => {
    const res = await hide({ entityType, entityId, field });
    expect(res.status).toBe(400);
    expect(await activeHides()).toEqual([]);
  });

  it.each([
    ['no source', { sourceUrl: undefined }],
    ['an http source', { sourceUrl: 'http://example.com/a' }],
    ['no received date', { receivedAt: undefined }],
    ['a received date in the future', { receivedAt: '2099-01-01' }],
    ['no reason', { reason: '' }],
  ])('refuses a hide with %s', async (_label, patch) => {
    const res = await hide({
      entityType: 'vendor',
      entityId: VENDOR_A,
      field: 'phone_number',
      ...patch,
    });
    expect(res.status).toBe(400);
    expect(await activeHides()).toEqual([]);
  });

  it('answers 404 for an unknown record', async () => {
    const res = await hide({ entityType: 'product', entityId: uuid(999), field: 'website' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/admin/field-hides/:id/restore', () => {
  it('clears the hide with the audit row and notice, and purges and syncs again', async () => {
    const set = await hide({ entityType: 'vendor', entityId: VENDOR_A, field: 'phone_number' });
    syncSpy.mockReset();
    const res = await restore(set.body.hide.id);
    expect(res.status).toBe(200);
    expect(() => AdminFieldHideResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body.hide).toMatchObject({
      cleared_by: ADMIN.userId,
      clear_kind: 'restored',
      clear_reason: 'The registry was out of date. The value stands.',
    });
    expect(res.body.hide.cleared_at).not.toBeNull();
    expect(await activeHides()).toEqual([]);

    const [audit] = await auditsFor('vendor.field_hide_cleared');
    expect(audit).toMatchObject({ vendorId: VENDOR_A, actorId: ADMIN.userId });
    expect(audit!.metadata).toMatchObject({
      clearKind: 'restored',
      fieldHideId: set.body.hide.id,
      reasonVisibility: 'vendor',
    });
    const notices = await auditsFor(NOTIFICATION_SENT_ACTION);
    expect(notices.map((n) => (n.metadata as { event: string }).event).sort()).toEqual([
      'field_hidden',
      'field_hide_cleared',
    ]);
    expect(
      notices.find((n) => (n.metadata as { event: string }).event === 'field_hide_cleared')!
        .metadata,
    ).toMatchObject({ hideClearKind: 'restored' });

    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'moderation', tags: ['vendor:autodesk'] }),
    );
    expect(syncSpy).toHaveBeenCalledWith({ products: [], vendors: [VENDOR_A], integrations: [] });
  });

  it('refuses a second restore with FIELD_HIDE_CLEARED, writing nothing more', async () => {
    const set = await hide({ entityType: 'vendor', entityId: VENDOR_A, field: 'phone_number' });
    await restore(set.body.hide.id);
    const again = await restore(set.body.hide.id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('FIELD_HIDE_CLEARED');
    expect(await auditsFor('vendor.field_hide_cleared')).toHaveLength(1);
  });

  it('answers FIELD_HIDE_CLEARED when a racing clear wins after the pre-read', async () => {
    const set = await hide({ entityType: 'vendor', entityId: VENDOR_A, field: 'phone_number' });
    const row = (await activeHides())[0]!;
    const spy = vi.spyOn(t.db.query.fieldHides, 'findFirst').mockResolvedValueOnce(row as never);
    await t.db
      .update(fieldHides)
      .set({ clearedAt: '2026-11-08T00:00:00.000Z', clearKind: 'vendor_edit' })
      .where(eq(fieldHides.id, set.body.hide.id));
    const res = await restore(set.body.hide.id);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FIELD_HIDE_CLEARED');
    // The sentinel rolled the whole batch back: no clear row, no notice.
    expect(await auditsFor('vendor.field_hide_cleared')).toEqual([]);
    const stored = await t.db.query.fieldHides.findFirst({
      where: eq(fieldHides.id, set.body.hide.id),
    });
    expect(stored!.clearKind).toBe('vendor_edit');
  });

  it('answers 404 for an unknown hide', async () => {
    expect((await restore(uuid(998))).status).toBe(404);
  });
});

describe('POST /api/admin/field-hides/:id/status-reply', () => {
  it('writes one internal audit row and nothing else', async () => {
    const set = await hide({ entityType: 'product', entityId: P_REVIT, field: 'website' });
    const before = (await auditsFor(NOTIFICATION_SENT_ACTION)).length;
    const res = await statusReply(set.body.hide.id);
    expect(res.status).toBe(200);
    expect(res.body.hide.last_status_reply).toMatchObject({
      note: 'Told the requester we are still checking.',
      by: ADMIN.userId,
    });
    const [audit] = await auditsFor('product.field_hide_status_reply');
    expect(audit).toMatchObject({ vendorId: VENDOR_A, productId: P_REVIT });
    expect(audit!.metadata).toMatchObject({
      fieldHideId: set.body.hide.id,
      note: 'Told the requester we are still checking.',
    });
    // Internal: no vendor-visible reason, no notice, no purge, the hide stands.
    expect(audit!.metadata).not.toHaveProperty('reasonVisibility');
    expect(await auditsFor(NOTIFICATION_SENT_ACTION)).toHaveLength(before);
    expect(res.send).not.toHaveBeenCalled();
    expect(await activeHides()).toHaveLength(1);
  });

  it('refuses a reply on a cleared hide', async () => {
    const set = await hide({ entityType: 'product', entityId: P_REVIT, field: 'website' });
    await restore(set.body.hide.id);
    const res = await statusReply(set.body.hide.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FIELD_HIDE_CLEARED');
    expect(await auditsFor('product.field_hide_status_reply')).toEqual([]);
  });
});

describe('an AECi correction ends the hide (clear_kind corrected)', () => {
  it('clears the hide in the correction batch, with its row and notice', async () => {
    const set = await hide({ entityType: 'vendor', entityId: VENDOR_A, field: 'phone_number' });
    const res = await call(ADMIN, '/api/admin/field-overrides', 'POST', {
      entityType: 'vendor',
      entityId: VENDOR_A,
      field: 'phone_number',
      value: '+1 555 0100',
      reason: 'The registry number is the right one.',
      sourceUrl: SOURCE_URL,
    });
    expect(res.status).toBe(201);
    expect(await activeHides()).toEqual([]);
    const stored = await t.db.query.fieldHides.findFirst({
      where: eq(fieldHides.id, set.body.hide.id),
    });
    expect(stored).toMatchObject({
      clearKind: 'corrected',
      clearedBy: ADMIN.userId,
      clearReason: 'The registry number is the right one.',
    });
    const [audit] = await auditsFor('vendor.field_hide_cleared');
    expect(audit!.metadata).toMatchObject({
      clearKind: 'corrected',
      fieldHideId: set.body.hide.id,
      overrideId: res.body.override.id,
    });
    const cleared = (await auditsFor(NOTIFICATION_SENT_ACTION)).filter(
      (n) => (n.metadata as { event: string }).event === 'field_hide_cleared',
    );
    expect(cleared).toHaveLength(1);
    expect(cleared[0]!.metadata).toMatchObject({ hideClearKind: 'corrected', vendorId: VENDOR_A });
  });

  it('leaves a hide on another field alone', async () => {
    await hide({ entityType: 'vendor', entityId: VENDOR_A, field: 'description' });
    await call(ADMIN, '/api/admin/field-overrides', 'POST', {
      entityType: 'vendor',
      entityId: VENDOR_A,
      field: 'phone_number',
      value: '+1 555 0100',
      reason: REASON,
      sourceUrl: SOURCE_URL,
    });
    expect((await activeHides()).map((h) => h.field)).toEqual(['description']);
    expect(await auditsFor('vendor.field_hide_cleared')).toEqual([]);
  });
});

describe('GET /api/admin/vendors/:id/field-hides', () => {
  it('lists the active hides on the vendor, its products and its rows, with dues', async () => {
    await hide({ entityType: 'vendor', entityId: VENDOR_B, field: 'website' });
    const edge = await hide({ entityType: 'integration', entityId: I_MAIN, field: 'docs_url' });
    const pair = await hide({
      entityType: 'connector_evidenced_pair',
      entityId: PAIR,
      field: 'listing_url',
    });
    const product = await hide({ entityType: 'product', entityId: P_MICRO, field: 'website' });
    // Another vendor's hide, and a cleared one, are not listed.
    await hide({ entityType: 'vendor', entityId: VENDOR_A, field: 'website' });
    await restore(product.body.hide.id);
    await statusReply(edge.body.hide.id, 'Still checking with the requester.');

    const res = await call(ADMIN, `/api/admin/vendors/${VENDOR_B}/field-hides`, 'GET');
    expect(res.status).toBe(200);
    expect(() => AdminFieldHidesResponseSchema.parse(res.body)).not.toThrow();
    const hides = res.body.hides as JsonBody[];
    expect(hides.map((h) => `${h.entity_type}:${h.field}`).sort()).toEqual([
      'connector_evidenced_pair:listing_url',
      'integration:docs_url',
      'vendor:website',
    ]);
    for (const h of hides) {
      expect(h.hide_due).toBe('2026-11-11T05:00:00.000Z');
      expect(h.decide_due).toBe('2026-11-17T05:00:00.000Z');
    }
    expect(hides.find((h) => h.id === edge.body.hide.id)!.last_status_reply).toMatchObject({
      note: 'Still checking with the requester.',
    });
    expect(hides.find((h) => h.id === pair.body.hide.id)!.last_status_reply).toBeNull();
    expect(hides.find((h) => h.entity_type === 'integration')!.entity_name).toBe(
      'Revit for MicroStation',
    );
  });

  it('answers 404 for an unknown vendor', async () => {
    expect((await call(ADMIN, `/api/admin/vendors/${uuid(997)}/field-hides`, 'GET')).status).toBe(
      404,
    );
  });
});

describe('the vendor feed shows the hide and its end', () => {
  it('maps field_hidden and field_hide_cleared rows, never the note', async () => {
    const set = await hide({
      entityType: 'vendor',
      entityId: VENDOR_A,
      field: 'phone_number',
      internalNote: NOTE,
    });
    await restore(set.body.hide.id);
    const res = await call(AUTH_A, '/api/vendor/notifications', 'GET');
    expect(res.status).toBe(200);
    const parsed = ListVendorNotificationsResponseSchema.parse(res.body);
    const rows = parsed.notifications.filter((n) => n.kind === 'aeci_override');
    expect(rows.map((n) => ('event' in n ? n.event : null)).sort()).toEqual([
      'field_hidden',
      'field_hide_cleared',
    ]);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'field_hidden',
          field: 'phone_number',
          reason: REASON,
          record_subject: { type: 'vendor', slug: 'autodesk', name: 'Autodesk' },
          hide_clear_kind: null,
        }),
        expect.objectContaining({ event: 'field_hide_cleared', hide_clear_kind: 'restored' }),
      ]),
    );
    expect(JSON.stringify(res.body)).not.toContain(NOTE);
    expect(JSON.stringify(res.body)).not.toContain(SOURCE_URL);
  });
});

describe('field_hide_decision_overdue (data quality)', () => {
  const LATE = new Date('2026-11-17T05:00:00.000Z');
  const EARLY = new Date('2026-11-17T04:59:59.999Z');

  it('is registered as a warning', () => {
    expect(CHECKS.find((c) => c.id === 'field_hide_decision_overdue')?.severity).toBe('warn');
  });

  it('fires on an active hide past decide_due with no status reply, and only then', async () => {
    const set = await hide({ entityType: 'vendor', entityId: VENDOR_A, field: 'phone_number' });
    expect(await checkFieldHideDecisionOverdue(t.db, EARLY)).toEqual({ lines: [] });
    const finding = await checkFieldHideDecisionOverdue(t.db, LATE);
    expect(finding.lines).toEqual([
      `vendor ${VENDOR_A} field phone_number: decision was due 2026-11-17T05:00:00.000Z`,
    ]);
    // A status reply answers it.
    await statusReply(set.body.hide.id);
    expect(await checkFieldHideDecisionOverdue(t.db, LATE)).toEqual({ lines: [] });
  });

  it('ignores a cleared hide', async () => {
    const set = await hide({ entityType: 'vendor', entityId: VENDOR_A, field: 'phone_number' });
    await restore(set.body.hide.id);
    expect(await checkFieldHideDecisionOverdue(t.db, LATE)).toEqual({ lines: [] });
  });

  it('is clean on a database with no hides', async () => {
    expect(await checkFieldHideDecisionOverdue(t.db, LATE)).toEqual({ lines: [] });
  });
});
