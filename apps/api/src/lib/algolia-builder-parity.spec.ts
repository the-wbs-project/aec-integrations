/**
 * Builder parity for the two writers of the `products` and `vendors` indexes
 * (AECI-1038).
 *
 * Two code paths build the same Algolia records. The nightly sync and the promote
 * hook use the Drizzle transforms in `./algolia-transforms`. The datatool full
 * reindex (`POST /api/reindex`) uses raw SQL in
 * `apps/datatool/src/algolia-reindex.ts`, typed `Record<string, unknown>`, so the
 * compiler cannot tell when the two disagree. A Zod parse cannot either: the
 * vendor schema defaults `verified` to `false`, so a builder that never emitted
 * the field still produced valid records. That is how every full reindex quietly
 * un-verified every vendor.
 *
 * This spec seeds one D1, builds every promoted row through BOTH paths, and
 * asserts the records are deeply equal with `toStrictEqual`, which also fails on
 * a key one side emits as `undefined` and the other omits. A field added to one
 * builder and forgotten in the other fails here.
 *
 * It lives in `apps/api` rather than `apps/datatool` because only this package has
 * the Drizzle client the transform path needs. The datatool builder only needs a
 * `D1Database`, which a three-line adapter over the same better-sqlite3 handle
 * provides.
 */

import {
  AlgoliaProductRecordSchema,
  AlgoliaVendorRecordSchema,
} from '@aeci/shared/algolia-records';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildProductRecords, buildVendorRecords } from '../../../datatool/src/algolia-reindex';
import {
  connectorEvidencedPairs,
  integrations,
  productAudiences,
  productCategories,
  productPhases,
  products,
  productTrades,
  productVendors,
  taxonomyAudiences,
  taxonomyCategories,
  taxonomyPhases,
  taxonomyTrades,
  vendors,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  algoliaProductConfig,
  algoliaVendorConfig,
  toAlgoliaProduct,
  toAlgoliaVendor,
  type RawAlgoliaProductRow,
  type RawAlgoliaVendorRow,
} from './algolia-transforms';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

/** The subset of `D1Database` the datatool builders call: `prepare(sql).all()`. */
function asD1(raw: TestDb['raw']): D1Database {
  return {
    prepare: (sql: string) => ({
      all: async () => ({ results: raw.prepare(sql).all(), success: true, meta: {} }),
    }),
  } as unknown as D1Database;
}

async function transformVendor(id: string) {
  const row = (await t.db.query.vendors.findFirst({
    ...algoliaVendorConfig,
    where: eq(vendors.id, id),
  })) as RawAlgoliaVendorRow | undefined;
  return toAlgoliaVendor(row!);
}

async function transformProduct(id: string) {
  const row = (await t.db.query.products.findFirst({
    ...algoliaProductConfig,
    where: eq(products.id, id),
  })) as RawAlgoliaProductRow | undefined;
  return toAlgoliaProduct(row!);
}

/**
 * A catalog that exercises every record field on both entities: a verified and an
 * unverified vendor, a vendor with a tier and one without, built integrations in
 * both delivered-tier tables, a multi-vendor product whose primary is inserted
 * second, multi-valued taxonomy, and trades whose aliases need deduping.
 */
async function seed() {
  await t.db.insert(vendors).values([
    {
      id: u(1),
      slug: 'procore-technologies',
      companyName: 'Procore Technologies',
      description: 'Construction software.',
      headquarters: 'Carpinteria, CA',
      foundedYear: 2002,
      website: 'https://procore.example',
      logoUrl: 'https://cdn.example/procore.png',
      verified: true,
      promotionStatus: 'promoted',
    },
    {
      id: u(2),
      slug: 'reseller',
      companyName: 'reseller LLC',
      verified: false,
      promotionStatus: 'promoted',
    },
  ]);
  await t.db.insert(products).values([
    {
      id: u(11),
      slug: 'procore',
      name: 'Procore',
      description: 'Construction management platform.',
      website: 'https://procore.example/product',
      logoUrl: 'https://cdn.example/procore-product.png',
      hasApiDocs: true,
      integrationCount: 2,
      reviewCount: 3,
      ratingOverallAvg: 4.5,
      promotionStatus: 'promoted',
    },
    {
      id: u(12),
      slug: 'autocad',
      name: 'AutoCAD',
      integrationCount: 1,
      promotionStatus: 'promoted',
    },
    // The connector a connector-evidenced pair is delivered through. Promoted, so
    // it is a third product record and a sparse one: no vendor, no taxonomy.
    { id: u(13), slug: 'agave', name: 'Agave', promotionStatus: 'promoted' },
  ]);
  // Primary inserted SECOND, so a builder that picks by insertion order fails.
  await t.db.insert(productVendors).values([
    { productId: u(11), vendorId: u(2), isPrimary: false },
    { productId: u(11), vendorId: u(1), isPrimary: true },
  ]);
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
  await t.db.insert(taxonomyTrades).values([
    {
      id: u(51),
      slug: 'paving-asphalt',
      name: 'Paving & Asphalt',
      description: 'Asphalt paving.',
      aliases: ['Blacktop', 'Paving & Asphalt', 'Shared Alias'],
    },
    {
      id: u(52),
      slug: 'roofing',
      name: 'Roofing',
      description: 'Roofing systems.',
      aliases: ['Shared Alias', 'Roofer'],
    },
  ]);
  await t.db.insert(productCategories).values([
    { productId: u(11), categoryId: u(21) },
    { productId: u(11), categoryId: u(22) },
  ]);
  await t.db.insert(productAudiences).values({ productId: u(11), audienceId: u(31) });
  await t.db.insert(productPhases).values([
    { productId: u(11), phaseId: u(41) },
    { productId: u(11), phaseId: u(42) },
  ]);
  await t.db.insert(productTrades).values([
    { productId: u(11), tradeId: u(51) },
    { productId: u(11), tradeId: u(52) },
  ]);
  // The vendor integration_count sums BOTH delivered-tier tables (AECI-721).
  await t.db.insert(integrations).values({
    id: u(61),
    name: 'Procore to AutoCAD',
    sourceProductId: u(11),
    targetProductId: u(12),
    mechanismKind: 'native',
    direction: 'a_to_b',
    builtByVendorId: u(1),
  });
  await t.db.insert(connectorEvidencedPairs).values({
    id: u(62),
    productAId: u(11),
    productBId: u(12),
    connectorProductId: u(13),
    direction: 'both',
    builtByVendorId: u(1),
  });
}

describe('Algolia builder parity: datatool full reindex vs Worker transform (AECI-1038)', () => {
  it('builds every vendor record identically on both paths', async () => {
    await seed();
    const reindexed = await buildVendorRecords(asD1(t.raw));
    expect(reindexed.map((r) => r.objectID).sort()).toEqual([u(1), u(2)]);

    for (const record of reindexed) {
      const transformed = await transformVendor(record.objectID as string);
      expect(record).toStrictEqual(transformed);
      expect(() => AlgoliaVendorRecordSchema.parse(record)).not.toThrow();
    }
  });

  it('carries verified: true for a verified vendor on the reindex path', async () => {
    await seed();
    const reindexed = await buildVendorRecords(asD1(t.raw));
    const byId = new Map(reindexed.map((r) => [r.objectID, r]));
    // Asserted directly as well as through parity: the schema's `.default(false)`
    // means an omitted key parses as unverified, so only an explicit value proves it.
    expect(byId.get(u(1))?.verified).toBe(true);
    expect(byId.get(u(2))?.verified).toBe(false);
  });

  it('builds every product record identically on both paths', async () => {
    await seed();
    const reindexed = await buildProductRecords(asD1(t.raw));
    expect(reindexed.map((r) => r.objectID).sort()).toEqual([u(11), u(12), u(13)]);

    for (const record of reindexed) {
      const transformed = await transformProduct(record.objectID as string);
      expect(record).toStrictEqual(transformed);
      expect(() => AlgoliaProductRecordSchema.parse(record)).not.toThrow();
    }
  });
});
