import { describe, expect, it } from 'vitest';

import type { ProductIntegrationItem, ProductLink } from '@aeci/shared';

import { splitIntegrationLanes } from './connector-lane-grouping';
import {
  filterIntegrationLanes,
  filterPoweredHubView,
  isFilterActive,
  normalizeFilterText,
} from './integration-filter';
import { groupPoweredIntegrations } from './powered-hub-grouping';

import type { PoweredIntegrationItem } from '@aeci/shared';

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
    direction: 'a_to_b',
    context_direction: 'outbound',
    source,
    target,
    via: null,
    powered_by_product: null,
    data_object_slugs: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A `integrations_as_connector` edge. The payload bucket is already filtered
 *  server-side to edges this product powers, so the connector itself is not a
 *  field on the row. */
function poweredEdge(source: ProductLink, target: ProductLink): PoweredIntegrationItem {
  edgeSeq += 1;
  return {
    id: '00000000-0000-4000-8000-0000000' + String(edgeSeq).padStart(5, '0'),
    name: source.name + ' to ' + target.name,
    mechanism_kind: 'api',
    mechanism_name: 'REST',
    direction: 'a_to_b',
    source,
    target,
    via: null,
    data_object_slugs: [],
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

  /**
   * AECI-966 — the reported defect. `mechanism_name` is rendered in the
   * Connection column (visible from `md` up), so a query that matches only it
   * must return the row rather than an empty list.
   */
  describe('matching the mechanism label (AECI-966)', () => {
    const navisworks = link('navisworks', 'Navisworks');
    const revit = link('revit', 'Revit');
    const mechView = splitIntegrationLanes(
      [
        edge(page, navisworks, { mechanism_name: 'Navisworks DWG file reader' }),
        edge(page, revit, { mechanism_name: 'IFC export' }),
        edge(page, acme, { via: agave, mechanism_name: 'DWG round-trip' }),
      ],
      [],
    );

    it('returns the row whose mechanism label matches, not an empty list', () => {
      const filtered = filterIntegrationLanes(mechView, 'DWG');
      expect(filtered.direct.map((r) => r.other.slug)).toEqual(['navisworks']);
      expect(filtered.via[0].rows.map((r) => r.other.slug)).toEqual(['acme-forms']);
      expect(filtered.rowCount).toBe(2);
    });

    it('still matches the partner name, so the widening is additive', () => {
      expect(filterIntegrationLanes(mechView, 'revit').rowCount).toBe(1);
    });

    it('folds case and accents on the mechanism label too', () => {
      expect(filterIntegrationLanes(mechView, 'file reader').rowCount).toBe(1);
      expect(filterIntegrationLanes(mechView, 'ífc').rowCount).toBe(1);
    });

    it('does not match a row whose mechanism label is null or blank', () => {
      const blank = splitIntegrationLanes(
        [
          edge(page, navisworks, { mechanism_name: null }),
          edge(page, revit, { mechanism_name: '   ' }),
        ],
        [],
      );
      // A blank normalizes to '', which is a substring of everything — the
      // guard in `matches()` is what stops it matching every query.
      expect(filterIntegrationLanes(blank, 'zzz').rowCount).toBe(0);
      expect(filterIntegrationLanes(blank, 'q').rowCount).toBe(0);
    });

    /**
     * A Via row renders ONE label (the representative edge's), so it must match
     * on that one. Matching the whole collapsed set would surface a row whose
     * visible Connection cell does not contain the query.
     */
    it('tests the representative edge of a collapsed Via row, not every edge', () => {
      const collapsed = splitIntegrationLanes(
        [
          edge(page, acme, { via: agave, mechanism_name: 'Visible label' }),
          edge(page, acme, { via: agave, mechanism_name: 'Hidden label' }),
        ],
        [],
      );
      expect(collapsed.via[0].rows).toHaveLength(1);
      expect(collapsed.via[0].rows[0].integration.mechanism_name).toBe('Visible label');
      expect(filterIntegrationLanes(collapsed, 'visible').rowCount).toBe(1);
      expect(filterIntegrationLanes(collapsed, 'hidden').rowCount).toBe(0);
    });
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

  /**
   * AECI-966 — the hub matches a label it does not render, so that the two
   * adjacent sections behave identically. See `PoweredConnection.mechanismNames`.
   */
  describe('matching the mechanism label (AECI-966)', () => {
    const mechView = groupPoweredIntegrations(
      [
        { ...poweredEdge(hub, sage), mechanism_name: 'DWG file reader' },
        { ...poweredEdge(hub, esub), mechanism_name: 'IFC export' },
        { ...poweredEdge(hub, acme), mechanism_name: null },
        { ...poweredEdge(other, sage), mechanism_name: 'DWG round-trip' },
      ],
      connector.slug,
    );

    it('matches a partner row inside a hub card on its mechanism label', () => {
      const filtered = filterPoweredHubView(mechView, 'DWG');
      expect(filtered.groups[0].partners.map((p) => p.partner.slug)).toEqual(['sage-300-cre']);
    });

    it('matches a hubless pair on its mechanism label', () => {
      expect(filterPoweredHubView(mechView, 'round-trip').others).toHaveLength(1);
    });

    it('leaves a pair with no mechanism label reachable by name only', () => {
      expect(filterPoweredHubView(mechView, 'acme').pairCount).toBe(1);
      expect(filterPoweredHubView(mechView, 'zzz').pairCount).toBe(0);
    });
  });
});
