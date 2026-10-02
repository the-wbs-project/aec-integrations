/**
 * The "Looks right" contracts (AECI-1216 / `STAGE_2_PAID_TIERS_SPEC.md` §13.8–§13.9).
 *
 * The request body is the interesting half. It must accept the empty object every
 * client sends and refuse anything else, so an edit posted to the wrong route is a
 * 400 rather than a review stamp that silently drops the edit.
 */

import { describe, expect, it } from 'vitest';

import {
  ReviewVendorProductIntegrationsResponseSchema,
  ReviewVendorProductResponseSchema,
  ReviewVendorProfileResponseSchema,
  ReviewVendorRecordSchema,
} from './vendor';

const PRODUCT = '00000000-0000-4000-8000-000000000010';
const NOW = '2026-10-02T09:00:00.000Z';

describe('ReviewVendorRecordSchema', () => {
  it('accepts the empty object', () => {
    expect(ReviewVendorRecordSchema.parse({})).toEqual({});
  });

  it('refuses any field, so an edit sent here is not silently dropped', () => {
    expect(ReviewVendorRecordSchema.safeParse({ description: 'New blurb' }).success).toBe(false);
  });

  it('refuses a non-object body', () => {
    expect(ReviewVendorRecordSchema.safeParse([]).success).toBe(false);
    expect(ReviewVendorRecordSchema.safeParse(null).success).toBe(false);
    expect(ReviewVendorRecordSchema.safeParse('ok').success).toBe(false);
  });
});

describe('Review response schemas', () => {
  it('parses the profile response', () => {
    expect(ReviewVendorProfileResponseSchema.parse({ last_reviewed_at: NOW })).toEqual({
      last_reviewed_at: NOW,
    });
    expect(ReviewVendorProfileResponseSchema.safeParse({ last_reviewed_at: null }).success).toBe(
      false,
    );
  });

  it('parses the product response', () => {
    const body = { product_id: PRODUCT, last_reviewed_at: NOW };
    expect(ReviewVendorProductResponseSchema.parse(body)).toEqual(body);
    expect(
      ReviewVendorProductResponseSchema.safeParse({ ...body, product_id: 'revit' }).success,
    ).toBe(false);
  });

  it('parses the integration-list response, including a zero count', () => {
    const body = { product_id: PRODUCT, integrations_reviewed_at: NOW, stamped_count: 0 };
    expect(ReviewVendorProductIntegrationsResponseSchema.parse(body)).toEqual(body);
    expect(
      ReviewVendorProductIntegrationsResponseSchema.safeParse({ ...body, stamped_count: -1 })
        .success,
    ).toBe(false);
    expect(
      ReviewVendorProductIntegrationsResponseSchema.safeParse({ ...body, stamped_count: 1.5 })
        .success,
    ).toBe(false);
  });
});
