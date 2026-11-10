/**
 * The active-entitlement test behind the AECI-1186 re-crawl gate. DB-free: it reads
 * the session the vendor guard already populated, so no harness is needed.
 */

import { describe, expect, it } from 'vitest';

import { hasActiveEntitlement } from './integration-entitlement';

describe('hasActiveEntitlement', () => {
  it('is true for a session that resolved to a paid tier', () => {
    expect(
      hasActiveEntitlement({
        entitlementTier: 'verified',
        entitlement: { status: 'active', periodEnd: null },
      }),
    ).toBe(true);
  });

  it('is false with no entitlement row (a §8.9 catalogue seat)', () => {
    expect(hasActiveEntitlement({ entitlementTier: 'unclaimed', entitlement: null })).toBe(false);
  });

  it.each(['pending', 'expired', 'revoked'] as const)(
    'is false for a %s row, which tierFor resolves to unclaimed',
    (status) => {
      expect(
        hasActiveEntitlement({
          entitlementTier: 'unclaimed',
          entitlement: { status, periodEnd: null },
        }),
      ).toBe(false);
    },
  );
});
