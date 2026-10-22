/**
 * Unit tests for the §23.1 daily data-quality suite (AECI-241 / Phase 7.6) on the
 * Drizzle/D1 path. The in-memory harness (`makeTestDb`) seeds real rows and each
 * check runs its actual query against them — a positive fixture that must flag and
 * a negative fixture that must not. The logo probe injects a fake `fetch`; the
 * Algolia-drift reuse injects a fake `runDrift`. The orchestrator test covers the
 * best-effort capture (a throwing check becomes an `error` result).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WORKER_CONNECTION_LIMIT } from '@aeci/shared/concurrency';

import type { AlgoliaIndexDrift } from './algolia-drift';
import {
  billingAccounts,
  licenses,
  mailingList,
  ownershipSyncDeliveries,
  pageViews,
  products,
  productVendors,
  profiles,
  reviews,
  statsCache,
  taxonomyAudiences,
  taxonomyCategories,
  taxonomyDataObjects,
  taxonomyPhases,
  taxonomyTrades,
  vendors,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { ARRIVAL_CF_COVERAGE_MIN } from './arrival-coverage';
import {
  CHECKS,
  checkAlgoliaDrift,
  checkArrivalCfCoverage,
  checkDuplicateProducts,
  checkDuplicateVendors,
  checkLandingCfCoverage,
  checkLicenseMirrorDrift,
  checkLogo404Sample,
  checkOwnershipSyncUnknownVendor,
  checkProductsWithoutVendor,
  checkReviewMirrorDrift,
  checkReviewsMissingAnonymizedAt,
  checkPromotionStatusInvariant,
  checkStaleStatsCache,
  checkTaxonomyMissingDescription,
  checkVendorsWithoutProducts,
  hasErrors,
  hasFindings,
  LANDING_CF_COVERAGE_MIN,
  LANDING_CF_COVERAGE_MIN_ROWS,
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
  promotionStatus?: string;
  logoUrl?: string | null;
  updatedAt?: string;
  ownedAt?: string | null;
}): Promise<void> {
  await t.db.insert(vendors).values({
    id: over.id,
    slug: over.slug ?? over.id,
    companyName: over.companyName ?? over.id,
    // Defaults to the production shape, not the schema default `'pending'` — every
    // other check's fixtures would otherwise trip `promotion_status_invariant`.
    promotionStatus: over.promotionStatus ?? 'promoted',
    logoUrl: over.logoUrl ?? null,
    ownedAt: over.ownedAt ?? null,
    createdAt: over.updatedAt ?? RECENT,
    updatedAt: over.updatedAt ?? RECENT,
  });
}

async function linkProductVendor(productId: string, vendorId: string): Promise<void> {
  await t.db.insert(productVendors).values({ productId, vendorId });
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

// ── #13 taxonomy terms with no description (AECI-962 / AECI-926) ──────────────

describe('checkTaxonomyMissingDescription', () => {
  const stamp = { createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };

  it('flags a promote-minted term and leaves the seeded ones alone', async () => {
    // The minted shape, exactly as `resolveTaxonomy` writes it: id, slug and name,
    // with description and display_order left NULL.
    await t.db.insert(taxonomyCategories).values([
      {
        id: 'c1',
        slug: 'reality-capture',
        name: 'Reality Capture',
        description: 'Laser scanning, photogrammetry, and point clouds converted into models.',
        displayOrder: 250,
        ...stamp,
      },
      {
        id: 'c2',
        slug: 'reality-capture-scan-to-bim',
        name: 'Reality Capture (Scan-to-BIM)',
        ...stamp,
      },
    ]);

    const { lines } = await checkTaxonomyMissingDescription(t.db);
    expect(lines).toEqual(['Reality Capture (Scan-to-BIM) (category/reality-capture-scan-to-bim)']);
  });

  it('treats a whitespace-only description as missing', async () => {
    // A blank string is not NULL, so `IS NULL` alone reads it as populated — and it
    // renders as an empty paragraph and an empty meta description just the same.
    await t.db
      .insert(taxonomyPhases)
      .values({ id: 'ph1', slug: 'design', name: 'Design', description: '   ', ...stamp });

    expect((await checkTaxonomyMissingDescription(t.db)).lines).toEqual(['Design (phase/design)']);
  });

  it('covers all five taxonomy tables, not just the mintable three', async () => {
    await t.db
      .insert(taxonomyCategories)
      .values({ id: 'c1', slug: 'robotics', name: 'Robotics', ...stamp });
    await t.db
      .insert(taxonomyAudiences)
      .values({ id: 'a1', slug: 'estimator', name: 'Estimator', ...stamp });
    await t.db
      .insert(taxonomyPhases)
      .values({ id: 'ph1', slug: 'design', name: 'Design', ...stamp });
    await t.db
      .insert(taxonomyTrades)
      // `taxonomy_trades.description` is NOT NULL (schema.ts), so the only shape a
      // trade can fail in is the blank string. That is why the check tests `trim() = ''`
      // and not just `IS NULL`.
      .values({ id: 'tr1', slug: 'roofing', name: 'Roofing', description: '', ...stamp });
    await t.db
      .insert(taxonomyDataObjects)
      .values({ id: 'do1', slug: 'rfis', name: 'RFIs', ...stamp });

    const { lines } = await checkTaxonomyMissingDescription(t.db);
    expect(lines.sort()).toEqual([
      'Design (phase/design)',
      'Estimator (audience/estimator)',
      'RFIs (data_object/rfis)',
      'Robotics (category/robotics)',
      'Roofing (trade/roofing)',
    ]);
  });

  it('is clean when every term carries a description', async () => {
    await t.db.insert(taxonomyCategories).values({
      id: 'c1',
      slug: 'robotics',
      name: 'Robotics',
      description: 'Physical robots.',
      ...stamp,
    });
    expect((await checkTaxonomyMissingDescription(t.db)).lines).toEqual([]);
  });

  it('is registered at error severity — a null description ships a default meta tag', async () => {
    const spec = CHECKS.find((c) => c.id === 'taxonomy_missing_description');
    expect(spec?.severity).toBe('error');
  });
});

// ── #2 promotion-status invariant (AECI-592) ──────────────────────────────────

describe('checkPromotionStatusInvariant', () => {
  it('passes against the production shape — every product and vendor promoted', async () => {
    await seedProduct({ id: 'p1', name: 'Revit' });
    await seedProduct({ id: 'p2', name: 'Procore' });
    await seedVendor({ id: 'v1', companyName: 'Autodesk' });
    await linkProductVendor('p1', 'v1');

    const { lines } = await checkPromotionStatusInvariant(t.db);
    expect(lines).toEqual([]);
  });

  it('flags a product that is not promoted, naming its status', async () => {
    await seedProduct({ id: 'p1', name: 'Live' });
    await seedProduct({ id: 'p2', name: 'Pulled', promotionStatus: 'retracted' });

    const { lines } = await checkPromotionStatusInvariant(t.db);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('product "Pulled" (p2)');
    expect(lines[0]).toContain('retracted');
  });

  it('flags a vendor left on the schema default `pending`', async () => {
    await seedVendor({ id: 'v1', companyName: 'Autodesk' });
    await seedVendor({ id: 'v2', companyName: 'Unpromoted Co', promotionStatus: 'pending' });

    const { lines } = await checkPromotionStatusInvariant(t.db);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('vendor "Unpromoted Co" (v2)');
    expect(lines[0]).toContain('pending');
  });

  it('reports products and vendors together, products first', async () => {
    await seedProduct({ id: 'p1', name: 'Pulled', promotionStatus: 'rejected' });
    await seedVendor({ id: 'v1', companyName: 'Stalled Co', promotionStatus: 'ready' });

    const { lines } = await checkPromotionStatusInvariant(t.db);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('product "Pulled"');
    expect(lines[1]).toContain('vendor "Stalled Co"');
  });

  it('is registered at `error` severity — a silent violation breaks the catalog series', () => {
    const spec = CHECKS.find((c) => c.id === 'promotion_status_invariant');
    expect(spec?.severity).toBe('error');
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

  // ── AECI-666: connection hygiene ────────────────────────────────────────────

  it('probes in bounded waves, never all at once', async () => {
    // `DEFAULT_LOGO_SAMPLE` is 20, more than three times what a Worker
    // invocation may hold open at once. A bare `Promise.all` over the sample
    // opened all of them; past the limit the runtime cancels the stalled
    // responses into `fetch` promises that never settle.
    // The sample is split evenly between products and vendors (`half`), so seed
    // both to reach a full 20-URL candidate set.
    for (let i = 0; i < 10; i++) {
      await seedProduct({ id: `p${i}`, name: `P${i}`, logoUrl: `https://logo/p${i}.png` });
      await seedVendor({ id: `v${i}`, companyName: `V${i}`, logoUrl: `https://logo/v${i}.png` });
    }

    let inFlight = 0;
    let peak = 0;
    const slowFetch = (async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const { note } = await checkLogo404Sample(t.db, slowFetch, 20);
    expect(note).toContain('sampled 20');
    expect(peak).toBeLessThanOrEqual(WORKER_CONNECTION_LIMIT);
  });

  it('releases the probe response body', async () => {
    await seedProduct({ id: 'p1', name: 'Logo', logoUrl: 'https://logo/x.png' });
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => c.enqueue(new TextEncoder().encode('x')),
      cancel: () => {
        cancelled = true;
      },
    });
    const bodyFetch = (async () =>
      new Response(stream, { status: 200 })) as unknown as typeof fetch;

    await checkLogo404Sample(t.db, bodyFetch, 20);
    await new Promise((r) => setTimeout(r, 0));
    // Only `res.status` is inspected, so nothing reads this body — an unread
    // body keeps holding its connection (AECI-666).
    expect(cancelled).toBe(true);
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

// ── license_mirror_drift (AECI-1354) ─────────────────────────────────────────

describe('checkLicenseMirrorDrift', () => {
  /** Seed a vendor, its billing account, and one license per entry of `ended`
   *  (`null` = live, a timestamp = ended). */
  async function seedVendor(
    id: string,
    slug: string,
    verified: boolean,
    ended: (string | null)[],
  ): Promise<void> {
    await t.db.insert(vendors).values({ id, slug, companyName: slug, verified });
    if (ended.length === 0) return;
    await t.db.insert(billingAccounts).values({ id: `ba-${id}`, vendorId: id, name: slug });
    await t.db.insert(licenses).values(
      ended.map((endedAt, i) => ({
        id: `l-${id}-${i}`,
        billingAccountId: `ba-${id}`,
        source: 'complimentary',
        startsAt: OLD,
        endsAt: null,
        endedAt,
        endReason: endedAt ? 'revoked' : null,
      })),
    );
  }

  it('flags a verified vendor with no license at all', async () => {
    await seedVendor('v1', 'autodesk', true, []);
    const { lines } = await checkLicenseMirrorDrift(t.db);
    expect(lines).toEqual(['autodesk (autodesk) — verified=1, no live license']);
  });

  it('flags a verified vendor whose every license has ended', async () => {
    // Live is stored state: an ended license does not back the mirror.
    await seedVendor('v1', 'bluebeam', true, [RECENT]);
    const { lines } = await checkLicenseMirrorDrift(t.db);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('no live license');
  });

  it('flags the reverse half: a live license on an unverified vendor', async () => {
    await seedVendor('v1', 'procore', false, [null, null, RECENT]);
    const { lines } = await checkLicenseMirrorDrift(t.db);
    expect(lines).toEqual(['procore (procore) — verified=0, 2 live license(s)']);
  });

  it('is clean for every in-sync shape', async () => {
    await seedVendor('v1', 'autodesk', true, [null, RECENT]); // live license backs verified
    await seedVendor('v2', 'free-co', false, []); // Free, no account
    await seedVendor('v3', 'gone-co', false, [RECENT]); // ended history only
    expect((await checkLicenseMirrorDrift(t.db)).lines).toEqual([]);
  });

  // `error` since AECI-1355. It is Guard 2 of the mirror now that AECI-1375
  // retired `entitlement_mirror_drift`, which must not come back.
  it('is registered at `error` severity, and the entitlement check is retired', () => {
    const ids = CHECKS.map((c) => c.id);
    expect(ids).not.toContain('entitlement_mirror_drift');
    expect(CHECKS.find((c) => c.id === 'license_mirror_drift')?.severity).toBe('error');
  });
});

// ── ownership sync: unknown vendor (AECI-1418) ────────────────────────────────

describe('checkOwnershipSyncUnknownVendor', () => {
  const row = (vendorId: string, outcome: string, httpStatus: number | null, at: string) => ({
    vendorId,
    reason: 'claim_approved',
    attempt: 1,
    outcome: outcome as 'permanent',
    httpStatus,
    createdAt: at,
  });

  it('flags a vendor whose LATEST delivery was a 404, and clears one a later delivery fixed', async () => {
    await t.db
      .insert(ownershipSyncDeliveries)
      .values([
        row('v-unknown', 'permanent', 404, '2026-06-23T01:00:00.000Z'),
        row('v-fixed', 'permanent', 404, '2026-06-23T01:00:00.000Z'),
        row('v-fixed', 'delivered', 200, '2026-06-23T02:00:00.000Z'),
        row('v-auth', 'permanent', 401, '2026-06-23T01:00:00.000Z'),
      ]);
    const { lines } = await checkOwnershipSyncUnknownVendor(t.db);
    expect(lines).toEqual([
      'vendor v-unknown: the review app answered 404 (unknown vendor) at 2026-06-23T01:00:00.000Z',
    ]);
  });

  it('is clean on an empty ledger, and registered at warn', async () => {
    expect((await checkOwnershipSyncUnknownVendor(t.db)).lines).toEqual([]);
    expect(CHECKS.find((c) => c.id === 'ownership_sync_unknown_vendor')?.severity).toBe('warn');
  });
});

// ── #12 arrival CF coverage (AECI-868) ────────────────────────────────────────

describe('checkArrivalCfCoverage', () => {
  // `NOW` is 2026-06-24T04:00Z (the cron's hour), so the window is the preceding
  // 24 h. These timestamps sit either side of it.
  const IN_WINDOW = '2026-06-23T18:00:00.000Z';
  const BEFORE_WINDOW = '2026-06-22T18:00:00.000Z';

  async function seedArrivals(
    withAsn: number,
    withoutAsn: number,
    createdAt = IN_WINDOW,
  ): Promise<void> {
    for (let i = 0; i < withAsn; i++) {
      await t.db
        .insert(pageViews)
        .values({ path: '/products/procore', navigation: 'arrival', cfAsn: 23700, createdAt });
    }
    for (let i = 0; i < withoutAsn; i++) {
      await t.db
        .insert(pageViews)
        .values({ path: '/products/procore', navigation: 'arrival', cfAsn: null, createdAt });
    }
  }

  it('passes with no arrivals at all — an empty night is not a telemetry defect', async () => {
    const finding = await checkArrivalCfCoverage(t.db, NOW);
    expect(finding.lines).toEqual([]);
    expect(finding.note).toContain('no full-document arrivals');
  });

  it('passes when coverage is exactly at the floor', async () => {
    await seedArrivals(19, 1); // 95.0% — the boundary must not fail
    const finding = await checkArrivalCfCoverage(t.db, NOW);
    expect(finding.lines).toEqual([]);
    expect(finding.note).toContain('19/20');
    expect(finding.note).toContain('95.0%');
  });

  it('fails when coverage is below the floor, naming the shortfall and the cause', async () => {
    await seedArrivals(0, 12); // the AECI-868 production shape: arrivals, zero ASNs
    const finding = await checkArrivalCfCoverage(t.db, NOW);
    expect(finding.lines).toHaveLength(1);
    expect(finding.lines[0]).toContain('12 of 12');
    expect(finding.lines[0]).toContain('NULL cf_asn');
    expect(finding.lines[0]).toContain('AECI-868');
    expect(finding.note).toContain('0/12');
  });

  it('fails on a partial regression, not only a total one', async () => {
    await seedArrivals(9, 11); // 45%
    const finding = await checkArrivalCfCoverage(t.db, NOW);
    expect(finding.lines).toHaveLength(1);
    expect(finding.lines[0]).toContain('11 of 20');
    expect(finding.lines[0]).toContain('45.0%');
  });

  it('ignores rows outside the 24h window', async () => {
    await seedArrivals(0, 50, BEFORE_WINDOW); // an older outage, already reported
    await seedArrivals(5, 0);
    const finding = await checkArrivalCfCoverage(t.db, NOW);
    expect(finding.lines).toEqual([]);
    expect(finding.note).toContain('5/5');
  });

  it('ignores `spa` rows, which never lost their metadata', async () => {
    await t.db.insert(pageViews).values({
      path: '/products/procore',
      navigation: 'spa',
      cfAsn: 23700,
      createdAt: IN_WINDOW,
    });
    await seedArrivals(0, 4);
    const finding = await checkArrivalCfCoverage(t.db, NOW);
    // The four NULL arrivals are the whole population — a healthy SPA row must
    // not be allowed to lift the ratio back over the floor.
    expect(finding.lines).toHaveLength(1);
    expect(finding.lines[0]).toContain('4 of 4');
  });

  it('is registered at `error` severity — a silent telemetry outage is not a warning', () => {
    const spec = CHECKS.find((c) => c.id === 'arrival_cf_coverage');
    expect(spec).toBeDefined();
    expect(spec!.severity).toBe('error');
    expect(ARRIVAL_CF_COVERAGE_MIN).toBe(0.95);
  });
});

// ── #13 landing CF coverage (AECI-876) ────────────────────────────────────────

describe('checkLandingCfCoverage', () => {
  // `NOW` is 2026-06-24T04:00Z, so the window is the preceding 30 days. These
  // timestamps sit either side of it.
  const IN_WINDOW = '2026-06-10T12:00:00.000Z';
  const BEFORE_WINDOW = '2026-05-01T12:00:00.000Z';

  let seq = 0;
  async function seedSignups(
    withAsn: number,
    withoutAsn: number,
    createdAt = IN_WINDOW,
  ): Promise<void> {
    // `mailing_list.email` is uniquely indexed, so every row needs its own
    // address — a shared one would silently collapse the denominator.
    for (let i = 0; i < withAsn; i++) {
      await t.db
        .insert(mailingList)
        .values({ email: `s${seq++}@example.com`, asn: 23700, createdAt });
    }
    for (let i = 0; i < withoutAsn; i++) {
      await t.db
        .insert(mailingList)
        .values({ email: `s${seq++}@example.com`, asn: null, createdAt });
    }
  }

  it('passes with no signups at all — an empty window is not a telemetry defect', async () => {
    const finding = await checkLandingCfCoverage(t.db, NOW);
    expect(finding.lines).toEqual([]);
    expect(finding.note).toContain('nothing to measure');
  });

  it('passes below the row minimum even when every row is NULL', async () => {
    // Nine all-NULL signups is 0% coverage, and it must still pass: a denominator
    // this small cannot tell an outage from one odd row, and a check that fires
    // on it would be noise rather than signal.
    await seedSignups(0, LANDING_CF_COVERAGE_MIN_ROWS - 1);
    const finding = await checkLandingCfCoverage(t.db, NOW);
    expect(finding.lines).toEqual([]);
    expect(finding.note).toContain('below the');
    expect(finding.note).toContain('nothing to measure');
  });

  it('passes at exactly the floor, on exactly the minimum denominator', async () => {
    // 9/10 = 90.0%. This is the case the two constants were chosen together for:
    // one legitimate NULL on the smallest measurable window must not fail. A
    // later change to either constant has to confront this test.
    await seedSignups(9, 1);
    const finding = await checkLandingCfCoverage(t.db, NOW);
    expect(finding.lines).toEqual([]);
    expect(finding.note).toContain('9/10');
    expect(finding.note).toContain('90.0%');
  });

  it('fails when the window loses its metadata entirely, naming the right cause', async () => {
    await seedSignups(0, 12);
    const finding = await checkLandingCfCoverage(t.db, NOW);
    expect(finding.lines).toHaveLength(1);
    expect(finding.lines[0]).toContain('12 of 12');
    expect(finding.lines[0]).toContain('NULL asn');
    expect(finding.lines[0]).toContain('withForwardedLandingCf');
    // The landing path is a POST, so the AECI-868 gateway override cannot be the
    // cause. The line must say so rather than send a reader to the wrong file.
    expect(finding.lines[0]).toContain('AECI-868 cache-gateway cf override is NOT');
    expect(finding.note).toContain('0/12');
  });

  it('fails on a partial regression, not only a total one', async () => {
    await seedSignups(8, 2); // 80%
    const finding = await checkLandingCfCoverage(t.db, NOW);
    expect(finding.lines).toHaveLength(1);
    expect(finding.lines[0]).toContain('2 of 10');
    expect(finding.lines[0]).toContain('80.0%');
  });

  it('ignores signups outside the 30-day window', async () => {
    await seedSignups(0, 50, BEFORE_WINDOW); // an older outage, already past
    await seedSignups(10, 0);
    const finding = await checkLandingCfCoverage(t.db, NOW);
    expect(finding.lines).toEqual([]);
    expect(finding.note).toContain('10/10');
  });

  it('is registered at `warn` — it invalidates no figure, so it must not page', () => {
    const spec = CHECKS.find((c) => c.id === 'landing_cf_coverage');
    expect(spec).toBeDefined();
    // `error` would route this to the ERROR alert (POST_LAUNCH_MONITORING §1 row
    // 5a). The column's only reader is the `/admin/audience` ASN breakdown, so a
    // failure is a lost
    // attribute rather than an unusable day.
    expect(spec!.severity).toBe('warn');
    expect(LANDING_CF_COVERAGE_MIN).toBe(0.9);
    expect(LANDING_CF_COVERAGE_MIN_ROWS).toBe(10);
    // The pairing invariant, stated as the case rather than as the algebra
    // (`1 / (1 - 0.9)` is 10.000000000000002 in float, which would make the
    // algebraic form fail on the exact values it is meant to accept): one
    // legitimate NULL on the smallest measurable window must still pass.
    const oneNullAtMinimum = (LANDING_CF_COVERAGE_MIN_ROWS - 1) / LANDING_CF_COVERAGE_MIN_ROWS;
    expect(oneNullAtMinimum).toBeGreaterThanOrEqual(LANDING_CF_COVERAGE_MIN);
  });
});

// ── review_mirror_drift (AECI-1455) ─────────────────────────────────────────────

describe('checkReviewMirrorDrift', () => {
  const BASE = 'https://review.example/ownership';
  const TOKEN = 'review-token';
  const ENV_V2 = {
    REVIEW_APP_OWNERSHIP_URL: BASE,
    REVIEW_APP_OWNERSHIP_TOKEN: TOKEN,
    REVIEW_APP_MIRROR_SCHEMA: '2',
  };
  const HASH_A = 'a'.repeat(64);
  const HASH_B = 'b'.repeat(64);
  const vid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  /** A `buildRecord` that hashes every vendor to `hashes[id]`, else HASH_A. */
  const builder = (hashes: Record<string, string | null> = {}) =>
    vi.fn(async (_db: unknown, vendorId: string) => {
      const h = vendorId in hashes ? hashes[vendorId] : HASH_A;
      return h === null ? null : { recordHash: h! };
    });

  /** A versions endpoint that answers from `held`, recording each call. */
  function versionsFetch(held: Record<string, { version?: number; recordHash: string | null }>) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const ids = new URL(url).searchParams.get('ids')!.split(',');
      const out = ids
        .filter((id) => id in held)
        .map((id) => ({
          vendorId: id,
          version: held[id]!.version ?? 3,
          recordHash: held[id]!.recordHash,
        }));
      return new Response(JSON.stringify({ vendors: out }), { status: 200 });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  async function seedOwned(...ids: string[]): Promise<void> {
    for (const id of ids) await seedVendor({ id, ownedAt: OLD });
  }

  it('is clean when every owned vendor hash matches, and ignores unowned vendors', async () => {
    await seedOwned(vid(1), vid(2));
    await seedVendor({ id: vid(3) }); // not owned: never built, never asked about
    const build = builder();
    const { impl, calls } = versionsFetch({
      [vid(1)]: { recordHash: HASH_A },
      [vid(2)]: { recordHash: HASH_A },
    });
    const out = await checkReviewMirrorDrift(t.db, {
      env: ENV_V2,
      buildRecord: build,
      fetchImpl: impl,
    });
    expect(out.skipped).toBeUndefined();
    expect(out.lines).toEqual([]);
    expect(build).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/vendors?ids=${vid(1)},${vid(2)}`);
    expect(calls[0]!.init?.method).toBe('GET');
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('flags a hash mismatch, a vendor missing on the review side, and a v1-only record', async () => {
    await seedOwned(vid(1), vid(2), vid(3), vid(4));
    const { impl } = versionsFetch({
      [vid(1)]: { recordHash: HASH_A }, // match
      [vid(2)]: { recordHash: HASH_B, version: 7 }, // mismatch
      // vid(3) absent: missing
      [vid(4)]: { recordHash: null, version: 2 }, // v1 only
    });
    const out = await checkReviewMirrorDrift(t.db, {
      env: ENV_V2,
      buildRecord: builder(),
      fetchImpl: impl,
    });
    expect(out.lines).toEqual([
      `vendor ${vid(2)}: hash differs (review version 7 holds bbbbbbbbbbbb, live builds aaaaaaaaaaaa)`,
      `vendor ${vid(3)}: missing on the review side`,
      `vendor ${vid(4)}: the review side holds no v2 record (version 2)`,
    ]);
  });

  it('skips a vendor whose record builds to null (row gone between reads)', async () => {
    await seedOwned(vid(1), vid(2));
    const { impl, calls } = versionsFetch({ [vid(1)]: { recordHash: HASH_A } });
    const out = await checkReviewMirrorDrift(t.db, {
      env: ENV_V2,
      buildRecord: builder({ [vid(2)]: null }),
      fetchImpl: impl,
    });
    expect(out.lines).toEqual([]);
    expect(calls[0]!.url).toBe(`${BASE}/vendors?ids=${vid(1)}`);
  });

  it('counts a vendor whose build throws as build_failed and still checks the rest', async () => {
    await seedOwned(vid(1), vid(2), vid(3));
    const long = `products[0].content.name: ${'x'.repeat(400)}`;
    const build = vi.fn(async (_db: unknown, vendorId: string) => {
      if (vendorId === vid(2)) throw new Error(long);
      return { recordHash: HASH_A };
    });
    const { impl, calls } = versionsFetch({
      [vid(1)]: { recordHash: HASH_A },
      [vid(3)]: { recordHash: HASH_B, version: 4 },
    });
    const out = await checkReviewMirrorDrift(t.db, {
      env: ENV_V2,
      buildRecord: build,
      fetchImpl: impl,
    });
    // The failed vendor is not asked about; the others are still compared.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/vendors?ids=${vid(1)},${vid(3)}`);
    expect(out.lines).toEqual([
      `vendor ${vid(2)}: build_failed (${long.slice(0, 200)}…)`,
      `vendor ${vid(3)}: hash differs (review version 4 holds bbbbbbbbbbbb, live builds aaaaaaaaaaaa)`,
    ]);

    // Through the orchestrator it is a finding, not an errored check.
    const results = await runDataQualityChecks({
      db: t.db,
      now: NOW,
      reviewMirror: { env: ENV_V2, buildRecord: build, fetchImpl: impl },
    });
    const drift = results.find((r) => r.id === 'review_mirror_drift');
    expect(drift?.error).toBeUndefined();
    expect(drift?.count).toBe(2);
  });

  it('reports build_failed lines and makes no request when every build throws', async () => {
    await seedOwned(vid(1));
    const { impl, calls } = versionsFetch({});
    const out = await checkReviewMirrorDrift(t.db, {
      env: ENV_V2,
      buildRecord: vi.fn(async () => {
        throw new Error('bad stored value');
      }),
      fetchImpl: impl,
    });
    expect(out.lines).toEqual([`vendor ${vid(1)}: build_failed (bad stored value)`]);
    expect(calls).toHaveLength(0);
  });

  it('makes no request when no vendor is owned', async () => {
    await seedVendor({ id: vid(1) });
    const { impl, calls } = versionsFetch({});
    const out = await checkReviewMirrorDrift(t.db, {
      env: ENV_V2,
      buildRecord: builder(),
      fetchImpl: impl,
    });
    expect(out).toEqual({ lines: [], note: 'no owned vendors' });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['not wired', undefined, 'not wired'],
    [
      'URL unset',
      { ...ENV_V2, REVIEW_APP_OWNERSHIP_URL: undefined },
      'REVIEW_APP_OWNERSHIP_URL unset',
    ],
    ['URL blank', { ...ENV_V2, REVIEW_APP_OWNERSHIP_URL: '  ' }, 'REVIEW_APP_OWNERSHIP_URL unset'],
    [
      'token unset',
      { ...ENV_V2, REVIEW_APP_OWNERSHIP_TOKEN: undefined },
      'REVIEW_APP_OWNERSHIP_TOKEN unset',
    ],
    ['schema "1"', { ...ENV_V2, REVIEW_APP_MIRROR_SCHEMA: '1' }, 'is not "2"'],
    ['schema unset', { ...ENV_V2, REVIEW_APP_MIRROR_SCHEMA: undefined }, 'is not "2"'],
  ])('is skipped when %s, with no build and no request', async (_label, env, note) => {
    await seedOwned(vid(1));
    const build = builder();
    const { impl, calls } = versionsFetch({});
    const out = await checkReviewMirrorDrift(
      t.db,
      env ? { env, buildRecord: build, fetchImpl: impl } : undefined,
    );
    expect(out.skipped).toBe(true);
    expect(out.lines).toEqual([]);
    expect(out.note).toContain(note);
    expect(build).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('chunks more than 100 owned vendors into reads of at most 100 ids', async () => {
    const ids = Array.from({ length: 205 }, (_, i) => vid(i + 1));
    await seedOwned(...ids);
    const held = Object.fromEntries(ids.map((id) => [id, { recordHash: HASH_A }]));
    delete held[ids[204]!]; // the last id, in the third chunk, is missing
    const { impl, calls } = versionsFetch(held);
    const out = await checkReviewMirrorDrift(t.db, {
      env: ENV_V2,
      buildRecord: builder(),
      fetchImpl: impl,
    });
    const sizes = calls.map((c) => new URL(c.url).searchParams.get('ids')!.split(',').length);
    expect(sizes).toEqual([100, 100, 5]);
    expect(out.lines).toEqual([`vendor ${ids[204]}: missing on the review side`]);
    expect(out.note).toBe('compared 205 owned vendor(s) in 3 read(s)');
  });

  it('throws on a non-2xx and releases the body', async () => {
    await seedOwned(vid(1));
    const res = new Response('nope', { status: 503 });
    const cancel = vi.spyOn(res.body!, 'cancel');
    const impl = vi.fn(async () => res) as unknown as typeof fetch;
    await expect(
      checkReviewMirrorDrift(t.db, { env: ENV_V2, buildRecord: builder(), fetchImpl: impl }),
    ).rejects.toThrow('review app versions read failed: HTTP 503');
    expect(cancel).toHaveBeenCalled();
  });

  it('throws on a network failure, a timeout, and a body that fails the schema', async () => {
    await seedOwned(vid(1));
    const run = (impl: typeof fetch) =>
      checkReviewMirrorDrift(t.db, { env: ENV_V2, buildRecord: builder(), fetchImpl: impl });

    await expect(
      run((async () => {
        throw new TypeError('connection reset');
      }) as unknown as typeof fetch),
    ).rejects.toThrow('review app versions read failed: connection reset');

    await expect(
      run((async () => {
        throw new DOMException('timed out', 'TimeoutError');
      }) as unknown as typeof fetch),
    ).rejects.toThrow('timed out after 10000 ms');

    await expect(
      run(
        (async () =>
          new Response(JSON.stringify({ vendors: [{ vendorId: 'not-a-uuid' }] }), {
            status: 200,
          })) as unknown as typeof fetch,
      ),
    ).rejects.toThrow('review app versions read failed');
  });

  it('errors (never zero) through the orchestrator when the review side fails', async () => {
    await seedOwned(vid(1));
    const results = await runDataQualityChecks({
      db: t.db,
      now: NOW,
      reviewMirror: {
        env: ENV_V2,
        buildRecord: builder(),
        fetchImpl: (async () => new Response('', { status: 500 })) as unknown as typeof fetch,
      },
    });
    const drift = results.find((r) => r.id === 'review_mirror_drift');
    expect(drift?.error).toContain('HTTP 500');
    expect(hasErrors(results)).toBe(true);
  });

  it('is an error-severity check in the registry', () => {
    expect(CHECKS.find((c) => c.id === 'review_mirror_drift')?.severity).toBe('error');
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
    // A runDrift that throws makes the drift check error; the other ten still run.
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
