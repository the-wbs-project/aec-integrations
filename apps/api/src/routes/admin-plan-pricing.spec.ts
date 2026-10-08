/**
 * `PUT /api/admin/vendors/:id/plan-pricing`: the display-only plan price overrides
 * (ruling 2026-10-08, `docs/STAGE_2_PAID_TIERS_SPEC.md` §13.13), against the
 * in-memory D1 harness.
 *
 * Authorization runs against the REAL `requireAdmin()` guard in the last describe,
 * including a `vendor_admin` seat on the vendor being priced: a vendor must never
 * set its own price.
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, profiles, vendorEntitlements, vendorPlanPricing, vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { requireAdmin, type AuthzVariables } from '../lib/authz';
import { loadPlanPrice } from '../lib/vendor-plan-pricing';
import { makeTestJwks, type TestJwks } from '../test/auth';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createSetVendorPlanPricingHandler } from './admin-plan-pricing';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = u(900);
const VENDOR = u(1);
const SEAT = u(500);
const OLD_TS = '2020-01-01T00:00:00.000Z';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(profiles).values({ id: ADMIN, role: 'admin' });
});
afterEach(() => t.dispose());

const seedVendor = () =>
  t.db.insert(vendors).values({
    id: VENDOR,
    slug: 'autodesk',
    companyName: 'Autodesk, Inc.',
    verified: false,
    updatedAt: OLD_TS,
  });

const seedPricing = (over: Partial<typeof vendorPlanPricing.$inferInsert> = {}) =>
  t.db.insert(vendorPlanPricing).values({
    vendorId: VENDOR,
    managedPriceCents: 1250,
    priceMessage: null,
    updatedBy: ADMIN,
    createdAt: OLD_TS,
    updatedAt: OLD_TS,
    ...over,
  });

const readRows = () => t.db.select().from(vendorPlanPricing);
const readAudit = () => t.db.select().from(auditLog);

function app() {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', {
      userId: ADMIN,
      email: undefined,
      role: 'admin',
      vendorId: null,
      entitlementTier: 'unclaimed',
      entitlement: null,
    });
    await next();
  });
  a.put('/api/admin/vendors/:id/plan-pricing', createSetVendorPlanPricingHandler(t.factory));
  return a;
}

const put = (id: string, body: unknown, raw = false) =>
  app().request(
    `/api/admin/vendors/${id}/plan-pricing`,
    {
      method: 'PUT',
      body: raw ? (body as string) : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    },
    TEST_ENV,
    fakeExecutionContext(),
  );

describe('PUT …/plan-pricing: set', () => {
  it('inserts the override and its audit row in one batch', async () => {
    await seedVendor();
    const res = await put(VENDOR, { managed_price_cents: 1250, message: null });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      vendor_id: VENDOR,
      managed_price_cents: 1250,
      message: null,
      updated_by: ADMIN,
    });
    expect(typeof body.updated_at).toBe('string');

    const [row] = await readRows();
    expect(row).toMatchObject({ vendorId: VENDOR, managedPriceCents: 1250, updatedBy: ADMIN });

    const audits = await readAudit();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'vendor_plan_pricing.set',
      entityType: 'vendor_plan_pricing',
      entityId: VENDOR,
      vendorId: VENDOR,
      actorId: ADMIN,
      actorType: 'admin',
      vendorTier: 'none',
      vendorEntitlementStatus: 'none',
    });
    expect(audits[0]!.beforeState).toBeNull();
    expect(audits[0]!.afterState).toEqual({ managed_price_cents: 1250, message: null });
  });

  it('updates an existing override in place and records before and after', async () => {
    await seedVendor();
    await seedPricing();
    const res = await put(VENDOR, { managed_price_cents: 1250, message: '  Free until Dec 12 ' });
    expect(res.status).toBe(200);
    const rows = await readRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ managedPriceCents: 1250, priceMessage: 'Free until Dec 12' });
    expect(rows[0]!.createdAt).toBe(OLD_TS);
    expect(rows[0]!.updatedAt).not.toBe(OLD_TS);

    const [audit] = await readAudit();
    expect(audit!.beforeState).toEqual({ managed_price_cents: 1250, message: null });
    expect(audit!.afterState).toEqual({ managed_price_cents: 1250, message: 'Free until Dec 12' });
  });

  it('works for a vendor with no entitlement row, and leaves the entitlement alone', async () => {
    await seedVendor();
    await put(VENDOR, { managed_price_cents: 900, message: null });
    expect(await t.db.select().from(vendorEntitlements)).toHaveLength(0);
    const [v] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR));
    expect(v!.verified).toBe(false);
    expect(v!.updatedAt).toBe(OLD_TS);
  });

  it('snapshots the vendor plan on the audit row', async () => {
    await seedVendor();
    await t.db.insert(vendorEntitlements).values({
      vendorId: VENDOR,
      tier: 'verified',
      status: 'active',
      grantedAt: OLD_TS,
    });
    await put(VENDOR, { managed_price_cents: 900, message: null });
    const [audit] = await readAudit();
    expect(audit).toMatchObject({ vendorTier: 'verified', vendorEntitlementStatus: 'active' });
  });

  it('writes nothing for an unchanged override', async () => {
    await seedVendor();
    await seedPricing();
    const res = await put(VENDOR, { managed_price_cents: 1250, message: null });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).updated_at).toBe(OLD_TS);
    expect(await readAudit()).toHaveLength(0);
  });

  it('is what the vendor block reads', async () => {
    await seedVendor();
    await put(VENDOR, { managed_price_cents: null, message: 'Free until December 12' });
    expect(await loadPlanPrice(t.db, VENDOR)).toEqual({
      managed_price_cents: null,
      message: 'Free until December 12',
    });
  });
});

describe('PUT …/plan-pricing: reset to default', () => {
  it('deletes the row and writes a cleared audit row', async () => {
    await seedVendor();
    await seedPricing({ priceMessage: 'Half price' });
    const res = await put(VENDOR, { managed_price_cents: null, message: '' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      vendor_id: VENDOR,
      managed_price_cents: null,
      message: null,
      updated_by: null,
      updated_at: null,
    });
    expect(await readRows()).toHaveLength(0);
    const [audit] = await readAudit();
    expect(audit).toMatchObject({ action: 'vendor_plan_pricing.cleared', entityId: VENDOR });
    expect(audit!.beforeState).toEqual({ managed_price_cents: 1250, message: 'Half price' });
    expect(audit!.afterState).toBeNull();
    expect(await loadPlanPrice(t.db, VENDOR)).toEqual({ managed_price_cents: null, message: null });
  });

  it('is a no-op with no row: 200, nothing written', async () => {
    await seedVendor();
    const res = await put(VENDOR, { managed_price_cents: null, message: null });
    expect(res.status).toBe(200);
    expect(await readRows()).toHaveLength(0);
    expect(await readAudit()).toHaveLength(0);
  });
});

describe('PUT …/plan-pricing: validation', () => {
  beforeEach(seedVendor);

  it.each([
    ['a negative price', { managed_price_cents: -1, message: null }],
    ['a fractional price', { managed_price_cents: 12.5, message: null }],
    ['a price over the cap', { managed_price_cents: 10_000_001, message: null }],
    ['a price as a string', { managed_price_cents: '1250', message: null }],
    ['a message over 280 characters', { managed_price_cents: null, message: 'x'.repeat(281) }],
    ['markup in the message', { managed_price_cents: null, message: '<b>Free</b>' }],
    ['a missing key', { managed_price_cents: 1250 }],
  ])('400s %s and writes nothing', async (_label, body) => {
    const res = await put(VENDOR, body);
    expect(res.status).toBe(400);
    expect(await readRows()).toHaveLength(0);
    expect(await readAudit()).toHaveLength(0);
  });

  it('400s a body that is not JSON', async () => {
    const res = await put(VENDOR, '{not json', true);
    expect(res.status).toBe(400);
  });

  it('404s an unknown vendor', async () => {
    const res = await put(u(77), { managed_price_cents: 1250, message: null });
    expect(res.status).toBe(404);
    expect(await readRows()).toHaveLength(0);
  });
});

describe('authorization', () => {
  const SUPABASE_URL = 'https://test-project.supabase.co';
  const AUTHZ_ENV = { ENV: 'preview', SUPABASE_URL } as Env;

  let jwks: TestJwks;
  beforeAll(async () => {
    jwks = await makeTestJwks();
  });

  function guardedApp() {
    const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    a.onError(errorHandler());
    a.put(
      '/api/admin/vendors/:id/plan-pricing',
      requireAdmin({ getKey: jwks.getKey, dbFor: t.factory }),
      createSetVendorPlanPricingHandler(t.factory),
    );
    return a;
  }

  const call = (token?: string) =>
    guardedApp().request(
      `/api/admin/vendors/${VENDOR}/plan-pricing`,
      {
        method: 'PUT',
        body: JSON.stringify({ managed_price_cents: 100, message: null }),
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      AUTHZ_ENV,
      fakeExecutionContext(),
    );

  beforeEach(seedVendor);

  it('401s with no token', async () => {
    expect((await call()).status).toBe(401);
    expect(await readRows()).toHaveLength(0);
  });

  it('403s a plain reviewer', async () => {
    await t.db.insert(profiles).values({ id: u(910), role: 'reviewer' });
    const token = await jwks.mintToken({ sub: u(910), supabaseUrl: SUPABASE_URL });
    expect((await call(token)).status).toBe(403);
    expect(await readRows()).toHaveLength(0);
  });

  it('403s a vendor_admin on the very vendor being priced', async () => {
    await t.db.insert(profiles).values({ id: SEAT, role: 'vendor_admin', vendorId: VENDOR });
    const token = await jwks.mintToken({ sub: SEAT, supabaseUrl: SUPABASE_URL });
    expect((await call(token)).status).toBe(403);
    expect(await readRows()).toHaveLength(0);
  });

  it('200s an admin', async () => {
    const token = await jwks.mintToken({ sub: ADMIN, supabaseUrl: SUPABASE_URL });
    expect((await call(token)).status).toBe(200);
    expect(await readRows()).toHaveLength(1);
  });
});
