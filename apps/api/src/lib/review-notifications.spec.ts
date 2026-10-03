/**
 * AECI-1180 — who is told about an approved review, and how the email fans out
 * (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11c.12).
 *
 *   - recipients are every owning vendor in `product_vendors`, primary or not, and
 *     nobody else;
 *   - one feed row per owner;
 *   - the email goes to each owner's unbanned `vendor_admin` seats, never to a
 *     non-owner, with the fan-out bounded by `WORKER_CONNECTION_LIMIT`;
 *   - a failure warns and never throws.
 *
 * The sender is mocked: nothing here reaches Resend.
 */

import { WORKER_CONNECTION_LIMIT } from '@aeci/shared/concurrency';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { productVendors, products, profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import { logToPosthog } from '../posthog';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV } from '../test/helpers';
import { sendVendorReviewPublishedEmail, type EmailContext } from './email';
import {
  emailOwnersOfApprovedReview,
  loadReviewOwners,
  reviewApprovedNotifications,
  vendorReviewPublishedKey,
} from './review-notifications';

vi.mock('./email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./email')>()),
  sendVendorReviewPublishedEmail: vi.fn(() => Promise.resolve('sent')),
}));
vi.mock('../posthog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../posthog')>()),
  logToPosthog: vi.fn(),
}));

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const PRIMARY = uuid(1);
const CO_OWNER = uuid(2);
const STRANGER = uuid(3);
const P = uuid(10);
const OTHER_P = uuid(11);
const REVIEW = { id: uuid(30), title: 'Solid', product: { id: P, slug: 'revit', name: 'Revit' } };

let t: TestDb;

beforeEach(async () => {
  vi.mocked(sendVendorReviewPublishedEmail).mockClear();
  vi.mocked(logToPosthog).mockClear();
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: PRIMARY, slug: 'autodesk', companyName: 'Autodesk' },
    { id: CO_OWNER, slug: 'bentley', companyName: 'Bentley' },
    { id: STRANGER, slug: 'trimble', companyName: 'Trimble' },
  ]);
  await t.db.insert(products).values([
    { id: P, slug: 'revit', name: 'Revit' },
    { id: OTHER_P, slug: 'tekla', name: 'Tekla' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P, vendorId: PRIMARY, isPrimary: true },
    { productId: P, vendorId: CO_OWNER, isPrimary: false },
    { productId: OTHER_P, vendorId: STRANGER, isPrimary: true },
  ]);
});
afterEach(() => t.dispose());

const ctx = (): EmailContext => ({
  env: { ...TEST_ENV } as Env,
  executionCtx: { waitUntil: () => {} },
  req: { raw: new Request('https://api.test/') },
});

describe('loadReviewOwners', () => {
  it('a co-owned product has two recipients, primary or not', async () => {
    expect(await loadReviewOwners(t.db, P)).toEqual([
      { vendorId: PRIMARY, vendorSlug: 'autodesk' },
      { vendorId: CO_OWNER, vendorSlug: 'bentley' },
    ]);
  });

  it('a vendor that owns a different product is never a recipient', async () => {
    const ids = (await loadReviewOwners(t.db, P)).map((o) => o.vendorId);
    expect(ids).not.toContain(STRANGER);
  });

  it('an unowned product has no recipients', async () => {
    await t.db.insert(products).values({ id: uuid(12), slug: 'orphan', name: 'Orphan' });
    expect(await loadReviewOwners(t.db, uuid(12))).toEqual([]);
  });
});

describe('reviewApprovedNotifications', () => {
  it('builds one `review` row per owner, addressed by metadata.vendorId', async () => {
    const owners = await loadReviewOwners(t.db, P);
    const rows = reviewApprovedNotifications(
      'portal-review',
      { actorId: uuid(900), actorType: 'admin' },
      owners,
      REVIEW,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r.metadata as { vendorId: string }).vendorId)).toEqual([
      PRIMARY,
      CO_OWNER,
    ]);
    expect(rows[0]).toEqual({
      actorId: uuid(900),
      actorType: 'admin',
      action: 'notification.sent',
      entityType: 'review',
      entityId: REVIEW.id,
      metadata: {
        kind: 'review',
        notificationId: 'portal-review',
        vendorId: PRIMARY,
        reviewId: REVIEW.id,
        productId: P,
        product: { slug: 'revit', name: 'Revit' },
        reviewTitle: 'Solid',
      },
    });
  });

  it('no owners, no rows', () => {
    expect(
      reviewApprovedNotifications(
        'portal-review',
        { actorId: null, actorType: 'admin' },
        [],
        REVIEW,
      ),
    ).toEqual([]);
  });
});

describe('emailOwnersOfApprovedReview', () => {
  const EMAIL_REVIEW = {
    id: REVIEW.id,
    title: 'Solid',
    ratingOverall: 4,
    ratingOnboarding: 3,
    product: REVIEW.product,
  };
  const seatEmails = vi.fn(
    async (_env: Env, ids: readonly string[]) =>
      new Map(ids.map((id) => [id, `${id.slice(-3)}@seat.test`])),
  );

  beforeEach(() => {
    seatEmails.mockClear();
  });

  it('emails each owner’s unbanned vendor_admin seats, and nobody else', async () => {
    await t.db.insert(profiles).values([
      { id: uuid(100), role: 'vendor_admin', vendorId: PRIMARY },
      { id: uuid(101), role: 'vendor_admin', vendorId: CO_OWNER },
      { id: uuid(102), role: 'vendor_admin', vendorId: CO_OWNER, bannedAt: '2026-09-01T00:00:00Z' },
      { id: uuid(103), role: 'vendor_admin', vendorId: STRANGER },
    ]);
    const owners = await loadReviewOwners(t.db, P);
    await emailOwnersOfApprovedReview(ctx(), t.db, owners, EMAIL_REVIEW, seatEmails);

    const calls = vi.mocked(sendVendorReviewPublishedEmail).mock.calls.map((c) => c[1]);
    expect(calls).toHaveLength(2);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: '100@seat.test', vendorSlug: 'autodesk' }),
        expect.objectContaining({ to: '101@seat.test', vendorSlug: 'bentley' }),
      ]),
    );
    expect(calls[0]).toMatchObject({
      reviewId: REVIEW.id,
      productName: 'Revit',
      productSlug: 'revit',
      title: 'Solid',
      ratingOverall: 4,
      ratingOnboarding: 3,
    });
  });

  it('keys each seat’s send by review and seat, so a replayed approve is a duplicate (AECI-1202)', async () => {
    await t.db.insert(profiles).values([
      { id: uuid(100), role: 'vendor_admin', vendorId: PRIMARY },
      { id: uuid(104), role: 'vendor_admin', vendorId: PRIMARY },
    ]);
    const owners = await loadReviewOwners(t.db, P);
    await emailOwnersOfApprovedReview(ctx(), t.db, owners, EMAIL_REVIEW, seatEmails);
    const keys = vi
      .mocked(sendVendorReviewPublishedEmail)
      .mock.calls.map((c) => c[1].dedupeKey)
      .sort();
    expect(keys).toEqual([
      vendorReviewPublishedKey(REVIEW.id, uuid(100)),
      vendorReviewPublishedKey(REVIEW.id, uuid(104)),
    ]);
    expect(keys[0]).toBe(`vendor-review-published:${REVIEW.id}:${uuid(100)}`);
  });

  it('sends nothing to an owner with no seat', async () => {
    const owners = await loadReviewOwners(t.db, P);
    await emailOwnersOfApprovedReview(ctx(), t.db, owners, EMAIL_REVIEW, seatEmails);
    expect(sendVendorReviewPublishedEmail).not.toHaveBeenCalled();
  });

  it('keeps at most WORKER_CONNECTION_LIMIT sends in flight', async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      vendorId: uuid(200 + i),
      vendorSlug: `v${i}`,
    }));
    await t.db
      .insert(vendors)
      .values(many.map((o) => ({ id: o.vendorId, slug: o.vendorSlug, companyName: o.vendorSlug })));
    await t.db
      .insert(profiles)
      .values(
        many.map((o, i) => ({ id: uuid(300 + i), role: 'vendor_admin', vendorId: o.vendorId })),
      );

    let inFlight = 0;
    let peak = 0;
    vi.mocked(sendVendorReviewPublishedEmail).mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return 'sent';
    });

    await emailOwnersOfApprovedReview(ctx(), t.db, many, EMAIL_REVIEW, seatEmails);
    expect(sendVendorReviewPublishedEmail).toHaveBeenCalledTimes(15);
    expect(peak).toBeLessThanOrEqual(WORKER_CONNECTION_LIMIT);
    expect(peak).toBeGreaterThan(1);
  });

  it('never throws: a failed address lookup or send only warns', async () => {
    await t.db.insert(profiles).values({ id: uuid(100), role: 'vendor_admin', vendorId: PRIMARY });
    const owners = await loadReviewOwners(t.db, P);
    await expect(
      emailOwnersOfApprovedReview(ctx(), t.db, owners, EMAIL_REVIEW, async () => {
        throw new Error('GoTrue down');
      }),
    ).resolves.toBeUndefined();

    vi.mocked(sendVendorReviewPublishedEmail).mockRejectedValueOnce(new Error('boom'));
    await expect(
      emailOwnersOfApprovedReview(ctx(), t.db, owners, EMAIL_REVIEW, seatEmails),
    ).resolves.toBeUndefined();
    expect(vi.mocked(logToPosthog).mock.calls.map((c) => c[3].outcome)).toEqual([
      'GoTrue down',
      'boom',
    ]);
  });
});
