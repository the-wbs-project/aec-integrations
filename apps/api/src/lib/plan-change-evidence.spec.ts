/**
 * The plan-change snapshot (AECI-1621, ADR 0056). The snapshot is evidence that a plan
 * did not move a product, so it must report what the public surfaces show: the same
 * inputs the index reads, and the same positions `GET /api/products` returns.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  billingAccounts,
  licenses,
  productCategories,
  products,
  productVendors,
  taxonomyCategories,
  vendors,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createProductsListHandler } from '../routes/products';
import {
  buildPlanChangeSnapshot,
  planSnapshotKey,
  type PlanChangeSnapshotRow,
} from './plan-change-evidence';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VENDOR = u(900);
const CAT = u(800);
const TAKEN = new Date('2026-11-16T10:00:00.000Z');

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values({
    id: VENDOR,
    slug: 'acme',
    companyName: 'Acme',
    promotionStatus: 'promoted',
  });
  await t.db.insert(taxonomyCategories).values({ id: CAT, slug: 'estimating', name: 'Estimating' });
  // Five products, created a day apart: u(1) is the oldest, u(5) the newest.
  for (let n = 1; n <= 5; n++) {
    await t.db.insert(products).values({
      id: u(n),
      slug: `p-${n}`,
      name: `Product ${n}`,
      description: n === 3 ? 'Takeoff and estimating.' : null,
      website: n === 3 ? 'https://p3.test' : null,
      promotionStatus: 'promoted',
      productRole: 'application',
      integrationCount: 10 - n,
      reviewCount: n,
      createdAt: `2026-01-0${n}T00:00:00.000Z`,
    });
    await t.db
      .insert(productVendors)
      .values({ productId: u(n), vendorId: VENDOR, isPrimary: true });
  }
  // Only the odd products are in the category.
  for (const n of [1, 3, 5]) {
    await t.db.insert(productCategories).values({ productId: u(n), categoryId: CAT });
  }
});
afterEach(() => t.dispose());

const row = (
  productId: string,
  over: Partial<PlanChangeSnapshotRow> = {},
): PlanChangeSnapshotRow => ({
  id: 'snap-1',
  productId,
  kind: 'end',
  phase: 'event',
  cause: 'license.lapsed',
  licenseId: 'l-1',
  eventAt: '2026-11-16T09:55:00.000Z',
  ...over,
});

const snapshot = (productId: string, over: Partial<PlanChangeSnapshotRow> = {}) =>
  buildPlanChangeSnapshot(t.db, row(productId, over), { takenAt: TAKEN, commitSha: 'abc123' });

async function publicOrder(query = ''): Promise<string[]> {
  const app = buildAppWithHandler({
    method: 'get',
    path: '/api/products',
    handler: createProductsListHandler(t.factory),
  });
  const res = await app.request(
    `/api/products?perPage=100${query}`,
    {},
    TEST_ENV,
    fakeExecutionContext(),
  );
  const body = (await res.json()) as { data: { id: string }[] };
  return body.data.map((p) => p.id);
}

describe('buildPlanChangeSnapshot', () => {
  it('names the ledger row and the run', async () => {
    const s = await snapshot(u(3));
    expect(s).toMatchObject({
      schema: 1,
      snapshot_id: 'snap-1',
      product_id: u(3),
      kind: 'end',
      phase: 'event',
      cause: 'license.lapsed',
      license_id: 'l-1',
      event_at: '2026-11-16T09:55:00.000Z',
      taken_at: TAKEN.toISOString(),
      commit_sha: 'abc123',
      product: { slug: 'p-3', name: 'Product 3', hidden: false, promotion_status: 'promoted' },
    });
  });

  it('records the ranking inputs through the code the index uses', async () => {
    const s = await snapshot(u(3));
    expect(s.inputs).toMatchObject({
      listing_tier_inputs: {
        name: 'Product 3',
        description: 'Takeoff and estimating.',
        categories: ['Estimating'],
        website: 'https://p3.test',
        logo_url: null,
      },
      review_count: 3,
      ratings: { overall_avg: null, onboarding_avg: null },
      created_at: '2026-01-03T00:00:00.000Z',
      integration_count: 7,
    });
    expect(s.inputs?.algolia_record).toMatchObject({
      objectID: u(3),
      review_count: 3,
      integration_count: 7,
    });
    // `listing_tier` and the record's own tier field agree.
    expect(s.inputs?.listing_tier ?? undefined).toBe(s.inputs?.algolia_record?.listing_tier);
  });

  it('positions match the order GET /api/products returns, list by list', async () => {
    const all = await publicOrder();
    const inCategory = await publicOrder('&category_slug=estimating');
    for (const n of [1, 3, 5]) {
      const s = await snapshot(u(n));
      expect(s.positions).toContainEqual({
        list: '/products',
        sort: 'created',
        rank: all.indexOf(u(n)) + 1,
        of: all.length,
      });
      expect(s.positions).toContainEqual({
        list: '/categories/estimating',
        sort: 'created',
        rank: inCategory.indexOf(u(n)) + 1,
        of: inCategory.length,
      });
    }
    // Newest first: u(5) leads both lists.
    expect((await snapshot(u(5))).positions[0]).toMatchObject({ rank: 1, of: 5 });
  });

  it('lists only the taxonomy pages the product is on', async () => {
    const s = await snapshot(u(2));
    expect(s.positions.map((p) => p.list)).toEqual(['/products', 'home:most-integrated']);
  });

  it('ranks the home "most integrated" list by its own order, connectors excluded', async () => {
    await t.db.insert(products).values({
      id: u(6),
      slug: 'p-6',
      name: 'Connector',
      promotionStatus: 'promoted',
      productRole: 'connector',
      integrationCount: 99,
    });
    // u(1) has the most integrations (9) among endpoint products.
    expect((await snapshot(u(1))).positions.at(-1)).toEqual({
      list: 'home:most-integrated',
      sort: 'most-integrated',
      rank: 1,
      of: 5,
    });
    expect((await snapshot(u(6))).positions.at(-1)).toMatchObject({ rank: null, of: 5 });
  });

  it('a hidden product is in no public list and has no search record', async () => {
    await t.db
      .update(products)
      .set({ hiddenAt: '2026-11-01T00:00:00.000Z' })
      .where(eq(products.id, u(3)));
    const s = await snapshot(u(3));
    expect(s.product?.hidden).toBe(true);
    expect(s.inputs?.algolia_record).toBeNull();
    expect(s.positions.every((p) => p.rank === null)).toBe(true);
  });

  it('plan_now is context: it reads the live license on the product', async () => {
    expect((await snapshot(u(3))).plan_now).toEqual({ managed: false, tier: 'free' });
    await t.db.insert(billingAccounts).values({ id: 'ba-1', vendorId: VENDOR, name: 'Acme' });
    await t.db.insert(licenses).values({
      id: 'l-1',
      billingAccountId: 'ba-1',
      source: 'complimentary',
      startsAt: '2026-01-01T00:00:00.000Z',
      assignedProductId: u(3),
      assignedAt: '2026-01-01T00:00:00.000Z',
    });
    expect((await snapshot(u(3))).plan_now).toEqual({ managed: true, tier: 'managed' });
  });

  it('a missing product still yields a snapshot that says so', async () => {
    const s = await snapshot(u(404));
    expect(s).toMatchObject({
      product_id: u(404),
      product: null,
      reason: 'product_missing',
      inputs: null,
      positions: [],
    });
  });

  it('holds no personal data: no actor, no email, no billing account', async () => {
    const text = JSON.stringify(await snapshot(u(3)));
    expect(text).not.toMatch(/actor|email|billing_account|ba-1|"ip"|user_agent/i);
  });
});

describe('planSnapshotKey', () => {
  it('files the snapshot under the locked evidence prefix, by product then date', () => {
    expect(planSnapshotKey(row(u(3), { phase: 'followup' }))).toBe(
      `evidence/plan-snapshots/product=${u(3)}/2026-11-16T09:55:00.000Z-end-followup-snap-1.json`,
    );
  });
});
