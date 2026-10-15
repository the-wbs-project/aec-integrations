import { describe, expect, it } from 'vitest';

import { ClaimGrantSummarySchema, ModerateClaimSchema } from './admin-claims';

/** AECI-1367: every approval lands on Free, so approve takes no plan. */
describe('ModerateClaimSchema', () => {
  it('accepts an approve with no plan', () => {
    expect(ModerateClaimSchema.parse({ action: 'approve' })).toEqual({ action: 'approve' });
    expect(ModerateClaimSchema.parse({ action: 'approve', reason: 'ok' })).toEqual({
      action: 'approve',
      reason: 'ok',
    });
  });

  it.each(['free', 'managed'] as const)(
    'refuses an approve that names plan %s, on field `plan`',
    (plan) => {
      const result = ModerateClaimSchema.safeParse({ action: 'approve', plan });
      expect(result.success).toBe(false);
      expect(result.error!.issues[0]!.path).toEqual(['plan']);
    },
  );

  it('refuses an approve that carries entitlement details, on field `entitlement`', () => {
    const result = ModerateClaimSchema.safeParse({
      action: 'approve',
      entitlement: { notes: 'PO 4417' },
    });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.path).toEqual(['entitlement']);
  });

  it('accepts a reject, and strips a plan if sent', () => {
    expect(ModerateClaimSchema.parse({ action: 'reject', reason: 'no' })).toEqual({
      action: 'reject',
      reason: 'no',
    });
    expect(ModerateClaimSchema.parse({ action: 'reject', plan: 'free' })).toEqual({
      action: 'reject',
    });
  });
});

describe('ClaimGrantSummarySchema', () => {
  const base = {
    user_id: '77777777-7777-4777-8777-777777777777',
    vendor_id: '11111111-1111-4111-8111-111111111111',
    verified: false,
    identity_outcome: 'linked',
    seat_created: true,
    tier: 'unclaimed',
  };

  it('requires tier (R10: a forgotten construction site must fail)', () => {
    const { tier: _tier, ...noTier } = base;
    expect(ClaimGrantSummarySchema.safeParse(noTier).success).toBe(false);
    expect(ClaimGrantSummarySchema.parse(base).tier).toBe('unclaimed');
  });

  it('no longer carries plan or entitlement_created', () => {
    const parsed = ClaimGrantSummarySchema.parse({
      ...base,
      plan: 'free',
      entitlement_created: false,
    });
    expect(parsed).not.toHaveProperty('plan');
    expect(parsed).not.toHaveProperty('entitlement_created');
  });
});
