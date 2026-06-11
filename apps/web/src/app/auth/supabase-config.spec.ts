import { afterEach, describe, expect, it } from 'vitest';

import { readSupabaseConfig } from './supabase-config';

type GlobalWithConfig = { __AECI_SUPABASE__?: unknown };

function setGlobal(value: unknown): void {
  (globalThis as GlobalWithConfig).__AECI_SUPABASE__ = value;
}

afterEach(() => {
  delete (globalThis as GlobalWithConfig).__AECI_SUPABASE__;
});

describe('readSupabaseConfig', () => {
  it('returns the config when the global is well-formed', () => {
    const cfg = { url: 'https://abc.supabase.co', anonKey: 'anon-key-123' };
    setGlobal(cfg);
    expect(readSupabaseConfig()).toEqual(cfg);
  });

  it('returns null when the global is absent', () => {
    expect(readSupabaseConfig()).toBeNull();
  });

  it.each([
    [null, 'null'],
    ['string', 'a string'],
    [42, 'a number'],
    [{}, 'an empty object'],
    [{ url: 'https://abc.supabase.co' }, 'missing anonKey'],
    [{ anonKey: 'anon-key-123' }, 'missing url'],
    [{ url: '', anonKey: 'anon-key-123' }, 'empty url'],
    [{ url: 'https://abc.supabase.co', anonKey: '' }, 'empty anonKey'],
    [{ url: 1, anonKey: 'anon-key-123' }, 'non-string url'],
    [{ url: 'https://abc.supabase.co', anonKey: {} }, 'non-string anonKey'],
  ])('returns null for a malformed global: %s (%s)', (value, _label) => {
    setGlobal(value);
    expect(readSupabaseConfig()).toBeNull();
  });
});
