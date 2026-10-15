import { describe, expect, it } from 'vitest';

import { isFreeEmailAddress } from './free-email-domains';

describe('isFreeEmailAddress', () => {
  it('flags the common free mailboxes', () => {
    for (const email of [
      'jane@gmail.com',
      'jane@yahoo.com',
      'jane@aol.com',
      'jane@outlook.com',
      'jane@hotmail.com',
      'jane@icloud.com',
    ]) {
      expect(isFreeEmailAddress(email)).toBe(true);
    }
  });

  it('ignores case and surrounding space', () => {
    expect(isFreeEmailAddress('  Jane@GMAIL.com ')).toBe(true);
  });

  it('passes a company domain', () => {
    expect(isFreeEmailAddress('jane@acme.com')).toBe(false);
    expect(isFreeEmailAddress('jane@zoho.com')).toBe(false);
  });

  it('matches the exact domain only', () => {
    expect(isFreeEmailAddress('jane@notgmail.com')).toBe(false);
    expect(isFreeEmailAddress('jane@mail.gmail.com.acme.io')).toBe(false);
  });

  it('returns false for a missing or half-typed address', () => {
    expect(isFreeEmailAddress('')).toBe(false);
    expect(isFreeEmailAddress(null)).toBe(false);
    expect(isFreeEmailAddress(undefined)).toBe(false);
    expect(isFreeEmailAddress('jane')).toBe(false);
    expect(isFreeEmailAddress('jane@')).toBe(false);
    expect(isFreeEmailAddress('@gmail.com')).toBe(false);
    expect(isFreeEmailAddress('jane@gmail')).toBe(false);
  });
});
