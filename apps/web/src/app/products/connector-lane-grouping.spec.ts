import type { ContextDirection, ProductIntegrationItem, ProductLink } from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import {
  applyDeferCut,
  routeIntegrationLane,
  splitIntegrationLanes,
} from './connector-lane-grouping';

/**
 * Unit tests for the Addendum C lane split (§13.2 routing, §13.3 presentation).
 * Pure functions, so these run under the plain Vitest runner (no TestBed) — the
 * rendering is covered by `product-detail.component.spec.ts`.
 */

const link = (slug: string, name = slug): ProductLink => ({
  id: `id-${slug}`,
  slug,
  name,
  logo_url: null,
});

let seq = 0;
const edge = (
  partial: Partial<ProductIntegrationItem> & {
    source: ProductLink;
    target: ProductLink;
  },
): ProductIntegrationItem => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  name: `${partial.source.name} ↔ ${partial.target.name}`,
  mechanism_kind: null,
  mechanism_name: null,
  direction: null,
  context_direction: null,
  via: null,
  powered_by_product: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  ...partial,
});

const procore = link('procore', 'Procore');
const sage = link('sage-intacct', 'Sage Intacct');
const acumatica = link('acumatica', 'Acumatica');
const vista = link('viewpoint-vista', 'Viewpoint Vista');
const agave = link('agave-erp-sync', 'Agave ERP Sync');
const aquifer = link('aquifer', 'Aquifer');
const kroo = link('kroo-connector', 'Kroo Connector');

describe('routeIntegrationLane — §13.2', () => {
  it('(a) keeps a Convention-A self-reference in the DIRECT lane', () => {
    // "Procore ships a connector on Aquifer": ONE edge, source Procore, target
    // Aquifer, powered_by Aquifer. Routed on the FK alone it would render a group
    // whose only partner is Aquifer — "Via Aquifer → Aquifer".
    const route = routeIntegrationLane(
      edge({
        source: procore,
        target: aquifer,
        mechanism_kind: 'iPaaS',
        powered_by_product: aquifer,
      }),
    );
    expect(route.lane).toBe('direct');
  });

  it('(a) applies to the SOURCE endpoint too, not just the target', () => {
    const route = routeIntegrationLane(
      edge({
        source: kroo,
        target: procore,
        mechanism_kind: 'iPaaS',
        powered_by_product: kroo,
      }),
    );
    expect(route.lane).toBe('direct');
  });

  it('(b) routes an evidenced pair by `via`', () => {
    const route = routeIntegrationLane(edge({ source: procore, target: sage, via: agave }));
    expect(route).toEqual({ lane: 'via', connector: agave });
  });

  it('(b) routes an un-migrated powered edge by `powered_by_product`', () => {
    // The un-migrated shape — the row is still in `integrations`. Preview and
    // staging D1 are not migrated by CI, so without this clause every connector
    // edge there renders as direct.
    const route = routeIntegrationLane(
      edge({
        source: procore,
        target: sage,
        mechanism_kind: 'marketplace-app',
        powered_by_product: agave,
      }),
    );
    expect(route).toEqual({ lane: 'via', connector: agave });
  });

  it('(c) routes an `iPaaS` edge with no connector to the UNNAMED group', () => {
    // 53 production rows, permanently: their connector (Zapier / Workato) is
    // parked review-side, so it has no `products` row to name.
    const route = routeIntegrationLane(
      edge({ source: procore, target: sage, mechanism_kind: 'iPaaS' }),
    );
    expect(route).toEqual({ lane: 'via', connector: null });
  });

  it('(c) keeps an unset-mechanism edge with no connector DIRECT', () => {
    // Unset is not a kind (AECI-698) — filing it under "Via" would invent an
    // attribution the data does not make. 19% of the review catalogue.
    expect(routeIntegrationLane(edge({ source: procore, target: sage })).lane).toBe('direct');
  });

  it('keeps ordinary accountable-party kinds direct', () => {
    for (const kind of ['native', 'marketplace-app', 'api', 'webhook', 'integrator'] as const) {
      expect(
        routeIntegrationLane(edge({ source: procore, target: sage, mechanism_kind: kind })).lane,
      ).toBe('direct');
    }
  });
});

describe('splitIntegrationLanes — §13.3', () => {
  it('returns an empty view for a product with no edges', () => {
    expect(splitIntegrationLanes([], [])).toEqual({ direct: [], via: [], rowCount: 0 });
  });

  it('puts the partner in `other` from whichever bucket the edge arrived in', () => {
    const view = splitIntegrationLanes(
      [edge({ source: procore, target: sage, mechanism_kind: 'native' })],
      [edge({ source: acumatica, target: procore, mechanism_kind: 'native' })],
    );
    expect(view.direct.map((r) => r.other.slug)).toEqual(['acumatica', 'sage-intacct']);
  });

  it('keeps ONE ROW PER EDGE in the direct lane — no collapse', () => {
    // Two mechanisms between the same pair are two accountable answers, and the
    // direct lane's identity is the edge (§13.3).
    const view = splitIntegrationLanes(
      [
        edge({ source: procore, target: sage, mechanism_kind: 'native' }),
        edge({ source: procore, target: sage, mechanism_kind: 'api' }),
      ],
      [],
    );
    expect(view.direct).toHaveLength(2);
    expect(view.rowCount).toBe(2);
  });

  it('collapses a Via group to one row per (connector, partner)', () => {
    const view = splitIntegrationLanes(
      [
        edge({ source: procore, target: sage, via: agave, context_direction: 'outbound' }),
        edge({ source: procore, target: sage, via: agave, context_direction: 'inbound' }),
      ],
      [],
    );
    expect(view.via).toHaveLength(1);
    expect(view.via[0]?.rows).toHaveLength(1);
    expect(view.via[0]?.rows[0]?.edgeCount).toBe(2);
    // Opposing one-ways describe a round trip — the same merge the connector
    // page's grouping applies, from the one shared definition.
    expect(view.via[0]?.rows[0]?.direction).toBe<ContextDirection>('both');
    expect(view.rowCount).toBe(1);
  });

  it('does NOT collapse two partners under one connector', () => {
    const view = splitIntegrationLanes(
      [
        edge({ source: procore, target: sage, via: agave }),
        edge({ source: procore, target: acumatica, via: agave }),
      ],
      [],
    );
    expect(view.via[0]?.rows.map((r) => r.other.slug)).toEqual(['acumatica', 'sage-intacct']);
    expect(view.rowCount).toBe(2);
  });

  it('keeps an evidenced row with no mechanism kind — the normal Via case', () => {
    // `connector_evidenced_pairs` has no `mechanism_kind` column, so an empty
    // badge set is construction, not a data smell. Never drop the row for it.
    const view = splitIntegrationLanes([edge({ source: procore, target: sage, via: agave })], []);
    expect(view.via[0]?.rows[0]?.mechanismKinds).toEqual([]);
    expect(view.rowCount).toBe(1);
  });

  it('merges distinct mechanism kinds into enum order on a collapsed row', () => {
    const view = splitIntegrationLanes(
      [
        edge({ source: procore, target: sage, mechanism_kind: 'api', powered_by_product: agave }),
        edge({ source: procore, target: sage, mechanism_kind: 'iPaaS', powered_by_product: agave }),
      ],
      [],
    );
    expect(view.via[0]?.rows[0]?.mechanismKinds).toEqual(['iPaaS', 'api']);
  });

  it('orders groups by row count desc, then connector name', () => {
    const view = splitIntegrationLanes(
      [
        edge({ source: procore, target: sage, via: kroo }),
        edge({ source: procore, target: acumatica, via: kroo }),
        edge({ source: procore, target: vista, via: agave }),
      ],
      [],
    );
    expect(view.via.map((g) => g.key)).toEqual(['kroo-connector', 'agave-erp-sync']);
  });

  it('sorts the unnamed group LAST, whatever its size', () => {
    const view = splitIntegrationLanes(
      [
        edge({ source: procore, target: sage, mechanism_kind: 'iPaaS' }),
        edge({ source: procore, target: acumatica, mechanism_kind: 'iPaaS' }),
        edge({ source: procore, target: vista, via: agave }),
      ],
      [],
    );
    expect(view.via.map((g) => g.connector?.slug ?? null)).toEqual(['agave-erp-sync', null]);
    expect(view.via[1]?.rows).toHaveLength(2);
  });

  it('never invents a connector name for the unnamed group', () => {
    const view = splitIntegrationLanes(
      [edge({ source: procore, target: sage, mechanism_kind: 'iPaaS' })],
      [],
    );
    expect(view.via[0]?.connector).toBeNull();
    expect(view.via[0]?.key).toBe('');
  });

  it('sums the sub-counts to the heading count across both lanes', () => {
    const view = splitIntegrationLanes(
      [
        edge({ source: procore, target: sage, mechanism_kind: 'native' }),
        edge({ source: procore, target: acumatica, via: agave }),
        edge({ source: procore, target: vista, mechanism_kind: 'iPaaS' }),
      ],
      [],
    );
    const sum = view.direct.length + view.via.reduce((n, g) => n + g.rows.length, 0);
    expect(view.rowCount).toBe(sum);
    expect(view.rowCount).toBe(3);
  });

  it('keeps every row key unique across both lanes', () => {
    const view = splitIntegrationLanes(
      [
        edge({ source: procore, target: sage, mechanism_kind: 'native' }),
        edge({ source: procore, target: sage, via: agave }),
        edge({ source: procore, target: sage, mechanism_kind: 'iPaaS' }),
      ],
      [],
    );
    const keys = [view.direct, ...view.via.map((g) => g.rows)].flat().map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('files a Convention-A edge into the direct lane, so no self-partner group appears', () => {
    const view = splitIntegrationLanes(
      [],
      [
        edge({
          source: procore,
          target: aquifer,
          mechanism_kind: 'iPaaS',
          powered_by_product: aquifer,
        }),
      ],
    );
    expect(view.via).toEqual([]);
    expect(view.direct.map((r) => r.other.slug)).toEqual(['procore']);
  });
});

describe('applyDeferCut — the FLATTENED §13.3 cut', () => {
  const view = (directCount: number, groupCounts: readonly number[]) =>
    splitIntegrationLanes(
      [
        ...Array.from({ length: directCount }, (_, i) =>
          edge({ source: procore, target: link(`direct-${i}`), mechanism_kind: 'native' }),
        ),
        ...groupCounts.flatMap((count, g) =>
          Array.from({ length: count }, (_, i) =>
            edge({
              source: procore,
              target: link(`p-${g}-${i}`),
              via: link(`c-${g}`, `Connector ${g}`),
            }),
          ),
        ),
      ],
      [],
    );

  it('spends the budget on the direct lane first, then the groups in order', () => {
    // The arithmetic that looks right and is off by a lane: with a 20-row cut a
    // 15-row direct lane leaves FIVE for the first group, not twenty.
    const cut = applyDeferCut(view(15, [8]), 20);
    expect(cut.direct.above).toHaveLength(15);
    expect(cut.direct.deferred).toHaveLength(0);
    expect(cut.via[0]?.above).toHaveLength(5);
    expect(cut.via[0]?.deferred).toHaveLength(3);
  });

  it('defers a lane wholly past the boundary in one piece', () => {
    const cut = applyDeferCut(view(25, [4]), 20);
    expect(cut.direct.above).toHaveLength(20);
    expect(cut.direct.deferred).toHaveLength(5);
    expect(cut.via[0]?.above).toHaveLength(0);
    expect(cut.via[0]?.deferred).toHaveLength(4);
  });

  it('renders everything above the fold when the section is smaller than the cut', () => {
    const cut = applyDeferCut(view(2, [3]), 20);
    expect(cut.direct.deferred).toHaveLength(0);
    expect(cut.via[0]?.deferred).toHaveLength(0);
  });

  it('partitions every row exactly once', () => {
    const v = view(9, [7, 6]);
    const cut = applyDeferCut(v, 20);
    const total =
      cut.direct.above.length +
      cut.direct.deferred.length +
      cut.via.reduce((n, l) => n + l.above.length + l.deferred.length, 0);
    expect(total).toBe(v.rowCount);
  });
});
