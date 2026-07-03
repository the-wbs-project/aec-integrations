import { afterEach, describe, expect, it } from 'vitest';

import { readPostHogConfig } from './posthog-config';

/**
 * Plain-Vitest (node) coverage for the public PostHog config reader. No Angular,
 * no `window` — `readPostHogConfig` reads `globalThis.__AECI_POSTHOG__`, so the
 * test sets/clears it directly. Validates the present / absent / malformed
 * branches that gate whether the analytics layer ever loads PostHog.
 */

type GlobalWithConfig = { __AECI_POSTHOG__?: unknown };

const VALID = { key: 'phc_abc', host: 'https://us.i.posthog.com' };

function setGlobal(value: unknown): void {
  (globalThis as GlobalWithConfig).__AECI_POSTHOG__ = value;
}

afterEach(() => {
  delete (globalThis as GlobalWithConfig).__AECI_POSTHOG__;
});

describe('readPostHogConfig', () => {
  it('returns the config when a well-formed global is present', () => {
    setGlobal(VALID);
    expect(readPostHogConfig()).toEqual(VALID);
  });

  it('returns null when the global is absent', () => {
    expect(readPostHogConfig()).toBeNull();
  });

  it('returns null when key is missing or empty', () => {
    setGlobal({ host: VALID.host });
    expect(readPostHogConfig()).toBeNull();
    setGlobal({ ...VALID, key: '' });
    expect(readPostHogConfig()).toBeNull();
  });

  it('returns null when host is missing or empty', () => {
    setGlobal({ key: VALID.key });
    expect(readPostHogConfig()).toBeNull();
    setGlobal({ ...VALID, host: '' });
    expect(readPostHogConfig()).toBeNull();
  });

  it('returns null for a non-object / garbage global', () => {
    setGlobal('not-an-object');
    expect(readPostHogConfig()).toBeNull();
    setGlobal(null);
    expect(readPostHogConfig()).toBeNull();
  });
});
