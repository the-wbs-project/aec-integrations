import { afterEach, describe, expect, it } from 'vitest';

import { readAlgoliaConfig } from './algolia-config';

/**
 * Plain-Vitest (node) coverage for the public Algolia config reader. No Angular,
 * no `window` — `readAlgoliaConfig` reads `globalThis.__AECI_ALGOLIA__`, so the
 * test sets/clears it directly. Validates the present / absent / malformed
 * branches that gate the `/search` page's graceful degradation.
 */

type GlobalWithConfig = { __AECI_ALGOLIA__?: unknown };

const VALID = {
  appId: 'APP123',
  searchKey: 'search-only-key',
  indexes: {
    products: 'preview_products',
    vendors: 'preview_vendors',
    integrations: 'preview_integrations',
  },
};

function setGlobal(value: unknown): void {
  (globalThis as GlobalWithConfig).__AECI_ALGOLIA__ = value;
}

afterEach(() => {
  delete (globalThis as GlobalWithConfig).__AECI_ALGOLIA__;
});

describe('readAlgoliaConfig', () => {
  it('returns the config when a well-formed global is present', () => {
    setGlobal(VALID);
    expect(readAlgoliaConfig()).toEqual(VALID);
  });

  it('returns null when the global is absent', () => {
    expect(readAlgoliaConfig()).toBeNull();
  });

  it('returns null when appId or searchKey is missing/empty', () => {
    setGlobal({ ...VALID, appId: '' });
    expect(readAlgoliaConfig()).toBeNull();
    setGlobal({ appId: 'APP123', indexes: VALID.indexes });
    expect(readAlgoliaConfig()).toBeNull();
  });

  it('returns null when the index names are incomplete', () => {
    setGlobal({ appId: 'APP123', searchKey: 'k', indexes: { products: 'p', vendors: 'v' } });
    expect(readAlgoliaConfig()).toBeNull();
  });

  it('returns null for a non-object / garbage global', () => {
    setGlobal('not-an-object');
    expect(readAlgoliaConfig()).toBeNull();
    setGlobal(null);
    expect(readAlgoliaConfig()).toBeNull();
  });
});
