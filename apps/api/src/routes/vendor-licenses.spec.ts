/**
 * `POST /api/vendor/licenses/:id/assign` and `PATCH /api/vendor/licenses/:id`
 * (AECI-1388, E5.2): an owner seat assigns a pool license and flags release at
 * renewal, against the in-memory D1 harness. A stub middleware sets the `auth`
 * Variable; the authz matrix (`vendor.authz-matrix.spec.ts`) runs the real guard.
 */

import { ApiErrorCode, VendorLicenseResponseSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, licenses, productVendors, products, profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import type { DbFactory } from '../lib/handler-utils';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { seedBillingAccount, seedLicense } from '../test/licenses';
import { racingFactory } from '../test/racing-factory';
import {
  createAssignVendorLicenseHandler,
  createUpdateVendorLicenseHandler,
} from './vendor-licenses';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VENDOR = u(1);
const OTHER = u(2);
const OWNER = u(100);
const MEMBER = u(101);
const PRODUCT = u(10); // Bentley's, unlicensed
const PRODUCT_LICENSED = u(11); // Bentley's, holds a live license
const PRODUCT_SHARED = u(12); // co-owned; the OTHER vendor's live license is on it
const PRODUCT_THEIRS = u(13); // the other vendor's alone
const OLD_TS = '2020-01-01T00:00:00.000Z';

const seat = (userId: string, vendorId: string): AuthzVariables['auth'] => ({
  userId,
  email: `${userId.slice(-3)}@bentley.example`,
  role: 'vendor_admin',
  vendorId,
  entitlementTier: 'unclaimed',
  entitlement: null,
});

let t: TestDb;
let queueSend: ReturnType<typeof vi.fn>;
let pool: string; // live, unassigned
let onProduct: string; // live, on PRODUCT_LICENSED

beforeEach(async () => {
  t = await makeTestDb();
  queueSend = vi.fn(async () => undefined);
  await t.db.insert(vendors).values([
    { id: VENDOR, slug: 'bentley', companyName: 'Bentley', verified: true },
    { id: OTHER, slug: 'autodesk', companyName: 'Autodesk', verified: true },
  ]);
  await t.db.insert(products).values([
    { id: PRODUCT, slug: 'openroads', name: 'OpenRoads', promotionStatus: 'promoted' },
    {
      id: PRODUCT_LICENSED,
      slug: 'microstation',
      name: 'MicroStation',
      promotionStatus: 'promoted',
    },
    { id: PRODUCT_SHARED, slug: 'synchro', name: 'SYNCHRO', promotionStatus: 'promoted' },
    { id: PRODUCT_THEIRS, slug: 'revit', name: 'Revit', promotionStatus: 'promoted' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: PRODUCT, vendorId: VENDOR, isPrimary: true },
    { productId: PRODUCT_LICENSED, vendorId: VENDOR, isPrimary: true },
    { productId: PRODUCT_SHARED, vendorId: VENDOR, isPrimary: false },
    { productId: PRODUCT_SHARED, vendorId: OTHER, isPrimary: true },
    { productId: PRODUCT_THEIRS, vendorId: OTHER, isPrimary: true },
  ]);
  await t.db.insert(profiles).values([
    { id: OWNER, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true },
    { id: MEMBER, role: 'vendor_admin', vendorId: VENDOR },
  ]);
  pool = await seedLicense(t.db, VENDOR, { source: 'invoice', endsAt: '2027-06-30T00:00:00.000Z' });
  onProduct = await seedLicense(t.db, VENDOR, { productId: PRODUCT_LICENSED });
  await seedLicense(t.db, OTHER, { productId: PRODUCT_SHARED });
});
afterEach(() => {
  t.dispose();
});

function app(auth: AuthzVariables['auth'], factory: DbFactory = t.factory) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.post('/api/vendor/licenses/:id/assign', createAssignVendorLicenseHandler(factory));
  a.patch('/api/vendor/licenses/:id', createUpdateVendorLicenseHandler(factory));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function send(
  method: 'POST' | 'PATCH',
  path: string,
  body: unknown,
  opts: { auth?: AuthzVariables['auth']; factory?: DbFactory } = {},
) {
  const execCtx = fakeExecutionContext();
  const res = await app(opts.auth ?? seat(OWNER, VENDOR), opts.factory).request(
    path,
    { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    { ...TEST_ENV, CACHE_PURGE_QUEUE: { send: queueSend } } as unknown as Env,
    execCtx,
  );
  const json = (await res.json()) as JsonBody;
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((call) => call[0]));
  return { status: res.status, body: json };
}

const assign = (id: string, productId: string, opts?: Parameters<typeof send>[3]) =>
  send('POST', `/api/vendor/licenses/${id}/assign`, { product_id: productId }, opts);
const flag = (id: string, release: boolean, opts?: Parameters<typeof send>[3]) =>
  send('PATCH', `/api/vendor/licenses/${id}`, { release_at_renewal: release }, opts);

const readAudit = () => t.db.select().from(auditLog);
const readLicense = async (id: string) =>
  (await t.db.select().from(licenses).where(eq(licenses.id, id)))[0]!;

describe('POST /api/vendor/licenses/:id/assign', () => {
  it('puts the license on the product with its audit row in one batch, and purges', async () => {
    const batch = vi.spyOn(t.db, 'batch');
    const { status, body } = await assign(pool, PRODUCT);
    expect(status).toBe(200);
    const parsed = VendorLicenseResponseSchema.parse(body);
    expect(parsed.license).toMatchObject({
      id: pool,
      live: true,
      assigned_product: { id: PRODUCT, slug: 'openroads', name: 'OpenRoads' },
      release_at_renewal: false,
    });
    expect(parsed.license.assigned_at).not.toBeNull();

    // [UPDATE, race sentinel, audit row, mirror reconcile].
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![0]).toHaveLength(4);
    batch.mockRestore();

    const row = await readLicense(pool);
    expect(row.assignedProductId).toBe(PRODUCT);

    const audits = await readAudit();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'license.assigned',
      actorId: OWNER,
      actorType: 'user',
      entityType: 'billing_account',
      entityId: await seedBillingAccount(t.db, VENDOR),
      vendorId: VENDOR,
      productId: PRODUCT,
    });
    expect(audits[0]!.metadata).toMatchObject({ source: 'vendor-portal', license_id: pool });

    expect(queueSend).toHaveBeenCalledTimes(1);
    expect(queueSend.mock.calls[0]![0]).toEqual({
      tags: ['product:openroads', 'index:products', 'vendor:bentley'],
      source: 'vendor',
    });
  });

  it('403s a member seat and writes nothing', async () => {
    const { status, body } = await assign(pool, PRODUCT, { auth: seat(MEMBER, VENDOR) });
    expect(status).toBe(403);
    expect(body.error.code).toBe(ApiErrorCode.FORBIDDEN);
    expect((await readLicense(pool)).assignedProductId).toBeNull();
    expect(await readAudit()).toHaveLength(0);
  });

  it("404s another vendor's license, the same as an unknown id", async () => {
    const theirs = await seedLicense(t.db, OTHER);
    for (const id of [theirs, u(999)]) {
      const { status, body } = await assign(id, PRODUCT);
      expect(status).toBe(404);
      expect(body.error.code).toBe(ApiErrorCode.NOT_FOUND);
    }
    expect((await readLicense(theirs)).assignedProductId).toBeNull();
    expect(await readAudit()).toHaveLength(0);
  });

  it('404s a product the vendor does not own, the same as an unknown id', async () => {
    for (const productId of [PRODUCT_THEIRS, u(998)]) {
      const { status, body } = await assign(pool, productId);
      expect(status).toBe(404);
      expect(body.error.code).toBe(ApiErrorCode.NOT_FOUND);
    }
    expect(await readAudit()).toHaveLength(0);
  });

  it('409s an ended license with LICENSE_NOT_LIVE', async () => {
    const ended = await seedLicense(t.db, VENDOR, { endedAt: OLD_TS, endReason: 'lapsed' });
    const { status, body } = await assign(ended, PRODUCT);
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.LICENSE_NOT_LIVE);
    expect(await readAudit()).toHaveLength(0);
  });

  it('409s an assigned license with LICENSE_ALREADY_ASSIGNED: moving is a release request', async () => {
    const { status, body } = await assign(onProduct, PRODUCT);
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.LICENSE_ALREADY_ASSIGNED);
    expect((await readLicense(onProduct)).assignedProductId).toBe(PRODUCT_LICENSED);
    expect(await readAudit()).toHaveLength(0);
  });

  it.each([
    ['its own live license', PRODUCT_LICENSED],
    ["a co-owner's live license", PRODUCT_SHARED],
  ])('409s a product holding %s with PRODUCT_ALREADY_LICENSED', async (_label, productId) => {
    const { status, body } = await assign(pool, productId);
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.PRODUCT_ALREADY_LICENSED);
    expect((await readLicense(pool)).assignedProductId).toBeNull();
    expect(await readAudit()).toHaveLength(0);
    expect(queueSend).not.toHaveBeenCalled();
  });

  it('maps a lost race on the live-product index to PRODUCT_ALREADY_LICENSED, writing nothing', async () => {
    const factory = racingFactory(t.factory, async (attempt) => {
      if (attempt === 1) await seedLicense(t.db, OTHER, { productId: PRODUCT });
    });
    const { status, body } = await assign(pool, PRODUCT, { factory });
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.PRODUCT_ALREADY_LICENSED);
    expect((await readLicense(pool)).assignedProductId).toBeNull();
    expect(await readAudit()).toHaveLength(0);
  });

  it('maps a lost race on the license to LICENSE_ALREADY_ASSIGNED, writing no audit row', async () => {
    const factory = racingFactory(t.factory, async (attempt) => {
      // Another tab put the pool license on the other product first: the slot there
      // was freed, then filled.
      if (attempt === 1) {
        await t.db.update(licenses).set({ endedAt: OLD_TS }).where(eq(licenses.id, onProduct));
        await t.db
          .update(licenses)
          .set({ assignedProductId: PRODUCT_LICENSED })
          .where(eq(licenses.id, pool));
      }
    });
    const { status, body } = await assign(pool, PRODUCT, { factory });
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.LICENSE_ALREADY_ASSIGNED);
    expect(await readAudit()).toHaveLength(0);
  });

  it.each([
    ['a missing product_id', {}],
    ['a blank product_id', { product_id: '  ' }],
    ['an unknown key', { product_id: PRODUCT, extra: 1 }],
  ])('400s %s', async (_label, body) => {
    const { status } = await send('POST', `/api/vendor/licenses/${pool}/assign`, body);
    expect(status).toBe(400);
    expect(await readAudit()).toHaveLength(0);
  });
});

describe('PATCH /api/vendor/licenses/:id', () => {
  it('sets the flag with a license.release_at_renewal_set row, and purges nothing', async () => {
    const batch = vi.spyOn(t.db, 'batch');
    const { status, body } = await flag(onProduct, true);
    expect(status).toBe(200);
    expect(VendorLicenseResponseSchema.parse(body).license).toMatchObject({
      id: onProduct,
      release_at_renewal: true,
      assigned_product: { id: PRODUCT_LICENSED },
    });
    expect(batch).toHaveBeenCalledTimes(1);
    batch.mockRestore();
    expect((await readLicense(onProduct)).releaseAtRenewal).toBe(true);
    const audits = await readAudit();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'license.release_at_renewal_set',
      actorId: OWNER,
      vendorId: VENDOR,
      productId: PRODUCT_LICENSED,
    });
    expect(audits[0]!.metadata).toMatchObject({ source: 'vendor-portal', license_id: onProduct });
    expect(queueSend).not.toHaveBeenCalled();
  });

  it('clears the flag with a license.release_at_renewal_cleared row', async () => {
    await t.db.update(licenses).set({ releaseAtRenewal: true }).where(eq(licenses.id, onProduct));
    const { status, body } = await flag(onProduct, false);
    expect(status).toBe(200);
    expect(body.license.release_at_renewal).toBe(false);
    expect((await readLicense(onProduct)).releaseAtRenewal).toBe(false);
    const audits = await readAudit();
    expect(audits.map((a) => a.action)).toEqual(['license.release_at_renewal_cleared']);
  });

  it('answers 200 and writes nothing when the flag already holds the value', async () => {
    const batch = vi.spyOn(t.db, 'batch');
    const { status, body } = await flag(onProduct, false);
    expect(status).toBe(200);
    expect(body.license.release_at_renewal).toBe(false);
    expect(batch).not.toHaveBeenCalled();
    batch.mockRestore();
    expect(await readAudit()).toHaveLength(0);
  });

  it.each([
    ['an unassigned', () => pool],
    [
      'an ended',
      () => seedLicense(t.db, VENDOR, { productId: PRODUCT, endedAt: OLD_TS, endReason: 'lapsed' }),
    ],
  ])('409s %s license with LICENSE_NOT_ASSIGNED', async (_label, make) => {
    const id = await make();
    const { status, body } = await flag(id, true);
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.LICENSE_NOT_ASSIGNED);
    expect(await readAudit()).toHaveLength(0);
  });

  it('403s a member seat', async () => {
    const { status } = await flag(onProduct, true, { auth: seat(MEMBER, VENDOR) });
    expect(status).toBe(403);
    expect((await readLicense(onProduct)).releaseAtRenewal).toBe(false);
  });

  it("404s another vendor's license", async () => {
    const theirs = await seedLicense(t.db, OTHER, { productId: PRODUCT_THEIRS });
    const { status, body } = await flag(theirs, true);
    expect(status).toBe(404);
    expect(body.error.code).toBe(ApiErrorCode.NOT_FOUND);
    expect((await readLicense(theirs)).releaseAtRenewal).toBe(false);
  });

  it('maps a license that ended since the read to LICENSE_NOT_ASSIGNED, writing nothing', async () => {
    const factory = racingFactory(t.factory, async (attempt) => {
      if (attempt === 1) {
        await t.db.update(licenses).set({ endedAt: OLD_TS }).where(eq(licenses.id, onProduct));
      }
    });
    const { status, body } = await flag(onProduct, true, { factory });
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.LICENSE_NOT_ASSIGNED);
    expect(await readAudit()).toHaveLength(0);
  });

  it('400s a body with no flag or an unknown key', async () => {
    for (const body of [{}, { release_at_renewal: true, product_id: PRODUCT }]) {
      const { status } = await send('PATCH', `/api/vendor/licenses/${onProduct}`, body);
      expect(status).toBe(400);
    }
  });
});
