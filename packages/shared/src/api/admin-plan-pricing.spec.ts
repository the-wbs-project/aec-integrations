import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PLAN_PRICE,
  MANAGED_LIST_PRICE_CENTS,
  MANAGED_PRICE_CENTS_MAX,
  PLAN_PRICE_MESSAGE_MAX,
  planPriceDisplay,
} from '../entitlements';
import { VendorEntitlementBlockSchema } from './admin-entitlements';
import {
  PlanPriceSchema,
  SetVendorPlanPricingSchema,
  VendorPlanPricingResponseSchema,
} from './admin-plan-pricing';

const ok = (body: unknown) => SetVendorPlanPricingSchema.safeParse(body).success;

describe('SetVendorPlanPricingSchema', () => {
  it('accepts a price override with no message', () => {
    expect(SetVendorPlanPricingSchema.parse({ managed_price_cents: 1250, message: null })).toEqual({
      managed_price_cents: 1250,
      message: null,
    });
  });

  it('accepts both null, which resets to the default', () => {
    expect(SetVendorPlanPricingSchema.parse({ managed_price_cents: null, message: null })).toEqual(
      DEFAULT_PLAN_PRICE,
    );
  });

  it('accepts the price bounds and refuses outside them', () => {
    expect(ok({ managed_price_cents: 0, message: null })).toBe(true);
    expect(ok({ managed_price_cents: MANAGED_PRICE_CENTS_MAX, message: null })).toBe(true);
    expect(ok({ managed_price_cents: MANAGED_PRICE_CENTS_MAX + 1, message: null })).toBe(false);
    expect(ok({ managed_price_cents: -1, message: null })).toBe(false);
  });

  it('refuses a fractional or string price: the wire unit is whole cents', () => {
    expect(ok({ managed_price_cents: 12.5, message: null })).toBe(false);
    expect(ok({ managed_price_cents: '1250', message: null })).toBe(false);
  });

  it('requires both keys, because a PUT is a full replacement', () => {
    expect(ok({ managed_price_cents: 1250 })).toBe(false);
    expect(ok({ message: 'Free until December' })).toBe(false);
  });

  it('trims the message and folds whitespace runs, newlines included', () => {
    const parsed = SetVendorPlanPricingSchema.parse({
      managed_price_cents: null,
      message: '  Free until December 12,\n then 50% off  ',
    });
    expect(parsed.message).toBe('Free until December 12, then 50% off');
  });

  it('turns an empty or blank message into null', () => {
    expect(
      SetVendorPlanPricingSchema.parse({ managed_price_cents: null, message: '' }).message,
    ).toBe(null);
    expect(
      SetVendorPlanPricingSchema.parse({ managed_price_cents: null, message: '   ' }).message,
    ).toBe(null);
  });

  it('caps the message at the limit after trimming', () => {
    const atCap = 'x'.repeat(PLAN_PRICE_MESSAGE_MAX);
    expect(ok({ managed_price_cents: null, message: `  ${atCap}  ` })).toBe(true);
    expect(ok({ managed_price_cents: null, message: `${atCap}x` })).toBe(false);
  });

  it('refuses markup: the message is plain text', () => {
    expect(ok({ managed_price_cents: null, message: '<b>Free</b> until December' })).toBe(false);
    expect(ok({ managed_price_cents: null, message: 'Free <!-- x --> now' })).toBe(false);
    // A bare comparison sign is not markup.
    expect(ok({ managed_price_cents: null, message: 'Under $10 < list price' })).toBe(true);
  });

  it('refuses a stray control character', () => {
    expect(ok({ managed_price_cents: null, message: 'Free\u0000 until December' })).toBe(false);
  });
});

describe('the vendor-facing price block', () => {
  it('is required on VendorEntitlementBlock (R10: a missed builder fails in dev)', () => {
    const block = {
      tier: 'unclaimed',
      status: null,
      period_end: null,
      ended_at: null,
      capabilities: [],
    };
    expect(VendorEntitlementBlockSchema.safeParse(block).success).toBe(false);
    expect(
      VendorEntitlementBlockSchema.safeParse({ ...block, price: DEFAULT_PLAN_PRICE }).success,
    ).toBe(true);
  });

  it('never carries who set the override', () => {
    expect(Object.keys(PlanPriceSchema.shape).sort()).toEqual(['managed_price_cents', 'message']);
    expect(Object.keys(VendorPlanPricingResponseSchema.shape)).toContain('updated_by');
  });
});

describe('planPriceDisplay precedence', () => {
  it('is the default with no override', () => {
    expect(planPriceDisplay(DEFAULT_PLAN_PRICE)).toEqual({ kind: 'default' });
    expect(planPriceDisplay(null)).toEqual({ kind: 'default' });
    expect(planPriceDisplay(undefined)).toEqual({ kind: 'default' });
  });

  it('shows a price override', () => {
    expect(planPriceDisplay({ managed_price_cents: 1250, message: null })).toEqual({
      kind: 'price',
      cents: 1250,
    });
  });

  it('shows a zero price as a price, not as the default', () => {
    expect(planPriceDisplay({ managed_price_cents: 0, message: null })).toEqual({
      kind: 'price',
      cents: 0,
    });
  });

  it('lets a message beat a price', () => {
    expect(planPriceDisplay({ managed_price_cents: 1250, message: 'Free until December' })).toEqual(
      { kind: 'message', text: 'Free until December' },
    );
  });

  it('ignores a blank message', () => {
    expect(planPriceDisplay({ managed_price_cents: null, message: '  ' })).toEqual({
      kind: 'default',
    });
  });

  it('keeps the default list price at $25', () => {
    expect(MANAGED_LIST_PRICE_CENTS).toBe(2500);
  });
});
