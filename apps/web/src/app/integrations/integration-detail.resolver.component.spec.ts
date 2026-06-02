/**
 * Resolver test. Named `.component.spec.ts` so it runs under `ng test`
 * (Angular's vitest unit-test runner) — needs Angular's `inject()` /
 * `TestBed` to exercise the resolver's DI surface.
 *
 * The six cases shared with the product + vendor resolvers live in
 * `detail-resolver.harness.ts` (AECI-113); only the integration fixture and the
 * integration-specific embedded-tag case live here. Integration keys on `id`
 * (not `slug`) and sets no JSON-LD per Phase 2 Spec §9.2.
 */
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IntegrationDetail } from '@aeci/shared';

import { createRequestContext } from '../../server/request-context';
import {
  buildClient,
  createSetup,
  registerDetailResolverSuite,
} from '../core/testing/detail-resolver.harness';
import type { MetaService } from '../core/meta.service';

import { integrationDetailResolver } from './integration-detail.resolver';

const ID = '00000000-0000-4000-8000-000000030001';

function buildIntegration(overrides: Partial<IntegrationDetail> = {}): IntegrationDetail {
  return {
    id: ID,
    name: 'Revit → Navisworks',
    mechanism_kind: 'native',
    mechanism_name: 'Autodesk Desktop Connector',
    direction: 'bidirectional',
    source: {
      id: '00000000-0000-4000-8000-000000020001',
      slug: 'revit',
      name: 'Revit',
      logo_url: null,
    },
    target: {
      id: '00000000-0000-4000-8000-000000020002',
      slug: 'navisworks',
      name: 'Navisworks',
      logo_url: null,
    },
    created_at: '2024-06-01T00:00:00.000Z',
    updated_at: '2024-06-01T00:00:00.000Z',
    description: 'Sync models between Revit and Navisworks.',
    listing_url: 'https://apps.autodesk.com/listing',
    docs_url: 'https://help.autodesk.com',
    mechanism_url: null,
    built_by_vendor: {
      id: '00000000-0000-4000-8000-000000010001',
      slug: 'autodesk',
      name: 'Autodesk',
      logo_url: null,
    },
    powered_by_product: {
      id: '00000000-0000-4000-8000-000000020003',
      slug: 'forge',
      name: 'Autodesk Platform Services',
      logo_url: null,
    },
    pricing_model: 'Included',
    maturity: 'GA',
    ...overrides,
  };
}

registerDetailResolverSuite<IntegrationDetail>({
  name: 'integrationDetailResolver',
  resolver: integrationDetailResolver,
  paramKey: 'id',
  paramValue: ID,
  url: `https://aecintegrations.com/integrations/${ID}`,
  stateKey: `aeci.integration-detail:${ID}`,
  buildFixture: () => buildIntegration(),
  // Headline built from source/target names per Phase 2 Spec §6.5; no og image.
  expectedMeta: {
    entity: 'integration',
    name: 'Revit → Navisworks',
    description: 'Sync models between Revit and Navisworks.',
    canonical: `https://aecintegrations.com/integrations/${ID}`,
    ogImage: undefined,
  },
  jsonLdMethod: null,
  // Embedded tags: both products, the built-by vendor, and the powered-by
  // connector product. (Path matcher emits integration:{id} + route:detail.)
  expectedEmbedded: [
    { type: 'product', slug: 'revit' },
    { type: 'product', slug: 'navisworks' },
    { type: 'vendor', slug: 'autodesk' },
    { type: 'product', slug: 'forge' },
  ],
  expectedPageView: {
    route: '/integrations/:id',
    entity_type: 'integration',
    entity_id: ID,
  },
  notFound: {
    kind: 'integration',
    slug: ID,
    canonical: `https://aecintegrations.com/integrations/${ID}`,
  },
});

describe('integrationDetailResolver — integration-specific', () => {
  const setup = createSetup<IntegrationDetail>(integrationDetailResolver, 'id', ID);
  beforeEach(() => TestBed.resetTestingModule());

  it('omits absent built-by / powered-by from the embedded tags', async () => {
    const integration = buildIntegration({ built_by_vendor: null, powered_by_product: null });
    const ctx = createRequestContext(buildClient(async () => integration));

    const { run } = setup({
      platform: 'server',
      ctx,
      responseInit: { status: 200 },
      request: new Request(`https://aecintegrations.com/integrations/${ID}`),
      meta: { setEntityMeta: vi.fn() } as Partial<MetaService>,
    });

    await run();

    expect(ctx.embedded).toEqual([
      { type: 'product', slug: 'revit' },
      { type: 'product', slug: 'navisworks' },
    ]);
  });
});
