/**
 * The shared vendor purge-tag builder (AECI-609 / §2.5). Promoted out of
 * `routes/admin-claims.ts` so the epic's second writer (§5's entitlement endpoint)
 * cannot construct a divergent set — that is how a page goes stale on one path and
 * not the other. `admin-claims.spec.ts`'s purge assertion passing unedited is the
 * proof the promotion was byte-identical.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  connectorEvidencedPairs,
  integrations,
  products,
  productVendors,
  vendors,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { vendorPurgeTags } from './vendor-cache-tags';

const VENDOR_ID = '11111111-1111-4111-8111-111111111111';

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values({ id: VENDOR_ID, slug: 'autodesk', companyName: 'Autodesk' });
});
afterEach(() => t.dispose());

async function seedProduct(id: string, slug: string) {
  await t.db.insert(products).values({ id, slug, name: slug });
  await t.db.insert(productVendors).values({ productId: id, vendorId: VENDOR_ID });
}

describe('vendorPurgeTags', () => {
  it('returns just the vendor tag when the vendor owns no products', async () => {
    expect(
      await vendorPurgeTags(t.db, { id: VENDOR_ID, slug: 'autodesk', verified: true }),
    ).toEqual(['vendor:autodesk']);
  });

  it('adds every owned product tag plus index:products', async () => {
    await seedProduct('b0000000-0000-4000-8000-000000000001', 'revit');
    await seedProduct('b0000000-0000-4000-8000-000000000002', 'autocad');

    const tags = await vendorPurgeTags(t.db, { id: VENDOR_ID, slug: 'autodesk', verified: true });

    // `verified` drives the version-diff gate on every pair page, which carries both
    // endpoints' `product:` tags. Purging only `vendor:` would leave that gate stale.
    expect(tags).toContain('vendor:autodesk');
    expect(tags).toContain('product:revit');
    expect(tags).toContain('product:autocad');
    expect(tags).toContain('index:products');
    expect(tags).toHaveLength(4);
  });

  it('does not leak another vendor’s products', async () => {
    const other = '99999999-9999-4999-8999-999999999999';
    await t.db.insert(vendors).values({ id: other, slug: 'procore', companyName: 'Procore' });
    await t.db
      .insert(products)
      .values({ id: 'b0000000-0000-4000-8000-000000000009', slug: 'procore-app', name: 'Procore' });
    await t.db
      .insert(productVendors)
      .values({ productId: 'b0000000-0000-4000-8000-000000000009', vendorId: other });

    expect(
      await vendorPurgeTags(t.db, { id: VENDOR_ID, slug: 'autodesk', verified: true }),
    ).toEqual(['vendor:autodesk']);
  });
});

/**
 * AECI-1663: a plan flip no longer changes a row caption (no row takes the `until`
 * form), so the set no longer follows the vendor's edited connector-powered rows onto
 * pages it does not own. AECI-1614 had added them.
 */
describe('vendorPurgeTags: edited connector-powered rows add no tags', () => {
  const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const VENDOR = { id: VENDOR_ID, slug: 'autodesk', verified: false };
  const EDITED = '2026-06-01T00:00:00.000Z';

  it('adds nothing for an edited connector-powered row on either table', async () => {
    await t.db.insert(products).values([
      { id: u(1), slug: 'alpha', name: 'Alpha' },
      { id: u(2), slug: 'beta', name: 'Beta' },
      { id: u(3), slug: 'agave', name: 'Agave', productRole: 'connector' },
    ]);
    await t.db.insert(integrations).values({
      id: u(10),
      sourceProductId: u(1),
      targetProductId: u(2),
      builtByVendorId: VENDOR_ID,
      claimedAt: EDITED,
      mechanismKind: 'integrator',
      poweredByProductId: u(3),
      vendorEditedAt: EDITED,
    });
    await t.db.insert(connectorEvidencedPairs).values({
      id: u(11),
      productAId: u(1),
      productBId: u(2),
      connectorProductId: u(3),
      builtByVendorId: VENDOR_ID,
      claimedAt: EDITED,
      vendorEditedAt: EDITED,
    });
    expect(await vendorPurgeTags(t.db, VENDOR)).toEqual(['vendor:autodesk']);
  });
});
