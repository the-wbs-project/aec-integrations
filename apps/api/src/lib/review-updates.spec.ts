/**
 * AECI-1872 (ruling 42) build condition (d): a public review carries the
 * reviewer's words only. The published vendor reply and the reviewer's update ride
 * beside the review in their own fields, and never enter its title or body. The
 * public product page, `GET /api/products/:slug` and `GET /api/products/:slug/reviews`
 * all build their reviews through `attachReviewExtras`.
 */
import { describe, expect, it } from 'vitest';

import type { PublicReviewUpdate, PublicVendorResponse } from '@aeci/shared';

import type { RawPublicReviewRow } from './drizzle-helpers';
import { attachReviewExtras } from './review-updates';

const ROW: RawPublicReviewRow = {
  id: 'r-1',
  ratingOverall: 4,
  ratingOnboarding: 3,
  title: 'Saves hours',
  body: 'The reviewer wrote this and only this.',
  roleAtCompany: 'manager',
  yearsUsing: 2,
  wouldRecommend: 'yes',
  createdAt: '2026-09-01T10:00:00.000Z',
};

const REPLY: PublicVendorResponse = {
  vendor_slug: 'autodesk',
  vendor_name: 'Autodesk',
  body: 'VENDOR REPLY TEXT, fixed in 3.0.',
  published_at: '2026-09-11T10:00:00.000Z',
};

const UPDATE: PublicReviewUpdate = {
  body: 'REVIEWER UPDATE TEXT.',
  rating_overall: 5,
  rating_onboarding: 4,
  published_at: '2026-10-05T10:00:00.000Z',
};

describe('attachReviewExtras: a public review carries the reviewer words only (AECI-1872)', () => {
  const [review] = attachReviewExtras(
    [ROW],
    new Map([[ROW.id, [REPLY]]]),
    new Map([[ROW.id, [UPDATE]]]),
  );

  it('keeps the review title and body exactly as the reviewer wrote them', () => {
    expect(review!.title).toBe(ROW.title);
    expect(review!.body).toBe(ROW.body);
  });

  it('never puts reply or update text into the review own fields', () => {
    const { vendor_responses, updates, ...own } = review!;
    const ownText = JSON.stringify(own);
    expect(ownText).not.toContain('VENDOR REPLY TEXT');
    expect(ownText).not.toContain('REVIEWER UPDATE TEXT');
    expect(vendor_responses).toEqual([REPLY]);
    expect(updates).toEqual([UPDATE]);
  });

  it('gives a review with no reply an empty reply list and the same own fields', () => {
    const [plain] = attachReviewExtras([ROW], new Map(), new Map());
    const { vendor_responses, updates, ...own } = plain!;
    const { vendor_responses: _r, updates: _u, ...withReplyOwn } = review!;
    expect(vendor_responses).toEqual([]);
    expect(updates).toEqual([]);
    expect(own).toEqual(withReplyOwn);
  });
});
