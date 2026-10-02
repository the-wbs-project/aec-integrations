import { describe, expect, it } from 'vitest';

import { ActivityArrivalRequestSchema } from './activity-arrival';
import { MIN_RETENTION_DAYS, USER_ACTIVITY_RETENTION_DAYS } from './admin-panel';
import {
  ARRIVAL_QUERY_PARAMS,
  arrivalFromSearch,
  arrivalQueryString,
  isValidArrivalValue,
  decodeUserActivitySurfaces,
  encodeUserActivitySurfaces,
  USER_ACTIVITY_SURFACE_BITS,
  USER_ACTIVITY_SURFACES,
} from './user-activity';

describe('USER_ACTIVITY_SURFACE_BITS (AECI-1208)', () => {
  it('pins every bit, because stored rows keep them', () => {
    expect(USER_ACTIVITY_SURFACE_BITS).toEqual({
      vendor_portal: 1,
      admin: 2,
      account: 4,
      reviews: 8,
    });
  });

  it('uses distinct single bits', () => {
    const bits = Object.values(USER_ACTIVITY_SURFACE_BITS);
    expect(new Set(bits).size).toBe(bits.length);
    for (const b of bits) expect(b & (b - 1)).toBe(0);
  });

  it('round-trips through encode and decode, in bit order', () => {
    expect(decodeUserActivitySurfaces(0)).toEqual([]);
    expect(decodeUserActivitySurfaces(1 | 8)).toEqual(['vendor_portal', 'reviews']);
    expect(decodeUserActivitySurfaces(encodeUserActivitySurfaces(USER_ACTIVITY_SURFACES))).toEqual(
      USER_ACTIVITY_SURFACES,
    );
    expect(encodeUserActivitySurfaces(['admin', 'account'])).toBe(6);
  });

  it('drops bits it does not know', () => {
    expect(decodeUserActivitySurfaces(2 | 64)).toEqual(['admin']);
  });
});

describe('USER_ACTIVITY_RETENTION_DAYS', () => {
  it('is 400 days, above the floor', () => {
    expect(USER_ACTIVITY_RETENTION_DAYS).toBe(400);
    expect(USER_ACTIVITY_RETENTION_DAYS).toBeGreaterThanOrEqual(MIN_RETENTION_DAYS);
  });
});

describe('ActivityArrivalRequestSchema', () => {
  it('accepts any non-empty subset of the three params', () => {
    expect(ActivityArrivalRequestSchema.parse({ utm_source: 'email' })).toEqual({
      utm_source: 'email',
    });
    expect(
      ActivityArrivalRequestSchema.parse({
        utm_source: 'email',
        utm_campaign: 'seat_invite',
        n: '42',
      }),
    ).toEqual({ utm_source: 'email', utm_campaign: 'seat_invite', n: '42' });
  });

  it('refuses an empty body', () => {
    expect(ActivityArrivalRequestSchema.safeParse({}).success).toBe(false);
  });

  it('refuses unknown keys', () => {
    expect(
      ActivityArrivalRequestSchema.safeParse({ utm_source: 'email', utm_medium: 'x' }).success,
    ).toBe(false);
  });

  it('caps each value at 100 chars', () => {
    expect(ActivityArrivalRequestSchema.safeParse({ utm_source: 'a'.repeat(100) }).success).toBe(
      true,
    );
    expect(ActivityArrivalRequestSchema.safeParse({ utm_source: 'a'.repeat(101) }).success).toBe(
      false,
    );
    expect(ActivityArrivalRequestSchema.safeParse({ utm_campaign: 'a'.repeat(101) }).success).toBe(
      false,
    );
  });

  it('requires n to look like a notification_sends id', () => {
    for (const ok of ['1', '42', '999999999999999']) {
      expect(ActivityArrivalRequestSchema.safeParse({ n: ok }).success).toBe(true);
    }
    for (const bad of ['0', '01', '-1', '1.5', 'abc', '1e3', '', '1234567890123456']) {
      expect(ActivityArrivalRequestSchema.safeParse({ n: bad }).success).toBe(false);
    }
  });
});

describe('arrivalFromSearch', () => {
  it('names exactly the three allowlisted params', () => {
    expect(ARRIVAL_QUERY_PARAMS).toEqual(['utm_source', 'utm_campaign', 'n']);
  });

  it('keeps only valid allowlisted values', () => {
    expect(arrivalFromSearch('?utm_source=email&utm_campaign=seat_invite&n=7&ref=x')).toEqual({
      utm_source: 'email',
      utm_campaign: 'seat_invite',
      n: '7',
    });
    expect(arrivalFromSearch(`?utm_source=${'a'.repeat(101)}&n=12`)).toEqual({ n: '12' });
    expect(arrivalFromSearch('?n=abc&utm_campaign=x')).toEqual({ utm_campaign: 'x' });
  });

  it('returns null when nothing survives', () => {
    expect(arrivalFromSearch('')).toBeNull();
    expect(arrivalFromSearch('?ref=waitlist&token=t')).toBeNull();
    expect(arrivalFromSearch('?n=0&utm_source=')).toBeNull();
  });
});

describe('the zod-free checks agree with the schema', () => {
  const samples = [
    '',
    ' ',
    'email',
    'a'.repeat(100),
    'a'.repeat(101),
    '0',
    '7',
    '01',
    'x y',
    '12345678901234567',
  ];
  for (const key of ARRIVAL_QUERY_PARAMS) {
    it(`agrees on ${key}`, () => {
      for (const value of samples) {
        expect(isValidArrivalValue(key, value), `${key}=${JSON.stringify(value)}`).toBe(
          ActivityArrivalRequestSchema.safeParse({ [key]: value }).success,
        );
      }
    });
  }
});

describe('arrivalQueryString', () => {
  it('keeps only valid allowlisted params, in a fixed order', () => {
    expect(arrivalQueryString('?n=7&ref=x&utm_campaign=c&utm_source=email&token=secret')).toBe(
      '?utm_source=email&utm_campaign=c&n=7',
    );
  });

  it('drops invalid values and returns empty when nothing survives', () => {
    expect(arrivalQueryString('?n=abc&utm_source=' + 'a'.repeat(101))).toBe('');
    expect(arrivalQueryString('')).toBe('');
    expect(arrivalQueryString('?tab=reviews')).toBe('');
  });

  it('encodes values', () => {
    expect(arrivalQueryString('?utm_campaign=a%26b%3Dc')).toBe('?utm_campaign=a%26b%3Dc');
  });
});
