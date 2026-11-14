/**
 * The on-page ordering firewall (AECI-1814, `STAGE_2_PAID_TIERS_SPEC.md` §3.2 assertion
 * 8; ruling R1 on AECI-1732).
 *
 * The Terms say ranking is "never influenced by payment". The other firewall tests
 * cover search attributes, sort keys and `listing_tier` inputs. This one covers the
 * order of lists on a page: no on-page sort, default order or featured subset may read
 * an input that only a capability outside the Free set can change.
 *
 * Ruling R1 (Chris, 2026-11-14): "Maintain orders as they are. If its a new feature a
 * to z". Applied:
 *
 *  1. Every NEW on-page list is A to Z by name, with id as the tie-break.
 *  2. The via-lane groups and the powered-hub groups keep their count order.
 *  3. The pair page keeps integrations first, then evidenced pairs.
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

import { ProductDetailSchema, ProductPairResponseSchema } from '@aeci/shared';
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
import { createProductPairHandler } from '../routes/integrations';
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
  readonly facet: 'categories' | 'audiences' | 'phases' | 'trades' | 'vendor_name' | '*';
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
    order: 'Partner count, then hub name (kept under R1); partners and flat pairs A to Z',
  },
  {
    key: 'pair-page-mechanisms',
    status: 'covered',
    spec: 'api',
    order: 'Integrations A to Z by name then id, then evidenced pairs A to Z by name then id',
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
    order: 'Newest first, id breaking a tie, 6 shown; membership by shared category',
  },
  {
    key: 'pair-page-closest-matches',
    status: 'pending',
    owner: 'AECI-1829',
    order: 'New list: A to Z by name, id tie-break (R1)',
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
    status: 'pending',
    owner: 'AECI-1782',
    order: 'New list: A to Z by name, id tie-break (R1); long lists in AECI-1783',
  },
  {
    key: 'product-page-hero-visual',
    status: 'pending',
    owner: 'AECI-1787',
    order: 'Any featured subset reads no Managed-only input',
  },
  {
    key: 'product-page-similar-products',
    status: 'pending',
    owner: 'AECI-1785',
    order: 'Renders related_products in an order per R1',
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
  // The home hero's fallback row (`home-hero.ts`).
  { file: 'core/taxonomy/taxonomy-nav.store.ts', kind: 'top-by-count', facet: 'categories' },
  { file: 'home/home.ts', kind: 'top-by-count', facet: 'categories' },
  { file: 'search/search-controller.ts', kind: 'algolia-facet', facet: 'categories' },
  { file: 'search/search-controller.ts', kind: 'algolia-facet', facet: 'phases' },
  { file: 'search/search-controller.ts', kind: 'algolia-facet', facet: 'vendor_name' },
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
  // The attestation and product-version writes (`STAGE_2_PAID_TIERS_SPEC.md` §3.3(a)).
  'attestation.author': [
    'claim agreement ("confirmed by both companies")',
    'a denial, which can refute a claim and so lower the data-flow count',
    'vendor-added data objects, so a higher data-flow count',
    'the deletion or withdrawal of a vendor-added data object, so a lower count',
    'product versions and the version stamps on a claim',
    'the integration maintenance stamps an attestation write moves',
  ],
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
      'attestation.author',
      'analytics.view',
      'integration.version_diff',
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
    // Category membership, and `created_at`, which no vendor writes.
    expect(FREE.has(PRODUCT_FIELD_CAPABILITIES.category_slugs)).toBe(true);
    expect(Object.keys(PRODUCT_FIELD_CAPABILITIES)).not.toContain('created_at');
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
  const literalRetire = new RegExp(
    `\\.update\\(\\s*${table}\\s*\\)\\s*\\.set\\(\\s*\\{[^}]*\\bretiredAt\\b`,
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
  'routes/integration-retire-write.ts',
  'routes/promote.ts',
  'routes/vendor-integration-create.ts',
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
/** Today's order, written out: integrations A to Z then id, then evidenced pairs. */
const PAIR_ORDER = [11, 12, 13, 10, 61, 62, 60].map(u);
/**
 * What each paid world loads. `rows` sort last (or first) in their table. `claims`
 * sort last (or first) inside their mechanism. Of the two tied "Logs" claims only 103
 * is listed, so in either world it carries more votes than 102.
 */
const PAIR_LAST = { rows: [10, 13, 60, 62], claims: [100, 103, 105, 106, 107, 109] };
const PAIR_FIRST = { rows: [11, 12, 61], claims: [101, 104, 108] };

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
  ]);
  await seedTwoVendors(db);
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
 * The page product and nine candidates sharing its category. Four share one
 * `created_at` across the sixth-place boundary, as promote writes them in bulk: p4,
 * p5 and p6 show, p7 does not, on the id tie-break alone.
 */
const CREATED_DAY: Readonly<Record<number, number>> = {
  2: 2,
  3: 3,
  4: 6,
  5: 6,
  6: 6,
  7: 6,
  8: 8,
  9: 9,
  10: 10,
};
const RELATED_ORDER = [10, 9, 8, 4, 5, 6].map(u);
/** `last` loads the products just outside the six (p7 inside the tie); `first` the ones inside. */
const RELATED_LOADED: Readonly<Record<Exclude<World, 'free'>, number[]>> = {
  last: [7, 3, 2],
  first: [10, 4, 5],
};

async function seedRelated(db: Db, world: World, bumpOldest = false) {
  const at = (day: number) => `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`;
  await db
    .insert(taxonomyCategories)
    .values({ id: u(21), slug: 'field', name: 'Field', displayOrder: 1 });
  await seedFacetTerms(db);
  await db.insert(products).values([
    { id: u(1), slug: 'page', name: 'Page', promotionStatus: 'promoted', createdAt: at(1) },
    ...Object.entries(CREATED_DAY).map(([n, day]) => ({
      id: u(Number(n)),
      slug: `p${n}`,
      name: `P${n}`,
      promotionStatus: 'promoted' as const,
      createdAt: bumpOldest && n === '2' ? at(28) : at(day),
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

async function relatedOrder(world: World, bumpOldest = false) {
  const body = ProductDetailSchema.parse(
    await readWorld((db) => seedRelated(db, world, bumpOldest), detailRoute),
  );
  return body.related_products.map((p) => p.id);
}

describe('on-page ordering firewall: related_products', () => {
  it(
    '[surface:related-products] newest first, id breaking a tie across the sixth place, six shown',
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
      expect((await relatedOrder('free', true))[0]).toBe(u(2));
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
      if (site.facet === '*' || site.facet === 'vendor_name') continue;
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
});
