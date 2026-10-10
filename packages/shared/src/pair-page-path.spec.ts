import { describe, expect, it } from 'vitest';

import { canonicalPairIds, parsePairPagePath } from './pair-page-path';

describe('parsePairPagePath (AECI-929)', () => {
  it('returns both slugs in URL order', () => {
    expect(parsePairPagePath('/products/procore/integrations/autodesk-docs')).toEqual({
      a: 'procore',
      b: 'autodesk-docs',
    });
  });

  it('parses the mirrored orientation as the mirrored pair', () => {
    expect(parsePairPagePath('/products/autodesk-docs/integrations/procore')).toEqual({
      a: 'autodesk-docs',
      b: 'procore',
    });
  });

  it('rejects two equal slugs, which the API 404s', () => {
    expect(parsePairPagePath('/products/procore/integrations/procore')).toBeNull();
  });

  it('rejects a trailing slash and extra segments', () => {
    expect(parsePairPagePath('/products/procore/integrations/autodesk-docs/')).toBeNull();
    expect(parsePairPagePath('/products/procore/integrations/autodesk-docs/extra')).toBeNull();
    expect(parsePairPagePath('/products/procore/integrations')).toBeNull();
    expect(parsePairPagePath('/products/procore/integrations/')).toBeNull();
  });

  it('rejects non-pair paths', () => {
    expect(parsePairPagePath('/products/procore')).toBeNull();
    expect(parsePairPagePath('/vendors/procore')).toBeNull();
    expect(parsePairPagePath('/admin/products/procore/integrations/x')).toBeNull();
    expect(parsePairPagePath('/')).toBeNull();
  });

  it('parses a bare route pattern, whose slugs then resolve to no product', () => {
    // A writer that sent the pattern with no `path` would land here. The parser is
    // shape-only; the slug lookup at ingest is what turns `:contextSlug` into NULL.
    expect(parsePairPagePath('/products/:contextSlug/integrations/:otherSlug')).toEqual({
      a: ':contextSlug',
      b: ':otherSlug',
    });
  });
});

describe('canonicalPairIds (AECI-929)', () => {
  it('puts the lower id first, whichever order it arrives in', () => {
    expect(canonicalPairIds('b-id', 'a-id')).toEqual(['a-id', 'b-id']);
    expect(canonicalPairIds('a-id', 'b-id')).toEqual(['a-id', 'b-id']);
  });

  it('orders BINARY, not case-insensitively', () => {
    // 'B' (0x42) sorts before 'a' (0x61) in a binary order.
    expect(canonicalPairIds('a', 'B')).toEqual(['B', 'a']);
  });

  it('puts a lone resolved id in the first slot', () => {
    expect(canonicalPairIds(null, 'x')).toEqual(['x', null]);
    expect(canonicalPairIds('x', null)).toEqual(['x', null]);
    expect(canonicalPairIds(null, null)).toEqual([null, null]);
  });
});
