/**
 * The `claim_added` feed member (AECI-1153 / `STAGE_2_ATTESTATIONS_SPEC.md` §7.6).
 *
 * `isAttestationNotification` classifies by naming every non-attestation kind,
 * because a pre-AECI-1008 row carries no `kind`. A kind it does not name reads as
 * an attestation row, so the new member must be named there.
 */

import { describe, expect, it } from 'vitest';

import {
  isAttestationNotification,
  ListVendorNotificationsResponseSchema,
  VendorClaimAddedNotificationSchema,
  VendorNotificationSchema,
  VendorReviewNotificationSchema,
  VendorReviewResponseNotificationSchema,
  VendorThreadMessageNotificationSchema,
  VendorThreadClosedNotificationSchema,
} from './vendor-notifications';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const CLAIM_ADDED = {
  kind: 'claim_added' as const,
  id: uuid(1),
  claim_id: uuid(2),
  integration_id: uuid(3),
  integration_name: 'Revit to MicroStation',
  data_object: { slug: 'rfis', name: 'RFIs' },
  direction: 'inbound' as const,
  added_by_name: 'Autodesk',
  counterpart_product: { slug: 'revit', name: 'Revit' },
  pair_path: '/products/microstation/integrations/revit',
  created_at: '2026-09-28T10:00:00.000Z',
};

describe('VendorClaimAddedNotificationSchema', () => {
  it('parses a feed row and keeps its kind through the union', () => {
    expect(VendorClaimAddedNotificationSchema.parse(CLAIM_ADDED)).toEqual(CLAIM_ADDED);
    const parsed = VendorNotificationSchema.parse(CLAIM_ADDED);
    expect(parsed.kind).toBe('claim_added');
    expect(ListVendorNotificationsResponseSchema.parse({ notifications: [CLAIM_ADDED] })).toEqual({
      notifications: [CLAIM_ADDED],
    });
  });

  it('carries no note field, and strips one a caller sends', () => {
    const parsed = VendorClaimAddedNotificationSchema.parse({ ...CLAIM_ADDED, note: 'private' });
    expect('note' in parsed).toBe(false);
  });

  it('refuses a stored A/B direction: the wire is caller-relative', () => {
    expect(
      VendorClaimAddedNotificationSchema.safeParse({ ...CLAIM_ADDED, direction: 'a_to_b' }).success,
    ).toBe(false);
  });
});

const REVIEW = {
  kind: 'review' as const,
  id: uuid(7),
  review_id: uuid(8),
  product: { slug: 'revit', name: 'Revit' },
  review_title: 'Solid for coordination',
  created_at: '2026-10-02T10:00:00.000Z',
};

const REVIEW_RESPONSE = {
  kind: 'review_response' as const,
  id: uuid(9),
  event: 'rejected' as const,
  response_id: uuid(10),
  review_id: uuid(8),
  product: { slug: 'revit', name: 'Revit' },
  reason: 'It is a sales pitch.',
  created_at: '2026-10-02T11:00:00.000Z',
};

describe('the review feed members (AECI-1180 / §11c.12)', () => {
  it('parses both and keeps their kind through the union', () => {
    expect(VendorReviewNotificationSchema.parse(REVIEW)).toEqual(REVIEW);
    expect(VendorReviewResponseNotificationSchema.parse(REVIEW_RESPONSE)).toEqual(REVIEW_RESPONSE);
    expect(VendorNotificationSchema.parse(REVIEW).kind).toBe('review');
    expect(VendorNotificationSchema.parse(REVIEW_RESPONSE).kind).toBe('review_response');
  });

  it('refuses a decision event the state machine does not have', () => {
    expect(
      VendorReviewResponseNotificationSchema.safeParse({ ...REVIEW_RESPONSE, event: 'withdrawn' })
        .success,
    ).toBe(false);
  });
});

const THREAD_MESSAGE = {
  kind: 'thread_message' as const,
  id: uuid(11),
  thread_id: uuid(12),
  message_id: uuid(13),
  claim_id: uuid(5),
  integration_id: uuid(6),
  data_object: { slug: 'drawings', name: 'Drawings' },
  from_vendor_name: 'Procore Technologies',
  pair_path: '/products/procore/integrations/revit',
  created_at: '2026-10-29T10:00:00.000Z',
};

describe('the thread_message feed member (AECI-1539 / §15.8)', () => {
  it('parses and keeps its kind through the union', () => {
    expect(VendorThreadMessageNotificationSchema.parse(THREAD_MESSAGE)).toEqual(THREAD_MESSAGE);
    expect(VendorNotificationSchema.parse(THREAD_MESSAGE).kind).toBe('thread_message');
  });

  it('strips a body key: the row never carries the message (§15.7)', () => {
    const parsed = VendorThreadMessageNotificationSchema.parse({
      ...THREAD_MESSAGE,
      body: 'private text',
    });
    expect(parsed).not.toHaveProperty('body');
  });
});

const THREAD_CLOSED = {
  kind: 'thread_closed' as const,
  id: uuid(14),
  thread_id: uuid(12),
  closed_reason: 'claim_removed' as const,
  data_object: { slug: 'drawings', name: 'Drawings' },
  other_vendor_name: 'Procore Technologies',
  created_at: '2026-10-30T10:00:00.000Z',
};

describe('the thread_closed feed member (AECI-1548 / §15.8)', () => {
  it('parses and keeps its kind through the union', () => {
    expect(VendorThreadClosedNotificationSchema.parse(THREAD_CLOSED)).toEqual(THREAD_CLOSED);
    expect(VendorNotificationSchema.parse(THREAD_CLOSED).kind).toBe('thread_closed');
    expect(isAttestationNotification(VendorNotificationSchema.parse(THREAD_CLOSED))).toBe(false);
  });

  it('accepts a row with no data object, and refuses an unknown close reason', () => {
    expect(
      VendorThreadClosedNotificationSchema.safeParse({ ...THREAD_CLOSED, data_object: null })
        .success,
    ).toBe(true);
    expect(
      VendorThreadClosedNotificationSchema.safeParse({ ...THREAD_CLOSED, closed_reason: 'gone' })
        .success,
    ).toBe(false);
  });
});

describe('isAttestationNotification', () => {
  it('does not read a thread_message row as an attestation row (AECI-1539)', () => {
    expect(isAttestationNotification(VendorNotificationSchema.parse(THREAD_MESSAGE))).toBe(false);
  });

  it('does not read a claim_added row as an attestation row', () => {
    expect(isAttestationNotification(VendorNotificationSchema.parse(CLAIM_ADDED))).toBe(false);
  });

  it('does not read a review or review_response row as an attestation row (AECI-1180)', () => {
    expect(isAttestationNotification(VendorNotificationSchema.parse(REVIEW))).toBe(false);
    expect(isAttestationNotification(VendorNotificationSchema.parse(REVIEW_RESPONSE))).toBe(false);
  });

  it('still reads a row with no kind as an attestation row', () => {
    const legacy = VendorNotificationSchema.parse({
      id: uuid(4),
      detector: 'claim-denied',
      claim_id: uuid(5),
      integration_id: uuid(6),
      data_object: null,
      counterpart_product: null,
      pair_path: null,
      created_at: '2026-09-01T00:00:00.000Z',
    });
    expect(isAttestationNotification(legacy)).toBe(true);
  });
});
