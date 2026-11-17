import { describe, expect, it } from 'vitest';

import type { IntegrationTerm, ProductIntegrationItem, ProductLink } from '@aeci/shared';

import { categoryHub } from './category-hub';
import { splitIntegrationLanes } from './connector-lane-grouping';
import {
  NO_INTEGRATION_FILTER,
  filterIntegrationLanes,
  partnerCategoryOptions,
} from './integration-filter';

/**
 * AECI-1787 review: the hero's category hub and the Integrations section's category
 * chip must tell the reader the same thing. For every hub entry, pressing the chip of
 * the same category shows exactly the hub's count ("Showing N of M"), and the hub lists
 * exactly the chips, A to Z.
 *
 * `categoryHub` counts on its own today, so this pins the two to each other. A change
 * to either the hub or the filter that makes them disagree fails here.
 */

function link(slug: string, name: string): ProductLink {
  return { id: 'p-' + slug, slug, name, logo_url: null };
}

const term = (slug: string, name: string): IntegrationTerm => ({ slug, name });

let seq = 0;
function edge(
  source: ProductLink,
  target: ProductLink,
  overrides: Partial<ProductIntegrationItem> = {},
): ProductIntegrationItem {
  seq += 1;
  return {
    id: '00000000-0000-4000-8000-0000001' + String(seq).padStart(5, '0'),
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
    data_objects: [],
    partner_categories: [],
    agreement: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function fixture(): { asSource: ProductIntegrationItem[]; asTarget: ProductIntegrationItem[] } {
  seq = 0;
  const self = link('self', 'Self');
  const mind = link('mindcloud', 'Mindcloud');
  const acc = term('accounting', 'Accounting');
  const ai = term('ai', 'AI');
  const bim = term('bim', 'bim authoring');
  const docsA = term('docs-a', 'Documents');
  const docsB = term('docs-b', 'Documents');
  const cats = (...t: IntegrationTerm[]) => ({ partner_categories: t });
  const a = link('a', 'Alpha');
  const b = link('b', 'Beta');
  const c = link('c', 'Gamma');
  const d = link('d', 'Delta');
  const e = link('e', 'Epsilon');
  const none = link('none', 'No category');
  return {
    asSource: [
      edge(self, a, cats(acc, ai)),
      // Two direct edges to one partner: two rows, both counted.
      edge(self, a, { ...cats(acc, ai), mechanism_kind: 'native' }),
      // Two via edges to one partner through one connector: merged into one row.
      edge(self, b, { ...cats(bim, docsA), mechanism_kind: 'iPaaS', powered_by_product: mind }),
      // A connector that is one of the endpoints keeps the row direct.
      edge(self, c, { ...cats(docsB), powered_by_product: self }),
      // The unnamed bucket: iPaaS with no connector on record.
      edge(self, d, { ...cats(ai), mechanism_kind: 'iPaaS' }),
      // A partner listed with one category twice.
      edge(self, e, cats(acc, acc)),
      edge(self, none, { mechanism_kind: 'iPaaS', powered_by_product: mind }),
    ],
    asTarget: [
      edge(b, self, { ...cats(bim, docsA), mechanism_kind: 'iPaaS', powered_by_product: mind }),
      edge(none, self),
    ],
  };
}

describe('categoryHub agrees with the category filter (AECI-1787)', () => {
  it('each entry counts what its chip shows, and the entries are the chips', () => {
    const { asSource, asTarget } = fixture();
    const view = splitIntegrationLanes(asSource, asTarget);
    const hub = categoryHub(asSource, asTarget);

    expect(hub.map((h) => [h.slug, h.name])).toEqual(
      partnerCategoryOptions(view).map((t) => [t.slug, t.name]),
    );
    for (const entry of hub) {
      const shown = filterIntegrationLanes(view, {
        ...NO_INTEGRATION_FILTER,
        partnerCategories: [entry.slug],
      }).rowCount;
      expect(entry.count, entry.slug).toBe(shown);
    }
    // The fixture exercises the cases the counts could split on.
    expect(hub.map((h) => [h.slug, h.count])).toEqual([
      ['accounting', 3],
      ['ai', 3],
      ['bim', 1],
      ['docs-a', 1],
      ['docs-b', 1],
    ]);
    // A row under two categories counts under both, so the entries sum past the rows.
    expect(view.rowCount).toBe(8);
  });

  it('lists nothing when no partner has a category, as the chips do', () => {
    const none = link('none', 'No category');
    const self = link('self', 'Self');
    const rows = [edge(self, none), edge(none, self)];
    expect(categoryHub(rows, [])).toEqual([]);
    expect(partnerCategoryOptions(splitIntegrationLanes(rows, []))).toEqual([]);
  });
});
