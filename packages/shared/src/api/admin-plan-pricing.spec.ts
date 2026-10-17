import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PLAN_PRICE,
  MANAGED_ANNUAL_PRICE_CENTS,
  MANAGED_LIST_PRICE_CENTS,
  planPriceDisplay,
} from '../entitlements';
import { VendorEntitlementBlockSchema } from './admin-entitlements';
import { PlanPriceSchema, VendorPlanPricingResponseSchema } from './admin-plan-pricing';

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

  // VENDOR_PROGRAM_PAGE_SPEC.md §1.1 decision 3: $250 a year per product.
  it('keeps the public annual price at $250', () => {
    expect(MANAGED_ANNUAL_PRICE_CENTS).toBe(25000);
  });
});
