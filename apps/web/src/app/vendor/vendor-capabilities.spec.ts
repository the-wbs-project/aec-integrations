import { describe, expect, it } from 'vitest';

import { isCatalogueSeat } from './vendor-capabilities';

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
