/**
 * AECI-2044 — the SQL form of the subscription rule agrees with
 * `productTakesSubscription`, and the vendor-level read counts it correctly.
 */
import { productTakesSubscription, type ConnectorKind } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { products, productVendors, vendors } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { ownsOnlyUnsubscribableProducts, subscribableProductSql } from './subscribable-products';

const CELLS: readonly [string, ConnectorKind | null][] = [
  ['application', null],
  ['hybrid', null],
  ['hybrid', 'integration_platform'],
  ['hybrid', 'sync_service'],
  ['connector', null],
  ['connector', 'integration_platform'],
  ['connector', 'sync_service'],
];

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: 'v-mixed', slug: 'mixed', companyName: 'Mixed' },
    { id: 'v-platform', slug: 'platform', companyName: 'Platform' },
    { id: 'v-sync', slug: 'sync', companyName: 'Sync' },
    { id: 'v-empty', slug: 'empty', companyName: 'Empty' },
  ]);
});
afterEach(() => t.dispose());

describe('subscribableProductSql', () => {
  it('selects exactly the products productTakesSubscription accepts', async () => {
    await t.db.insert(products).values(
      CELLS.map(([role, kind], i) => ({
        id: `p-${i}`,
        slug: `p-${i}`,
        name: `p-${i}`,
        productRole: role,
        connectorKind: kind,
      })),
    );
    const rows = await t.db
      .select({ id: products.id })
      .from(products)
      .where(subscribableProductSql());
    const expected = CELLS.flatMap(([role, kind], i) =>
      productTakesSubscription(role, kind) ? [`p-${i}`] : [],
    );
    expect(rows.map((r) => r.id).sort()).toEqual(expected.sort());
  });
});

describe('ownsOnlyUnsubscribableProducts', () => {
  async function own(vendorId: string, id: string, role: string, kind: ConnectorKind | null) {
    await t.db
      .insert(products)
      .values({ id, slug: id, name: id, productRole: role, connectorKind: kind });
    await t.db.insert(productVendors).values({ productId: id, vendorId });
  }

  it('is true for a vendor whose products are all Integration platforms or blank', async () => {
    await own('v-platform', 'a', 'connector', 'integration_platform');
    await own('v-platform', 'b', 'connector', null);
    expect(await ownsOnlyUnsubscribableProducts(t.db, 'v-platform')).toBe(true);
  });

  it('is false for a mixed vendor and for a vendor with a Sync Service', async () => {
    await own('v-mixed', 'c', 'connector', 'integration_platform');
    await own('v-mixed', 'd', 'application', null);
    await own('v-sync', 'e', 'connector', 'sync_service');
    expect(await ownsOnlyUnsubscribableProducts(t.db, 'v-mixed')).toBe(false);
    expect(await ownsOnlyUnsubscribableProducts(t.db, 'v-sync')).toBe(false);
  });

  it('is false for a vendor with no products', async () => {
    expect(await ownsOnlyUnsubscribableProducts(t.db, 'v-empty')).toBe(false);
  });
});
