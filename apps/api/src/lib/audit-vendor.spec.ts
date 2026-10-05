/**
 * AECI-1192 / AECI-1193 builders: `auditInsert` maps the four columns,
 * `vendorAuditEntry` stamps a vendor session's vendor and plan, and the admin-side
 * helpers in `lib/audit-vendor.ts` find the holder and its plan.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditLog, productVendors, products, vendorEntitlements, vendors } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  sessionVendorPlan,
  vendorAuditEntry,
  vendorAuditLogEvent,
  type VendorContext,
} from '../routes/vendor-shared';
import { auditInsert } from './audit';
import {
  NO_VENDOR_STAMP,
  productAuditStamp,
  productHolderVendorId,
  vendorAuditStamp,
} from './audit-vendor';
import type { AuthzVariables } from './authz';
import type { Env } from '../env';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const V1 = uuid(1);
const V2 = uuid(2);
const P1 = uuid(10);
const P_UNOWNED = uuid(11);

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: V1, slug: 'v1', companyName: 'V1' },
    { id: V2, slug: 'v2', companyName: 'V2' },
  ]);
  await t.db.insert(products).values([
    { id: P1, slug: 'p1', name: 'P1' },
    { id: P_UNOWNED, slug: 'p2', name: 'P2' },
  ]);
});
afterEach(() => t.dispose());

describe('auditInsert maps the AECI-1192 / AECI-1193 columns', () => {
  it('writes vendor, product and plan when the entry carries them', async () => {
    await t.db.batch([
      auditInsert(t.db, {
        actorType: 'system',
        action: 'product.updated',
        entityType: 'product',
        entityId: P1,
        vendorId: V1,
        productId: P1,
        vendorPlan: { tier: 'verified', status: 'expired' },
      }),
    ]);
    const [row] = await t.db.select().from(auditLog);
    expect(row).toMatchObject({
      vendorId: V1,
      productId: P1,
      vendorTier: 'verified',
      vendorEntitlementStatus: 'expired',
    });
  });

  it('leaves all four NULL when the entry is not about a vendor', async () => {
    await t.db.batch([auditInsert(t.db, { actorType: 'system', action: 'job.ran' })]);
    const [row] = await t.db.select().from(auditLog);
    expect(row).toMatchObject({
      vendorId: null,
      productId: null,
      vendorTier: null,
      vendorEntitlementStatus: null,
    });
  });
});

describe('the admin-side holder and plan helpers', () => {
  it('vendorAuditStamp reads the plan, and says none for no row', async () => {
    expect(await vendorAuditStamp(t.db, V1)).toEqual({
      vendorId: V1,
      vendorPlan: { tier: 'none', status: 'none' },
    });
    await t.db
      .insert(vendorEntitlements)
      .values({ id: uuid(40), vendorId: V1, tier: 'verified', status: 'revoked' });
    expect(await vendorAuditStamp(t.db, V1)).toEqual({
      vendorId: V1,
      vendorPlan: { tier: 'verified', status: 'revoked' },
    });
  });

  it('vendorAuditStamp records expired for an active row past period_end', async () => {
    await t.db.insert(vendorEntitlements).values({
      id: uuid(41),
      vendorId: V1,
      tier: 'verified',
      status: 'active',
      periodEnd: '2026-10-01',
    });
    expect(await vendorAuditStamp(t.db, V1, '2026-10-05T00:00:00.000Z')).toEqual({
      vendorId: V1,
      vendorPlan: { tier: 'verified', status: 'expired' },
    });
    expect(await vendorAuditStamp(t.db, V1, '2026-09-30T00:00:00.000Z')).toEqual({
      vendorId: V1,
      vendorPlan: { tier: 'verified', status: 'active' },
    });
  });

  it('vendorAuditStamp leaves both NULL for no vendor', async () => {
    expect(await vendorAuditStamp(t.db, null)).toEqual(NO_VENDOR_STAMP);
  });

  it('productHolderVendorId prefers the primary owner of a co-owned product', async () => {
    await t.db.insert(productVendors).values([
      { productId: P1, vendorId: V1, isPrimary: false },
      { productId: P1, vendorId: V2, isPrimary: true },
    ]);
    expect(await productHolderVendorId(t.db, P1)).toBe(V2);
    expect(await productHolderVendorId(t.db, P_UNOWNED)).toBeNull();
    expect(await productAuditStamp(t.db, P_UNOWNED)).toEqual(NO_VENDOR_STAMP);
  });
});

describe('vendorAuditEntry stamps the session vendor and plan', () => {
  /** Run `fn` inside a real Hono context carrying `auth`. */
  async function withSession<T>(
    auth: AuthzVariables['auth'],
    fn: (c: VendorContext) => T,
  ): Promise<T> {
    let out: T | undefined;
    const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    app.get('/', (c) => {
      c.set('auth', auth);
      out = fn(c);
      return c.text('ok');
    });
    await app.request('/');
    return out as T;
  }

  const SESSION: AuthzVariables['auth'] = {
    userId: uuid(100),
    role: 'vendor_admin',
    vendorId: V1,
    entitlementTier: 'unclaimed',
    entitlement: { status: 'expired', tier: 'verified', periodEnd: null, endedAt: null },
  };

  it('stamps the session vendor and the RAW tier with its status', async () => {
    const entry = await withSession(SESSION, (c) =>
      vendorAuditEntry(c, { actorType: 'user', action: 'vendor.updated', vendorId: V2 }),
    );
    // The session wins: a vendor route cannot file a row under another vendor.
    expect(entry.vendorId).toBe(V1);
    expect(entry.vendorPlan).toEqual({ tier: 'verified', status: 'expired' });
  });

  it('records none for a session with no entitlement row', async () => {
    const plan = await withSession({ ...SESSION, entitlement: null }, (c) => sessionVendorPlan(c));
    expect(plan).toEqual({ tier: 'none', status: 'none' });
  });

  it('falls back to entitlementTier when a hand-built session omits the raw tier', async () => {
    const plan = await withSession(
      {
        ...SESSION,
        entitlementTier: 'verified',
        entitlement: { status: 'active', periodEnd: null },
      },
      (c) => sessionVendorPlan(c),
    );
    expect(plan).toEqual({ tier: 'verified', status: 'active' });
  });

  it('records expired when the session row is active but past period_end', async () => {
    const plan = await withSession(
      {
        ...SESSION,
        entitlementTier: 'verified',
        entitlement: { status: 'active', tier: 'verified', periodEnd: '2026-10-01T00:00:00.000Z' },
      },
      (c) => sessionVendorPlan(c, '2026-10-05T00:00:00.000Z'),
    );
    expect(plan).toEqual({ tier: 'verified', status: 'expired' });
  });

  it('passes a notification.sent row through untouched: it names its RECIPIENT', async () => {
    const notice = { actorType: 'user' as const, action: 'notification.sent', vendorId: V2 };
    const entry = await withSession(SESSION, (c) => vendorAuditEntry(c, notice));
    expect(entry).toBe(notice);
  });

  it('forwards vendor_id and vendor_tier to PostHog', () => {
    const event = vendorAuditLogEvent({
      actorType: 'user',
      action: 'vendor.updated',
      entityId: V1,
      vendorId: V1,
      vendorPlan: { tier: 'verified', status: 'active' },
    });
    expect(event).toMatchObject({ vendor_id: V1, vendor_tier: 'verified' });
  });
});
