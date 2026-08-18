/**
 * Vendor-portal deny matrix (AECI-520) — the acceptance gate for
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.
 *
 * There is NO row-level security behind `/api/vendor/*` (ADR 0016 — D1 has none).
 * The only things stopping vendor A from reading or writing vendor B's rows are
 * (1) the `requireVendor()` guard and (2) the `vendor_id` filter inside each
 * handler. So unlike `vendor.spec.ts` — which stubs the session — this spec
 * composes the REAL guard with the REAL handlers over the in-memory D1 harness,
 * driving them with genuinely signed JWTs. If this file passes, the isolation
 * claim is tested end to end rather than asserted.
 *
 * The matrix (▸ = the cells that only exist here):
 *   every /api/vendor/* route
 *     anon                     → 401
 *     verified token, no row   → 401
 *     reviewer                 → 403
 *   ▸ site admin               → 403  (no impersonation at launch)
 *   ▸ vendor_admin, vendor_id null → 403 (half-granted seat)
 *     banned vendor_admin      → 403  (ban precedes role — the §7 gate)
 *     granted seat             → 200
 *   ▸ CROSS-VENDOR, as a fully valid seat of another vendor:
 *       GET  /me      → only own vendor + own products
 *       GET  /seats   → only own seats
 *       PATCH /products/:id on a foreign product → 404, row unmutated, no audit
 *
 * AECI-607 adds the four `/products/:id/versions` routes to every cell above,
 * plus the one gate that is NOT part of `requireVendor()`: version WRITES also
 * require `vendors.verified` (`STAGE_2_ATTESTATIONS_SPEC.md` §1), and ownership
 * is evaluated first so a non-owner still gets a 404 rather than a 403 that
 * would confirm the product exists.
 *
 * AECI-301 adds the four attestation-authoring routes on the same terms, with the
 * ownership question asked one grain up — at the INTEGRATION, via
 * `lib/attestation-authority.ts` rather than `requireOwnedProduct`. Two properties
 * are specific to it and are pinned below: a claim on an integration the caller
 * touches neither endpoint of is a 404 **indistinguishable from a claim that does
 * not exist**, and `GET /api/vendor/integrations` shows a vendor only its own
 * attestable surface.
 *
 * AECI-606 adds `GET /api/vendor/data-objects`, the surface's FIRST route with no
 * ownership question at all — the `data_object` vocabulary is AECi-curated and
 * holds no vendor-owned rows, so there is nothing to scope. It still takes every
 * guard cell above. What differs is the isolation cell: for every other route the
 * assertion is that two vendors see DIFFERENT data, and here it is that they see
 * the SAME data, deliberately. That inversion is why the cell is written out
 * rather than left to the generic sweep.
 */

import { ApiErrorCode } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  attestations,
  auditLog,
  claims,
  integrations,
  productVendors,
  productVersions,
  products,
  profiles,
  taxonomyDataObjects,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { requireVendor, type AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { makeTestJwks, type TestJwks } from '../test/auth';
import { fakeExecutionContext } from '../test/helpers';
import {
  createUpdateVendorProductHandler,
  createUpdateVendorProfileHandler,
  createVendorMeHandler,
  createVendorSeatsHandler,
} from './vendor';
import { createListVendorNotificationsHandler } from './vendor-notifications';
import {
  createDeleteProductVersionHandler,
  createListProductVersionsHandler,
  createProductVersionHandler,
  createUpdateProductVersionHandler,
} from './vendor-product-versions';
import {
  createListVendorIntegrationsHandler,
  createRetractVendorAttestationHandler,
  createUpsertVendorAttestationHandler,
  createVendorClaimHandler,
} from './vendor-attestations';
import { createListDataObjectsHandler } from './vendor-data-objects';

const SUPABASE_URL = 'https://test-project.supabase.co';
const ENV = { ENV: 'preview', SUPABASE_URL } as Env;

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const VENDOR_UNVERIFIED = uuid(3); // claimed but not yet Verified (AECI-607 gate)
const PRODUCT_A = uuid(10);
const PRODUCT_B = uuid(11);
const PRODUCT_UNVERIFIED = uuid(12);
const VERSION_A = uuid(20); // a product_versions row on PRODUCT_A
const VERSION_B = uuid(21); // …and one on PRODUCT_B

// AECI-301 fixtures. INTEGRATION_AB is the one vendor A may attest on (it owns
// endpoint A); INTEGRATION_BU touches neither of A's products.
const INTEGRATION_AB = uuid(30);
const INTEGRATION_BU = uuid(31);
const DATA_OBJECT_RFIS = uuid(40);
const DATA_OBJECT_SUBMITTALS = uuid(41);
const CLAIM_AB = uuid(50); // on INTEGRATION_AB — A may attest
const CLAIM_BU = uuid(51); // on INTEGRATION_BU — A may not
const CLAIM_UNVERIFIED = uuid(52); // on INTEGRATION_BU — the unverified vendor's own

const SEAT_A = uuid(100); // granted seat on vendor A
const SEAT_B = uuid(101); // granted seat on vendor B
const SEAT_BANNED = uuid(102); // banned seat on vendor A
const SEAT_UNLINKED = uuid(103); // vendor_admin with a null vendor_id
const REVIEWER = uuid(104);
const ADMIN = uuid(105);
const SEAT_UNVERIFIED = uuid(106); // granted seat on an unverified vendor

let t: TestDb;
let jwks: TestJwks;

beforeEach(async () => {
  t = await makeTestDb();
  jwks = await makeTestJwks();

  // A and B are Verified so the granted-seat cells reach the handlers; the
  // Verified gate itself is exercised through VENDOR_UNVERIFIED below.
  await t.db.insert(vendors).values([
    {
      id: VENDOR_A,
      slug: 'autodesk',
      companyName: 'Autodesk',
      description: 'A blurb',
      verified: true,
    },
    {
      id: VENDOR_B,
      slug: 'bentley',
      companyName: 'Bentley',
      description: 'B blurb',
      verified: true,
    },
    { id: VENDOR_UNVERIFIED, slug: 'trimble', companyName: 'Trimble', verified: false },
  ]);
  await t.db.insert(products).values([
    { id: PRODUCT_A, slug: 'revit', name: 'Revit', description: 'A product' },
    { id: PRODUCT_B, slug: 'microstation', name: 'MicroStation', description: 'B product' },
    { id: PRODUCT_UNVERIFIED, slug: 'tekla', name: 'Tekla', description: 'U product' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: PRODUCT_A, vendorId: VENDOR_A, isPrimary: true },
    { productId: PRODUCT_B, vendorId: VENDOR_B, isPrimary: true },
    { productId: PRODUCT_UNVERIFIED, vendorId: VENDOR_UNVERIFIED, isPrimary: true },
  ]);
  await t.db.insert(productVersions).values([
    { id: VERSION_A, productId: PRODUCT_A, label: 'v1', sortKey: 100_000_000_000 },
    { id: VERSION_B, productId: PRODUCT_B, label: 'v1', sortKey: 100_000_000_000 },
  ]);
  await t.db.insert(integrations).values([
    { id: INTEGRATION_AB, sourceProductId: PRODUCT_A, targetProductId: PRODUCT_B },
    { id: INTEGRATION_BU, sourceProductId: PRODUCT_B, targetProductId: PRODUCT_UNVERIFIED },
  ]);
  await t.db.insert(taxonomyDataObjects).values([
    // `displayOrder` inverts the alphabetical order on purpose, so the
    // AECI-606 vocabulary cell below proves the endpoint actually orders by it
    // rather than happening to agree with the slug sort.
    { id: DATA_OBJECT_RFIS, slug: 'rfis', name: 'RFIs', displayOrder: 110 },
    { id: DATA_OBJECT_SUBMITTALS, slug: 'submittals', name: 'Submittals', displayOrder: 20 },
  ]);
  await t.db.insert(claims).values([
    {
      id: CLAIM_AB,
      integrationId: INTEGRATION_AB,
      dataObjectId: DATA_OBJECT_RFIS,
      direction: 'a_to_b',
    },
    {
      id: CLAIM_BU,
      integrationId: INTEGRATION_BU,
      dataObjectId: DATA_OBJECT_RFIS,
      direction: 'a_to_b',
    },
    {
      id: CLAIM_UNVERIFIED,
      integrationId: INTEGRATION_BU,
      dataObjectId: DATA_OBJECT_SUBMITTALS,
      direction: 'b_to_a',
    },
  ]);
  // A live attestation of vendor A's, so the granted-seat DELETE cell has
  // something of its own to retract.
  await t.db.insert(attestations).values({
    id: uuid(60),
    claimId: CLAIM_AB,
    source: 'vendor_a',
    asserted: true,
    attestedByVendorId: VENDOR_A,
  });
  await t.db.insert(profiles).values([
    { id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR_A },
    { id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR_B },
    {
      id: SEAT_BANNED,
      role: 'vendor_admin',
      vendorId: VENDOR_A,
      bannedAt: '2026-07-01T00:00:00.000Z',
      banReason: 'Portal abuse',
    },
    { id: SEAT_UNLINKED, role: 'vendor_admin', vendorId: null },
    { id: REVIEWER, role: 'reviewer' },
    { id: ADMIN, role: 'admin' },
    { id: SEAT_UNVERIFIED, role: 'vendor_admin', vendorId: VENDOR_UNVERIFIED },
  ]);
});
afterEach(() => t.dispose());

/** The real guard in front of the real handlers — nothing stubbed but the
 *  JWKS (offline keypair) and the Supabase email lookup. */
function makeApp() {
  const guard = { getKey: jwks.getKey, dbFor: t.factory };
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.get('/api/vendor/me', requireVendor(guard), createVendorMeHandler(t.factory));
  app.get(
    '/api/vendor/seats',
    requireVendor(guard),
    createVendorSeatsHandler(t.factory, async () => new Map()),
  );
  app.get(
    '/api/vendor/notifications',
    requireVendor(guard),
    createListVendorNotificationsHandler(t.factory),
  );
  app.patch(
    '/api/vendor/profile',
    requireVendor(guard),
    createUpdateVendorProfileHandler(t.factory),
  );
  // Version routes registered BEFORE `/products/:id`, matching `index.ts`.
  app.get(
    '/api/vendor/products/:id/versions',
    requireVendor(guard),
    createListProductVersionsHandler(t.factory),
  );
  app.post(
    '/api/vendor/products/:id/versions',
    requireVendor(guard),
    createProductVersionHandler(t.factory),
  );
  app.patch(
    '/api/vendor/products/:id/versions/:versionId',
    requireVendor(guard),
    createUpdateProductVersionHandler(t.factory),
  );
  app.delete(
    '/api/vendor/products/:id/versions/:versionId',
    requireVendor(guard),
    createDeleteProductVersionHandler(t.factory),
  );
  app.patch(
    '/api/vendor/products/:id',
    requireVendor(guard),
    createUpdateVendorProductHandler(t.factory),
  );
  // AECI-301 — no path overlap with the product routes, so ordering is free.
  app.get(
    '/api/vendor/integrations',
    requireVendor(guard),
    createListVendorIntegrationsHandler(t.factory),
  );
  app.post('/api/vendor/claims', requireVendor(guard), createVendorClaimHandler(t.factory));
  app.put(
    '/api/vendor/claims/:claimId/attestation',
    requireVendor(guard),
    createUpsertVendorAttestationHandler(t.factory),
  );
  app.delete(
    '/api/vendor/claims/:claimId/attestation',
    requireVendor(guard),
    createRetractVendorAttestationHandler(t.factory),
  );
  // AECI-606 — guard only; no authority resolution, no verified gate.
  app.get(
    '/api/vendor/data-objects',
    requireVendor(guard),
    createListDataObjectsHandler(t.factory),
  );
  return app;
}

async function tokenFor(sub: string): Promise<string> {
  return jwks.mintToken({ sub, supabaseUrl: SUPABASE_URL });
}

/** Success payloads and the error envelope share this alias so the deny cells
 *  and the isolation cells can index the body without four casts per test. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

type Result = { status: number; body: JsonBody };

async function call(path: string, method: string, sub?: string, body?: unknown): Promise<Result> {
  const headers: Record<string, string> = {};
  if (sub) headers.Authorization = `Bearer ${await tokenFor(sub)}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await makeApp().request(
    path,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
    ENV,
    fakeExecutionContext(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as JsonBody };
}

/** Every route on the surface, with a minimal valid body for the writes and the
 *  status a granted seat of the OWNING vendor should get. */
const ROUTES: ReadonlyArray<{ path: string; method: string; body?: unknown; ok?: number }> = [
  { path: '/api/vendor/me', method: 'GET' },
  { path: '/api/vendor/seats', method: 'GET' },
  { path: '/api/vendor/notifications', method: 'GET' },
  { path: '/api/vendor/profile', method: 'PATCH', body: { description: 'edited' } },
  {
    path: `/api/vendor/products/${PRODUCT_A}`,
    method: 'PATCH',
    body: { description: 'edited' },
  },
  { path: `/api/vendor/products/${PRODUCT_A}/versions`, method: 'GET' },
  {
    path: `/api/vendor/products/${PRODUCT_A}/versions`,
    method: 'POST',
    body: { label: '2026.1' },
    ok: 201,
  },
  {
    path: `/api/vendor/products/${PRODUCT_A}/versions/${VERSION_A}`,
    method: 'PATCH',
    body: { label: 'v2' },
  },
  {
    path: `/api/vendor/products/${PRODUCT_A}/versions/${VERSION_A}`,
    method: 'DELETE',
    ok: 204,
  },
  { path: '/api/vendor/integrations', method: 'GET' },
  {
    path: '/api/vendor/claims',
    method: 'POST',
    // `submittals` rather than `rfis`: the seeded CLAIM_AB already occupies
    // (INTEGRATION_AB, rfis, a_to_b), and a duplicate identity is a 400.
    body: { integration_id: INTEGRATION_AB, data_object: 'submittals', direction: 'outbound' },
    ok: 201,
  },
  {
    path: `/api/vendor/claims/${CLAIM_AB}/attestation`,
    method: 'PUT',
    body: { asserted: true },
  },
  {
    path: `/api/vendor/claims/${CLAIM_AB}/attestation`,
    method: 'DELETE',
    ok: 204,
  },
  { path: '/api/vendor/data-objects', method: 'GET' },
];

/** The version routes that WRITE, and are therefore Verified-gated. */
const VERSION_WRITE_ROUTES: ReadonlyArray<{
  path: (p: string, v: string) => string;
  method: string;
  body?: unknown;
}> = [
  { path: (p) => `/api/vendor/products/${p}/versions`, method: 'POST', body: { label: 'v9' } },
  {
    path: (p, v) => `/api/vendor/products/${p}/versions/${v}`,
    method: 'PATCH',
    body: { label: 'v9' },
  },
  { path: (p, v) => `/api/vendor/products/${p}/versions/${v}`, method: 'DELETE' },
];

describe('/api/vendor/* — guard deny cells (every route)', () => {
  it.each(ROUTES)('$method $path rejects anon with 401', async ({ path, method, body }) => {
    const { status, body: res } = await call(path, method, undefined, body);
    expect(status).toBe(401);
    expect(res.error.code).toBe(ApiErrorCode.UNAUTHENTICATED);
  });

  it.each(ROUTES)(
    '$method $path rejects a verified token with no profile (401)',
    async ({ path, method, body }) => {
      expect((await call(path, method, uuid(900), body)).status).toBe(401);
    },
  );

  it.each(ROUTES)('$method $path rejects a reviewer with 403', async ({ path, method, body }) => {
    const { status, body: res } = await call(path, method, REVIEWER, body);
    expect(status).toBe(403);
    expect(res.error.code).toBe(ApiErrorCode.FORBIDDEN);
  });

  it.each(ROUTES)(
    '$method $path rejects a SITE ADMIN with 403 — no impersonation',
    async ({ path, method, body }) => {
      const { status, body: res } = await call(path, method, ADMIN, body);
      expect(status).toBe(403);
      expect(res.error.message).toBe('Vendor admin role required');
    },
  );

  it.each(ROUTES)(
    '$method $path rejects a vendor_admin with a null vendor_id (403)',
    async ({ path, method, body }) => {
      const { status, body: res } = await call(path, method, SEAT_UNLINKED, body);
      expect(status).toBe(403);
      expect(res.error.message).toBe('Vendor account is not linked to a vendor');
    },
  );

  it.each(ROUTES)(
    '$method $path rejects a BANNED vendor_admin with 403 (§7 gate)',
    async ({ path, method, body }) => {
      const { status, body: res } = await call(path, method, SEAT_BANNED, body);
      expect(status).toBe(403);
      expect(res.error.message).toBe('Portal abuse');
    },
  );

  it.each(ROUTES)('$method $path accepts a granted seat', async ({ path, method, body, ok }) => {
    expect((await call(path, method, SEAT_A, body)).status).toBe(ok ?? 200);
  });
});

describe('/api/vendor/products/:id/versions — the Verified capability gate (AECI-607)', () => {
  it.each(VERSION_WRITE_ROUTES)(
    '$method rejects an UNVERIFIED vendor on its own product with 403',
    async ({ path, method, body }) => {
      const versionId = uuid(30);
      await t.db
        .insert(productVersions)
        .values({ id: versionId, productId: PRODUCT_UNVERIFIED, label: 'v1', sortKey: 1 });

      const { status, body: res } = await call(
        path(PRODUCT_UNVERIFIED, versionId),
        method,
        SEAT_UNVERIFIED,
        body,
      );
      expect(status).toBe(403);
      expect(res.error.code).toBe(ApiErrorCode.FORBIDDEN);
      // Nothing written, and the row is still there.
      expect(await t.db.select().from(auditLog)).toHaveLength(0);
      const [row] = await t.db
        .select()
        .from(productVersions)
        .where(eq(productVersions.id, versionId));
      expect(row?.label).toBe('v1');
    },
  );

  it.each(VERSION_WRITE_ROUTES)(
    '$method answers 404 — NOT 403 — when an unverified vendor targets a product it does not own',
    async ({ path, method, body }) => {
      // Ownership is checked BEFORE the capability gate, so an unverified
      // non-owner learns nothing about the product's existence.
      const { status, body: res } = await call(
        path(PRODUCT_A, VERSION_A),
        method,
        SEAT_UNVERIFIED,
        body,
      );
      expect(status).toBe(404);
      expect(res.error.code).toBe(ApiErrorCode.NOT_FOUND);
    },
  );

  it('lets an UNVERIFIED vendor READ its own versions — authoring is the gated capability', async () => {
    const { status, body } = await call(
      `/api/vendor/products/${PRODUCT_UNVERIFIED}/versions`,
      'GET',
      SEAT_UNVERIFIED,
    );
    expect(status).toBe(200);
    expect(body.versions).toEqual([]);
  });
});

/** The attestation routes that WRITE, and are therefore Verified-gated (AECI-301).
 *  `own` targets the unverified vendor's OWN surface; `foreign` targets vendor A's. */
const ATTESTATION_WRITE_ROUTES: ReadonlyArray<{
  label: string;
  method: string;
  own: { path: string; body?: unknown };
  foreign: { path: string; body?: unknown };
}> = [
  {
    label: 'POST /claims',
    method: 'POST',
    own: {
      path: '/api/vendor/claims',
      body: { integration_id: INTEGRATION_BU, data_object: 'rfis', direction: 'inbound' },
    },
    foreign: {
      path: '/api/vendor/claims',
      body: { integration_id: INTEGRATION_AB, data_object: 'rfis', direction: 'inbound' },
    },
  },
  {
    label: 'PUT /claims/:id/attestation',
    method: 'PUT',
    own: { path: `/api/vendor/claims/${CLAIM_UNVERIFIED}/attestation`, body: { asserted: true } },
    foreign: { path: `/api/vendor/claims/${CLAIM_AB}/attestation`, body: { asserted: true } },
  },
  {
    label: 'DELETE /claims/:id/attestation',
    method: 'DELETE',
    own: { path: `/api/vendor/claims/${CLAIM_UNVERIFIED}/attestation` },
    foreign: { path: `/api/vendor/claims/${CLAIM_AB}/attestation` },
  },
];

describe('/api/vendor/claims* — the Verified capability gate (AECI-301)', () => {
  it.each(ATTESTATION_WRITE_ROUTES)(
    '$label rejects an UNVERIFIED vendor on its OWN integration with 403',
    async ({ method, own }) => {
      const { status, body } = await call(own.path, method, SEAT_UNVERIFIED, own.body);
      expect(status).toBe(403);
      expect(body.error.code).toBe(ApiErrorCode.FORBIDDEN);
      // Nothing written, and the claim set is untouched.
      expect(await t.db.select().from(auditLog)).toHaveLength(0);
      expect(await t.db.select().from(claims)).toHaveLength(3);
    },
  );

  it.each(ATTESTATION_WRITE_ROUTES)(
    '$label answers 404 — NOT 403 — when an unverified vendor targets another vendor’s integration',
    async ({ method, foreign }) => {
      // Authority is evaluated before the capability gate, so an unverified
      // non-owner learns nothing about the integration's existence.
      const { status, body } = await call(foreign.path, method, SEAT_UNVERIFIED, foreign.body);
      expect(status).toBe(404);
      expect(body.error.code).toBe(ApiErrorCode.NOT_FOUND);
    },
  );

  it('lets an UNVERIFIED vendor READ its own attestable surface', async () => {
    // Same split as the version list: authoring is gated, reading your own data
    // is not, so the §6 tab renders read-only and explains what verification adds.
    const { status, body } = await call('/api/vendor/integrations', 'GET', SEAT_UNVERIFIED);
    expect(status).toBe(200);
    expect(body.integrations.map((i: { id: string }) => i.id)).toEqual([INTEGRATION_BU]);
  });

  it('lets an UNVERIFIED vendor READ the data_object vocabulary (AECI-606)', async () => {
    // 403-ing the vocabulary would leave the read-only tab unable to label its
    // own claims. Reading is not the gated capability on any of these three.
    const { status, body } = await call('/api/vendor/data-objects', 'GET', SEAT_UNVERIFIED);
    expect(status).toBe(200);
    expect(Array.isArray(body.data_objects)).toBe(true);
  });
});

describe('/api/vendor/* — a rejected caller never mutates state', () => {
  it.each([REVIEWER, ADMIN, SEAT_BANNED, SEAT_UNLINKED])(
    'sub %s cannot edit the vendor profile',
    async (sub) => {
      await call('/api/vendor/profile', 'PATCH', sub, { description: 'hijacked' });
      const [row] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR_A));
      expect(row?.description).toBe('A blurb');
      expect(await t.db.select().from(auditLog)).toHaveLength(0);
    },
  );
});

describe('/api/vendor/* — cross-vendor isolation', () => {
  it('GET /me returns only the caller’s own vendor and products', async () => {
    const a = await call('/api/vendor/me', 'GET', SEAT_A);
    expect(a.body.vendor.slug).toBe('autodesk');
    expect(a.body.products.map((p: { slug: string }) => p.slug)).toEqual(['revit']);

    const b = await call('/api/vendor/me', 'GET', SEAT_B);
    expect(b.body.vendor.slug).toBe('bentley');
    expect(b.body.products.map((p: { slug: string }) => p.slug)).toEqual(['microstation']);
  });

  it('GET /seats returns only the caller’s own seats', async () => {
    const a = await call('/api/vendor/seats', 'GET', SEAT_A);
    expect(a.body.seats.map((s: { user_id: string }) => s.user_id).sort()).toEqual(
      [SEAT_A, SEAT_BANNED].sort(),
    );

    const b = await call('/api/vendor/seats', 'GET', SEAT_B);
    expect(b.body.seats.map((s: { user_id: string }) => s.user_id)).toEqual([SEAT_B]);
  });

  it('GET /notifications returns only the caller’s own ledger rows, never an ops row', async () => {
    const ledger = (vendorId: string | null, claimId: string) => ({
      id: crypto.randomUUID(),
      actorType: 'system' as const,
      action: 'notification.sent',
      entityType: 'claim',
      entityId: claimId,
      metadata: {
        detector: 'silent-counterparty',
        vendorId,
        integrationId: uuid(700),
        dataObject: { slug: 'rfis', name: 'RFIs' },
        counterpartProduct: { slug: 'p-b', name: 'Product B' },
        pairSlugs: ['p-a', 'p-b'],
      },
    });
    await t.db
      .insert(auditLog)
      .values([ledger(VENDOR_A, uuid(701)), ledger(VENDOR_B, uuid(702)), ledger(null, uuid(703))]);

    const a = await call('/api/vendor/notifications', 'GET', SEAT_A);
    expect(a.body.notifications.map((n: { claim_id: string }) => n.claim_id)).toEqual([uuid(701)]);

    const b = await call('/api/vendor/notifications', 'GET', SEAT_B);
    expect(b.body.notifications.map((n: { claim_id: string }) => n.claim_id)).toEqual([uuid(702)]);
  });

  it('PATCH /profile edits only the caller’s own vendor', async () => {
    expect(
      (await call('/api/vendor/profile', 'PATCH', SEAT_B, { description: 'B edited' })).status,
    ).toBe(200);
    const [a] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR_A));
    const [b] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR_B));
    expect(a?.description).toBe('A blurb'); // untouched
    expect(b?.description).toBe('B edited');
  });

  it('PATCH /products/:id on another vendor’s product → 404, unmutated, unaudited', async () => {
    const { status, body } = await call(`/api/vendor/products/${PRODUCT_B}`, 'PATCH', SEAT_A, {
      description: 'hijacked',
    });
    // 404 rather than 403: a non-owner must not learn that the product exists.
    expect(status).toBe(404);
    expect(body.error.code).toBe(ApiErrorCode.NOT_FOUND);

    const [row] = await t.db.select().from(products).where(eq(products.id, PRODUCT_B));
    expect(row?.description).toBe('B product');
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it.each([
    {
      label: 'GET /versions',
      method: 'GET',
      path: () => `/api/vendor/products/${PRODUCT_B}/versions`,
    },
    {
      label: 'POST /versions',
      method: 'POST',
      path: () => `/api/vendor/products/${PRODUCT_B}/versions`,
      body: { label: 'hijacked' },
    },
    {
      label: 'PATCH /versions/:versionId',
      method: 'PATCH',
      path: () => `/api/vendor/products/${PRODUCT_B}/versions/${VERSION_B}`,
      body: { label: 'hijacked' },
    },
    {
      label: 'DELETE /versions/:versionId',
      method: 'DELETE',
      path: () => `/api/vendor/products/${PRODUCT_B}/versions/${VERSION_B}`,
    },
  ])(
    '$label on another vendor’s product → 404, unmutated, unaudited',
    async ({ method, path, body }) => {
      const { status, body: res } = await call(path(), method, SEAT_A, body);
      // 404 rather than 403: a non-owner must not learn that the product exists.
      expect(status).toBe(404);
      expect(res.error.code).toBe(ApiErrorCode.NOT_FOUND);

      const rows = await t.db
        .select()
        .from(productVersions)
        .where(eq(productVersions.productId, PRODUCT_B));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.label).toBe('v1');
      expect(await t.db.select().from(auditLog)).toHaveLength(0);
    },
  );

  it('a version id from another product is a 404 even for its own vendor', async () => {
    // Vendor A owns PRODUCT_A, so ownership passes — but VERSION_B is not on it.
    const { status } = await call(
      `/api/vendor/products/${PRODUCT_A}/versions/${VERSION_B}`,
      'DELETE',
      SEAT_A,
    );
    expect(status).toBe(404);
    expect(
      await t.db.select().from(productVersions).where(eq(productVersions.id, VERSION_B)),
    ).toHaveLength(1);
  });

  it('GET /integrations returns only the surface the caller can actually attest on', async () => {
    const a = await call('/api/vendor/integrations', 'GET', SEAT_A);
    expect(a.body.integrations.map((i: { id: string }) => i.id)).toEqual([INTEGRATION_AB]);
    expect(a.body.integrations[0].slots).toEqual(['vendor_a']);

    // B owns both PRODUCT_B endpoints across the two rows, and sees both.
    const b = await call('/api/vendor/integrations', 'GET', SEAT_B);
    expect(b.body.integrations.map((i: { id: string }) => i.id).sort()).toEqual(
      [INTEGRATION_AB, INTEGRATION_BU].sort(),
    );
  });

  it.each([
    { label: 'PUT /claims/:id/attestation', method: 'PUT', body: { asserted: true } },
    { label: 'DELETE /claims/:id/attestation', method: 'DELETE', body: undefined },
  ])('$label on another vendor’s claim → 404, unmutated, unaudited', async ({ method, body }) => {
    const { status, body: res } = await call(
      `/api/vendor/claims/${CLAIM_BU}/attestation`,
      method,
      SEAT_A,
      body,
    );
    expect(status).toBe(404);
    expect(res.error.code).toBe(ApiErrorCode.NOT_FOUND);
    expect(
      await t.db.select().from(attestations).where(eq(attestations.claimId, CLAIM_BU)),
    ).toHaveLength(0);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('a claim id the caller cannot touch is indistinguishable from one that does not exist', async () => {
    // Divergent 404s here would let a vendor walk claim ids and learn which are
    // real. `resolveClaimAuthority` collapses both into one empty join result.
    const foreign = await call(`/api/vendor/claims/${CLAIM_BU}/attestation`, 'DELETE', SEAT_A);
    const ghost = await call(`/api/vendor/claims/${uuid(999)}/attestation`, 'DELETE', SEAT_A);
    expect(ghost.status).toBe(foreign.status);
    expect(ghost.body.error.code).toBe(foreign.body.error.code);
    expect(ghost.body.error.details.resource).toBe(foreign.body.error.details.resource);
    expect(Object.keys(ghost.body.error).sort()).toEqual(Object.keys(foreign.body.error).sort());
  });

  it('POST /claims on another vendor’s integration → 404, nothing created', async () => {
    const { status } = await call('/api/vendor/claims', 'POST', SEAT_A, {
      integration_id: INTEGRATION_BU,
      data_object: 'rfis',
      direction: 'outbound',
    });
    expect(status).toBe(404);
    expect(await t.db.select().from(claims)).toHaveLength(3);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('a second seat on the same vendor has the same access (multi-seat, flat)', async () => {
    const SEAT_A2 = uuid(110);
    await t.db.insert(profiles).values({ id: SEAT_A2, role: 'vendor_admin', vendorId: VENDOR_A });
    const { status, body } = await call('/api/vendor/me', 'GET', SEAT_A2);
    expect(status).toBe(200);
    expect(body.vendor.slug).toBe('autodesk');
    expect(body.seat_count).toBe(3);
  });

  it('GET /data-objects returns the SAME vocabulary to every vendor — the one route with no scope', async () => {
    // The inversion of every other cell in this block, and deliberate: the
    // vocabulary is AECi-curated and has no `vendor_id` column, so a scoping
    // filter would be vacuous rather than missing. Pinning the sameness means a
    // later "restore the scope filter" edit fails here instead of reading as a
    // fix (`docs/AUTH_AND_RLS.md` §4.4 carries the matching carve-out).
    const a = await call('/api/vendor/data-objects', 'GET', SEAT_A);
    const b = await call('/api/vendor/data-objects', 'GET', SEAT_B);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
    // Ordered by display_order, not by slug — see the seed above.
    expect(a.body.data_objects.map((d: { slug: string }) => d.slug)).toEqual([
      'submittals',
      'rfis',
    ]);
  });
});
