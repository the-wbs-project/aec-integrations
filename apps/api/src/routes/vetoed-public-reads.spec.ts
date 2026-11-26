/**
 * A vetoed Sync Service pair renders on no public read (AECI-2042, ruling 8 on
 * AECI-2035, `STAGE_2_VENDOR_PORTAL_SPEC.md` §11e.2, `STAGE_1_5_SPEC.md` §13.5).
 *
 * The veto is filed through the real route, so this proves the write and every reader
 * together. One test per reader, the way `retired-evidenced-public-reads.spec.ts`
 * covers a retire: the integrations list and its total, the sitemap, the pair page, its
 * timeline, both endpoint product pages (their lanes and `data_object_slugs`), the Sync
 * Service's own page, `readPairCounterpartSlugs`, `resolveMovedPair`, the Connectors
 * section, the admin connector screens, the stored counts, and the Algolia integrations
 * index (the by-id sync's delete arm). Since AECI-2192 (ruling 66) also the legacy
 * integration detail, the closest matches, and a sweep of every public payload for any
 * trace of a removal. The `integrations` arm is covered on the same
 * reads by a Sync Service row in that table.
 *
 * Beside each vetoed row sits a live row that must stay, so a predicate that empties
 * everything instead of dropping one row fails.
 *
 * Each vetoed key also carries a second row the veto was NOT filed on, in
 * `integrations`, stored the other way round (the review blocker on AECI-2042): a veto
 * is keyed to the pair, so every reader must drop every row on the key.
 */

import { IntegrationsListResponseSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/algolia-sync', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/algolia-sync')>();
  return { ...real, syncIndexTargets: vi.fn(async () => []) };
});

import {
  claims,
  connectorCatalogs,
  connectorEvidencedPairs,
  integrationEndpointMoves,
  integrations,
  productVendors,
  products,
  profiles,
  taxonomyDataObjects,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { buildIntegrationRequests } from '../lib/algolia-sync';
import type { AuthzVariables } from '../lib/authz';
import { resolveMovedPair } from '../lib/pair-redirect';
import { readPairCounterpartSlugs } from '../lib/product-pair-slugs';
import { buildCatalogSitemap } from '../lib/sitemap-build';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import {
  createAdminConnectorCatalogsListHandler,
  createAdminConnectorPairsHandler,
} from './admin-connectors';
import {
  createIntegrationDetailHandler,
  createIntegrationsListHandler,
  createPairAlternativesHandler,
  createPairTimelineHandler,
  createProductPairHandler,
} from './integrations';
import { createProductDetailHandler } from './products';
import { createListVendorProductConnectorsHandler } from './vendor-connectors';
import { createFileVetoHandler, createWithdrawVetoHandler } from './vendor-sync-service-vetoes';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const P_PROCORE = u(1);
const P_SAGE = u(2);
const P_OKTA = u(3);
const P_INEIGHT = u(4);
const S_SYNC = u(5); // a Sync Service
const S_OTHER = u(6); // a second Sync Service, for the live pair beside the vetoed one
const V_RIVETS = u(10);
const V_PROCORE = u(11);
const V_SAGE = u(12);
const LIVE = u(20); // procore ↔ sage via S_OTHER, live
const VETOED = u(21); // procore ↔ sage via S_SYNC, vetoed by Procore
const VETOED_ALONE = u(22); // procore ↔ okta via S_SYNC, vetoed, the pair's only edge
const INT_VETOED = u(23); // integrations: sage → ineight via S_SYNC, vetoed by Sage
const INT_LIVE = u(24); // integrations: sage → ineight, native, live
const DUP_INT = u(25); // integrations: sage → procore via S_SYNC, on VETOED's key
const DUP_INT_TWIN = u(26); // integrations: ineight → sage via S_SYNC, on INT_VETOED's key
const DUPS = [DUP_INT, DUP_INT_TWIN];
const CATALOG = u(30);
const DO_RFIS = u(40);
const DO_INVOICES = u(41);

const seat = (n: number, vendorId: string): AuthzVariables['auth'] => ({
  userId: u(90 + n),
  email: `seat${n}@example.test`,
  role: 'vendor_admin',
  vendorId,
  entitlementTier: 'unclaimed',
  entitlement: null,
});

let t: TestDb;
const vetoIds: string[] = [];

type Handler = (c: never) => Promise<Response>;

async function request(
  method: 'GET' | 'POST',
  path: string,
  url: string,
  handler: Handler,
  auth?: AuthzVariables['auth'],
  body?: unknown,
): Promise<{ status: number; body: unknown; text: string }> {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  if (auth) {
    app.use('*', async (c, next) => {
      c.set('auth', auth);
      await next();
    });
  }
  if (method === 'GET') app.get(path, handler as never);
  else app.post(path, handler as never);
  const execCtx = fakeExecutionContext();
  const env: Env = {
    ...TEST_ENV,
    CACHE_PURGE_QUEUE: { send: vi.fn() } as unknown as Env['CACHE_PURGE_QUEUE'],
  };
  const init: RequestInit =
    body === undefined
      ? { method }
      : { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } };
  const res = await app.request(url, init, env, execCtx);
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}
const get = (path: string, url: string, handler: Handler, auth?: AuthzVariables['auth']) =>
  request('GET', path, url, handler, auth);

async function fileVeto(id: string, auth: AuthzVariables['auth']): Promise<void> {
  const res = await request(
    'POST',
    '/api/vendor/integrations/:id/veto',
    `/api/vendor/integrations/${id}/veto`,
    createFileVetoHandler(t.factory) as Handler,
    auth,
    { reason_code: 'not_authorised' },
  );
  expect(res.status).toBe(201);
  vetoIds.push((res.body as { veto: { id: string } }).veto.id);
}

beforeEach(async () => {
  vetoIds.length = 0;
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: V_RIVETS, slug: 'rivets', companyName: 'Rivets', promotionStatus: 'promoted' },
    { id: V_PROCORE, slug: 'procore-inc', companyName: 'Procore Inc', promotionStatus: 'promoted' },
    { id: V_SAGE, slug: 'sage-inc', companyName: 'Sage Inc', promotionStatus: 'promoted' },
  ]);
  const promoted = { promotionStatus: 'promoted' } as const;
  const syncService = {
    productRole: 'connector',
    connectorKind: 'sync_service',
    ...promoted,
  } as const;
  await t.db.insert(products).values([
    { id: P_PROCORE, slug: 'procore', name: 'Procore', ...promoted },
    { id: P_SAGE, slug: 'sage', name: 'Sage', ...promoted },
    { id: P_OKTA, slug: 'okta', name: 'Okta', ...promoted },
    { id: P_INEIGHT, slug: 'ineight', name: 'InEight', ...promoted },
    { id: S_SYNC, slug: 'rivets-sync', name: 'Rivets Sync', ...syncService },
    { id: S_OTHER, slug: 'agave-sync', name: 'Agave Sync', ...syncService },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_PROCORE, vendorId: V_PROCORE, isPrimary: true },
    { productId: P_SAGE, vendorId: V_SAGE, isPrimary: true },
    { productId: S_SYNC, vendorId: V_RIVETS, isPrimary: true },
  ]);
  const owned = {
    builtByVendorId: V_RIVETS,
    claimedAt: '2026-10-01T00:00:00.000Z',
    origin: 'vendor',
    maintainedBy: 'vendor' as const,
  };
  await t.db.insert(connectorEvidencedPairs).values([
    {
      id: LIVE,
      name: 'Live pair',
      connectorProductId: S_OTHER,
      productAId: P_PROCORE,
      productBId: P_SAGE,
      direction: 'a_to_b',
    },
    {
      id: VETOED,
      name: 'Vetoed pair',
      connectorProductId: S_SYNC,
      productAId: P_PROCORE,
      productBId: P_SAGE,
      direction: 'a_to_b',
      ...owned,
    },
    {
      id: VETOED_ALONE,
      name: 'Vetoed okta pair',
      connectorProductId: S_SYNC,
      productAId: P_PROCORE,
      productBId: P_OKTA,
      direction: 'both',
      ...owned,
    },
  ]);
  await t.db.insert(integrations).values([
    {
      id: INT_VETOED,
      name: 'Vetoed sync row',
      sourceProductId: P_SAGE,
      targetProductId: P_INEIGHT,
      poweredByProductId: S_SYNC,
      mechanismKind: 'iPaaS',
    },
    {
      id: INT_LIVE,
      name: 'Live native row',
      sourceProductId: P_SAGE,
      targetProductId: P_INEIGHT,
      mechanismKind: 'native',
    },
    {
      id: DUP_INT,
      name: 'Duplicate sync row',
      sourceProductId: P_SAGE,
      targetProductId: P_PROCORE,
      poweredByProductId: S_SYNC,
      mechanismKind: 'iPaaS',
    },
    {
      id: DUP_INT_TWIN,
      name: 'Twin sync row',
      sourceProductId: P_INEIGHT,
      targetProductId: P_SAGE,
      poweredByProductId: S_SYNC,
      mechanismKind: 'iPaaS',
    },
  ]);
  await t.db.insert(taxonomyDataObjects).values([
    { id: DO_RFIS, slug: 'rfis', name: 'RFIs', displayOrder: 1 },
    { id: DO_INVOICES, slug: 'invoices', name: 'Invoices', displayOrder: 2 },
  ]);
  // A data object only the vetoed pair moves, so `data_object_slugs` must lose it.
  await t.db.insert(claims).values([
    { id: u(50), connectorEvidencedPairId: LIVE, dataObjectId: DO_RFIS, direction: 'a_to_b' },
    { id: u(51), connectorEvidencedPairId: VETOED, dataObjectId: DO_INVOICES, direction: 'a_to_b' },
  ]);
  await t.db.insert(connectorCatalogs).values({ id: CATALOG, connectorProductId: S_SYNC });
  await t.db.insert(profiles).values([
    { id: seat(1, V_PROCORE).userId, role: 'vendor_admin', vendorId: V_PROCORE },
    { id: seat(2, V_SAGE).userId, role: 'vendor_admin', vendorId: V_SAGE },
  ]);

  await fileVeto(VETOED, seat(1, V_PROCORE));
  await fileVeto(VETOED_ALONE, seat(1, V_PROCORE));
  await fileVeto(INT_VETOED, seat(2, V_SAGE));
});
afterEach(() => t.dispose());

describe('a vetoed Sync Service pair renders on no public read (AECI-2042)', () => {
  it('the integrations list and its total drop it', async () => {
    const { body } = await get(
      '/api/integrations',
      '/api/integrations',
      createIntegrationsListHandler(t.factory) as Handler,
    );
    const list = IntegrationsListResponseSchema.parse(body);
    expect(list.data.map((i) => i.id).sort()).toEqual([INT_LIVE, LIVE].sort());
    expect(list.total).toBe(2);
  });

  it('the sitemap lists no pair whose only edge is vetoed', async () => {
    const { xml } = await buildCatalogSitemap(t.db, 'https://www.example.test');
    expect(xml).toContain('/products/procore/integrations/sage');
    expect(xml).not.toContain('/products/okta/integrations/procore');
    expect(xml).not.toContain('/products/procore/integrations/okta');
  });

  it('the pair page lists only the live pair, and a vetoed-only pair lists none', async () => {
    const handler = createProductPairHandler(t.factory) as Handler;
    const path = '/api/products/:slug/integrations/:otherSlug';
    const pair = await get(path, '/api/products/procore/integrations/sage', handler);
    expect(pair.status).toBe(200);
    expect(pair.text).toContain(LIVE);
    expect(pair.text).not.toContain(VETOED);
    expect(pair.text).not.toContain('Vetoed pair');
    expect(pair.text).not.toContain(DUP_INT);
    const alone = await get(path, '/api/products/procore/integrations/okta', handler);
    expect((alone.body as { mechanisms: unknown[] }).mechanisms).toEqual([]);
    const rows = await get(path, '/api/products/sage/integrations/ineight', handler);
    expect(rows.text).toContain(INT_LIVE);
    expect(rows.text).not.toContain(INT_VETOED);
    expect(rows.text).not.toContain(DUP_INT_TWIN);
  });

  it('the pair timeline omits it', async () => {
    const { status, text } = await get(
      '/api/products/:slug/integrations/:otherSlug/timeline',
      '/api/products/procore/integrations/sage/timeline',
      createPairTimelineHandler(t.factory) as Handler,
    );
    expect(status).toBe(200);
    expect(text).not.toContain(VETOED);
    expect(text).not.toContain(DUP_INT);
  });

  it('both endpoint pages drop it from their lanes and its data objects from data_object_slugs', async () => {
    const handler = createProductDetailHandler(t.factory) as Handler;
    for (const slug of ['procore', 'sage']) {
      const page = await get('/api/products/:slug', `/api/products/${slug}`, handler);
      expect(page.status).toBe(200);
      expect(page.text).not.toContain(VETOED);
      expect(page.text).not.toContain(VETOED_ALONE);
      expect(page.text).not.toContain(INT_VETOED);
      for (const dup of DUPS) expect(page.text).not.toContain(dup);
      expect(page.text).not.toContain('"invoices"');
    }
    const procore = await get('/api/products/:slug', '/api/products/procore', handler);
    expect(procore.text).toContain(LIVE);
    expect(procore.text).toContain('"rfis"');
  });

  it("the Sync Service's own page lists none of its vetoed pairs", async () => {
    const handler = createProductDetailHandler(t.factory) as Handler;
    const page = await get('/api/products/:slug', '/api/products/rivets-sync', handler);
    expect(page.status).toBe(200);
    expect(page.text).not.toContain(VETOED);
    expect(page.text).not.toContain(VETOED_ALONE);
    expect(page.text).not.toContain(INT_VETOED);
    for (const dup of DUPS) expect(page.text).not.toContain(dup);
    const other = await get('/api/products/:slug', '/api/products/agave-sync', handler);
    expect(other.text).toContain(LIVE);
  });

  it('the stored counts are recomputed without it', async () => {
    const count = async (id: string) =>
      (await t.db.query.products.findFirst({ where: eq(products.id, id) }))!.integrationCount;
    expect(await count(P_PROCORE)).toBe(1); // LIVE only
    expect(await count(P_OKTA)).toBe(0);
    expect(await count(P_INEIGHT)).toBe(1); // INT_LIVE only
    expect(await count(S_SYNC)).toBe(0);
  });

  it('readPairCounterpartSlugs does not list a pair whose only edge is vetoed', async () => {
    expect(await readPairCounterpartSlugs(t.db, P_PROCORE)).toEqual(['sage']);
  });

  it('resolveMovedPair never redirects onto a vetoed pair', async () => {
    await t.db
      .insert(integrationEndpointMoves)
      .values([
        { integrationId: VETOED_ALONE, fromProductASlug: 'autodesk', fromProductBSlug: 'okta' },
      ]);
    expect(await resolveMovedPair(t.db, 'autodesk', 'okta')).toBeNull();
  });

  it('the Algolia sync deletes the vetoed records and keeps the live ones', async () => {
    const { requests } = await buildIntegrationRequests(t.db, {
      type: 'ids',
      ids: [LIVE, VETOED, VETOED_ALONE, INT_VETOED, INT_LIVE, ...DUPS],
    });
    const byAction = (action: string) =>
      requests
        .filter((r) => r.action === action)
        .map((r) => (r.body as { objectID: string }).objectID)
        .sort();
    expect(byAction('deleteObject')).toEqual([INT_VETOED, VETOED, VETOED_ALONE, ...DUPS].sort());
    expect(byAction('updateObject')).toEqual([INT_LIVE, LIVE].sort());
  });

  it("the vendor portal's Connectors section delivers only the live pair", async () => {
    const { status, text } = await get(
      '/api/vendor/products/:id/connectors',
      `/api/vendor/products/${P_PROCORE}/connectors`,
      createListVendorProductConnectorsHandler(t.factory) as Handler,
      seat(1, V_PROCORE),
    );
    expect(status).toBe(200);
    expect(text).not.toContain(VETOED);
    expect(text).not.toContain(DUP_INT);
  });

  it('the admin connector screens count and list only live pairs', async () => {
    const list = await get(
      '/api/admin/connector-catalogs',
      '/api/admin/connector-catalogs',
      createAdminConnectorCatalogsListHandler(t.factory) as Handler,
    );
    const counts = new Map(
      (list.body as { data: { id: string; counts: { evidenced_pairs: number } }[] }).data.map(
        (row) => [row.id, row.counts.evidenced_pairs],
      ),
    );
    expect(counts.get(CATALOG)).toBe(0);
    const pairs = await get(
      '/api/admin/connector-catalogs/:id/pairs',
      `/api/admin/connector-catalogs/${CATALOG}/pairs?lane=evidenced`,
      createAdminConnectorPairsHandler(t.factory) as Handler,
    );
    expect((pairs.body as { total: number }).total).toBe(0);
  });

  // ── AECI-2192 (ruling 66): the public sees nothing ─────────────────────────

  it('the legacy integration detail answers a removed row with its two slugs only, as a retired row', async () => {
    const res = await get(
      '/api/integrations/:id',
      `/api/integrations/${INT_VETOED}`,
      createIntegrationDetailHandler(t.factory) as Handler,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: INT_VETOED,
      retired: true,
      source: { slug: 'sage' },
      target: { slug: 'ineight' },
    });
    expect(res.text).not.toContain('Vetoed sync row');
  });

  it('the empty pair page’s closest matches list no removed row', async () => {
    const res = await get(
      '/api/products/:slug/integrations/:otherSlug/alternatives',
      '/api/products/procore/integrations/okta/alternatives',
      createPairAlternativesHandler(t.factory) as Handler,
    );
    expect(res.status).toBe(200);
    for (const id of [VETOED, VETOED_ALONE, INT_VETOED, ...DUPS]) {
      expect(res.text).not.toContain(id);
    }
  });

  it('no public payload carries a removal: no veto id, reason, remover, label or column', async () => {
    const rows = await t.db.query.syncServicePairVetoes.findMany();
    const vetoTraces = [
      ...rows.map((r) => r.id),
      'vetoed_at',
      'vetoedAt',
      'veto',
      'reason_code',
      'It is not offered',
      'We have not authorised it',
      'removed at the request',
      'Removed by',
    ];
    const reads: Array<[string, string, Handler]> = [
      [
        '/api/integrations',
        '/api/integrations',
        createIntegrationsListHandler(t.factory) as Handler,
      ],
      [
        '/api/products/:slug/integrations/:otherSlug',
        '/api/products/procore/integrations/sage',
        createProductPairHandler(t.factory) as Handler,
      ],
      [
        '/api/products/:slug/integrations/:otherSlug',
        '/api/products/procore/integrations/okta',
        createProductPairHandler(t.factory) as Handler,
      ],
      [
        '/api/products/:slug/integrations/:otherSlug/timeline',
        '/api/products/procore/integrations/okta/timeline',
        createPairTimelineHandler(t.factory) as Handler,
      ],
      [
        '/api/products/:slug',
        '/api/products/procore',
        createProductDetailHandler(t.factory) as Handler,
      ],
      [
        '/api/products/:slug',
        '/api/products/sage',
        createProductDetailHandler(t.factory) as Handler,
      ],
      [
        '/api/products/:slug',
        '/api/products/rivets-sync',
        createProductDetailHandler(t.factory) as Handler,
      ],
      [
        '/api/integrations/:id',
        `/api/integrations/${INT_VETOED}`,
        createIntegrationDetailHandler(t.factory) as Handler,
      ],
    ];
    for (const [path, url, handler] of reads) {
      const { text } = await get(path, url, handler);
      for (const trace of vetoTraces) expect(text, `${url} carries ${trace}`).not.toContain(trace);
    }
    const { xml } = await buildCatalogSitemap(t.db, 'https://www.example.test');
    for (const trace of vetoTraces) expect(xml).not.toContain(trace);
    // The Algolia records of a removed row are deleted, never written with a trace.
    const { requests } = await buildIntegrationRequests(t.db, {
      type: 'ids',
      ids: [VETOED, VETOED_ALONE, INT_VETOED, LIVE, INT_LIVE, ...DUPS],
    });
    const written = JSON.stringify(requests.filter((r) => r.action !== 'deleteObject'));
    for (const trace of vetoTraces) expect(written).not.toContain(trace);
  });

  it('a withdraw puts every row on the key back on the pair page', async () => {
    const res = await request(
      'POST',
      '/api/vendor/vetoes/:id/withdraw',
      `/api/vendor/vetoes/${vetoIds[0]}/withdraw`,
      createWithdrawVetoHandler(t.factory) as Handler,
      seat(1, V_PROCORE),
    );
    expect(res.status).toBe(200);
    const pair = await get(
      '/api/products/:slug/integrations/:otherSlug',
      '/api/products/procore/integrations/sage',
      createProductPairHandler(t.factory) as Handler,
    );
    expect(pair.text).toContain(VETOED);
    expect(pair.text).toContain(DUP_INT);
  });

  it('the integrations list, the endpoint pages and the counts drop the duplicate too', async () => {
    const count = async (id: string) =>
      (await t.db.query.products.findFirst({ where: eq(products.id, id) }))!.integrationCount;
    expect(await count(P_SAGE)).toBe(2); // LIVE and INT_LIVE
    const rows = await t.db
      .select({ id: integrations.id, vetoedAt: integrations.vetoedAt })
      .from(integrations);
    for (const dup of DUPS) expect(rows.find((r) => r.id === dup)?.vetoedAt).not.toBeNull();
  });
});
