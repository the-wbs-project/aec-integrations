/**
 * `GET /api/vendor/products/:id/connector-catalog` — the connector seat's own
 * catalogue (AECI-1083, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.16), against the REAL
 * `requireVendor()` guard and the in-memory D1 harness, with signed JWTs.
 *
 * What is pinned:
 *
 *   - **A seat is the whole gate.** The seat has no `vendor_entitlements` row (the
 *     AECI-740 shape) and reads.
 *   - **Ownership and role are one 404.** Another vendor's connector product, and the
 *     owner's product when it is not `connector`-role, answer the same 404.
 *   - **The read never shows a row the PATCH would refuse on ownership.** Every mapping
 *     id the read returns is one the AECI-724 PATCH answers with something other than 404.
 *   - **Curation-internal fields stay server-side.** No `notes`, no raw `decided_by`.
 *   - **Filters, search, order and paging** behave, and removed listings are hidden.
 */

import { VendorConnectorCatalogResponseSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  connectorCatalogSurfaces,
  connectorCatalogs,
  connectorStubMappings,
  connectorStubs,
  productVendors,
  products,
  profiles,
  vendorEntitlements,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import worker from '../index';
import { requireVendor, type AuthzVariables } from '../lib/authz';
import { makeTestJwks, type TestJwks } from '../test/auth';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import { createVendorConnectorCatalogHandler } from './vendor-connector-catalog';
import { createVendorUpdateConnectorStubMappingHandler } from './vendor-connector-stub-mappings';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SUPABASE_URL = 'https://test-project.supabase.co';
const AGAVE = u(1);
const PROCORE = u(2);
const AUTODESK = u(3);
const SAGE = u(4);
const OTHER_CONNECTOR = u(5);
const AGAVE_APP = u(6);
const AGAVE_VENDOR = u(10);
const OTHER_VENDOR = u(11);
const AGAVE_SEAT = u(500);
const OTHER_SEAT = u(501);
const CATALOG = 'fx-cat-agave';
const OTHER_CATALOG = 'fx-cat-other';
const TS = '2026-09-01T00:00:00.000Z';

let t: TestDb;
let jwks: TestJwks;
beforeAll(async () => {
  jwks = await makeTestJwks();
});
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

async function stub(id: string, catalogId: string, label: string | null, removed = false) {
  await t.db.insert(connectorStubs).values({
    id,
    catalogId,
    slug: id.replace(/^st-/, ''),
    label,
    url: `https://example.test/apps/${id}`,
    firstSeenAt: TS,
    lastSeenAt: TS,
    removedAt: removed ? TS : null,
  });
}

async function seed(opts: { managedBy?: 'review' | 'vendor'; role?: string } = {}) {
  await t.db.insert(products).values([
    {
      id: AGAVE,
      slug: 'agave',
      name: 'Agave',
      productRole: opts.role ?? 'connector',
      promotionStatus: 'promoted',
    },
    { id: PROCORE, slug: 'procore', name: 'Procore', promotionStatus: 'promoted' },
    { id: AUTODESK, slug: 'autodesk-build', name: 'Autodesk Build', promotionStatus: 'promoted' },
    { id: SAGE, slug: 'sage-intacct', name: 'Sage Intacct', promotionStatus: 'promoted' },
    {
      id: OTHER_CONNECTOR,
      slug: 'other-ipaas',
      name: 'Other iPaaS',
      productRole: 'connector',
      promotionStatus: 'promoted',
    },
    { id: AGAVE_APP, slug: 'agave-sync', name: 'Agave Sync', promotionStatus: 'promoted' },
  ]);
  await t.db.insert(vendors).values([
    { id: AGAVE_VENDOR, slug: 'agave-inc', companyName: 'Agave Inc' },
    { id: OTHER_VENDOR, slug: 'other-co', companyName: 'Other Co' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: AGAVE, vendorId: AGAVE_VENDOR, isPrimary: true },
    { productId: AGAVE_APP, vendorId: AGAVE_VENDOR },
    { productId: OTHER_CONNECTOR, vendorId: OTHER_VENDOR, isPrimary: true },
  ]);
  await t.db.insert(profiles).values([
    { id: AGAVE_SEAT, role: 'vendor_admin', vendorId: AGAVE_VENDOR },
    { id: OTHER_SEAT, role: 'vendor_admin', vendorId: OTHER_VENDOR },
  ]);
  await t.db.insert(connectorCatalogs).values([
    { id: CATALOG, connectorProductId: AGAVE, managedBy: opts.managedBy ?? 'vendor' },
    { id: OTHER_CATALOG, connectorProductId: OTHER_CONNECTOR, managedBy: 'vendor' },
  ]);
  await t.db.insert(connectorCatalogSurfaces).values([
    {
      id: 'sf-1',
      catalogId: CATALOG,
      surfaceRole: 'apps',
      lastIngestedAt: '2026-09-10T00:00:00.000Z',
    },
    { id: 'sf-2', catalogId: CATALOG, surfaceRole: 'pairs', lastIngestedAt: null },
  ]);
  // Labels chosen so name order differs from id order and from case order.
  await stub('st-procore', CATALOG, 'procore');
  await stub('st-autodesk', CATALOG, 'Autodesk Build');
  await stub('st-sage', CATALOG, 'Sage Intacct');
  await stub('st-unmatched', CATALOG, null);
  await stub('st-gone', CATALOG, 'Gone listing', true);
  await stub('st-other', OTHER_CATALOG, 'Other vendor listing');
  await t.db.insert(connectorStubMappings).values([
    {
      id: 'm-procore',
      stubId: 'st-procore',
      catalogId: CATALOG,
      productId: PROCORE,
      status: 'mapped',
      confidence: 'high',
      decidedBy: 'Chris Walton',
      decidedAt: TS,
      notes: 'Internal curation note',
    },
    {
      id: 'm-autodesk',
      stubId: 'st-autodesk',
      catalogId: CATALOG,
      productId: AUTODESK,
      status: 'mapped',
      confidence: 'medium',
      decidedBy: 'auto-name-match',
    },
    {
      id: 'm-sage',
      stubId: 'st-sage',
      catalogId: CATALOG,
      productId: null,
      status: 'out_of_scope',
      decidedBy: 'vendor:agave-inc',
      decidedAt: TS,
    },
    {
      id: 'm-gone',
      stubId: 'st-gone',
      catalogId: CATALOG,
      productId: SAGE,
      status: 'mapped',
      decidedBy: 'Chris Walton',
    },
    {
      id: 'm-other',
      stubId: 'st-other',
      catalogId: OTHER_CATALOG,
      productId: PROCORE,
      status: 'mapped',
      decidedBy: 'Chris Walton',
    },
  ]);
}

function guardedApp() {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  const guard = requireVendor({ getKey: jwks.getKey, dbFor: t.factory });
  a.get(
    '/api/vendor/products/:id/connector-catalog',
    guard,
    createVendorConnectorCatalogHandler(t.factory),
  );
  a.patch(
    '/api/vendor/connector-stub-mappings/:id',
    guard,
    createVendorUpdateConnectorStubMappingHandler(t.factory),
  );
  return a;
}

async function send(path: string, as: string | null, init: RequestInit = {}) {
  const token = as ? await jwks.mintToken({ sub: as, supabaseUrl: SUPABASE_URL }) : null;
  return guardedApp().request(
    path,
    {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    },
    { ENV: 'preview', SUPABASE_URL } as Env,
    fakeExecutionContext(),
  );
}

async function read(query = '', as: string | null = AGAVE_SEAT, productId = AGAVE) {
  const res = await send(`/api/vendor/products/${productId}/connector-catalog${query}`, as);
  return { res, body: (await res.json()) as Record<string, unknown> };
}

describe('GET /api/vendor/products/:id/connector-catalog — the owner seat', () => {
  it('reads with NO entitlement row, and ships the summary the tab needs', async () => {
    await seed();
    expect(await t.db.select().from(vendorEntitlements)).toHaveLength(0);

    const { res, body } = await read();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const parsed = VendorConnectorCatalogResponseSchema.parse(body);
    expect(parsed.catalog).toEqual({
      id: CATALOG,
      managed_by: 'vendor',
      // MAX ignores the never-ingested surface.
      last_ingested_at: '2026-09-10T00:00:00.000Z',
      // Removed listings are not listings.
      listings: 4,
      unmatched: 1,
      // Only `m-procore`: `m-autodesk` is auto-decided, `m-sage` names no product,
      // `m-gone` sits on a removed listing.
      publishable: 1,
    });
    expect(parsed.total).toBe(4);
    // A read writes nothing.
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('orders by name, case-insensitive, with the slug standing in for a missing label', async () => {
    await seed();
    const parsed = VendorConnectorCatalogResponseSchema.parse((await read()).body);
    // Autodesk Build, procore, Sage Intacct, unmatched (slug).
    expect(parsed.data.map((l) => l.id)).toEqual([
      'st-autodesk',
      'st-procore',
      'st-sage',
      'st-unmatched',
    ]);
  });

  it('never ships notes or a raw decided_by, and says what kind of decider stands behind a row', async () => {
    await seed();
    const { body } = await read();
    expect(JSON.stringify(body)).not.toContain('Internal curation note');
    expect(JSON.stringify(body)).not.toContain('Chris Walton');
    const parsed = VendorConnectorCatalogResponseSchema.parse(body);
    const byId = new Map(parsed.data.flatMap((l) => l.mappings).map((m) => [m.id, m]));
    expect(byId.get('m-procore')).toMatchObject({
      decided_by: 'aeci',
      publishable: true,
      product: { id: PROCORE, name: 'Procore', slug: 'procore' },
    });
    expect(byId.get('m-autodesk')).toMatchObject({ decided_by: 'automatic', publishable: false });
    expect(byId.get('m-sage')).toMatchObject({ decided_by: 'vendor', product: null });
    expect(parsed.data.find((l) => l.id === 'st-unmatched')?.mappings).toEqual([]);
  });

  it('filters by state, including the undecided anti-join, and searches label or slug', async () => {
    await seed();
    const unmatched = VendorConnectorCatalogResponseSchema.parse(
      (await read('?state=undecided')).body,
    );
    expect(unmatched.data.map((l) => l.id)).toEqual(['st-unmatched']);
    expect(unmatched.total).toBe(1);

    const mapped = VendorConnectorCatalogResponseSchema.parse((await read('?state=mapped')).body);
    // `st-gone` is mapped too, but removed.
    expect(mapped.data.map((l) => l.id)).toEqual(['st-autodesk', 'st-procore']);

    const search = VendorConnectorCatalogResponseSchema.parse((await read('?search=SAGE')).body);
    expect(search.data.map((l) => l.id)).toEqual(['st-sage']);
    // The summary describes the catalogue, not the filtered page.
    expect(search.catalog?.listings).toBe(4);
  });

  it('pages with a stable boundary', async () => {
    await seed();
    const first = VendorConnectorCatalogResponseSchema.parse((await read('?perPage=2')).body);
    const second = VendorConnectorCatalogResponseSchema.parse(
      (await read('?perPage=2&page=2')).body,
    );
    expect(first.data.map((l) => l.id)).toEqual(['st-autodesk', 'st-procore']);
    expect(second.data.map((l) => l.id)).toEqual(['st-sage', 'st-unmatched']);
    expect(first.total).toBe(4);
  });

  it('400s a perPage over the cap', async () => {
    await seed();
    expect((await read('?perPage=500')).res.status).toBe(400);
  });

  it('reads a REVIEW-managed catalogue too, and says so', async () => {
    await seed({ managedBy: 'review' });
    const parsed = VendorConnectorCatalogResponseSchema.parse((await read()).body);
    expect(parsed.catalog?.managed_by).toBe('review');
    expect(parsed.data).toHaveLength(4);
  });

  it('answers catalog: null for a connector product AECi holds no catalogue for', async () => {
    await seed();
    await t.db.delete(connectorCatalogs).where(eq(connectorCatalogs.id, CATALOG));
    const { res, body } = await read();
    expect(res.status).toBe(200);
    expect(VendorConnectorCatalogResponseSchema.parse(body)).toEqual({
      data: [],
      page: 1,
      perPage: 25,
      total: 0,
      product_id: AGAVE,
      catalog: null,
    });
  });
});

describe('GET /api/vendor/products/:id/connector-catalog — ownership and role are one 404', () => {
  it("404s another vendor's connector product", async () => {
    await seed();
    const { res, body } = await read('', AGAVE_SEAT, OTHER_CONNECTOR);
    expect(res.status).toBe(404);
    expect((body.error as { code: string }).code).toBe('NOT_FOUND');
  });

  it('404s the owner’s product when it is not connector-role', async () => {
    await seed({ role: 'application' });
    expect((await read()).res.status).toBe(404);
  });

  it('404s an owned application product', async () => {
    await seed();
    expect((await read('', AGAVE_SEAT, AGAVE_APP)).res.status).toBe(404);
  });

  it('404s an unknown product id', async () => {
    await seed();
    expect((await read('', AGAVE_SEAT, u(999))).res.status).toBe(404);
  });
});

describe('GET /api/vendor/products/:id/connector-catalog — lockstep with the AECI-724 PATCH', () => {
  it('every mapping it shows is one the PATCH does not 404', async () => {
    await seed();
    const parsed = VendorConnectorCatalogResponseSchema.parse((await read()).body);
    const ids = parsed.data.flatMap((l) => l.mappings).map((m) => m.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const res = await send(`/api/vendor/connector-stub-mappings/${id}`, AGAVE_SEAT, {
        method: 'PATCH',
        body: JSON.stringify({ confidence: 'low' }),
      });
      expect(res.status, id).not.toBe(404);
    }
    // And the other vendor's row, which the read never showed, IS a 404.
    const other = await send('/api/vendor/connector-stub-mappings/m-other', AGAVE_SEAT, {
      method: 'PATCH',
      body: JSON.stringify({ confidence: 'low' }),
    });
    expect(other.status).toBe(404);
  });
});

describe('GET /api/vendor/products/:id/connector-catalog — guard cells', () => {
  it('401s with no token', async () => {
    await seed();
    expect((await read('', null)).res.status).toBe(401);
  });

  it('403s a site admin', async () => {
    await seed();
    await t.db.insert(profiles).values({ id: u(900), role: 'admin' });
    expect((await read('', u(900))).res.status).toBe(403);
  });

  it('403s a banned seat', async () => {
    await seed();
    await t.db.update(profiles).set({ bannedAt: TS }).where(eq(profiles.id, AGAVE_SEAT));
    expect((await read()).res.status).toBe(403);
  });

  it('is mounted on the vendor sub-router and guarded: 401, not 404', async () => {
    const res = await worker.fetch(
      new Request(`https://api/api/vendor/products/${AGAVE}/connector-catalog`),
      { ENV: 'preview', SUPABASE_URL } as Env,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(401);
  });

  it('shows OTHER_SEAT only its own catalogue', async () => {
    await seed();
    const parsed = VendorConnectorCatalogResponseSchema.parse(
      (await read('', OTHER_SEAT, OTHER_CONNECTOR)).body,
    );
    expect(parsed.data.map((l) => l.id)).toEqual(['st-other']);
  });
});
