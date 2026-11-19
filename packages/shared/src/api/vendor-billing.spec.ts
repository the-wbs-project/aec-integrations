import { describe, expect, it } from 'vitest';

import {
  AddStripeLicensesRequestSchema,
  StripeCheckoutRequestSchema,
  unusedAfterPurchase,
} from './vendor-billing';

describe('unusedAfterPurchase (AECI-1865)', () => {
  it('counts what one product cannot hold', () => {
    expect(unusedAfterPurchase({ quantity: 3, pool: 0, productsWithoutSubscription: 1 })).toBe(2);
  });

  it('is zero when every subscription has a product', () => {
    expect(unusedAfterPurchase({ quantity: 2, pool: 0, productsWithoutSubscription: 2 })).toBe(0);
  });

  it('counts the spares already in the pool', () => {
    expect(unusedAfterPurchase({ quantity: 1, pool: 1, productsWithoutSubscription: 1 })).toBe(1);
  });

  it('never goes below zero', () => {
    expect(unusedAfterPurchase({ quantity: 1, pool: 0, productsWithoutSubscription: 5 })).toBe(0);
  });
});

describe('unused_acknowledged on the purchase bodies', () => {
  it('is optional and takes a non-negative integer', () => {
    expect(
      StripeCheckoutRequestSchema.safeParse({ quantity: 1, interval: 'year', signer_title: 'CEO' })
        .success,
    ).toBe(true);
    expect(
      AddStripeLicensesRequestSchema.safeParse({ quantity: 1, unused_acknowledged: 2 }).success,
    ).toBe(true);
    expect(
      AddStripeLicensesRequestSchema.safeParse({ quantity: 1, unused_acknowledged: -1 }).success,
    ).toBe(false);
    expect(
      AddStripeLicensesRequestSchema.safeParse({ quantity: 1, unused_acknowledged: 1.5 }).success,
    ).toBe(false);
  });
});
