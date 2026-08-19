/**
 * Product-version CRUD handler coverage (AECI-607 /
 * `STAGE_2_ATTESTATIONS_SPEC.md` §8.3).
 *
 * Per the repo split, this spec stubs `c.set('auth', …)` and exercises the
 * HANDLERS: ordering, the `sort_key` derivation and its override, the label
 * uniqueness pre-check, audit-in-batch, and the purge tag. The real
 * `requireVendor()` guard and the cross-vendor deny cells live in
 * `vendor.authz-matrix.spec.ts`.
 *
 * The security-relevant cases here are the two gates and their ORDER: a
 * non-owning vendor gets a flat 404 (never a 403 that would confirm the product
 * exists), and an unverified OWNER gets a 403 on writes but still reads its own
 * list.
 */

import { ListProductVersionsResponseSchema } from '@aeci/shared';
import { deriveVersionSortKey } from '@aeci/shared/version-sort';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import {
  createDeleteProductVersionHandler,
  createListProductVersionsHandler,
  createProductVersionHandler,
  createUpdateProductVersionHandler,
} from './vendor-product-versions';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const VENDOR = uuid(1);
const UNVERIFIED_VENDOR = uuid(2);
const PRODUCT = uuid(10);
const OTHER_PRODUCT = uuid(11);
const UNVERIFIED_PRODUCT = uuid(12);
const SEAT = uuid(100);
const UNVERIFIED_SEAT = uuid(101);

let t: TestDb;

const AUTH: AuthzVariables['auth'] = {
  userId: SEAT,
  email: 'ops@autodesk.test',
  role: 'vendor_admin',
  vendorId: VENDOR,
  entitlementTier: 'verified',
  entitlement: { status: 'active', periodEnd: null },
};

const UNVERIFIED_AUTH: AuthzVariables['auth'] = {
  userId: UNVERIFIED_SEAT,
  email: 'ops@bentley.test',
  role: 'vendor_admin',
  vendorId: UNVERIFIED_VENDOR,
  entitlementTier: 'unclaimed',
  entitlement: null,
};

beforeEach(async () => {
  t = await makeTestDb();

  await t.db.insert(vendors).values([
    { id: VENDOR, slug: 'autodesk', companyName: 'Autodesk', verified: true },
    { id: UNVERIFIED_VENDOR, slug: 'bentley', companyName: 'Bentley', verified: false },
  ]);
  await t.db.insert(products).values([
    { id: PRODUCT, slug: 'revit', name: 'Revit' },
    // Owned by nobody in this spec — the "not yours" case.
    { id: OTHER_PRODUCT, slug: 'microstation', name: 'MicroStation' },
    { id: UNVERIFIED_PRODUCT, slug: 'openroads', name: 'OpenRoads' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: PRODUCT, vendorId: VENDOR, isPrimary: true },
    { productId: UNVERIFIED_PRODUCT, vendorId: UNVERIFIED_VENDOR, isPrimary: true },
  ]);
  await t.db.insert(profiles).values([
    { id: SEAT, role: 'vendor_admin', vendorId: VENDOR },
    { id: UNVERIFIED_SEAT, role: 'vendor_admin', vendorId: UNVERIFIED_VENDOR },
  ]);
});
afterEach(() => t.dispose());

/** App with the session stubbed — the guard is exercised in the matrix spec.
 *  Route order mirrors `index.ts`. */
function app(auth: AuthzVariables['auth'] = AUTH) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.get('/api/vendor/products/:id/versions', createListProductVersionsHandler(t.factory));
  a.post('/api/vendor/products/:id/versions', createProductVersionHandler(t.factory));
  a.patch(
    '/api/vendor/products/:id/versions/:versionId',
    createUpdateProductVersionHandler(t.factory),
  );
  a.delete(
    '/api/vendor/products/:id/versions/:versionId',
    createDeleteProductVersionHandler(t.factory),
  );
  return a;
}

/** Heterogeneous bodies (list, single, error envelope, and a 204 with none), so
 *  assertions index loosely. `ListProductVersionsResponseSchema.parse` pins the
 *  real shape in the read test. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

type Call = { status: number; body: JsonBody; send: ReturnType<typeof vi.fn> };

async function call(
  path: string,
  init: RequestInit = {},
  auth: AuthzVariables['auth'] = AUTH,
): Promise<Call> {
  const send = vi.fn().mockResolvedValue(undefined);
  const env: Env = {
    ...TEST_ENV,
    CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'],
  };
  const execCtx = fakeExecutionContext();
  const res = await app(auth).request(path, init, env, execCtx);
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  const body = res.status === 204 ? {} : await res.json();
  return { status: res.status, body: body as JsonBody, send };
}

const sendJson = (
  method: 'POST' | 'PATCH',
  path: string,
  body: unknown,
  auth?: AuthzVariables['auth'],
) =>
  call(
    path,
    { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
    auth,
  );

const versionsUrl = (productId = PRODUCT) => `/api/vendor/products/${productId}/versions`;
const auditRows = () => t.db.select().from(auditLog);
const versionRows = () => t.db.select().from(productVersions);

/** Seed two versions whose labels sort the WRONG way lexically. */
async function seedTwoVersions() {
  await t.db.insert(productVersions).values([
    {
      id: uuid(200),
      productId: PRODUCT,
      label: '2026.10',
      sortKey: deriveVersionSortKey('2026.10'),
      createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    },
    {
      id: uuid(201),
      productId: PRODUCT,
      label: '2026.9',
      sortKey: deriveVersionSortKey('2026.9'),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]);
}

// ─── GET ─────────────────────────────────────────────────────────────────────

describe('GET /api/vendor/products/:id/versions', () => {
  it('orders by sort_key, not by label or insertion order', async () => {
    await seedTwoVersions();
    const { status, body } = await call(versionsUrl());
    expect(status).toBe(200);
    // Inserted 2026.10 first, and it sorts FIRST lexically — neither decides.
    expect(body.versions.map((v: JsonBody) => v.label)).toEqual(['2026.9', '2026.10']);
    expect(() => ListProductVersionsResponseSchema.parse(body)).not.toThrow();
  });

  it('breaks a sort_key tie on created_at, never on the label', async () => {
    await t.db.insert(productVersions).values([
      {
        id: uuid(210),
        productId: PRODUCT,
        label: 'Zulu release',
        sortKey: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: uuid(211),
        productId: PRODUCT,
        label: 'Alpha release',
        sortKey: 0,
        createdAt: '2026-02-01T00:00:00.000Z',
        updatedAt: '2026-02-01T00:00:00.000Z',
      },
    ]);
    const { body } = await call(versionsUrl());
    expect(body.versions.map((v: JsonBody) => v.label)).toEqual(['Zulu release', 'Alpha release']);
  });

  it('returns only this product’s versions', async () => {
    await seedTwoVersions();
    await t.db
      .insert(productVersions)
      .values({ id: uuid(220), productId: UNVERIFIED_PRODUCT, label: 'v1', sortKey: 1 });
    const { body } = await call(versionsUrl());
    expect(body.versions).toHaveLength(2);
  });

  it('is readable by an UNVERIFIED vendor — authoring is the gated capability', async () => {
    const { status, body } = await call(versionsUrl(UNVERIFIED_PRODUCT), {}, UNVERIFIED_AUTH);
    expect(status).toBe(200);
    expect(body.versions).toEqual([]);
  });

  it('404s on a product the caller does not own', async () => {
    const { status, body } = await call(versionsUrl(OTHER_PRODUCT));
    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

// ─── POST ────────────────────────────────────────────────────────────────────

describe('POST /api/vendor/products/:id/versions', () => {
  it('creates a version and derives sort_key from the label', async () => {
    const { status, body, send } = await sendJson('POST', versionsUrl(), { label: '2026.9' });
    expect(status).toBe(201);
    expect(body.version.label).toBe('2026.9');
    expect(body.version.sort_key).toBe(deriveVersionSortKey('2026.9'));
    expect(body.version.product_id).toBe(PRODUCT);
    expect(body.version.released_at).toBeNull();

    const rows = await versionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sortKey).toBe(deriveVersionSortKey('2026.9'));

    // `product:{slug}` only — the pair page embeds it for both endpoints, and
    // versions never render on the /products catalog.
    expect(send).toHaveBeenCalledWith({ tags: ['product:revit'], source: 'vendor' });
  });

  it('honours an explicit sort_key for a label the derivation reads as 0', async () => {
    const { body } = await sendJson('POST', versionsUrl(), { label: 'LTS', sort_key: 12345 });
    expect(deriveVersionSortKey('LTS')).toBe(0);
    expect(body.version.sort_key).toBe(12345);
  });

  it('stores date-only release stamps', async () => {
    const { body } = await sendJson('POST', versionsUrl(), {
      label: '2026.1',
      released_at: '2026-01-15',
      sunset_at: '2028-01-15',
    });
    expect(body.version.released_at).toBe('2026-01-15');
    expect(body.version.sunset_at).toBe('2028-01-15');
  });

  it('emits its audit row in the SAME batch', async () => {
    const { body } = await sendJson('POST', versionsUrl(), { label: '2026.1' });
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe('product_version.created');
    expect(audits[0]?.entityType).toBe('product_version');
    expect(audits[0]?.entityId).toBe(body.version.id);
    expect(audits[0]?.actorId).toBe(SEAT);
    expect(audits[0]?.metadata).toMatchObject({
      source: 'vendor-portal',
      vendorId: VENDOR,
      productId: PRODUCT,
    });
  });

  it('rejects a duplicate label with a 400 keyed to the field, writing nothing', async () => {
    await sendJson('POST', versionsUrl(), { label: '2026.1' });
    const { status, body } = await sendJson('POST', versionsUrl(), { label: '2026.1' });
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details?.field ?? body.error.field).toBe('label');
    expect(await versionRows()).toHaveLength(1);
    expect(await auditRows()).toHaveLength(1);
  });

  it('403s an unverified vendor on its OWN product, and writes nothing', async () => {
    const { status, body } = await sendJson(
      'POST',
      versionsUrl(UNVERIFIED_PRODUCT),
      { label: '2026.1' },
      UNVERIFIED_AUTH,
    );
    expect(status).toBe(403);
    expect(body.error.code).toBe('FORBIDDEN');
    // Copy points at verification, never at ranking or placement.
    expect(body.error.message).toMatch(/verified/i);
    expect(body.error.message).not.toMatch(/rank|placement|search/i);
    expect(await versionRows()).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });

  it('404s a non-owning vendor BEFORE the verified gate — ownership wins the race', async () => {
    // An unverified vendor asking about a product it does not own must learn
    // nothing: 404, not the 403 it would get on its own product.
    const { status, body } = await sendJson(
      'POST',
      versionsUrl(PRODUCT),
      { label: '2026.1' },
      UNVERIFIED_AUTH,
    );
    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('404s a non-owning vendor even with a malformed body', async () => {
    const { status } = await sendJson('POST', versionsUrl(OTHER_PRODUCT), { label: '' });
    expect(status).toBe(404);
  });

  it('rejects an unknown field silently and an empty label loudly', async () => {
    const { status } = await sendJson('POST', versionsUrl(), { label: '  ' });
    expect(status).toBe(400);
  });
});

// ─── PATCH ───────────────────────────────────────────────────────────────────

describe('PATCH /api/vendor/products/:id/versions/:versionId', () => {
  const VERSION = uuid(200);

  beforeEach(async () => {
    await t.db.insert(productVersions).values({
      id: VERSION,
      productId: PRODUCT,
      label: '2026.1',
      releasedAt: '2026-01-15',
      sortKey: deriveVersionSortKey('2026.1'),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  const patch = (
    body: unknown,
    versionId = VERSION,
    productId = PRODUCT,
    auth?: AuthzVariables['auth'],
  ) => sendJson('PATCH', `${versionsUrl(productId)}/${versionId}`, body, auth);

  it('edits a field and leaves the others alone', async () => {
    const { status, body, send } = await patch({ sunset_at: '2028-01-01' });
    expect(status).toBe(200);
    expect(body.version.sunset_at).toBe('2028-01-01');
    expect(body.version.released_at).toBe('2026-01-15');
    expect(body.version.label).toBe('2026.1');
    expect(send).toHaveBeenCalledWith({ tags: ['product:revit'], source: 'vendor' });
  });

  it('clears a date stamp on explicit null', async () => {
    const { body } = await patch({ released_at: null });
    expect(body.version.released_at).toBeNull();
  });

  it('leaves sort_key ALONE when the label changes without one — no silent re-derive', async () => {
    const before = deriveVersionSortKey('2026.1');
    const { body } = await patch({ label: '2027.5' });
    expect(body.version.label).toBe('2027.5');
    expect(body.version.sort_key).toBe(before);
    expect(body.version.sort_key).not.toBe(deriveVersionSortKey('2027.5'));
  });

  it('re-derives from the new label on explicit sort_key: null', async () => {
    const { body } = await patch({ label: '2027.5', sort_key: null });
    expect(body.version.sort_key).toBe(deriveVersionSortKey('2027.5'));
  });

  it('re-derives from the EXISTING label when sort_key: null arrives alone', async () => {
    await t.db.update(productVersions).set({ sortKey: 7 }).where(eq(productVersions.id, VERSION));
    const { body } = await patch({ sort_key: null });
    expect(body.version.sort_key).toBe(deriveVersionSortKey('2026.1'));
  });

  it('takes an explicit sort_key verbatim', async () => {
    const { body } = await patch({ sort_key: 99 });
    expect(body.version.sort_key).toBe(99);
  });

  it('emits its audit row in the SAME batch, with a before/after diff', async () => {
    await patch({ label: '2026.2' });
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe('product_version.updated');
    expect(audits[0]?.entityId).toBe(VERSION);
    expect(audits[0]?.beforeState).toMatchObject({ label: '2026.1' });
    expect(audits[0]?.afterState).toMatchObject({ label: '2026.2' });
    expect(audits[0]?.metadata).toMatchObject({ source: 'vendor-portal', fields: ['label'] });
  });

  it('rejects renaming onto a sibling’s label, writing nothing', async () => {
    await t.db
      .insert(productVersions)
      .values({ id: uuid(201), productId: PRODUCT, label: '2026.2', sortKey: 2 });
    const { status, body } = await patch({ label: '2026.2' });
    expect(status).toBe(400);
    expect(body.error.details?.field ?? body.error.field).toBe('label');
    expect(await auditRows()).toEqual([]);
  });

  it('allows a no-op rename to the version’s own label', async () => {
    const { status } = await patch({ label: '2026.1', released_at: null });
    expect(status).toBe(200);
  });

  it('rejects an empty body', async () => {
    const { status } = await patch({});
    expect(status).toBe(400);
  });

  it('404s a version that belongs to another product', async () => {
    await t.db
      .insert(productVersions)
      .values({ id: uuid(230), productId: UNVERIFIED_PRODUCT, label: 'v1', sortKey: 1 });
    const { status, body } = await patch({ label: 'v2' }, uuid(230));
    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    // Untouched.
    const [row] = await t.db
      .select()
      .from(productVersions)
      .where(eq(productVersions.id, uuid(230)));
    expect(row?.label).toBe('v1');
  });

  it('404s a product the caller does not own', async () => {
    const { status } = await patch({ label: 'v2' }, VERSION, OTHER_PRODUCT);
    expect(status).toBe(404);
  });

  it('403s an unverified vendor on its own product', async () => {
    await t.db
      .insert(productVersions)
      .values({ id: uuid(240), productId: UNVERIFIED_PRODUCT, label: 'v1', sortKey: 1 });
    const { status } = await patch({ label: 'v2' }, uuid(240), UNVERIFIED_PRODUCT, UNVERIFIED_AUTH);
    expect(status).toBe(403);
  });
});

// ─── DELETE ──────────────────────────────────────────────────────────────────

describe('DELETE /api/vendor/products/:id/versions/:versionId', () => {
  const VERSION = uuid(200);

  beforeEach(async () => {
    await t.db.insert(productVersions).values({
      id: VERSION,
      productId: PRODUCT,
      label: '2026.1',
      sortKey: deriveVersionSortKey('2026.1'),
    });
  });

  const del = (versionId = VERSION, productId = PRODUCT, auth?: AuthzVariables['auth']) =>
    call(`${versionsUrl(productId)}/${versionId}`, { method: 'DELETE' }, auth);

  it('removes the row, answers 204, and purges the product tag', async () => {
    const { status, send } = await del();
    expect(status).toBe(204);
    expect(await versionRows()).toEqual([]);
    expect(send).toHaveBeenCalledWith({ tags: ['product:revit'], source: 'vendor' });
  });

  it('emits its audit row in the SAME batch, carrying the deleted state', async () => {
    await del();
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe('product_version.deleted');
    expect(audits[0]?.entityId).toBe(VERSION);
    expect(audits[0]?.beforeState).toMatchObject({ label: '2026.1' });
  });

  it('degrades an attestation stamp to null rather than deleting the attestation', async () => {
    await t.db
      .insert(integrations)
      .values({ id: uuid(300), sourceProductId: PRODUCT, targetProductId: OTHER_PRODUCT });
    await t.db.insert(taxonomyDataObjects).values({ id: uuid(310), slug: 'rfis', name: 'RFIs' });
    await t.db.insert(claims).values({
      id: uuid(320),
      integrationId: uuid(300),
      dataObjectId: uuid(310),
      direction: 'a_to_b',
    });
    await t.db.insert(attestations).values({
      id: uuid(330),
      claimId: uuid(320),
      source: 'vendor_a',
      introducedAt: '2026-01-15',
      introducedVersionId: VERSION,
    });

    const { status } = await del();
    expect(status).toBe(204);

    const [row] = await t.db
      .select()
      .from(attestations)
      .where(eq(attestations.id, uuid(330)));
    expect(row).toBeDefined();
    expect(row?.introducedVersionId).toBeNull();
    // Falls back to the coarse date stamp (§8.2).
    expect(row?.introducedAt).toBe('2026-01-15');
  });

  it('404s a version that belongs to another product, leaving it in place', async () => {
    await t.db
      .insert(productVersions)
      .values({ id: uuid(230), productId: UNVERIFIED_PRODUCT, label: 'v1', sortKey: 1 });
    const { status } = await del(uuid(230));
    expect(status).toBe(404);
    expect(await versionRows()).toHaveLength(2);
    expect(await auditRows()).toEqual([]);
  });

  it('404s a product the caller does not own', async () => {
    const { status } = await del(VERSION, OTHER_PRODUCT);
    expect(status).toBe(404);
  });

  it('403s an unverified vendor on its own product', async () => {
    await t.db
      .insert(productVersions)
      .values({ id: uuid(240), productId: UNVERIFIED_PRODUCT, label: 'v1', sortKey: 1 });
    const { status } = await del(uuid(240), UNVERIFIED_PRODUCT, UNVERIFIED_AUTH);
    expect(status).toBe(403);
    expect(await versionRows()).toHaveLength(2);
  });
});
