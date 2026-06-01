/**
 * AECI-83 / Phase 2.0 — integration test for the Airtable → Supabase bulk
 * migration. Drives `bulkMigrate` with a fake in-memory Airtable gateway (no
 * network) and a real Prisma client against `TEST_DATABASE_URL`.
 *
 * Covers: dependency-order inserts, transitive vendor + taxonomy migration,
 * slug collision → vendor-suffix disambiguation, integration excluded when an
 * endpoint product isn't promoted, integration_count recompute, audit rows,
 * supabase_uuid write-back, and idempotent re-run.
 *
 * Gated on `TEST_DATABASE_URL` (direct postgresql:// URL with the schema
 * applied — the local Supabase dev container). `describe.skipIf` keeps the unit
 * lane silent when unset.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bulkMigrate,
  TABLES,
  type MigratePrisma,
} from '../../scripts/airtable-to-supabase-bulk-migrate';
import type { AirtableGateway, AirtableRecord } from '../../scripts/lib/airtable';

const testDbUrl = process.env.TEST_DATABASE_URL;
const TAG = `mig${Date.now()}`;
const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

/** In-memory Airtable double. Mutates its own store on patch so re-runs see writebacks. */
class FakeAirtable implements AirtableGateway {
  constructor(private store: Record<string, AirtableRecord[]>) {}

  listRecords(tableId: string, opts?: { filterByFormula?: string }): Promise<AirtableRecord[]> {
    let recs = this.store[tableId] ?? [];
    if (opts?.filterByFormula?.includes("'promoted'")) {
      recs = recs.filter((r) => r.fields.promotion_status === 'promoted');
    }
    // Return copies so the script can't mutate the store except via patch.
    return Promise.resolve(recs.map((r) => ({ id: r.id, fields: { ...r.fields } })));
  }

  ensureField(): Promise<{ created: boolean }> {
    return Promise.resolve({ created: false });
  }

  patchRecords(
    tableId: string,
    updates: { id: string; fields: Record<string, unknown> }[],
  ): Promise<void> {
    const recs = this.store[tableId] ?? [];
    for (const u of updates) {
      const rec = recs.find((r) => r.id === u.id);
      if (rec) rec.fields = { ...rec.fields, ...u.fields };
    }
    return Promise.resolve();
  }
}

function buildStore(): Record<string, AirtableRecord[]> {
  return {
    [TABLES.vendors]: [
      { id: 'recV1', fields: { company_name: `VendorOne ${TAG}`, website: 'https://v1.example' } },
      { id: 'recV2', fields: { company_name: `VendorTwo ${TAG}` } },
    ],
    [TABLES.categories]: [
      { id: 'recC1', fields: { Name: `Cat ${TAG}`, Description: 'a category' } },
    ],
    [TABLES.disciplines]: [{ id: 'recD1', fields: { Name: `Disc ${TAG}` } }],
    [TABLES.phases]: [{ id: 'recPH1', fields: { Name: `Phase ${TAG}` } }],
    [TABLES.products]: [
      {
        id: 'recP1',
        fields: {
          Name: `Widget ${TAG}`,
          promotion_status: 'promoted',
          vendors: ['recV1'],
          category: ['recC1'],
          supported_disciplines: ['recD1'],
          supported_project_phases: ['recPH1'],
          has_api_docs: true,
          product_role: 'application',
        },
      },
      {
        // Same name as P1 → slug collision → vendor-suffix disambiguation.
        // extension_of P1 exercises Pass C (product_extension insert + audit).
        id: 'recP2',
        fields: {
          Name: `Widget ${TAG}`,
          promotion_status: 'promoted',
          vendors: ['recV2'],
          extension_of: ['recP1'],
        },
      },
      {
        // NOT promoted — must not migrate, and excludes I2 below.
        id: 'recP3',
        fields: { Name: `Ghost ${TAG}`, promotion_status: 'ready' },
      },
    ],
    [TABLES.integrations]: [
      {
        id: 'recI1',
        fields: {
          Name: `Int1 ${TAG}`,
          'Source Tool': ['recP1'],
          'Target Tool': ['recP2'],
          mechanism_kind: 'native',
          direction: 'one-way',
          built_by: ['recV1'],
        },
      },
      {
        // Target P3 not promoted → skipped.
        id: 'recI2',
        fields: { Name: `Int2 ${TAG}`, 'Source Tool': ['recP1'], 'Target Tool': ['recP3'] },
      },
    ],
  };
}

const baseSlug = `widget-${TAG}`.toLowerCase();
const v2Slug = `vendortwo-${TAG}`.toLowerCase();
const p2Slug = `${baseSlug}-${v2Slug}`;

describe.skipIf(!testDbUrl)('bulkMigrate — integration (AECI-83)', () => {
  let prisma: PrismaClient;
  let fake: FakeAirtable;
  let store: Record<string, AirtableRecord[]>;

  beforeAll(() => {
    prisma = new PrismaClient({ datasourceUrl: testDbUrl });
    store = buildStore();
    fake = new FakeAirtable(store);
  });

  afterAll(async () => {
    if (!prisma) return;
    const products = await prisma.product.findMany({
      where: { slug: { in: [baseSlug, p2Slug] } },
      select: { id: true },
    });
    const vendors = await prisma.vendor.findMany({
      where: { slug: { in: [`vendorone-${TAG}`.toLowerCase(), v2Slug] } },
      select: { id: true },
    });
    const cats = await prisma.taxonomyCategory.findMany({
      where: { slug: `cat-${TAG}`.toLowerCase() },
      select: { id: true },
    });
    const discs = await prisma.taxonomyDiscipline.findMany({
      where: { slug: `disc-${TAG}`.toLowerCase() },
      select: { id: true },
    });
    const phases = await prisma.taxonomyPhase.findMany({
      where: { slug: `phase-${TAG}`.toLowerCase() },
      select: { id: true },
    });
    const integrations = await prisma.integration.findMany({
      where: { name: { in: [`Int1 ${TAG}`] } },
      select: { id: true },
    });
    const productIds = products.map((p) => p.id);
    const allEntityIds = [
      ...productIds,
      ...vendors.map((v) => v.id),
      ...cats.map((c) => c.id),
      ...discs.map((d) => d.id),
      ...phases.map((p) => p.id),
      ...integrations.map((i) => i.id),
    ];

    if (productIds.length) {
      await prisma.productVendor.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.productCategory.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.productDiscipline.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.productPhase.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.productExtension.deleteMany({ where: { productId: { in: productIds } } });
    }
    await prisma.integration.deleteMany({ where: { id: { in: integrations.map((i) => i.id) } } });
    if (productIds.length) await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.vendor.deleteMany({ where: { id: { in: vendors.map((v) => v.id) } } });
    await prisma.taxonomyCategory.deleteMany({ where: { id: { in: cats.map((c) => c.id) } } });
    await prisma.taxonomyDiscipline.deleteMany({ where: { id: { in: discs.map((d) => d.id) } } });
    await prisma.taxonomyPhase.deleteMany({ where: { id: { in: phases.map((p) => p.id) } } });
    if (allEntityIds.length) {
      await prisma.auditLog.deleteMany({ where: { entityId: { in: allEntityIds } } });
    }
    await prisma.$disconnect();
  });

  it('migrates promoted products + transitive vendors/taxonomy in dependency order', async () => {
    const result = await bulkMigrate(
      { airtable: fake, prisma: prisma as unknown as MigratePrisma },
      { dryRun: false, log: silentLogger },
    );

    expect(result.verification.ok).toBe(true);
    expect(result.products.inserted).toBe(2);
    expect(result.vendors.inserted).toBe(2);
    expect(result.integrations.inserted).toBe(1);
    expect(result.integrationsSkippedUnmigratedEndpoint).toBe(1);

    const p1 = await prisma.product.findUniqueOrThrow({ where: { slug: baseSlug } });
    const p2 = await prisma.product.findUniqueOrThrow({ where: { slug: p2Slug } });
    expect(p1.promotionStatus).toBe('promoted');

    // P3 (not promoted) never lands.
    const ghost = await prisma.product.findFirst({ where: { slug: `ghost-${TAG}`.toLowerCase() } });
    expect(ghost).toBeNull();

    // Vendor link + taxonomy joins on P1.
    const pvs = await prisma.productVendor.findMany({ where: { productId: p1.id } });
    expect(pvs).toHaveLength(1);
    expect(pvs[0].isPrimary).toBe(true);
    expect(await prisma.productCategory.count({ where: { productId: p1.id } })).toBe(1);
    expect(await prisma.productDiscipline.count({ where: { productId: p1.id } })).toBe(1);
    expect(await prisma.productPhase.count({ where: { productId: p1.id } })).toBe(1);

    // integration_count recomputed: I1 links P1↔P2, so both = 1.
    expect(p1.integrationCount).toBe(1);
    expect(p2.integrationCount).toBe(1);

    // Review aggregates recomputed by the shared helper (AECI-104): the
    // migration writes no reviews, so review_count is 0 and the rating averages
    // are NULL, matching the "approved-only / NULL-at-zero" rule.
    expect(p1.reviewCount).toBe(0);
    expect(p1.ratingOverallAvg).toBeNull();
    expect(p1.ratingOnboardingAvg).toBeNull();

    // audit rows written for each entity create.
    expect(
      await prisma.auditLog.count({ where: { action: 'product.created', entityId: p1.id } }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({ where: { action: 'integration.created' } }),
    ).toBeGreaterThanOrEqual(1);

    // Pass C: product_extension row created + audit row committed atomically.
    expect(
      await prisma.productExtension.count({ where: { productId: p2.id, hostProductId: p1.id } }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { action: 'product.extension_created', entityId: p2.id },
      }),
    ).toBe(1);

    // supabase_uuid written back to Airtable (fake store mutated).
    const writtenP1 = store[TABLES.products].find((r) => r.id === 'recP1');
    expect(writtenP1?.fields.supabase_uuid).toBe(p1.id);
  });

  it('re-run is idempotent — no duplicate inserts', async () => {
    const result = await bulkMigrate(
      { airtable: fake, prisma: prisma as unknown as MigratePrisma },
      { dryRun: false, log: silentLogger },
    );

    expect(result.products.inserted).toBe(0);
    expect(result.vendors.inserted).toBe(0);
    expect(result.integrations.inserted).toBe(0);
    expect(result.products.skipped).toBe(2);
    expect(result.vendors.skipped).toBe(2);
    expect(result.verification.ok).toBe(true);

    // Still exactly one of each (no duplicates).
    expect(await prisma.product.count({ where: { slug: { in: [baseSlug, p2Slug] } } })).toBe(2);
    expect(await prisma.integration.count({ where: { name: `Int1 ${TAG}` } })).toBe(1);

    // Pass C: extension row not duplicated on re-run.
    const p2Rerun = await prisma.product.findUniqueOrThrow({ where: { slug: p2Slug } });
    expect(await prisma.productExtension.count({ where: { productId: p2Rerun.id } })).toBe(1);
  });
});
