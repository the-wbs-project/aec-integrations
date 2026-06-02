import { describe, expect, it } from 'vitest';

import { timingSafeEqual } from './timing-safe-equal';

describe('timingSafeEqual', () => {
  it('returns true for identical ASCII strings', () => {
    expect(timingSafeEqual('hunter2', 'hunter2')).toBe(true);
    expect(timingSafeEqual('a3f9c1e0b2', 'a3f9c1e0b2')).toBe(true);
  });

  it('returns false for same-length strings that differ', () => {
    expect(timingSafeEqual('hunter2', 'hunter3')).toBe(false);
    // Differ only in the final byte — must still compare false.
    expect(timingSafeEqual('aaaaaaaa', 'aaaaaaab')).toBe(false);
    // Differ only in the first byte.
    expect(timingSafeEqual('baaaaaaa', 'aaaaaaaa')).toBe(false);
  });

  it('returns false for strings of differing length', () => {
    expect(timingSafeEqual('short', 'shorter')).toBe(false);
    expect(timingSafeEqual('shorter', 'short')).toBe(false);
    // A prefix of the secret must not match the secret.
    expect(timingSafeEqual('hunter', 'hunter2')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(timingSafeEqual('', '')).toBe(true);
    expect(timingSafeEqual('', 'x')).toBe(false);
    expect(timingSafeEqual('x', '')).toBe(false);
  });

  it('returns true for identical multibyte strings', () => {
    expect(timingSafeEqual('café', 'café')).toBe(true);
    expect(timingSafeEqual('🔑🔒', '🔑🔒')).toBe(true);
    expect(timingSafeEqual('Ωπ漢字', 'Ωπ漢字')).toBe(true);
  });

  it('returns false for multibyte strings that differ', () => {
    expect(timingSafeEqual('café', 'cafe')).toBe(false);
    expect(timingSafeEqual('🔑', '🔒')).toBe(false);
  });

  it('compares by UTF-8 bytes, not UTF-16 code units', () => {
    // '€' (U+20AC) is 1 UTF-16 unit but 3 UTF-8 bytes — same byte length as
    // 'abc' (3 bytes) yet different content.
    expect(timingSafeEqual('€', 'abc')).toBe(false);
    // 'é' is 1 UTF-16 unit / 2 UTF-8 bytes; 'a' is 1 unit / 1 byte. Equal
    // string .length, different byte length — must compare false.
    expect(timingSafeEqual('é', 'a')).toBe(false);
  });
});
