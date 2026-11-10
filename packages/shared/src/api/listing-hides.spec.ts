import { describe, expect, it } from 'vitest';

import { AdminListingHideBodySchema, AdminListingRestoreBodySchema } from './listing-hides';

const base = { kind: 'lawful_order', reason: 'A court order.', receivedAt: '2026-11-08' };

describe('AdminListingHideBodySchema (AECI-1238)', () => {
  it('accepts each kind, with the source optional outside a complaint', () => {
    expect(AdminListingHideBodySchema.safeParse(base).success).toBe(true);
    expect(AdminListingHideBodySchema.safeParse({ ...base, kind: 'defunct' }).success).toBe(true);
  });

  it('requires an https source for a complaint under review', () => {
    const complaint = { ...base, kind: 'complaint_under_review' };
    expect(AdminListingHideBodySchema.safeParse(complaint).success).toBe(false);
    expect(
      AdminListingHideBodySchema.safeParse({ ...complaint, sourceUrl: 'http://x.test' }).success,
    ).toBe(false);
    expect(
      AdminListingHideBodySchema.safeParse({ ...complaint, sourceUrl: 'https://x.test/a' }).success,
    ).toBe(true);
  });

  it('refuses an unknown kind, a blank reason, a bad date and a future date', () => {
    for (const body of [
      { ...base, kind: 'other' },
      { ...base, reason: '   ' },
      { ...base, receivedAt: '8 Nov 2026' },
      { ...base, receivedAt: '2099-01-01' },
    ]) {
      expect(AdminListingHideBodySchema.safeParse(body).success).toBe(false);
    }
  });

  it('drops a blank internal note on a restore', () => {
    expect(AdminListingRestoreBodySchema.parse({ reason: 'Done.', internalNote: ' ' })).toEqual({
      reason: 'Done.',
    });
  });
});
