/**
 * AECI-1178 — vendor replies on the two public review reads
 * (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11c.11, §11c.14, §11c.10).
 *
 * What this file pins:
 *
 *   - the helper emits only replies that pass all three render rules: the reply
 *     is `published`, its review is `approved`, and its vendor still owns the
 *     product. Pending, rejected, withdrawn and removed replies never appear;
 *   - co-owner replies come back in public order, `published_at ASC, id ASC`;
 *   - `GET /api/products/:slug/reviews` and the `ProductDetail.reviews` embed
 *     return identical `vendor_responses` for the same review;
 *   - the firewall: review order, `review_count` and the averages are the same
 *     with and without a reply;
 *   - one reply query per page, never one per review.
 */

import { ProductDetailSchema, ProductReviewsResponseSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { productVendors, products, reviewResponses, reviews, vendors } from '../db/schema';
import { publicReviewColumns } from '../lib/drizzle-helpers';
import { withPublishedVendorResponses } from '../lib/review-responses';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createProductReviewsListHandler } from './product-reviews';
import { createProductDetailHandler } from './products';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const AUTODESK = u(1); // owns Dynamo (primary)
const BENTLEY = u(2); // co-owns Dynamo
const GRAPHISOFT = u(3); // owns nothing here

const DYNAMO = u(10);

const R_PUBLISHED = u(20);
const R_PENDING_REPLY = u(21);
const R_REJECTED_REPLY = u(22);
const R_WITHDRAWN_REPLY = u(23);
const R_REMOVED_REPLY = u(24);
const R_NO_REPLY = u(25);
const R_NON_OWNER = u(26);
const R_PENDING_REVIEW = u(27);

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: AUTODESK, slug: 'autodesk', companyName: 'Autodesk', promotionStatus: 'promoted' },
    { id: BENTLEY, slug: 'bentley', companyName: 'Bentley', promotionStatus: 'promoted' },
    { id: GRAPHISOFT, slug: 'graphisoft', companyName: 'Graphisoft', promotionStatus: 'promoted' },
  ]);
  await t.db.insert(products).values({
    id: DYNAMO,
    slug: 'dynamo',
    name: 'Dynamo',
    promotionStatus: 'promoted',
    reviewCount: 7,
    ratingOverallAvg: 3.5,
    ratingOnboardingAvg: 3.25,
  });
  await t.db.insert(productVendors).values([
    { productId: DYNAMO, vendorId: AUTODESK, isPrimary: true },
    { productId: DYNAMO, vendorId: BENTLEY, isPrimary: false },
  ]);
  const review = (id: string, day: number, status = 'approved') => ({
    id,
    productId: DYNAMO,
    ratingOverall: 4,
    ratingOnboarding: 3,
    title: `Review ${id.slice(-2)}`,
    body: 'Body',
    status,
    createdAt: `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`,
  });
  await t.db
    .insert(reviews)
    .values([
      review(R_PUBLISHED, 1),
      review(R_PENDING_REPLY, 2),
      review(R_REJECTED_REPLY, 3),
      review(R_WITHDRAWN_REPLY, 4),
      review(R_REMOVED_REPLY, 5),
      review(R_NO_REPLY, 6),
      review(R_NON_OWNER, 7),
      review(R_PENDING_REVIEW, 8, 'pending'),
    ]);
});
afterEach(() => t.dispose());

let nextReply = 100;
async function reply(
  reviewId: string,
  vendorId: string,
  status: string,
  publishedAt: string | null,
  body = `Reply from ${vendorId.slice(-1)} to ${reviewId.slice(-2)}`,
) {
  const id = u(nextReply++);
  await t.db.insert(reviewResponses).values({ id, reviewId, vendorId, body, status, publishedAt });
  return id;
}

/** One reply in each status, plus a published reply by a vendor that does not own
 *  the product and one on a review that is not approved. */
async function seedEveryCase() {
  await reply(
    R_PUBLISHED,
    AUTODESK,
    'published',
    '2026-09-20T00:00:00.000Z',
    'Line one.\nLine two.',
  );
  await reply(R_PENDING_REPLY, AUTODESK, 'pending', null);
  await reply(R_REJECTED_REPLY, AUTODESK, 'rejected', null);
  await reply(R_WITHDRAWN_REPLY, AUTODESK, 'withdrawn', null);
  await reply(R_REMOVED_REPLY, AUTODESK, 'removed', null);
  await reply(R_NON_OWNER, GRAPHISOFT, 'published', '2026-09-20T00:00:00.000Z');
  await reply(R_PENDING_REVIEW, AUTODESK, 'published', '2026-09-20T00:00:00.000Z');
}

const listApp = () =>
  buildAppWithHandler({
    method: 'get',
    path: '/api/products/:slug/reviews',
    handler: createProductReviewsListHandler(t.factory),
  });
const detailApp = () =>
  buildAppWithHandler({
    method: 'get',
    path: '/api/products/:slug',
    handler: createProductDetailHandler(t.factory),
  });

async function getList() {
  const res = await listApp().request(
    '/api/products/dynamo/reviews',
    {},
    TEST_ENV,
    fakeExecutionContext(),
  );
  expect(res.status).toBe(200);
  return ProductReviewsResponseSchema.parse(await res.json());
}
async function getDetail() {
  const res = await detailApp().request(
    '/api/products/dynamo',
    {},
    TEST_ENV,
    fakeExecutionContext(),
  );
  expect(res.status).toBe(200);
  return ProductDetailSchema.parse(await res.json());
}

async function approvedRows() {
  return t.db.query.reviews.findMany({
    columns: publicReviewColumns,
    where: eq(reviews.status, 'approved'),
  });
}

describe('withPublishedVendorResponses (§11c.11)', () => {
  it('emits only published replies on approved reviews by a vendor that owns the product', async () => {
    await seedEveryCase();
    const mapped = await withPublishedVendorResponses(t.db, await approvedRows());
    const byId = new Map(mapped.map((r) => [r.id, r.vendor_responses]));

    expect(byId.get(R_PUBLISHED)).toEqual([
      {
        vendor_slug: 'autodesk',
        vendor_name: 'Autodesk',
        body: 'Line one.\nLine two.',
        published_at: '2026-09-20T00:00:00.000Z',
      },
    ]);
    for (const id of [
      R_PENDING_REPLY,
      R_REJECTED_REPLY,
      R_WITHDRAWN_REPLY,
      R_REMOVED_REPLY,
      R_NO_REPLY,
      R_NON_OWNER,
    ]) {
      expect(byId.get(id), id).toEqual([]);
    }
  });

  it('drops a published reply on a review that is not approved', async () => {
    await seedEveryCase();
    const pendingRow = await t.db.query.reviews.findFirst({
      columns: publicReviewColumns,
      where: eq(reviews.id, R_PENDING_REVIEW),
    });
    const [mapped] = await withPublishedVendorResponses(t.db, [pendingRow!]);
    expect(mapped!.vendor_responses).toEqual([]);
  });

  it('drops a reply once its vendor no longer owns the product', async () => {
    await reply(R_PUBLISHED, BENTLEY, 'published', '2026-09-20T00:00:00.000Z');
    expect(
      (await withPublishedVendorResponses(t.db, await approvedRows())).find(
        (r) => r.id === R_PUBLISHED,
      )!.vendor_responses,
    ).toHaveLength(1);

    await t.db.delete(productVendors).where(eq(productVendors.vendorId, BENTLEY));
    expect(
      (await withPublishedVendorResponses(t.db, await approvedRows())).find(
        (r) => r.id === R_PUBLISHED,
      )!.vendor_responses,
    ).toEqual([]);
  });

  it('stacks co-owner replies in public order, published_at ASC', async () => {
    await reply(R_PUBLISHED, BENTLEY, 'published', '2026-09-22T00:00:00.000Z');
    await reply(R_PUBLISHED, AUTODESK, 'published', '2026-09-21T00:00:00.000Z');
    const mapped = await withPublishedVendorResponses(t.db, await approvedRows());
    expect(
      mapped.find((r) => r.id === R_PUBLISHED)!.vendor_responses.map((v) => v.vendor_slug),
    ).toEqual(['autodesk', 'bentley']);
  });

  it('keeps the input order and runs one reply query for the page, not one per review', async () => {
    await seedEveryCase();
    const rows = await approvedRows();
    const spy = vi.spyOn(t.db, 'select');
    const mapped = await withPublishedVendorResponses(t.db, rows);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(mapped.map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });

  it('makes no query for an empty page', async () => {
    const spy = vi.spyOn(t.db, 'select');
    expect(await withPublishedVendorResponses(t.db, [])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('the two public reads (§11c.14)', () => {
  it('return identical vendor_responses for every review', async () => {
    await seedEveryCase();
    await reply(R_NO_REPLY, BENTLEY, 'published', '2026-09-23T00:00:00.000Z');
    await reply(R_NO_REPLY, AUTODESK, 'published', '2026-09-22T00:00:00.000Z');

    const list = await getList();
    const detail = await getDetail();

    expect(detail.reviews.map((r) => r.id)).toEqual(list.data.map((r) => r.id));
    expect(detail.reviews.map((r) => r.vendor_responses)).toEqual(
      list.data.map((r) => r.vendor_responses),
    );
    const published = list.data.find((r) => r.id === R_PUBLISHED)!;
    expect(published.vendor_responses.map((v) => v.vendor_name)).toEqual(['Autodesk']);
    const coOwned = list.data.find((r) => r.id === R_NO_REPLY)!;
    expect(coOwned.vendor_responses.map((v) => v.vendor_slug)).toEqual(['autodesk', 'bentley']);
    // Every other review carries an empty array, never a missing key.
    expect(
      list.data
        .filter((r) => r.vendor_responses.length > 0)
        .map((r) => r.id)
        .sort(),
    ).toEqual([R_PUBLISHED, R_NO_REPLY].sort());
  });

  it('carry no reviewer or moderation data on a reply', async () => {
    await seedEveryCase();
    const raw = (await (
      await listApp().request('/api/products/dynamo/reviews', {}, TEST_ENV, fakeExecutionContext())
    ).json()) as { data: Array<{ id: string; vendor_responses: Record<string, unknown>[] }> };
    const replyKeys = Object.keys(raw.data.find((r) => r.id === R_PUBLISHED)!.vendor_responses[0]!);
    expect(replyKeys.sort()).toEqual(['body', 'published_at', 'vendor_name', 'vendor_slug']);
  });
});

describe('the firewall (§11c.10)', () => {
  it('leaves review order, count and averages unchanged with and without a reply', async () => {
    const before = { list: await getList(), detail: await getDetail() };
    await seedEveryCase();
    await reply(R_NO_REPLY, BENTLEY, 'published', '2026-09-23T00:00:00.000Z');
    const after = { list: await getList(), detail: await getDetail() };

    expect(after.list.data.map((r) => r.id)).toEqual(before.list.data.map((r) => r.id));
    expect(after.list.total).toBe(before.list.total);
    expect(after.detail.reviews.map((r) => r.id)).toEqual(before.detail.reviews.map((r) => r.id));
    expect(after.detail.review_count).toBe(before.detail.review_count);
    expect(after.detail.rating_overall_avg).toBe(before.detail.rating_overall_avg);
    expect(after.detail.rating_onboarding_avg).toBe(before.detail.rating_onboarding_avg);

    // Stripped of replies, every review is byte-for-byte what it was.
    const strip = (rs: Array<{ vendor_responses: unknown }>) =>
      rs.map(({ vendor_responses: _ignored, ...rest }) => rest);
    expect(strip(after.list.data)).toEqual(strip(before.list.data));
    expect(strip(after.detail.reviews)).toEqual(strip(before.detail.reviews));
  });
});
