/**
 * Pending removals and the hold (AECI-1618, `ADMIN_PANEL_SPEC.md` §5.7), against the
 * real-SQLite harness.
 */

import { ApiErrorCode, ListBrandAssetRemovalsResponseSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../posthog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../posthog')>()),
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
}));

import { auditLog, products, productVendors, profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import {
  createLiftBrandAssetHoldHandler,
  createListBrandAssetRemovalsHandler,
  createSetBrandAssetHoldHandler,
} from './admin-brand-assets';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VENDOR = u(1);
const CLAIMED = u(2);
const ADMIN = u(100);
const ENDED = '2026-11-01T10:00:00.000Z';

let t: TestDb;

function app() {
  const hono = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  hono.onError(errorHandler());
  hono.use('*', async (c, next) => {
    c.set('auth', { userId: ADMIN, email: 'a@aeci.example', role: 'admin' } as never);
    await next();
  });
  hono.get('/list', createListBrandAssetRemovalsHandler(t.factory));
  hono.post('/hold/:id', createSetBrandAssetHoldHandler(t.factory));
  hono.delete('/hold/:id', createLiftBrandAssetHoldHandler(t.factory));
  return hono;
}

const call = (path: string, method = 'GET', body?: unknown) =>
  app().request(
    path,
    {
      method,
      ...(body
        ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
        : {}),
    },
    { ENV: 'staging' } as unknown as Env,
    fakeExecutionContext(),
  );
const code = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code;
const row = async () => (await t.db.select().from(vendors).where(eq(vendors.id, VENDOR)))[0]!;

beforeEach(async () => {
  t = await makeTestDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-02T12:00:00.000Z'));
  await t.db.insert(profiles).values({ id: ADMIN, role: 'admin' });
  await t.db.insert(vendors).values([
    {
      id: VENDOR,
      slug: 'acme',
      companyName: 'Acme',
      ownedAt: '2026-01-01T00:00:00.000Z',
      claimEndedAt: ENDED,
      logoUrl: 'https://vendor.example/a.png',
      logoSource: 'vendor',
      updatedAt: '2026-11-01T10:00:00.000Z',
    },
    { id: CLAIMED, slug: 'other', companyName: 'Other', ownedAt: '2026-01-01T00:00:00.000Z' },
  ]);
  await t.db.insert(products).values([
    {
      id: u(11),
      slug: 'mine',
      name: 'Mine',
      logoUrl: 'https://vendor.example/m.png',
      logoSource: 'vendor',
    },
    {
      id: u(12),
      slug: 'shared',
      name: 'Shared',
      logoUrl: 'https://vendor.example/s.png',
      logoSource: 'vendor',
    },
  ]);
  await t.db.insert(productVendors).values([
    { productId: u(11), vendorId: VENDOR, isPrimary: true },
    { productId: u(12), vendorId: VENDOR, isPrimary: true },
    { productId: u(12), vendorId: CLAIMED, isPrimary: false },
  ]);
  await t.db.insert(auditLog).values({
    id: u(200),
    actorType: 'admin',
    action: 'vendor.claim_ended',
    entityType: 'vendor',
    entityId: VENDOR,
    metadata: { cause: 'last-seat-revoked' },
  });
});

afterEach(() => {
  vi.useRealTimers();
  t.dispose();
});

describe('GET /api/admin/brand-asset-removals', () => {
  it('lists a pending company with its cause, rows and dates', async () => {
    const body = ListBrandAssetRemovalsResponseSchema.parse(await (await call('/list')).json());
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      vendor_id: VENDOR,
      vendor_slug: 'acme',
      claim_ended_at: ENDED,
      cause: 'last-seat-revoked',
      hold_at: null,
      limit_at: '2026-11-15T10:00:00.000Z',
      next_run_at: '2026-11-02T16:00:00.000Z',
      skipped_product_ids: [u(12)],
    });
    expect(body.data[0]!.affected_rows.map((r) => r.slug)).toEqual(['acme', 'mine']);
  });

  it('drops a company once it is stamped', async () => {
    await t.db
      .update(vendors)
      .set({ brandAssetsRemovedAt: '2026-11-02T00:00:00.000Z' })
      .where(eq(vendors.id, VENDOR));
    expect(await (await call('/list')).json()).toEqual({ data: [] });
  });
});

describe('the hold', () => {
  it('sets with its audit row, and leaves updated_at alone', async () => {
    const res = await call(`/hold/${VENDOR}`, 'POST', { reason: 'Vendor asked for a week' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ vendor_id: VENDOR, hold_at: '2026-11-02T12:00:00.000Z' });
    expect(await row()).toMatchObject({
      brandAssetsHoldAt: '2026-11-02T12:00:00.000Z',
      updatedAt: '2026-11-01T10:00:00.000Z',
    });
    const [audit] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'vendor.brand_assets_hold_set'));
    expect(audit).toMatchObject({ vendorId: VENDOR, actorId: ADMIN });
    expect(audit!.metadata).toMatchObject({ reason: 'Vendor asked for a week' });
  });

  it('requires a reason', async () => {
    expect((await call(`/hold/${VENDOR}`, 'POST', {})).status).toBe(400);
    expect((await row()).brandAssetsHoldAt).toBeNull();
  });

  it('refuses a claimed company, and a second hold', async () => {
    const claimed = await call(`/hold/${CLAIMED}`, 'POST', { reason: 'x' });
    expect(claimed.status).toBe(409);
    expect(await code(claimed)).toBe(ApiErrorCode.BRAND_ASSETS_NOT_PENDING);
    await call(`/hold/${VENDOR}`, 'POST', { reason: 'x' });
    expect(await code(await call(`/hold/${VENDOR}`, 'POST', { reason: 'y' }))).toBe(
      ApiErrorCode.BRAND_ASSETS_NOT_PENDING,
    );
    expect(
      await t.db.select().from(auditLog).where(eq(auditLog.action, 'vendor.brand_assets_hold_set')),
    ).toHaveLength(1);
  });

  it('lifts with its audit row, and refuses when there is none', async () => {
    const none = await call(`/hold/${VENDOR}`, 'DELETE', { reason: 'x' });
    expect(none.status).toBe(409);
    expect(await code(none)).toBe(ApiErrorCode.BRAND_ASSETS_NOT_HELD);
    await call(`/hold/${VENDOR}`, 'POST', { reason: 'x' });
    const res = await call(`/hold/${VENDOR}`, 'DELETE', { reason: 'Done' });
    expect(await res.json()).toEqual({ vendor_id: VENDOR, hold_at: null });
    expect((await row()).brandAssetsHoldAt).toBeNull();
  });

  it('answers 404 for an unknown vendor', async () => {
    expect((await call(`/hold/${u(9)}`, 'POST', { reason: 'x' })).status).toBe(404);
  });
});
