import {
  IntegrationMechanismKindSchema,
  type IntegrationListItem,
  type ProductLink,
} from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import {
  connectedProductCount,
  groupPoweredIntegrations,
  MECHANISM_ORDER,
} from './powered-hub-grouping';

/**
 * Unit tests for the Addendum B hub-grouping heuristic. Pure function, so these
 * run under the plain Vitest runner (no TestBed) — the component's rendering is
 * covered by `product-detail.component.spec.ts`.
 */

/**
 * The page product whose view is being grouped. Every fixture below is a
 * third-party pair, so this slug never appears as an endpoint and the §13.4(2)
 * self-exclusion is a no-op for the pre-existing cases; the Convention-A cases
 * at the bottom of the file are the ones that exercise it.
 */
const CONNECTOR = 'agave-erp-sync';

const link = (slug: string, name = slug): ProductLink => ({
  id: `id-${slug}`,
  slug,
  name,
  logo_url: null,
});

let seq = 0;
const edge = (
  source: ProductLink,
  target: ProductLink,
  mechanismKind: IntegrationListItem['mechanism_kind'] = 'native',
  direction: IntegrationListItem['direction'] = null,
): IntegrationListItem => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  name: `${source.name} ↔ ${target.name}`,
  mechanism_kind: mechanismKind,
  mechanism_name: null,
  direction,
  source,
  target,
  via: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
});

describe('groupPoweredIntegrations', () => {
  const procore = link('procore', 'Procore');
  const acc = link('autodesk-construction-cloud', 'Autodesk Construction Cloud');
  const acumatica = link('acumatica', 'Acumatica');
  const sage = link('sage-intacct', 'Sage Intacct');
  const vista = link('viewpoint-vista', 'Viewpoint Vista');
  const quickbooks = link('quickbooks-online', 'QuickBooks Online');
  const roofr = link('roofr', 'Roofr');

  it('returns an empty view for an empty edge list', () => {
    expect(groupPoweredIntegrations([], CONNECTOR)).toEqual({
      groups: [],
      others: [],
      pairCount: 0,
    });
  });

  it('files every pair under the globally more frequent endpoint, regardless of orientation', () => {
    // Procore appears in all three edges; the stored orientation flips between
    // them, which must not change which side is the hub.
    const { groups, others, pairCount } = groupPoweredIntegrations(
      [edge(procore, acumatica), edge(sage, procore), edge(procore, vista)],
      CONNECTOR,
    );

    expect(groups).toHaveLength(1);
    expect(others).toEqual([]);
    expect(pairCount).toBe(3);
    expect(groups[0]!.hub.slug).toBe('procore');
    expect(groups[0]!.partners.map((p) => p.partner.slug)).toEqual([
      'acumatica',
      'sage-intacct',
      'viewpoint-vista',
    ]);
  });

  it('never lets one product be both a hub heading and a partner row', () => {
    // The live Agave ERP Sync shape, and the regression this rewrite exists for.
    // Deciding a hub per EDGE made ACC win `ACC↔QuickBooks` and QuickBooks win
    // `QuickBooks↔Roofr`, so QuickBooks rendered as a partner AND as a hub.
    const { groups, others, pairCount } = groupPoweredIntegrations(
      [
        edge(acc, acumatica),
        edge(acc, link('cmic', 'CMiC')),
        edge(acc, quickbooks),
        edge(roofr, quickbooks),
      ],
      CONNECTOR,
    );

    expect(pairCount).toBe(4);
    expect(groups.map((g) => g.hub.slug)).toEqual(['autodesk-construction-cloud']);
    expect(groups[0]!.partners.map((p) => p.partner.slug)).toEqual([
      'acumatica',
      'cmic',
      'quickbooks-online',
    ]);
    // The hubless pair falls through to `others` rather than promoting
    // QuickBooks — already spent as a partner — to a second hub.
    expect(others.map((o) => o.key)).toEqual(['quickbooks-online::roofr']);

    const hubSlugs = new Set(groups.map((g) => g.hub.slug));
    const partnerSlugs = new Set(groups.flatMap((g) => g.partners.map((p) => p.partner.slug)));
    expect([...hubSlugs].filter((s) => partnerSlugs.has(s))).toEqual([]);
  });

  it('leaves a lone pair hubless instead of inventing a one-partner hub', () => {
    const { groups, others, pairCount } = groupPoweredIntegrations(
      [edge(procore, acumatica)],
      CONNECTOR,
    );

    expect(groups).toEqual([]);
    expect(pairCount).toBe(1);
    expect(others).toHaveLength(1);
    // Canonical pair orientation: `a` is the alphabetically-first slug.
    expect(others[0]!.a.slug).toBe('acumatica');
    expect(others[0]!.b.slug).toBe('procore');
  });

  it('collapses duplicate edges for one pair into a single row and counts pairs, not edges', () => {
    // The live NetSuite Connector by Appficiency shape: 4 edges, 2 pairs, each
    // pair duplicated. The heading counts `pairCount`, so it must read 2.
    const projectSosAed = link('projectsos-aed', 'ProjectSOS for Architecture');
    const projectSosCon = link('projectsos-construction', 'ProjectSOS for Construction');
    const { groups, pairCount } = groupPoweredIntegrations(
      [
        edge(projectSosAed, procore, 'marketplace-app', 'bidirectional'),
        edge(projectSosCon, procore, 'marketplace-app', 'bidirectional'),
        edge(projectSosAed, procore, 'marketplace-app', 'bidirectional'),
        edge(projectSosCon, procore, 'marketplace-app', 'bidirectional'),
      ],
      CONNECTOR,
    );

    expect(pairCount).toBe(2);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.hub.slug).toBe('procore');
    expect(groups[0]!.partners).toHaveLength(2);
    expect(groups[0]!.partners.every((p) => p.edgeCount === 2)).toBe(true);
    // Both edges carried the same kind, so it stays a single badge — not "2 types".
    expect(groups[0]!.partners.map((p) => p.mechanismKinds)).toEqual([
      ['marketplace-app'],
      ['marketplace-app'],
    ]);
  });

  it('gathers distinct mechanism kinds for one pair in enum order', () => {
    const { groups } = groupPoweredIntegrations(
      [
        edge(procore, acumatica, 'iPaaS'),
        edge(acumatica, procore, 'native'),
        edge(procore, sage, 'native'),
      ],
      CONNECTOR,
    );

    expect(groups[0]!.hub.slug).toBe('procore');
    const acumaticaRow = groups[0]!.partners.find((p) => p.partner.slug === 'acumatica');
    // Declaration order (native before iPaaS), not authoring order.
    expect(acumaticaRow!.mechanismKinds).toEqual(['native', 'iPaaS']);
    expect(acumaticaRow!.edgeCount).toBe(2);
  });

  it('keeps a pair whose edges carry NO kind, with an empty badge set (AECI-721)', () => {
    // Every connector-evidenced pair hits this: `connector_evidenced_pairs` has no
    // `mechanism_kind` column at all, so the payload row is null-kinded by
    // construction rather than by omission. Dropping such a pair for want of a kind
    // would empty the hub on exactly the pages whose entire subject it is.
    const { groups } = groupPoweredIntegrations([
      edge(procore, acumatica, null),
      edge(procore, sage, null),
    ]);

    expect(groups[0]!.hub.slug).toBe('procore');
    expect(groups[0]!.partners.map((p) => p.partner.slug).sort()).toEqual([
      'acumatica',
      'sage-intacct',
    ]);
    // No badge, but the row survives — `mechanismSummary()` renders '' for this.
    expect(groups[0]!.partners.every((p) => p.mechanismKinds.length === 0)).toBe(true);
  });

  it('mixes kinded and kindless edges on one pair without losing either', () => {
    // The transitional shape: one edge still in `integrations` carrying a kind, one
    // already migrated to the evidenced tier carrying none. The badge reflects only
    // what is actually asserted; the edge count reflects both.
    //
    // One distinct pair, so it lands in `others` rather than forming a hub
    // (`MIN_PAIRS_FOR_HUB` is 2) — the collapse still has to be right there.
    const { groups, others } = groupPoweredIntegrations([
      edge(procore, acumatica, 'marketplace-app'),
      edge(procore, acumatica, null),
    ]);

    expect(groups).toEqual([]);
    expect(others).toHaveLength(1);
    expect(others[0]!.mechanismKinds).toEqual(['marketplace-app']);
    expect(others[0]!.edgeCount).toBe(2);
  });

  it('badges `integrator`, which MECHANISM_ORDER filters rather than orders', () => {
    // `freeze()` uses MECHANISM_ORDER as a filter, so a kind missing from that list
    // is silently dropped instead of sorted last. Pinned because `integrator` has
    // zero rows until the review app re-keys, so nothing else would catch it.
    const { groups } = groupPoweredIntegrations([
      edge(procore, acumatica, 'integrator'),
      edge(procore, sage, 'native'),
    ]);
    const row = groups[0]!.partners.find((p) => p.partner.slug === 'acumatica');
    expect(row!.mechanismKinds).toEqual(['integrator']);
  });

  it('frames direction relative to the hub, mirroring it when the hub is endpoint B', () => {
    // `one-way` flows source → target. Procore is the hub in both rows, but is
    // the source in one and the target in the other, so the hub-relative
    // direction must come out opposite.
    const { groups } = groupPoweredIntegrations(
      [
        edge(procore, acumatica, 'native', 'one-way'),
        edge(sage, procore, 'native', 'one-way'),
        edge(procore, vista, 'native', 'bidirectional'),
      ],
      CONNECTOR,
    );

    const byPartner = new Map(groups[0]!.partners.map((p) => [p.partner.slug, p.hubDirection]));
    expect(groups[0]!.hub.slug).toBe('procore');
    expect(byPartner.get('acumatica')).toBe('outbound'); // data leaves Procore
    expect(byPartner.get('sage-intacct')).toBe('inbound'); // data arrives at Procore
    expect(byPartner.get('viewpoint-vista')).toBe('both');
  });

  it('merges two opposing one-way edges for the same pair into a round trip', () => {
    const { groups } = groupPoweredIntegrations(
      [
        edge(procore, acumatica, 'native', 'one-way'),
        edge(acumatica, procore, 'iPaaS', 'one-way'),
        edge(procore, sage, 'native', 'one-way'),
      ],
      CONNECTOR,
    );

    const acumaticaRow = groups[0]!.partners.find((p) => p.partner.slug === 'acumatica');
    expect(acumaticaRow!.hubDirection).toBe('both');
  });

  it('leaves direction null when no collapsed edge carried one', () => {
    const { groups } = groupPoweredIntegrations(
      [edge(procore, acumatica), edge(procore, sage)],
      CONNECTOR,
    );
    expect(groups[0]!.partners.every((p) => p.hubDirection === null)).toBe(true);
  });

  it('sorts groups by partner count descending; partners by name', () => {
    const bluebeam = link('bluebeam', 'Bluebeam');
    const extra = link('extra-platform', 'Extra Platform');
    const { groups } = groupPoweredIntegrations(
      [
        // ACC hub: 3 partners.
        edge(acc, acumatica),
        edge(acc, vista),
        edge(acc, sage),
        // Procore hub: 4 partners → sorts first despite being authored second.
        edge(procore, bluebeam),
        edge(procore, extra),
        edge(procore, quickbooks),
        edge(procore, roofr),
      ],
      CONNECTOR,
    );

    expect(groups.map((g) => g.hub.slug)).toEqual(['procore', 'autodesk-construction-cloud']);
    expect(groups[0]!.partners.map((p) => p.partner.name)).toEqual([
      'Bluebeam',
      'Extra Platform',
      'QuickBooks Online',
      'Roofr',
    ]);
    expect(groups[1]!.partners.map((p) => p.partner.name)).toEqual([
      'Acumatica',
      'Sage Intacct',
      'Viewpoint Vista',
    ]);
  });

  it('breaks an equal-degree hub tie on slug, and an equal-size group tie on hub name', () => {
    const zed = link('zed-platform', 'Zed Platform');
    const able = link('able-platform', 'Able Platform');
    const { groups } = groupPoweredIntegrations(
      [
        edge(zed, link('w-one', 'W One')),
        edge(zed, link('w-two', 'W Two')),
        edge(able, link('x-one', 'X One')),
        edge(able, link('x-two', 'X Two')),
      ],
      CONNECTOR,
    );

    expect(groups.map((g) => g.hub.name)).toEqual(['Able Platform', 'Zed Platform']);
    expect(groups.every((g) => g.partners.length === 2)).toBe(true);
  });

  it('skips a corrupt self-edge instead of emitting a self-referencing row', () => {
    const { groups, others, pairCount } = groupPoweredIntegrations(
      [edge(procore, procore), edge(procore, acumatica)],
      CONNECTOR,
    );

    expect(pairCount).toBe(1);
    expect(groups).toEqual([]);
    expect(others).toHaveLength(1);
    expect(others[0]!.key).toBe('acumatica::procore');
  });

  /**
   * §13.4(2). The Drizzle relation selects on `powered_by_product_id` alone, so
   * a Convention-A edge (§13.2a: "X ships a connector on platform C" stored as
   * source X, target C, powered_by C) is hydrated into the endpoint buckets AND
   * this one. Rendering it here would duplicate it: once in `#integrations`,
   * once in `#powered-integrations`.
   */
  it('excludes a Convention-A edge that names the page product as an endpoint', () => {
    const self = link(CONNECTOR, 'Agave ERP Sync');
    const { groups, others, pairCount } = groupPoweredIntegrations(
      [edge(procore, self), edge(acumatica, self), edge(procore, acumatica)],
      CONNECTOR,
    );

    // Only the third-party pair survives; the two self-referencing edges belong
    // to the endpoint lane, where §13.2(a) keeps them direct.
    expect(pairCount).toBe(1);
    expect(groups).toEqual([]);
    expect(others.map((o) => o.key)).toEqual(['acumatica::procore']);
  });

  it('empties the view entirely when every edge is Convention A (the Aquifer / Kroo shape)', () => {
    const self = link(CONNECTOR, 'Agave ERP Sync');
    const view = groupPoweredIntegrations(
      [edge(procore, self), edge(acumatica, self), edge(sage, self)],
      CONNECTOR,
    );

    // This is what `showPowered` reads to suppress the section rather than
    // render an empty state contradicting the hero line.
    expect(view).toEqual({ groups: [], others: [], pairCount: 0 });
  });
});

/**
 * The hero line's catalog-reach figure (§13.6). Deliberately reads the RAW edge
 * list, unlike the grouping above, so a Convention-A connector reports the
 * products it reaches rather than the zero pairs it sits in the middle of.
 */
describe('connectedProductCount', () => {
  const procore = link('procore', 'Procore');
  const acumatica = link('acumatica', 'Acumatica');
  const sage = link('sage-intacct', 'Sage Intacct');
  const self = link(CONNECTOR, 'Agave ERP Sync');

  it('is 0 for an empty edge list', () => {
    expect(connectedProductCount([], CONNECTOR)).toBe(0);
  });

  it('counts distinct endpoint products, not pairs and not edges', () => {
    // Procore appears in two pairs and Acumatica in two edges of the same pair;
    // three distinct products are reached.
    expect(
      connectedProductCount(
        [edge(procore, acumatica), edge(acumatica, procore, 'iPaaS'), edge(procore, sage)],
        CONNECTOR,
      ),
    ).toBe(3);
  });

  it('drops the page product itself, so Convention A reports reach rather than zero', () => {
    // The Aquifer shape at small scale: every edge names the connector as an
    // endpoint. A naive distinct-endpoint count returns 4 (three partners plus
    // the connector); §13.6 excludes the self-reference, so it is 3 -- and NOT
    // the 0 the grouped view reports for the same input.
    const edges = [edge(procore, self), edge(acumatica, self), edge(sage, self)];

    expect(connectedProductCount(edges, CONNECTOR)).toBe(3);
    expect(groupPoweredIntegrations(edges, CONNECTOR).pairCount).toBe(0);
  });
});

/**
 * The web end of the mechanism-vocabulary lockstep (AECI-735).
 *
 * `MECHANISM_ORDER` is used by `freeze()` as a **filter**, so a kind missing from it
 * is dropped from the pair's badges entirely rather than ordered last — a SILENT
 * content loss, with no type error and no runtime throw to notice. That makes it the
 * sharpest of the five spellings of this vocabulary and the reason this assertion
 * exists; the other four are covered in `packages/shared/src/api/integrations.spec.ts`
 * and `apps/api/src/test/mechanism-vocabulary.spec.ts`.
 */
describe('MECHANISM_ORDER (vocabulary lockstep)', () => {
  it('lists every mechanism kind — it is a FILTER, so a gap silently drops badges', () => {
    expect([...MECHANISM_ORDER].sort()).toEqual([...IntegrationMechanismKindSchema.options].sort());
  });
});
