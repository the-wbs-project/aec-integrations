import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { turnstileSiteKey } from './turnstile-config';

// Plain Node vitest: no `window`; `navigator` and `performance` are stubbed per test.
type G = { __AECI_TURNSTILE__?: unknown };

function stubNavigationEntries(entries: unknown[]): void {
  vi.stubGlobal('performance', { getEntriesByType: () => entries });
}

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
    stubNavigationEntries([{ serverTiming: [] }]);
    expect(turnstileSiteKey()).toBe('k');
  });

  // AECI-1581: the geo exclusion, until the AECI-1458 ruling.
  describe('region', () => {
    const CFRAY = { name: 'cfray', description: '8f2a1b3c4d5e6f70-SIN' };

    beforeEach(() => {
      (globalThis as G).__AECI_TURNSTILE__ = { siteKey: 'k' };
    });

    it('returns null when the gateway stamped geo=eu', () => {
      stubNavigationEntries([{ serverTiming: [CFRAY, { name: 'geo', description: 'eu' }] }]);
      expect(turnstileSiteKey()).toBeNull();
    });

    it.each([
      ['no navigation entry', []],
      ['an entry with no serverTiming', [{}]],
    ])('fails closed on %s', (_label, entries) => {
      stubNavigationEntries(entries);
      expect(turnstileSiteKey()).toBeNull();
    });

    it('fails closed when the browser has no performance API', () => {
      vi.stubGlobal('performance', undefined);
      expect(turnstileSiteKey()).toBeNull();
    });

    it.each([
      ['an empty list', []],
      ['only a ray', [CFRAY]],
      ['a geo entry with another value', [{ name: 'geo', description: 'other' }]],
    ])('returns the site key for %s', (_label, serverTiming) => {
      stubNavigationEntries([{ serverTiming }]);
      expect(turnstileSiteKey()).toBe('k');
    });

    it('does not read timing when the config is absent', () => {
      delete (globalThis as G).__AECI_TURNSTILE__;
      const getEntriesByType = vi.fn();
      vi.stubGlobal('performance', { getEntriesByType });
      expect(turnstileSiteKey()).toBeNull();
      expect(getEntriesByType).not.toHaveBeenCalled();
    });
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
