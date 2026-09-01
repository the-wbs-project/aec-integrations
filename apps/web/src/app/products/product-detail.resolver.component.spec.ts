/**
 * Resolver test. Named `.component.spec.ts` so it runs under `ng test`
 * (Angular's vitest unit-test runner) — needs Angular's `inject()` /
 * `TestBed` to exercise the resolver's DI surface. Plain `*.spec.ts`
 * is Vitest-only and excludes Angular per `apps/web/vitest.config.ts`.
 *
 * The six cases shared with the vendor + integration resolvers live in
 * `detail-resolver.harness.ts` (AECI-113); only the product fixture and the
 * product-specific embedded-tag case live here.
 */
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProductDetail } from '@aeci/shared';

import { createRequestContext } from '../../server/request-context';
import {
  buildClient,
  createSetup,
  registerDetailResolverSuite,
} from '../core/testing/detail-resolver.harness';
import type { MetaService } from '../core/meta.service';

import { productDetailResolver } from './product-detail.resolver';

function buildProduct(overrides: Partial<ProductDetail> = {}): ProductDetail {
  return {
    id: '00000000-0000-4000-8000-000000020001',
    slug: 'procore',
    name: 'Procore',
    logo_url: 'https://example.com/procore.png',
    product_role: 'application',
    vendor: {
      id: '00000000-0000-4000-8000-000000010001',
      slug: 'procore',
      name: 'Procore Technologies',
      logo_url: 'https://example.com/procore-logo.png',
      verified: false,
    },
    primary_category: null,
    integration_count: 2,
    review_count: 0,
    rating_overall_avg: null,
    rating_onboarding_avg: null,
    created_at: '2024-06-01T00:00:00.000Z',
    updated_at: '2024-06-01T00:00:00.000Z',
    description: 'Construction management platform.',
    website: 'https://www.procore.com',
    tool_integrations_url: null,
    api_docs_url: null,
    has_api_docs: false,
    categories: [],
    audiences: [],
    phases: [],
    trades: [],
    usefulness: null,
    integrations_as_source: [],
    integrations_as_target: [],
    integrations_as_connector: [],
    related_products: [],
    reviews: [],
    // The unreviewed baseline (AECI-616): bare attribution, no date.
    maintenance: { maintained_by: 'aeci', last_reviewed_at: null },
    ...overrides,
  };
}

registerDetailResolverSuite<ProductDetail>({
  name: 'productDetailResolver',
  resolver: productDetailResolver,
  paramKey: 'slug',
  paramValue: 'procore',
  url: 'https://aecintegrations.com/products/procore',
  apiPath: '/api/products/procore',
  stateKey: 'aeci.product-detail:procore',
  buildFixture: () =>
    buildProduct({
      integrations_as_source: [
        // Minimal ProductIntegrationItem shape — only id is read by the resolver.
        {
          id: 'int-a',
          name: 'A → B',
          mechanism_kind: 'native',
          mechanism_name: null,
          direction: null,
          context_direction: null,
          source: { id: 's1', name: 'A', slug: 'a', logo_url: null },
          target: { id: 't1', name: 'B', slug: 'b', logo_url: null },
          via: null,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
      ],
      integrations_as_target: [
        {
          id: 'int-b',
          name: 'C → procore',
          mechanism_kind: 'native',
          mechanism_name: null,
          direction: null,
          context_direction: null,
          source: { id: 's2', name: 'C', slug: 'c', logo_url: null },
          target: { id: 't2', name: 'Procore', slug: 'procore', logo_url: null },
          via: null,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
      ],
      // Powered edge (this product is the connector) — bare IntegrationListItem,
      // no `context_direction`. Both endpoints render, so both get tagged.
      integrations_as_connector: [
        {
          id: 'int-c',
          name: 'D ↔ E',
          mechanism_kind: 'iPaaS',
          mechanism_name: null,
          direction: null,
          source: { id: 's3', name: 'D', slug: 'd', logo_url: null },
          target: { id: 't3', name: 'E', slug: 'e', logo_url: null },
          via: null,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
      ],
    }),
  expectedMeta: {
    entity: 'product',
    name: 'Procore',
    description: 'Construction management platform.',
    canonical: 'https://aecintegrations.com/products/procore',
    ogImage: 'https://example.com/procore.png',
  },
  jsonLdMethod: 'setProductJsonLd',
  // Vendor tag + integration tag + partner product tag for each shown
  // integration (both source and target lists). Partner product tags are
  // required per CACHE_STRATEGY.md §3 so edits to those products purge this page.
  // Powered edges (Addendum B) tag BOTH endpoints — this product is the
  // connector, so neither endpoint is "self".
  expectedEmbedded: [
    { type: 'vendor', slug: 'procore' },
    { type: 'integration', id: 'int-a' },
    { type: 'product', slug: 'b' }, // target of integrations_as_source[0]
    { type: 'integration', id: 'int-b' },
    { type: 'product', slug: 'c' }, // source of integrations_as_target[0]
    { type: 'integration', id: 'int-c' },
    { type: 'product', slug: 'd' }, // source of integrations_as_connector[0]
    { type: 'product', slug: 'e' }, // target of integrations_as_connector[0]
  ],
  expectedPageView: {
    route: '/products/:slug',
    entity_type: 'product',
    entity_id: '00000000-0000-4000-8000-000000020001',
  },
  notFound: {
    kind: 'product',
    slug: 'procore',
    canonical: 'https://aecintegrations.com/products/procore',
  },
});

describe('productDetailResolver — product-specific', () => {
  const setup = createSetup<ProductDetail>(productDetailResolver, 'slug', 'procore');
  beforeEach(() => TestBed.resetTestingModule());

  it('omits the vendor cache tag when the product has no vendor (AECI-115)', async () => {
    const product = buildProduct({ vendor: null });
    const ctx = createRequestContext(buildClient(async () => product));

    const { run } = setup({
      platform: 'server',
      ctx,
      responseInit: { status: 200 },
      request: new Request('https://aecintegrations.com/products/procore'),
      meta: { setEntityMeta: vi.fn(), setProductJsonLd: vi.fn() } as Partial<MetaService>,
    });

    await run();

    // No vendor link → no `vendor:*` tag (and no fabricated `vendor:unknown`).
    // This product has no embedded integrations either, so the list is empty.
    expect(ctx.embedded).toEqual([]);
  });

  // AECI-518 — the second argument the shared harness deliberately does not
  // assert. The canonical is what gives the node a stable `@id`, and it is the
  // URI the product-PAIR page references in `about[]`; passing the wrong URL (or
  // dropping the argument) silently disconnects the entity graph rather than
  // failing anything.
  it('passes the canonical to setProductJsonLd so the node gets a stable @id', async () => {
    const product = buildProduct();
    const setProductJsonLd = vi.fn();
    const ctx = createRequestContext(buildClient(async () => product));

    const { run } = setup({
      platform: 'server',
      ctx,
      responseInit: { status: 200 },
      request: new Request('https://aecintegrations.com/products/procore'),
      meta: { setEntityMeta: vi.fn(), setProductJsonLd } as Partial<MetaService>,
    });

    await run();

    expect(setProductJsonLd).toHaveBeenCalledWith(
      product,
      'https://aecintegrations.com/products/procore',
    );
  });

  /**
   * Stage 1.5 Addendum C §13.6 (AECI-707) — the role-varied meta description.
   * Every role but `connector` keeps the Phase 2 §9.1 default (the entity's own
   * description); a connector page targets "«connector» for construction"-class
   * queries instead, which its vendor-written description almost never does.
   */
  const poweredEdge = (sourceSlug: string, targetSlug: string) => ({
    id: `int-${sourceSlug}-${targetSlug}`,
    name: `${sourceSlug} ↔ ${targetSlug}`,
    mechanism_kind: 'iPaaS' as const,
    mechanism_name: null,
    direction: null,
    source: { id: `s-${sourceSlug}`, name: sourceSlug, slug: sourceSlug, logo_url: null },
    target: { id: `t-${targetSlug}`, name: targetSlug, slug: targetSlug, logo_url: null },
    via: null,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
  });

  const resolvedDescription = async (product: ProductDetail): Promise<unknown> => {
    const setEntityMeta = vi.fn();
    const ctx = createRequestContext(buildClient(async () => product));
    const { run } = setup({
      platform: 'server',
      ctx,
      responseInit: { status: 200 },
      request: new Request('https://aecintegrations.com/products/procore'),
      meta: { setEntityMeta, setProductJsonLd: vi.fn() } as Partial<MetaService>,
    });
    await run();
    return setEntityMeta.mock.calls[0]![0].description;
  };

  it('gives a connector page a reach-shaped meta description', async () => {
    expect(
      await resolvedDescription(
        buildProduct({
          product_role: 'connector',
          integrations_as_connector: [poweredEdge('d', 'e'), poweredEdge('d', 'f')],
        }),
      ),
    ).toBe(
      'Procore connects 3 construction and AEC products. See the integrations it powers and reviews from the teams using them.',
    );
  });

  it('counts reach from the RAW edge list, so a Convention-A connector is not zero', () => {
    // §13.4(2) excludes these edges from the rendered section, but the page
    // product IS reaching those three products; the snippet must say so.
    return expect(
      resolvedDescription(
        buildProduct({
          product_role: 'connector',
          integrations_as_connector: [
            poweredEdge('d', 'procore'),
            poweredEdge('e', 'procore'),
            poweredEdge('f', 'procore'),
          ],
        }),
      ),
    ).resolves.toBe(
      'Procore connects 3 construction and AEC products. See the integrations it powers and reviews from the teams using them.',
    );
  });

  it('falls back to the product description for a connector with no reach', async () => {
    // Nothing to count, so the variant would assert less than the real
    // description does.
    expect(await resolvedDescription(buildProduct({ product_role: 'connector' }))).toBe(
      'Construction management platform.',
    );
  });

  it('leaves hybrid and application pages on the default description', async () => {
    for (const role of ['hybrid', 'application'] as const) {
      expect(
        await resolvedDescription(
          buildProduct({
            product_role: role,
            integrations_as_connector: [poweredEdge('d', 'e')],
          }),
        ),
      ).toBe('Construction management platform.');
      TestBed.resetTestingModule();
    }
  });
});
