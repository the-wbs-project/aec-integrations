import { describe, expect, it } from 'vitest';

import {
  defaultIntegrationContext,
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
