/**
 * A retired EVIDENCED PAIR renders on no public read (AECI-1091 /
 * `STAGE_1_5_SPEC.md` §13.5 rule 2, "both arms"). The `integrations` half is
 * `retired-public-reads.spec.ts`; the counts and id sets are
 * `lib/count-lockstep.spec.ts`. This file is the reads that are not counts, over the
 * second table: the integrations list and its total (the sitemap source), the pair
 * page, its timeline, the product page's evidenced relations (endpoint AND
 * connector), `readPairCounterpartSlugs`, `resolveMovedPair`, the vendor portal's
 * Connectors section (AECI-1013) and the admin connector screens.
 *
 * The seed puts a LIVE and a RETIRED pair between Procore and Sage (through two
 * connectors, as the unique index needs), and a second retired pair as the ONLY
 * edge between Procore and Okta. The live pair beside the retired one is what
 * catches a predicate that empties everything instead of dropping one row.
 */

import { IntegrationsListResponseSchema } from '@aeci/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  connectorCatalogs,
  connectorEvidencedPairs,
  integrationEndpointMoves,
  productVendors,
  products,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { resolveMovedPair } from '../lib/pair-redirect';
import { readPairCounterpartSlugs } from '../lib/product-pair-slugs';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import {
  createAdminConnectorCatalogsListHandler,
  createAdminConnectorPairsHandler,
} from './admin-connectors';
import {
  createIntegrationsListHandler,
  createPairTimelineHandler,
  createProductPairHandler,
} from './integrations';
import { createProductDetailHandler } from './products';
import { createListVendorProductConnectorsHandler } from './vendor-connectors';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Canonical order is a CHECK (`product_a_id < product_b_id`): Procore sorts first.
const P_PROCORE = u(1);
const P_SAGE = u(2);
const P_OKTA = u(3);
const P_AGAVE = u(4); // connector for the live pair
const P_WORKATO = u(5); // connector for both retired pairs
const V_OWNER = u(10);
const V_PROCORE = u(11);
const LIVE = u(20); // procore ↔ sage via Agave, live
const RETIRED = u(21); // procore ↔ sage via Workato, retired
const RETIRED_ALONE = u(22); // procore ↔ okta via Workato, retired, the pair's only edge
const CATALOG_AGAVE = u(30);
const CATALOG_WORKATO = u(31);
const RETIRED_AT = '2026-09-20T00:00:00.000Z';

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: V_OWNER, slug: 'agave', companyName: 'Agave', promotionStatus: 'promoted' },
    { id: V_PROCORE, slug: 'procore-inc', companyName: 'Procore Inc', promotionStatus: 'promoted' },
  ]);
  await t.db.insert(products).values([
    { id: P_PROCORE, slug: 'procore', name: 'Procore', promotionStatus: 'promoted' },
    { id: P_SAGE, slug: 'sage', name: 'Sage', promotionStatus: 'promoted' },
    { id: P_OKTA, slug: 'okta', name: 'Okta', promotionStatus: 'promoted' },
    {
      id: P_AGAVE,
      slug: 'agave-sync',
      name: 'Agave Sync',
      productRole: 'connector',
      promotionStatus: 'promoted',
    },
    {
      id: P_WORKATO,
      slug: 'workato',
      name: 'Workato',
      productRole: 'connector',
      promotionStatus: 'promoted',
    },
  ]);
  await t.db.insert(productVendors).values({
    productId: P_PROCORE,
    vendorId: V_PROCORE,
    isPrimary: true,
  });
  const retired = {
    builtByVendorId: V_OWNER,
    claimedAt: RETIRED_AT,
    maintainedBy: 'vendor' as const,
    retiredAt: RETIRED_AT,
    retiredBy: 'owner',
  };
  await t.db.insert(connectorEvidencedPairs).values([
    {
      id: LIVE,
      name: 'Live pair',
      connectorProductId: P_AGAVE,
      productAId: P_PROCORE,
      productBId: P_SAGE,
      direction: 'a_to_b',
      builtByVendorId: V_OWNER,
    },
    {
      id: RETIRED,
      name: 'Retired pair',
      connectorProductId: P_WORKATO,
      productAId: P_PROCORE,
      productBId: P_SAGE,
      direction: 'a_to_b',
      ...retired,
    },
    {
      id: RETIRED_ALONE,
      name: 'Retired okta pair',
      connectorProductId: P_WORKATO,
      productAId: P_PROCORE,
      productBId: P_OKTA,
      direction: 'both',
      ...retired,
    },
  ]);
  await t.db.insert(connectorCatalogs).values([
    { id: CATALOG_AGAVE, connectorProductId: P_AGAVE },
    { id: CATALOG_WORKATO, connectorProductId: P_WORKATO },
  ]);
});
afterEach(() => t.dispose());

type Handler = (c: never) => Promise<Response>;

async function getJson(
  path: string,
  url: string,
  handler: Handler,
  auth?: AuthzVariables['auth'],
): Promise<{ status: number; body: unknown; text: string }> {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  if (auth) {
    app.use('*', async (c, next) => {
      c.set('auth', auth);
      await next();
    });
  }
  app.get(path, handler as never);
  const res = await app.request(url, {}, TEST_ENV, fakeExecutionContext());
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

describe('a retired evidenced pair renders on no public read (AECI-1091)', () => {
  it('the integrations list and its total (the sitemap source) drop it', async () => {
    const { body } = await getJson(
      '/api/integrations',
      '/api/integrations',
      createIntegrationsListHandler(t.factory) as Handler,
    );
    const list = IntegrationsListResponseSchema.parse(body);
    expect(list.data.map((i) => i.id)).toEqual([LIVE]);
    expect(list.total).toBe(1);
  });

  it('the pair page lists only the live pair, and a retired-only pair lists none', async () => {
    const handler = createProductPairHandler(t.factory) as Handler;
    const path = '/api/products/:slug/integrations/:otherSlug';
    const pair = await getJson(path, '/api/products/procore/integrations/sage', handler);
    expect(pair.status).toBe(200);
    expect(pair.text).toContain(LIVE);
    expect(pair.text).not.toContain(RETIRED);
    expect(pair.text).not.toContain('Retired pair');

    const alone = await getJson(path, '/api/products/procore/integrations/okta', handler);
    expect(alone.status).toBe(200);
    expect((alone.body as { mechanisms: unknown[] }).mechanisms).toEqual([]);
    expect(alone.text).not.toContain(RETIRED_ALONE);
  });

  it('the pair timeline omits it', async () => {
    const { status, text } = await getJson(
      '/api/products/:slug/integrations/:otherSlug/timeline',
      '/api/products/procore/integrations/sage/timeline',
      createPairTimelineHandler(t.factory) as Handler,
    );
    expect(status).toBe(200);
    expect(text).not.toContain(RETIRED);
    expect(text).not.toContain('Retired pair');
  });

  it('the endpoint page and the connector page relations omit it', async () => {
    const handler = createProductDetailHandler(t.factory) as Handler;
    const endpoint = await getJson('/api/products/:slug', '/api/products/procore', handler);
    expect(endpoint.status).toBe(200);
    expect(endpoint.text).toContain(LIVE);
    expect(endpoint.text).not.toContain(RETIRED);
    expect(endpoint.text).not.toContain(RETIRED_ALONE);

    // The connector's own page lists the pairs it delivers. Workato delivers only
    // retired pairs, so it lists none.
    const connector = await getJson('/api/products/:slug', '/api/products/workato', handler);
    expect(connector.status).toBe(200);
    expect(connector.text).not.toContain(RETIRED);
    expect(connector.text).not.toContain(RETIRED_ALONE);
    const agave = await getJson('/api/products/:slug', '/api/products/agave-sync', handler);
    expect(agave.text).toContain(LIVE);
  });

  it('readPairCounterpartSlugs does not list a pair whose only edge is a retired pair', async () => {
    expect(await readPairCounterpartSlugs(t.db, P_PROCORE)).toEqual(['sage']);
  });

  it('resolveMovedPair never redirects onto a retired pair', async () => {
    await t.db.insert(integrationEndpointMoves).values([
      { integrationId: RETIRED_ALONE, fromProductASlug: 'autodesk', fromProductBSlug: 'okta' },
      { integrationId: LIVE, fromProductASlug: 'navisworks', fromProductBSlug: 'sage' },
    ]);
    expect(await resolveMovedPair(t.db, 'autodesk', 'okta')).toBeNull();
    expect(await resolveMovedPair(t.db, 'navisworks', 'sage')).not.toBeNull();
  });

  it("the vendor portal's Connectors section (AECI-1013) delivers only the live pair", async () => {
    const seat: AuthzVariables['auth'] = {
      userId: u(90),
      email: 'seat@procore.test',
      role: 'vendor_admin',
      vendorId: V_PROCORE,
      entitlementTier: 'unclaimed',
      entitlement: null,
    };
    const { status, text } = await getJson(
      '/api/vendor/products/:id/connectors',
      `/api/vendor/products/${P_PROCORE}/connectors`,
      createListVendorProductConnectorsHandler(t.factory) as Handler,
      seat,
    );
    expect(status).toBe(200);
    expect(text).toContain(LIVE);
    expect(text).not.toContain(RETIRED);
    expect(text).not.toContain(RETIRED_ALONE);
  });

  it('the admin connector screens count and list only live pairs', async () => {
    const list = await getJson(
      '/api/admin/connector-catalogs',
      '/api/admin/connector-catalogs',
      createAdminConnectorCatalogsListHandler(t.factory) as Handler,
    );
    expect(list.status).toBe(200);
    const counts = new Map(
      (list.body as { data: { id: string; counts: { evidenced_pairs: number } }[] }).data.map(
        (row) => [row.id, row.counts.evidenced_pairs],
      ),
    );
    expect(counts.get(CATALOG_AGAVE)).toBe(1);
    expect(counts.get(CATALOG_WORKATO)).toBe(0);

    const handler = createAdminConnectorPairsHandler(t.factory) as Handler;
    const path = '/api/admin/connector-catalogs/:id/pairs';
    const workato = await getJson(
      path,
      `/api/admin/connector-catalogs/${CATALOG_WORKATO}/pairs?lane=evidenced`,
      handler,
    );
    expect(workato.status).toBe(200);
    expect((workato.body as { total: number }).total).toBe(0);
    expect(workato.text).not.toContain(RETIRED);
    const agave = await getJson(
      path,
      `/api/admin/connector-catalogs/${CATALOG_AGAVE}/pairs?lane=evidenced`,
      handler,
    );
    expect((agave.body as { total: number }).total).toBe(1);
    expect(agave.text).toContain(LIVE);
  });
});
