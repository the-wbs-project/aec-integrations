/**
 * `resolveOwnerVisit()` — the ownership half of `page_views.is_owner_visit`
 * (AECI-934 / `ADMIN_PANEL_SPEC.md` §13 D26), against the in-memory D1 harness.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { products, productVendors, vendors } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { resolveOwnerVisit, type OwnerVisitRow } from './owner-visit';

const OURS = 'v-ours';
const CO_OWNER = 'v-co';
const THEIRS = 'v-theirs';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: OURS, slug: 'ours', companyName: 'Ours' },
    { id: CO_OWNER, slug: 'co', companyName: 'Co' },
    { id: THEIRS, slug: 'theirs', companyName: 'Theirs' },
  ]);
  await t.db.insert(products).values([
    { id: 'p-ours', slug: 'ours-app', name: 'Ours App' },
    { id: 'p-theirs', slug: 'theirs-app', name: 'Theirs App' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: 'p-ours', vendorId: OURS, isPrimary: true },
    // A co-owner that is NOT the primary vendor still owns the listing.
    { productId: 'p-ours', vendorId: CO_OWNER, isPrimary: false },
    { productId: 'p-theirs', vendorId: THEIRS, isPrimary: true },
  ]);
});
afterEach(() => t.dispose());

const row = (over: Partial<OwnerVisitRow>): OwnerVisitRow => ({
  productId: null,
  vendorId: null,
  pairProductAId: null,
  pairProductBId: null,
  concretePath: '/',
  ...over,
});

describe('resolveOwnerVisit', () => {
  it('is false with no D1 work when the session is not a vendor admin', async () => {
    const select = vi.spyOn(t.db, 'select');
    expect(await resolveOwnerVisit(t.db, null, row({ productId: 'p-ours' }))).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });

  it('is true for the vendor page itself, with no D1 work', async () => {
    const select = vi.spyOn(t.db, 'select');
    expect(await resolveOwnerVisit(t.db, OURS, row({ vendorId: OURS }))).toBe(true);
    expect(select).not.toHaveBeenCalled();
  });

  it('is true for a product the vendor owns, primary or not', async () => {
    expect(await resolveOwnerVisit(t.db, OURS, row({ productId: 'p-ours' }))).toBe(true);
    expect(await resolveOwnerVisit(t.db, CO_OWNER, row({ productId: 'p-ours' }))).toBe(true);
  });

  it('is false for another vendor’s product or vendor page', async () => {
    expect(await resolveOwnerVisit(t.db, OURS, row({ productId: 'p-theirs' }))).toBe(false);
    expect(await resolveOwnerVisit(t.db, OURS, row({ vendorId: THEIRS }))).toBe(false);
  });

  it.each([
    ['side A', { pairProductAId: 'p-ours', pairProductBId: 'p-theirs' }],
    ['side B', { pairProductAId: 'p-theirs', pairProductBId: 'p-ours' }],
  ])('is true for a pair page whose %s is the vendor’s product', async (_side, pair) => {
    expect(await resolveOwnerVisit(t.db, OURS, row(pair))).toBe(true);
    // ...and the other endpoint's vendor owns the same page view too.
    expect(await resolveOwnerVisit(t.db, THEIRS, row(pair))).toBe(true);
  });

  it('is false for a pair page neither endpoint of which is the vendor’s', async () => {
    expect(
      await resolveOwnerVisit(
        t.db,
        CO_OWNER,
        row({ pairProductAId: 'p-theirs', pairProductBId: null }),
      ),
    ).toBe(false);
  });

  it('reads the slug of an SPA hop, which stores no entity id', async () => {
    expect(await resolveOwnerVisit(t.db, OURS, row({ concretePath: '/products/ours-app' }))).toBe(
      true,
    );
    expect(
      await resolveOwnerVisit(t.db, CO_OWNER, row({ concretePath: '/products/ours-app' })),
    ).toBe(true);
    expect(await resolveOwnerVisit(t.db, OURS, row({ concretePath: '/vendors/ours' }))).toBe(true);
    expect(await resolveOwnerVisit(t.db, OURS, row({ concretePath: '/products/theirs-app' }))).toBe(
      false,
    );
    expect(await resolveOwnerVisit(t.db, OURS, row({ concretePath: '/vendors/theirs' }))).toBe(
      false,
    );
  });

  it.each([
    ['/products/ghost'],
    ['/vendors/ghost'],
    ['/products/ours-app/review'],
    ['/vendors/ours/claim'],
    ['/products/ours-app/'],
    ['/products'],
    ['/search'],
  ])('is false for %s, which is not a page the vendor owns', async (concretePath) => {
    expect(await resolveOwnerVisit(t.db, OURS, row({ concretePath }))).toBe(false);
  });

  it('resolves false rather than throwing when the read fails', async () => {
    t.dispose();
    await expect(resolveOwnerVisit(t.db, OURS, row({ productId: 'p-ours' }))).resolves.toBe(false);
    t = await makeTestDb(); // so afterEach's dispose stays valid
  });
});
