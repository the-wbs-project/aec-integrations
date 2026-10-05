import { describe, expect, it } from 'vitest';

import {
  ADMIN_REASON_MAX,
  AdminOverrideReasonSchema,
  AdminReasonSchema,
  REASON_VISIBILITY_VENDOR,
  vendorVisibleReason,
  vendorVisibleReasonMetadata,
} from './admin-reason';

describe('AdminReasonSchema', () => {
  it('accepts a reason and trims it', () => {
    expect(AdminReasonSchema.parse('  Logo was out of date.  ')).toBe('Logo was out of date.');
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace only', '   \n '],
    ['over the cap', 'x'.repeat(ADMIN_REASON_MAX + 1)],
  ])('refuses a reason that is %s', (_label, value) => {
    expect(AdminReasonSchema.safeParse(value).success).toBe(false);
  });
});

describe('AdminOverrideReasonSchema (AECI-1159)', () => {
  it('takes a vendor reason and an optional internal note, both trimmed', () => {
    expect(
      AdminOverrideReasonSchema.parse({ reason: ' Wrong logo. ', internalNote: ' Ticket 42 ' }),
    ).toEqual({ reason: 'Wrong logo.', internalNote: 'Ticket 42' });
  });

  it.each([
    ['absent', {}],
    ['null', { internalNote: null }],
    ['blank', { internalNote: '   ' }],
  ])('reads an internal note that is %s as absent', (_label, extra) => {
    const parsed = AdminOverrideReasonSchema.parse({ reason: 'Wrong logo.', ...extra });
    expect(parsed.reason).toBe('Wrong logo.');
    expect(parsed.internalNote).toBeUndefined();
  });

  it.each([
    ['missing', {}],
    ['blank', { reason: '  ' }],
    ['over the cap', { reason: 'x'.repeat(ADMIN_REASON_MAX + 1) }],
  ])('refuses a vendor reason that is %s', (_label, body) => {
    expect(AdminOverrideReasonSchema.safeParse(body).success).toBe(false);
  });

  it('refuses an internal note over the cap', () => {
    const body = { reason: 'ok', internalNote: 'x'.repeat(ADMIN_REASON_MAX + 1) };
    expect(AdminOverrideReasonSchema.safeParse(body).success).toBe(false);
  });
});

describe('vendorVisibleReasonMetadata and vendorVisibleReason (AECI-1159)', () => {
  it('marks the reason vendor-visible and keeps the internal note beside it', () => {
    expect(vendorVisibleReasonMetadata({ reason: 'Why', internalNote: 'Private' })).toEqual({
      reason: 'Why',
      reasonVisibility: 'vendor',
      internalNote: 'Private',
    });
    expect(vendorVisibleReasonMetadata({ reason: 'Why' })).toEqual({
      reason: 'Why',
      reasonVisibility: REASON_VISIBILITY_VENDOR,
    });
  });

  it('reads a reason only from a row with the marker, and never the internal note', () => {
    expect(vendorVisibleReason({ reason: 'Why', reasonVisibility: 'vendor' })).toBe('Why');
    expect(vendorVisibleReason({ reason: 'Why' })).toBeNull();
    expect(vendorVisibleReason({ reason: 'Why', reasonVisibility: 'internal' })).toBeNull();
    expect(vendorVisibleReason({ internalNote: 'Private', reasonVisibility: 'vendor' })).toBeNull();
    expect(vendorVisibleReason(null)).toBeNull();
  });
});
