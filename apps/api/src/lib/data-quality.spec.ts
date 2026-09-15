/**
 * Unit tests for the §23.1 daily data-quality suite (AECI-241 / Phase 7.6) on the
 * Drizzle/D1 path. The in-memory harness (`makeTestDb`) seeds real rows and each
 * check runs its actual query against them — a positive fixture that must flag and
 * a negative fixture that must not. The logo probe injects a fake `fetch`; the
 * Algolia-drift reuse injects a fake `runDrift`. The orchestrator test covers the
 * best-effort capture (a throwing check becomes an `error` result).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WORKER_CONNECTION_LIMIT } from '@aeci/shared/concurrency';

import type { AlgoliaIndexDrift } from './algolia-drift';
import {
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
  vendorEntitlements,
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
  checkEntitlementMirrorDrift,
  checkLogo404Sample,
  checkProductsWithoutVendor,
  checkReviewsMissingAnonymizedAt,
  checkPromotionStatusInvariant,
  checkStaleStatsCache,
  checkTaxonomyMissingDescription,
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
  promotionStatus?: string;
  logoUrl?: string | null;
  updatedAt?: string;
}): Promise<void> {
  await t.db.insert(vendors).values({
    id: over.id,
    slug: over.slug ?? over.id,
    companyName: over.companyName ?? over.id,
    // Defaults to the production shape, not the schema default `'pending'` — every
    // other check's fixtures would otherwise trip `promotion_status_invariant`.
    promotionStatus: over.promotionStatus ?? 'promoted',
    logoUrl: over.logoUrl ?? null,
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

// ── #11 entitlement_mirror_drift (AECI-609 Guard 2) ───────────────────────────

describe('checkEntitlementMirrorDrift', () => {
  /** Seed a vendor + (optionally) its entitlement row in one go. */
  async function seedPair(
    id: string,
    slug: string,
    verified: boolean,
    status: string | null,
  ): Promise<void> {
    await t.db.insert(vendors).values({ id, slug, companyName: slug, verified });
    if (status !== null) {
      await t.db
        .insert(vendorEntitlements)
        .values({ vendorId: id, tier: 'verified', status, grantedAt: OLD });
    }
  }

  it('flags a verified vendor with NO entitlement row (the backfill-did-not-run case)', async () => {
    await seedPair('v1', 'autodesk', true, null);
    const finding = await checkEntitlementMirrorDrift(t.db);
    expect(finding.lines).toHaveLength(1);
    expect(finding.lines[0]).toContain('no entitlement row');
    expect(finding.lines[0]).toContain('verified=1');
  });

  it('flags a verified vendor whose entitlement is NOT active', async () => {
    // This is the case that silently disappears if the `isNull(id)` disjunct is
    // "simplified" away — `status <> 'active'` is NULL, not true, for a missing row,
    // so the two halves of the predicate must both be present.
    await seedPair('v1', 'bluebeam', true, 'revoked');
    const finding = await checkEntitlementMirrorDrift(t.db);
    expect(finding.lines).toHaveLength(1);
    expect(finding.lines[0]).toContain("entitlement is 'revoked'");
  });

  it('flags the reverse half — an active entitlement on an unverified vendor', async () => {
    await seedPair('v1', 'procore', false, 'active');
    const finding = await checkEntitlementMirrorDrift(t.db);
    expect(finding.lines).toHaveLength(1);
    expect(finding.lines[0]).toContain('verified=0');
    expect(finding.lines[0]).toContain("entitlement is 'active'");
  });

  it('is clean for every in-sync shape', async () => {
    await seedPair('v1', 'autodesk', true, 'active'); // verified + active
    await seedPair('v2', 'procore', false, null); // unclaimed baseline
    await seedPair('v3', 'bluebeam', false, 'revoked'); // lapsed, mirror cleared
    await seedPair('v4', 'trimble', false, 'pending'); // PO issued, not yet effective
    expect((await checkEntitlementMirrorDrift(t.db)).lines).toEqual([]);
  });

  it('is registered at `error` severity — this invariant pages', () => {
    const spec = CHECKS.find((c) => c.id === 'entitlement_mirror_drift');
    expect(spec).toBeDefined();
    expect(spec!.severity).toBe('error');
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
