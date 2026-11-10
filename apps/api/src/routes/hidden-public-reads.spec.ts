/**
 * A hidden listing renders on no public read (AECI-1238, ADR 0052,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11d.6). The model is `retired-public-reads.spec.ts`.
 * The counts and id sets are `lib/count-lockstep.spec.ts`; the write is
 * `admin-listing-hide.spec.ts`. This file is every other public read: the product and
 * vendor lists, details and embeds, the pair page and the legacy integration detail,
 * the integrations list, the taxonomy embeds and counts, the sitemap, the home stats,
 * the slug redirects, the review and claim entry points, and Algolia membership.
 *
 * The seed puts a VISIBLE product beside each hidden one, so a predicate that empties
 * a read instead of dropping one row fails too.
 */

import { CategoryDetailSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  integrations,
  listingHides,
  productCategories,
  productVendors,
  products,
  slugRedirects,
  taxonomyCategories,
  vendors,
} from '../db/schema';
import { drizzleDriftCounter, drizzlePromotedIds } from '../lib/algolia-drift-deps';
import { buildIntegrationRequests } from '../lib/algolia-sync';
import { computeTotalProducts, computeTotalVendors } from '../lib/home-stats';
import { buildCatalogSitemap } from '../lib/sitemap-build';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import {
  createIntegrationDetailHandler,
  createIntegrationsListHandler,
  createProductPairHandler,
} from './integrations';
import { createProductReviewsListHandler } from './product-reviews';
import { createProductDetailHandler, createProductsListHandler } from './products';
import { resolveClaimTarget } from './requests';
import { createSlugRedirectResolveHandler } from './slug-redirects';
import { createTaxonomyDetailHandler } from './taxonomy-detail';
import { createVendorDetailHandler, createVendorsListHandler } from './vendors';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const V_LIVE = u(1);
const V_HIDDEN = u(2);
const P_PROCORE = u(10); // visible, V_LIVE
const P_REVIZTO = u(11); // visible, V_LIVE
const P_HIDDEN = u(12); // hidden on its own, joined to V_LIVE
const P_GONE = u(13); // hidden with V_HIDDEN
const I_LIVE = u(20); // procore -> revizto
const I_HIDDEN = u(21); // procore -> hidden
const I_POWERED = u(22); // procore -> revizto, powered by the hidden product
const CAT = u(30);
const HIDDEN_AT = '2026-11-01T00:00:00.000Z';

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(listingHides).values([
    {
      id: u(40),
      entityType: 'vendor',
      entityId: V_HIDDEN,
      kind: 'defunct',
      reason: 'The company closed.',
      receivedAt: '2026-10-31',
      setAt: HIDDEN_AT,
    },
    {
      id: u(41),
      entityType: 'product',
      entityId: P_GONE,
      parentId: u(40),
      kind: 'defunct',
      reason: 'The company closed.',
      receivedAt: '2026-10-31',
      setAt: HIDDEN_AT,
    },
    {
      id: u(42),
      entityType: 'product',
      entityId: P_HIDDEN,
      kind: 'lawful_order',
      reason: 'A court order.',
      receivedAt: '2026-10-31',
      setAt: HIDDEN_AT,
    },
  ]);
  await t.db.insert(vendors).values([
    { id: V_LIVE, slug: 'acme', companyName: 'Acme', promotionStatus: 'promoted' },
    {
      id: V_HIDDEN,
      slug: 'gone-co',
      companyName: 'Gone Co',
      promotionStatus: 'promoted',
      hiddenAt: HIDDEN_AT,
      hiddenHideId: u(40),
    },
  ]);
  await t.db.insert(products).values([
    { id: P_PROCORE, slug: 'procore', name: 'Procore', promotionStatus: 'promoted' },
    { id: P_REVIZTO, slug: 'revizto', name: 'Revizto', promotionStatus: 'promoted' },
    {
      id: P_HIDDEN,
      slug: 'hidden-tool',
      name: 'Hidden Tool',
      promotionStatus: 'promoted',
      hiddenAt: HIDDEN_AT,
      hiddenHideId: u(42),
    },
    {
      id: P_GONE,
      slug: 'gone-tool',
      name: 'Gone Tool',
      promotionStatus: 'promoted',
      hiddenAt: HIDDEN_AT,
      hiddenHideId: u(41),
    },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_PROCORE, vendorId: V_LIVE, isPrimary: true },
    { productId: P_REVIZTO, vendorId: V_LIVE, isPrimary: true },
    { productId: P_HIDDEN, vendorId: V_LIVE, isPrimary: true },
    { productId: P_GONE, vendorId: V_HIDDEN, isPrimary: true },
  ]);
  await t.db.insert(integrations).values([
    {
      id: I_LIVE,
      name: 'Live link',
      sourceProductId: P_PROCORE,
      targetProductId: P_REVIZTO,
      mechanismKind: 'native',
    },
    {
      id: I_HIDDEN,
      name: 'Hidden link',
      sourceProductId: P_PROCORE,
      targetProductId: P_HIDDEN,
      mechanismKind: 'api',
    },
    {
      id: I_POWERED,
      name: 'Powered link',
      sourceProductId: P_PROCORE,
      targetProductId: P_REVIZTO,
      poweredByProductId: P_HIDDEN,
      mechanismKind: 'iPaaS',
    },
  ]);
  await t.db.insert(taxonomyCategories).values({ id: CAT, slug: 'pm', name: 'PM' });
  await t.db.insert(productCategories).values([
    { productId: P_PROCORE, categoryId: CAT },
    { productId: P_HIDDEN, categoryId: CAT },
  ]);
  await t.db.insert(slugRedirects).values([
    { entity: 'product', fromSlug: 'old-hidden', toSlug: 'hidden-tool' },
    { entity: 'product', fromSlug: 'old-procore', toSlug: 'procore' },
  ]);
});
afterEach(() => t.dispose());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = any;

async function get(
  path: string,
  url: string,
  handler: Parameters<typeof buildAppWithHandler>[0]['handler'],
): Promise<{ status: number; body: JsonBody }> {
  const res = await buildAppWithHandler({ method: 'get', path, handler }).request(
    url,
    {},
    TEST_ENV,
    fakeExecutionContext(),
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('a hidden listing renders on no public read (AECI-1238)', () => {
  it('the product list, its total and a search drop hidden products', async () => {
    const { body } = await get(
      '/api/products',
      '/api/products',
      createProductsListHandler(t.factory),
    );
    expect(body.data.map((p: { slug: string }) => p.slug).sort()).toEqual(['procore', 'revizto']);
    expect(body.total).toBe(2);
    const search = await get(
      '/api/products',
      '/api/products?search=tool',
      createProductsListHandler(t.factory),
    );
    expect(search.body.total).toBe(0);
  });

  it('a hidden product 404s, and a visible one embeds no edge through it', async () => {
    const handler = createProductDetailHandler(t.factory);
    expect((await get('/api/products/:slug', '/api/products/hidden-tool', handler)).status).toBe(
      404,
    );
    expect((await get('/api/products/:slug', '/api/products/gone-tool', handler)).status).toBe(404);
    const procore = await get('/api/products/:slug', '/api/products/procore', handler);
    expect(procore.status).toBe(200);
    const edges = [
      ...procore.body.integrations_as_source,
      ...procore.body.integrations_as_target,
    ].map((e: { id: string }) => e.id);
    expect(edges).toEqual([I_LIVE]);
    expect(procore.body.related_products.map((p: { slug: string }) => p.slug)).not.toContain(
      'hidden-tool',
    );
    const reviews = await get(
      '/api/products/:slug/reviews',
      '/api/products/hidden-tool/reviews',
      createProductReviewsListHandler(t.factory),
    );
    expect(reviews.status).toBe(404);
  });

  it('the vendor list drops a hidden company, and a detail 404s it', async () => {
    const list = await get('/api/vendors', '/api/vendors', createVendorsListHandler(t.factory));
    expect(list.body.data.map((v: { slug: string }) => v.slug)).toEqual(['acme']);
    expect(list.body.total).toBe(1);
    // The live company's count and embeds leave its hidden product out.
    expect(list.body.data[0].product_count).toBe(2);
    const handler = createVendorDetailHandler(t.factory);
    expect((await get('/api/vendors/:slug', '/api/vendors/gone-co', handler)).status).toBe(404);
    const acme = await get('/api/vendors/:slug', '/api/vendors/acme', handler);
    expect(acme.body.products.map((p: { slug: string }) => p.slug).sort()).toEqual([
      'procore',
      'revizto',
    ]);
  });

  it('the pair page 404s through a hidden endpoint, and the integrations list drops it', async () => {
    const pair = createProductPairHandler(t.factory);
    const path = '/api/products/:slug/integrations/:otherSlug';
    expect((await get(path, '/api/products/procore/integrations/hidden-tool', pair)).status).toBe(
      404,
    );
    const live = await get(path, '/api/products/procore/integrations/revizto', pair);
    expect(live.status).toBe(200);
    // The edge powered by a hidden connector is not live either.
    expect(live.body.mechanisms.map((m: { id: string }) => m.id)).toEqual([I_LIVE]);

    const list = await get(
      '/api/integrations',
      '/api/integrations',
      createIntegrationsListHandler(t.factory),
    );
    expect(list.body.data.map((i: { id: string }) => i.id)).toEqual([I_LIVE]);
    expect(list.body.total).toBe(1);

    const detail = createIntegrationDetailHandler(t.factory);
    expect(
      (await get('/api/integrations/:id', `/api/integrations/${I_HIDDEN}`, detail)).status,
    ).toBe(404);
    expect((await get('/api/integrations/:id', `/api/integrations/${I_LIVE}`, detail)).status).toBe(
      200,
    );
  });

  it('a hidden builder is dropped from a live integration, not the integration', async () => {
    // A third-party builder hidden on its own leaves the edge between two visible
    // products live. No read may name it, show its logo or link to its 404.
    const builtBy = async (vendorId: string) =>
      t.db
        .update(integrations)
        .set({
          builtByVendorId: vendorId,
          claimedAt: '2026-10-01T00:00:00.000Z',
          vendorEditedAt: '2026-10-02T00:00:00.000Z',
          origin: 'vendor',
        })
        .where(eq(integrations.id, I_LIVE));
    const reads = async () => {
      const pair = await get(
        '/api/products/:slug/integrations/:otherSlug',
        '/api/products/procore/integrations/revizto',
        createProductPairHandler(t.factory),
      );
      const detail = await get(
        '/api/integrations/:id',
        `/api/integrations/${I_LIVE}`,
        createIntegrationDetailHandler(t.factory),
      );
      const product = await get(
        '/api/products/:slug',
        '/api/products/procore',
        createProductDetailHandler(t.factory),
      );
      const edge = product.body.integrations_as_source.find((e: { id: string }) => e.id === I_LIVE);
      return { pair, detail, edge };
    };

    await builtBy(V_HIDDEN);
    const hidden = await reads();
    expect(hidden.pair.status).toBe(200);
    expect(hidden.pair.body.mechanisms.map((m: { id: string }) => m.id)).toEqual([I_LIVE]);
    expect(hidden.pair.body.mechanisms[0].built_by_vendor).toBeNull();
    expect(hidden.pair.body.mechanisms[0].caption).toBeNull();
    expect(hidden.detail.status).toBe(200);
    expect(hidden.detail.body.built_by_vendor).toBeNull();
    expect(hidden.edge.caption).toBeNull();
    for (const body of [hidden.pair.body, hidden.detail.body, hidden.edge]) {
      expect(JSON.stringify(body)).not.toContain('Gone Co');
      expect(JSON.stringify(body)).not.toContain('gone-co');
    }

    // The control: a visible builder still shows, so the null above is the hide.
    await builtBy(V_LIVE);
    const visible = await reads();
    expect(visible.pair.body.mechanisms[0].built_by_vendor).toMatchObject({ slug: 'acme' });
    expect(visible.pair.body.mechanisms[0].caption).toMatchObject({ vendor_names: ['Acme'] });
    expect(visible.detail.body.built_by_vendor).toMatchObject({ slug: 'acme' });
    expect(visible.edge.caption).toMatchObject({ vendor_names: ['Acme'] });
  });

  it('a term page lists and counts visible products only', async () => {
    const res = await get(
      '/api/categories/:slug',
      '/api/categories/pm',
      createTaxonomyDetailHandler(
        { resource: 'category', schema: CategoryDetailSchema },
        t.factory,
      ),
    );
    expect(res.status).toBe(200);
    expect(res.body.products.map((p: { slug: string }) => p.slug)).toEqual(['procore']);
    expect(res.body.product_count).toBe(1);
  });

  it('the sitemap leaves out the hidden product, company and pair', async () => {
    const { xml } = await buildCatalogSitemap(t.db, 'https://www.example.test');
    expect(xml).toContain('/products/procore<');
    expect(xml).not.toContain('hidden-tool');
    expect(xml).not.toContain('gone-tool');
    expect(xml).not.toContain('/vendors/gone-co');
    expect(xml).toContain('/products/procore/integrations/revizto');
  });

  it('the home totals count visible products and companies', async () => {
    expect(await computeTotalProducts(t.db)).toBe(2);
    expect(await computeTotalVendors(t.db)).toBe(1);
  });

  it('a slug redirect never points at a hidden listing', async () => {
    const handler = createSlugRedirectResolveHandler(t.factory);
    const path = '/api/slug-redirects/:entity/:fromSlug';
    expect((await get(path, '/api/slug-redirects/product/old-hidden', handler)).status).toBe(404);
    const live = await get(path, '/api/slug-redirects/product/old-procore', handler);
    expect(live.body.to_slug).toBe('procore');
  });

  it('a hidden listing is no claim or correction target', async () => {
    await expect(resolveClaimTarget(t.db, 'vendor', 'gone-co')).rejects.toMatchObject({
      status: 404,
    });
    await expect(resolveClaimTarget(t.db, 'product', 'hidden-tool')).rejects.toMatchObject({
      status: 404,
    });
    await expect(resolveClaimTarget(t.db, 'product', 'procore')).resolves.toMatchObject({
      id: V_LIVE,
    });
  });

  it('Algolia membership is promoted AND visible, and the sync deletes the rest by id', async () => {
    const ids = drizzlePromotedIds(t.db);
    expect([...(await ids.productIds())].sort()).toEqual([P_PROCORE, P_REVIZTO].sort());
    expect([...(await ids.vendorIds())]).toEqual([V_LIVE]);
    expect([...(await ids.integrationIds())]).toEqual([I_LIVE]);
    const counter = drizzleDriftCounter(t.db);
    expect(await counter.product.count({ where: { promotionStatus: 'promoted' } })).toBe(2);

    const { requests } = await buildIntegrationRequests(t.db, {
      type: 'ids',
      ids: [I_LIVE, I_HIDDEN, I_POWERED],
    });
    const byAction = (action: string) =>
      requests
        .filter((r) => r.action === action)
        .map((r) => (r.body as { objectID: string }).objectID)
        .sort();
    expect(byAction('updateObject')).toEqual([I_LIVE]);
    expect(byAction('deleteObject')).toEqual([I_HIDDEN, I_POWERED].sort());
  });

  it('a restore puts the product back on every read', async () => {
    await t.db
      .update(products)
      .set({ hiddenAt: null, hiddenHideId: null })
      .where(eq(products.id, P_HIDDEN));
    const list = await get('/api/products', '/api/products', createProductsListHandler(t.factory));
    expect(list.body.total).toBe(3);
    expect([...(await drizzlePromotedIds(t.db).integrationIds())].sort()).toEqual(
      [I_LIVE, I_HIDDEN, I_POWERED].sort(),
    );
  });
});
