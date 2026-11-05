import { describe, expect, it } from 'vitest';

import { addBusinessDays, businessWindowEnd, isBusinessDay } from './business-days';

const date = (s: string) => new Date(`${s}T00:00:00.000Z`);
const key = (d: Date) => d.toISOString().slice(0, 10);

describe('isBusinessDay', () => {
  it('excludes weekends', () => {
    expect(isBusinessDay(date('2026-11-07'))).toBe(false);
    expect(isBusinessDay(date('2026-11-08'))).toBe(false);
    expect(isBusinessDay(date('2026-11-09'))).toBe(true);
  });

  it.each([
    ['2026-01-01', 'New Year'],
    ['2026-01-19', 'MLK'],
    ['2026-02-16', 'Washington'],
    ['2026-05-25', 'Memorial'],
    ['2026-06-19', 'Juneteenth'],
    ['2026-07-03', 'Independence observed on Friday'],
    ['2026-09-07', 'Labor'],
    ['2026-10-12', 'Columbus'],
    ['2026-11-11', 'Veterans'],
    ['2026-11-26', 'Thanksgiving'],
    ['2026-12-25', 'Christmas'],
    ['2027-12-31', "New Year's Day 2028 observed on the Friday before"],
    ['2028-07-04', 'plain Tuesday holiday'],
  ])('excludes %s (%s)', (d) => {
    expect(isBusinessDay(date(d))).toBe(false);
  });

  it('counts the day after Thanksgiving: it is not a federal holiday', () => {
    expect(isBusinessDay(date('2026-11-27'))).toBe(true);
  });
});

describe('addBusinessDays', () => {
  it('does not count the start day', () => {
    // Monday 2026-11-02 at noon New York: 7 business days end Wednesday the 12th, because
    // Wednesday the 11th is Veterans Day.
    expect(key(addBusinessDays(new Date('2026-11-02T17:00:00Z'), 7))).toBe('2026-11-12');
  });

  it('skips a weekend when the notice goes on a Friday', () => {
    expect(key(addBusinessDays(new Date('2026-08-07T17:00:00Z'), 7))).toBe('2026-08-18');
  });

  it('uses the New York date: 11 pm Sunday New York is still Sunday', () => {
    // 2026-08-10T03:00Z is 11 pm on Sunday the 9th in New York.
    expect(key(addBusinessDays(new Date('2026-08-10T03:00:00Z'), 1))).toBe('2026-08-10');
  });

  it('stacks two stages to 14 business days', () => {
    const stage1 = addBusinessDays(new Date('2026-08-03T17:00:00Z'), 7);
    expect(key(stage1)).toBe('2026-08-12');
    expect(key(addBusinessDays(new Date(`${key(stage1)}T17:00:00Z`), 7))).toBe('2026-08-21');
  });
});

describe('businessWindowEnd', () => {
  it('ends after the last day has fully passed in New York, never before', () => {
    const end = businessWindowEnd('2026-08-03T17:00:00.000Z', 7);
    expect(end).toBe('2026-08-13T05:00:00.000Z');
    // 11:59 pm on the last day, EDT, is before the end.
    expect(Date.parse('2026-08-13T03:59:00Z')).toBeLessThan(Date.parse(end));
  });
});
