import { describe, expect, it } from 'vitest';

import { NOINDEX_PATH_PREFIXES as APP_NOINDEX_PATH_PREFIXES } from '../app/docs/docs-indexing';
import {
  NOINDEX_DIRECTIVE,
  NOINDEX_PATH_PREFIXES,
  indexingAllowed,
  pathForcesNoindex,
} from './robots-policy';

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

describe('pathForcesNoindex (AECI-1104, AECI-1248; emptied by AECI-1253)', () => {
  it('holds nothing out since AECI-1253: the vendor guide and every help page are indexable', () => {
    for (const path of [
      '/',
      '/docs',
      '/docs/vendors',
      '/docs/vendors/overview',
      '/docs/vendors/plans',
      '/docs/reviewers/requests-and-corrections',
      '/vendor-program',
      '/methodology',
    ]) {
      expect(pathForcesNoindex(path), path).toBe(false);
    }
  });

  // The live list is empty, so the matching rule is pinned with an explicit list.
  it('covers a prefix and everything below it, the bare section index included', () => {
    expect(pathForcesNoindex('/docs/vendors/your-seat', ['/docs/vendors'])).toBe(true);
    expect(pathForcesNoindex('/docs/vendors', ['/docs/vendors'])).toBe(true);
  });

  it('matches whole segments, not a string prefix', () => {
    expect(pathForcesNoindex('/docs/vendorsx', ['/docs/vendors'])).toBe(false);
    expect(pathForcesNoindex('/docs/vendors-guide/x', ['/docs/vendors'])).toBe(false);
  });

  it('is one list, re-exported from the app module (STAGE_2_PRODUCT_DOCS_SPEC.md §3)', () => {
    expect(NOINDEX_PATH_PREFIXES).toBe(APP_NOINDEX_PATH_PREFIXES);
    expect(NOINDEX_PATH_PREFIXES).toEqual([]);
  });
});
