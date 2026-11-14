/**
 * The on-page ordering firewall, browser half (AECI-1814, `STAGE_2_PAID_TIERS_SPEC.md`
 * §3.2 assertion 8; ruling R1 on AECI-1732).
 *
 * No on-page sort, default order or featured subset may read an input that only a
 * paid plan can change. The browser orders three lists itself, so they are tested
 * here, behaviourally: build a fixture, change one input that is not an order input,
 * and assert that nothing moved.
 *
 *  - the endpoint product page's Integrations section (`connector-lane-grouping.ts`):
 *    the direct lane, the "Via {connector}" groups, and the rows above the `@defer`
 *    cut, which are a featured subset;
 *  - the connector page's "Integrations it powers" hubs (`powered-hub-grouping.ts`);
 *  - the taxonomy term ranking (`taxonomy-rank.ts`, `search-facet-order.ts`), which is
 *    the one tolerated exception (`taxonomy-term-product-count`, below).
 *
 * The API half, and the registry of every ordered surface, is
 * `apps/api/src/lib/on-page-ordering-firewall.spec.ts`. That spec checks that every
 * `[surface:…]` tag in a test title below names a surface in its registry.
 *
 * Ruling R1 (Chris, 2026-11-14): "Maintain orders as they are. If its a new feature a
 * to z". So the existing orders below are asserted exactly as they ship. The via
 * groups and the powered hubs keep their count order, which is safe because no
 * capability gates any write that changes those counts (proved in the API half).
 */

import {
  PoweredIntegrationItemSchema,
  ProductIntegrationItemSchema,
  TaxonomyTermWithCountSchema,
  type PoweredIntegrationItem,
  type ProductIntegrationItem,
  type ProductLink,
  type TaxonomyTermWithCount,
} from '@aeci/shared';
import {
  CAPABILITIES,
  PRODUCT_FIELD_CAPABILITIES,
  TIER_CAPABILITIES,
  type Capability,
} from '@aeci/shared/entitlements';
import { compareText } from '@aeci/shared/text-sort';
import { describe, expect, it } from 'vitest';

import { TOP_N, byDisplayOrder, topByCount } from '../core/taxonomy/taxonomy-rank';
import type { RefinementItem } from '../shared/facets/refinement-item';
import { orderFacetItems } from '../search/search-facet-order';

import { applyDeferCut, splitIntegrationLanes } from './connector-lane-grouping';
import { groupPoweredIntegrations } from './powered-hub-grouping';

// ─── The registry ─────────────────────────────────────────────────────────────

/** The Free plan's capabilities, and the ones only a Managed plan holds. */
const FREE = new Set<Capability>(TIER_CAPABILITIES.unclaimed);
const MANAGED_ONLY = CAPABILITIES.filter((c) => !FREE.has(c));

/**
 * Who can change an order input. A capability writer must be in the Free set. The
 * named writers are capability-free by proof in the API half: `seat` writes are
 * the integration create, edit and retire routes, none of which consults the registry.
 */
type Writer = 'not-vendor-editable' | 'promote-only' | 'seat' | Capability;

/**
 * Every field of a product page integration row, sorted into the fields the order
 * may read and the fields it may not. A field the schema gains that is in neither
 * list fails `classifies every row field`, so a new field cannot become an order
 * input without someone deciding its writer.
 */
const ENDPOINT_ORDER_INPUTS: Readonly<Record<string, Writer>> = {
  id: 'not-vendor-editable',
  // The owner edits it with a seat (AECI-1006). No capability (`STAGE_2_PAID_TIERS_SPEC.md` §3.1).
  name: 'seat',
  // The partner's name and slug. A product rename is a correction request: `name`
  // is absent from PRODUCT_FIELD_CAPABILITIES, asserted below.
  source: 'not-vendor-editable',
  target: 'not-vendor-editable',
  // Lane routing. A vendor create has no `powered_by` field and refuses `iPaaS`.
  via: 'promote-only',
  powered_by_product: 'promote-only',
  mechanism_kind: 'seat',
};

const ENDPOINT_PAYLOAD_FIELDS = [
  'mechanism_name',
  'direction',
  'context_direction',
  // The data-flow count. Vendor-added data objects need `attestation.author`.
  'data_object_slugs',
  // "Maintained by" and corrections: edit stamps a Managed vendor moves.
  'caption',
  'corrections',
  'under_review',
  'created_at',
  'updated_at',
] as const;

/**
 * Row fields AECI-1781 (PR #1275) adds and the redesign will be tempted to sort by.
 * Classified now, so they are flipped below before they exist and the schema check
 * passes the day they land. `agreement` is "confirmed by both companies", which R1
 * keeps a row label only. `data_objects` is the data-flow count with names.
 * `partner_categories` is Free-editable, but R1 orders new lists by name alone.
 */
const PENDING_ROW_FIELDS = ['agreement', 'data_objects', 'partner_categories'] as const;

/** The connector page's hub rows read only the two endpoints. */
const POWERED_ORDER_INPUTS: Readonly<Record<string, Writer>> = {
  source: 'not-vendor-editable',
  target: 'not-vendor-editable',
};

const POWERED_PAYLOAD_FIELDS = [
  'id',
  'name',
  'mechanism_kind',
  'mechanism_name',
  'direction',
  'via',
  'data_object_slugs',
  'created_at',
  'updated_at',
] as const;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const link = (slug: string, name: string): ProductLink => ({
  id: `id-${slug}`,
  slug,
  name,
  logo_url: null,
});

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

const page = link('procore', 'Procore');
const agave = link('agave-erp-sync', 'Agave ERP Sync');
const kroo = link('kroo-connector', 'Kroo Connector');
const boomi = link('boomi', 'Boomi');

const endpointEdge = (
  partner: ProductLink,
  name: string,
  extra: Partial<ProductIntegrationItem> = {},
): ProductIntegrationItem => ({
  id: uuid(),
  name,
  mechanism_kind: 'native',
  mechanism_name: null,
  direction: null,
  context_direction: null,
  source: page,
  target: partner,
  via: null,
  powered_by_product: null,
  data_object_slugs: [],
  caption: null,
  corrections: [],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  ...extra,
});

/**
 * A product page with every lane case: mixed-case partner names (A to Z must not be
 * case-sensitive), a partner with two direct edges (the edge-name tie-break), a
 * Convention-A self-reference, three named Via groups of 3, 2 and 2 rows (the count
 * order and its name tie-break), a collapsed Via row, and the unnamed iPaaS bucket.
 */
function endpointFixture(): {
  asSource: ProductIntegrationItem[];
  asTarget: ProductIntegrationItem[];
} {
  seq = 0;
  const zeta = link('zeta-erp', 'Zeta ERP');
  const alpha = link('alpha-docs', 'alpha docs');
  const mid = link('mid-field', 'Mid Field');
  const sage = link('sage-intacct', 'Sage Intacct');
  const vista = link('viewpoint-vista', 'Viewpoint Vista');
  const acumatica = link('acumatica', 'Acumatica');
  const quickbooks = link('quickbooks', 'QuickBooks');
  const xero = link('xero', 'Xero');
  return {
    asSource: [
      endpointEdge(zeta, 'Zeta sync'),
      endpointEdge(alpha, 'Alpha link'),
      endpointEdge(mid, 'mid bridge B'),
      endpointEdge(mid, 'Mid bridge A'),
      // Convention A: powered_by is one of the row's own endpoints, so it stays direct.
      endpointEdge(agave, 'Procore on Agave', { powered_by_product: agave }),
      endpointEdge(sage, 'Sage via Agave', { via: agave, mechanism_kind: null }),
      endpointEdge(vista, 'Vista via Agave', { via: agave, mechanism_kind: null }),
      endpointEdge(acumatica, 'Acumatica via Agave', { via: agave, mechanism_kind: null }),
      endpointEdge(quickbooks, 'QuickBooks via Kroo 2', { via: kroo, mechanism_kind: null }),
      endpointEdge(quickbooks, 'QuickBooks via Kroo 1', { via: kroo, mechanism_kind: null }),
      endpointEdge(xero, 'Xero via Kroo', { via: kroo, mechanism_kind: null }),
      endpointEdge(sage, 'Sage via Boomi', { via: boomi, mechanism_kind: null }),
      endpointEdge(xero, 'Xero via Boomi', { via: boomi, mechanism_kind: null }),
      endpointEdge(zeta, 'Zeta over iPaaS', { mechanism_kind: 'iPaaS' }),
    ],
    asTarget: [
      // The page product is the target here, so the partner is the source.
      { ...endpointEdge(page, 'Bluebeam to Procore'), source: link('bluebeam', 'Bluebeam') },
    ],
  };
}

/** Everything about a lane view's order, and nothing else. */
function laneOrder(asSource: ProductIntegrationItem[], asTarget: ProductIntegrationItem[]) {
  const view = splitIntegrationLanes(asSource, asTarget);
  const cut = applyDeferCut(view, 6);
  return {
    direct: view.direct.map((r) => r.key),
    via: view.via.map((g) => ({ group: g.key, rows: g.rows.map((r) => r.key) })),
    // The edge a collapsed Via row shows as its representative.
    representatives: view.via.flatMap((g) => g.rows.map((r) => r.integration.id)),
    // The featured subset: rows rendered before the `@defer` boundary.
    aboveTheFold: [
      ...cut.direct.above.map((r) => r.key),
      ...cut.via.flatMap((g) => g.above.map((r) => r.key)),
    ],
  };
}

/**
 * A value for a non-order field that would reorder the rows if the order read it.
 * `weight` is the row's position in the fixture, which is not A to Z order, so a
 * "most evidence first" or "least first" order would differ from today's. The
 * deliberate-failure run in AECI-1814 showed exactly that for `data_object_slugs`.
 */
function managedValue(field: string, weight: number): unknown {
  const many = Array.from({ length: weight + 1 }, (_, i) => `object-${weight}-${i}`);
  switch (field) {
    case 'data_object_slugs':
      return many;
    case 'data_objects':
      return many.map((slug) => ({ slug, name: slug }));
    case 'agreement':
      return weight % 2 === 0 ? 'confirmed' : 'unverified';
    case 'partner_categories':
      return [{ slug: `category-${weight}`, name: `Category ${String.fromCharCode(90 - weight)}` }];
    case 'caption':
      return {
        form: 'updated',
        vendor_names: [`Vendor ${weight}`],
        date: `2026-11-${10 + weight}`,
      };
    case 'corrections':
      return many.map((f) => ({ field: f, date: '2026-11-01', source_url: null, cleared: false }));
    case 'under_review':
      return weight % 2 === 0 ? ['description'] : [];
    case 'context_direction':
    case 'direction':
      return weight % 2 === 0 ? 'both' : 'outbound';
    case 'mechanism_name':
      return `${String.fromCharCode(90 - weight)} mechanism`;
    case 'mechanism_kind':
      return weight % 2 === 0 ? 'api' : 'webhook';
    case 'id':
      return `ffffffff-0000-4000-8000-${String(1000 - weight).padStart(12, '0')}`;
    case 'name':
      return `${String.fromCharCode(90 - weight)} edge`;
    case 'via':
      return weight % 2 === 0 ? link(`via-${weight}`, `Via ${weight}`) : null;
    case 'created_at':
    case 'updated_at':
      return `2026-${String((weight % 12) + 1).padStart(2, '0')}-01T00:00:00.000Z`;
    default:
      throw new Error(`No managed value for ${field}: add one before classifying it`);
  }
}

/** The same rows, with `fields` rewritten. The cast is what lets a field AECI-1781
 *  has not landed yet ride on today's type. */
function flip<T extends object>(rows: readonly T[], fields: readonly string[]): T[] {
  return rows.map(
    (row, i) =>
      ({ ...row, ...Object.fromEntries(fields.map((f) => [f, managedValue(f, i)])) }) as T,
  );
}

// ─── The product page Integrations section ────────────────────────────────────

describe('on-page ordering firewall: product page integrations', () => {
  it('classifies every row field as an order input or a payload field', () => {
    const shape = Object.keys(ProductIntegrationItemSchema.shape);
    const classified = new Set<string>([
      ...Object.keys(ENDPOINT_ORDER_INPUTS),
      ...ENDPOINT_PAYLOAD_FIELDS,
      ...PENDING_ROW_FIELDS,
    ]);
    expect(shape.filter((field) => !classified.has(field))).toEqual([]);
    // No stale entries: every classified field except the pending three is on the row.
    expect(
      [...Object.keys(ENDPOINT_ORDER_INPUTS), ...ENDPOINT_PAYLOAD_FIELDS].filter(
        (field) => !shape.includes(field),
      ),
    ).toEqual([]);
  });

  it('every order input is written without a Managed-only capability', () => {
    for (const [field, writer] of Object.entries({
      ...ENDPOINT_ORDER_INPUTS,
      ...POWERED_ORDER_INPUTS,
    })) {
      expect(MANAGED_ONLY, field).not.toContain(writer);
    }
    // The partner's name and slug are not vendor-editable: a rename is a correction request.
    expect(Object.keys(PRODUCT_FIELD_CAPABILITIES)).not.toContain('name');
    expect(Object.keys(PRODUCT_FIELD_CAPABILITIES)).not.toContain('slug');
  });

  it('[surface:product-integrations-direct-lane] [surface:product-integrations-via-groups] [surface:product-integrations-above-fold] follows R1 as it ships today', () => {
    const { asSource, asTarget } = endpointFixture();
    const view = splitIntegrationLanes(asSource, asTarget);

    // Direct lane: A to Z by partner name, then edge name, then id.
    const direct = view.direct.map((r) => [r.other.name, r.integration.name, r.integration.id]);
    const expected = [...direct].sort(
      (a, b) =>
        compareText(a[0]!, b[0]!) || compareText(a[1]!, b[1]!) || a[2]!.localeCompare(b[2]!),
    );
    expect(direct).toEqual(expected);
    expect(direct.map((r) => r[0])).toEqual([
      'Agave ERP Sync',
      'alpha docs',
      'Bluebeam',
      'Mid Field',
      'Mid Field',
      'Zeta ERP',
    ]);
    expect(direct.slice(3, 5).map((r) => r[1])).toEqual(['Mid bridge A', 'mid bridge B']);

    // Via groups: kept count order (R1), connector name breaking a tie, unnamed last.
    expect(view.via.map((g) => [g.connector?.name ?? null, g.rows.length])).toEqual([
      ['Agave ERP Sync', 3],
      ['Boomi', 2],
      ['Kroo Connector', 2],
      [null, 1],
    ]);
    // Rows inside a group: A to Z by partner name.
    for (const group of view.via) {
      const names = group.rows.map((r) => r.other.name);
      expect(names).toEqual([...names].sort(compareText));
    }
  });

  const baseline = (() => {
    const { asSource, asTarget } = endpointFixture();
    return laneOrder(asSource, asTarget);
  })();

  it.each([...ENDPOINT_PAYLOAD_FIELDS, ...PENDING_ROW_FIELDS])(
    '[surface:product-integrations-direct-lane] does not move when %s changes',
    (field) => {
      const { asSource, asTarget } = endpointFixture();
      expect(laneOrder(flip(asSource, [field]), flip(asTarget, [field]))).toEqual(baseline);
    },
  );

  it('[surface:product-integrations-via-groups] [surface:product-integrations-above-fold] does not move when every payload field changes at once', () => {
    const fields = [...ENDPOINT_PAYLOAD_FIELDS, ...PENDING_ROW_FIELDS];
    const { asSource, asTarget } = endpointFixture();
    expect(laneOrder(flip(asSource, fields), flip(asTarget, fields))).toEqual(baseline);
  });

  it('sees a move when an order input changes (the comparison is not vacuous)', () => {
    const { asSource, asTarget } = endpointFixture();
    const renamed = asSource.map((row) =>
      row.target.slug === 'zeta-erp' ? { ...row, target: link('zeta-erp', 'Aaron ERP') } : row,
    );
    expect(laneOrder(renamed, asTarget)).not.toEqual(baseline);
  });
});

// ─── The connector page's powered hubs ────────────────────────────────────────

const poweredEdge = (source: ProductLink, target: ProductLink): PoweredIntegrationItem => ({
  id: uuid(),
  name: `${source.name} ↔ ${target.name}`,
  mechanism_kind: null,
  mechanism_name: null,
  direction: null,
  source,
  target,
  via: null,
  data_object_slugs: [],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
});

/** Hub ACC (3 partners), hub QuickBooks (2), and two pairs that earn no hub. */
function poweredFixture(): PoweredIntegrationItem[] {
  seq = 0;
  const acc = link('acc', 'Autodesk Construction Cloud');
  const qb = link('quickbooks', 'QuickBooks');
  const p = (slug: string, name: string) => link(slug, name);
  return [
    poweredEdge(acc, p('roofr', 'roofr')),
    poweredEdge(acc, p('bluebeam', 'Bluebeam')),
    poweredEdge(p('zeta', 'Zeta'), acc),
    poweredEdge(qb, p('xero', 'Xero')),
    poweredEdge(qb, p('fieldwire', 'fieldwire')),
    poweredEdge(p('sage', 'Sage'), p('vista', 'Vista')),
    poweredEdge(p('archicad', 'Archicad'), p('revit', 'Revit')),
  ];
}

function hubOrder(items: PoweredIntegrationItem[]) {
  const view = groupPoweredIntegrations(items, 'agave-erp-sync');
  return {
    groups: view.groups.map((g) => ({ hub: g.hub.slug, partners: g.partners.map((x) => x.key) })),
    others: view.others.map((o) => o.key),
  };
}

describe('on-page ordering firewall: connector page powered hubs', () => {
  it('classifies every row field as an order input or a payload field', () => {
    const shape = Object.keys(PoweredIntegrationItemSchema.shape);
    const classified = new Set<string>([
      ...Object.keys(POWERED_ORDER_INPUTS),
      ...POWERED_PAYLOAD_FIELDS,
      ...PENDING_ROW_FIELDS,
    ]);
    expect(shape.filter((field) => !classified.has(field))).toEqual([]);
  });

  it('[surface:connector-powered-hub] follows R1 as it ships today', () => {
    const view = groupPoweredIntegrations(poweredFixture(), 'agave-erp-sync');
    // Hubs: kept count order (R1), hub name breaking a tie.
    expect(view.groups.map((g) => [g.hub.name, g.partners.length])).toEqual([
      ['Autodesk Construction Cloud', 3],
      ['QuickBooks', 2],
    ]);
    // Partners inside a hub, and the flat pairs: A to Z by name.
    for (const group of view.groups) {
      const names = group.partners.map((x) => x.partner.name);
      expect(names).toEqual([...names].sort(compareText));
    }
    expect(view.others.map((o) => o.a.name)).toEqual(['Archicad', 'Sage']);
  });

  const baseline = hubOrder(poweredFixture());

  it.each([...POWERED_PAYLOAD_FIELDS, ...PENDING_ROW_FIELDS])(
    '[surface:connector-powered-hub] does not move when %s changes',
    (field) => {
      expect(hubOrder(flip(poweredFixture(), [field]))).toEqual(baseline);
    },
  );

  it('sees a move when an order input changes (the comparison is not vacuous)', () => {
    const renamed = poweredFixture().map((row) =>
      row.target.slug === 'xero' ? { ...row, target: link('xero', 'Aardvark') } : row,
    );
    expect(hubOrder(renamed)).not.toEqual(baseline);
  });
});

// ─── The tolerated exception: taxonomy term counts ────────────────────────────

/**
 * `taxonomy-term-product-count` (registry entry in the API half, status "awaiting
 * ruling (Slack 2026-11-14)"). The nav flyouts, the home page, the `/search` facets
 * and the taxonomy index's "Most products" sort rank audience and trade terms by
 * `product_count`, and a Managed product's `product.taxonomy.edit` writes move that
 * count. It is tolerated because it orders terms, not vendors, and R1 keeps
 * existing orders. These cases keep it narrow: `product_count` must stay the ONLY
 * input, so the surfaces cannot start reading anything else a plan can change.
 */
const term = (slug: string, name: string, count: number, order: number): TaxonomyTermWithCount => ({
  id: `id-${slug}`,
  slug,
  name,
  description: null,
  display_order: order,
  product_count: count,
  integration_count: 0,
});

function termsFixture(): TaxonomyTermWithCount[] {
  return [
    term('electrical', 'Electrical', 4, 3),
    term('roofing', 'roofing', 9, 1),
    term('plumbing', 'Plumbing', 4, 2),
    term('hvac', 'HVAC', 7, 4),
    term('concrete', 'Concrete', 1, 5),
  ];
}

/** Every term field `topByCount` must not read: all but `product_count`. */
const TERM_NON_COUNT_FIELDS = [
  'id',
  'slug',
  'name',
  'description',
  'display_order',
  'integration_count',
] as const;

function flipTerm(t: TaxonomyTermWithCount, i: number): TaxonomyTermWithCount {
  const values: Record<(typeof TERM_NON_COUNT_FIELDS)[number], unknown> = {
    id: `id-flipped-${9 - i}`,
    slug: `flipped-${9 - i}`,
    name: `${String.fromCharCode(90 - i)} term`,
    description: `Described ${i}`,
    display_order: 100 - i,
    integration_count: 100 - i * 10,
  };
  return { ...t, ...values } as TaxonomyTermWithCount;
}

describe('on-page ordering firewall: the taxonomy term-count exception', () => {
  it('the exception capability is still Managed-only (retire the entry if a ruling frees it)', () => {
    for (const field of ['audience_slugs', 'phase_slugs', 'trade_slugs'] as const) {
      expect(MANAGED_ONLY).toContain(PRODUCT_FIELD_CAPABILITIES[field]);
    }
    // Categories are Free, so a category count order needs no exception.
    expect(FREE.has(PRODUCT_FIELD_CAPABILITIES.category_slugs)).toBe(true);
  });

  it('classifies every term field', () => {
    expect(Object.keys(TaxonomyTermWithCountSchema.shape).sort()).toEqual(
      [...TERM_NON_COUNT_FIELDS, 'product_count'].sort(),
    );
  });

  it('[surface:taxonomy-term-product-count] topByCount reads product_count and nothing else', () => {
    // Positions, not slugs: the flip rewrites the slugs.
    const positions = (terms: TaxonomyTermWithCount[]) =>
      topByCount(terms, TOP_N).map((t) => terms.indexOf(t));
    const baseline = positions(termsFixture());
    expect(topByCount(termsFixture(), TOP_N).map((t) => t.slug)).toEqual([
      'roofing',
      'hvac',
      'electrical',
      'plumbing',
      'concrete',
    ]);
    expect(positions(termsFixture().map(flipTerm))).toEqual(baseline);
    // The top-N cut is a featured subset of the same order.
    expect(topByCount(termsFixture(), 2).map((t) => t.slug)).toEqual(['roofing', 'hvac']);
  });

  it('[surface:taxonomy-term-product-count] phases never rank by count: display order in the nav, lifecycle on /search', () => {
    const counts = termsFixture();
    const recounted = counts.map((t, i) => ({ ...t, product_count: 50 - i * 7 }));
    expect(byDisplayOrder(recounted).map((t) => t.slug)).toEqual(
      byDisplayOrder(counts).map((t) => t.slug),
    );

    const items = (countFor: (i: number) => number): RefinementItem[] =>
      ['Closeout & Operations', 'Design', 'Concept & Planning', 'Construction'].map((value, i) => ({
        value,
        label: value,
        count: countFor(i),
        isRefined: false,
      }));
    const lifecycle = orderFacetItems(
      'phases',
      items((i) => i),
    ).map((x) => x.value);
    expect(
      orderFacetItems(
        'phases',
        items((i) => 40 - i),
      ).map((x) => x.value),
    ).toEqual(lifecycle);
    expect(lifecycle).toEqual([
      'Concept & Planning',
      'Design',
      'Construction',
      'Closeout & Operations',
    ]);
  });
});
