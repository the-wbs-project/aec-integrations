import { describe, expect, it } from 'vitest';

import { NOINDEX_DIRECTIVE, indexingAllowed, pathForcesNoindex } from './robots-policy';

describe('indexingAllowed (fail-closed crawler gate)', () => {
  it('allows indexing only when ALLOW_INDEXING is exactly "true"', () => {
    expect(indexingAllowed({ ALLOW_INDEXING: 'true' })).toBe(true);
  });

  it('blocks when the flag is unset (pre-launch default on every env)', () => {
    expect(indexingAllowed({})).toBe(false);
  });

  it('blocks for "false" and any non-"true" string (no truthiness coercion)', () => {
    for (const value of ['false', 'TRUE', 'True', '1', 'yes', '']) {
      expect(indexingAllowed({ ALLOW_INDEXING: value })).toBe(false);
    }
  });
});

describe('NOINDEX_DIRECTIVE', () => {
  it('blocks both indexing and link-following', () => {
    expect(NOINDEX_DIRECTIVE).toBe('noindex, nofollow');
  });
});

describe('pathForcesNoindex (AECI-1104, lifted by AECI-1105)', () => {
  it('holds the vendor guide out of the index', () => {
    expect(pathForcesNoindex('/docs/vendors/your-seat')).toBe(true);
  });

  it('leaves every other path to the env gate', () => {
    for (const path of ['/', '/docs', '/docs/vendors', '/methodology', '/vendors/acme']) {
      expect(pathForcesNoindex(path)).toBe(false);
    }
  });
});
