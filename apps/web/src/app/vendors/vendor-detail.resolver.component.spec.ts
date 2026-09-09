/**
 * Resolver test. Named `.component.spec.ts` so it runs under `ng test`
 * (Angular's vitest unit-test runner) — needs Angular's `inject()` /
 * `TestBed` to exercise the resolver's DI surface. Plain `*.spec.ts`
 * is Vitest-only and excludes Angular per `apps/web/vitest.config.ts`.
 *
 * The six cases shared with the product + integration resolvers live in
 * `detail-resolver.harness.ts` (AECI-113); only the vendor fixtures live here.
 * The vendor resolver has no entity-specific case.
 */
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProductListItem, VendorDetail } from '@aeci/shared';

import { createRequestContext } from '../../server/request-context';
import {
  buildClient,
  createSetup,
  registerDetailResolverSuite,
} from '../core/testing/detail-resolver.harness';
import type { MetaService, SetEntityMetaInput } from '../core/meta.service';

import { vendorDetailResolver } from './vendor-detail.resolver';

function buildProduct(slug: string, id: string): ProductListItem {
  return {
    id,
    slug,
    name: slug,
    logo_url: null,
    product_role: 'application',
    vendor: {
      id: '00000000-0000-4000-8000-000000010001',
      slug: 'procore',
      name: 'Procore Technologies',
      logo_url: null,
      verified: false,
    },
    primary_category: null,
    integration_count: 0,
    review_count: 0,
    rating_overall_avg: null,
    rating_onboarding_avg: null,
    created_at: '2024-06-01T00:00:00.000Z',
    updated_at: '2024-06-01T00:00:00.000Z',
  };
}

function buildVendor(overrides: Partial<VendorDetail> = {}): VendorDetail {
  return {
    id: '00000000-0000-4000-8000-000000010001',
    slug: 'procore',
    company_name: 'Procore Technologies',
    logo_url: 'https://example.com/procore.png',
    verified: true,
    headquarters: 'Carpinteria, CA',
    founded_year: 2002,
    product_count: 1,
    integration_count: 2,
    review_count: 0,
    created_at: '2024-06-01T00:00:00.000Z',
    updated_at: '2024-06-01T00:00:00.000Z',
    description: 'Construction management vendor.',
    website: 'https://www.procore.com',
    linkedin_url: null,
    x_url: null,
    facebook_url: null,
    instagram_url: null,
    youtube_url: null,
    products: [],
    // The unreviewed baseline (AECI-616): bare attribution, no date.
    maintenance: { maintained_by: 'aeci', last_reviewed_at: null },
    ...overrides,
  };
}

registerDetailResolverSuite<VendorDetail>({
  name: 'vendorDetailResolver',
  resolver: vendorDetailResolver,
  paramKey: 'slug',
  paramValue: 'procore',
  url: 'https://aecintegrations.com/vendors/procore',
  apiPath: '/api/vendors/procore',
  stateKey: 'aeci.vendor-detail:procore',
  buildFixture: () =>
    buildVendor({
      // Coherent with the embedded list: `product_count` and `products.length`
      // are the same fact from two places, and AECI-802's description reads both.
      product_count: 2,
      products: [
        buildProduct('procore-platform', '00000000-0000-4000-8000-000000020001'),
        buildProduct('procore-revizto', '00000000-0000-4000-8000-000000020002'),
      ],
    }),
  // AECI-802: composed title + description. Only ONE product is named even
  // though two exist, because naming both would push the trust line past the
  // 155-char budget and a named product outranks byte-identical boilerplate.
  expectedMeta: {
    entity: 'vendor',
    name: 'Procore Technologies products and integrations',
    description:
      'Procore Technologies publishes 2 products in the AEC directory, including procore-platform. ' +
      'Independent data, compiled and curated by AEC Integrations.',
    canonical: 'https://aecintegrations.com/vendors/procore',
    ogImage: 'https://example.com/procore.png',
  },
  jsonLdMethod: 'setVendorJsonLd',
  // Embedded tag for every product rendered on the page. The path matcher
  // already emits `vendor:procore` and `route:detail`; the resolver only pushes
  // the product tags so purges on those products cascade here.
  expectedEmbedded: [
    { type: 'product', slug: 'procore-platform' },
    { type: 'product', slug: 'procore-revizto' },
  ],
  expectedPageView: {
    route: '/vendors/:slug',
    entity_type: 'vendor',
    entity_id: '00000000-0000-4000-8000-000000010001',
  },
  notFound: {
    kind: 'vendor',
    slug: 'procore',
    canonical: 'https://aecintegrations.com/vendors/procore',
  },
});

/** The §9.1 description ladder for vendors (AECI-802). */
describe('vendorDetailResolver — title and description (AECI-802)', () => {
  const setup = createSetup<VendorDetail>(vendorDetailResolver, 'slug', 'procore');
  const TRUST = 'Independent data, compiled and curated by AEC Integrations.';

  beforeEach(() => TestBed.resetTestingModule());

  async function metaFor(vendor: VendorDetail): Promise<SetEntityMetaInput> {
    const setEntityMeta = vi.fn();
    const { run } = setup({
      platform: 'server',
      ctx: createRequestContext(buildClient(async () => vendor)),
      responseInit: { status: 200 },
      request: new Request('https://aecintegrations.com/vendors/procore'),
      meta: { setEntityMeta, setVendorJsonLd: vi.fn() } as Partial<MetaService>,
    });
    await run();
    expect(setEntityMeta).toHaveBeenCalledTimes(1);
    return setEntityMeta.mock.calls[0][0] as SetEntityMetaInput;
  }

  function named(slug: string, name: string, integrationCount = 0): ProductListItem {
    return { ...buildProduct(slug, `id-${slug}`), name, integration_count: integrationCount };
  }

  it('titles the page with the intent modifier and no em dash', async () => {
    const meta = await metaFor(buildVendor());
    expect(meta.name).toBe('Procore Technologies products and integrations');
    expect(meta.name).not.toContain('—');
  });

  it('composes the description from the catalog footprint, not the blurb', async () => {
    const vendor = buildVendor({
      company_name: 'Acme',
      product_count: 3,
      products: [named('b', 'Beta'), named('a', 'Alpha'), named('g', 'Gamma')],
    });
    const meta = await metaFor(vendor);
    expect(meta.description).toBe(
      `Acme publishes 3 products in the AEC directory, including Alpha, Beta and Gamma. ${TRUST}`,
    );
    expect(meta.description).not.toContain('Construction management vendor.');
  });

  it('names the most-integrated products first', async () => {
    const vendor = buildVendor({
      company_name: 'Acme',
      product_count: 3,
      products: [named('a', 'Alpha'), named('b', 'Beta', 40), named('g', 'Gamma')],
    });
    const meta = await metaFor(vendor);
    expect(meta.description).toContain('including Beta, Alpha and Gamma.');
  });

  it('uses the singular message id at a count of one', async () => {
    const vendor = buildVendor({
      company_name: 'Acme',
      product_count: 1,
      products: [named('a', 'Alpha')],
    });
    const meta = await metaFor(vendor);
    expect(meta.description).toBe(`Acme publishes 1 product in the AEC directory: Alpha. ${TRUST}`);
  });

  it('never claims verification, which no vendor holds today', async () => {
    const vendor = buildVendor({ product_count: 1, products: [named('a', 'Alpha')] });
    const meta = await metaFor(vendor);
    expect(meta.description).not.toMatch(/verified/i);
  });

  it('falls back to the vendor blurb when the vendor publishes nothing', async () => {
    const meta = await metaFor(buildVendor({ product_count: 0, products: [] }));
    expect(meta.description).toBe('Construction management vendor.');
  });

  it('falls back to the blurb when the count is non-zero but names nothing', async () => {
    const meta = await metaFor(buildVendor({ product_count: 4, products: [] }));
    expect(meta.description).toBe('Construction management vendor.');
  });

  it('returns null for the generic fallback only when there is nothing at all', async () => {
    const meta = await metaFor(buildVendor({ product_count: 0, products: [], description: null }));
    expect(meta.description).toBeNull();
  });
});
