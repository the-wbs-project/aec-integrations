/**
 * Builder parity for the two writers of the `products` and `vendors` indexes
 * (AECI-1038).
 *
 * Two code paths build the same Algolia records. The nightly sync and the promote
 * hook use the Drizzle transforms in `./algolia-transforms`. The datatool full
 * reindex (`POST /api/reindex`) uses raw SQL in
 * `apps/datatool/src/algolia-reindex.ts`, typed `Record<string, unknown>`, so the
 * compiler cannot tell when the two disagree. A Zod parse cannot either: a
 * schema default hides a field a builder never emitted. That is how every full
 * reindex once quietly reset the vendor `verified` field (AECI-1038), a field
 * AECI-1266 has since removed from the record.
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
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildProductRecords, buildVendorRecords } from '../../../datatool/src/algolia-reindex';
import {
  connectorEvidencedPairs,
  fieldHides,
  fieldOverrides,
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
import { toFieldCorrections } from './field-captions';
import { groupCorrections, vendorCorrectionsQuery } from './field-corrections';
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

/**
 * The subset of `D1Database` the datatool builders call: `prepare(sql).all()`, and
 * `.first()` for the `retired_at` column probe the vendor and integration builders
 * run before their count (AECI-1010).
 */
function asD1(raw: TestDb['raw']): D1Database {
  return {
    prepare: (sql: string) => ({
      all: async () => ({ results: raw.prepare(sql).all(), success: true, meta: {} }),
      first: async () => raw.prepare(sql).get() ?? null,
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
 * A catalog that exercises every record field on both entities: a vendor whose plan
 * mirror is set and one whose is not (neither may leak it), a vendor with a tier and
 * one without, built integrations in
 * both delivered-tier tables, a multi-vendor product whose primary is inserted
 * second, multi-valued taxonomy, trades whose aliases need deduping, and a
 * connector-role product beside two default applications (AECI-1086).
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
      ownedAt: '2026-01-01T00:00:00.000Z',
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
    // AECI-1086: connector-role, so `product_role` is exercised off its default.
    {
      id: u(13),
      slug: 'agave',
      name: 'Agave',
      productRole: 'connector',
      promotionStatus: 'promoted',
    },
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
  // A RETIRED built integration (AECI-1010). Both builders must leave it out of the
  // vendor's integration_count, or a full reindex re-counts what the sync dropped.
  await t.db.insert(integrations).values({
    id: u(63),
    name: 'AutoCAD to Procore (retired)',
    sourceProductId: u(12),
    targetProductId: u(11),
    mechanismKind: 'native',
    direction: 'a_to_b',
    builtByVendorId: u(1),
    retiredAt: '2026-09-20T00:00:00.000Z',
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

  it('never carries the plan mirror on the reindex path (AECI-1266)', async () => {
    await seed();
    const reindexed = await buildVendorRecords(asD1(t.raw));
    const byId = new Map(reindexed.map((r) => [r.objectID, r]));
    // Asserted directly as well as through parity: both builders could regress
    // together, and a public index must not say which vendors pay.
    expect(byId.get(u(1))).not.toHaveProperty('verified');
    expect(byId.get(u(2))).not.toHaveProperty('verified');
    // One live integration plus one evidenced pair. The retired row is not counted.
    expect(byId.get(u(1))?.integration_count).toBe(2);
  });

  it('hides an unclaimed logo on both paths and keeps its tier (AECI-1618)', async () => {
    await seed();
    await t.db
      .update(vendors)
      .set({ claimEndedAt: '2026-11-01T00:00:00.000Z' })
      .where(eq(vendors.id, u(1)));
    for (const record of await buildVendorRecords(asD1(t.raw))) {
      expect(record).toStrictEqual(await transformVendor(record.objectID as string));
    }
    const reindexed = await buildProductRecords(asD1(t.raw));
    for (const record of reindexed) {
      expect(record).toStrictEqual(await transformProduct(record.objectID as string));
    }
    const hidden = reindexed.find((r) => r.objectID === u(11))!;
    expect(hidden.logo_url).toBeNull();
    // The ranking firewall: the tier read the stored logo, so hiding it moved nothing.
    await t.db
      .update(vendors)
      .set({ claimEndedAt: null })
      .where(eq(vendors.id, u(1)));
    const claimed = (await buildProductRecords(asD1(t.raw))).find((r) => r.objectID === u(11))!;
    expect(claimed.logo_url).toBe('https://cdn.example/procore-product.png');
    expect(hidden.listing_tier).toBe(claimed.listing_tier);
  });

  it('nulls a hidden value on both paths and keeps its tier (AECI-1238)', async () => {
    await seed();
    const before = (await buildVendorRecords(asD1(t.raw))).find((r) => r.objectID === u(1))!;
    const hide = (id: number, entityType: string, entityId: string, field: string) => ({
      id: u(id),
      entityType,
      entityId,
      field,
      reason: 'R',
      sourceUrl: 'https://source.example',
      receivedAt: '2026-11-02',
      setAt: '2026-11-03T00:00:00.000Z',
    });
    await t.db
      .insert(fieldHides)
      .values([
        hide(90, 'vendor', u(1), 'description'),
        hide(91, 'vendor', u(1), 'headquarters'),
        hide(92, 'product', u(11), 'description'),
      ]);
    // A cleared hide masks nothing.
    await t.db.insert(fieldHides).values({
      ...hide(93, 'product', u(12), 'description'),
      clearedAt: '2026-11-04T00:00:00.000Z',
      clearKind: 'restored',
    });
    const vendorRecords = await buildVendorRecords(asD1(t.raw));
    for (const record of vendorRecords) {
      const row = (await t.db.query.vendors.findFirst({
        ...algoliaVendorConfig,
        where: eq(vendors.id, record.objectID as string),
      })) as RawAlgoliaVendorRow;
      const hidden = record.objectID === u(1) ? ['description', 'headquarters'] : [];
      expect(record).toStrictEqual(toAlgoliaVendor(row, hidden));
    }
    const masked = vendorRecords.find((r) => r.objectID === u(1))!;
    expect(masked).toMatchObject({ description: null, headquarters: null });
    expect(masked.listing_tier).toBe(before.listing_tier);
    const products = await buildProductRecords(asD1(t.raw));
    expect(products.find((r) => r.objectID === u(11))!.description).toBeNull();
    const unmasked = products.find((r) => r.objectID === u(12))!;
    expect(unmasked).toStrictEqual(await transformProduct(u(12)));
  });

  it('applies the company-facts display rule identically on both paths (AECI-1635)', async () => {
    await seed();
    const at = '2026-11-01T00:00:00.000Z';
    await t.db.insert(vendors).values([
      // Not owned, no source: both facts hidden.
      {
        id: u(3),
        slug: 'unsourced',
        companyName: 'Unsourced',
        headquarters: 'Nowhere',
        foundedYear: 1990,
        promotionStatus: 'promoted',
      },
      // Not owned, no source, a still-true correction on one fact and a stale one on the
      // other. Only the first shows.
      {
        id: u(4),
        slug: 'corrected',
        companyName: 'Corrected',
        headquarters: 'Boston, MA',
        foundedYear: 1999,
        promotionStatus: 'promoted',
      },
      // Not owned, one fact sourced.
      {
        id: u(5),
        slug: 'sourced',
        companyName: 'Sourced',
        headquarters: 'Denver, CO',
        headquartersSourceUrl: 'https://sourced.example/about',
        headquartersCheckedAt: at,
        foundedYear: 2001,
        promotionStatus: 'promoted',
      },
    ]);
    const correction = (id: number, field: string, value: string | number, setAt: string) => ({
      id: u(id),
      entityType: 'vendor',
      entityId: u(4),
      field,
      value,
      reason: 'R',
      sourceUrl: 'https://registry.example',
      setAt,
    });
    await t.db
      .insert(fieldOverrides)
      .values([
        correction(96, 'headquarters', 'Boston, MA', at),
        correction(97, 'founded_year', 1998, at),
      ]);
    const corrections = groupCorrections(
      await vendorCorrectionsQuery(
        t.db,
        inArray(fieldOverrides.field, ['headquarters', 'founded_year']),
      ),
    );

    const reindexed = await buildVendorRecords(asD1(t.raw));
    for (const record of reindexed) {
      const id = record.objectID as string;
      const row = (await t.db.query.vendors.findFirst({
        ...algoliaVendorConfig,
        where: eq(vendors.id, id),
      })) as RawAlgoliaVendorRow;
      expect(record).toStrictEqual(
        toAlgoliaVendor(row, [], toFieldCorrections(corrections.get(id) ?? [])),
      );
    }
    const byId = new Map(reindexed.map((r) => [r.objectID, r]));
    expect(byId.get(u(1))).toMatchObject({ headquarters: 'Carpinteria, CA', founded_year: 2002 });
    expect(byId.get(u(3))).toMatchObject({ headquarters: null, founded_year: null });
    expect(byId.get(u(4))).toMatchObject({ headquarters: 'Boston, MA', founded_year: null });
    expect(byId.get(u(5))).toMatchObject({ headquarters: 'Denver, CO', founded_year: null });
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

  // AECI-1086 — asserted directly as well as through parity: both builders could
  // drop the field together and still agree with each other.
  it('carries product_role on both paths, for every role', async () => {
    await seed();
    await t.db
      .update(products)
      .set({ productRole: 'hybrid' })
      .where(eq(products.id, u(12)));
    const reindexed = await buildProductRecords(asD1(t.raw));
    const expected = { [u(11)]: 'application', [u(12)]: 'hybrid', [u(13)]: 'connector' };
    for (const record of reindexed) {
      const id = record.objectID as string;
      const transformed = await transformProduct(id);
      expect(record.product_role).toBe(expected[id]);
      expect(transformed.product_role).toBe(expected[id]);
      expect(record).toStrictEqual(transformed);
    }
  });
});
