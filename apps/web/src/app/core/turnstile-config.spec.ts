import { afterEach, describe, expect, it, vi } from 'vitest';

import { turnstileSiteKey } from './turnstile-config';

// Plain Node vitest: no `window`; `navigator` is stubbed per test.
type G = { __AECI_TURNSTILE__?: unknown };

afterEach(() => {
  delete (globalThis as G).__AECI_TURNSTILE__;
  vi.unstubAllGlobals();
});

describe('turnstileSiteKey', () => {
  it('returns null when the config is absent (the shipped, dark state)', () => {
    expect(turnstileSiteKey()).toBeNull();
  });

  it.each([null, 'key', {}, { siteKey: '' }, { siteKey: 42 }])(
    'returns null for a malformed config %j',
    (value) => {
      (globalThis as G).__AECI_TURNSTILE__ = value;
      expect(turnstileSiteKey()).toBeNull();
    },
  );

  it('returns the site key with no privacy signal', () => {
    (globalThis as G).__AECI_TURNSTILE__ = { siteKey: 'k' };
    vi.stubGlobal('navigator', { doNotTrack: null });
    expect(turnstileSiteKey()).toBe('k');
  });

  it.each([
    ['Global Privacy Control', { globalPrivacyControl: true }],
    ['Do-Not-Track', { doNotTrack: '1' }],
  ])('returns null under %s', (_label, nav) => {
    (globalThis as G).__AECI_TURNSTILE__ = { siteKey: 'k' };
    vi.stubGlobal('navigator', nav);
    expect(turnstileSiteKey()).toBeNull();
  });
});
