/**
 * The on-page ordering firewall (AECI-1814, `STAGE_2_PAID_TIERS_SPEC.md` §3.2 assertion
 * 8; ruling R1 on AECI-1732).
 *
 * The Terms say "Payment never changes the order in which products are listed or
 * returned in search" (ruling 65, AECI-2230). The other firewall tests
 * cover search attributes, sort keys and `listing_tier` inputs. This one covers the
 * order of lists on a page: no on-page sort, default order or featured subset may read
 * an input that only a capability outside the Free set can change.
 *
 * Ruling R1 (Chris, 2026-11-14): "Maintain orders as they are. If its a new feature a
 * to z". Applied:
 *
 *  1. Every NEW on-page list is A to Z by name, with id as the tie-break.
 *  2. The via-lane groups and the powered-hub groups keep their count order.
 *  3. The pair page keeps integrations first, then evidenced pairs. Since AECI-2043
 *     (ruling 14 on AECI-2035) a Sync Service's cards come after both, A to Z by the
 *     offering vendor, id on a tie.
 *  4. "Confirmed by both companies" is a row label only, never a filter or a sort.
 *
 * Six blocks:
 *
 *  1. The registry of ordered surfaces (`SURFACES`). It is hand-written: a surface is
 *     covered only once it is registered. Each entry is covered here, covered in the
 *     browser halves (`apps/web/src/app/products/on-page-ordering-firewall*.spec.ts`),
 *     pending with the issue that will build it, or the one tolerated exception.
 *  2. The Managed-only inputs, derived from the capability registry.
 *  3. Why the count orders pass: the writes that change an integration row count call
 *     no plan check. A source scan, so a tripwire rather than a proof.
 *  4. The pair page, behaviourally, over the in-memory D1 harness.
 *  5. `related_products`, behaviourally.
 *  6. The accepted taxonomy term-count exception (Chris, 2026-11-14; permanent rule in
 *     AECI-1836), kept narrow by a source scan (a tripwire).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PairAlternativesSchema,
  ProductDetailSchema,
  ProductPairResponseSchema,
} from '@aeci/shared';
import {
  CAPABILITIES,
  PRODUCT_FIELD_CAPABILITIES,
  TIER_CAPABILITIES,
  VENDOR_FIELD_CAPABILITIES,
  type Capability,
} from '@aeci/shared/entitlements';
import { compareText } from '@aeci/shared/text-sort';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import type { Db } from '../db/client';
import {
  attestations,
  claims,
  connectorEvidencedPairs,
  integrations,
  productAudiences,
  productCategories,
  productPhases,
  products,
  productTrades,
  productVendors,
  productVersions,
  taxonomyAudiences,
  taxonomyCategories,
  taxonomyDataObjects,
  taxonomyPhases,
  taxonomyTrades,
  vendors,
} from '../db/schema';
import { createPairAlternativesHandler, createProductPairHandler } from '../routes/integrations';
import { createProductDetailHandler } from '../routes/products';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { seedLicense } from '../test/licenses';

/** Vitest runs with cwd = apps/api. */
const API_SRC = join(process.cwd(), 'src');
const WEB_APP = join(process.cwd(), '..', 'web', 'src', 'app');
const WEB_SPECS = [
  join(WEB_APP, 'products', 'on-page-ordering-firewall.spec.ts'),
  join(WEB_APP, 'products', 'on-page-ordering-firewall.component.spec.ts'),
];
const THIS_SPEC = join(API_SRC, 'lib', 'on-page-ordering-firewall.spec.ts');

/** A cold in-memory D1 plus two worlds takes several seconds on a loaded machine. */
const DB_TIMEOUT = 30_000;

// ─── 1. The registry ──────────────────────────────────────────────────────────

/** One place that orders or cuts taxonomy terms by a count. */
interface CountSite {
  readonly file: string;
  readonly kind:
    | 'top-by-count'
    | 'count-sort'
    | 'count-compare'
    | 'count-cut'
    | 'publish-floor'
    | 'algolia-facet';
  /** The facet, or `*` when one comparator or cut serves every facet. */
  readonly facet:
    | 'categories'
    | 'audiences'
    | 'phases'
    | 'trades'
    | 'vendor_name'
    | 'connector_kind'
    | '*';
  /** For a sort or a cut, the expression as written, whitespace collapsed. */
  readonly detail?: string;
}

type Surface =
  | {
      readonly key: string;
      readonly status: 'covered';
      readonly spec: 'api' | 'web';
      readonly order: string;
    }
  | {
      readonly key: string;
      readonly status: 'pending';
      readonly owner: `AECI-${number}`;
      readonly order: string;
    }
  | {
      readonly key: string;
      readonly status: 'exception';
      readonly capability: Capability;
      readonly surfaces: readonly string[];
      /** Orders and featured subsets. */
      readonly sites: readonly CountSite[];
      /** Indexing decisions on the same input. Not orders, but they move with the ruling. */
      readonly indexing: readonly CountSite[];
      readonly reason: string;
      readonly ruling: string;
      /** The issue that holds the permanent rule. */
      readonly followUp: `AECI-${number}`;
    };

/**
 * The registered ordered lists on public pages. A pending entry names the issue that
 * builds the surface: that issue moves it to `covered` and adds its case. The
 * exception is ONE entry, so the permanent rule (AECI-1836) changes one place.
 */
const SURFACES: readonly Surface[] = [
  {
    key: 'product-integrations-direct-lane',
    status: 'covered',
    spec: 'web',
    order: 'Partner name A to Z, then edge name, then id',
  },
  {
    key: 'product-integrations-via-groups',
    status: 'covered',
    spec: 'web',
    order: 'Row count, then connector name, unnamed last (kept under R1); rows A to Z',
  },
  {
    key: 'product-integrations-above-fold',
    status: 'covered',
    spec: 'web',
    order: 'The first 20 rows of the two orders above, before the @defer boundary',
  },
  {
    key: 'connector-powered-hub',
    status: 'covered',
    spec: 'web',
    order:
      'Partner count, then hub name (kept under R1); partners and flat pairs A to Z; cards and table share the order (AECI-1924)',
  },
  {
    key: 'pair-page-mechanisms',
    status: 'covered',
    spec: 'api',
    order:
      'Integrations A to Z by name then id, then evidenced pairs A to Z by name then id; Sync Service cards from either table last, A to Z by the offering vendor case folded, an unknown vendor last, then id (AECI-2043, ruling 14)',
  },
  {
    key: 'pair-page-claims',
    status: 'covered',
    spec: 'api',
    order: 'Data object display order, nulls last, then data object name',
  },
  {
    key: 'related-products',
    status: 'covered',
    spec: 'api',
    order:
      'New list (R1, AECI-1785): A to Z by name, case folded, id breaking a tie, 6 shown; membership by shared category',
  },
  {
    key: 'pair-page-closest-matches',
    status: 'covered',
    spec: 'api',
    order:
      'New list (R1, AECI-1829): A to Z by name with compareText (case only breaks a letter tie), id breaking a tie, none cut; membership by an integration with the kept product and a category shared with the other product. The page filter (`pair-matches-filter.ts`) only removes, and the web spec holds it to that',
  },
  {
    key: 'browse-menu-term-order',
    status: 'covered',
    spec: 'web',
    order:
      'Key categories: a fixed editorial list (R4). Categories: product count (Free), then name, then id. Phases: display order. Audiences and trades: the accepted count order (taxonomy-term-product-count), then name, then id',
  },
  {
    key: 'product-page-integrations-redesign',
    status: 'covered',
    spec: 'web',
    order:
      'Cards and table keep the lane orders above (R1 keeps existing orders); reader filters remove rows only; chip options A to Z by name, slug tie-break; long lists in AECI-1783',
  },
  {
    key: 'product-page-integrations-long-list',
    status: 'covered',
    spec: 'web',
    order:
      'AECI-1783: groups A to Z by category name, slug tie-break, uncategorised last (R1); rows keep the lane order inside a group; a list groups only at 13 rows or more with fewer groups than half its rows (row count and categories only); a row sits in each of its categories; the first 6 rows of a group above "Show more"; one list shows the first 12 in lane order; no @defer cut in the grouped list',
  },
  {
    key: 'product-page-hero-wheel',
    status: 'covered',
    spec: 'web',
    order:
      "Integrations wheel (AECI-2018, replaced the AECI-1787 category hub): \"All integrations\" first, then one slide per partner category A to Z by name, slug tie-break; every product with an integration on record, A to Z by name with compareText, id tie-break, clockwise from 12 o'clock; one tile size per product and the ring count or dots per slide from the product count and the stage width only; logo and claim state (ruling 64) decide the tile image and the card label, never inclusion, order or size. A connector's wheel (QA pass on AECI-2035): one slide of the products its pairs reach (the hero reach line's set), A to Z by name, id tie-break; which set a page shows reads the role and whether each set is empty, never a plan",
  },
  {
    key: 'product-page-similar-products',
    status: 'covered',
    spec: 'web',
    order: 'Renders related_products in the API order (A to Z, R1); adds no sort, filter or cut',
  },
  {
    key: 'product-page-what-it-syncs',
    status: 'covered',
    spec: 'api',
    order:
      'New list (R1, AECI-2046): a Sync Service page lists the record types across the pairs it delivers, A to Z by the vocabulary name with compareText, slug breaking a tie, none cut; the pair counts describe and never order',
  },
  {
    key: 'taxonomy-term-product-count',
    status: 'exception',
    capability: 'product.taxonomy.edit',
    surfaces: [
      'Browse menu (header and mobile menu): audiences and trades top 7 by product count, terms with no products left out; trades behind the publish floor',
      'Home: trades top 10 by product count, behind the publish floor',
      '/search: audience and trade facet values in Algolia count order (pinned by source only)',
      '/audiences, /phases, /trades: the reader-chosen "Most products" sort; /trades behind the floor',
      'Browse pages: the facet sidebar hides terms with no matching products',
    ],
    sites: [
      { file: 'core/taxonomy/browse-menu-model.ts', kind: 'top-by-count', facet: 'audiences' },
      { file: 'core/taxonomy/browse-menu-model.ts', kind: 'top-by-count', facet: 'trades' },
      { file: 'core/taxonomy/browse-menu-model.ts', kind: 'publish-floor', facet: 'trades' },
      // `withProducts`, shared by every Browse column: a term with no products never
      // appears. It cuts audiences too, so it sits inside the exception.
      {
        file: 'core/taxonomy/browse-menu-model.ts',
        kind: 'count-cut',
        facet: '*',
        detail: 'term.product_count > 0',
      },
      { file: 'home/home.ts', kind: 'top-by-count', facet: 'trades' },
      { file: 'home/home.ts', kind: 'publish-floor', facet: 'trades' },
      { file: 'search/search-controller.ts', kind: 'algolia-facet', facet: 'audiences' },
      { file: 'search/search-controller.ts', kind: 'algolia-facet', facet: 'trades' },
      // The `/search` refinement lists' own comparator (AECI-1796): checked first, then
      // count, then `compareText`. It is the order Algolia's default gave before, made
      // explicit so a count tie no longer falls to letter case. It serves every list
      // above and in `FREE_COUNT_SITES`, so it sits under the exception.
      {
        file: 'search/search-facet-order.ts',
        kind: 'count-compare',
        facet: '*',
        detail: 'b.count - a.count',
      },
      // `topByCount` itself: its comparator reads `SORT_KEY`, which is `product_count`.
      {
        file: 'core/taxonomy/taxonomy-rank.ts',
        kind: 'count-sort',
        facet: '*',
        detail: '[SORT_KEY], [SORT_KEY]',
      },
      {
        file: 'taxonomy/taxonomy-index.ts',
        kind: 'count-sort',
        facet: '*',
        detail: 'b.product_count, a.product_count',
      },
      {
        file: 'taxonomy/taxonomy-index.ts',
        kind: 'count-compare',
        facet: '*',
        detail: 'b.product_count - a.product_count',
      },
      { file: 'taxonomy/taxonomy-index.ts', kind: 'publish-floor', facet: 'trades' },
      {
        file: 'shared/facets/facet-sidebar.ts',
        kind: 'count-cut',
        facet: '*',
        detail: 'item.count > 0',
      },
    ],
    indexing: [
      // `/trades/:slug` is noindex below the publish floor. An indexing decision, not an order.
      { file: 'taxonomy/taxonomy-browse.resolver.ts', kind: 'publish-floor', facet: 'trades' },
    ],
    reason: 'orders terms, not vendors; existing order kept under R1',
    ruling: 'accepted by Chris 2026-11-14 (Slack): "A, create a ticket to address later"',
    followUp: 'AECI-1836',
  },
];

/**
 * Count orders over an input no plan gates. Categories are Free
 * (`product.categories.edit`). Phases on `/search` are re-sorted into lifecycle order,
 * so their counts never order them. The vendor facet counts products per vendor,
 * which promote and the product create write (block 3).
 */
const FREE_COUNT_SITES: readonly CountSite[] = [
  { file: 'core/taxonomy/browse-menu-model.ts', kind: 'top-by-count', facet: 'categories' },
  // The home browse block's category row. Its head (`slice(0, 5)`) is also the home
  // hero's "Largest categories" fallback row (AECI-1792), so one site serves both.
  { file: 'home/home.ts', kind: 'top-by-count', facet: 'categories' },
  { file: 'search/search-controller.ts', kind: 'algolia-facet', facet: 'categories' },
  { file: 'search/search-controller.ts', kind: 'algolia-facet', facet: 'phases' },
  { file: 'search/search-controller.ts', kind: 'algolia-facet', facet: 'vendor_name' },
];

/**
 * The "Connector type" filter (AECI-1662). `connector_kind` is admin-set: no plan
 * capability writes it (`entitlements.spec.ts`). Its two options read in vocabulary
 * order, Integration platform then Sync Service, whatever the counts: `/search`
 * re-sorts them (`orderFacetItems`), and `/products` and browse take the order of
 * `GET /api/products/facets`, which maps `CONNECTOR_KINDS`. The only count use is the
 * hide-at-zero-unless-checked cut, over the same Free product counts.
 */
const CONNECTOR_KIND_COUNT_SITES: readonly CountSite[] = [
  { file: 'search/search-controller.ts', kind: 'algolia-facet', facet: 'connector_kind' },
  // The facet sidebar's kind group, beside the taxonomy cut of the same text in the
  // exception. The scan cannot tell the two apart, so the key repeats.
  {
    file: 'shared/facets/facet-sidebar.ts',
    kind: 'count-cut',
    facet: '*',
    detail: 'item.count > 0',
  },
];

/** Count comparisons that only choose what to print, never an order or a cut. */
const DISPLAY_COUNT_SITES: readonly CountSite[] = [
  // The browse chip prints a count only when there is one.
  { file: 'home/browse-grid.ts', kind: 'count-cut', facet: '*', detail: 'term.product_count > 0' },
  // The term page's empty state.
  {
    file: 'taxonomy/taxonomy-browse.ts',
    kind: 'count-cut',
    facet: '*',
    detail: 't.product_count === 0',
  },
];

const surfaceTags = (file: string): string[] =>
  [...readFileSync(file, 'utf8').matchAll(/\[surface:([a-z0-9-]+)\]/g)].map((m) => m[1]!);
const webTags = () => WEB_SPECS.flatMap(surfaceTags);

describe('on-page ordering firewall: the surface registry', () => {
  it('every covered surface has a test tagged with its key, in the spec it names', () => {
    const tags = { api: surfaceTags(THIS_SPEC), web: webTags() };
    for (const surface of SURFACES) {
      if (surface.status === 'covered') {
        expect(tags[surface.spec], surface.key).toContain(surface.key);
      }
    }
  });

  it('every surface tag names a registry entry', () => {
    const keys = SURFACES.map((s) => s.key);
    for (const tag of [...surfaceTags(THIS_SPEC), ...webTags()]) {
      expect(keys, tag).toContain(tag);
    }
  });

  it('holds exactly one exception', () => {
    const exceptions = SURFACES.filter((s) => s.status === 'exception');
    expect(exceptions.map((s) => s.key)).toEqual(['taxonomy-term-product-count']);
  });

  for (const surface of SURFACES) {
    if (surface.status === 'pending') {
      it.todo(`[pending ${surface.owner}] ${surface.key}: ${surface.order}`);
    }
  }
});

// ─── 2. The Managed-only inputs ───────────────────────────────────────────────

const FREE = new Set<Capability>(TIER_CAPABILITIES.unclaimed);
const MANAGED_ONLY = CAPABILITIES.filter((c) => !FREE.has(c));

/** The wire fields a capability writes, read from the tables the vendor routes enforce. */
const fieldsWrittenBy = (cap: Capability): string[] =>
  [
    ...Object.entries(PRODUCT_FIELD_CAPABILITIES).map(([f, c]) => [`product.${f}`, c] as const),
    ...Object.entries(VENDOR_FIELD_CAPABILITIES).map(([f, c]) => [`vendor.${f}`, c] as const),
  ]
    .filter(([, c]) => c === cap)
    .map(([f]) => f);

/**
 * What each Managed-only capability that is not a field edit lets a vendor change.
 * Field-edit capabilities are derived from the field tables instead. A Managed-only
 * capability with neither fails the test, so moving one out of the Free set forces a
 * decision about its inputs. Plan state itself (licenses, `vendors.verified`, the
 * plan-end mirrors and edit stamps) is written by no capability: blocks 4 and 5 set
 * it too.
 */
const ROUTE_CAPABILITY_INPUTS: Readonly<Partial<Record<Capability, readonly string[]>>> = {
  // The three product-version writes (`STAGE_2_PAID_TIERS_SPEC.md` §3.3(a)). Since
  // AECI-2038 `attestation.author` is in the Free set, so claim agreement, denials,
  // vendor-added data objects, version stamps on a claim and the maintenance stamps an
  // attestation write moves are no longer Managed-only inputs. The pair page cases
  // still hold them out of every order.
  'product.versions.edit': ['product versions, which a claim can stamp'],
  // A read gate on the pair page, keyed on the pair's vendors (AECI-304).
  'integration.version_diff': ['the depth of the pair page version diff'],
  // Declared with no consumer, and a vendor-only read when it has one.
  'analytics.view': [],
  // Declared with no field: every vendor field is `profile.edit`.
  'profile.rich_fields': [],
};

describe('on-page ordering firewall: the Managed-only inputs', () => {
  it('derives the Managed-only capabilities from the Free set', () => {
    expect(MANAGED_ONLY).toEqual([
      'profile.rich_fields',
      'product.edit',
      'product.taxonomy.edit',
      'product.usefulness.edit',
      'analytics.view',
      'integration.version_diff',
      'product.versions.edit',
    ]);
  });

  it('maps every Managed-only capability to the inputs it can change', () => {
    for (const cap of MANAGED_ONLY) {
      const fields = fieldsWrittenBy(cap);
      // Exactly one source of truth per capability: the field tables, or the list above.
      expect(fields.length > 0 !== cap in ROUTE_CAPABILITY_INPUTS, cap).toBe(true);
    }
    expect(fieldsWrittenBy('product.edit')).toEqual([
      'product.tool_integrations_url',
      'product.api_docs_url',
    ]);
    expect(fieldsWrittenBy('product.taxonomy.edit')).toEqual([
      'product.audience_slugs',
      'product.phase_slugs',
      'product.trade_slugs',
    ]);
    expect(fieldsWrittenBy('product.usefulness.edit')).toEqual(['product.usefulness']);
  });

  it('the inputs related_products reads are Free or not vendor-editable', () => {
    // Category membership, and the name, which no vendor writes (a rename is a
    // correction request).
    expect(FREE.has(PRODUCT_FIELD_CAPABILITIES.category_slugs)).toBe(true);
    expect(Object.keys(PRODUCT_FIELD_CAPABILITIES)).not.toContain('name');
  });
});

// ─── 3. Why the count orders pass ─────────────────────────────────────────────

function sourceFiles(root: string, dir = root, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test' || entry.name === 'node_modules') continue;
      sourceFiles(root, full, acc);
      continue;
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) continue;
    acc.push(full.slice(root.length + 1).replaceAll('\\', '/'));
  }
  return acc;
}

/** Source with comments removed, so a comment can neither hide nor fake a match. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

const apiSource = (rel: string) => stripComments(readFileSync(join(API_SRC, rel), 'utf8'));

const ROW_TABLES = ['integrations', 'connectorEvidencedPairs'] as const;

/**
 * The names a file reaches the two row tables by: the plain import, an aliased import
 * (`integrations as rows`), and a namespace import (`schema.integrations`).
 */
function rowTableNames(src: string): string[] {
  const names: string[] = [...ROW_TABLES];
  for (const m of src.matchAll(/\b(integrations|connectorEvidencedPairs)\s+as\s+(\w+)/g)) {
    names.push(m[2]!);
  }
  for (const m of src.matchAll(/import\s+\*\s+as\s+(\w+)\s+from\s+['"][./]*(?:db\/)?schema['"]/g)) {
    for (const table of ROW_TABLES) names.push(`${m[1]}.${table}`);
  }
  return names;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** How a file writes the two row tables. */
function rowWrites(src: string): { count: boolean; opaque: boolean } {
  const table = `(?:${rowTableNames(src).map(escapeRegExp).join('|')})`;
  const insertOrDelete = new RegExp(`\\.(?:insert|delete)\\(\\s*${table}\\s*\\)`);
  // AECI-2042: an endpoint veto writes `vetoedAt`, which takes a row out of every count
  // the way `retiredAt` does, so it is a count write too.
  const literalRetire = new RegExp(
    `\\.update\\(\\s*${table}\\s*\\)\\s*\\.set\\(\\s*\\{[^}]*\\b(?:retiredAt|vetoedAt)\\b`,
  );
  // A `.set(` whose argument is not an object literal: the scan cannot see its columns.
  const opaque = new RegExp(`\\.update\\(\\s*${table}\\s*\\)\\s*\\.set\\(\\s*[^\\s{]`);
  return { count: insertOrDelete.test(src) || literalRetire.test(src), opaque: opaque.test(src) };
}

/**
 * A plan check. `requireCapability` and its product twin are the route gates.
 * `productTier`, `hasActiveEntitlement` and `assertFieldsEntitled` read the plan,
 * and `entitlementRequired` builds the refusal. Any one inside a row writer would
 * let a plan decide whether a row is created or retired.
 */
const PLAN_CHECK =
  /\b(requireCapability|requireProductCapability|hasCapability|capabilitiesFor|productTier|hasActiveEntitlement|assertFieldsEntitled|entitlementRequired)\(/g;
const planChecks = (src: string) => [...src.matchAll(PLAN_CHECK)].map((m) => m[1]!);

/** Every file that adds, removes, retires or restores an integration row. */
const COUNT_WRITERS = [
  // AECI-2042: the endpoint veto's `vetoed_at` recompute. A seat is the gate, never a plan.
  'lib/sync-service-pair-rights.ts',
  'routes/integration-retire-write.ts',
  'routes/promote.ts',
  'routes/vendor-integration-create.ts',
  // AECI-2040: a Sync Service adds its own pair. A seat is the gate, never a plan.
  'routes/vendor-sync-service-pair-create.ts',
];

/**
 * Files that update a row table through a `.set(` the scan cannot read. Each is
 * reviewed: none writes `retiredAt`, and each is plan-free, so none can hide a count
 * change behind a plan.
 */
const OPAQUE_WRITERS = [
  // A contest accept writes the edited fields (`EDIT_FIELD_COLUMNS`).
  'lib/integration-contests.ts',
  // A claim writes `claimColumns`: claimed_at, maintained_by, last_reviewed_at.
  'routes/vendor-integration-claims.ts',
  // Clears the links of an endpoint that left the row.
  'routes/vendor-integration-links.ts',
];

describe('on-page ordering firewall: the via-group and powered-hub counts', () => {
  const files = sourceFiles(API_SRC);

  it('finds the files that write an integration row (a tripwire, not a proof)', () => {
    const writes = files.map((rel) => ({ rel, ...rowWrites(apiSource(rel)) }));
    expect(
      writes
        .filter((w) => w.count)
        .map((w) => w.rel)
        .sort(),
    ).toEqual(COUNT_WRITERS);
    expect(
      writes
        .filter((w) => w.opaque)
        .map((w) => w.rel)
        .sort(),
    ).toEqual(OPAQUE_WRITERS);
    // The shared retire write runs from these two routes and nowhere else.
    expect(
      files
        .filter((rel) => rel !== 'routes/integration-retire-write.ts')
        .filter((rel) => /\bbuild(Pair)?RetireBatch\(/.test(apiSource(rel)))
        .sort(),
    ).toEqual(['routes/admin-integration-retire.ts', 'routes/vendor-integration-retire.ts']);
  });

  it('the scan sees through an alias, a namespace import and an opaque set', () => {
    expect(
      rowWrites('import { integrations as rows } from "../db/schema"; db.insert(rows)').count,
    ).toBe(true);
    expect(
      rowWrites("import * as schema from '../db/schema'; db.insert(schema.integrations)").count,
    ).toBe(true);
    expect(rowWrites('db.update(integrations).set(patch)').opaque).toBe(true);
    expect(rowWrites('db.update(integrations).set({ retiredAt: now })').count).toBe(true);
    expect(rowWrites('db.update(integrations).set({ vetoedAt: earliest })').count).toBe(true);
    expect(rowWrites(stripComments('// db.insert(integrations)')).count).toBe(false);
  });

  /** Every file that calls `fn(`, other than the one that defines it. */
  const callersOf = (fn: string, definedIn: string) =>
    files
      .filter((rel) => rel !== definedIn)
      .filter((rel) => new RegExp(`\\b${fn}\\(`).test(apiSource(rel)))
      .sort();

  it('derives the routes that hand columns to the opaque contest write', () => {
    // `anchorUpdate` writes whatever columns its caller passes, `mechanism_kind`
    // included, which can move a row into the unnamed Via group.
    expect(callersOf('anchorUpdate', 'lib/integration-contests.ts')).toEqual([
      'routes/admin-contests.ts',
      'routes/vendor-contests.ts',
    ]);
  });

  it('no row writer, nor the routes that rename a row or pass it columns, reads the plan', () => {
    for (const rel of [
      ...COUNT_WRITERS,
      ...OPAQUE_WRITERS,
      ...callersOf('anchorUpdate', 'lib/integration-contests.ts'),
      'routes/vendor-integration-retire.ts',
      'routes/admin-integration-retire.ts',
      'routes/vendor-integration-edits.ts',
      'routes/vendor-evidenced-pair-edits.ts',
    ]) {
      expect(planChecks(apiSource(rel)), rel).toEqual([]);
    }
  });

  it('the plan-check pattern catches a route gate and a tier read (controls)', () => {
    expect(planChecks(apiSource('routes/vendor-attestations.ts'))).toContain(
      'requireProductCapability',
    );
    expect(planChecks(apiSource('routes/vendor-attestations.ts'))).toContain('productTier');
  });

  it('the product create reads the plan only to limit its fields, never the act', () => {
    // The /search vendor facet counts products per vendor. The create is open to any
    // seat; the plan only decides which fields it may set. A new plan check here fails.
    expect(planChecks(apiSource('routes/vendor-product-create.ts')).sort()).toEqual([
      'assertFieldsEntitled',
      'productTier',
    ]);
  });

  it('no capability id names an integration write', () => {
    expect(CAPABILITIES.filter((c) => c.startsWith('integration.'))).toEqual([
      // A read gate on the pair page version diff, not a write.
      'integration.version_diff',
    ]);
  });
});

// ─── Shared fixtures for blocks 4 and 5 ───────────────────────────────────────

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACME = u(901);
const GLOBEX = u(902);

interface Route {
  readonly path: string;
  readonly url: string;
  readonly handler: (t: TestDb) => Parameters<typeof buildAppWithHandler>[0]['handler'];
}

/** Run `seed` in a fresh database, then read the route. */
async function readWorld(seed: (db: Db) => Promise<void>, route: Route): Promise<unknown> {
  const t = await makeTestDb();
  try {
    await seed(t.db);
    const app = buildAppWithHandler({ method: 'get', path: route.path, handler: route.handler(t) });
    const res = await app.request(route.url, {}, TEST_ENV, fakeExecutionContext());
    expect(res.status).toBe(200);
    return await res.json();
  } finally {
    t.dispose();
  }
}

async function seedFacetTerms(db: Db) {
  await db
    .insert(taxonomyTrades)
    .values({ id: u(51), slug: 'roofing', name: 'Roofing', description: 'Roofs' });
  await db.insert(taxonomyAudiences).values({ id: u(52), slug: 'gc', name: 'General Contracting' });
  await db
    .insert(taxonomyPhases)
    .values({ id: u(53), slug: 'design', name: 'Design', displayOrder: 1 });
}

/** Every Managed-only input a product carries that is not a claim, plus plan state. */
async function giveManagedProfile(db: Db, productId: string, vendorId: string, n: number) {
  await seedLicense(db, vendorId, { productId });
  await db.update(vendors).set({ verified: true }).where(eq(vendors.id, vendorId));
  await db
    .update(products)
    .set({
      toolIntegrationsUrl: `https://example.com/${n}/integrations`,
      apiDocsUrl: `https://example.com/${n}/api`,
      usefulness: { audiences: [{ slug: 'gc', name: 'General Contracting', points: ['p'] }] },
      managedEditedAt: '2026-11-01T00:00:00.000Z',
    })
    .where(eq(products.id, productId));
  await db.insert(productVersions).values([
    { id: u(800 + n * 2), productId, label: '1.0', sortKey: 1 },
    { id: u(801 + n * 2), productId, label: '2.0', sortKey: 2 },
  ]);
  await db.insert(productTrades).values({ productId, tradeId: u(51) });
  await db.insert(productAudiences).values({ productId, audienceId: u(52) });
  await db.insert(productPhases).values({ productId, phaseId: u(53) });
}

async function seedTwoVendors(db: Db) {
  await db.insert(vendors).values([
    { id: ACME, companyName: 'Acme Software', slug: 'acme-software' },
    { id: GLOBEX, companyName: 'Globex', slug: 'globex' },
  ]);
}

/**
 * Which rows the paid inputs land on. `last` loads the rows that sort last and
 * lowers the rows that sort first; `first` does the opposite. One of the two
 * disagrees with today's order for any order that rewards or punishes a plan.
 */
type World = 'free' | 'last' | 'first';

// ─── 4. The pair page ─────────────────────────────────────────────────────────

const pairRoute: Route = {
  path: '/api/products/:slug/integrations/:otherSlug',
  url: '/api/products/procore/integrations/revit',
  handler: (t) => createProductPairHandler(t.factory),
};

/** The data object vocabulary: slug → display order and name. */
const DATA_OBJECTS: ReadonlyArray<[n: number, slug: string, name: string, order: number | null]> = [
  [71, 'invoices', 'Invoices', 1],
  [72, 'rfis', 'RFIs', 2],
  [73, 'submittals', 'Submittals', 3],
  [74, 'drawings', 'drawings', null],
  [77, 'photos', 'Photos', 4],
  // Two objects with the same name and no order: a true tie.
  [75, 'logs-a', 'Logs', null],
  [76, 'logs-b', 'Logs', null],
];
const OBJECT_BY_SLUG = new Map(
  DATA_OBJECTS.map(([, slug, name, order]) => [slug, { name, order }]),
);

/**
 * Integrations, with a tie: `Mid bridge` and `mid bridge` are equal under NOCASE, so the
 * id decides. Evidenced pairs, with the same kind of tie.
 */
const PAIR_INTEGRATIONS: ReadonlyArray<[n: number, name: string]> = [
  [10, 'Zeta sync'],
  [11, 'alpha link'],
  [12, 'Mid bridge'],
  [13, 'mid bridge'],
];
const PAIR_EVIDENCED: ReadonlyArray<[n: number, name: string, connector: number]> = [
  [60, 'Zulu', 3],
  [61, 'bravo', 4],
  [62, 'Bravo', 5],
];
/**
 * Two Sync Service cards (AECI-2043, ruling 14): connectors 6 and 7 are `sync_service`.
 * Their names would put 65 first. The offering vendors put 66 first: Acme Software
 * before Globex.
 */
const PAIR_SYNC_SERVICE: ReadonlyArray<
  [n: number, name: string, connector: number, vendor: string]
> = [
  [65, 'Alpha sync', 6, GLOBEX],
  [66, 'Zed sync', 7, ACME],
];
/**
 * Today's order, written out: integrations A to Z then id, then evidenced pairs, then
 * the Sync Service cards A to Z by the offering vendor.
 */
const PAIR_ORDER = [11, 12, 13, 10, 61, 62, 60, 66, 65].map(u);
/**
 * What each paid world loads. `rows` sort last (or first) in their table. `claims`
 * sort last (or first) inside their mechanism. Of the two tied "Logs" claims only 103
 * is listed, so in either world it carries more votes than 102.
 */
const PAIR_LAST = { rows: [10, 13, 60, 62, 65], claims: [100, 103, 105, 106, 107, 109, 110] };
const PAIR_FIRST = { rows: [11, 12, 61, 66], claims: [101, 104, 108, 111] };

/** The AECi seed: claim id, row, data object. */
const PAIR_CLAIMS: ReadonlyArray<[id: number, row: number, object: number]> = [
  [100, 10, 72],
  [101, 11, 71],
  [102, 11, 76],
  [103, 11, 75],
  [104, 12, 71],
  [105, 12, 72],
  [106, 13, 72],
  [107, 60, 71],
  [108, 61, 72],
  [109, 62, 72],
  [110, 65, 71],
  [111, 66, 72],
];

async function seedPair(db: Db, world: World, renameLast = false) {
  await db.insert(products).values([
    { id: u(1), slug: 'procore', name: 'Procore', promotionStatus: 'promoted' },
    { id: u(2), slug: 'revit', name: 'Revit', promotionStatus: 'promoted' },
    ...[3, 4, 5].map((n) => ({
      id: u(n),
      slug: `connector-${n}`,
      name: `Connector ${n}`,
      productRole: 'connector' as const,
      promotionStatus: 'promoted' as const,
    })),
    ...[6, 7].map((n) => ({
      id: u(n),
      slug: `sync-service-${n}`,
      name: `Sync Service ${n}`,
      productRole: 'connector' as const,
      connectorKind: 'sync_service',
      promotionStatus: 'promoted' as const,
    })),
  ]);
  await seedTwoVendors(db);
  // The Sync Service order input (AECI-2043): renamed, Acme's card sorts after Globex's.
  if (renameLast) {
    await db.update(vendors).set({ companyName: 'Zebra Software' }).where(eq(vendors.id, ACME));
  }
  await db.insert(productVendors).values([
    { productId: u(1), vendorId: ACME, isPrimary: true },
    { productId: u(2), vendorId: GLOBEX, isPrimary: true },
  ]);
  await seedFacetTerms(db);
  await db.insert(taxonomyDataObjects).values(
    DATA_OBJECTS.map(([n, slug, name, order]) => ({
      id: u(n),
      slug,
      name,
      ...(order === null ? {} : { displayOrder: order }),
    })),
  );
  await db.insert(integrations).values(
    PAIR_INTEGRATIONS.map(([n, name]) => ({
      id: u(n),
      name: renameLast && n === 10 ? 'Aardvark sync' : name,
      sourceProductId: u(1),
      targetProductId: u(2),
      mechanismKind: 'native' as const,
      direction: 'a_to_b',
    })),
  );
  const [a, b] = [u(1), u(2)].sort();
  await db.insert(connectorEvidencedPairs).values(
    PAIR_EVIDENCED.map(([n, name, connector]) => ({
      id: u(n),
      name,
      connectorProductId: u(connector),
      productAId: a!,
      productBId: b!,
      direction: 'a_to_b',
    })),
  );
  await db.insert(connectorEvidencedPairs).values(
    PAIR_SYNC_SERVICE.map(([n, name, connector, vendor]) => ({
      id: u(n),
      name,
      connectorProductId: u(connector),
      productAId: a!,
      productBId: b!,
      builtByVendorId: vendor,
      direction: 'a_to_b',
    })),
  );
  const isEvidenced = (row: number) => row >= 60;
  for (const [id, row, object] of PAIR_CLAIMS) {
    await db.insert(claims).values({
      id: u(id),
      ...(isEvidenced(row) ? { connectorEvidencedPairId: u(row) } : { integrationId: u(row) }),
      dataObjectId: u(object),
      direction: 'a_to_b',
    });
    await db
      .insert(attestations)
      .values({ id: u(id + 100), claimId: u(id), source: 'aeci', asserted: true });
  }
  if (world === 'free') return;

  await giveManagedProfile(db, u(1), ACME, 1);
  await giveManagedProfile(db, u(2), GLOBEX, 2);
  const up = world === 'last' ? PAIR_LAST : PAIR_FIRST;
  const down = world === 'last' ? PAIR_FIRST : PAIR_LAST;
  const vote = (claim: number, asserted: boolean) =>
    db.insert(attestations).values([
      {
        id: u(claim + 300),
        claimId: u(claim),
        source: 'vendor_a',
        asserted,
        attestedByVendorId: ACME,
      },
      {
        id: u(claim + 400),
        claimId: u(claim),
        source: 'vendor_b',
        asserted,
        attestedByVendorId: GLOBEX,
      },
    ]);
  // "Confirmed by both companies" on the loaded claims.
  for (const claim of up.claims) await vote(claim, true);
  // Both companies deny the lowered claims: refuted, so the data-flow count drops.
  for (const claim of down.claims) await vote(claim, false);

  // Vendor-added data objects on every loaded row, including one that sorts FIRST in
  // the vocabulary, and one withdrawn (its backing vote retracted) on a lowered row.
  // Four on a loaded row, so the case-tied rows 12 and 13 never end level on votes:
  // one is loaded and the other lowered in each world.
  let next = 500;
  const added = async (row: number, object: number, retracted: boolean) => {
    const id = next++;
    await db.insert(claims).values({
      id: u(id),
      ...(isEvidenced(row) ? { connectorEvidencedPairId: u(row) } : { integrationId: u(row) }),
      dataObjectId: u(object),
      direction: 'a_to_b',
      origin: 'vendor',
      createdByVendorId: ACME,
    });
    await db.insert(attestations).values({
      id: u(id + 100),
      claimId: u(id),
      source: 'vendor_a',
      asserted: true,
      attestedByVendorId: ACME,
      ...(retracted ? { retractedAt: '2026-11-12T00:00:00.000Z' } : {}),
    });
  };
  const seededOn = (row: number) => PAIR_CLAIMS.filter(([, r]) => r === row).map(([, , o]) => o);
  for (const row of up.rows.filter((r) => !isEvidenced(r))) {
    for (const object of [71, 73, 74, 77].filter((o) => !seededOn(row).includes(o))) {
      await added(row, object, false);
    }
  }
  for (const row of down.rows.filter((r) => !isEvidenced(r))) await added(row, 73, true);

  // A version stamp on every live vote on every loaded row, so the loaded rows carry
  // all the stamps and the lowered rows none.
  const loadedClaims = await db
    .select({ id: claims.id })
    .from(claims)
    .where(
      or(
        inArray(claims.integrationId, up.rows.map(u)),
        inArray(claims.connectorEvidencedPairId, up.rows.map(u)),
      ),
    );
  await db
    .update(attestations)
    .set({ introducedVersionId: u(802) })
    .where(
      and(
        inArray(
          attestations.claimId,
          loadedClaims.map((c) => c.id),
        ),
        isNull(attestations.retractedAt),
      ),
    );
  // And one stamp on each lowered row, on the claim that sorts LAST in it, so a claim
  // order that put stamped claims first would move inside the row.
  const objectKey = (n: number) => {
    const [, , name, order] = DATA_OBJECTS.find(([id]) => id === n)!;
    return { order: order ?? Number.MAX_SAFE_INTEGER, name };
  };
  for (const row of down.rows) {
    const last = PAIR_CLAIMS.filter(([, r]) => r === row)
      .map(([id, , object]) => ({ id, ...objectKey(object) }))
      .sort((x, y) => x.order - y.order || compareText(x.name, y.name) || x.id - y.id)
      .at(-1);
    if (!last) continue;
    await db
      .update(attestations)
      .set({ introducedVersionId: u(802) })
      .where(and(eq(attestations.claimId, u(last.id)), isNull(attestations.retractedAt)));
  }

  for (const row of up.rows.filter((r) => !isEvidenced(r))) {
    await db
      .update(integrations)
      .set({
        maintainedBy: 'vendor',
        lastReviewedAt: '2026-11-10T00:00:00.000Z',
        vendorEditedAt: '2026-11-10T00:00:00.000Z',
      })
      .where(eq(integrations.id, u(row)));
  }
}

async function pairWorld(world: World, renameLast = false) {
  const body = ProductPairResponseSchema.parse(
    await readWorld((db) => seedPair(db, world, renameLast), pairRoute),
  );
  const seeded = new Set(PAIR_CLAIMS.map(([id]) => u(id)));
  return {
    mechanisms: body.mechanisms.map((m) => m.id),
    /** The AECi claims both worlds share, by id, in rendered order, per mechanism. */
    seededClaims: Object.fromEntries(
      body.mechanisms.map((m) => [m.id, m.claims.map((c) => c.id).filter((id) => seeded.has(id!))]),
    ),
    /** Every rendered claim's data object, per mechanism. */
    objects: Object.fromEntries(
      body.mechanisms.map((m) => [m.id, m.claims.map((c) => c.data_object_slug)]),
    ),
    confirmed: body.sync_headline.confirmed,
    total: body.sync_headline.total,
  };
}

/** Whether a mechanism's claims follow the vocabulary: display order (nulls last), then name. */
function inVocabularyOrder(slugs: readonly string[]): boolean {
  const key = (slug: string) => OBJECT_BY_SLUG.get(slug)!;
  return slugs.every((slug, i) => {
    if (i === 0) return true;
    const x = key(slugs[i - 1]!);
    const y = key(slug);
    const ox = x.order ?? Number.MAX_SAFE_INTEGER;
    const oy = y.order ?? Number.MAX_SAFE_INTEGER;
    return ox < oy || (ox === oy && compareText(x.name, y.name) <= 0);
  });
}

describe('on-page ordering firewall: the pair page', () => {
  it(
    '[surface:pair-page-mechanisms] follows R1: integrations A to Z, then evidenced pairs A to Z, id on a tie',
    async () => {
      const { mechanisms } = await pairWorld('free');
      expect(mechanisms).toEqual(PAIR_ORDER);
    },
    DB_TIMEOUT,
  );

  for (const world of ['last', 'first'] as const) {
    it(
      `[surface:pair-page-mechanisms] [surface:pair-page-claims] does not move when the paid inputs load the ${world} rows`,
      async () => {
        const free = await pairWorld('free');
        const paid = await pairWorld(world);
        // The fixture really did change what a plan buys.
        expect(paid.confirmed).toBeGreaterThan(free.confirmed);
        expect(paid.objects).not.toEqual(free.objects);

        expect(paid.mechanisms).toEqual(free.mechanisms);
        expect(paid.seededClaims).toEqual(free.seededClaims);
        for (const [id, slugs] of Object.entries(paid.objects)) {
          expect(inVocabularyOrder(slugs), `${id}: ${slugs.join(', ')}`).toBe(true);
        }
      },
      DB_TIMEOUT,
    );
  }

  it(
    '[surface:pair-page-claims] a claim tie on name keeps the same order whoever voted',
    async () => {
      const free = await pairWorld('free');
      // u(11) carries two "Logs" objects with no display order: a true tie.
      expect(free.objects[u(11)]).toEqual(['invoices', 'logs-b', 'logs-a']);
      for (const world of ['last', 'first'] as const) {
        expect((await pairWorld(world)).seededClaims[u(11)], world).toEqual(
          free.seededClaims[u(11)],
        );
      }
    },
    DB_TIMEOUT * 2,
  );

  it(
    'sees a move when an order input changes (the comparison is not vacuous)',
    async () => {
      const renamed = await pairWorld('free', true);
      expect(renamed.mechanisms[0]).toBe(u(10));
      // The offering vendor's name is the Sync Service order input (AECI-2043).
      expect(renamed.mechanisms.slice(-2)).toEqual([u(65), u(66)]);
    },
    DB_TIMEOUT,
  );
});

// ─── 5. related_products ──────────────────────────────────────────────────────

const detailRoute: Route = {
  path: '/api/products/:slug',
  url: '/api/products/page',
  handler: (t) => createProductDetailHandler(t.factory),
};

/**
 * The page product and nine candidates sharing its category. Four share one name
 * under NOCASE across the sixth-place boundary, in four spellings: p4, p5 and p6
 * show, p7 does not, on the id tie-break alone. `created_at` falls as the name
 * rises, so a newest-first order would differ everywhere.
 */
const RELATED_NAME: Readonly<Record<number, string>> = {
  2: 'Bravo',
  3: 'charlie',
  4: 'delta',
  5: 'Delta',
  6: 'DELTA',
  7: 'dElTa',
  8: 'Echo',
  9: 'foxtrot',
  10: 'Alpha',
};
const RELATED_ORDER = [10, 2, 3, 4, 5, 6].map(u);
/** `last` loads the products just outside the six (p7 inside the tie); `first` the ones inside. */
const RELATED_LOADED: Readonly<Record<Exclude<World, 'free'>, number[]>> = {
  last: [7, 8, 9],
  first: [10, 4, 5],
};

async function seedRelated(db: Db, world: World, renameLast = false) {
  const at = (day: number) => `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`;
  await db
    .insert(taxonomyCategories)
    .values({ id: u(21), slug: 'field', name: 'Field', displayOrder: 1 });
  await seedFacetTerms(db);
  await db.insert(products).values([
    { id: u(1), slug: 'page', name: 'Page', promotionStatus: 'promoted', createdAt: at(1) },
    ...Object.entries(RELATED_NAME).map(([n, name]) => ({
      id: u(Number(n)),
      slug: `p${n}`,
      name: renameLast && n === '9' ? 'Aardvark' : name,
      promotionStatus: 'promoted' as const,
      createdAt: at(20 - Number(n)),
    })),
  ]);
  await db
    .insert(productCategories)
    .values([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ productId: u(n), categoryId: u(21) })));
  if (world === 'free') return;

  await seedTwoVendors(db);
  // The page product gets every Managed input too, so an order that matched the
  // page's own paid tags (a shared trade, say) would fire.
  await db.insert(productVendors).values({ productId: u(1), vendorId: ACME, isPrimary: true });
  await giveManagedProfile(db, u(1), ACME, 1);
  await db.insert(taxonomyDataObjects).values({ id: u(71), slug: 'invoices', name: 'Invoices' });
  for (const n of RELATED_LOADED[world]) {
    const vendorId = n % 2 === 0 ? GLOBEX : ACME;
    await db.insert(productVendors).values({ productId: u(n), vendorId, isPrimary: true });
    await giveManagedProfile(db, u(n), vendorId, n);
    await db.insert(integrations).values({
      id: u(200 + n),
      name: `P${n} to Page`,
      sourceProductId: u(n),
      targetProductId: u(1),
      mechanismKind: 'native',
      direction: 'both',
    });
    await db.insert(claims).values({
      id: u(300 + n),
      integrationId: u(200 + n),
      dataObjectId: u(71),
      direction: 'both',
    });
    await db.insert(attestations).values([
      {
        id: u(400 + n),
        claimId: u(300 + n),
        source: 'vendor_a',
        asserted: true,
        attestedByVendorId: vendorId,
      },
      {
        id: u(500 + n),
        claimId: u(300 + n),
        source: 'vendor_b',
        asserted: true,
        attestedByVendorId: vendorId,
      },
    ]);
  }
}

async function relatedOrder(world: World, renameLast = false) {
  const body = ProductDetailSchema.parse(
    await readWorld((db) => seedRelated(db, world, renameLast), detailRoute),
  );
  return body.related_products.map((p) => p.id);
}

// ─── The Sync Service "What it syncs" block (AECI-2046) ───────────────────────

/** Record types named so case and input order cannot decide the order. */
const SYNC_OBJECT_NAME: Readonly<Record<number, string>> = {
  61: 'Timesheets',
  62: 'budgets',
  63: 'Change Orders',
  64: 'Budgets & Forecasts',
  65: 'RFIs',
};
const SYNC_OBJECT_ORDER = Object.entries(SYNC_OBJECT_NAME)
  .sort(([an, a], [bn, b]) => compareText(a, b) || Number(an) - Number(bn))
  .map(([n]) => `o${n}`);

/**
 * A Sync Service (the page product) delivering three evidenced pairs over four endpoint
 * products, every record type on every pair. The paid worlds load the Managed profile
 * and both companies' confirmations onto the endpoints of the objects that sort last
 * (or first), so an order that rewarded a plan or an agreement state would move.
 */
async function seedWhatItSyncs(db: Db, world: World, renameLast = false) {
  await db.insert(products).values([
    {
      id: u(1),
      slug: 'page',
      name: 'Page',
      promotionStatus: 'promoted',
      productRole: 'connector',
      connectorKind: 'sync_service',
    },
    ...[2, 3, 4, 5].map((n) => ({
      id: u(n),
      slug: `p${n}`,
      name: `P${n}`,
      promotionStatus: 'promoted' as const,
    })),
  ]);
  await db.insert(taxonomyDataObjects).values(
    Object.entries(SYNC_OBJECT_NAME).map(([n, name]) => ({
      id: u(Number(n)),
      slug: `o${n}`,
      name: renameLast && n === '65' ? 'Aardvark records' : name,
    })),
  );
  const pairs: [number, number][] = [
    [2, 3],
    [2, 4],
    [3, 5],
  ];
  for (const [i, [a, b]] of pairs.entries()) {
    await db.insert(connectorEvidencedPairs).values({
      id: u(200 + i),
      productAId: u(a),
      productBId: u(b),
      connectorProductId: u(1),
      direction: 'both',
    });
    // Inserted in reverse vocabulary order, so a stored order would differ too.
    for (const n of Object.keys(SYNC_OBJECT_NAME).map(Number).reverse()) {
      await db.insert(claims).values({
        id: u(1000 + i * 100 + n),
        connectorEvidencedPairId: u(200 + i),
        dataObjectId: u(n),
        direction: 'both',
      });
    }
  }
  if (world === 'free') return;

  await seedTwoVendors(db);
  await seedFacetTerms(db);
  const loaded = world === 'last' ? [61, 65] : [62, 64];
  for (const [n, vendorId] of [
    [2, ACME],
    [3, GLOBEX],
  ] as const) {
    await db.insert(productVendors).values({ productId: u(n), vendorId, isPrimary: true });
    await giveManagedProfile(db, u(n), vendorId, n);
  }
  for (const object of loaded) {
    await db.insert(attestations).values([
      {
        id: u(5000 + object),
        claimId: u(1000 + object),
        source: 'vendor_a',
        asserted: true,
        attestedByVendorId: ACME,
      },
      {
        id: u(6000 + object),
        claimId: u(1000 + object),
        source: 'vendor_b',
        asserted: true,
        attestedByVendorId: GLOBEX,
      },
    ]);
  }
}

async function whatItSyncsOrder(world: World, renameLast = false) {
  const body = ProductDetailSchema.parse(
    await readWorld((db) => seedWhatItSyncs(db, world, renameLast), detailRoute),
  );
  return (body.what_it_syncs?.objects ?? []).map((o) => o.slug);
}

describe('on-page ordering firewall: the "What it syncs" block', () => {
  it(
    '[surface:product-page-what-it-syncs] A to Z by name with compareText, slug on a tie, none cut',
    async () => {
      expect(await whatItSyncsOrder('free')).toEqual(SYNC_OBJECT_ORDER);
    },
    DB_TIMEOUT,
  );

  for (const world of ['last', 'first'] as const) {
    it(
      `[surface:product-page-what-it-syncs] does not move when the paid inputs load the ${world} record types`,
      async () => {
        expect(await whatItSyncsOrder(world)).toEqual(SYNC_OBJECT_ORDER);
      },
      DB_TIMEOUT,
    );
  }

  it(
    'sees a move when an order input changes (the comparison is not vacuous)',
    async () => {
      expect((await whatItSyncsOrder('free', true))[0]).toBe('o65');
    },
    DB_TIMEOUT,
  );
});

describe('on-page ordering firewall: related_products', () => {
  it(
    '[surface:related-products] A to Z by name whatever the case, id breaking a tie across the sixth place, six shown',
    async () => {
      expect(await relatedOrder('free')).toEqual(RELATED_ORDER);
    },
    DB_TIMEOUT,
  );

  for (const world of ['last', 'first'] as const) {
    it(
      `[surface:related-products] neither the order nor the six shown move when the paid inputs load the ${world} products`,
      async () => {
        expect(await relatedOrder(world)).toEqual(RELATED_ORDER);
      },
      DB_TIMEOUT,
    );
  }

  it(
    'sees a move when an order input changes (the comparison is not vacuous)',
    async () => {
      expect((await relatedOrder('free', true))[0]).toBe(u(9));
    },
    DB_TIMEOUT,
  );
});

// ─── The empty pair page's closest matches (AECI-1829, AECI-341) ───────────────

const alternativesRoute: Route = {
  path: '/api/products/:slug/integrations/:otherSlug/alternatives',
  url: '/api/products/page/integrations/swapped/alternatives',
  handler: (t) => createPairAlternativesHandler(t.factory),
};

/** Every candidate is a match: an integration with the page product, the shared category. */
const MATCHES_ORDER = Object.entries(RELATED_NAME)
  .sort(([an, a], [bn, b]) => compareText(a, b) || Number(an) - Number(bn))
  .map(([n]) => u(Number(n)));

/**
 * The page product (kept), the swapped product, and the nine named candidates, each with
 * an integration to the page product and the swapped product's category. The paid
 * worlds load the Managed profile and both companies' confirmations onto three of them.
 */
async function seedMatches(db: Db, world: World, renameLast = false) {
  await db
    .insert(taxonomyCategories)
    .values({ id: u(21), slug: 'field', name: 'Field', displayOrder: 1 });
  await seedFacetTerms(db);
  await db.insert(products).values([
    { id: u(1), slug: 'page', name: 'Page', promotionStatus: 'promoted' },
    { id: u(11), slug: 'swapped', name: 'Swapped', promotionStatus: 'promoted' },
    ...Object.entries(RELATED_NAME).map(([n, name]) => ({
      id: u(Number(n)),
      slug: `p${n}`,
      name: renameLast && n === '9' ? 'Aardvark' : name,
      promotionStatus: 'promoted' as const,
    })),
  ]);
  await db
    .insert(productCategories)
    .values([2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => ({ productId: u(n), categoryId: u(21) })));
  await db.insert(taxonomyDataObjects).values({ id: u(71), slug: 'invoices', name: 'Invoices' });
  for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    await db.insert(integrations).values({
      id: u(200 + n),
      name: `P${n} to Page`,
      sourceProductId: u(n),
      targetProductId: u(1),
      mechanismKind: 'native',
      direction: 'both',
    });
    await db.insert(claims).values({
      id: u(300 + n),
      integrationId: u(200 + n),
      dataObjectId: u(71),
      direction: 'both',
    });
  }
  if (world === 'free') return;

  await seedTwoVendors(db);
  for (const n of RELATED_LOADED[world]) {
    const vendorId = n % 2 === 0 ? GLOBEX : ACME;
    await db.insert(productVendors).values({ productId: u(n), vendorId, isPrimary: true });
    await giveManagedProfile(db, u(n), vendorId, n);
    await db.insert(attestations).values([
      {
        id: u(400 + n),
        claimId: u(300 + n),
        source: 'vendor_a',
        asserted: true,
        attestedByVendorId: vendorId,
      },
      {
        id: u(500 + n),
        claimId: u(300 + n),
        source: 'vendor_b',
        asserted: true,
        attestedByVendorId: vendorId,
      },
    ]);
  }
}

async function matchesOrder(world: World, renameLast = false) {
  const body = PairAlternativesSchema.parse(
    await readWorld((db) => seedMatches(db, world, renameLast), alternativesRoute),
  );
  return body.lanes.context.matches.map((m) => m.product.id);
}

describe('on-page ordering firewall: the empty pair page closest matches', () => {
  it(
    '[surface:pair-page-closest-matches] A to Z by name (compareText: a letter before case), id breaking a tie, none cut',
    async () => {
      expect(await matchesOrder('free')).toEqual(MATCHES_ORDER);
    },
    DB_TIMEOUT,
  );

  for (const world of ['last', 'first'] as const) {
    it(
      `[surface:pair-page-closest-matches] neither the order nor the set moves when the paid inputs load the ${world} matches`,
      async () => {
        expect(await matchesOrder(world)).toEqual(MATCHES_ORDER);
      },
      DB_TIMEOUT,
    );
  }

  it(
    'sees a move when an order input changes (the comparison is not vacuous)',
    async () => {
      expect((await matchesOrder('free', true))[0]).toBe(u(9));
    },
    DB_TIMEOUT,
  );
});

// ─── 6. The taxonomy term-count exception ─────────────────────────────────────

const webSource = (rel: string) => stripComments(readFileSync(join(WEB_APP, rel), 'utf8'));
const FACETS = ['categories', 'audiences', 'phases', 'trades'] as const;

/** The wire field a facet's slugs are written through. */
const FACET_FIELD = {
  categories: 'category_slugs',
  audiences: 'audience_slugs',
  phases: 'phase_slugs',
  trades: 'trade_slugs',
} as const;

const siteKey = (s: CountSite) =>
  `${s.file} | ${s.kind} | ${s.facet}${s.detail ? ` | ${s.detail}` : ''}`;
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

const COMPARISON = '(?:>=|<=|===|!==|>|<)';

/** The operator console, the vendor portal and design previews: not public pages. */
const PRIVATE_AREAS = /^(admin|vendor|preview)\//;

/** The argument text of every `.sort(` and `.toSorted(` call, parentheses balanced. */
function sortCallArgs(src: string): string[] {
  const args: string[] = [];
  for (const m of src.matchAll(/\.(?:sort|toSorted)\(/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') depth -= 1;
      i += 1;
    }
    args.push(src.slice(start, i - 1));
  }
  return args;
}

/** A count read: `x.product_count`, `x.count`, or the `topByCount` sort key. */
const COUNT_READ = /\b\w+\.(?:product_count|count)\b|\[SORT_KEY\]/g;

/** Each sort call that reads a count, as the reads it makes. */
const countSorts = (src: string) =>
  sortCallArgs(src)
    .map((arg) => [...arg.matchAll(COUNT_READ)].map((m) => m[0]).join(', '))
    .filter((reads) => reads !== '');

/** Each subtraction of one count from another, anywhere: a comparator, inline or in a helper. */
const countCompares = (src: string) =>
  [...src.matchAll(/\b\w+\.(product_count|count)\s*-\s*\w+\.\1\b/g)].map((m) => collapse(m[0]));

/**
 * Every place the browser orders or cuts terms by a count, found from source with
 * comments removed. A tripwire, not a proof: a count reached without naming
 * `product_count`, `.count` or `SORT_KEY` (a destructured field, a computed key, a
 * helper called with the whole term) would pass unseen.
 *
 *  - a `topByCount(` call, its facet read off the line (`unknown` fails);
 *  - any count read inside a `.sort(` or `.toSorted(` call, a helper's arguments
 *    included, and any subtraction of one count from another, over any number of lines;
 *  - a `product_count` compared with a number anywhere, and a `.filter` that compares
 *    an item's `.count` with a number;
 *  - a use of the trade publish floor;
 *  - each `/search` refinement list, whose order Algolia sets by count.
 */
function discoverCountSites(): CountSite[] {
  const sites: CountSite[] = [];
  for (const file of sourceFiles(WEB_APP).filter((rel) => !PRIVATE_AREAS.test(rel))) {
    const src = webSource(file);
    for (const line of src.split('\n')) {
      if (/\btopByCount\(/.test(line) && !/function topByCount\(/.test(line)) {
        const facet = FACETS.find((f) => new RegExp(`\\b${f}\\b`).test(line)) ?? 'unknown';
        sites.push({ file, kind: 'top-by-count', facet: facet as CountSite['facet'] });
      }
      if (/isPublishedTrade[()]/.test(line) && !/function isPublishedTrade/.test(line)) {
        sites.push({ file, kind: 'publish-floor', facet: 'trades' });
      }
    }
    for (const reads of countSorts(src)) {
      sites.push({ file, kind: 'count-sort', facet: '*', detail: reads });
    }
    for (const compare of countCompares(src)) {
      sites.push({ file, kind: 'count-compare', facet: '*', detail: compare });
    }
    for (const m of src.matchAll(
      new RegExp(`\\b[\\w.]*product_count\\s*${COMPARISON}\\s*\\d+`, 'g'),
    )) {
      sites.push({ file, kind: 'count-cut', facet: '*', detail: collapse(m[0]) });
    }
    const filterCut = new RegExp(
      `\\.filter\\(\\s*\\(?(\\w+)\\)?\\s*=>[^;]*?\\b(\\1\\.count\\s*${COMPARISON}\\s*\\d+)`,
      'g',
    );
    for (const m of src.matchAll(filterCut)) {
      sites.push({ file, kind: 'count-cut', facet: '*', detail: collapse(m[2]!) });
    }
  }
  const lists = webSource('search/search-controller.ts').match(/refinementLists:\s*\[([^\]]*)\]/);
  for (const m of (lists?.[1] ?? '').matchAll(/'([a-z_]+)'/g)) {
    sites.push({
      file: 'search/search-controller.ts',
      kind: 'algolia-facet',
      facet: m[1] as CountSite['facet'],
    });
  }
  return sites;
}

const exception = SURFACES.find(
  (s): s is Extract<Surface, { status: 'exception' }> => s.status === 'exception',
)!;

describe('on-page ordering firewall: the taxonomy term-count exception', () => {
  it('[surface:taxonomy-term-product-count] is tolerated only at the sites it names, and every count site found is registered', () => {
    const found = discoverCountSites().map(siteKey).sort();
    const allowed = [
      ...exception.sites,
      ...exception.indexing,
      ...FREE_COUNT_SITES,
      ...CONNECTOR_KIND_COUNT_SITES,
      ...DISPLAY_COUNT_SITES,
    ]
      .map(siteKey)
      .sort();
    expect(found).toEqual(allowed);
  });

  it('the scan sees a comparator split over lines, a helper, a .count sort and a new floor', () => {
    expect(countCompares('list.sort((a, b) =>\n  b.product_count -\n  a.product_count)')).toEqual([
      'b.product_count - a.product_count',
    ]);
    expect(countSorts('terms.sort((a, b) => byCount(a.product_count, b.product_count))')).toEqual([
      'a.product_count, b.product_count',
    ]);
    expect(
      countSorts('items.filter((i) => i.count > 0).sort((a, b) => b.count - a.count)'),
    ).toEqual(['b.count, a.count']);
    const floor = 'terms.filter((t) => t.product_count >= 3)';
    expect(
      floor.match(new RegExp(`\\b[\\w.]*product_count\\s*${COMPARISON}\\s*\\d+`)),
    ).not.toBeNull();
  });

  it('every tolerated site orders by the one capability the entry names, which is still Managed-only', () => {
    for (const site of [...exception.sites, ...exception.indexing]) {
      // `connector_kind` sites live in their own list (AECI-1662), never in this exception.
      if (site.facet === '*' || site.facet === 'vendor_name' || site.facet === 'connector_kind')
        continue;
      expect(PRODUCT_FIELD_CAPABILITIES[FACET_FIELD[site.facet]], siteKey(site)).toBe(
        exception.capability,
      );
    }
    // If AECI-1836 frees the capability, this fails: retire the entry.
    expect(MANAGED_ONLY).toContain(exception.capability);
    expect(exception.ruling).toMatch(/^accepted by Chris 2026-11-14/);
    expect(exception.followUp).toBe('AECI-1836');
  });

  it('every count site outside the exception reads a Free input', () => {
    for (const site of FREE_COUNT_SITES) {
      if (site.facet === 'categories') {
        expect(FREE.has(PRODUCT_FIELD_CAPABILITIES.category_slugs), siteKey(site)).toBe(true);
      } else if (site.facet === 'phases') {
        // /search re-sorts phases into lifecycle order, so the count never orders them.
        // The browser half asserts the behaviour; this pins the branch.
        expect(webSource('search/search-facet-order.ts')).toMatch(/attribute !== 'phases'/);
      } else {
        // Products per vendor: promote and the product create (block 3).
        expect(site.facet).toBe('vendor_name');
      }
    }
  });

  it('the connector type filter reads an admin-set input in a fixed order', () => {
    expect(PRODUCT_FIELD_CAPABILITIES).not.toHaveProperty('connector_kind');
    // /search: the kinds re-sorted into vocabulary order before any count is read.
    expect(webSource('search/search-facet-order.ts')).toMatch(
      /attribute === 'connector_kind'[\s\S]*?kinds\.indexOf\(a\.value\) - kinds\.indexOf\(b\.value\)/,
    );
    // /products and browse: the API emits the kinds in vocabulary order, and the
    // sidebar maps them without a sort.
    expect(readFileSync(join(API_SRC, 'routes', 'product-facets.ts'), 'utf8')).toMatch(
      /connector_kinds: CONNECTOR_KINDS\.map\(/,
    );
    expect(webSource('shared/facets/facet-sidebar.ts')).toMatch(
      /\(facets\.connector_kinds \?\? \[\]\)\s*\.map\([\s\S]*?\}\)\)\s*\.filter\(\(item\) => item\.count > 0 \|\| item\.isRefined\);/,
    );
  });
});

// ─── 7. The registry scan (AECI-1841) ─────────────────────────────────────────

/**
 * A tripwire, not a proof. Blocks 1 to 6 prove that each REGISTERED order ignores a
 * Managed-only input. Nothing there fails when an order ships without being
 * registered, because the registry is hand-written. This block closes that gap by
 * counting the ordering tokens in the public read paths and checking the count of
 * every file against `ORDER_SITES`. A new `orderBy`, `.sort(` or `.toSorted(` in a
 * scanned file, or a new file with one, fails until someone adds the entry, which
 * means registering the surface (`SURFACES`) or stating why it is allowed.
 *
 * It sees tokens, not meaning. A comparator reached without one of them (a hand-
 * rolled loop, a `reduce`), or a file outside the scan set, passes. The behavioural
 * cases in blocks 4 and 5 and in the web specs stay the proof.
 *
 * Scan set:
 *  - `apps/api/src/routes/`, minus the write, auth, admin, vendor and ops routes in
 *    `OUT_OF_SCOPE_ROUTE`.
 *  - The API `lib/` files in `PUBLIC_READ_LIB`: the read configs, sort resolvers and
 *    mappers the public routes call. A new `lib/` file is NOT scanned until it is
 *    added there.
 *  - `apps/web/src/app/`, minus the signed-in and preview areas in `OUT_OF_SCOPE_WEB`.
 */

const ORDER_TOKENS =
  /\borderBy\b|(?<!\bidx)(?<!\bthis)\.sort\(|\.toSorted\(|\bfunction\s+resolve\w*(?:OrderBy|Sort)\b/g;

/** How many ordering tokens one source file holds, comments excluded. */
function countOrderTokens(source: string): number {
  return (stripComments(source).match(ORDER_TOKENS) ?? []).length;
}

/** Not a public read: writes, auth, the admin console, the vendor portal, ops. */
const OUT_OF_SCOPE_ROUTE =
  /^(admin-|vendor|account|promote|internal-|webhooks|landing-forms|listing-requests|request|seat-invites|notification-preferences|auth-|page-views|activity-arrival|health|version|logos)/;

/** Signed-in, preview and dev areas of the web app. Not public pages. */
const OUT_OF_SCOPE_WEB =
  /^(admin|vendor|account|preview|dev|demo|welcome|auth|unsubscribe|notifications)\//;

const PUBLIC_READ_LIB = [
  'drizzle-helpers',
  'sort',
  'home-stats',
  'usefulness-order',
  'taxonomy-order',
  'field-captions',
  'owned-integrations',
  'sitemap-build',
  // AECI-818 moved the sitemap's reads here. `sitemap-build` stays listed so an
  // order added back to it is still caught.
  'catalog-urls',
  'display-order',
  'pair-redirect',
  'slug-redirect',
  'review-updates',
  'review-responses',
  'product-extensions',
  'field-hides',
  'listing-hide',
  'pair-mechanism-order',
  'what-it-syncs',
];

interface OrderSite {
  /** Repo-relative path. */
  readonly file: string;
  /** Ordering tokens in the file, comments excluded. A change here is the tripwire. */
  readonly count: number;
  /** `SURFACES` keys for the orders the file builds that are registered. */
  readonly registered?: readonly string[];
  /** Why the rest are allowed. Required when any order in the file is not registered. */
  readonly allowed?: string;
}

const NEVER_PLAN = 'reads no plan input';

/** Every ordering token in the scan set, classified once. */
const ORDER_SITES: readonly OrderSite[] = [
  {
    file: 'apps/api/src/routes/integrations.ts',
    count: 6,
    registered: ['pair-page-mechanisms'],
    allowed: `the public ?sort=name|created key on GET /api/integrations; the sort-key firewall covers it, and ${NEVER_PLAN}`,
  },
  {
    file: 'apps/api/src/routes/product-facets.ts',
    count: 4,
    allowed: `facet term lists, A to Z by name or display_order; ${NEVER_PLAN}`,
  },
  {
    file: 'apps/api/src/routes/product-reviews.ts',
    count: 1,
    allowed: `reviews newest first, id breaking a tie; ${NEVER_PLAN}`,
  },
  {
    file: 'apps/api/src/routes/products.ts',
    count: 5,
    registered: ['related-products'],
    allowed: `the public ?sort= key on GET /api/products and reviews newest first; ${NEVER_PLAN}`,
  },
  {
    file: 'apps/api/src/routes/taxonomy-list.ts',
    count: 4,
    allowed: `taxonomy term lists, display_order or A to Z by name; ${NEVER_PLAN}`,
  },
  {
    file: 'apps/api/src/routes/taxonomy.ts',
    count: 4,
    allowed: `taxonomy term lists, display_order or A to Z by name; ${NEVER_PLAN}`,
  },
  {
    // QA pass on AECI-2035: 18 to 17, the powered rows' endpoint categories are gone.
    file: 'apps/api/src/lib/drizzle-helpers.ts',
    count: 17,
    registered: ['pair-page-claims', 'pair-page-closest-matches'],
    allowed: `term lists by display_order or name, attestation timelines by created_at, vendor products A to Z; ${NEVER_PLAN}`,
  },
  {
    file: 'apps/api/src/lib/sort.ts',
    count: 8,
    allowed: `the sort resolvers behind the public ?sort= keys; the sort-key firewall covers them. The two admin resolvers are not public`,
  },
  {
    file: 'apps/api/src/lib/home-stats.ts',
    count: 3,
    allowed: `home page lists by integration_count, page views and created_at; these inputs are written by promote and page views, never by a plan check (block 3)`,
  },
  {
    file: 'apps/api/src/lib/usefulness-order.ts',
    count: 2,
    allowed: `audiences A to Z by name, phases by display_order; ${NEVER_PLAN}`,
  },
  {
    file: 'apps/api/src/lib/field-captions.ts',
    count: 4,
    // AECI-2139: the data flow correction lines, by date then source, for byte-stable HTML.
    allowed: `caption attribution names A to Z, a stable field order and data flow corrections by date; ${NEVER_PLAN}`,
  },
  {
    file: 'apps/api/src/lib/owned-integrations.ts',
    count: 1,
    allowed: `the owned-integrations list, A to Z by partner names then id; ${NEVER_PLAN}`,
  },
  {
    // AECI-818: the sitemap's four reads moved here from `sitemap-build.ts`, which now
    // only renders them. Products and vendors by id, pairs by their two slugs,
    // taxonomy terms by facet then id. The admin search console reads the same list
    // and re-sorts it by publish date, in `seo-queue.ts`, which is admin-only.
    file: 'apps/api/src/lib/catalog-urls.ts',
    count: 4,
    allowed: `sitemap URL order by id, pair slugs or facet; a crawl feed, not an on-page list, and ${NEVER_PLAN}`,
  },
  {
    file: 'apps/api/src/lib/pair-mechanism-order.ts',
    count: 1,
    registered: ['pair-page-mechanisms'],
  },
  {
    file: 'apps/api/src/lib/what-it-syncs.ts',
    count: 1,
    registered: ['product-page-what-it-syncs'],
  },
  {
    file: 'apps/api/src/lib/pair-redirect.ts',
    count: 2,
    allowed: 'redirect target lookup by latest move; a redirect, not an on-page list',
  },
  {
    file: 'apps/api/src/lib/slug-redirect.ts',
    count: 1,
    allowed: 'redirect table load keyed by slug; a redirect, not an on-page list',
  },
  {
    file: 'apps/api/src/lib/review-updates.ts',
    count: 2,
    allowed: `review updates oldest first by created_at or published_at; ${NEVER_PLAN}`,
  },
  {
    file: 'apps/api/src/lib/review-responses.ts',
    count: 1,
    allowed: `vendor replies oldest first by published_at; ${NEVER_PLAN}`,
  },
  {
    file: 'apps/api/src/lib/product-extensions.ts',
    count: 3,
    allowed: `extension and host products A to Z by name then id; ${NEVER_PLAN}`,
  },
  {
    file: 'apps/api/src/lib/field-hides.ts',
    count: 2,
    allowed: 'hide records by set time and a stable id order; internal, not an on-page list',
  },
  {
    file: 'apps/api/src/lib/listing-hide.ts',
    count: 10,
    allowed: 'sets of ids ordered for a stable write; internal, not an on-page list',
  },
  {
    file: 'apps/web/src/app/core/meta.helpers.ts',
    count: 2,
    allowed: 'meta description names A to Z; text in a tag, not a ranked list',
  },
  {
    file: 'apps/web/src/app/core/route-cache-key.ts',
    count: 2,
    allowed: 'cache key normalisation of query params; not an on-page list',
  },
  {
    file: 'apps/web/src/app/core/taxonomy/browse-menu-model.ts',
    count: 1,
    registered: ['browse-menu-term-order'],
  },
  {
    file: 'apps/web/src/app/core/taxonomy/taxonomy-rank.ts',
    count: 2,
    registered: ['taxonomy-term-product-count'],
    allowed: 'terms by display_order then A to Z by name',
  },
  {
    file: 'apps/web/src/app/docs/docs-content.ts',
    count: 2,
    allowed: 'help center pages and sections in authored order; static content',
  },
  {
    file: 'apps/web/src/app/products/connector-lane-grouping.ts',
    count: 3,
    registered: ['product-integrations-direct-lane', 'product-integrations-via-groups'],
  },
  {
    // AECI-1782: the filter panel's term chips, A to Z by name with the slug last.
    file: 'apps/web/src/app/products/integration-filter.ts',
    count: 1,
    registered: ['product-page-integrations-redesign'],
  },
  {
    // AECI-2018: the wheel's products A to Z, and its category slides A to Z. QA pass on
    // AECI-2035: a connector's wheel, the products its pairs reach A to Z (the third).
    file: 'apps/web/src/app/products/integration-wheel.ts',
    count: 3,
    registered: ['product-page-hero-wheel'],
  },
  {
    file: 'apps/web/src/app/products/powered-hub-grouping.ts',
    count: 3,
    registered: ['connector-powered-hub'],
  },
  {
    file: 'apps/web/src/app/requests/company-country-field.ts',
    count: 1,
    allowed: 'country names A to Z in a form control; not a ranked list',
  },
  {
    file: 'apps/web/src/app/search/search-facet-order.ts',
    count: 3,
    registered: ['taxonomy-term-product-count'],
    allowed:
      'lifecycle order for phases on /search; a checked value Algolia left out, placed by the same compareFacetValues (AECI-1899); the connector type options in vocabulary order whatever the counts, an admin-set input no plan writes (AECI-1662)',
  },
  {
    file: 'apps/web/src/app/search/search-url-state.ts',
    count: 1,
    allowed: 'filter values sorted so one filter set has one URL; not an on-page list',
  },
  {
    file: 'apps/web/src/app/shared/facets/facet-sidebar.ts',
    count: 1,
    registered: ['taxonomy-term-product-count'],
    allowed: 'selected ids sorted into a change key',
  },
  {
    file: 'apps/web/src/app/shared/paginated-index/paginated-index-controller.ts',
    count: 2,
    allowed: 'query keys and loaded pages kept in page order; not a ranking',
  },
  {
    file: 'apps/web/src/app/taxonomy/taxonomy-index.ts',
    count: 2,
    registered: ['taxonomy-term-product-count'],
    allowed: 'the A to Z sort of the same list',
  },
];

/** Repo-relative path of every file the scan reads. */
function scannedFiles(): string[] {
  const routes = sourceFiles(join(API_SRC, 'routes'))
    .filter((f) => !OUT_OF_SCOPE_ROUTE.test(f))
    .map((f) => `apps/api/src/routes/${f}`);
  const lib = PUBLIC_READ_LIB.map((n) => `apps/api/src/lib/${n}.ts`);
  const web = sourceFiles(WEB_APP)
    .filter((f) => !OUT_OF_SCOPE_WEB.test(f))
    .map((f) => `apps/web/src/app/${f}`);
  return [...routes, ...lib, ...web];
}

const readRepo = (file: string) => readFileSync(join(process.cwd(), '..', '..', file), 'utf8');

describe('on-page ordering firewall: the registry scan (a tripwire, not a proof)', () => {
  it('every ordering token in the public read paths is classified', () => {
    const actual = Object.fromEntries(
      scannedFiles()
        .map((f) => [f, countOrderTokens(readRepo(f))] as const)
        .filter(([, n]) => n > 0),
    );
    const expected = Object.fromEntries(ORDER_SITES.map((s) => [s.file, s.count]));
    // A failure here means an order was added, removed or moved. Register the
    // surface in SURFACES with a test, or add an ORDER_SITES entry that says why
    // it is allowed. Do not just bump the number.
    expect(actual).toEqual(expected);
  });

  it('every entry is classified: registered with a real surface key, or allowed with a reason', () => {
    const keys = new Set(SURFACES.map((s) => s.key));
    for (const site of ORDER_SITES) {
      expect(site.registered || site.allowed, site.file).toBeTruthy();
      for (const key of site.registered ?? [])
        expect(keys.has(key), `${site.file}: ${key}`).toBe(true);
      if (site.allowed) expect(site.allowed.length, site.file).toBeGreaterThanOrEqual(12);
    }
  });

  it('lists each file once, and every file it lists is in the scan set', () => {
    const files = ORDER_SITES.map((s) => s.file);
    expect(new Set(files).size).toBe(files.length);
    const scanned = new Set(scannedFiles());
    for (const file of files) expect(scanned.has(file), file).toBe(true);
  });

  // The control. Without it a scan that matches nothing would pass every case above.
  it('the counter catches a planted order and ignores comments and signal reads', () => {
    const clean = 'const a = db.select().from(t);\n';
    expect(countOrderTokens(clean)).toBe(0);
    expect(countOrderTokens(`${clean}db.query.t.findMany({ orderBy: [asc(t.id)] });`)).toBe(1);
    expect(countOrderTokens(`${clean}rows.sort((a, b) => a - b);`)).toBe(1);
    expect(countOrderTokens(`${clean}rows.toSorted();`)).toBe(1);
    expect(countOrderTokens(`${clean}export function resolveFooOrderBy() {}`)).toBe(1);
    expect(countOrderTokens(`${clean}// rows.sort(x) and orderBy\n/* .toSorted( */`)).toBe(0);
    expect(countOrderTokens(`${clean}if (this.idx.sort() === 'created') {}`)).toBe(0);
  });
});
