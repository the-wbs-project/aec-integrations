/**
 * Unit tests for the §23.1 daily data-quality suite (AECI-241 / Phase 7.6) on the
 * Drizzle/D1 path. The in-memory harness (`makeTestDb`) seeds real rows and each
 * check runs its actual query against them — a positive fixture that must flag and
 * a negative fixture that must not. The logo probe injects a fake `fetch`; the
 * Algolia-drift reuse injects a fake `runDrift`. The orchestrator test covers the
 * best-effort capture (a throwing check becomes an `error` result).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AlgoliaIndexDrift } from './algolia-drift';
import {
  integrations,
  products,
  productVendors,
  profiles,
  reviews,
  statsCache,
  vendors,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  CHECKS,
  checkAlgoliaDrift,
  checkBrokenIntegrationRefs,
  checkDuplicateProducts,
  checkDuplicateVendors,
  checkLogo404Sample,
  checkProductsWithoutVendor,
  checkReviewsMissingAnonymizedAt,
  checkStaleReadyProducts,
  checkStaleStatsCache,
  checkVendorsWithoutProducts,
  hasErrors,
  hasFindings,
  runDataQualityChecks,
} from './data-quality';

const NOW = new Date('2026-06-24T04:00:00.000Z');
const OLD = '2026-01-01T00:00:00.000Z'; // >30d and >48h before NOW
const RECENT = '2026-06-23T20:00:00.000Z'; // <48h before NOW

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

// ── Seed helpers (defaults fill the non-null columns the schema requires) ──────

async function seedProduct(over: {
  id: string;
  name?: string;
  slug?: string;
  promotionStatus?: string;
  logoUrl?: string | null;
  updatedAt?: string;
}): Promise<void> {
  await t.db.insert(products).values({
    id: over.id,
    slug: over.slug ?? over.id,
    name: over.name ?? over.id,
    promotionStatus: over.promotionStatus ?? 'promoted',
    logoUrl: over.logoUrl ?? null,
    createdAt: over.updatedAt ?? RECENT,
    updatedAt: over.updatedAt ?? RECENT,
  });
}

async function seedVendor(over: {
  id: string;
  companyName?: string;
  slug?: string;
  logoUrl?: string | null;
  updatedAt?: string;
}): Promise<void> {
  await t.db.insert(vendors).values({
    id: over.id,
    slug: over.slug ?? over.id,
    companyName: over.companyName ?? over.id,
    logoUrl: over.logoUrl ?? null,
    createdAt: over.updatedAt ?? RECENT,
    updatedAt: over.updatedAt ?? RECENT,
  });
}

async function linkProductVendor(productId: string, vendorId: string): Promise<void> {
  await t.db.insert(productVendors).values({ productId, vendorId });
}

async function seedIntegration(over: {
  id: string;
  sourceProductId: string;
  targetProductId: string;
  name?: string;
}): Promise<void> {
  await t.db.insert(integrations).values({
    id: over.id,
    name: over.name ?? null,
    sourceProductId: over.sourceProductId,
    targetProductId: over.targetProductId,
  });
}

async function seedReview(over: {
  id: string;
  productId: string;
  reviewerId?: string | null;
  anonymizedAt?: string | null;
}): Promise<void> {
  await t.db.insert(reviews).values({
    id: over.id,
    productId: over.productId,
    reviewerId: over.reviewerId ?? null,
    anonymizedAt: over.anonymizedAt ?? null,
    ratingOverall: 4,
    ratingOnboarding: 4,
    title: 'T',
    body: 'B',
    status: 'approved',
  });
}

// ── #1 products without vendor ─────────────────────────────────────────────────

describe('checkProductsWithoutVendor', () => {
  it('flags only products with no product_vendors row', async () => {
    await seedProduct({ id: 'p1', name: 'Linked' });
    await seedProduct({ id: 'p2', name: 'Orphan' });
    await seedVendor({ id: 'v1' });
    await linkProductVendor('p1', 'v1');

    const { lines } = await checkProductsWithoutVendor(t.db);
    expect(lines).toEqual(['Orphan (p2)']);
  });

  it('is clean when every product has a vendor', async () => {
    await seedProduct({ id: 'p1' });
    await seedVendor({ id: 'v1' });
    await linkProductVendor('p1', 'v1');
    expect((await checkProductsWithoutVendor(t.db)).lines).toEqual([]);
  });
});

// ── #2 stale ready products ────────────────────────────────────────────────────

describe('checkStaleReadyProducts', () => {
  it('flags ready products unchanged for >30 days, not recent or non-ready ones', async () => {
    await seedProduct({ id: 'p1', name: 'StaleReady', promotionStatus: 'ready', updatedAt: OLD });
    await seedProduct({
      id: 'p2',
      name: 'FreshReady',
      promotionStatus: 'ready',
      updatedAt: RECENT,
    });
    await seedProduct({
      id: 'p3',
      name: 'OldPromoted',
      promotionStatus: 'promoted',
      updatedAt: OLD,
    });

    const { lines } = await checkStaleReadyProducts(t.db, NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('StaleReady (p1)');
  });
});

// ── #3 broken integration refs ─────────────────────────────────────────────────

describe('checkBrokenIntegrationRefs', () => {
  it('flags integrations whose source or target product was pulled', async () => {
    await seedProduct({ id: 'p1', name: 'Live', promotionStatus: 'promoted' });
    await seedProduct({ id: 'p2', name: 'Pulled', promotionStatus: 'retracted' });
    await seedProduct({ id: 'p3', name: 'AlsoLive', promotionStatus: 'promoted' });
    await seedIntegration({
      id: 'i1',
      name: 'Broken',
      sourceProductId: 'p1',
      targetProductId: 'p2',
    });
    await seedIntegration({
      id: 'i2',
      name: 'Healthy',
      sourceProductId: 'p1',
      targetProductId: 'p3',
    });

    const { lines } = await checkBrokenIntegrationRefs(t.db);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Broken');
    expect(lines[0]).toContain('retracted');
  });
});

// ── #4 vendors without products ────────────────────────────────────────────────

describe('checkVendorsWithoutProducts', () => {
  it('flags only vendors with no product_vendors row', async () => {
    await seedVendor({ id: 'v1', companyName: 'Linked' });
    await seedVendor({ id: 'v2', companyName: 'Orphan' });
    await seedProduct({ id: 'p1' });
    await linkProductVendor('p1', 'v1');

    expect((await checkVendorsWithoutProducts(t.db)).lines).toEqual(['Orphan (v2)']);
  });
});

// ── #5 anonymized reviews missing anonymized_at ────────────────────────────────

describe('checkReviewsMissingAnonymizedAt', () => {
  it('flags reviewer_id NULL with anonymized_at NULL only', async () => {
    await seedProduct({ id: 'p1' });
    // r3 keeps a reviewer, so its FK needs a real profile (the harness enforces FKs).
    await t.db.insert(profiles).values({ id: 'u1' });
    await seedReview({ id: 'r1', productId: 'p1', reviewerId: null, anonymizedAt: null }); // defect
    await seedReview({ id: 'r2', productId: 'p1', reviewerId: null, anonymizedAt: OLD }); // ok (stamped)
    await seedReview({ id: 'r3', productId: 'p1', reviewerId: 'u1', anonymizedAt: null }); // ok (has reviewer)

    const { lines } = await checkReviewsMissingAnonymizedAt(t.db);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('r1');
  });
});

// ── #6 stale stats_cache ───────────────────────────────────────────────────────

describe('checkStaleStatsCache', () => {
  it('flags rows older than 48h', async () => {
    await t.db.insert(statsCache).values({ key: 'home.fresh', value: 1, computedAt: RECENT });
    await t.db.insert(statsCache).values({ key: 'home.stale', value: 2, computedAt: OLD });

    const { lines } = await checkStaleStatsCache(t.db, NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('home.stale');
  });
});

// ── #7 duplicate vendors ───────────────────────────────────────────────────────

describe('checkDuplicateVendors', () => {
  it('groups case/whitespace-insensitive company-name collisions', async () => {
    await seedVendor({ id: 'v1', companyName: 'Acme Co', slug: 'acme-1' });
    await seedVendor({ id: 'v2', companyName: 'acme  co', slug: 'acme-2' });
    await seedVendor({ id: 'v3', companyName: 'Distinct Inc', slug: 'distinct' });

    const { lines } = await checkDuplicateVendors(t.db);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('2×');
    expect(lines[0]).toContain('Acme Co');
  });
});

// ── #8 duplicate products per vendor ───────────────────────────────────────────

describe('checkDuplicateProducts', () => {
  it('flags same product name within one vendor, not across vendors', async () => {
    await seedVendor({ id: 'v1', companyName: 'VendorOne' });
    await seedVendor({ id: 'v2', companyName: 'VendorTwo' });
    await seedProduct({ id: 'p1', name: 'Revit', slug: 'revit-1' });
    await seedProduct({ id: 'p2', name: 'revit', slug: 'revit-2' });
    await seedProduct({ id: 'p3', name: 'Revit', slug: 'revit-3' });
    await linkProductVendor('p1', 'v1');
    await linkProductVendor('p2', 'v1'); // dup within v1
    await linkProductVendor('p3', 'v2'); // same name but other vendor → not a dup

    const { lines } = await checkDuplicateProducts(t.db);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('VendorOne');
    expect(lines[0]).toContain('2×');
  });
});

// ── #9 logo 404 sample ─────────────────────────────────────────────────────────

describe('checkLogo404Sample', () => {
  it('flags only logo URLs that return HTTP 404', async () => {
    await seedProduct({ id: 'p1', name: 'Good', logoUrl: 'https://logo/ok.png' });
    await seedProduct({ id: 'p2', name: 'Gone', logoUrl: 'https://logo/404.png' });
    await seedVendor({ id: 'v1', companyName: 'NoLogo', logoUrl: null });

    const fakeFetch = (async (url: string | URL) =>
      new Response(null, {
        status: String(url).includes('404') ? 404 : 200,
      })) as unknown as typeof fetch;

    const { lines, note } = await checkLogo404Sample(t.db, fakeFetch, 20);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Gone');
    expect(note).toContain('sampled');
  });

  it('does not flag network errors (only definitive 404s)', async () => {
    await seedProduct({ id: 'p1', name: 'Flaky', logoUrl: 'https://logo/boom.png' });
    const throwingFetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect((await checkLogo404Sample(t.db, throwingFetch, 20)).lines).toEqual([]);
  });
});

// ── #10 algolia drift (reuse) ──────────────────────────────────────────────────

describe('checkAlgoliaDrift', () => {
  it('flags drifted indexes from the injected count', async () => {
    const rows: AlgoliaIndexDrift[] = [
      { entity: 'products', indexName: 'prod_products', database: 43, algolia: 43, drift: 0 },
      { entity: 'vendors', indexName: 'prod_vendors', database: 30, algolia: 28, drift: 2 },
    ];
    const { lines, skipped } = await checkAlgoliaDrift(async () => rows);
    expect(skipped).toBeFalsy();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('prod_vendors');
    expect(lines[0]).toContain('+2');
  });

  it('skips when no drift closure is provided (no creds)', async () => {
    const finding = await checkAlgoliaDrift(undefined);
    expect(finding.skipped).toBe(true);
    expect(finding.lines).toEqual([]);
  });
});

// ── orchestrator ───────────────────────────────────────────────────────────────

describe('runDataQualityChecks', () => {
  it('returns one result per check and aggregates findings', async () => {
    await seedProduct({ id: 'p1', name: 'Orphan' }); // trips #1
    const results = await runDataQualityChecks({ db: t.db, now: NOW });

    expect(results).toHaveLength(CHECKS.length);
    const orphan = results.find((r) => r.id === 'products_without_vendor');
    expect(orphan?.count).toBe(1);
    // No Algolia creds → drift check skipped.
    expect(results.find((r) => r.id === 'algolia_index_drift')?.skipped).toBe(true);
    expect(hasFindings(results)).toBe(true);
    expect(hasErrors(results)).toBe(false);
  });

  it('captures a thrown check as an error result without aborting the rest', async () => {
    // A runDrift that throws makes the drift check error; the other nine still run.
    const results = await runDataQualityChecks({
      db: t.db,
      now: NOW,
      runDrift: async () => {
        throw new Error('algolia unreachable');
      },
    });
    expect(results).toHaveLength(CHECKS.length);
    const drift = results.find((r) => r.id === 'algolia_index_drift');
    expect(drift?.error).toContain('algolia unreachable');
    expect(hasErrors(results)).toBe(true);
  });
});
