/**
 * A retired integration renders on no public read (AECI-1010 / `STAGE_1_5_SPEC.md`
 * §13.5). The counts and id sets are `lib/count-lockstep.spec.ts`; this file is the
 * reads that are not counts: the integrations list and its total (the sitemap's only
 * pair source), the pair page, its timeline, the product page's relations,
 * `resolveMovedPair`, `readPairCounterpartSlugs` and the §7 detector sweep. Plus the
 * one deliberate exception, `GET /api/integrations/:id`, which still answers for a
 * retired row but with its two slugs only (ruled 2026-09-22).
 *
 * The seed puts a LIVE and a RETIRED row between the same two products, and a second
 * retired row as the ONLY edge of another pair. The live row beside the retired one
 * is what catches a predicate that empties everything instead of dropping one row.
 */

import {
  IntegrationDetailSchema,
  IntegrationsListResponseSchema,
  RetiredIntegrationDetailSchema,
} from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  attestations,
  claims,
  integrationEndpointMoves,
  integrations,
  products,
  taxonomyDataObjects,
  vendors,
} from '../db/schema';
import { loadDetectorClaims } from '../lib/attestation-detectors';
import { resolveMovedPair } from '../lib/pair-redirect';
import { readPairCounterpartSlugs } from '../lib/product-pair-slugs';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import {
  createIntegrationDetailHandler,
  createIntegrationsListHandler,
  createPairTimelineHandler,
  createProductPairHandler,
} from './integrations';
import { createProductDetailHandler } from './products';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const P_PROCORE = u(1);
const P_REVIZTO = u(2);
const P_OKTA = u(3);
const VENDOR = u(10);
const LIVE = u(20); // procore ↔ revizto, live
const RETIRED = u(21); // procore ↔ revizto, retired
const RETIRED_ALONE = u(22); // procore ↔ okta, retired and the pair's only edge
const RETIRED_AT = '2026-09-20T00:00:00.000Z';

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db
    .insert(vendors)
    .values({ id: VENDOR, slug: 'acme', companyName: 'Acme', promotionStatus: 'promoted' });
  await t.db.insert(products).values([
    { id: P_PROCORE, slug: 'procore', name: 'Procore', promotionStatus: 'promoted' },
    { id: P_REVIZTO, slug: 'revizto', name: 'Revizto', promotionStatus: 'promoted' },
    { id: P_OKTA, slug: 'okta', name: 'Okta', promotionStatus: 'promoted' },
  ]);
  const retired = {
    builtByVendorId: VENDOR,
    claimedAt: RETIRED_AT,
    maintainedBy: 'vendor' as const,
    retiredAt: RETIRED_AT,
  };
  await t.db.insert(integrations).values([
    {
      id: LIVE,
      name: 'Live link',
      sourceProductId: P_PROCORE,
      targetProductId: P_REVIZTO,
      mechanismKind: 'native',
    },
    {
      id: RETIRED,
      name: 'Retired link',
      description: 'Withdrawn by its owner.',
      sourceProductId: P_REVIZTO,
      targetProductId: P_PROCORE,
      mechanismKind: 'api',
      ...retired,
    },
    {
      id: RETIRED_ALONE,
      name: 'Retired okta link',
      sourceProductId: P_PROCORE,
      targetProductId: P_OKTA,
      mechanismKind: 'api',
      ...retired,
    },
  ]);
});
afterEach(() => t.dispose());

async function getJson(
  method: 'get',
  path: string,
  url: string,
  handler: Parameters<typeof buildAppWithHandler>[0]['handler'],
): Promise<{ status: number; body: unknown; text: string }> {
  const res = await buildAppWithHandler({ method, path, handler }).request(
    url,
    {},
    TEST_ENV,
    fakeExecutionContext(),
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

describe('a retired integration renders on no public read (AECI-1010)', () => {
  it('the integrations list and its total (the sitemap source) drop it', async () => {
    const { body } = await getJson(
      'get',
      '/api/integrations',
      '/api/integrations',
      createIntegrationsListHandler(t.factory),
    );
    const list = IntegrationsListResponseSchema.parse(body);
    expect(list.data.map((i) => i.id)).toEqual([LIVE]);
    expect(list.total).toBe(1);
  });

  it('the pair page lists only the live mechanism, and a retired-only pair lists none', async () => {
    const handler = createProductPairHandler(t.factory);
    const path = '/api/products/:slug/integrations/:otherSlug';
    const pair = await getJson('get', path, '/api/products/procore/integrations/revizto', handler);
    expect(pair.status).toBe(200);
    expect(pair.text).toContain(LIVE);
    expect(pair.text).not.toContain(RETIRED);
    expect(pair.text).not.toContain('Retired link');

    const alone = await getJson('get', path, '/api/products/procore/integrations/okta', handler);
    expect(alone.status).toBe(200);
    expect((alone.body as { mechanisms: unknown[] }).mechanisms).toEqual([]);
    expect(alone.text).not.toContain(RETIRED_ALONE);
  });

  it('the pair timeline omits it', async () => {
    const { status, text } = await getJson(
      'get',
      '/api/products/:slug/integrations/:otherSlug/timeline',
      '/api/products/procore/integrations/revizto/timeline',
      createPairTimelineHandler(t.factory),
    );
    expect(status).toBe(200);
    expect(text).not.toContain(RETIRED);
    expect(text).not.toContain('Retired link');
  });

  it('the product page relations omit it', async () => {
    const { status, text } = await getJson(
      'get',
      '/api/products/:slug',
      '/api/products/procore',
      createProductDetailHandler(t.factory),
    );
    expect(status).toBe(200);
    expect(text).toContain(LIVE);
    expect(text).not.toContain(RETIRED);
    expect(text).not.toContain(RETIRED_ALONE);
    expect(text).not.toContain('Retired link');
  });

  it('readPairCounterpartSlugs does not list a pair whose only edge is retired', async () => {
    expect(await readPairCounterpartSlugs(t.db, P_PROCORE)).toEqual(['revizto']);
  });

  it('resolveMovedPair never redirects onto a retired edge', async () => {
    await t.db.insert(integrationEndpointMoves).values([
      { integrationId: RETIRED_ALONE, fromProductASlug: 'autodesk', fromProductBSlug: 'okta' },
      { integrationId: LIVE, fromProductASlug: 'navisworks', fromProductBSlug: 'revizto' },
    ]);
    expect(await resolveMovedPair(t.db, 'autodesk', 'okta')).toBeNull();
    expect(await resolveMovedPair(t.db, 'navisworks', 'revizto')).not.toBeNull();
  });

  it('the §7 detector sweep reads no claim on a retired row', async () => {
    await t.db.insert(taxonomyDataObjects).values({ id: u(40), slug: 'rfis', name: 'RFIs' });
    await t.db.insert(claims).values([
      { id: u(50), integrationId: LIVE, dataObjectId: u(40), direction: 'a_to_b' },
      { id: u(51), integrationId: RETIRED, dataObjectId: u(40), direction: 'a_to_b' },
    ]);
    await t.db.insert(attestations).values([
      { id: u(60), claimId: u(50), source: 'vendor_a', attestedByVendorId: VENDOR },
      { id: u(61), claimId: u(51), source: 'vendor_a', attestedByVendorId: VENDOR },
    ]);
    const rows = await loadDetectorClaims(t.db);
    expect(rows.map((r) => r.id)).toEqual([u(50)]);
  });
});

describe('GET /api/integrations/:id on a retired row (ruled 2026-09-22)', () => {
  const detail = (id: string) =>
    getJson(
      'get',
      '/api/integrations/:id',
      `/api/integrations/${id}`,
      createIntegrationDetailHandler(t.factory),
    );

  it('answers the two slugs the legacy 301 needs, and no content', async () => {
    const { status, body, text } = await detail(RETIRED);
    expect(status).toBe(200);
    expect(RetiredIntegrationDetailSchema.parse(body)).toEqual({
      id: RETIRED,
      retired: true,
      source: { slug: 'revizto' },
      target: { slug: 'procore' },
    });
    expect(text).not.toContain('Retired link');
    expect(text).not.toContain('Withdrawn by its owner.');
  });

  it('still answers a live row in full', async () => {
    const { body } = await detail(LIVE);
    expect(IntegrationDetailSchema.parse(body).name).toBe('Live link');
  });
});
