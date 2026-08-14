import { describe, expect, it } from 'vitest';

import type { ClaimDirection } from './api/promote';
import {
  attestorForContext,
  claimDirectionForContext,
  contextDirectionFromClaims,
  defaultIntegrationContext,
  effectiveContextDirection,
  integrationDirectionForContext,
  orderedPairSlugs,
  type DirectionalClaim,
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

describe('attestorForContext', () => {
  it('never attributes the AECi seed to either endpoint', () => {
    expect(attestorForContext('aeci', true)).toBe('aeci');
    expect(attestorForContext('aeci', false)).toBe('aeci');
  });

  // `vendor_a` is endpoint A = the integration row's `source_product`. Viewed
  // from that product the slot is the context's own vendor; viewed from the
  // other end it is the counterparty. Same mirror as `claimDirectionForContext`.
  it('mirrors the endpoint-A/B slots into the context frame', () => {
    expect(attestorForContext('vendor_a', true)).toBe('context');
    expect(attestorForContext('vendor_a', false)).toBe('other');
    expect(attestorForContext('vendor_b', true)).toBe('other');
    expect(attestorForContext('vendor_b', false)).toBe('context');
  });
});

describe('effectiveContextDirection', () => {
  /** A claim nobody has voted on — the Stage 1.5 AECi-seeded baseline. */
  const seeded = (direction: ClaimDirection): DirectionalClaim => ({
    direction,
    attestations: [{ source: 'aeci', asserted: true, attestedByVendorId: null, retractedAt: null }],
  });

  /** A claim every voting vendor denies — refuted, so it must not steer the arrow. */
  const refuted = (direction: ClaimDirection): DirectionalClaim => ({
    direction,
    attestations: [
      { source: 'vendor_a', asserted: false, attestedByVendorId: 'v-acme', retractedAt: null },
    ],
  });

  it('prefers the claim aggregate over the stored row direction when claims exist', () => {
    // The bug this fixes: stored direction null, but claims flow both ways.
    expect(effectiveContextDirection(null, [seeded('both')], true)).toBe('both');
    expect(effectiveContextDirection(null, [seeded('a_to_b'), seeded('b_to_a')], false)).toBe(
      'both',
    );
    // Claims win even over a (stale/coarse) stored one-way.
    expect(effectiveContextDirection('one-way', [seeded('a_to_b'), seeded('b_to_a')], true)).toBe(
      'both',
    );
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

  // §4.3: once every voting vendor denies a flow, it must stop steering the
  // product-detail table's arrow — otherwise the table keeps asserting a
  // direction the pair page has already struck through (the §7.1 drift bug).
  it('drops refuted claims from the aggregate', () => {
    // The refuted b_to_a would otherwise widen this to `both`.
    expect(effectiveContextDirection(null, [seeded('a_to_b'), refuted('b_to_a')], true)).toBe(
      'outbound',
    );
  });

  it('falls back to the stored direction when every claim is refuted', () => {
    expect(effectiveContextDirection('one-way', [refuted('both')], true)).toBe('outbound');
  });

  it('is null when every claim is refuted and there is no stored direction', () => {
    expect(effectiveContextDirection(null, [refuted('a_to_b')], true)).toBeNull();
  });

  // A conflict is a dispute, not a withdrawal: one vendor still says the flow
  // exists, so the table keeps showing it.
  it('keeps a disputed (conflict) claim in the aggregate', () => {
    const disputed: DirectionalClaim = {
      direction: 'a_to_b',
      attestations: [
        { source: 'vendor_a', asserted: true, attestedByVendorId: 'v-acme', retractedAt: null },
        { source: 'vendor_b', asserted: false, attestedByVendorId: 'v-globex', retractedAt: null },
      ],
    };
    expect(effectiveContextDirection(null, [disputed], true)).toBe('outbound');
  });
});
