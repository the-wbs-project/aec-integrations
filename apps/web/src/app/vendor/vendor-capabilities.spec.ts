import { signal } from '@angular/core';
import { describe, expect, it } from 'vitest';

import { capabilitiesFor, type Capability } from '@aeci/shared/entitlements';
import type { VendorMeResponse } from '@aeci/shared';

import { isCatalogueSeat, productCan, vendorCan } from './vendor-capabilities';
import type { VendorPortalStore } from './vendor-portal-store';

const connector = { product_role: 'connector' };
const application = { product_role: 'application' };

/**
 * The §8.9 catalogue-seat rule (`STAGE_2_SPEC.md` §8.9, AECI-724 / AECI-1082).
 * The plan panel and the read-only notices both read it, so it is pinned once here.
 */
describe('isCatalogueSeat', () => {
  it('is true with no entitlement row and a connector-role product', () => {
    expect(isCatalogueSeat(null, [application, connector])).toBe(true);
  });

  it('is false for a never-arranged vendor with no connector product', () => {
    expect(isCatalogueSeat(null, [application])).toBe(false);
    expect(isCatalogueSeat(null, [])).toBe(false);
  });

  it('is false once any entitlement row exists, lapsed or not', () => {
    for (const status of ['active', 'pending', 'expired', 'revoked']) {
      expect(isCatalogueSeat(status, [connector])).toBe(false);
    }
  });

  it('is false before the store is seeded', () => {
    expect(isCatalogueSeat(undefined, [connector])).toBe(false);
  });
});

/** A product carrying only what `productCan` reads. */
const withPlan = (capabilities: readonly Capability[]) => ({ plan: { capabilities } });

describe('productCan (AECI-1214, §13.7)', () => {
  it('reads the product plan, Free and Managed', () => {
    const free = withPlan(capabilitiesFor('unclaimed'));
    expect(productCan(free, 'product.listing.edit')).toBe(true);
    expect(productCan(free, 'product.categories.edit')).toBe(true);
    expect(productCan(free, 'product.edit')).toBe(false);
    expect(productCan(free, 'product.taxonomy.edit')).toBe(false);
    expect(productCan(free, 'product.usefulness.edit')).toBe(false);

    const managed = withPlan(capabilitiesFor('verified'));
    expect(productCan(managed, 'product.edit')).toBe(true);
    expect(productCan(managed, 'product.taxonomy.edit')).toBe(true);
  });

  it('is closed with no product', () => {
    expect(productCan(null, 'product.listing.edit')).toBe(false);
    expect(productCan(undefined, 'product.listing.edit')).toBe(false);
  });

  it('reads the product, not the vendor', () => {
    // Two products on different plans answer differently. The server cannot
    // produce this yet, which is the point: no screen changes when it can.
    expect(productCan(withPlan([]), 'product.listing.edit')).toBe(false);
    expect(productCan(withPlan(['product.listing.edit']), 'product.listing.edit')).toBe(true);
  });
});

describe('vendorCan', () => {
  const storeWith = (capabilities: readonly Capability[] | null) =>
    ({
      me: signal(
        capabilities === null
          ? null
          : ({ entitlement: { capabilities } } as unknown as VendorMeResponse),
      ),
    }) as unknown as VendorPortalStore;

  it('lets a seat with no plan edit company details (§13.3)', () => {
    expect(vendorCan(storeWith(capabilitiesFor('unclaimed')), 'profile.edit')()).toBe(true);
    expect(vendorCan(storeWith(capabilitiesFor('unclaimed')), 'attestation.author')()).toBe(false);
  });

  it('is false before the store is seeded', () => {
    expect(vendorCan(storeWith(null), 'profile.edit')()).toBe(false);
  });
});
