import { describe, expect, it } from 'vitest';

import {
  claimDirectionForContext,
  contextDirectionFromClaims,
  defaultIntegrationContext,
  effectiveContextDirection,
  integrationDirectionForContext,
  orderedPairSlugs,
} from './integration-context';

describe('defaultIntegrationContext', () => {
  it('returns the alphabetically-first slug', () => {
    expect(defaultIntegrationContext('revit', 'procore')).toBe('procore');
    expect(defaultIntegrationContext('autocad', 'revit')).toBe('autocad');
  });

  it('is symmetric (same result whichever way the pair is passed)', () => {
    expect(defaultIntegrationContext('revit', 'procore')).toBe(
      defaultIntegrationContext('procore', 'revit'),
    );
  });

  it('is stable for equal slugs (a caller error rejected upstream)', () => {
    expect(defaultIntegrationContext('revit', 'revit')).toBe('revit');
  });
});

describe('orderedPairSlugs', () => {
  it('returns [min, max] regardless of argument order', () => {
    expect(orderedPairSlugs('revit', 'procore')).toEqual(['procore', 'revit']);
    expect(orderedPairSlugs('procore', 'revit')).toEqual(['procore', 'revit']);
  });
});

describe('integrationDirectionForContext', () => {
  it('maps bidirectional to both regardless of which endpoint is the context', () => {
    expect(integrationDirectionForContext('bidirectional', true)).toBe('both');
    expect(integrationDirectionForContext('bidirectional', false)).toBe('both');
  });

  it('maps one-way to outbound when the context is the source, inbound otherwise', () => {
    expect(integrationDirectionForContext('one-way', true)).toBe('outbound');
    expect(integrationDirectionForContext('one-way', false)).toBe('inbound');
  });

  it('passes null through (nullable stored direction)', () => {
    expect(integrationDirectionForContext(null, true)).toBeNull();
    expect(integrationDirectionForContext(null, false)).toBeNull();
  });
});

describe('claimDirectionForContext', () => {
  it('maps both to both regardless of which endpoint is the context', () => {
    expect(claimDirectionForContext('both', true)).toBe('both');
    expect(claimDirectionForContext('both', false)).toBe('both');
  });

  it('reads a_to_b as outbound from endpoint A (source) and inbound from B', () => {
    expect(claimDirectionForContext('a_to_b', true)).toBe('outbound');
    expect(claimDirectionForContext('a_to_b', false)).toBe('inbound');
  });

  it('reads b_to_a as the mirror of a_to_b', () => {
    expect(claimDirectionForContext('b_to_a', true)).toBe('inbound');
    expect(claimDirectionForContext('b_to_a', false)).toBe('outbound');
  });
});

describe('contextDirectionFromClaims', () => {
  it('returns null when the mechanism has no claims', () => {
    expect(contextDirectionFromClaims([], true)).toBeNull();
    expect(contextDirectionFromClaims([], false)).toBeNull();
  });

  it('reads a single one-directional set as that direction, framed to the context', () => {
    expect(contextDirectionFromClaims(['a_to_b', 'a_to_b'], true)).toBe('outbound');
    expect(contextDirectionFromClaims(['a_to_b', 'a_to_b'], false)).toBe('inbound');
    expect(contextDirectionFromClaims(['b_to_a'], true)).toBe('inbound');
    expect(contextDirectionFromClaims(['b_to_a'], false)).toBe('outbound');
  });

  it('reads any `both` claim as both', () => {
    expect(contextDirectionFromClaims(['both'], true)).toBe('both');
    expect(contextDirectionFromClaims(['a_to_b', 'both'], false)).toBe('both');
  });

  it('reads opposing flows across claims as both, regardless of endpoint', () => {
    expect(contextDirectionFromClaims(['a_to_b', 'b_to_a'], true)).toBe('both');
    expect(contextDirectionFromClaims(['a_to_b', 'b_to_a'], false)).toBe('both');
  });
});

describe('effectiveContextDirection', () => {
  it('prefers the claim aggregate over the stored row direction when claims exist', () => {
    // The bug this fixes: stored direction null, but claims flow both ways.
    expect(effectiveContextDirection(null, ['both'], true)).toBe('both');
    expect(effectiveContextDirection(null, ['a_to_b', 'b_to_a'], false)).toBe('both');
    // Claims win even over a (stale/coarse) stored one-way.
    expect(effectiveContextDirection('one-way', ['a_to_b', 'b_to_a'], true)).toBe('both');
  });

  it('falls back to the stored row direction when there are no claims', () => {
    expect(effectiveContextDirection('bidirectional', [], true)).toBe('both');
    expect(effectiveContextDirection('one-way', [], true)).toBe('outbound');
    expect(effectiveContextDirection('one-way', [], false)).toBe('inbound');
  });

  it('is null only when there is neither a claim nor a stored direction', () => {
    expect(effectiveContextDirection(null, [], true)).toBeNull();
    expect(effectiveContextDirection(null, [], false)).toBeNull();
  });
});
