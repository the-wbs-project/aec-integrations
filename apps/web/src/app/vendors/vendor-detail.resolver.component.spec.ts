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
import type { ProductListItem, VendorDetail } from '@aeci/shared';

import { registerDetailResolverSuite } from '../core/testing/detail-resolver.harness';

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
      products: [
        buildProduct('procore-platform', '00000000-0000-4000-8000-000000020001'),
        buildProduct('procore-revizto', '00000000-0000-4000-8000-000000020002'),
      ],
    }),
  expectedMeta: {
    entity: 'vendor',
    name: 'Procore Technologies',
    description: 'Construction management vendor.',
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
