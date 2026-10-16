import { describe, expect, it } from 'vitest';

import { formatTermDate } from './format-term-date';

/** Paid Tiers §5.8: a date-only value is a calendar date, never shifted a day.
 *  A component spec only so `ng test` runs it: `@angular/common` needs the linker. */
describe('formatTermDate', () => {
  it('keeps a date-only value on its own day', () => {
    expect(formatTermDate('2027-09-01', 'en-US')).toBe('Sep 1, 2027');
  });

  it('formats an instant in UTC', () => {
    expect(formatTermDate('2027-09-01T23:30:00.000Z', 'en-US')).toBe('Sep 1, 2027');
  });

  it('falls back to the raw string when it cannot parse', () => {
    expect(formatTermDate('not a date', 'en-US')).toBe('not a date');
  });
});
