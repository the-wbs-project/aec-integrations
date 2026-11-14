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
 *  1. The registry of every ordered surface (`SURFACES`): covered here, covered in the
 *     browser half (`apps/web/src/app/products/on-page-ordering-firewall.spec.ts`),
 *     pending with the issue that will build it, or the one tolerated exception.
 *  2. The Managed-only inputs, derived from the capability registry.
 *  3. Why the count orders pass: every write that changes an integration row count is
 *     capability-free. Promote is AECi's; the rest need a seat and nothing else.
 *  4. The pair page, behaviourally, over the in-memory D1 harness.
 *  5. `related_products`, behaviourally.
 *  6. The taxonomy term-count exception, kept narrow by a source scan.
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
import { eq } from 'drizzle-orm';
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
const WEB_SPEC = join(WEB_APP, 'products', 'on-page-ordering-firewall.spec.ts');
const THIS_SPEC = join(API_SRC, 'lib', 'on-page-ordering-firewall.spec.ts');

// ─── 1. The registry ──────────────────────────────────────────────────────────

/** One site that orders or cuts taxonomy terms by count: a file, how, which facet. */
interface CountSite {
  readonly file: string;
  readonly kind: 'top-by-count' | 'count-comparator' | 'publish-floor' | 'algolia-facet';
  /** `*` when one comparator serves every facet. */
  readonly facet: 'categories' | 'audiences' | 'phases' | 'trades' | 'vendor_name' | '*';
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
      readonly sites: readonly CountSite[];
      readonly reason: string;
      readonly ruling: string;
    };

/**
 * Every ordered list on a public page. A pending entry names the issue that builds the
 * surface: that issue moves it to `covered` and adds its case. The exception is ONE
 * entry, so Chris's ruling changes one place.
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
    order: 'Data object display order, then data object name',
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
    status: 'pending',
    owner: 'AECI-1774',
    order: 'Inherits the taxonomy-term-product-count ruling for its term order',
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
      'Nav flyouts: audiences and trades top 10 by product count; trades behind the publish floor',
      'Home: trades top 10 by product count, behind the publish floor',
      '/search: audience and trade facet values in Algolia count order',
      '/audiences, /phases, /trades: the reader-chosen "Most products" sort; /trades behind the floor',
      '/trades/:slug: noindex below the publish floor',
    ],
    sites: [
      { file: 'core/taxonomy/taxonomy-nav.store.ts', kind: 'top-by-count', facet: 'audiences' },
      { file: 'core/taxonomy/taxonomy-nav.store.ts', kind: 'top-by-count', facet: 'trades' },
      { file: 'core/taxonomy/taxonomy-nav.store.ts', kind: 'publish-floor', facet: 'trades' },
      { file: 'home/home.ts', kind: 'top-by-count', facet: 'trades' },
      { file: 'home/home.ts', kind: 'publish-floor', facet: 'trades' },
      { file: 'search/search-controller.ts', kind: 'algolia-facet', facet: 'audiences' },
      { file: 'search/search-controller.ts', kind: 'algolia-facet', facet: 'trades' },
      { file: 'taxonomy/taxonomy-index.ts', kind: 'count-comparator', facet: '*' },
      { file: 'taxonomy/taxonomy-index.ts', kind: 'publish-floor', facet: 'trades' },
      { file: 'taxonomy/taxonomy-browse.resolver.ts', kind: 'publish-floor', facet: 'trades' },
    ],
    reason: 'orders terms, not vendors; existing order kept under R1',
    ruling: 'awaiting ruling (Slack 2026-11-14)',
  },
];

/**
 * Count orders over an input no plan gates. Categories are Free
 * (`product.categories.edit`). Phases on `/search` are re-sorted into lifecycle order,
 * so their counts never order them. The vendor facet counts products per vendor,
 * which promote and the seat-gated product create write (block 3).
 */
const FREE_COUNT_SITES: readonly CountSite[] = [
  { file: 'core/taxonomy/taxonomy-nav.store.ts', kind: 'top-by-count', facet: 'categories' },
  { file: 'home/home.ts', kind: 'top-by-count', facet: 'categories' },
  { file: 'search/search-controller.ts', kind: 'algolia-facet', facet: 'categories' },
  { file: 'search/search-controller.ts', kind: 'algolia-facet', facet: 'phases' },
  { file: 'search/search-controller.ts', kind: 'algolia-facet', facet: 'vendor_name' },
];

const surfaceTags = (file: string): string[] =>
  [...readFileSync(file, 'utf8').matchAll(/\[surface:([a-z0-9-]+)\]/g)].map((m) => m[1]!);

describe('on-page ordering firewall: the surface registry', () => {
  it('every covered surface has a test tagged with its key, in the spec it names', () => {
    const tags = { api: surfaceTags(THIS_SPEC), web: surfaceTags(WEB_SPEC) };
    for (const surface of SURFACES) {
      if (surface.status === 'covered') {
        expect(tags[surface.spec], surface.key).toContain(surface.key);
      }
    }
  });

  it('every surface tag names a registry entry', () => {
    const keys = SURFACES.map((s) => s.key);
    for (const tag of [...surfaceTags(THIS_SPEC), ...surfaceTags(WEB_SPEC)]) {
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
 * plan-end mirrors and edit stamps) is written by no capability: blocks 4 and 5 flip
 * it too.
 */
const ROUTE_CAPABILITY_INPUTS: Readonly<Partial<Record<Capability, readonly string[]>>> = {
  // The six attestation and product-version writes (`STAGE_2_PAID_TIERS_SPEC.md` §3.3(a)).
  'attestation.author': [
    'claim agreement ("confirmed by both companies")',
    'vendor-added data objects, so the data-flow count',
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

const apiSource = (rel: string) => readFileSync(join(API_SRC, rel), 'utf8');

/** A write that adds, removes, retires or restores an integration row. */
const ROW_COUNT_WRITE =
  /\.(insert|delete)\((integrations|connectorEvidencedPairs)\)|\.set\(\{[^}]*\bretiredAt\b/;
/** A route-level capability gate. A per-field check (`assertFieldsEntitled`) is not one. */
const CAPABILITY_GATE =
  /\b(requireCapability|requireProductCapability|requireAttestationCapability|hasCapability|capabilitiesFor)\(/;

describe('on-page ordering firewall: the via-group and powered-hub counts', () => {
  const files = sourceFiles(API_SRC);

  it('finds every write that changes an integration row count', () => {
    expect(files.filter((rel) => ROW_COUNT_WRITE.test(apiSource(rel))).sort()).toEqual([
      'routes/integration-retire-write.ts',
      'routes/promote.ts',
      'routes/vendor-integration-create.ts',
    ]);
    // The shared retire write runs from these two routes and nowhere else.
    expect(
      files
        .filter((rel) => rel !== 'routes/integration-retire-write.ts')
        .filter((rel) => /\bbuild(Pair)?RetireBatch\(/.test(apiSource(rel)))
        .sort(),
    ).toEqual(['routes/admin-integration-retire.ts', 'routes/vendor-integration-retire.ts']);
  });

  it('none of those writes, nor the edits that rename a row, consults a capability', () => {
    for (const rel of [
      'routes/integration-retire-write.ts',
      'routes/promote.ts',
      'routes/vendor-integration-create.ts',
      'routes/vendor-integration-retire.ts',
      'routes/admin-integration-retire.ts',
      'routes/vendor-integration-edits.ts',
      'routes/vendor-evidenced-pair-edits.ts',
      // The /search vendor facet counts products per vendor.
      'routes/vendor-product-create.ts',
    ]) {
      expect(CAPABILITY_GATE.test(apiSource(rel)), rel).toBe(false);
    }
    // The pattern does match a gated route, so the absence above is real.
    expect(CAPABILITY_GATE.test(apiSource('routes/vendor-attestations.ts'))).toBe(true);
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

// ─── 4. The pair page ─────────────────────────────────────────────────────────

const pairRoute: Route = {
  path: '/api/products/:slug/integrations/:otherSlug',
  url: '/api/products/procore/integrations/revit',
  handler: (t) => createProductPairHandler(t.factory),
};

interface PairOptions {
  /** Add every Managed-only input, weighted onto the rows that sort LAST. */
  readonly managed: boolean;
  /** Rename the last integration so it sorts first: the order input, for non-vacuity. */
  readonly renameLast?: boolean;
}

async function seedPair(db: Db, { managed, renameLast = false }: PairOptions) {
  await db.insert(products).values([
    { id: u(1), slug: 'procore', name: 'Procore', promotionStatus: 'promoted' },
    { id: u(2), slug: 'revit', name: 'Revit', promotionStatus: 'promoted' },
    {
      id: u(3),
      slug: 'agave',
      name: 'Agave',
      productRole: 'connector',
      promotionStatus: 'promoted',
    },
    { id: u(4), slug: 'kroo', name: 'Kroo', productRole: 'connector', promotionStatus: 'promoted' },
  ]);
  await seedTwoVendors(db);
  await db.insert(productVendors).values([
    { productId: u(1), vendorId: ACME, isPrimary: true },
    { productId: u(2), vendorId: GLOBEX, isPrimary: true },
  ]);
  await seedFacetTerms(db);
  await db.insert(taxonomyDataObjects).values([
    { id: u(71), slug: 'invoices', name: 'Invoices', displayOrder: 1 },
    { id: u(72), slug: 'rfis', name: 'RFIs', displayOrder: 2 },
    { id: u(73), slug: 'submittals', name: 'Submittals', displayOrder: 3 },
    { id: u(74), slug: 'drawings', name: 'drawings' },
  ]);

  // Mixed case on purpose: A to Z must not be case-sensitive.
  const rows: Array<[number, string]> = [
    [10, renameLast ? 'Aardvark sync' : 'Zeta sync'],
    [11, 'alpha link'],
    [12, 'Mid bridge'],
  ];
  await db.insert(integrations).values(
    rows.map(([n, name]) => ({
      id: u(n),
      name,
      sourceProductId: u(1),
      targetProductId: u(2),
      mechanismKind: 'native' as const,
      direction: 'a_to_b',
    })),
  );
  const [a, b] = [u(1), u(2)].sort();
  await db.insert(connectorEvidencedPairs).values([
    {
      id: u(60),
      name: 'Zulu',
      connectorProductId: u(3),
      productAId: a!,
      productBId: b!,
      direction: 'a_to_b',
    },
    {
      id: u(61),
      name: 'bravo',
      connectorProductId: u(4),
      productAId: a!,
      productBId: b!,
      direction: 'both',
    },
  ]);

  // The AECi seed: one or two claims per row.
  const seedClaims: Array<[id: number, table: 'i' | 'e', row: number, object: number]> = [
    [100, 'i', 10, 72],
    [101, 'i', 11, 71],
    [102, 'i', 12, 72],
    [103, 'i', 12, 71],
    [104, 'e', 60, 71],
    [105, 'e', 61, 72],
  ];
  for (const [id, table, row, object] of seedClaims) {
    await db.insert(claims).values({
      id: u(id),
      ...(table === 'i' ? { integrationId: u(row) } : { connectorEvidencedPairId: u(row) }),
      dataObjectId: u(object),
      direction: 'a_to_b',
    });
    await db
      .insert(attestations)
      .values({ id: u(id + 100), claimId: u(id), source: 'aeci', asserted: true });
  }
  if (!managed) return;

  // "Confirmed by both companies" on the row that sorts last in each table.
  for (const id of [100, 104]) {
    await db.insert(attestations).values([
      {
        id: u(id + 300),
        claimId: u(id),
        source: 'vendor_a',
        asserted: true,
        attestedByVendorId: ACME,
      },
      {
        id: u(id + 400),
        claimId: u(id),
        source: 'vendor_b',
        asserted: true,
        attestedByVendorId: GLOBEX,
      },
    ]);
  }
  // Vendor-added data objects: the most data flows on the row that sorts last.
  for (const [id, object] of [
    [110, 73],
    [111, 74],
  ] as const) {
    await db.insert(claims).values({
      id: u(id),
      integrationId: u(10),
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
    });
  }
  await db
    .update(integrations)
    .set({
      maintainedBy: 'vendor',
      lastReviewedAt: '2026-11-10T00:00:00.000Z',
      vendorEditedAt: '2026-11-10T00:00:00.000Z',
    })
    .where(eq(integrations.id, u(10)));
  await giveManagedProfile(db, u(1), ACME, 1);
  await giveManagedProfile(db, u(2), GLOBEX, 2);
}

async function pairOrder(options: PairOptions) {
  const body = ProductPairResponseSchema.parse(
    await readWorld((db) => seedPair(db, options), pairRoute),
  );
  const shared = new Set(['invoices', 'rfis']);
  return {
    mechanisms: body.mechanisms.map((m) => m.id),
    // Claim order inside each mechanism, over the AECi-seeded objects both worlds share.
    claims: body.mechanisms.map((m) =>
      m.claims.map((c) => c.data_object_slug).filter((slug) => shared.has(slug)),
    ),
    /** Every claim, by mechanism id, so a reordered world is still read row by row. */
    allClaims: Object.fromEntries(
      body.mechanisms.map((m) => [m.id, m.claims.map((c) => c.data_object_slug)]),
    ),
    confirmed: body.sync_headline.confirmed,
  };
}

describe('on-page ordering firewall: the pair page', () => {
  it('[surface:pair-page-mechanisms] follows R1: integrations A to Z, then evidenced pairs A to Z', async () => {
    const { mechanisms } = await pairOrder({ managed: false });
    const byName = (rows: Array<[string, string]>) =>
      [...rows]
        .sort(([idX, x], [idY, y]) => compareText(x, y) || idX.localeCompare(idY))
        .map(([id]) => id);
    expect(mechanisms).toEqual([
      ...byName([
        [u(10), 'Zeta sync'],
        [u(11), 'alpha link'],
        [u(12), 'Mid bridge'],
      ]),
      ...byName([
        [u(60), 'Zulu'],
        [u(61), 'bravo'],
      ]),
    ]);
    expect(mechanisms).toEqual([u(11), u(12), u(10), u(61), u(60)]);
  });

  it('[surface:pair-page-mechanisms] [surface:pair-page-claims] does not move when every Managed-only input changes', async () => {
    const free = await pairOrder({ managed: false });
    const managed = await pairOrder({ managed: true });
    // The fixture really did change what a plan buys.
    expect(managed.confirmed).toBeGreaterThan(free.confirmed);
    expect(managed.allClaims[u(10)]!.length).toBeGreaterThan(free.allClaims[u(10)]!.length);

    expect(managed.mechanisms).toEqual(free.mechanisms);
    expect(managed.claims).toEqual(free.claims);
  });

  it('[surface:pair-page-claims] orders claims by the data object vocabulary, whoever added them', async () => {
    const { allClaims } = await pairOrder({ managed: true });
    // The AECi claim (display_order 2), then the two vendor-added ones (3, then none):
    // vocabulary order, whoever added the claim.
    expect(allClaims[u(10)]).toEqual(['rfis', 'submittals', 'drawings']);
  });

  it('sees a move when an order input changes (the comparison is not vacuous)', async () => {
    const renamed = await pairOrder({ managed: false, renameLast: true });
    expect(renamed.mechanisms[0]).toBe(u(10));
  });
});

// ─── 5. related_products ──────────────────────────────────────────────────────

const detailRoute: Route = {
  path: '/api/products/:slug',
  url: '/api/products/page',
  handler: (t) => createProductDetailHandler(t.factory),
};

interface RelatedOptions {
  readonly managed: boolean;
  /** Make the oldest candidate the newest: the order input, for non-vacuity. */
  readonly bumpOldest?: boolean;
}

/**
 * The page product and nine candidates sharing its category, one created per day.
 * Six show, so the three oldest are outside the featured subset. The Managed world
 * gives exactly those three every Managed-only input, plus an integration confirmed
 * by both companies, so any order that rewarded a plan would pull them in.
 */
async function seedRelated(db: Db, { managed, bumpOldest = false }: RelatedOptions) {
  const at = (day: number) => `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`;
  await db
    .insert(taxonomyCategories)
    .values({ id: u(21), slug: 'field', name: 'Field', displayOrder: 1 });
  await seedFacetTerms(db);
  await db.insert(products).values([
    { id: u(1), slug: 'page', name: 'Page', promotionStatus: 'promoted', createdAt: at(1) },
    ...[2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({
      id: u(n),
      slug: `p${n}`,
      name: `P${n}`,
      promotionStatus: 'promoted' as const,
      createdAt: bumpOldest && n === 2 ? at(28) : at(n),
    })),
  ]);
  await db
    .insert(productCategories)
    .values([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ productId: u(n), categoryId: u(21) })));
  if (!managed) return;

  await seedTwoVendors(db);
  await db.insert(taxonomyDataObjects).values({ id: u(71), slug: 'invoices', name: 'Invoices' });
  for (const n of [2, 3, 4]) {
    const vendorId = n === 2 ? GLOBEX : ACME;
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

async function relatedOrder(options: RelatedOptions) {
  const body = ProductDetailSchema.parse(
    await readWorld((db) => seedRelated(db, options), detailRoute),
  );
  return body.related_products.map((p) => p.id);
}

describe('on-page ordering firewall: related_products', () => {
  it('[surface:related-products] newest first, id breaking a tie, six shown', async () => {
    expect(await relatedOrder({ managed: false })).toEqual([10, 9, 8, 7, 6, 5].map(u));
  });

  it('[surface:related-products] neither the order nor the six shown move when every Managed-only input changes', async () => {
    expect(await relatedOrder({ managed: true })).toEqual(await relatedOrder({ managed: false }));
  });

  it('sees a move when an order input changes (the comparison is not vacuous)', async () => {
    expect((await relatedOrder({ managed: false, bumpOldest: true }))[0]).toBe(u(2));
  });
});

// ─── 6. The taxonomy term-count exception ─────────────────────────────────────

const webSource = (rel: string) => readFileSync(join(WEB_APP, rel), 'utf8');
const FACETS = ['categories', 'audiences', 'phases', 'trades'] as const;

/** The wire field a facet's slugs are written through. */
const FACET_FIELD = {
  categories: 'category_slugs',
  audiences: 'audience_slugs',
  phases: 'phase_slugs',
  trades: 'trade_slugs',
} as const;

const siteKey = (s: CountSite) => `${s.file} | ${s.kind} | ${s.facet}`;

/**
 * Every place the browser orders or cuts taxonomy terms by `product_count`, found from
 * source: a `topByCount(` call (its facet read off the line), a `product_count`
 * subtraction comparator, a use of the trade publish floor, and each `/search`
 * refinement list (Algolia's default order is by count). A call whose facet the scan
 * cannot name is reported as `unknown` and fails.
 */
function discoverCountSites(): CountSite[] {
  const sites: CountSite[] = [];
  for (const file of sourceFiles(WEB_APP)) {
    for (const line of webSource(file).split('\n')) {
      if (/\btopByCount\(/.test(line) && !/function topByCount\(/.test(line)) {
        const facet = FACETS.find((f) => new RegExp(`\\b${f}\\b`).test(line)) ?? 'unknown';
        sites.push({ file, kind: 'top-by-count', facet: facet as CountSite['facet'] });
      }
      if (/\b\w+\.product_count\s*-\s*\w+\.product_count\b/.test(line)) {
        sites.push({ file, kind: 'count-comparator', facet: '*' });
      }
      if (/isPublishedTrade[()]/.test(line) && !/function isPublishedTrade/.test(line)) {
        sites.push({ file, kind: 'publish-floor', facet: 'trades' });
      }
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
  it('[surface:taxonomy-term-product-count] is tolerated only at the sites it names, and every count site is accounted for', () => {
    const found = discoverCountSites().map(siteKey).sort();
    const allowed = [...exception.sites, ...FREE_COUNT_SITES].map(siteKey).sort();
    expect(found).toEqual(allowed);
  });

  it('every tolerated site orders by the one capability the entry names, which is still Managed-only', () => {
    for (const site of exception.sites) {
      if (site.facet === '*' || site.facet === 'vendor_name') continue;
      expect(PRODUCT_FIELD_CAPABILITIES[FACET_FIELD[site.facet]], siteKey(site)).toBe(
        exception.capability,
      );
    }
    // If a ruling frees the capability, this fails: retire the entry.
    expect(MANAGED_ONLY).toContain(exception.capability);
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
        // Products per vendor: promote and the seat-gated product create (block 3).
        expect(site.facet).toBe('vendor_name');
      }
    }
  });
});
