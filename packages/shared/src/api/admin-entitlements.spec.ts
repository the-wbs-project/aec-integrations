import { describe, expect, it } from 'vitest';

import { MANAGED_ANNUAL_PRICE_CENTS, MANAGED_LIST_PRICE_CENTS, TIERS } from '../entitlements';
import {
  EntitlementTermDateSchema,
  EntitlementTierSchema,
  VendorEntitlementBlockSchema,
} from './admin-entitlements';

describe('EntitlementTierSchema', () => {
  it('derives its tier enum from the registry, so a new rung needs no schema edit', () => {
    expect(EntitlementTierSchema.options).toEqual([...TIERS]);
  });
});

describe('EntitlementTermDateSchema', () => {
  it('accepts a date-only value and a full ISO timestamp', () => {
    expect(EntitlementTermDateSchema.safeParse('2027-09-01').success).toBe(true);
    expect(EntitlementTermDateSchema.safeParse('2027-09-01T00:00:00.000Z').success).toBe(true);
  });

  it('rejects a malformed term boundary', () => {
    expect(EntitlementTermDateSchema.safeParse('next year').success).toBe(false);
  });
});

// AECI-1357 (E1.8): the per-vendor price override is retired (VENDOR_SIGNUP_PROCESS.md
// §2 decision 8). The block carries no price, and the two list prices are constants.
describe('VendorEntitlementBlockSchema', () => {
  it('carries no price block', () => {
    expect(Object.keys(VendorEntitlementBlockSchema.shape)).not.toContain('price');
    const block = {
      tier: 'unclaimed',
      status: null,
      period_end: null,
      ended_at: null,
      capabilities: [],
    };
    expect(VendorEntitlementBlockSchema.safeParse(block).success).toBe(true);
  });
});

describe('Managed list prices', () => {
  it('keeps the monthly list price at $25', () => {
    expect(MANAGED_LIST_PRICE_CENTS).toBe(2500);
  });

  // VENDOR_PROGRAM_PAGE_SPEC.md §1.1 decision 3: $250 a year per product.
  it('keeps the public annual price at $250', () => {
    expect(MANAGED_ANNUAL_PRICE_CENTS).toBe(25000);
  });
});
