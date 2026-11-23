import { describe, expect, it } from 'vitest';

import { countListedIntegrationRows, type ListedEndpointEdge } from './listed-integration-rows';

const edge = (
  partial: Partial<ListedEndpointEdge> & { partnerSlug: string },
): ListedEndpointEdge => ({
  sourceSlug: 'procore',
  targetSlug: partial.partnerSlug,
  connectorSlug: null,
  evidenced: false,
  mechanismKind: 'native',
  ...partial,
});

describe('countListedIntegrationRows (AECI-1827)', () => {
  it('counts each direct edge as its own row', () => {
    expect(
      countListedIntegrationRows(
        'procore',
        [edge({ partnerSlug: 'a' }), edge({ partnerSlug: 'a' })],
        [],
      ),
    ).toBe(2);
  });

  it('collapses Via edges to one row per connector and partner, across both tables', () => {
    expect(
      countListedIntegrationRows(
        'procore',
        [
          edge({ partnerSlug: 'a', connectorSlug: 'zapier' }),
          edge({ partnerSlug: 'a', connectorSlug: 'zapier', evidenced: true, mechanismKind: null }),
          edge({ partnerSlug: 'a', connectorSlug: 'workato' }),
          edge({ partnerSlug: 'b', connectorSlug: 'zapier' }),
        ],
        [],
      ),
    ).toBe(3);
  });

  it('keeps a self-powered edge direct and groups a bare iPaaS edge under no name', () => {
    expect(
      countListedIntegrationRows(
        'procore',
        [
          edge({ partnerSlug: 'aquifer', connectorSlug: 'aquifer' }),
          edge({ partnerSlug: 'aquifer', connectorSlug: 'aquifer' }),
          edge({ partnerSlug: 'b', mechanismKind: 'iPaaS' }),
          edge({ partnerSlug: 'b', mechanismKind: 'iPaaS' }),
        ],
        [],
      ),
    ).toBe(3);
  });

  it('counts powered pairs once per unordered pair, skipping its own and self edges', () => {
    expect(
      countListedIntegrationRows(
        'zapier',
        [],
        [
          { sourceSlug: 'a', targetSlug: 'b' },
          { sourceSlug: 'b', targetSlug: 'a' },
          { sourceSlug: 'zapier', targetSlug: 'c' },
          { sourceSlug: 'd', targetSlug: 'd' },
          { sourceSlug: 'a', targetSlug: 'c' },
        ],
      ),
    ).toBe(2);
  });

  it('is zero for a product that lists nothing', () => {
    expect(countListedIntegrationRows('procore', [], [])).toBe(0);
  });
});
