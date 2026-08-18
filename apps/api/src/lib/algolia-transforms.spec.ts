/**
 * Unit tests for the AECI-137 Drizzle-row → Algolia-record transforms — Drizzle/D1
 * (ADR 0016 / AECI-253). Replaces the retired Prisma-mock suite: each case seeds
 * REAL rows on the in-memory D1 harness, hydrates them through the production
 * `*Config` objects (`db.query.<table>.findMany({ ...config, where })`), feeds the
 * raw row to the mapper, and asserts the record field-by-field AND against the
 * shared Zod record schema (`@aeci/shared/algolia-records`) — the "transform
 * output IS a valid index record" guarantee the sync pipeline (3.5/3.6) relies on.
 *
 * Two old Prisma-shaped conversions are gone under D1: `real` columns arrive as
 * `number` (no `Decimal`), and the vendor counts come from the config's
 * correlated-subquery `extras` (so they only appear when product_vendors /
 * integrations are actually seeded).
 */

import {
  AlgoliaIntegrationRecordSchema,
  AlgoliaProductRecordSchema,
  AlgoliaVendorRecordSchema,
} from '@aeci/shared/algolia-records';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  integrations,
  products,
  productVendors,
  taxonomyAudiences,
  taxonomyCategories,
  taxonomyPhases,
  taxonomyTrades,
  productAudiences,
  productCategories,
  productPhases,
  productTrades,
  vendors,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  algoliaIntegrationConfig,
  algoliaProductConfig,
  algoliaVendorConfig,
  toAlgoliaIntegration,
  toAlgoliaProduct,
  toAlgoliaVendor,
  type RawAlgoliaIntegrationRow,
  type RawAlgoliaProductRow,
  type RawAlgoliaVendorRow,
} from './algolia-transforms';

// Valid UUIDs (the record schemas validate `objectID` as a uuid; prod ids are real).
const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

// Hydrate one product/vendor/integration row through the production config.
const productById = (id: string) =>
  t.db.query.products.findFirst({
    ...algoliaProductConfig,
    where: eq(products.id, id),
  }) as Promise<RawAlgoliaProductRow | undefined>;
const vendorById = (id: string) =>
  t.db.query.vendors.findFirst({
    ...algoliaVendorConfig,
    where: eq(vendors.id, id),
  }) as Promise<RawAlgoliaVendorRow | undefined>;
const integrationById = (id: string) =>
  t.db.query.integrations.findFirst({
    ...algoliaIntegrationConfig,
    where: eq(integrations.id, id),
  }) as Promise<RawAlgoliaIntegrationRow | undefined>;

// ---------------------------------------------------------------------------
// toAlgoliaProduct
// ---------------------------------------------------------------------------

describe('toAlgoliaProduct', () => {
  it('denormalizes a product (primary vendor + multi-valued taxonomy) into a valid §7.1 record', async () => {
    await t.db.insert(products).values({
      id: u(1),
      slug: 'procore',
      name: 'Procore',
      description: 'Construction management platform.',
      logoUrl: 'https://cdn.brandfetch.io/procore.png',
      hasApiDocs: true,
      integrationCount: 342,
      reviewCount: 0,
      ratingOverallAvg: 4.5,
      promotionStatus: 'promoted',
    });
    // Two vendor links; the PRIMARY one is inserted SECOND to prove
    // pickPrimaryVendor selects by isPrimary, not array/insertion order.
    await t.db.insert(vendors).values([
      { id: u(11), slug: 'reseller', companyName: 'Reseller LLC' },
      { id: u(12), slug: 'procore-technologies', companyName: 'Procore Technologies' },
    ]);
    await t.db
      .insert(productVendors)
      .values({ productId: u(1), vendorId: u(11), isPrimary: false });
    await t.db.insert(productVendors).values({ productId: u(1), vendorId: u(12), isPrimary: true });
    // Multi-valued categories / audiences / phases.
    await t.db.insert(taxonomyCategories).values([
      { id: u(21), slug: 'project-management', name: 'Project Management' },
      { id: u(22), slug: 'document-control', name: 'Document Control' },
    ]);
    await t.db
      .insert(taxonomyAudiences)
      .values({ id: u(31), slug: 'construction-management', name: 'Construction Management' });
    await t.db.insert(taxonomyPhases).values([
      { id: u(41), slug: 'construction', name: 'Construction' },
      { id: u(42), slug: 'closeout', name: 'Closeout & Operations' },
    ]);
    await t.db.insert(productCategories).values([
      { productId: u(1), categoryId: u(21) },
      { productId: u(1), categoryId: u(22) },
    ]);
    await t.db.insert(productAudiences).values({ productId: u(1), audienceId: u(31) });
    await t.db.insert(productPhases).values([
      { productId: u(1), phaseId: u(41) },
      { productId: u(1), phaseId: u(42) },
    ]);
    // Trades (AECI-545). `description` is NOT NULL on this table (it diverges
    // from its three siblings — `/trades/:slug` is an SEO landing page). The
    // second trade has NULL aliases, and 'Paving' repeats a canonical trade name,
    // so this one fixture covers the whole `trade_aliases` flattening contract.
    await t.db.insert(taxonomyTrades).values([
      {
        id: u(51),
        slug: 'paving-asphalt',
        name: 'Paving & Asphalt',
        description: 'Asphalt paving, milling, and pavement maintenance.',
        aliases: ['Blacktop', 'Paving & Asphalt', 'Asphalt Paving'],
      },
      {
        id: u(52),
        slug: 'roofing',
        name: 'Roofing',
        description: 'Low-slope and steep-slope roofing systems.',
        aliases: null,
      },
    ]);
    await t.db.insert(productTrades).values([
      { productId: u(1), tradeId: u(51) },
      { productId: u(1), tradeId: u(52) },
    ]);

    const row = (await productById(u(1)))!;
    const record = toAlgoliaProduct(row);

    expect(record.objectID).toBe(u(1));
    expect(record.name).toBe('Procore');
    expect(record.slug).toBe('procore');
    expect(record.description).toBe('Construction management platform.');
    expect(record.vendor_name).toBe('Procore Technologies');
    expect(record.vendor_slug).toBe('procore-technologies');
    expect([...record.categories].sort()).toEqual(['Document Control', 'Project Management']);
    expect(record.audiences).toEqual(['Construction Management']);
    expect([...record.phases].sort()).toEqual(['Closeout & Operations', 'Construction']);
    expect([...record.trades].sort()).toEqual(['Paving & Asphalt', 'Roofing']);
    // The alias that repeats the canonical trade name is dropped (it already
    // lives in `trades`); the NULL-aliases trade contributes nothing.
    expect([...record.trade_aliases].sort()).toEqual(['Asphalt Paving', 'Blacktop']);
    expect(record.integration_count).toBe(342);
    expect(record.review_count).toBe(0);
    expect(record.rating_overall_avg).toBe(4.5);
    expect(record.has_api_docs).toBe(true);
    expect(record.logo_url).toBe('https://cdn.brandfetch.io/procore.png');
    expect(() => AlgoliaProductRecordSchema.parse(record)).not.toThrow();
  });

  it('surfaces a null vendor (no links) rather than fabricating one', async () => {
    await t.db.insert(products).values({ id: u(1), slug: 'procore', name: 'Procore' });
    const record = toAlgoliaProduct((await productById(u(1)))!);
    expect(record.vendor_name).toBeNull();
    expect(record.vendor_slug).toBeNull();
    expect(() => AlgoliaProductRecordSchema.parse(record)).not.toThrow();
  });

  it('keeps a null rating as null (no approved reviews)', async () => {
    await t.db
      .insert(products)
      .values({ id: u(1), slug: 'procore', name: 'Procore', ratingOverallAvg: null });
    const record = toAlgoliaProduct((await productById(u(1)))!);
    expect(record.rating_overall_avg).toBeNull();
  });

  it('emits empty taxonomy arrays when a product has no taxonomy links', async () => {
    await t.db.insert(products).values({ id: u(1), slug: 'procore', name: 'Procore' });
    const record = toAlgoliaProduct((await productById(u(1)))!);
    expect(record.categories).toEqual([]);
    expect(record.audiences).toEqual([]);
    expect(record.phases).toEqual([]);
    // Trades are SPARSE BY DESIGN (§5.5a) — a horizontal platform carries none,
    // so this is the COMMON case, not an edge case.
    expect(record.trades).toEqual([]);
    expect(record.trade_aliases).toEqual([]);
  });

  it('dedupes an alias shared by two of a product’s trades (AECI-545)', async () => {
    await t.db.insert(products).values({ id: u(1), slug: 'procore', name: 'Procore' });
    await t.db.insert(taxonomyTrades).values([
      {
        id: u(51),
        slug: 'glazing-curtain-wall',
        name: 'Glazing & Curtain Wall',
        description: 'Glazing, curtain wall, and storefront systems.',
        aliases: ['Curtain Wall', 'Glazier'],
      },
      {
        id: u(52),
        slug: 'framing',
        name: 'Framing',
        description: 'Wood and light-gauge metal framing.',
        aliases: ['Curtain Wall', 'Carpentry'],
      },
    ]);
    await t.db.insert(productTrades).values([
      { productId: u(1), tradeId: u(51) },
      { productId: u(1), tradeId: u(52) },
    ]);

    const record = toAlgoliaProduct((await productById(u(1)))!);
    expect(record.trade_aliases.filter((a) => a === 'Curtain Wall')).toHaveLength(1);
    expect([...record.trade_aliases].sort()).toEqual(['Carpentry', 'Curtain Wall', 'Glazier']);
    expect(() => AlgoliaProductRecordSchema.parse(record)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// toAlgoliaVendor
// ---------------------------------------------------------------------------

describe('toAlgoliaVendor', () => {
  it('denormalizes a vendor (counts from the extras subqueries) into a valid §7.1 record', async () => {
    await t.db.insert(vendors).values({
      id: u(1),
      slug: 'procore-technologies',
      companyName: 'Procore Technologies',
      description: null,
      headquarters: 'Carpinteria, CA',
      foundedYear: 2003,
      logoUrl: null,
      verified: true,
    });
    // product_count: 2 product_vendors rows for this vendor.
    await t.db.insert(products).values([
      { id: u(11), slug: 'procore', name: 'Procore' },
      { id: u(12), slug: 'procore-bim', name: 'Procore BIM' },
    ]);
    await t.db.insert(productVendors).values([
      { productId: u(11), vendorId: u(1), isPrimary: true },
      { productId: u(12), vendorId: u(1), isPrimary: true },
    ]);
    // integration_count: 3 integrations built_by this vendor.
    await t.db.insert(integrations).values([
      { id: u(21), sourceProductId: u(11), targetProductId: u(12), builtByVendorId: u(1) },
      { id: u(22), sourceProductId: u(12), targetProductId: u(11), builtByVendorId: u(1) },
      { id: u(23), sourceProductId: u(11), targetProductId: u(12), builtByVendorId: u(1) },
    ]);

    const record = toAlgoliaVendor((await vendorById(u(1)))!);
    expect(record).toEqual({
      objectID: u(1),
      company_name: 'Procore Technologies',
      slug: 'procore-technologies',
      verified: true,
      description: null,
      headquarters: 'Carpinteria, CA',
      founded_year: 2003,
      product_count: 2,
      integration_count: 3,
      logo_url: null,
    });
    expect(() => AlgoliaVendorRecordSchema.parse(record)).not.toThrow();
  });

  it('maps the verified flag from the vendor row, defaulting to false (AECI-529)', async () => {
    // A vendor not yet granted a verified account carries the schema default.
    await t.db.insert(vendors).values({ id: u(1), slug: 'unclaimed', companyName: 'Unclaimed Co' });
    const record = toAlgoliaVendor((await vendorById(u(1)))!);
    expect(record.verified).toBe(false);
  });

  it('reports zero counts for a vendor with no products / integrations', async () => {
    await t.db.insert(vendors).values({ id: u(1), slug: 'lonely', companyName: 'Lonely Co' });
    const record = toAlgoliaVendor((await vendorById(u(1)))!);
    expect(record.product_count).toBe(0);
    expect(record.integration_count).toBe(0);
    expect(() => AlgoliaVendorRecordSchema.parse(record)).not.toThrow();
  });

  it('keeps null headquarters / founded_year', async () => {
    await t.db.insert(vendors).values({
      id: u(1),
      slug: 'procore-technologies',
      companyName: 'Procore Technologies',
      headquarters: null,
      foundedYear: null,
    });
    const record = toAlgoliaVendor((await vendorById(u(1)))!);
    expect(record.headquarters).toBeNull();
    expect(record.founded_year).toBeNull();
    expect(() => AlgoliaVendorRecordSchema.parse(record)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// toAlgoliaIntegration
// ---------------------------------------------------------------------------

describe('toAlgoliaIntegration', () => {
  // Seed source/target products once per integration case.
  async function seedEndpoints() {
    await t.db.insert(products).values([
      { id: u(81), slug: 'procore', name: 'Procore' },
      {
        id: u(82),
        slug: 'autodesk-construction-cloud',
        name: 'Autodesk Construction Cloud',
      },
    ]);
  }

  it('denormalizes source/target + derives mechanism_rank into a valid §7.1 record', async () => {
    await seedEndpoints();
    await t.db.insert(integrations).values({
      id: u(1),
      name: 'Procore App',
      sourceProductId: u(81),
      targetProductId: u(82),
      mechanismKind: 'native',
      mechanismName: 'Procore App',
      direction: 'bidirectional',
      description: null,
    });

    const record = toAlgoliaIntegration((await integrationById(u(1)))!);
    expect(record).toEqual({
      objectID: u(1),
      source_product_name: 'Procore',
      source_product_slug: 'procore',
      target_product_name: 'Autodesk Construction Cloud',
      target_product_slug: 'autodesk-construction-cloud',
      mechanism_kind: 'native',
      mechanism_name: 'Procore App',
      direction: 'bidirectional',
      description: null,
      mechanism_rank: 6,
    });
    expect(() => AlgoliaIntegrationRecordSchema.parse(record)).not.toThrow();
  });

  it('ranks each mechanism_kind per §7.3 (native 6 … partner 1, null 0)', async () => {
    await seedEndpoints();
    const rankFor = async (mechanismKind: string | null) => {
      await t.db.delete(integrations).where(eq(integrations.id, u(1)));
      await t.db
        .insert(integrations)
        .values({ id: u(1), sourceProductId: u(81), targetProductId: u(82), mechanismKind });
      return toAlgoliaIntegration((await integrationById(u(1)))!).mechanism_rank;
    };
    expect(await rankFor('native')).toBe(6);
    expect(await rankFor('marketplace-app')).toBe(5);
    expect(await rankFor('iPaaS')).toBe(4);
    expect(await rankFor('api')).toBe(3);
    expect(await rankFor('webhook')).toBe(2);
    expect(await rankFor('partner')).toBe(1);
    expect(await rankFor(null)).toBe(0);
  });

  it('passes a null mechanism_kind / direction through (rank 0)', async () => {
    await seedEndpoints();
    await t.db.insert(integrations).values({
      id: u(1),
      sourceProductId: u(81),
      targetProductId: u(82),
      mechanismKind: null,
      direction: null,
    });
    const record = toAlgoliaIntegration((await integrationById(u(1)))!);
    expect(record.mechanism_kind).toBeNull();
    expect(record.direction).toBeNull();
    expect(record.mechanism_rank).toBe(0);
    expect(() => AlgoliaIntegrationRecordSchema.parse(record)).not.toThrow();
  });

  it('throws on an out-of-enum mechanism_kind (data-integrity violation, fail loud)', async () => {
    await seedEndpoints();
    await t.db.insert(integrations).values({
      id: u(1),
      sourceProductId: u(81),
      targetProductId: u(82),
      mechanismKind: 'native',
    });
    // The DB CHECK (`integrations_mechanism_kind_check`) rejects a bad value at
    // INSERT, so corrupt the hydrated row in-memory to exercise the mapper's
    // fail-loud branch — the transform is the real fence the sync pipeline trusts.
    const bad: RawAlgoliaIntegrationRow = {
      ...(await integrationById(u(1)))!,
      mechanismKind: 'telepathy',
    };
    expect(() => toAlgoliaIntegration(bad)).toThrow(/unknown mechanism_kind/);
  });
});
