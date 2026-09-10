import { describe, expect, it } from 'vitest';

import type { ProductIntegrationItem, ProductLink } from '@aeci/shared';

import { splitIntegrationLanes } from './connector-lane-grouping';
import {
  filterIntegrationLanes,
  filterPoweredHubView,
  INTEGRATION_FILTER_MIN_ROWS,
  isFilterActive,
  normalizeFilterText,
} from './integration-filter';
import { groupPoweredIntegrations } from './powered-hub-grouping';

import type { IntegrationListItem } from '@aeci/shared';

/**
 * AECI-841 — the client-side name filter over both product-detail integration
 * sections.
 *
 * Built on REAL views: every fixture goes through `splitIntegrationLanes` or
 * `groupPoweredIntegrations` first, so a filter that quietly disagreed with the
 * grouping about what a row is would fail here rather than in the browser.
 */

function link(slug: string, name: string): ProductLink {
  return { id: 'p-' + slug, slug, name, logo_url: null };
}

let edgeSeq = 0;

function edge(
  source: ProductLink,
  target: ProductLink,
  overrides: Partial<ProductIntegrationItem> = {},
): ProductIntegrationItem {
  edgeSeq += 1;
  return {
    id: '00000000-0000-4000-8000-0000000' + String(edgeSeq).padStart(5, '0'),
    name: source.name + ' to ' + target.name,
    mechanism_kind: 'api',
    mechanism_name: 'REST',
    direction: 'one-way',
    context_direction: 'outbound',
    source,
    target,
    via: null,
    powered_by_product: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A `integrations_as_connector` edge. The payload bucket is already filtered
 *  server-side to edges this product powers, so the connector itself is not a
 *  field on the row. */
function poweredEdge(source: ProductLink, target: ProductLink): IntegrationListItem {
  edgeSeq += 1;
  return {
    id: '00000000-0000-4000-8000-0000000' + String(edgeSeq).padStart(5, '0'),
    name: source.name + ' to ' + target.name,
    mechanism_kind: 'api',
    mechanism_name: 'REST',
    direction: 'one-way',
    source,
    target,
    via: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('normalizeFilterText', () => {
  it('folds case so a lowercase query finds an interior-capital brand', () => {
    expect(normalizeFilterText('eSUB Cloud')).toBe('esub cloud');
  });

  it('strips diacritics so a reader who cannot type one is not shut out', () => {
    expect(normalizeFilterText('Procoré')).toBe('procore');
  });

  it('trims, so leading whitespace is not a query', () => {
    expect(normalizeFilterText('   ')).toBe('');
  });
});

describe('isFilterActive', () => {
  it('treats whitespace as no query at all', () => {
    expect(isFilterActive('  ')).toBe(false);
    expect(isFilterActive('')).toBe(false);
    expect(isFilterActive(' a ')).toBe(true);
  });
});

describe('filterIntegrationLanes', () => {
  const page = link('procore', 'Procore');
  const sage = link('sage-300-cre', 'Sage 300 CRE');
  const esub = link('esub-cloud', 'eSUB Cloud');
  const agave = link('agave-erp-sync', 'Agave ERP Sync');
  const acme = link('acme-forms', 'Acme Forms');

  const view = splitIntegrationLanes(
    [
      edge(page, sage),
      edge(page, esub),
      edge(page, acme, { via: agave }),
      edge(page, sage, { via: agave }),
    ],
    [],
  );

  it('returns the input by identity when the query is empty', () => {
    expect(filterIntegrationLanes(view, '')).toBe(view);
    expect(filterIntegrationLanes(view, '   ')).toBe(view);
  });

  it('matches partner names case-insensitively across both lanes', () => {
    const filtered = filterIntegrationLanes(view, 'sage');
    expect(filtered.direct.map((r) => r.other.slug)).toEqual(['sage-300-cre']);
    expect(filtered.via).toHaveLength(1);
    expect(filtered.via[0].rows.map((r) => r.other.slug)).toEqual(['sage-300-cre']);
    expect(filtered.rowCount).toBe(2);
  });

  it('keeps EVERY row of a group whose own connector name matches', () => {
    const filtered = filterIntegrationLanes(view, 'agave');
    // No partner is called Agave, so the direct lane empties...
    expect(filtered.direct).toHaveLength(0);
    // ...and the whole Agave group survives, not just a matching row.
    expect(filtered.via).toHaveLength(1);
    expect(filtered.via[0].rows).toHaveLength(2);
    expect(filtered.rowCount).toBe(2);
  });

  it('drops a group entirely when neither it nor its rows match', () => {
    const filtered = filterIntegrationLanes(view, 'esub');
    expect(filtered.via).toHaveLength(0);
    expect(filtered.rowCount).toBe(1);
  });

  it('recomputes rowCount so the count and the rendered rows stay one set', () => {
    const filtered = filterIntegrationLanes(view, 'no-such-product');
    expect(filtered.direct).toHaveLength(0);
    expect(filtered.via).toHaveLength(0);
    expect(filtered.rowCount).toBe(0);
  });

  it('never reorders: the surviving rows keep the grouping order', () => {
    const filtered = filterIntegrationLanes(view, 'e');
    const unfiltered = view.direct.filter((r) => filtered.direct.includes(r));
    expect(filtered.direct).toEqual(unfiltered);
  });
});

describe('filterPoweredHubView', () => {
  const connector = link('agave-erp-sync', 'Agave ERP Sync');
  const hub = link('procore', 'Procore');
  const sage = link('sage-300-cre', 'Sage 300 CRE');
  const esub = link('esub-cloud', 'eSUB Cloud');
  const acme = link('acme-forms', 'Acme Forms');
  const other = link('bluebeam', 'Bluebeam');

  const view = groupPoweredIntegrations(
    [
      poweredEdge(hub, sage),
      poweredEdge(hub, esub),
      poweredEdge(hub, acme),
      poweredEdge(other, sage),
    ],
    connector.slug,
  );

  it('returns the input by identity when the query is empty', () => {
    expect(filterPoweredHubView(view, '')).toBe(view);
  });

  it('groups on a real hub, which is the precondition for the rest', () => {
    expect(view.groups).toHaveLength(1);
    expect(view.groups[0].hub.slug).toBe('procore');
    expect(view.pairCount).toBe(4);
  });

  it('matches partner names inside a hub card', () => {
    const filtered = filterPoweredHubView(view, 'esub');
    expect(filtered.groups).toHaveLength(1);
    expect(filtered.groups[0].partners.map((p) => p.partner.slug)).toEqual(['esub-cloud']);
    expect(filtered.pairCount).toBe(1);
  });

  it('keeps every partner of a hub whose own name matches', () => {
    const filtered = filterPoweredHubView(view, 'procore');
    expect(filtered.groups[0].partners).toHaveLength(3);
  });

  it('matches a hubless pair on EITHER endpoint', () => {
    expect(view.others).toHaveLength(1);
    expect(filterPoweredHubView(view, 'bluebeam').others).toHaveLength(1);
    expect(filterPoweredHubView(view, 'sage').others).toHaveLength(1);
    expect(filterPoweredHubView(view, 'acme').others).toHaveLength(0);
  });

  it('recomputes pairCount from the rows it kept', () => {
    const filtered = filterPoweredHubView(view, 'sage');
    expect(filtered.pairCount).toBe(
      filtered.groups.reduce((n, g) => n + g.partners.length, 0) + filtered.others.length,
    );
  });
});

describe('INTEGRATION_FILTER_MIN_ROWS', () => {
  it('is the documented threshold both sections gate their filter box on', () => {
    expect(INTEGRATION_FILTER_MIN_ROWS).toBe(10);
  });
});
