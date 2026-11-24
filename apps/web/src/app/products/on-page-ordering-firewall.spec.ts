/**
 * The on-page ordering firewall, browser half (AECI-1814, `STAGE_2_PAID_TIERS_SPEC.md`
 * §3.2 assertion 8; ruling R1 on AECI-1732).
 *
 * No on-page sort, default order or featured subset may read an input that only a
 * paid plan can change. The browser orders three lists itself, so they are tested
 * here, behaviourally: build a fixture, change inputs that are not order inputs, and
 * assert that nothing moved and nothing entered or left a cut.
 *
 *  - the endpoint product page's Integrations section: the lane split
 *    (`connector-lane-grouping.ts`), the reader's filter (`integration-filter.ts`) and
 *    the rows above the `@defer` cut, which are a featured subset;
 *  - the connector page's "Integrations it powers" hubs and their filter;
 *  - the product hero's integrations wheel (`integration-wheel.ts`, AECI-2018);
 *  - `topByCount`, the taxonomy term ranking behind the one tolerated exception;
 *  - the header's Browse menu (`core/taxonomy/browse-menu-model.ts`, AECI-1774);
 *  - the empty pair page's closest-matches filter (`pair-matches-filter.ts`, AECI-1829).
 *
 * How the flips are built, because a flip that agrees with today's order proves
 * nothing:
 *
 *  - every field is flipped twice, with weights RISING and FALLING along the fixture,
 *    so a "most first" and a "least first" order both disagree with A to Z in one run;
 *  - every group-level input is also loaded onto ONE group or partner at a time (all
 *    paid inputs at their highest there, absent everywhere else), for every group;
 *  - the fixtures carry real ties at every comparator level, so the tie-breaks run.
 *
 * The API half, and the registry of ordered surfaces, is
 * `apps/api/src/lib/on-page-ordering-firewall.spec.ts`. It checks that every
 * `[surface:…]` tag in a test title below names an entry in its registry. The
 * component half (`on-page-ordering-firewall.component.spec.ts`) covers the taxonomy
 * index's "Most products" sort, which lives inside a component.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PairAlternativeMatchSchema,
  PoweredIntegrationItemSchema,
  ProductIntegrationItemSchema,
  TaxonomyResponseSchema,
  TaxonomyTermWithCountSchema,
  type PairAlternativeLane,
  type PairAlternativeMatch,
  type PoweredIntegrationItem,
  type ProductIntegrationItem,
  type ProductLink,
  type TaxonomyResponse,
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

import {
  BROWSE_COLUMN_LENGTH,
  type BrowseMenuModel,
  buildBrowseMenu,
} from '../core/taxonomy/browse-menu-model';
import { TOP_N, byDisplayOrder, topByCount } from '../core/taxonomy/taxonomy-rank';
import type { RefinementItem } from '../shared/facets/refinement-item';
import { orderFacetItems } from '../search/search-facet-order';

import {
  INTEGRATIONS_ABOVE_FOLD,
  applyDeferCut,
  routeIntegrationLane,
  splitIntegrationLanes,
} from './connector-lane-grouping';
import {
  ONE_LIST_PAGE_SIZE,
  groupRowsByCategory,
  isLongIntegrationList,
  peekGroup,
  stackPartners,
} from './integration-category-groups';
import {
  NO_INTEGRATION_FILTER,
  dataObjectOptions,
  filterIntegrationLanes,
  filterPoweredHubView,
  partnerCategoryOptions,
  rowsWithoutDataObjects,
} from './integration-filter';
import { filterPairMatches } from './pair-matches-filter';
import {
  WHEEL_BANDS,
  connectorWheelModel,
  heroWheelSource,
  layoutSlide,
  wheelModel,
} from './integration-wheel';
import { groupPoweredIntegrations } from './powered-hub-grouping';

// ─── The registry ─────────────────────────────────────────────────────────────

/** The Free plan's capabilities, and the ones only a Managed plan holds. */
const FREE = new Set<Capability>(TIER_CAPABILITIES.unclaimed);
const MANAGED_ONLY = CAPABILITIES.filter((c) => !FREE.has(c));

/**
 * Who can change an order input. A capability writer must be in the Free set. The
 * named writers are capability-free by the API half's scan: `seat` writes are the
 * integration create, edit and retire routes.
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

/**
 * The fields no order may read. `mechanism_name` is also a filter input (the reader
 * types it), so it is flipped only in the order cases, never in the filter cases.
 */
const ENDPOINT_PAYLOAD_FIELDS = [
  'mechanism_name',
  'direction',
  'context_direction',
  // The data-flow count. Vendor-added data objects need `attestation.author`.
  'data_object_slugs',
  // AECI-1781. The same objects with names, the partner's categories (Free, but R1
  // orders new lists by name alone), and "confirmed by both companies", which R1
  // keeps a row label only.
  'data_objects',
  'partner_categories',
  // AECI-1720: the partner's vendor name, the card's "by {vendor}" line. A vendor
  // renames its company, so no order may read it.
  'partner_vendor_name',
  // Its slug, for the page's vendor Cache-Tag only. Never rendered or ordered by.
  'partner_vendor_slug',
  'agreement',
  // "Maintained by" and corrections: edit stamps a Managed vendor moves.
  'caption',
  'corrections',
  'under_review',
  'created_at',
  'updated_at',
] as const;

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

/** Text the filters match on. Flipping it would change what a query matches, which
 *  is the filter working, not an order reading a paid input. */
const FILTER_TEXT_FIELDS = new Set<string>(['mechanism_name']);

// ─── Flips ────────────────────────────────────────────────────────────────────

/**
 * The value a paid input takes at `level`, 0 being none. Higher is "more evidence":
 * more data objects, confirmed agreement, a later date, a name that sorts first.
 * A level of 0 gives empty lists, so a cut on "has data objects" has rows on both
 * sides.
 */
function paidValue(field: string, level: number): unknown {
  const many = Array.from({ length: level }, (_, i) => `object-${level}-${i}`);
  switch (field) {
    case 'data_object_slugs':
      return many;
    case 'data_objects':
      return many.map((slug) => ({ slug, name: slug }));
    case 'agreement':
      // The loaded level is "confirmed by both companies"; neighbours differ.
      return level === 0
        ? null
        : level >= 9
          ? 'confirmed'
          : (['unverified', 'single_source', 'confirmed', 'conflict'] as const)[level % 4];
    case 'partner_categories':
      return many.map((slug) => ({ slug, name: slug }));
    case 'caption':
      return level === 0
        ? null
        : { form: 'updated', vendor_names: [`Vendor ${level}`], date: `2026-11-${10 + level}` };
    case 'corrections':
      return many.map((f) => ({ field: f, date: '2026-11-01', source_url: null, cleared: false }));
    case 'under_review':
      return level === 0 ? [] : ['description'];
    case 'context_direction':
    case 'direction':
      return level === 0 ? null : level % 2 === 0 ? 'both' : 'outbound';
    case 'mechanism_kind':
      return level % 2 === 0 ? 'api' : 'webhook';
    case 'partner_vendor_name':
      return level === 0 ? null : `${String.fromCharCode(65 + (level % 26))} Vendor ${level}`;
    case 'partner_vendor_slug':
      return level === 0 ? null : `${String.fromCharCode(97 + (level % 26))}-vendor-${level}`;
    case 'mechanism_name':
    case 'name':
      return `${String.fromCharCode(90 - (level % 26))} label ${level}`;
    case 'id':
      return `ffffffff-0000-4000-8000-${String(1000 - level).padStart(12, '0')}`;
    case 'via':
      return level === 0
        ? null
        : { id: `id-via-${level}`, slug: `via-${level}`, name: `Via ${level}`, logo_url: null };
    case 'created_at':
    case 'updated_at':
      return `2026-${String((level % 12) + 1).padStart(2, '0')}-01T00:00:00.000Z`;
    default:
      throw new Error(`No paid value for ${field}: add one before classifying it`);
  }
}

type Direction = 'rising' | 'falling';

/** The same rows, with `fields` set by position: rising or falling along the fixture. */
function flipRows<T extends object>(
  rows: readonly T[],
  fields: readonly string[],
  dir: Direction,
): T[] {
  return rows.map((row, i) => {
    const level = dir === 'rising' ? i : rows.length - 1 - i;
    return { ...row, ...Object.fromEntries(fields.map((f) => [f, paidValue(f, level)])) } as T;
  });
}

/** The same rows, with every paid input at its highest on the rows `loaded` picks
 *  and absent on the rest. */
function loadOne<T extends object>(
  rows: readonly T[],
  fields: readonly string[],
  loaded: (row: T) => boolean,
): T[] {
  return rows.map(
    (row) =>
      ({
        ...row,
        ...Object.fromEntries(fields.map((f) => [f, paidValue(f, loaded(row) ? 9 : 0)])),
      }) as T,
  );
}

// ─── Endpoint fixtures ────────────────────────────────────────────────────────

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
  data_objects: [],
  partner_categories: [],
  agreement: null,
  caption: null,
  corrections: [],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  ...extra,
});

const viaEdge = (partner: ProductLink, connector: ProductLink, name: string) =>
  endpointEdge(partner, name, { via: connector, mechanism_kind: null });

/**
 * A product page with every lane case and a tie at every comparator level:
 *  - mixed-case partner names (A to Z must not be case-sensitive);
 *  - one partner with two edges (the edge-name tie-break);
 *  - two partners with the same name AND the same edge name (the id tie-break;
 *    `compareText` breaks on case, so a true tie needs identical strings);
 *  - a Convention-A self-reference, which stays direct;
 *  - Via groups of 3, 2 and 2 rows (the count order and its name tie-break), a
 *    collapsed Via row whose two edges tie on name, and the unnamed iPaaS bucket.
 */
function endpointFixture(): {
  asSource: ProductIntegrationItem[];
  asTarget: ProductIntegrationItem[];
} {
  seq = 0;
  const zeta = link('zeta-erp', 'Zeta ERP');
  const alpha = link('alpha-docs', 'alpha docs');
  const mid = link('mid-field', 'Mid Field');
  const twinA = link('twin-a', 'Twin Co');
  const twinB = link('twin-b', 'Twin Co');
  const sage = link('sage-intacct', 'Sage Intacct');
  const vista = link('viewpoint-vista', 'Viewpoint Vista');
  const acumatica = link('acumatica', 'Acumatica');
  const quickbooks = link('quickbooks', 'QuickBooks');
  const xero = link('xero', 'Xero');
  return {
    asSource: [
      endpointEdge(zeta, 'Zeta sync'),
      endpointEdge(twinB, 'Twin link'),
      endpointEdge(alpha, 'Alpha link'),
      endpointEdge(mid, 'mid bridge B'),
      endpointEdge(twinA, 'Twin link'),
      endpointEdge(mid, 'Mid bridge A'),
      // Convention A: powered_by is one of the row's own endpoints, so it stays direct.
      endpointEdge(agave, 'Procore on Agave', { powered_by_product: agave }),
      viaEdge(xero, kroo, 'Xero via Kroo'),
      viaEdge(sage, agave, 'Sage via Agave'),
      viaEdge(quickbooks, kroo, 'QuickBooks via Kroo'),
      viaEdge(vista, agave, 'Vista via Agave'),
      viaEdge(xero, boomi, 'Xero via Boomi'),
      viaEdge(quickbooks, kroo, 'quickbooks via kroo'),
      viaEdge(acumatica, agave, 'Acumatica via Agave'),
      viaEdge(sage, boomi, 'Sage via Boomi'),
      endpointEdge(zeta, 'Zeta over iPaaS', { mechanism_kind: 'iPaaS' }),
    ],
    asTarget: [
      // The page product is the target here, so the partner is the source.
      { ...endpointEdge(page, 'Bluebeam to Procore'), source: link('bluebeam', 'Bluebeam') },
    ],
  };
}

/** Thirty direct partners and a Via group, so the real 20-row cut lands mid-lane. */
function largeEndpointFixture(): ProductIntegrationItem[] {
  seq = 100;
  const rows: ProductIntegrationItem[] = [];
  for (let i = 0; i < 30; i++) {
    // Names deliberately out of insertion order, with case and a few ties.
    const n = (i * 7) % 30;
    const name = `${n % 2 === 0 ? 'Partner' : 'partner'} ${String(Math.floor(n / 2)).padStart(2, '0')}`;
    rows.push(endpointEdge(link(`partner-${i}`, name), `Edge ${n % 5}`));
  }
  rows.push(viaEdge(link('extra-a', 'Extra A'), agave, 'A via Agave'));
  rows.push(viaEdge(link('extra-b', 'Extra B'), kroo, 'B via Kroo'));
  return rows;
}

/** Where a row lands: the key a group-loaded flip targets. */
function groupOf(row: ProductIntegrationItem): string {
  const route = routeIntegrationLane(row);
  return route.lane === 'direct'
    ? `direct:${row.target.slug}:${row.source.slug}`
    : `via:${route.connector?.slug ?? ''}`;
}

/** Everything about the section's order and cuts, and nothing else. */
function sectionOrder(asSource: ProductIntegrationItem[], asTarget: ProductIntegrationItem[]) {
  const view = splitIntegrationLanes(asSource, asTarget);
  const keys = (v: typeof view) => ({
    direct: v.direct.map((r) => r.key),
    via: v.via.map((g) => ({ group: g.key, rows: g.rows.map((r) => r.key) })),
  });
  const above = (limit: number) => {
    const cut = applyDeferCut(view, limit);
    return [
      ...cut.direct.above.map((r) => r.key),
      ...cut.via.flatMap((g) => g.above.map((r) => r.key)),
    ];
  };
  return {
    ...keys(view),
    // The edge a collapsed Via row shows as its representative.
    representatives: view.via.flatMap((g) => g.rows.map((r) => r.integration.id)),
    // Featured subsets: a cut inside the direct lane, one inside a Via group, and the real one.
    above4: above(4),
    above11: above(11),
    aboveFold: above(INTEGRATIONS_ABOVE_FOLD),
    // The reader's filter, with no query and with one.
    unfiltered: keys(filterIntegrationLanes(view, '')),
    filtered: keys(filterIntegrationLanes(view, 'a')),
  };
}

// ─── The product page Integrations section ────────────────────────────────────

describe('on-page ordering firewall: product page integrations', () => {
  it('classifies every row field as an order input or a payload field', () => {
    const shape = Object.keys(ProductIntegrationItemSchema.shape);
    const classified = [...Object.keys(ENDPOINT_ORDER_INPUTS), ...ENDPOINT_PAYLOAD_FIELDS];
    expect(shape.filter((field) => !classified.includes(field))).toEqual([]);
    expect(classified.filter((field) => !shape.includes(field))).toEqual([]);
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

  it('[surface:product-integrations-direct-lane] [surface:product-integrations-via-groups] follows R1 as it ships today', () => {
    const { asSource, asTarget } = endpointFixture();
    const view = splitIntegrationLanes(asSource, asTarget);

    // Direct lane: A to Z by partner name, then edge name, then id.
    const direct = view.direct.map(
      (r) => [r.other.name, r.integration.name, r.integration.id] as const,
    );
    const expected = [...direct].sort(
      (a, b) => compareText(a[0], b[0]) || compareText(a[1], b[1]) || a[2].localeCompare(b[2]),
    );
    expect(direct).toEqual(expected);
    expect(direct.map((r) => r[0])).toEqual([
      'Agave ERP Sync',
      'alpha docs',
      'Bluebeam',
      'Mid Field',
      'Mid Field',
      'Twin Co',
      'Twin Co',
      'Zeta ERP',
    ]);
    // The twins tie on partner name and on edge name: the id decides.
    const twins = view.direct.filter((r) => /^twin-/.test(r.other.slug));
    expect(twins[0]!.integration.id.localeCompare(twins[1]!.integration.id)).toBeLessThan(0);

    // Via groups: kept count order (R1), connector name breaking the 2-row tie, unnamed last.
    expect(view.via.map((g) => [g.connector?.name ?? null, g.rows.length])).toEqual([
      ['Agave ERP Sync', 3],
      ['Boomi', 2],
      ['Kroo Connector', 2],
      [null, 1],
    ]);
    for (const group of view.via) {
      const names = group.rows.map((r) => r.other.name);
      expect(names).toEqual([...names].sort(compareText));
    }
  });

  const { asSource: baseSource, asTarget: baseTarget } = endpointFixture();
  const baseline = sectionOrder(baseSource, baseTarget);
  const orderFields = ENDPOINT_PAYLOAD_FIELDS;
  const filterSafeFields = ENDPOINT_PAYLOAD_FIELDS.filter((f) => !FILTER_TEXT_FIELDS.has(f));

  for (const dir of ['rising', 'falling'] as const) {
    it.each(filterSafeFields)(
      `[surface:product-integrations-direct-lane] does not move when %s changes (${dir})`,
      (field) => {
        const { asSource, asTarget } = endpointFixture();
        expect(
          sectionOrder(flipRows(asSource, [field], dir), flipRows(asTarget, [field], dir)),
        ).toEqual(baseline);
      },
    );

    it(`[surface:product-integrations-via-groups] [surface:product-integrations-above-fold] does not move when every payload field changes at once (${dir})`, () => {
      const { asSource, asTarget } = endpointFixture();
      // Every field, the filter text included, so the query case is left out here.
      const flipped = sectionOrder(
        flipRows(asSource, orderFields, dir),
        flipRows(asTarget, orderFields, dir),
      );
      expect({ ...flipped, filtered: null }).toEqual({ ...baseline, filtered: null });
    });
  }

  it('[surface:product-integrations-via-groups] [surface:product-integrations-above-fold] does not move when every paid input is loaded onto one group', () => {
    const { asSource, asTarget } = endpointFixture();
    const targets = new Set([...asSource, ...asTarget].map(groupOf));
    expect(targets.size).toBeGreaterThan(8);
    for (const target of targets) {
      const loaded = (row: ProductIntegrationItem) => groupOf(row) === target;
      expect(
        sectionOrder(
          loadOne(asSource, filterSafeFields, loaded),
          loadOne(asTarget, filterSafeFields, loaded),
        ),
        target,
      ).toEqual(baseline);
    }
  });

  it('[surface:product-integrations-above-fold] the real 20-row cut takes the same rows whatever the paid inputs', () => {
    const rows = largeEndpointFixture();
    const cut = (r: ProductIntegrationItem[]) => {
      const view = splitIntegrationLanes(r, []);
      const c = applyDeferCut(view, INTEGRATIONS_ABOVE_FOLD);
      return [...c.direct.above, ...c.via.flatMap((g) => g.above)].map((x) => x.key);
    };
    const base = cut(rows);
    expect(base).toHaveLength(INTEGRATIONS_ABOVE_FOLD);
    for (const dir of ['rising', 'falling'] as const) {
      expect(cut(flipRows(rows, filterSafeFields, dir)), dir).toEqual(base);
    }
    for (let i = 0; i < rows.length; i++) {
      expect(cut(loadOne(rows, filterSafeFields, (r) => r === rows[i])), `row ${i}`).toEqual(base);
    }
  });

  it('sees a move when an order input changes (the comparison is not vacuous)', () => {
    const { asSource, asTarget } = endpointFixture();
    const renamed = asSource.map((row) =>
      row.target.slug === 'zeta-erp' ? { ...row, target: link('zeta-erp', 'Aaron ERP') } : row,
    );
    expect(sectionOrder(renamed, asTarget)).not.toEqual(baseline);
  });

  it('[surface:product-integrations-direct-lane] the section applies the lane order and adds none of its own', () => {
    // A structural check, not a proof: the component's chain is split, then filter,
    // then cut, and it holds no comparator that could re-sort what they return.
    const src = readFileSync(
      join(process.cwd(), 'src/app/products/product-integrations-section.ts'),
      'utf8',
    );
    expect(src).toMatch(/splitIntegrationLanes\(this\.asSource\(\), this\.asTarget\(\)\)/);
    // AECI-1782 widened the filter to the reader's whole filter state. Still one call,
    // still over the lane view as split.
    expect(src).toMatch(/filterIntegrationLanes\(this\.lanes\(\), this\.filterState\(\)\)/);
    expect(src).toMatch(/applyDeferCut\(view, limit\)/);
    expect(src).not.toMatch(/\.(sort|toSorted|reverse)\(|compareText|localeCompare/);
    // No row filter or cut of its own either. A filter the reader chooses belongs in
    // `integration-filter.ts`, where the cases above cover it. The rendered check is
    // the component half: no filter selected means every row renders.
    expect(src).not.toMatch(/\.(filter|slice|splice)\(/);
  });

  // AECI-1782: the redesigned section's filter panel. A filter the reader chooses is
  // allowed; it must remove rows only, keep the lane order, and read no paid input.
  const PAID_ROW_FIELDS = [
    'data_object_slugs',
    'data_objects',
    'agreement',
    'caption',
    'corrections',
    'under_review',
  ] as const;

  const readerFilter = (view: ReturnType<typeof splitIntegrationLanes>) => {
    const keys = (v: typeof view) => [
      ...v.direct.map((r) => r.key),
      ...v.via.flatMap((g) => g.rows.map((r) => r.key)),
    ];
    return {
      none: keys(filterIntegrationLanes(view, NO_INTEGRATION_FILTER)),
      outbound: keys(
        filterIntegrationLanes(view, { ...NO_INTEGRATION_FILTER, directions: ['outbound'] }),
      ),
      category: keys(
        filterIntegrationLanes(view, {
          ...NO_INTEGRATION_FILTER,
          partnerCategories: ['accounting'],
        }),
      ),
      categoryChips: partnerCategoryOptions(view).map((t) => t.slug),
    };
  };

  /** The base fixture with directions and categories the reader can filter on. */
  const withFacets = (rows: ProductIntegrationItem[]) =>
    rows.map((row, i) => ({
      ...row,
      context_direction: (['outbound', 'inbound', 'both', null] as const)[i % 4]!,
      partner_categories:
        i % 3 === 0
          ? [{ slug: 'accounting', name: 'Accounting' }]
          : i % 3 === 1
            ? [
                { slug: 'field-b', name: 'Field' },
                { slug: 'field-a', name: 'Field' },
              ]
            : [],
    }));

  it('[surface:product-page-integrations-redesign] a reader filter keeps the lane order and reads no paid input', () => {
    const { asSource, asTarget } = endpointFixture();
    const base = readerFilter(splitIntegrationLanes(withFacets(asSource), withFacets(asTarget)));
    // No filter: every row, in the lane order.
    expect(base.none).toEqual([...baseline.direct, ...baseline.via.flatMap((g) => g.rows)]);
    // A filter removes and never reorders: each result is a subsequence of the whole.
    for (const subset of [base.outbound, base.category]) {
      expect(subset.length).toBeGreaterThan(0);
      expect(base.none.filter((k) => subset.includes(k))).toEqual(subset);
    }
    for (const dir of ['rising', 'falling'] as const) {
      const flipped = readerFilter(
        splitIntegrationLanes(
          withFacets(flipRows(asSource, PAID_ROW_FIELDS, dir)),
          withFacets(flipRows(asTarget, PAID_ROW_FIELDS, dir)),
        ),
      );
      expect(flipped, dir).toEqual(base);
    }
  });

  it('[surface:product-page-integrations-redesign] chip options are A to Z by name, slug breaking a tie, never by count', () => {
    const { asSource, asTarget } = endpointFixture();
    const view = splitIntegrationLanes(withFacets(asSource), withFacets(asTarget));
    // "Field" is carried by more rows than "Accounting"; A to Z still puts Accounting first,
    // and the two "Field" terms tie on name, so the slug decides.
    expect(partnerCategoryOptions(view).map((t) => t.slug)).toEqual([
      'accounting',
      'field-a',
      'field-b',
    ]);
    const objects = [
      { slug: 'rfi', name: 'RFIs' },
      { slug: 'invoice-b', name: 'invoices' },
      { slug: 'invoice-a', name: 'Invoices' },
    ];
    const withObjects = asSource.map((row, i) => ({
      ...row,
      data_objects: i % 2 === 0 ? objects : [objects[0]!],
      data_object_slugs: i % 2 === 0 ? objects.map((o) => o.slug) : ['rfi'],
    }));
    const options = dataObjectOptions(splitIntegrationLanes(withObjects, asTarget));
    // compareText ignores case first, then breaks on it; the slug comes last.
    expect(options.map((t) => t.name)).toEqual(['Invoices', 'invoices', 'RFIs'].sort(compareText));
    expect(options.map((t) => t.slug)[2]).toBe('rfi');
  });

  it('[surface:product-page-integrations-redesign] a data-object filter leaves out rows with no data object on record', () => {
    const { asSource, asTarget } = endpointFixture();
    const rows = asSource.map((row, i) => ({
      ...row,
      data_object_slugs: i % 2 === 0 ? ['invoice'] : [],
      data_objects: i % 2 === 0 ? [{ slug: 'invoice', name: 'Invoices' }] : [],
    }));
    const view = splitIntegrationLanes(rows, asTarget);
    const filtered = filterIntegrationLanes(view, {
      ...NO_INTEGRATION_FILTER,
      dataObjects: ['invoice'],
    });
    expect(filtered.rowCount).toBe(view.rowCount - rowsWithoutDataObjects(view));
  });

  // AECI-1783: the long list. Category membership is the partner's own categories
  // (Free), so the categories are fixed here and only the paid inputs move.
  const CATEGORY_SETS = [
    [{ slug: 'scheduling', name: 'Scheduling' }],
    [
      { slug: 'accounting', name: 'Accounting' },
      { slug: 'field-b', name: 'Field' },
    ],
    [],
    [{ slug: 'field-a', name: 'Field' }],
  ];

  /** Thirty direct partners with real name ties, each given fixed categories. */
  const longListRows = () =>
    largeEndpointFixture()
      .filter((row) => routeIntegrationLane(row).lane === 'direct')
      .map((row, i) => ({ ...row, partner_categories: CATEGORY_SETS[i % CATEGORY_SETS.length]! }));

  /** Everything about the long list's order, membership and cuts, and nothing else. */
  const longListOrder = (rows: ProductIntegrationItem[]) => {
    const view = splitIntegrationLanes(rows, []);
    const groups = groupRowsByCategory(view.direct);
    const keys = (list: readonly { key: string }[]) => list.map((r) => r.key);
    return {
      long: isLongIntegrationList(view),
      groups: groups.map((g) => ({
        group: g.key,
        rows: keys(g.rows),
        aboveShowMore: keys(peekGroup(g.rows).peek),
        stack: keys(stackPartners(peekGroup(g.rows).hidden)),
      })),
      oneListFirstPage: keys(view.direct.slice(0, ONE_LIST_PAGE_SIZE)),
      chosen: keys(groupRowsByCategory(view.direct, ['field-a', 'accounting'])),
    };
  };

  it('[surface:product-page-integrations-long-list] groups A to Z, rows in lane order, every cut is the first rows', () => {
    const rows = longListRows();
    const view = splitIntegrationLanes(rows, []);
    const order = longListOrder(rows);
    expect(order.long).toBe(true);
    // A to Z by name; the two "Field" categories tie, so the slug decides; none last.
    expect(order.groups.map((g) => g.group)).toEqual([
      'accounting',
      'field-a',
      'field-b',
      'scheduling',
      '',
    ]);
    const lane = view.direct.map((r) => r.key);
    for (const group of order.groups) {
      expect(
        lane.filter((k) => group.rows.includes(k)),
        group.group,
      ).toEqual(group.rows);
      expect(group.aboveShowMore).toEqual(group.rows.slice(0, 6));
    }
    expect(order.oneListFirstPage).toEqual(lane.slice(0, ONE_LIST_PAGE_SIZE));
  });

  it('[surface:product-page-integrations-long-list] sees a move when a category changes (the comparison is not vacuous)', () => {
    const rows = longListRows();
    const moved = rows.map((row, i) =>
      i === 0 ? { ...row, partner_categories: [{ slug: 'aaa', name: 'Aardvark' }] } : row,
    );
    expect(longListOrder(moved)).not.toEqual(longListOrder(rows));
  });

  for (const dir of ['rising', 'falling'] as const) {
    it(`[surface:product-page-integrations-long-list] paid inputs move no group, row, member or cut (${dir})`, () => {
      const rows = longListRows();
      const base = longListOrder(rows);
      expect(longListOrder(flipRows(rows, PAID_ROW_FIELDS, dir))).toEqual(base);
    });
  }

  it('[surface:product-page-integrations-long-list] paid inputs loaded onto any one row move nothing', () => {
    const rows = longListRows();
    const base = longListOrder(rows);
    for (let i = 0; i < rows.length; i++) {
      expect(
        longListOrder(loadOne(rows, PAID_ROW_FIELDS, (r) => r === rows[i])),
        `row ${i}`,
      ).toEqual(base);
    }
  });

  it('[surface:product-page-integrations-long-list] the grouping modules hold no comparator but the shared A to Z', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/app/products/integration-category-groups.ts'),
      'utf8',
    );
    // Group order comes from partnerCategoryOptions, the chips' own A to Z.
    expect(src).toMatch(/partnerCategoryOptions\(/);
    expect(src).not.toMatch(/\.(sort|toSorted|reverse)\(|compareText|localeCompare/);
    // No row field but the partner categories: nothing a paid plan writes.
    expect(src).not.toMatch(
      /\.(agreement|data_objects|data_object_slugs|dataObjects|dataObjectSlugs|caption|corrections|under_review)\b/,
    );
  });

  // The three components render the cuts. A re-sort or a filter in a template would
  // move a cut without touching the module above, and the behavioural cases above
  // would not see it, so they get the same structural check (AECI-1783 review).
  for (const file of [
    'product-integration-groups.ts',
    'product-integration-category-group.ts',
    'product-integration-one-list.ts',
  ]) {
    it(`[surface:product-page-integrations-long-list] ${file} renders rows and groups in the order it is given`, () => {
      const src = readFileSync(join(process.cwd(), 'src/app/products', file), 'utf8');
      expect(src).not.toMatch(
        /\.(sort|toSorted|reverse|filter|slice|splice)\(|compareText|localeCompare/,
      );
      expect(src).not.toMatch(
        /\.(agreement|data_objects|data_object_slugs|dataObjects|dataObjectSlugs|caption|corrections|under_review|integration_count)\b/,
      );
    });
  }
});

// ─── The product hero's integrations wheel (AECI-2018) ────────────────────────

/**
 * The wheel's inputs: each row's partner (name, slug, id), its partner categories, and
 * the lane fields that decide which rows the section lists. Its paid-plan flips are every
 * other payload field. `partner_vendor_name` rides along: the card prints it, and nothing
 * orders, includes or sizes by it.
 */
const WHEEL_PAID_FIELDS = ENDPOINT_PAYLOAD_FIELDS.filter((f) => f !== 'partner_categories');

const wheelTerm = (slug: string, name: string) => ({ slug, name });

/**
 * Rows with a tie at every comparator level:
 *  - mixed-case product and category names (A to Z must not be case-sensitive);
 *  - two products with the same name (the id decides) and two categories with the same
 *    name (the slug decides);
 *  - a product with three categories, one with none, one with a category twice;
 *  - a product on two rows (one tile, two dots) and a via group that collapses two edges.
 */
function wheelFixture(): {
  asSource: ProductIntegrationItem[];
  asTarget: ProductIntegrationItem[];
} {
  seq = 200;
  const acc = wheelTerm('accounting', 'Accounting');
  const bim = wheelTerm('bim-authoring', 'bim authoring');
  const docsA = wheelTerm('docs-a', 'Documents');
  const docsB = wheelTerm('docs-b', 'Documents');
  const field = wheelTerm('field', 'Field');
  const cats = (...t: ReturnType<typeof wheelTerm>[]) => ({ partner_categories: t });
  return {
    asSource: [
      endpointEdge(link('zeta', 'Zeta'), 'Zeta sync', cats(field, acc)),
      endpointEdge(link('zeta', 'Zeta'), 'Zeta two', cats(field, acc)),
      endpointEdge(link('alpha', 'alpha'), 'Alpha link', cats(bim, docsB, acc)),
      endpointEdge(link('twin-b', 'Twin'), 'Twin B', cats(field)),
      endpointEdge(link('twin-a', 'Twin'), 'Twin A', cats(field)),
      endpointEdge(link('none', 'No Category'), 'Bare link', cats()),
      endpointEdge(link('dup', 'Dup'), 'Dup link', cats(docsA, docsA)),
      { ...viaEdge(link('xero', 'Xero'), kroo, 'Xero via Kroo'), ...cats(acc) },
      { ...viaEdge(link('xero', 'Xero'), kroo, 'xero via kroo'), ...cats(acc) },
    ],
    asTarget: [
      {
        ...endpointEdge(page, 'Bluebeam to Procore', cats(docsB, field)),
        source: link('bluebeam', 'Bluebeam'),
      },
    ],
  };
}

/** Every mark claimed or unclaimed, with or without a logo, by position. */
function wheelMarks(
  rows: { asSource: ProductIntegrationItem[]; asTarget: ProductIntegrationItem[] },
  pick: (i: number) => { logo: boolean; claimed: boolean },
) {
  const ids = [
    ...new Set([
      ...rows.asSource.map((r) => r.target.id),
      ...rows.asTarget.map((r) => r.source.id),
    ]),
  ];
  return ids.map((id, i) => {
    const { logo, claimed } = pick(i);
    return {
      product_id: id,
      logo_url: logo ? `https://cdn.example/${i}.png` : null,
      claim_status: claimed ? ('claimed' as const) : ('unclaimed' as const),
    };
  });
}

/** Everything the wheel decides: slides, membership, order, counts, and at every stage
 *  width, each slide's mode and tile size. Nothing it merely prints. */
function wheelDecisions(
  asSource: ProductIntegrationItem[],
  asTarget: ProductIntegrationItem[],
  marks?: ReturnType<typeof wheelMarks>,
) {
  const model = wheelModel(asSource, asTarget, marks);
  return {
    slides: model.slides.map((s) => ({
      key: s.key,
      products: s.products.map((p) => p.id),
      integrations: s.integrations,
    })),
    layouts: [...WHEEL_BANDS, 640].map((d) =>
      model.slides.map((_, i) => {
        const layout = layoutSlide(model, i, d);
        return { mode: layout.mode, tile: layout.tilePx, points: layout.points };
      }),
    ),
  };
}

describe('on-page ordering firewall: the product hero integrations wheel', () => {
  it('[surface:product-page-hero-wheel] "All" first, then categories A to Z; products A to Z, id breaking a tie', () => {
    const { asSource, asTarget } = wheelFixture();
    const model = wheelModel(asSource, asTarget, undefined);
    expect(model.slides.map((s) => s.key)).toEqual([
      'all',
      'accounting',
      'bim-authoring',
      'docs-a',
      'docs-b',
      'field',
    ]);
    expect(model.slides[0]!.products.map((p) => p.slug)).toEqual([
      'alpha',
      'bluebeam',
      'dup',
      'none',
      'twin-a',
      'twin-b',
      'xero',
      'zeta',
    ]);
    // A product with two categories is on both slides; one with none is on "All" only.
    expect(model.slides.find((s) => s.key === 'field')!.products.map((p) => p.slug)).toEqual([
      'bluebeam',
      'twin-a',
      'twin-b',
      'zeta',
    ]);
    // One dot per row the Integrations section lists: Zeta has two, the via pair one.
    expect(model.slides[0]!.integrations).toBe(9);
    expect(model.categoryCount).toBe(5);
  });

  it('its inputs are written on the Free plan, or by no vendor', () => {
    expect(PRODUCT_FIELD_CAPABILITIES.category_slugs).toBe('product.categories.edit');
    expect(FREE.has('product.categories.edit')).toBe(true);
    expect(Object.keys(PRODUCT_FIELD_CAPABILITIES)).not.toContain('name');
  });

  const { asSource: wheelSource, asTarget: wheelTarget } = wheelFixture();
  const wheelBaseline = wheelDecisions(wheelSource, wheelTarget);

  for (const dir of ['rising', 'falling'] as const) {
    it.each(WHEEL_PAID_FIELDS)(
      `[surface:product-page-hero-wheel] neither inclusion, order nor size moves when %s changes (${dir})`,
      (f) => {
        const { asSource, asTarget } = wheelFixture();
        expect(wheelDecisions(flipRows(asSource, [f], dir), flipRows(asTarget, [f], dir))).toEqual(
          wheelBaseline,
        );
      },
    );

    it(`[surface:product-page-hero-wheel] neither inclusion, order nor size moves when every paid input changes at once (${dir})`, () => {
      const { asSource, asTarget } = wheelFixture();
      expect(
        wheelDecisions(
          flipRows(asSource, WHEEL_PAID_FIELDS, dir),
          flipRows(asTarget, WHEEL_PAID_FIELDS, dir),
        ),
      ).toEqual(wheelBaseline);
    });
  }

  it('[surface:product-page-hero-wheel] does not move when every paid input is loaded onto one product', () => {
    const { asSource, asTarget } = wheelFixture();
    const partners = new Set([
      ...asSource.map((r) => r.target.slug),
      ...asTarget.map((r) => r.source.slug),
    ]);
    for (const slug of partners) {
      const loaded = (row: ProductIntegrationItem) =>
        row.target.slug === slug || row.source.slug === slug;
      expect(
        wheelDecisions(
          loadOne(asSource, WHEEL_PAID_FIELDS, loaded),
          loadOne(asTarget, WHEEL_PAID_FIELDS, loaded),
        ),
        slug,
      ).toEqual(wheelBaseline);
    }
  });

  // Ruling 64: the logo shows whenever we hold one, and the claim decides only the card's
  // "Unclaimed" label. A claim (a seat) and a logo (`product.listing.edit`) must not move
  // a tile, include or drop a product, or change a size.
  it('[surface:product-page-hero-wheel] the logo and the claim state move nothing, in any mix', () => {
    const rows = wheelFixture();
    const mixes: ((i: number) => { logo: boolean; claimed: boolean })[] = [
      () => ({ logo: true, claimed: true }),
      () => ({ logo: false, claimed: false }),
      (i) => ({ logo: i % 2 === 0, claimed: i % 3 === 0 }),
      (i) => ({ logo: i % 2 === 1, claimed: i % 3 !== 0 }),
    ];
    for (const mix of mixes) {
      expect(wheelDecisions(rows.asSource, rows.asTarget, wheelMarks(rows, mix))).toEqual(
        wheelBaseline,
      );
    }
    // One product at a time with a logo and claimed, every other one without.
    const count = wheelBaseline.slides[0]!.products.length;
    for (let k = 0; k < count; k++) {
      const marks = wheelMarks(rows, (i) => ({ logo: i === k, claimed: i === k }));
      expect(wheelDecisions(rows.asSource, rows.asTarget, marks), String(k)).toEqual(wheelBaseline);
    }
  });

  it('sees a move when a product name changes (the comparison is not vacuous)', () => {
    const { asSource, asTarget } = wheelFixture();
    const rename = (rows: ProductIntegrationItem[]) =>
      rows.map((row) =>
        row.target.slug === 'zeta' ? { ...row, target: { ...row.target, name: 'Aardvark' } } : row,
      );
    expect(wheelDecisions(rename(asSource), asTarget).slides[0]!.products).not.toEqual(
      wheelBaseline.slides[0]!.products,
    );
  });

  it('a planted order by logo would disagree with A to Z, so the cases above would catch it', () => {
    const rows = wheelFixture();
    const marks = wheelMarks(rows, (i) => ({ logo: i % 2 === 1, claimed: true }));
    const withLogo = new Set(marks.filter((m) => m.logo_url).map((m) => m.product_id));
    const byLogo = [...wheelBaseline.slides[0]!.products].sort(
      (a, b) => Number(withLogo.has(b)) - Number(withLogo.has(a)),
    );
    expect(byLogo).not.toEqual(wheelBaseline.slides[0]!.products);
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

/**
 * Hub ACC (3 partners, two of them sharing a name), then hubs Procore and QuickBooks
 * tied at 2 partners, and two flat pairs that earn no hub.
 */
function poweredFixture(): PoweredIntegrationItem[] {
  seq = 0;
  const acc = link('acc', 'Autodesk Construction Cloud');
  const qb = link('quickbooks', 'QuickBooks');
  const pc = link('procore', 'Procore');
  return [
    poweredEdge(acc, link('roofr', 'roofr')),
    poweredEdge(link('zeta', 'Bluebeam'), acc),
    poweredEdge(acc, link('bluebeam', 'Bluebeam')),
    poweredEdge(qb, link('xero', 'Xero')),
    poweredEdge(qb, link('fieldwire', 'fieldwire')),
    poweredEdge(link('sage', 'Sage'), link('vista', 'Vista')),
    poweredEdge(pc, link('pc-two', 'Two')),
    poweredEdge(link('archicad', 'Archicad'), link('revit', 'Revit')),
    poweredEdge(pc, link('pc-one', 'One')),
  ];
}

function hubOrder(items: PoweredIntegrationItem[]) {
  const view = groupPoweredIntegrations(items, 'agave-erp-sync');
  const keys = (v: typeof view) => ({
    groups: v.groups.map((g) => ({ hub: g.hub.slug, partners: g.partners.map((x) => x.key) })),
    others: v.others.map((o) => o.key),
  });
  return {
    ...keys(view),
    unfiltered: keys(filterPoweredHubView(view, '')),
    filtered: keys(filterPoweredHubView(view, 'o')),
  };
}

describe('on-page ordering firewall: connector page powered hubs', () => {
  it('classifies every row field as an order input or a payload field', () => {
    const shape = Object.keys(PoweredIntegrationItemSchema.shape);
    const classified = [...Object.keys(POWERED_ORDER_INPUTS), ...POWERED_PAYLOAD_FIELDS];
    expect(shape.filter((field) => !classified.includes(field))).toEqual([]);
    expect(classified.filter((field) => !shape.includes(field))).toEqual([]);
  });

  it('[surface:connector-powered-hub] follows R1 as it ships today', () => {
    const view = groupPoweredIntegrations(poweredFixture(), 'agave-erp-sync');
    // Hubs: kept count order (R1), hub name breaking the 2-partner tie.
    expect(view.groups.map((g) => [g.hub.name, g.partners.length])).toEqual([
      ['Autodesk Construction Cloud', 3],
      ['Procore', 2],
      ['QuickBooks', 2],
    ]);
    for (const group of view.groups) {
      const names = group.partners.map((x) => x.partner.name);
      expect(names).toEqual([...names].sort(compareText));
    }
    expect(view.others.map((o) => o.a.name)).toEqual(['Archicad', 'Sage']);
  });

  const baseline = hubOrder(poweredFixture());
  const safe = POWERED_PAYLOAD_FIELDS.filter((f) => !FILTER_TEXT_FIELDS.has(f));

  for (const dir of ['rising', 'falling'] as const) {
    it.each(safe)(
      `[surface:connector-powered-hub] does not move when %s changes (${dir})`,
      (field) => {
        expect(hubOrder(flipRows(poweredFixture(), [field], dir))).toEqual(baseline);
      },
    );
  }

  it('[surface:connector-powered-hub] does not move when every paid input is loaded onto one pair', () => {
    const rows = poweredFixture();
    for (let i = 0; i < rows.length; i++) {
      expect(hubOrder(loadOne(rows, safe, (r) => r === rows[i])), `pair ${i}`).toEqual(baseline);
    }
  });

  it('sees a move when an order input changes (the comparison is not vacuous)', () => {
    const renamed = poweredFixture().map((row) =>
      row.target.slug === 'xero' ? { ...row, target: link('xero', 'Aardvark') } : row,
    );
    expect(hubOrder(renamed)).not.toEqual(baseline);
  });
});

// ─── A connector's hero wheel (QA pass on AECI-2035) ──────────────────────────

/** The connector wheel's decisions: who is on it, in what order, and how it is drawn. */
function connectorWheelDecisions(items: PoweredIntegrationItem[]) {
  const model = connectorWheelModel(items, 'agave-erp-sync', undefined);
  return {
    slides: model.slides.map((s) => ({
      key: s.key,
      products: s.products.map((p) => p.id),
      integrations: s.integrations,
    })),
    layouts: [...WHEEL_BANDS, 640].map((d) =>
      model.slides.map((_, i) => {
        const layout = layoutSlide(model, i, d);
        return { mode: layout.mode, tile: layout.tilePx, points: layout.points };
      }),
    ),
  };
}

describe('on-page ordering firewall: a connector hero wheel', () => {
  it('[surface:product-page-hero-wheel] shows every product the pairs reach, A to Z by name, id on a tie', () => {
    const model = connectorWheelModel(poweredFixture(), 'agave-erp-sync', undefined);
    expect(model.slides).toHaveLength(1);
    const names = model.slides[0]!.products.map((p) => p.name);
    expect(names).toEqual([...names].sort(compareText));
    // Two "Bluebeam" products: the id breaks the tie, so both are on it.
    expect(names.filter((n) => n === 'Bluebeam')).toHaveLength(2);
    // One dot per product.
    expect(model.slides[0]!.integrations).toBe(names.length);
  });

  const connectorBaseline = connectorWheelDecisions(poweredFixture());
  const safe = POWERED_PAYLOAD_FIELDS.filter((f) => !FILTER_TEXT_FIELDS.has(f));

  for (const dir of ['rising', 'falling'] as const) {
    it.each(safe)(
      `[surface:product-page-hero-wheel] a connector wheel does not move when %s changes (${dir})`,
      (field) => {
        expect(connectorWheelDecisions(flipRows(poweredFixture(), [field], dir))).toEqual(
          connectorBaseline,
        );
      },
    );
  }

  it('[surface:product-page-hero-wheel] the set a page shows reads the role and empty sets only', () => {
    const rows = poweredFixture();
    const page = (role: 'application' | 'connector' | 'hybrid', endpoint: boolean) => ({
      product_role: role,
      slug: 'agave-erp-sync',
      integrations_as_source: endpoint ? (wheelFixture().asSource as ProductIntegrationItem[]) : [],
      integrations_as_target: [],
      integrations_as_connector: rows,
    });
    expect(heroWheelSource(page('connector', true))).toBe('connector');
    expect(heroWheelSource(page('hybrid', true))).toBe('endpoint');
    expect(heroWheelSource(page('application', false))).toBe('connector');
    expect(heroWheelSource({ ...page('connector', true), integrations_as_connector: [] })).toBe(
      'endpoint',
    );
    expect(heroWheelSource({ ...page('connector', false), integrations_as_connector: [] })).toBe(
      'empty',
    );
    expect(heroWheelSource({ ...page('hybrid', false), integrations_as_connector: [] })).toBe(
      'none',
    );
  });

  it('sees a move when a product name changes (the comparison is not vacuous)', () => {
    const renamed = poweredFixture().map((row) =>
      row.target.slug === 'xero' ? { ...row, target: link('xero', 'Aardvark') } : row,
    );
    expect(connectorWheelDecisions(renamed)).not.toEqual(connectorBaseline);
  });
});

// ─── The accepted exception: taxonomy term counts ─────────────────────────────

/**
 * `taxonomy-term-product-count` (registry entry in the API half). Accepted by Chris on
 * 2026-11-14: "A, create a ticket to address later". The permanent rule is AECI-1836.
 * Terms rank by `product_count`, which a Managed product's
 * `product.taxonomy.edit` writes move. These cases keep it narrow: `topByCount` must
 * read `product_count` and nothing else, including on a tie, where it must keep the
 * input order rather than reach for another field.
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

/** Ties on count at 4 and at 2, in an input order that is neither A to Z nor display order. */
function termsFixture(): TaxonomyTermWithCount[] {
  return [
    term('plumbing', 'Plumbing', 4, 2),
    term('roofing', 'roofing', 9, 1),
    term('electrical', 'Electrical', 4, 3),
    term('masonry', 'Masonry', 2, 6),
    term('hvac', 'HVAC', 7, 4),
    term('concrete', 'Concrete', 2, 5),
    term('acoustics', 'Acoustics', 4, 7),
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

function flipTerms(terms: TaxonomyTermWithCount[], dir: Direction): TaxonomyTermWithCount[] {
  return terms.map((t, i) => {
    const level = dir === 'rising' ? i : terms.length - 1 - i;
    const values: Record<(typeof TERM_NON_COUNT_FIELDS)[number], unknown> = {
      id: `id-flipped-${level}`,
      slug: `flipped-${level}`,
      name: `${String.fromCharCode(65 + level)} term`,
      description: `Described ${level}`,
      display_order: level,
      integration_count: level * 10,
    };
    return { ...t, ...values } as TaxonomyTermWithCount;
  });
}

describe('on-page ordering firewall: the taxonomy term-count exception', () => {
  it('the exception capability is still Managed-only (retire the entry if AECI-1836 frees it)', () => {
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

  it('[surface:taxonomy-term-product-count] topByCount reads product_count and nothing else, and keeps input order on a tie', () => {
    // Positions, not slugs: the flip rewrites the slugs.
    const positions = (terms: TaxonomyTermWithCount[], n: number) =>
      topByCount(terms, n).map((t) => terms.indexOf(t));
    const base = termsFixture();
    expect(topByCount(base, TOP_N).map((t) => t.slug)).toEqual([
      'roofing',
      'hvac',
      'plumbing',
      'electrical',
      'acoustics',
      'masonry',
      'concrete',
    ]);
    for (const dir of ['rising', 'falling'] as const) {
      for (const n of [TOP_N, 3, 4]) {
        // 3 and 4 cut through the tie at 4 products: the featured subset.
        expect(positions(flipTerms(base, dir), n), `${dir} top ${n}`).toEqual(positions(base, n));
      }
    }
  });

  it('[surface:taxonomy-term-product-count] phases never rank by count: display order in the nav, lifecycle on /search', () => {
    const counts = termsFixture();
    for (const dir of ['rising', 'falling'] as const) {
      const recounted = counts.map((t, i) => ({
        ...t,
        product_count: dir === 'rising' ? i * 7 : 50 - i * 7,
      }));
      expect(byDisplayOrder(recounted).map((t) => t.slug)).toEqual(
        byDisplayOrder(counts).map((t) => t.slug),
      );
    }

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

// ─── The Browse menu ──────────────────────────────────────────────────────────

/**
 * `browse-menu-term-order` (AECI-1774). The Browse menu orders five lists from
 * `GET /api/taxonomy`, which carries no plan, license or review field. The inputs a
 * paid plan can change there are the audience, phase and trade product counts
 * (`product.taxonomy.edit`). Categories are Free to tag.
 *
 * Flipped both ways, with real ties:
 *  - the Managed-only counts move nothing in the key column, the Categories column or
 *    the Phases column, and the set of rows in each stays the same;
 *  - every non-count field moves nothing anywhere;
 *  - a category count change, which is Free, still never moves the key column: that
 *    list is the editorial pick, not a count order.
 *
 * Audiences and trades are the accepted exception: their counts order them.
 */
function browseFixture(): TaxonomyResponse {
  return {
    categories: [
      term('accounting-erp', 'Accounting & ERP', 9, 10),
      term('ai', 'AI', 4, 20),
      term('field', 'Field Management', 4, 30),
      term('bim-authoring', 'BIM Authoring', 2, 60),
      term('documents', 'document Management', 4, 40),
      term('estimating', 'Estimating', 6, 50),
      term('project-management', 'Project Management', 7, 230),
      term('safety', 'Safety', 2, 70),
      term('scheduling', 'Scheduling', 6, 80),
      term('bids', 'Bid Management', 2, 90),
      term('robotics', 'Robotics', 0, 100),
    ],
    audiences: termsFixture(),
    phases: [
      term('closeout', 'Closeout', 9, 5),
      term('concept', 'Concept', 2, 1),
      term('construction', 'Construction', 9, 4),
      term('design', 'Design', 2, 2),
      term('precon', 'Pre-Construction', 4, 3),
    ],
    trades: termsFixture(),
    total_products: 40,
  };
}

const MANAGED_COUNT_FACETS = ['audiences', 'phases', 'trades'] as const;

/** New counts that run against the fixture order, never below `floor`. */
function flipCounts(
  terms: TaxonomyTermWithCount[],
  dir: Direction,
  floor = 1,
): TaxonomyTermWithCount[] {
  return terms.map((t, i) => ({
    ...t,
    product_count: floor + (dir === 'rising' ? i * 3 : (terms.length - i) * 3),
  }));
}

const columnSlugs = (menu: BrowseMenuModel) => ({
  keyCategories: menu.keyCategories.map((t) => t.slug),
  categories: menu.categories.map((t) => t.slug),
  phases: menu.phases.map((t) => t.slug),
  audiences: menu.audiences.map((t) => t.slug),
  trades: menu.trades.map((t) => t.slug),
});

describe('on-page ordering firewall: the Browse menu', () => {
  const base = columnSlugs(buildBrowseMenu(browseFixture()));

  /**
   * The menu's whole input is `GET /api/taxonomy`. Pin every field of it, so a
   * field added to the payload (a plan, a license, a "featured" flag, a review
   * count) fails here and forces a firewall review before the menu can read it.
   * The API builds each term through `toTaxonomyTermWithCount`, which is typed
   * to this schema, so an extra key fails the API typecheck as well. A trade's
   * "published" state is not a field: `isPublishedTrade` derives it from
   * `product_count`.
   */
  it('[surface:browse-menu-term-order] pins every field of the payload the menu reads', () => {
    expect(Object.keys(TaxonomyResponseSchema.shape).sort()).toEqual([
      'audiences',
      'categories',
      'phases',
      'total_products',
      'trades',
    ]);
    expect(Object.keys(TaxonomyTermWithCountSchema.shape).sort()).toEqual([
      'description',
      'display_order',
      'id',
      'integration_count',
      'name',
      'product_count',
      'slug',
    ]);
  });

  it('[surface:browse-menu-term-order] the baseline has real ties and the documented orders', () => {
    expect(base.keyCategories).toEqual([
      'ai',
      'project-management',
      'bim-authoring',
      'accounting-erp',
    ]);
    // Count, then name ignoring case: categories tie at 6, at 4 and at 2.
    expect(base.categories).toEqual([
      'estimating',
      'scheduling',
      'documents',
      'field',
      'bids',
      'safety',
    ]);
    expect(base.phases).toEqual(['concept', 'design', 'precon', 'construction', 'closeout']);
    expect(base.audiences).toEqual([
      'roofing',
      'hvac',
      'acoustics',
      'electrical',
      'plumbing',
      'concrete',
      'masonry',
    ]);
  });

  for (const dir of ['rising', 'falling'] as const) {
    it(`[surface:browse-menu-term-order] Managed-only counts move no key, category or phase row (${dir})`, () => {
      const fixture = browseFixture();
      for (const facet of MANAGED_COUNT_FACETS) fixture[facet] = flipCounts(fixture[facet], dir);
      const flipped = columnSlugs(buildBrowseMenu(fixture));
      expect(flipped.keyCategories).toEqual(base.keyCategories);
      expect(flipped.categories).toEqual(base.categories);
      expect(flipped.phases).toEqual(base.phases);
    });

    it(`[surface:browse-menu-term-order] no non-count field moves any column (${dir})`, () => {
      const fixture = browseFixture();
      for (const facet of ['categories', ...MANAGED_COUNT_FACETS] as const) {
        const terms = fixture[facet];
        fixture[facet] = terms.map((t, i) => {
          const level = dir === 'rising' ? i : terms.length - 1 - i;
          return {
            ...t,
            description: `Described ${level}`,
            integration_count: level * 10,
            // Phases read display order, so it is an order input there only.
            display_order: facet === 'phases' ? t.display_order : level,
          };
        });
      }
      expect(columnSlugs(buildBrowseMenu(fixture))).toEqual(base);
    });

    it(`[surface:browse-menu-term-order] a category count change never moves the key column (${dir})`, () => {
      const fixture = browseFixture();
      fixture.categories = flipCounts(fixture.categories, dir);
      expect(columnSlugs(buildBrowseMenu(fixture)).keyCategories).toEqual(base.keyCategories);
    });
  }

  it('[surface:browse-menu-term-order] audiences and trades are the named exception: count, then name', () => {
    const fixture = browseFixture();
    fixture.audiences = flipCounts(fixture.audiences, 'falling');
    const audiences = columnSlugs(buildBrowseMenu(fixture)).audiences;
    // Not vacuous: the count is the one input that moves them.
    expect(audiences).not.toEqual(base.audiences);
    const byName = [...fixture.audiences].sort((a, b) => compareText(a.name, b.name));
    expect(audiences).toEqual(topByCount(byName, BROWSE_COLUMN_LENGTH).map((t) => t.slug));
  });
});

// ─── The empty pair page's closest matches (AECI-1829) ─────────────────────────

describe('on-page ordering firewall: the empty pair page closest-matches filter', () => {
  /** The fields the reader's filter reads: the category toggles and the data-object picks. */
  const FILTER_INPUTS = new Set(['shared_categories', 'data_objects']);
  /**
   * Text the search matches (with `product.name`). Flipping it would change what a query
   * matches, which is the search working, not an order reading a paid input, so it is
   * never flipped (the Integrations section's `FILTER_TEXT_FIELDS` rule).
   */
  const FILTER_TEXT = new Set(['vendor_name']);
  /** Every other match field. None may move the list. */
  const NOT_INPUTS = [
    'review_count',
    'rating_overall_avg',
    'rating_onboarding_avg',
    'direction',
    'confirmed',
  ] as const;
  /**
   * Fields the payload does not carry today, planted on every match: what a plan, a
   * license, a count or the claim would add. `product.logo_url` is flipped too: it is
   * withheld while a match is unclaimed (AECI-1618), so it is the claim state as the
   * browser sees it.
   */
  const PLANTED = [
    'plan',
    'license',
    'tier',
    'entitlements',
    'claim_status',
    'integration_count',
    'listed_integration_count',
  ] as const;

  const NAMES = [
    'Alpha',
    'Bravo',
    'Charlie',
    'Delta',
    'Delta',
    'Echo',
    'Foxtrot',
    'Golf',
    'Hotel',
    'India',
    'Juliet',
    'Kilo',
  ];

  /** Match `i` of the fixture's 12, A to Z with a tie on "Delta", as the API sends them. */
  function match(i: number): PairAlternativeMatch {
    return {
      product: {
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        slug: `match-${i}`,
        name: NAMES[i]!,
        logo_url: null,
      },
      vendor_name: null,
      review_count: 0,
      rating_overall_avg: null,
      rating_onboarding_avg: null,
      // Three category shapes, so every filter state keeps rows on both sides of its cut.
      shared_categories:
        i % 3 === 0
          ? [{ slug: 'accounting', name: 'Accounting' }]
          : i % 3 === 1
            ? [{ slug: 'estimating', name: 'Estimating' }]
            : [
                { slug: 'accounting', name: 'Accounting' },
                { slug: 'erp', name: 'ERP' },
              ],
      data_objects:
        i % 2 === 0
          ? [
              { slug: 'invoice', name: 'Invoices' },
              { slug: 'cost-code', name: 'Cost codes' },
            ]
          : [{ slug: 'invoice', name: 'Invoices' }],
      direction: null,
      confirmed: false,
    };
  }

  const lane = (matches: PairAlternativeMatch[]): PairAlternativeLane => ({
    anchors: [
      { id: '10000000-0000-4000-8000-000000000001', slug: 'accounting', name: 'Accounting' },
      { id: '10000000-0000-4000-8000-000000000002', slug: 'erp', name: 'ERP' },
      { id: '10000000-0000-4000-8000-000000000003', slug: 'estimating', name: 'Estimating' },
    ],
    matches,
  });

  /** Every kind of reader state the deck offers, from nothing touched to the narrowest. */
  const STATES: readonly { off: string[]; picked: string[]; query?: string }[] = [
    { off: [], picked: [] },
    { off: ['estimating'], picked: [] },
    { off: ['accounting'], picked: [] },
    { off: ['accounting', 'erp'], picked: [] },
    { off: [], picked: ['cost-code'] },
    { off: ['estimating'], picked: ['invoice', 'cost-code'] },
    // The search (AECI-1835): a product name substring, alone and with the other filters.
    { off: [], picked: [], query: 'O' },
    { off: ['estimating'], picked: ['invoice'], query: 'delta' },
  ];

  const ids = (l: PairAlternativeLane) =>
    STATES.map((st) => filterPairMatches(l, st.off, st.picked, st.query).map((m) => m.product.id));

  /** A paid or count-like value at `level`, 0 being none. Higher is "more". */
  function notInputValue(field: string, level: number): unknown {
    switch (field) {
      case 'review_count':
      case 'integration_count':
      case 'listed_integration_count':
        return level * 7;
      case 'rating_overall_avg':
      case 'rating_onboarding_avg':
        return level === 0 ? null : Math.min(5, 1 + level / 3);
      case 'direction':
        return level === 0 ? null : level % 2 === 0 ? 'both' : 'outbound';
      case 'confirmed':
        return level % 2 === 1;
      case 'plan':
      case 'tier':
        return level === 0 ? 'free' : 'managed';
      case 'license':
        return level === 0 ? null : { tier: 'managed', seats: level };
      case 'entitlements':
        return level === 0 ? [] : [...MANAGED_ONLY];
      case 'claim_status':
        return level === 0 ? 'unclaimed' : 'claimed';
      default:
        throw new Error(`No value for ${field}`);
    }
  }

  function withLevels(
    rows: readonly PairAlternativeMatch[],
    level: (i: number) => number,
  ): PairAlternativeMatch[] {
    return rows.map((row, i) => ({
      ...row,
      ...Object.fromEntries(
        [...NOT_INPUTS, ...PLANTED].map((f) => [f, notInputValue(f, level(i))]),
      ),
      product: {
        ...row.product,
        logo_url: level(i) === 0 ? null : `https://cdn.example.com/logo-${i}.png`,
      },
    })) as PairAlternativeMatch[];
  }

  const rows = Array.from({ length: 12 }, (_, i) => match(i));
  const base = ids(lane(rows));

  it('classifies every match field as a filter input or a field the filter may not read', () => {
    for (const f of Object.keys(PairAlternativeMatchSchema.shape)) {
      const known =
        FILTER_INPUTS.has(f) ||
        FILTER_TEXT.has(f) ||
        f === 'product' ||
        (NOT_INPUTS as readonly string[]).includes(f);
      expect(known, f).toBe(true);
    }
  });

  it('[surface:pair-page-closest-matches] the reader filter removes and never reorders', () => {
    const whole = base[0]!;
    expect(whole).toEqual(rows.map((m) => m.product.id));
    for (const subset of base.slice(1)) {
      // Each state cuts some and keeps some, so the subsequence check is not vacuous.
      expect(subset.length).toBeGreaterThan(0);
      expect(subset.length).toBeLessThan(whole.length);
      expect(whole.filter((id) => subset.includes(id))).toEqual(subset);
    }
    // Every category off empties the list. It never falls back to another order.
    expect(filterPairMatches(lane(rows), ['accounting', 'erp', 'estimating'], [])).toEqual([]);
  });

  for (const dir of ['rising', 'falling'] as const) {
    it(`[surface:pair-page-closest-matches] plan, license, ratings, counts and claim state move nothing (${dir})`, () => {
      const flipped = withLevels(rows, (i) => (dir === 'rising' ? i : rows.length - 1 - i));
      expect(ids(lane(flipped))).toEqual(base);
    });
  }

  it('[surface:pair-page-closest-matches] paid inputs loaded onto any one match move nothing', () => {
    for (let k = 0; k < rows.length; k++) {
      expect(ids(lane(withLevels(rows, (i) => (i === k ? 9 : 0)))), `match ${k}`).toEqual(base);
    }
  });

  it('sees a move when a filter input changes (the comparison is not vacuous)', () => {
    const moved = rows.map((m, i) =>
      i === 0 ? { ...m, shared_categories: [{ slug: 'estimating', name: 'Estimating' }] } : m,
    );
    expect(ids(lane(moved))).not.toEqual(base);
  });

  it('[surface:pair-page-closest-matches] the search matches product or vendor names and never reorders', () => {
    const named = rows.map((m, i) => (i === 7 ? { ...m, vendor_name: 'Quill Software' } : m));
    const all = filterPairMatches(lane(named), [], []).map((m) => m.product.id);
    // A vendor name match keeps its row; a product name match keeps its rows; case and
    // accents fold as in the Integrations section.
    expect(filterPairMatches(lane(named), [], [], 'quill').map((m) => m.product.id)).toEqual([
      named[7]!.product.id,
    ]);
    const byName = filterPairMatches(lane(named), [], [], 'DÉLTA').map((m) => m.product.id);
    expect(byName).toEqual([named[3]!.product.id, named[4]!.product.id]);
    expect(all.filter((id) => byName.includes(id))).toEqual(byName);
    // Whitespace is no query.
    expect(filterPairMatches(lane(named), [], [], '   ').map((m) => m.product.id)).toEqual(all);
  });

  it('[surface:pair-page-closest-matches] the filter and the section hold no comparator and name no paid input', () => {
    const filter = readFileSync(
      join(process.cwd(), 'src/app/products/pair-matches-filter.ts'),
      'utf8',
    )
      // The doc comment names what the filter never reads.
      .replace(/\/\*\*[\s\S]*?\*\//g, '');
    expect(filter).not.toMatch(/\.sort\(|toSorted|localeCompare|compareText/);
    // `vendor_name` is search text (FILTER_TEXT), so the filter may read it.
    expect(filter).not.toMatch(
      /plan|license|tier|entitle|rating|review_count|integration_count|claim|logo_url|confirmed/,
    );
    const section = readFileSync(
      join(process.cwd(), 'src/app/products/pair-empty-alternatives.ts'),
      'utf8',
    );
    expect(section).not.toMatch(/\.sort\(|toSorted|localeCompare/);
    // The section's list is the pure filter's output, rendered in the order it is given.
    expect(section).toMatch(/filterPairMatches\(/);
  });
});
