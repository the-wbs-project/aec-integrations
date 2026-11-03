import { describe, expect, it } from 'vitest';

import { VendorRevisionsSchema, VENDOR_PORTAL_SCOPES } from './vendor-updates';

/** The ten scopes of the freshness cursor (`STAGE_2_REALTIME_SPEC.md` §2). */
describe('VENDOR_PORTAL_SCOPES', () => {
  it('lists every scope once, in wire order', () => {
    expect(VENDOR_PORTAL_SCOPES).toEqual([
      'profile',
      'entitlement',
      'products',
      'integrations',
      'notifications',
      'requests',
      'contests',
      'catalogue',
      'reviews',
      'threads',
    ]);
  });
});

/** AECI-1538, `STAGE_2_ATTESTATIONS_SPEC.md` §15.9. */
describe('the threads cursor scope', () => {
  const preThreads = {
    profile: null,
    entitlement: null,
    products: null,
    integrations: null,
    notifications: null,
    requests: null,
    contests: null,
    catalogue: null,
    reviews: null,
  };

  it('defaults to null when an older API omits the key (deploy skew)', () => {
    expect(VendorRevisionsSchema.parse(preThreads).threads).toBeNull();
  });

  it('carries a timestamp through unchanged', () => {
    const at = '2026-10-29T07:00:00.000Z';
    expect(VendorRevisionsSchema.parse({ ...preThreads, threads: at }).threads).toBe(at);
  });

  it('rejects a non-string value', () => {
    expect(VendorRevisionsSchema.safeParse({ ...preThreads, threads: 7 }).success).toBe(false);
  });
});
