import { describe, expect, it } from 'vitest';

import { ADMIN_REASON_MAX, AdminReasonSchema } from './admin-reason';

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
