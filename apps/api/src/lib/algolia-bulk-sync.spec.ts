/**
 * Unit tests for the Phase 3.5 bulk-reindex core (AECI-138). Fully fake-driven:
 * a recording Prisma stub and a recording Algolia stub prove the read→transform
 * →validate→upload pipeline without touching Postgres or Algolia. Asserts the
 * promoted-only filters, per-locale index naming, dry-run no-write behaviour,
 * the 0-integration-rows path, and that records are validated before upload.
 */

import { Prisma } from '@prisma/client/edge';
import { describe, expect, it } from 'vitest';

import {
  algoliaIntegrationSelect,
  algoliaProductSelect,
  algoliaVendorSelect,
  type RawAlgoliaIntegrationRow,
  type RawAlgoliaProductRow,
  type RawAlgoliaVendorRow,
} from './algolia-transforms';
import { runBulkSync, type AlgoliaBatchClient, type BulkSyncPrisma } from './algolia-bulk-sync';

// ── Fixtures (typed against the Raw* payloads, like algolia-transforms.spec) ──

const productRow: RawAlgoliaProductRow = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'procore',
  name: 'Procore',
  description: 'Construction management platform.',
  logoUrl: 'https://cdn.brandfetch.io/procore.png',
  hasApiDocs: true,
  integrationCount: 342,
  reviewCount: 0,
  ratingOverallAvg: new Prisma.Decimal(4.5),
  productVendors: [
    {
      isPrimary: true,
      vendor: {
        id: 'v-1',
        companyName: 'Procore Technologies',
        slug: 'procore-technologies',
        logoUrl: null,
      },
    },
  ],
  productCategories: [{ category: { name: 'Project Management' } }],
  productAudiences: [{ audience: { name: 'Construction Management' } }],
  productPhases: [{ phase: { name: 'Construction' } }],
};

const vendorRow: RawAlgoliaVendorRow = {
  id: '22222222-2222-4222-8222-222222222222',
  slug: 'procore-technologies',
  companyName: 'Procore Technologies',
  logoUrl: null,
  verified: true,
  headquarters: 'Carpinteria, CA',
  foundedYear: 2003,
  createdAt: new Date('2024-01-01T00:00:00Z'),
  updatedAt: new Date('2024-01-01T00:00:00Z'),
  _count: { productVendors: 8, builtIntegrations: 412 },
  description: null,
};

const integrationRow: RawAlgoliaIntegrationRow = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Procore App',
  mechanismKind: 'native',
  mechanismName: 'Procore App',
  direction: 'bidirectional',
  sourceProduct: { id: 's-1', name: 'Procore', slug: 'procore', logoUrl: null },
  targetProduct: {
    id: 't-1',
    name: 'Autodesk Construction Cloud',
    slug: 'autodesk-construction-cloud',
    logoUrl: null,
  },
  createdAt: new Date('2024-01-01T00:00:00Z'),
  updatedAt: new Date('2024-01-01T00:00:00Z'),
  description: null,
};

// ── Recording fakes ──────────────────────────────────────────────────────────

type FindManyArgs = { where: unknown; select: unknown };

function makePrisma(rows: {
  products?: RawAlgoliaProductRow[];
  vendors?: RawAlgoliaVendorRow[];
  integrations?: RawAlgoliaIntegrationRow[];
}) {
  const calls: Record<'product' | 'vendor' | 'integration', FindManyArgs[]> = {
    product: [],
    vendor: [],
    integration: [],
  };
  const prisma: BulkSyncPrisma = {
    product: {
      async findMany(args) {
        calls.product.push(args);
        return rows.products ?? [productRow];
      },
    },
    vendor: {
      async findMany(args) {
        calls.vendor.push(args);
        return rows.vendors ?? [vendorRow];
      },
    },
    integration: {
      async findMany(args) {
        calls.integration.push(args);
        return rows.integrations ?? [integrationRow];
      },
    },
  };
  return { prisma, calls };
}

type SaveCall = { indexName: string; objects: Record<string, unknown>[]; waitForTasks?: boolean };
type SettingsCall = { indexName: string };

function makeAlgolia() {
  const saves: SaveCall[] = [];
  const settings: SettingsCall[] = [];
  let taskID = 0;
  const algolia: AlgoliaBatchClient = {
    async setSettings(args) {
      settings.push({ indexName: args.indexName });
      return { taskID: ++taskID };
    },
    async waitForTask() {
      return undefined;
    },
    async saveObjects(args) {
      saves.push({
        indexName: args.indexName,
        objects: args.objects,
        waitForTasks: args.waitForTasks,
      });
      return [];
    },
  };
  return { algolia, saves, settings };
}

const silentLog = { log: () => undefined, warn: () => undefined };

// ── Tests ────────────────────────────────────────────────────────────────────

describe('runBulkSync', () => {
  it('reads promoted-only rows, applies settings, and upserts each index (en-US/staging)', async () => {
    const { prisma, calls } = makePrisma({});
    const { algolia, saves, settings } = makeAlgolia();

    const result = await runBulkSync(
      { prisma, algolia, log: silentLog },
      { env: 'staging', dryRun: false },
    );

    // Promoted-only filters + the AECI-137 select shapes.
    expect(calls.product[0]).toEqual({
      where: { promotionStatus: 'promoted' },
      select: algoliaProductSelect,
    });
    expect(calls.vendor[0]).toEqual({
      where: { promotionStatus: 'promoted' },
      select: algoliaVendorSelect,
    });
    expect(calls.integration[0]).toEqual({
      where: {
        sourceProduct: { promotionStatus: 'promoted' },
        targetProduct: { promotionStatus: 'promoted' },
      },
      select: algoliaIntegrationSelect,
    });

    // Settings applied to all three canonical indexes before upload.
    expect(settings.map((s) => s.indexName)).toEqual([
      'staging_products',
      'staging_vendors',
      'staging_integrations',
    ]);

    // One upsert per index, targeting the right index, carrying the UUID objectID.
    expect(saves.map((s) => s.indexName)).toEqual([
      'staging_products',
      'staging_vendors',
      'staging_integrations',
    ]);
    expect(saves[0]!.objects).toHaveLength(1);
    expect(saves[0]!.objects[0]!.objectID).toBe('11111111-1111-4111-8111-111111111111');
    expect(saves[0]!.waitForTasks).toBe(true);
    expect(saves[1]!.objects[0]!.objectID).toBe('22222222-2222-4222-8222-222222222222');
    expect(saves[2]!.objects[0]!.objectID).toBe('33333333-3333-4333-8333-333333333333');

    expect(result.settingsApplied).toBe(true);
    expect(result.entities).toEqual([
      { entity: 'products', indexName: 'staging_products', read: 1, uploaded: 1 },
      { entity: 'vendors', indexName: 'staging_vendors', read: 1, uploaded: 1 },
      { entity: 'integrations', indexName: 'staging_integrations', read: 1, uploaded: 1 },
    ]);
  });

  it('dry-run reads + validates but performs NO writes', async () => {
    const { prisma } = makePrisma({});
    const { algolia, saves, settings } = makeAlgolia();

    const result = await runBulkSync(
      { prisma, algolia, log: silentLog },
      { env: 'staging', dryRun: true },
    );

    expect(saves).toHaveLength(0);
    expect(settings).toHaveLength(0);
    expect(result.settingsApplied).toBe(false);
    expect(result.entities).toEqual([
      { entity: 'products', indexName: 'staging_products', read: 1, uploaded: 0 },
      { entity: 'vendors', indexName: 'staging_vendors', read: 1, uploaded: 0 },
      { entity: 'integrations', indexName: 'staging_integrations', read: 1, uploaded: 0 },
    ]);
  });

  it('handles 0 integration rows cleanly (index left empty, no throw)', async () => {
    const { prisma } = makePrisma({ integrations: [] });
    const { algolia, saves } = makeAlgolia();

    const result = await runBulkSync(
      { prisma, algolia, log: silentLog },
      { env: 'preview', dryRun: false },
    );

    // products + vendors uploaded; integrations skipped (no saveObjects).
    expect(saves.map((s) => s.indexName)).toEqual(['preview_products', 'preview_vendors']);
    expect(result.entities[2]).toEqual({
      entity: 'integrations',
      indexName: 'preview_integrations',
      read: 0,
      uploaded: 0,
    });
  });

  it('targets per-locale index names for a non-default locale (§7.6)', async () => {
    const { prisma } = makePrisma({});
    const { algolia, saves, settings } = makeAlgolia();

    await runBulkSync(
      { prisma, algolia, log: silentLog },
      { env: 'staging', locale: 'es', dryRun: false },
    );

    expect(settings.map((s) => s.indexName)).toEqual([
      'staging_products_es',
      'staging_vendors_es',
      'staging_integrations_es',
    ]);
    expect(saves.map((s) => s.indexName)).toEqual([
      'staging_products_es',
      'staging_vendors_es',
      'staging_integrations_es',
    ]);
  });

  it('skips the settings apply when skipSettings is set, but still uploads', async () => {
    const { prisma } = makePrisma({});
    const { algolia, saves, settings } = makeAlgolia();

    const result = await runBulkSync(
      { prisma, algolia, log: silentLog },
      { env: 'staging', dryRun: false, skipSettings: true },
    );

    expect(settings).toHaveLength(0);
    expect(result.settingsApplied).toBe(false);
    expect(saves).toHaveLength(3);
  });

  it('fails loud on a record that violates the schema, before any upload', async () => {
    // name '' violates AlgoliaProductRecordSchema (min(1)).
    const { prisma } = makePrisma({ products: [{ ...productRow, name: '' }] });
    const { algolia, saves } = makeAlgolia();

    await expect(
      runBulkSync({ prisma, algolia, log: silentLog }, { env: 'staging', dryRun: false }),
    ).rejects.toThrow();
    // Products are read first; the parse throws before products upload.
    expect(saves.map((s) => s.indexName)).not.toContain('staging_products');
  });
});
