/**
 * `GET /api/admin/catalog/coverage` (AECI-579) against the in-memory D1 harness.
 *
 * The AC names two cases that matter more than the rest and both are pinned here:
 *
 *   - **the zero case AND the all-affected case for every gap.** `logo_url IS NULL`
 *     is 171 of 171 in production, so "everything is affected" is the *normal*
 *     rendering, not an error path — the response must report it as a plain count
 *     with `universe` alongside, never as a failure.
 *   - **a non-admin receiving 403** — covered end-to-end against the real guard in
 *     `admin-panel.authz-matrix.spec.ts`, not here (this file mounts the handler
 *     bare, so it never touches authorization).
 *
 * Plus the funnel's degeneracy flag on both sides, taxonomy usage per facet with
 * the trade publication floor pinned at its boundary, the data-object facet
 * counting CLAIMS rather than products, claim/attestation coverage, and each of
 * the three new notes firing and not firing.
 */

import {
  ADMIN_COVERAGE_DEFAULT_SAMPLE,
  AdminCatalogCoverageResponseSchema,
  TRADE_PUBLISH_MIN_PRODUCTS,
  type AdminCatalogCoverageResponse,
  type AdminCoverageGapKey,
  type AdminTaxonomyFacet,
} from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  attestations,
  claims,
  integrations,
  productAudiences,
  productCategories,
  productPhases,
  products,
  productTrades,
  productVendors,
  taxonomyAudiences,
  taxonomyCategories,
  taxonomyDataObjects,
  taxonomyPhases,
  taxonomyTrades,
  vendors,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createAdminCatalogCoverageHandler } from './admin-catalog';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = new Date('2026-08-13T05:00:00.000Z');

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

function call(query = '') {
  const qs = query ? `?${query}` : '';
  return buildAppWithHandler({
    method: 'get',
    path: '/api/admin/catalog/coverage',
    handler: createAdminCatalogCoverageHandler(t.factory, { now: () => NOW }),
  }).request(`/api/admin/catalog/coverage${qs}`, {}, TEST_ENV, fakeExecutionContext());
}

async function coverage(query = ''): Promise<AdminCatalogCoverageResponse> {
  const res = await call(query);
  expect(res.status).toBe(200);
  return AdminCatalogCoverageResponseSchema.parse(await res.json());
}

const gap = (body: AdminCatalogCoverageResponse, key: AdminCoverageGapKey) => {
  const found = body.gaps.find((g) => g.key === key);
  expect(found, `gap ${key} missing from response`).toBeDefined();
  return found!;
};

const facet = (body: AdminCatalogCoverageResponse, f: AdminTaxonomyFacet) => {
  const found = body.taxonomy.find((x) => x.facet === f);
  expect(found, `facet ${f} missing from response`).toBeDefined();
  return found!;
};

const noteCodes = (body: AdminCatalogCoverageResponse) => body.notes.map((n) => n.code);

/** A product with every field populated and every facet tagged — the "no gaps"
 *  baseline each test then breaks in exactly one way. */
async function seedCompleteProduct(seq: number): Promise<string> {
  const id = u(seq);
  await t.db.insert(products).values({
    id,
    slug: `complete-${seq}`,
    name: `Complete ${seq}`,
    description: 'A real description.',
    apiDocsUrl: 'https://example.test/api',
    hasApiDocs: true,
    logoUrl: 'https://example.test/logo.png',
    promotionStatus: 'promoted',
  });

  const vendorId = u(5000 + seq);
  await t.db
    .insert(vendors)
    .values({ id: vendorId, slug: `vendor-${seq}`, companyName: `Vendor ${seq}` });
  await t.db.insert(productVendors).values({ productId: id, vendorId });

  const categoryId = u(6000 + seq);
  const audienceId = u(7000 + seq);
  const phaseId = u(8000 + seq);
  const tradeId = u(9000 + seq);
  await t.db
    .insert(taxonomyCategories)
    .values({ id: categoryId, slug: `cat-${seq}`, name: `Cat ${seq}` });
  await t.db
    .insert(taxonomyAudiences)
    .values({ id: audienceId, slug: `aud-${seq}`, name: `Aud ${seq}` });
  await t.db.insert(taxonomyPhases).values({ id: phaseId, slug: `ph-${seq}`, name: `Ph ${seq}` });
  await t.db
    .insert(taxonomyTrades)
    .values({ id: tradeId, slug: `tr-${seq}`, name: `Tr ${seq}`, description: 'Trade work.' });
  await t.db.insert(productCategories).values({ productId: id, categoryId });
  await t.db.insert(productAudiences).values({ productId: id, audienceId });
  await t.db.insert(productPhases).values({ productId: id, phaseId });
  await t.db.insert(productTrades).values({ productId: id, tradeId });

  return id;
}

/** A bare product row — every gap applies to it. */
async function seedBareProduct(seq: number, overrides: Record<string, unknown> = {}) {
  await t.db.insert(products).values({
    id: u(seq),
    slug: `bare-${seq}`,
    name: `Bare ${seq}`,
    promotionStatus: 'promoted',
    ...overrides,
  });
}

describe('GET /api/admin/catalog/coverage — the empty database', () => {
  it('returns a well-formed response with every count at zero', async () => {
    const body = await coverage();

    expect(body.source).toBe('live');
    expect(body.generated_at).toBe(NOW.toISOString());
    expect(body.totals).toEqual({
      products: 0,
      integrations: 0,
      vendors: 0,
      claims: 0,
      attestations: 0,
    });
    expect(body.gaps).toHaveLength(8);
    for (const g of body.gaps) {
      expect(g.total).toBe(0);
      expect(g.universe).toBe(0);
      expect(g.sample).toEqual([]);
      expect(g.sample_truncated).toBe(false);
    }
  });

  it('does NOT claim a promoted-only cohort when there are no products at all', async () => {
    // `0 === 0` would be true under a naive `promoted === total` check. An empty
    // catalog is not "the promoted cohort" — it is nothing — and saying otherwise
    // would put a warning on a screen with no data behind it.
    const body = await coverage();
    expect(body.funnel.promoted_cohort_only).toBe(false);
    expect(noteCodes(body)).not.toContain('funnel_is_promoted_cohort_only');
  });
});

describe('GET /api/admin/catalog/coverage — gap counts', () => {
  it('reports zero for every gap when the product is complete', async () => {
    await seedCompleteProduct(1);
    const body = await coverage();

    for (const g of body.gaps) {
      expect(g.total, `${g.key} should be clean`).toBe(0);
      expect(g.universe).toBe(1);
      expect(g.sample).toEqual([]);
    }
    expect(noteCodes(body)).not.toContain('trade_facet_sparse_by_design');
  });

  it('reports the ALL-AFFECTED case as a plain count, not an error', async () => {
    // The production shape: `logo_url IS NULL` on 171 of 171. The response must
    // read as a worklist — an exact count, the full universe beside it, and a
    // sample to start from. Nothing about it may signal failure.
    for (let i = 0; i < 3; i += 1) await seedBareProduct(100 + i);

    const res = await call();
    expect(res.status).toBe(200);
    const body = AdminCatalogCoverageResponseSchema.parse(await res.json());

    const logo = gap(body, 'products_without_logo');
    expect(logo.total).toBe(3);
    expect(logo.universe).toBe(3);
    expect(logo.sample).toHaveLength(3);
    expect(logo.sample_truncated).toBe(false);
    // Every other product gap is likewise all-affected on a bare row.
    for (const key of [
      'products_without_vendor',
      'products_without_description',
      'products_without_api_docs',
      'products_without_category',
      'products_without_audience',
      'products_without_phase',
      'products_without_trade',
    ] as const) {
      expect(gap(body, key).total, key).toBe(3);
    }
  });

  it('counts a whitespace-only description as missing', async () => {
    await seedBareProduct(200, { description: '   ' });
    await seedBareProduct(201, { description: 'Real copy.' });

    const body = await coverage();
    const g = gap(body, 'products_without_description');
    expect(g.total).toBe(1);
    expect(g.sample.map((r) => r.slug)).toEqual(['bare-200']);
  });

  it('separates the tagged from the untagged on each facet', async () => {
    await seedCompleteProduct(1);
    await seedBareProduct(300);

    const body = await coverage();
    expect(gap(body, 'products_without_category').total).toBe(1);
    expect(gap(body, 'products_without_audience').total).toBe(1);
    expect(gap(body, 'products_without_phase').total).toBe(1);
    expect(gap(body, 'products_without_trade').total).toBe(1);
    expect(gap(body, 'products_without_vendor').total).toBe(1);
    expect(gap(body, 'products_without_category').universe).toBe(2);
  });

  it('orders samples by name and marks truncation against the exact count', async () => {
    await seedBareProduct(400, { name: 'Zulu' });
    await seedBareProduct(401, { name: 'Alpha' });
    await seedBareProduct(402, { name: 'Mike' });

    const body = await coverage('sample=2');
    const g = gap(body, 'products_without_logo');
    expect(g.total).toBe(3);
    expect(g.sample.map((r) => r.name)).toEqual(['Alpha', 'Mike']);
    expect(g.sample_truncated).toBe(true);
    expect(body.sample_limit).toBe(2);
  });

  it('sample=0 returns exact counts with empty samples', async () => {
    await seedBareProduct(500);
    const body = await coverage('sample=0');

    expect(body.sample_limit).toBe(0);
    const g = gap(body, 'products_without_logo');
    expect(g.total).toBe(1);
    expect(g.sample).toEqual([]);
    // Truncated is still true: there IS more than we returned.
    expect(g.sample_truncated).toBe(true);
    expect(body.claim_coverage.integrations_without_claims_sample).toEqual([]);
  });

  it('defaults the sample size to the data-quality suite depth', async () => {
    const body = await coverage();
    expect(body.sample_limit).toBe(ADMIN_COVERAGE_DEFAULT_SAMPLE);
  });

  it('400s a sample above the cap', async () => {
    const res = await call('sample=500');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/admin/catalog/coverage — api-docs flag consistency', () => {
  it('raises a note when has_api_docs disagrees with api_docs_url', async () => {
    await seedBareProduct(600, { hasApiDocs: true }); // flag set, no URL
    const body = await coverage();

    expect(noteCodes(body)).toContain('api_docs_flag_inconsistent');
    expect(body.notes.find((n) => n.code === 'api_docs_flag_inconsistent')?.params).toEqual({
      rows: 1,
    });
    // The gap itself keys off the URL, which IS missing.
    expect(gap(body, 'products_without_api_docs').total).toBe(1);
  });

  it('stays silent when the flag and the URL agree', async () => {
    await seedCompleteProduct(1); // flag true + URL present
    await seedBareProduct(601); // flag false + URL absent

    const body = await coverage();
    expect(noteCodes(body)).not.toContain('api_docs_flag_inconsistent');
  });
});

describe('GET /api/admin/catalog/coverage — promotion funnel', () => {
  it('zero-fills every status in pipeline order', async () => {
    await seedBareProduct(700);
    const body = await coverage();

    expect(body.funnel.stages.map((s) => s.status)).toEqual([
      'pending',
      'ready',
      'promoted',
      'retracted',
      'rejected',
    ]);
    expect(body.funnel.stages.find((s) => s.status === 'promoted')?.count).toBe(1);
    expect(body.funnel.stages.find((s) => s.status === 'ready')?.count).toBe(0);
    expect(body.funnel.total).toBe(1);
  });

  it('flags the degenerate promoted-only cohort and explains it in a note', async () => {
    // The production shape (§13 D6): promote is the only insert path and sets
    // `promoted` on both branches, so the funnel has one populated stage.
    for (let i = 0; i < 3; i += 1) await seedBareProduct(710 + i);

    const body = await coverage();
    expect(body.funnel.promoted_cohort_only).toBe(true);
    const note = body.notes.find((n) => n.code === 'funnel_is_promoted_cohort_only');
    expect(note).toBeDefined();
    expect(note?.severity).toBe('warn');
    expect(note?.params).toEqual({ promoted: 3 });
  });

  it('clears the flag as soon as a single row sits at another status', async () => {
    // Derived, not hardcoded: the day a real un-promote path lands, the flag and
    // its note retire themselves.
    await seedBareProduct(720);
    await seedBareProduct(721, { promotionStatus: 'retracted' });

    const body = await coverage();
    expect(body.funnel.promoted_cohort_only).toBe(false);
    expect(noteCodes(body)).not.toContain('funnel_is_promoted_cohort_only');
    expect(body.funnel.stages.find((s) => s.status === 'retracted')?.count).toBe(1);
  });
});

describe('GET /api/admin/catalog/coverage — research_status distribution', () => {
  it('zero-fills all four CHECK values', async () => {
    await seedBareProduct(800, { researchStatus: 'done' });
    await seedBareProduct(801, { researchStatus: 'done' });
    await seedBareProduct(802, { researchStatus: 'blocked' });

    const body = await coverage();
    expect(body.research_status).toEqual([
      { status: 'pending', count: 0 },
      { status: 'in_progress', count: 0 },
      { status: 'done', count: 2 },
      { status: 'blocked', count: 1 },
    ]);
  });
});

describe('GET /api/admin/catalog/coverage — taxonomy usage', () => {
  it('returns all five facets with per-term counts', async () => {
    await seedCompleteProduct(1);
    const body = await coverage();

    expect(body.taxonomy.map((f) => f.facet)).toEqual([
      'category',
      'audience',
      'phase',
      'trade',
      'data_object',
    ]);
    const categories = facet(body, 'category');
    expect(categories.counts_what).toBe('products');
    expect(categories.terms_total).toBe(1);
    expect(categories.terms_used).toBe(1);
    expect(categories.terms[0]?.count).toBe(1);
    // Only trades have a gate; the rest report null so "no gate" can never be
    // confused with "fails the gate".
    expect(categories.publish_floor).toBeNull();
    expect(categories.terms_published).toBeNull();
    expect(categories.terms[0]?.published).toBeNull();
  });

  it('counts an unused term as used=0 rather than dropping it', async () => {
    await t.db
      .insert(taxonomyCategories)
      .values({ id: u(6100), slug: 'orphan', name: 'Orphan category' });

    const body = await coverage();
    const categories = facet(body, 'category');
    expect(categories.terms_total).toBe(1);
    expect(categories.terms_used).toBe(0);
    expect(categories.terms[0]).toMatchObject({ slug: 'orphan', count: 0 });
  });

  it('applies the trade publication floor inclusively at the boundary', async () => {
    const seedTrade = async (slug: string, productCount: number, seq: number) => {
      const tradeId = u(9100 + seq);
      await t.db
        .insert(taxonomyTrades)
        .values({ id: tradeId, slug, name: slug, description: `${slug} work.` });
      for (let i = 0; i < productCount; i += 1) {
        const productId = u(seq * 1000 + i + 20000);
        await t.db
          .insert(products)
          .values({ id: productId, slug: `${slug}-p${i}`, name: `${slug} ${i}` });
        await t.db.insert(productTrades).values({ productId, tradeId });
      }
    };
    // Off-by-one here is the difference between publishing a trade page and
    // withholding it, so pin both sides of the floor.
    await seedTrade('at-floor', TRADE_PUBLISH_MIN_PRODUCTS, 1);
    await seedTrade('below-floor', TRADE_PUBLISH_MIN_PRODUCTS - 1, 2);
    await seedTrade('above-floor', TRADE_PUBLISH_MIN_PRODUCTS + 1, 3);

    const trades = facet(await coverage(), 'trade');
    expect(trades.publish_floor).toBe(TRADE_PUBLISH_MIN_PRODUCTS);
    expect(trades.terms_published).toBe(2);
    const published = Object.fromEntries(trades.terms.map((t2) => [t2.slug, t2.published]));
    expect(published).toEqual({ 'at-floor': true, 'below-floor': false, 'above-floor': true });
  });

  it('counts CLAIMS for the data_object facet, not products', async () => {
    // Data objects hang off claims (the Stage 1.5 spine), never off products —
    // conflating the two would silently report every data object as unused.
    const [a, b] = [u(30001), u(30002)];
    await t.db.insert(products).values([
      { id: a, slug: 'source', name: 'Source' },
      { id: b, slug: 'target', name: 'Target' },
    ]);
    await t.db
      .insert(integrations)
      .values({ id: u(31000), sourceProductId: a, targetProductId: b });
    await t.db.insert(taxonomyDataObjects).values([
      { id: u(32000), slug: 'rfi', name: 'RFI' },
      { id: u(32001), slug: 'submittal', name: 'Submittal' },
    ]);
    await t.db.insert(claims).values([
      { id: u(33000), integrationId: u(31000), dataObjectId: u(32000), direction: 'a_to_b' },
      { id: u(33001), integrationId: u(31000), dataObjectId: u(32000), direction: 'b_to_a' },
    ]);

    const dataObjects = facet(await coverage(), 'data_object');
    expect(dataObjects.counts_what).toBe('claims');
    expect(dataObjects.terms_total).toBe(2);
    expect(dataObjects.terms_used).toBe(1);
    expect(dataObjects.terms.find((x) => x.slug === 'rfi')?.count).toBe(2);
    expect(dataObjects.terms.find((x) => x.slug === 'submittal')?.count).toBe(0);
  });
});

describe('GET /api/admin/catalog/coverage — the trade facet is sparse by design', () => {
  it('raises the sparse-by-design note whenever products are untagged', async () => {
    // 171 of 171 untagged is the production shape and is NOT a backlog:
    // TRADES_VOCABULARY.md §1.1 tags only trade-SPECIFIC products, so horizontal
    // platforms correctly carry none. Shipping the count without the note is what
    // would make the to-do list wrong.
    await seedBareProduct(900);
    const body = await coverage();

    const note = body.notes.find((n) => n.code === 'trade_facet_sparse_by_design');
    expect(note).toBeDefined();
    expect(note?.severity).toBe('info');
    expect(note?.params).toEqual({ untagged: 1, universe: 1 });
  });

  it('drops the note when every product carries a trade', async () => {
    await seedCompleteProduct(1);
    expect(noteCodes(await coverage())).not.toContain('trade_facet_sparse_by_design');
  });
});

describe('GET /api/admin/catalog/coverage — claim + attestation coverage', () => {
  const SOURCE = u(40001);
  const TARGET = u(40002);
  const WITH_CLAIMS = u(41000);
  const WITHOUT_CLAIMS = u(41001);
  const DATA_OBJECT = u(42000);

  beforeEach(async () => {
    await t.db.insert(products).values([
      { id: SOURCE, slug: 'procore', name: 'Procore' },
      { id: TARGET, slug: 'revit', name: 'Revit' },
    ]);
    await t.db.insert(integrations).values([
      { id: WITH_CLAIMS, sourceProductId: SOURCE, targetProductId: TARGET, name: 'Claimed' },
      { id: WITHOUT_CLAIMS, sourceProductId: TARGET, targetProductId: SOURCE, name: null },
    ]);
    await t.db.insert(taxonomyDataObjects).values({ id: DATA_OBJECT, slug: 'rfi', name: 'RFI' });
  });

  it('counts integrations with and without claims, and samples the gap', async () => {
    await t.db.insert(claims).values({
      id: u(43000),
      integrationId: WITH_CLAIMS,
      dataObjectId: DATA_OBJECT,
      direction: 'a_to_b',
    });

    const c = (await coverage()).claim_coverage;
    expect(c.integrations_total).toBe(2);
    expect(c.integrations_with_claims).toBe(1);
    expect(c.integrations_without_claims).toBe(1);
    expect(c.integrations_without_claims_sample).toHaveLength(1);
    expect(c.integrations_without_claims_sample_truncated).toBe(false);

    // A nullable `name` is why both endpoints travel: the pair URL is built from
    // the two slugs, so the row is renderable either way.
    const [sample] = c.integrations_without_claims_sample;
    expect(sample?.name).toBeNull();
    expect(sample?.source_product.slug).toBe('revit');
    expect(sample?.target_product.slug).toBe('procore');
  });

  it('counts a claim with no ACTIVE attestation as uncovered', async () => {
    await t.db.insert(claims).values([
      {
        id: u(43100),
        integrationId: WITH_CLAIMS,
        dataObjectId: DATA_OBJECT,
        direction: 'a_to_b',
      },
      {
        id: u(43101),
        integrationId: WITH_CLAIMS,
        dataObjectId: DATA_OBJECT,
        direction: 'b_to_a',
      },
    ]);
    await t.db.insert(attestations).values([
      { id: u(44000), claimId: u(43100), source: 'aeci' },
      // Deprecated: history, not coverage. Nothing writes this in Stage 1.5, but
      // the predicate has to be right before Stage 2 starts writing it.
      {
        id: u(44001),
        claimId: u(43101),
        source: 'aeci',
        deprecatedAt: '2026-08-01T00:00:00.000Z',
      },
    ]);

    const c = (await coverage()).claim_coverage;
    expect(c.claims_total).toBe(2);
    expect(c.attestations_total).toBe(2);
    expect(c.claims_with_active_attestation).toBe(1);
    expect(c.claims_without_active_attestation).toBe(1);
  });

  it('reports the fully-covered spine (915/915 in production) with no gap', async () => {
    await t.db.insert(claims).values([
      {
        id: u(43200),
        integrationId: WITH_CLAIMS,
        dataObjectId: DATA_OBJECT,
        direction: 'a_to_b',
      },
      {
        id: u(43201),
        integrationId: WITHOUT_CLAIMS,
        dataObjectId: DATA_OBJECT,
        direction: 'a_to_b',
      },
    ]);
    await t.db.insert(attestations).values([
      { id: u(44100), claimId: u(43200), source: 'aeci' },
      { id: u(44101), claimId: u(43201), source: 'aeci' },
    ]);

    const c = (await coverage()).claim_coverage;
    expect(c.integrations_without_claims).toBe(0);
    expect(c.integrations_without_claims_sample).toEqual([]);
    expect(c.integrations_without_claims_sample_truncated).toBe(false);
    expect(c.claims_without_active_attestation).toBe(0);
  });
});

describe('GET /api/admin/catalog/coverage — totals', () => {
  it('reports the five headline counts', async () => {
    await seedCompleteProduct(1);
    const [a, b] = [u(50001), u(50002)];
    await t.db.insert(products).values([
      { id: a, slug: 'a', name: 'A' },
      { id: b, slug: 'b', name: 'B' },
    ]);
    await t.db
      .insert(integrations)
      .values({ id: u(51000), sourceProductId: a, targetProductId: b });
    await t.db.insert(taxonomyDataObjects).values({ id: u(52000), slug: 'rfi', name: 'RFI' });
    await t.db.insert(claims).values({
      id: u(53000),
      integrationId: u(51000),
      dataObjectId: u(52000),
      direction: 'both',
    });
    await t.db.insert(attestations).values({ id: u(54000), claimId: u(53000), source: 'aeci' });

    const body = await coverage();
    expect(body.totals).toEqual({
      products: 3,
      integrations: 1,
      vendors: 1,
      claims: 1,
      attestations: 1,
    });
  });
});
