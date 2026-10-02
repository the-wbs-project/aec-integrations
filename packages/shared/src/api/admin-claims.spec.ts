import { describe, expect, it } from 'vitest';

import { ClaimGrantSummarySchema, ModerateClaimSchema } from './admin-claims';

/** AECI-1215 / `STAGE_2_PAID_TIERS_SPEC.md` §13.6: approve must name a plan. */
describe('ModerateClaimSchema', () => {
  it.each(['free', 'managed'] as const)('accepts an approve with plan %s', (plan) => {
    expect(ModerateClaimSchema.parse({ action: 'approve', plan })).toEqual({
      action: 'approve',
      plan,
    });
  });

  it('refuses an approve with no plan, on field `plan` (there is no default)', () => {
    const result = ModerateClaimSchema.safeParse({ action: 'approve' });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.path).toEqual(['plan']);
  });

  it('refuses a plan outside free | managed', () => {
    expect(ModerateClaimSchema.safeParse({ action: 'approve', plan: 'verified' }).success).toBe(
      false,
    );
  });

  it('accepts entitlement details with plan managed', () => {
    const parsed = ModerateClaimSchema.parse({
      action: 'approve',
      plan: 'managed',
      entitlement: { notes: 'PO 4417' },
    });
    expect(parsed).toMatchObject({ plan: 'managed', entitlement: { notes: 'PO 4417' } });
  });

  it('refuses entitlement details with plan free', () => {
    const result = ModerateClaimSchema.safeParse({
      action: 'approve',
      plan: 'free',
      entitlement: { notes: 'PO 4417' },
    });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.path).toEqual(['entitlement']);
  });

  it('accepts a reject with no plan, and strips one if sent', () => {
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
    entitlement_created: false,
  };

  it('requires the chosen plan (R10: a forgotten construction site must fail)', () => {
    expect(ClaimGrantSummarySchema.safeParse(base).success).toBe(false);
    expect(ClaimGrantSummarySchema.parse({ ...base, plan: 'free' }).plan).toBe('free');
  });
});
