import { describe, expect, it } from 'vitest';

import { TIERS } from '../entitlements';
import {
  EntitlementTierSchema,
  SetVendorEntitlementSchema,
  VendorEntitlementResponseSchema,
} from './admin-entitlements';

describe('SetVendorEntitlementSchema', () => {
  it('accepts a minimal set with a date-only term', () => {
    const parsed = SetVendorEntitlementSchema.parse({
      action: 'set',
      tier: 'verified',
      period_start: '2026-09-01',
      period_end: '2027-09-01',
      payer: 'Acme Corp',
      amount: 'USD 5,000 / yr',
      invoice_ref: 'PO-4417',
    });
    expect(parsed.action).toBe('set');
    expect(parsed.tier).toBe('verified');
    expect(parsed.period_end).toBe('2027-09-01');
  });

  it('accepts a bare clear — the arrangement fields are all optional', () => {
    expect(SetVendorEntitlementSchema.parse({ action: 'clear' })).toEqual({ action: 'clear' });
  });

  it('accepts a full ISO timestamp as a term boundary', () => {
    expect(
      SetVendorEntitlementSchema.safeParse({
        action: 'renew',
        period_end: '2027-09-01T00:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown action', () => {
    expect(SetVendorEntitlementSchema.safeParse({ action: 'revoke' }).success).toBe(false);
  });

  it('rejects an unknown tier', () => {
    expect(
      SetVendorEntitlementSchema.safeParse({ action: 'set', tier: 'enterprise' }).success,
    ).toBe(false);
  });

  it('rejects a malformed term boundary', () => {
    expect(
      SetVendorEntitlementSchema.safeParse({ action: 'set', period_end: 'next year' }).success,
    ).toBe(false);
  });

  it('rejects `verified` in the body — the mirror has one writer (§2.1)', () => {
    const parsed = SetVendorEntitlementSchema.parse({ action: 'set', verified: true } as never);
    expect(parsed).not.toHaveProperty('verified');
  });

  it('derives its tier enum from the registry, so a new rung needs no schema edit', () => {
    expect(EntitlementTierSchema.options).toEqual([...TIERS]);
  });
});

describe('VendorEntitlementResponseSchema', () => {
  const row = {
    vendor_id: '3f6a9c2e-5d41-4b8a-9f0e-1c2d3e4f5a6b',
    tier: 'verified',
    status: 'active',
    period_start: '2026-09-01',
    period_end: null,
    granted_at: '2026-09-01T12:00:00.000Z',
    ended_at: null,
    verified: true,
    payer: 'Acme Corp',
    amount: 'USD 5,000 / yr',
    terms: null,
    arranged_by: null,
    invoice_ref: 'PO-4417',
    notes: null,
  };

  it('accepts a perpetual entitlement (null period_end)', () => {
    expect(VendorEntitlementResponseSchema.parse(row).period_end).toBeNull();
  });

  it('accepts every status in the vocabulary', () => {
    for (const status of ['pending', 'active', 'expired', 'revoked']) {
      expect(VendorEntitlementResponseSchema.safeParse({ ...row, status }).success).toBe(true);
    }
  });

  it('rejects a missing field rather than defaulting it (R10)', () => {
    const { verified: _verified, ...withoutMirror } = row;
    expect(VendorEntitlementResponseSchema.safeParse(withoutMirror).success).toBe(false);
  });
});
