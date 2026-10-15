import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { products, productVendors, vendors } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  EMPTY_PRODUCT_ROLES,
  claimTargetIsPureConnector,
  foldProductRoleGroups,
  isPureConnectorVendor,
} from './vendor-product-roles';

/**
 * The §5.2 payer test in isolation (AECI-738). The route specs cover the SQL and
 * the wiring; this covers the decision itself. Since AECI-1367 it drives an
 * informational flag only ("Connector vendor: contact them directly"), so a wrong
 * answer costs the operator a misleading line, not a parked claim.
 */
describe('isPureConnectorVendor', () => {
  const roles = (o: Partial<typeof EMPTY_PRODUCT_ROLES>) => ({ ...EMPTY_PRODUCT_ROLES, ...o });

  it('is true only when the vendor owns products and all of them are connectors', () => {
    expect(isPureConnectorVendor(roles({ connector: 2, total: 2 }))).toBe(true);
  });

  it('is false when any product is an application', () => {
    // The Autodesk / Trimble / Deltek / Sage case (`STAGE_2_SPEC.md` §8.8(1)):
    // each owns connector-role products AND is a major endpoint account.
    expect(isPureConnectorVendor(roles({ application: 1, connector: 9, total: 10 }))).toBe(false);
  });

  it('is false when any product is a hybrid — hybrid counts as an endpoint', () => {
    // §8.8(1)'s hybrid rule: a hybrid IS an endpoint as well as a connector, so
    // it is chargeable on its endpoint side and confers no exemption.
    expect(isPureConnectorVendor(roles({ hybrid: 1, connector: 9, total: 10 }))).toBe(false);
  });

  it('is false for a vendor with no products at all', () => {
    // Owning nothing is UNKNOWN, not exempt. Written as `connector === total`
    // rather than "no application and no hybrid" precisely so the empty case
    // does not pass by vacuous truth.
    expect(isPureConnectorVendor(EMPTY_PRODUCT_ROLES)).toBe(false);
  });
});

describe('foldProductRoleGroups', () => {
  it('folds grouped rows per vendor', () => {
    const byVendor = foldProductRoleGroups([
      { vendorId: 'v1', role: 'application', value: 2 },
      { vendorId: 'v1', role: 'connector', value: 1 },
      { vendorId: 'v2', role: 'connector', value: 3 },
    ]);
    expect(byVendor.get('v1')).toEqual({ application: 2, connector: 1, hybrid: 0, total: 3 });
    expect(byVendor.get('v2')).toEqual({ application: 0, connector: 3, hybrid: 0, total: 3 });
    // Absent, not zeroed — the caller decides what "no rows" means in its context.
    expect(byVendor.get('v3')).toBeUndefined();
  });

  it('counts an unrecognised role toward the total but into no bucket, failing the carve-out CLOSED', () => {
    // `products_product_role_check` makes this unreachable today, but a future
    // migration could land ahead of this file. The vendor must then read as
    // "owns something that is not a connector" — the safe direction. Counting it
    // as a connector would park a claim wrongly; throwing would 500 the queue.
    const roles = foldProductRoleGroups([
      { vendorId: 'v1', role: 'connector', value: 1 },
      { vendorId: 'v1', role: 'marketplace', value: 1 },
    ]).get('v1')!;
    expect(roles).toEqual({ application: 0, connector: 1, hybrid: 0, total: 2 });
    expect(isPureConnectorVendor(roles)).toBe(false);
  });
});

// ─── AECI-1367: the claim alert's connector flag ─────────────────────────────

describe('claimTargetIsPureConnector', () => {
  const V = '11111111-1111-4111-8111-111111111111';
  const P1 = '22222222-2222-4222-8222-222222222221';
  const P2 = '22222222-2222-4222-8222-222222222222';
  let t: TestDb;
  beforeEach(async () => {
    t = await makeTestDb();
    await t.db.insert(vendors).values({ id: V, slug: 'zapier', companyName: 'Zapier' });
  });
  afterEach(() => t.dispose());

  const seedProducts = async (roles: Array<'application' | 'connector' | 'hybrid'>) => {
    const ids = [P1, P2].slice(0, roles.length);
    await t.db
      .insert(products)
      .values(ids.map((id, i) => ({ id, slug: `p-${i}`, name: `P${i}`, productRole: roles[i]! })));
    await t.db
      .insert(productVendors)
      .values(ids.map((productId) => ({ productId, vendorId: V, isPrimary: true })));
  };

  it('is true for a vendor target whose every product is a connector', async () => {
    await seedProducts(['connector', 'connector']);
    expect(await claimTargetIsPureConnector(t.db, 'vendor', V)).toBe(true);
  });

  it('is false when the vendor also lists an application', async () => {
    await seedProducts(['connector', 'application']);
    expect(await claimTargetIsPureConnector(t.db, 'vendor', V)).toBe(false);
  });

  it('is false for a vendor with no products (unknown, never flagged)', async () => {
    expect(await claimTargetIsPureConnector(t.db, 'vendor', V)).toBe(false);
  });

  it('tests a product target on its primary vendor', async () => {
    await seedProducts(['connector']);
    expect(await claimTargetIsPureConnector(t.db, 'product', P1)).toBe(true);
  });

  it('answers null for a product with no vendor', async () => {
    expect(await claimTargetIsPureConnector(t.db, 'product', P2)).toBeNull();
  });
});
