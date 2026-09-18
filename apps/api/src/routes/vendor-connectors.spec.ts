/**
 * `GET /api/vendor/products/:id/connectors` handler coverage (AECI-1013 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.13).
 *
 * Per the repo split, the session is stubbed and the HANDLER is exercised; the
 * real `requireVendor()` guard and the anon / reviewer / admin / banned cells live
 * in `vendor.authz-matrix.spec.ts`.
 *
 * The cases that matter are the ones that go wrong silently:
 *
 *  1. **Delivered and reachable never merge.** A partner already delivered by
 *     ANY path — an evidenced pair or a direct `integrations` row, in either
 *     orientation — is not listed as reachable too.
 *  2. **The canonical pair has no orientation meaning.** The owned product sits
 *     on the B side of the evidenced pair here, and still lists it.
 *  3. **A `derived` pair is reach.** All of Kroo's and Trimble's pairs are
 *     `derived`; a `curated` filter would report nothing.
 *  4. **Ownership is a 404**, never a 403 that confirms the product exists.
 */

import { VendorProductConnectorsResponseSchema } from '@aeci/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  connectorCatalogSurfaces,
  connectorCatalogs,
  connectorEvidencedPairs,
  connectorPairs,
  connectorStubMappings,
  connectorStubs,
  integrations,
  productVendors,
  products,
  profiles,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { createListVendorProductConnectorsHandler } from './vendor-connectors';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const VENDOR = uuid(1);
const SEAT = uuid(100);
// Ids chosen so the owned product sorts AFTER the delivered partner: the
// evidenced pair then stores the owned product on the B side.
const OWNED = uuid(30);
const NOT_OWNED = uuid(31);
const DELIVERED_PARTNER = uuid(20);
const DIRECT_PARTNER = uuid(21);
const REACH_ONLY = uuid(22);
const REACH_OTHER = uuid(23);
const KROO = uuid(40);
const AQUIFER = uuid(41);
const KROO_CATALOG = 'cat-kroo';
const AQUIFER_CATALOG = 'cat-aquifer';

const AUTH: AuthzVariables['auth'] = {
  userId: SEAT,
  email: 'ops@procore.test',
  role: 'vendor_admin',
  vendorId: VENDOR,
  entitlementTier: 'unclaimed',
  entitlement: null,
};

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values({ id: VENDOR, slug: 'procore-co', companyName: 'Procore' });
  await t.db.insert(products).values([
    { id: OWNED, slug: 'procore', name: 'Procore' },
    { id: NOT_OWNED, slug: 'autodesk-build', name: 'Autodesk Build' },
    { id: DELIVERED_PARTNER, slug: 'sage-intacct', name: 'Sage Intacct' },
    { id: DIRECT_PARTNER, slug: 'quickbooks-online', name: 'QuickBooks Online' },
    { id: REACH_ONLY, slug: 'acumatica', name: 'Acumatica' },
    { id: REACH_OTHER, slug: 'netsuite', name: 'NetSuite' },
    { id: KROO, slug: 'kroo-connector', name: 'Kroo Connector', productRole: 'connector' },
    { id: AQUIFER, slug: 'aquifer', name: 'Aquifer', productRole: 'connector' },
  ]);
  await t.db.insert(productVendors).values({ productId: OWNED, vendorId: VENDOR, isPrimary: true });
  await t.db.insert(profiles).values({ id: SEAT, role: 'vendor_admin', vendorId: VENDOR });
  await t.db.insert(connectorCatalogs).values([
    { id: KROO_CATALOG, connectorProductId: KROO, connectorAuthorship: 'platform' },
    { id: AQUIFER_CATALOG, connectorProductId: AQUIFER, connectorAuthorship: 'platform' },
  ]);
});
afterEach(() => t.dispose());

function app() {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', AUTH);
    await next();
  });
  a.get('/api/vendor/products/:id/connectors', createListVendorProductConnectorsHandler(t.factory));
  return a;
}

async function get(productId = OWNED) {
  const res = await app().request(
    `/api/vendor/products/${productId}/connectors`,
    {},
    TEST_ENV,
    fakeExecutionContext(),
  );
  return { res, body: (await res.json()) as Record<string, unknown> };
}

async function seedStub(id: string, catalogId: string): Promise<void> {
  await t.db.insert(connectorStubs).values({
    id,
    catalogId,
    slug: id,
    label: id,
    firstSeenAt: '2026-09-01T00:00:00.000Z',
    lastSeenAt: '2026-09-13T00:00:00.000Z',
  });
}

async function seedMapping(id: string, stubId: string, catalogId: string, productId: string) {
  await t.db.insert(connectorStubMappings).values({
    id,
    stubId,
    catalogId,
    productId,
    status: 'mapped',
    decidedBy: 'chris',
    decidedAt: '2026-09-01T00:00:00.000Z',
  });
}

/** The owned product and `partners` all mapped in `catalogId`, one `derived`
 *  pair from the owned stub to each partner stub. */
async function seedReach(catalogId: string, partners: string[]): Promise<void> {
  const owned = `${catalogId}-owned`;
  await seedStub(owned, catalogId);
  await seedMapping(`${owned}-m`, owned, catalogId, OWNED);
  for (const [i, partner] of partners.entries()) {
    // `z…` sorts after `<catalog>-owned`, so the owned stub is always stub A.
    const stub = `z-${catalogId}-${i}`;
    await seedStub(stub, catalogId);
    await seedMapping(`${stub}-m`, stub, catalogId, partner);
    await t.db.insert(connectorPairs).values({
      id: `${catalogId}-pair-${i}`,
      catalogId,
      stubAId: owned,
      stubBId: stub,
      surface: 'derived',
      firstSeenAt: '2026-09-01T00:00:00.000Z',
      lastSeenAt: '2026-09-13T00:00:00.000Z',
    });
  }
}

describe('GET /api/vendor/products/:id/connectors', () => {
  it('404s a product the caller does not own, never 403', async () => {
    const { res, body } = await get(NOT_OWNED);
    expect(res.status).toBe(404);
    expect((body.error as { code: string }).code).toBe('NOT_FOUND');
  });

  it('returns an empty list for a product no connector reaches', async () => {
    const { res, body } = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(VendorProductConnectorsResponseSchema.parse(body)).toEqual({
      product_id: OWNED,
      connectors: [],
    });
  });

  it('groups delivered and reachable per connector, and never lists a delivered partner as reachable', async () => {
    // Delivered through Kroo, with the owned product on the canonical B side.
    await t.db.insert(connectorEvidencedPairs).values({
      id: uuid(500),
      connectorProductId: KROO,
      productAId: DELIVERED_PARTNER,
      productBId: OWNED,
      direction: 'b_to_a',
    });
    // Delivered directly, in `integrations`, with the owned product as TARGET.
    await t.db.insert(integrations).values({
      id: uuid(501),
      sourceProductId: DIRECT_PARTNER,
      targetProductId: OWNED,
      mechanismKind: 'native',
    });
    // Kroo's catalogue reaches all three partners; only REACH_ONLY is undelivered.
    await seedReach(KROO_CATALOG, [DELIVERED_PARTNER, DIRECT_PARTNER, REACH_ONLY]);
    await t.db.insert(connectorCatalogSurfaces).values([
      {
        id: 's1',
        catalogId: KROO_CATALOG,
        surfaceRole: 'all',
        lastIngestedAt: '2026-09-10T00:00:00.000Z',
      },
    ]);

    const { res, body } = await get();
    expect(res.status).toBe(200);
    const parsed = VendorProductConnectorsResponseSchema.parse(body);
    expect(parsed.connectors).toHaveLength(1);
    const [kroo] = parsed.connectors;
    expect(kroo!.connector).toMatchObject({ id: KROO, slug: 'kroo-connector' });
    expect(kroo!.catalog_as_of).toBe('2026-09-10T00:00:00.000Z');
    expect(kroo!.delivered.map((d) => d.id)).toEqual([uuid(500)]);
    expect(kroo!.delivered[0]!.via?.id).toBe(KROO);
    expect(kroo!.reachable.map((p) => p.id)).toEqual([REACH_ONLY]);
  });

  it('lists a connector that only reaches, sorted after a delivering one', async () => {
    await t.db.insert(connectorEvidencedPairs).values({
      id: uuid(500),
      connectorProductId: KROO,
      productAId: DELIVERED_PARTNER,
      productBId: OWNED,
      direction: 'both',
    });
    await seedReach(AQUIFER_CATALOG, [REACH_OTHER, REACH_ONLY]);

    const parsed = VendorProductConnectorsResponseSchema.parse((await get()).body);
    expect(parsed.connectors.map((c) => c.connector.id)).toEqual([KROO, AQUIFER]);
    const [kroo, aquifer] = parsed.connectors;
    // Kroo has a delivered row and no catalogue surfaces, so no stamp.
    expect(kroo!.catalog_as_of).toBeNull();
    expect(kroo!.reachable).toEqual([]);
    // Partners sort by name, case-insensitively.
    expect(aquifer!.delivered).toEqual([]);
    expect(aquifer!.reachable.map((p) => p.name)).toEqual(['Acumatica', 'NetSuite']);
  });
});
