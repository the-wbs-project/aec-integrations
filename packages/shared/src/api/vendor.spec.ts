/** The plan read shapes on `GET /api/vendor/me`. Moved from the deleted
 *  `admin-entitlements.spec.ts` (AECI-1358). */

import { describe, expect, it } from 'vitest';

import { TIERS } from '../entitlements';
import { EntitlementTierSchema, VendorEntitlementBlockSchema } from './vendor';

describe('EntitlementTierSchema', () => {
  it('derives its tier enum from the registry, so a new rung needs no schema edit', () => {
    expect(EntitlementTierSchema.options).toEqual([...TIERS]);
  });
});

// AECI-1357 (E1.8): the per-vendor price override is retired (VENDOR_SIGNUP_PROCESS.md
// §2 decision 8). The block carries no price.
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
