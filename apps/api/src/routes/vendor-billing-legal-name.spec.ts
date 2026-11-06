/**
 * `PUT /api/vendor/billing/legal-name` and `PUT /api/admin/vendors/:id/billing/legal-name`
 * (AECI-1625) over the in-memory D1. The guard cells are in `vendor.authz-matrix.spec.ts`
 * and the two `*.registration.spec.ts` files. This file covers what the handlers decide:
 * owner seats only, the stored value, the audit row in the same batch, and the no-op on an
 * unchanged name.
 */

import { UpdateVendorLegalNameResponseSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { createAdminUpdateVendorLegalNameHandler } from './admin-vendors-billing';
import { createUpdateVendorLegalNameHandler } from './vendor-billing-legal-name';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VENDOR = uuid(1);
const OTHER_VENDOR = uuid(2);
const OWNER = uuid(100);
const MEMBER = uuid(101);
const ADMIN = uuid(200);

const seat = (userId = OWNER): AuthzVariables['auth'] => ({
  userId,
  email: 'owner@acme.com',
  role: 'vendor_admin',
  vendorId: VENDOR,
  entitlementTier: 'unclaimed',
  entitlement: null,
});
const admin: AuthzVariables['auth'] = {
  userId: ADMIN,
  email: 'ops@aecintegrations.com',
  role: 'admin',
  vendorId: null,
  entitlementTier: 'unclaimed',
  entitlement: null,
};

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR, slug: 'acme', companyName: 'Acme' },
    { id: OTHER_VENDOR, slug: 'globex', companyName: 'Globex' },
  ]);
  await t.db.insert(profiles).values([
    { id: OWNER, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true },
    { id: MEMBER, role: 'vendor_admin', vendorId: VENDOR, seatOwner: false },
    { id: ADMIN, role: 'admin' },
  ]);
});
afterEach(() => t.dispose());

async function call(
  who: 'vendor' | 'admin',
  auth: AuthzVariables['auth'],
  body: unknown,
  vendorId = VENDOR,
) {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  app.put('/api/vendor/billing/legal-name', createUpdateVendorLegalNameHandler(t.factory));
  app.put(
    '/api/admin/vendors/:id/billing/legal-name',
    createAdminUpdateVendorLegalNameHandler(t.factory),
  );
  const path =
    who === 'vendor'
      ? '/api/vendor/billing/legal-name'
      : `/api/admin/vendors/${vendorId}/billing/legal-name`;
  const res = await app.fetch(
    new Request(`http://x${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    TEST_ENV,
    fakeExecutionContext(),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json()) as any };
}

const stored = async (id = VENDOR) =>
  (await t.db.select().from(vendors).where(eq(vendors.id, id)))[0]!.legalName;

describe('PUT /api/vendor/billing/legal-name', () => {
  it('stores the name trimmed, with one audit row in the same batch', async () => {
    const { status, body } = await call('vendor', seat(), { legal_name: '  Acme   Corp, Inc. ' });

    expect(status).toBe(200);
    expect(UpdateVendorLegalNameResponseSchema.parse(body)).toEqual({
      legal_name: 'Acme Corp, Inc.',
    });
    expect(await stored()).toBe('Acme Corp, Inc.');

    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'vendor.legal_name_changed',
      entityType: 'vendor',
      entityId: VENDOR,
      actorId: OWNER,
      actorType: 'user',
      vendorId: VENDOR,
    });
    expect(audits[0]!.beforeState).toEqual({ legal_name: null });
    expect(audits[0]!.afterState).toEqual({ legal_name: 'Acme Corp, Inc.' });
    expect(audits[0]!.metadata).toMatchObject({ source: 'vendor-portal' });
  });

  it('clears the name on null and on blank', async () => {
    for (const value of [null, '   ']) {
      await t.db.update(vendors).set({ legalName: 'Acme, Inc.' }).where(eq(vendors.id, VENDOR));
      const { status, body } = await call('vendor', seat(), { legal_name: value });
      expect(status).toBe(200);
      expect(body).toEqual({ legal_name: null });
      expect(await stored()).toBeNull();
    }
  });

  it('writes nothing for an unchanged name', async () => {
    await t.db.update(vendors).set({ legalName: 'Acme, Inc.' }).where(eq(vendors.id, VENDOR));
    const { status } = await call('vendor', seat(), { legal_name: 'Acme, Inc.' });
    expect(status).toBe(200);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('refuses a member seat with 403 and writes nothing', async () => {
    const { status } = await call('vendor', seat(MEMBER), { legal_name: 'Acme, Inc.' });
    expect(status).toBe(403);
    expect(await stored()).toBeNull();
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it.each([
    ['a missing field', {}],
    ['an unknown key', { legal_name: 'Acme, Inc.', vendor_id: OTHER_VENDOR }],
    ['a number', { legal_name: 42 }],
    ['a name over 200 characters', { legal_name: 'x'.repeat(201) }],
  ])('refuses %s with 400', async (_label, body) => {
    const { status } = await call('vendor', seat(), body);
    expect(status).toBe(400);
    expect(await stored()).toBeNull();
    expect(await stored(OTHER_VENDOR)).toBeNull();
  });
});

describe('PUT /api/admin/vendors/:id/billing/legal-name', () => {
  it('sets the named vendor with an admin audit row', async () => {
    const { status, body } = await call('admin', admin, { legal_name: 'Globex LLC' }, OTHER_VENDOR);
    expect(status).toBe(200);
    expect(body).toEqual({ legal_name: 'Globex LLC' });
    expect(await stored(OTHER_VENDOR)).toBe('Globex LLC');
    expect(await stored()).toBeNull();

    const [audit] = await t.db.select().from(auditLog);
    expect(audit).toMatchObject({
      action: 'vendor.legal_name_changed',
      entityId: OTHER_VENDOR,
      actorId: ADMIN,
      actorType: 'admin',
      vendorId: OTHER_VENDOR,
    });
    expect(audit!.metadata).toMatchObject({ source: 'admin-vendors-billing' });
  });

  it('corrects a name a claim filled', async () => {
    await t.db.update(vendors).set({ legalName: 'Acme Inc' }).where(eq(vendors.id, VENDOR));
    const { status } = await call('admin', admin, { legal_name: 'Acme, Inc.' });
    expect(status).toBe(200);
    expect(await stored()).toBe('Acme, Inc.');
    const [audit] = await t.db.select().from(auditLog);
    expect(audit!.beforeState).toEqual({ legal_name: 'Acme Inc' });
  });

  it('answers 404 for an unknown vendor', async () => {
    const { status } = await call('admin', admin, { legal_name: 'Nobody LLC' }, uuid(999));
    expect(status).toBe(404);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });
});
