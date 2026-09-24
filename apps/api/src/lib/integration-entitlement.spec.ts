/**
 * The carve-out entitlement gate (AECI-1089 / AECI-1040 ruling 2). DB-free: it reads
 * the session the vendor guard already populated, so no harness is needed.
 */

import { ApiErrorCode } from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import { ApiError } from '../errors';
import type { AuthzContext, AuthzVariables } from './authz';
import {
  hasActiveEntitlement,
  integrationEntitlementRequired,
  requireActiveEntitlement,
} from './integration-entitlement';

const ctxFor = (auth: Partial<AuthzVariables['auth']>) =>
  ({
    get: () => ({
      userId: 'u',
      role: 'vendor_admin',
      vendorId: 'v-1',
      entitlementTier: 'unclaimed',
      entitlement: null,
      ...auth,
    }),
  }) as unknown as AuthzContext;

function thrownBy(fn: () => void): ApiError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error('expected a throw');
}

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

describe('requireActiveEntitlement', () => {
  it('passes an active entitlement', () => {
    expect(() =>
      requireActiveEntitlement(
        ctxFor({ entitlementTier: 'verified', entitlement: { status: 'active', periodEnd: null } }),
      ),
    ).not.toThrow();
  });

  it('refuses a seat with no entitlement: 403 INTEGRATION_ENTITLEMENT_REQUIRED, status null', () => {
    const err = thrownBy(() => requireActiveEntitlement(ctxFor({})));
    expect(err.status).toBe(403);
    expect(err.code).toBe(ApiErrorCode.INTEGRATION_ENTITLEMENT_REQUIRED);
    // Its own code, not ENTITLEMENT_REQUIRED: this gate names no capability.
    expect(err.code).not.toBe(ApiErrorCode.ENTITLEMENT_REQUIRED);
    expect(err.details).toEqual({ tier: 'unclaimed', status: null });
  });

  it('refuses a lapsed entitlement and says which status it is', () => {
    const err = thrownBy(() =>
      requireActiveEntitlement(
        ctxFor({
          entitlementTier: 'unclaimed',
          entitlement: { status: 'expired', periodEnd: '2026-01-01T00:00:00.000Z' },
        }),
      ),
    );
    expect(err.details).toEqual({ tier: 'unclaimed', status: 'expired' });
  });

  it('copy points at activation, never at ranking or placement', () => {
    const err = integrationEntitlementRequired({ entitlementTier: 'unclaimed', entitlement: null });
    expect(err.message).toMatch(/activate/i);
    expect(err.message).not.toMatch(/rank|placement|position|boost|search/i);
  });
});
