/**
 * Unit coverage for the ownership predicates (AECI-1415, ADR 0042).
 *
 * They gate the promote ownership fence, so their failure modes are asymmetric: a
 * false negative lets the review app overwrite vendor-owned data, and a false
 * positive silently freezes a company out of curation. Ownership is the stored
 * `vendors.owned_at`, so seats no longer decide it in either direction: a seated
 * vendor without the stamp is unowned, and a seatless vendor with it stays owned.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/client';
import { productVendors, products, profiles, vendors } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { loadOwnedProductIds, loadOwnedVendorIds } from './claimed-vendors';

const V1 = '11111111-1111-4111-8111-111111111111';
const V2 = '22222222-2222-4222-8222-222222222222';
const V3 = '33333333-3333-4333-8333-333333333333';
const P1 = '44444444-4444-4444-8444-444444444441';
const P2 = '44444444-4444-4444-8444-444444444442';
const P3 = '44444444-4444-4444-8444-444444444443';
const OWNED_AT = '2026-10-01T00:00:00.000Z';

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: V1, slug: 'autodesk', companyName: 'Autodesk', ownedAt: OWNED_AT },
    { id: V2, slug: 'deltek', companyName: 'Deltek' },
    { id: V3, slug: 'bentley', companyName: 'Bentley' },
  ]);
  await t.db.insert(products).values([
    { id: P1, slug: 'revit', name: 'Revit' },
    { id: P2, slug: 'vantagepoint', name: 'Vantagepoint' },
    { id: P3, slug: 'synchro', name: 'Synchro' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P1, vendorId: V1, isPrimary: true },
    { productId: P2, vendorId: V2, isPrimary: true },
    // Co-owned: one owned vendor and one unowned.
    { productId: P3, vendorId: V3, isPrimary: true },
    { productId: P3, vendorId: V1, isPrimary: false },
  ]);
});
afterEach(() => t.dispose());

function exploding(): Db {
  return new Proxy({} as Db, {
    get() {
      throw new Error('queried D1 for an empty candidate list');
    },
  });
}

describe('loadOwnedVendorIds', () => {
  it('returns an empty set for an empty candidate list without touching D1', async () => {
    expect(await loadOwnedVendorIds(exploding(), [])).toEqual(new Set());
  });

  it('returns only the vendors whose owned_at is set', async () => {
    expect(await loadOwnedVendorIds(t.db, [V1, V2, V3])).toEqual(new Set([V1]));
  });

  it('a seat does not make a vendor owned, and seat loss does not un-own one', async () => {
    await t.db.insert(profiles).values({ id: 'u1', role: 'vendor_admin', vendorId: V2 });
    expect(await loadOwnedVendorIds(t.db, [V1, V2])).toEqual(new Set([V1]));
  });

  it('de-duplicates candidate ids', async () => {
    expect(await loadOwnedVendorIds(t.db, [V1, V1, V1])).toEqual(new Set([V1]));
  });

  it('answers past the 100-parameter cap', async () => {
    const many = Array.from({ length: 150 }, (_, i) => `x-${i}`);
    expect(await loadOwnedVendorIds(t.db, [...many, V1])).toEqual(new Set([V1]));
  });
});

describe('loadOwnedProductIds', () => {
  it('returns an empty set for an empty candidate list without touching D1', async () => {
    expect(await loadOwnedProductIds(exploding(), [])).toEqual(new Set());
  });

  it('a product is owned when any joined vendor is owned (Q3)', async () => {
    expect(await loadOwnedProductIds(t.db, [P1, P2, P3])).toEqual(new Set([P1, P3]));
  });

  it('a product with no owned vendor is not owned', async () => {
    expect(await loadOwnedProductIds(t.db, [P2])).toEqual(new Set());
  });
});
