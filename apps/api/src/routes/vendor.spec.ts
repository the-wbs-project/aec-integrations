/**
 * Vendor-portal handler coverage (AECI-520 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §4).
 *
 * Per the repo split: this spec stubs `c.set('auth', …)` and exercises the
 * HANDLERS (payload shape, allow-list enforcement, audit-in-batch, purge tags).
 * The real `requireVendor()` guard and the cross-vendor deny cells live in
 * `vendor.authz-matrix.spec.ts`.
 *
 * The allow-list cases are the security-relevant ones: a field absent from the
 * Zod schema must be *silently stripped and never written*, because that is the
 * only thing standing between a vendor and `verified` / `promotion_status` /
 * `admin_notes`.
 */

import { ListVendorSeatsResponseSchema, VendorMeResponseSchema } from '@aeci/shared';
import type { CachePurgeMessage } from '@aeci/shared/cache-purge';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  productAudiences,
  productCategories,
  productVendors,
  products,
  profiles,
  taxonomyAudiences,
  taxonomyCategories,
  taxonomyPhases,
  vendorRequests,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import type { AuthzVariables } from '../lib/authz';
import {
  createUpdateVendorProductHandler,
  createUpdateVendorProfileHandler,
  createVendorMeHandler,
  createVendorSeatsHandler,
} from './vendor';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const VENDOR = uuid(1);
const OTHER_VENDOR = uuid(2);
const PRODUCT = uuid(10);
const OTHER_PRODUCT = uuid(11);
const SEAT = uuid(100);
const SEAT_2 = uuid(101);
const CAT_BIM = uuid(200);
const CAT_COST = uuid(201);
const AUD_ARCH = uuid(210);
const PHASE_DESIGN = uuid(220);
const REQUEST = uuid(300);

let t: TestDb;

const AUTH: AuthzVariables['auth'] = {
  userId: SEAT,
  email: 'ops@autodesk.test',
  role: 'vendor_admin',
  vendorId: VENDOR,
};

beforeEach(async () => {
  t = await makeTestDb();

  await t.db.insert(vendors).values([
    { id: VENDOR, slug: 'autodesk', companyName: 'Autodesk', description: 'Old blurb' },
    { id: OTHER_VENDOR, slug: 'bentley', companyName: 'Bentley' },
  ]);
  await t.db.insert(products).values([
    { id: PRODUCT, slug: 'revit', name: 'Revit', description: 'Old product blurb' },
    { id: OTHER_PRODUCT, slug: 'microstation', name: 'MicroStation' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: PRODUCT, vendorId: VENDOR, isPrimary: true },
    { productId: OTHER_PRODUCT, vendorId: OTHER_VENDOR, isPrimary: true },
  ]);
  await t.db.insert(profiles).values([
    { id: SEAT, role: 'vendor_admin', vendorId: VENDOR, displayName: 'Dana Ops' },
    { id: SEAT_2, role: 'vendor_admin', vendorId: VENDOR, bannedAt: '2026-07-01T00:00:00.000Z' },
  ]);
  await t.db.insert(taxonomyCategories).values([
    { id: CAT_BIM, slug: 'bim', name: 'BIM' },
    { id: CAT_COST, slug: 'cost-management', name: 'Cost Management' },
  ]);
  await t.db
    .insert(taxonomyAudiences)
    .values([{ id: AUD_ARCH, slug: 'architects', name: 'Architects' }]);
  await t.db.insert(taxonomyPhases).values([{ id: PHASE_DESIGN, slug: 'design', name: 'Design' }]);
  await t.db.insert(productCategories).values([{ productId: PRODUCT, categoryId: CAT_BIM }]);
});
afterEach(() => t.dispose());

/** App with the session stubbed — the guard is exercised in the matrix spec. */
function app(auth: AuthzVariables['auth'] = AUTH) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.get('/api/vendor/me', createVendorMeHandler(t.factory));
  a.get(
    '/api/vendor/seats',
    createVendorSeatsHandler(t.factory, async () => new Map()),
  );
  a.patch('/api/vendor/profile', createUpdateVendorProfileHandler(t.factory));
  a.patch('/api/vendor/products/:id', createUpdateVendorProductHandler(t.factory));
  return a;
}

/** Responses here are heterogeneous (four success payloads plus the error
 *  envelope), so assertions index the body loosely. The real shapes are pinned
 *  by the `*ResponseSchema.parse()` calls in the read tests. */
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
  return { status: res.status, body: await res.json(), send };
}

const patchJson = (path: string, body: unknown, auth?: AuthzVariables['auth']) =>
  call(
    path,
    {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    },
    auth,
  );

const auditRows = () => t.db.select().from(auditLog);

// ─── GET /api/vendor/me ──────────────────────────────────────────────────────

describe('GET /api/vendor/me', () => {
  it('returns the vendor, its owned products, and the seat count', async () => {
    const { status, body } = await call('/api/vendor/me');
    expect(status).toBe(200);
    expect(() => VendorMeResponseSchema.parse(body)).not.toThrow();

    expect(body.vendor.slug).toBe('autodesk');
    expect(body.vendor.verified).toBe(false);
    expect(body.products).toHaveLength(1);
    expect(body.products[0]).toMatchObject({
      slug: 'revit',
      is_primary: true,
      category_slugs: ['bim'],
      audience_slugs: [],
      phase_slugs: [],
    });
    // Both seats on this vendor, banned included.
    expect(body.seat_count).toBe(2);
  });

  it('never includes another vendor’s products', async () => {
    const { body } = await call('/api/vendor/me');
    expect(body.products.map((p: { slug: string }) => p.slug)).toEqual(['revit']);
  });

  it('surfaces requests targeting the vendor and its products, and nothing else', async () => {
    await t.db.insert(vendorRequests).values([
      {
        id: REQUEST,
        kind: 'claim',
        targetType: 'vendor',
        targetId: VENDOR,
        submitterEmail: 'ops@autodesk.test',
        body: 'We would like to claim this vendor profile.',
      },
      {
        id: uuid(301),
        kind: 'correction',
        targetType: 'product',
        targetId: PRODUCT,
        submitterEmail: 'someone@example.com',
        body: 'The description is out of date and should be refreshed.',
      },
      // Another vendor's request — must not leak.
      {
        id: uuid(302),
        kind: 'correction',
        targetType: 'product',
        targetId: OTHER_PRODUCT,
        submitterEmail: 'someone@example.com',
        body: 'Unrelated correction against a product we do not own.',
      },
    ]);

    const { body } = await call('/api/vendor/me');
    expect(body.requests.map((r: { id: string }) => r.id).sort()).toEqual(
      [REQUEST, uuid(301)].sort(),
    );
    // The submitter's identity and free text are deliberately not exposed.
    expect(body.requests[0]).not.toHaveProperty('submitter_email');
    expect(body.requests[0]).not.toHaveProperty('body');
  });

  it('counts only real seats — a reviewer carrying a vendor_id is not one', async () => {
    // seat_count and GET /seats must use the same predicate, or the dashboard
    // claims a seat the roster can't account for.
    await t.db.insert(profiles).values({ id: uuid(102), role: 'reviewer', vendorId: VENDOR });

    const me = await call('/api/vendor/me');
    const seats = await call('/api/vendor/seats');
    expect(me.body.seat_count).toBe(2);
    expect(seats.body.seats).toHaveLength(2);
    expect(me.body.seat_count).toBe(seats.body.seats.length);
  });

  it('handles a vendor that owns nothing', async () => {
    const lonely: AuthzVariables['auth'] = { ...AUTH, vendorId: OTHER_VENDOR };
    await t.db.delete(productVendors).where(eq(productVendors.vendorId, OTHER_VENDOR));
    const { status, body } = await call('/api/vendor/me', {}, lonely);
    expect(status).toBe(200);
    expect(body.products).toEqual([]);
    // The caller is a seat even when no profiles row points at this vendor.
    expect(body.seat_count).toBe(1);
  });
});

// ─── GET /api/vendor/seats ───────────────────────────────────────────────────

describe('GET /api/vendor/seats', () => {
  it('lists only this vendor’s vendor_admin seats, banned flag included', async () => {
    // A reviewer pointed at the vendor is not a seat; another vendor's seat must
    // not leak.
    await t.db.insert(profiles).values([
      { id: uuid(102), role: 'reviewer', vendorId: VENDOR },
      { id: uuid(103), role: 'vendor_admin', vendorId: OTHER_VENDOR },
    ]);

    const { status, body } = await call('/api/vendor/seats');
    expect(status).toBe(200);
    expect(() => ListVendorSeatsResponseSchema.parse(body)).not.toThrow();
    expect(body.seats.map((s: { user_id: string }) => s.user_id).sort()).toEqual(
      [SEAT, SEAT_2].sort(),
    );
    expect(body.seats.find((s: { user_id: string }) => s.user_id === SEAT_2)?.banned).toBe(true);
  });

  it('degrades to email: null when the Supabase admin seam returns nothing', async () => {
    const { body } = await call('/api/vendor/seats');
    expect(body.seats.every((s: { email: string | null }) => s.email === null)).toBe(true);
  });

  it('threads resolved emails through when the seam supplies them', async () => {
    const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    a.onError(errorHandler());
    a.use('*', async (c, next) => {
      c.set('auth', AUTH);
      await next();
    });
    a.get(
      '/api/vendor/seats',
      createVendorSeatsHandler(t.factory, async () => new Map([[SEAT, 'dana@autodesk.test']])),
    );
    const res = await a.request('/api/vendor/seats', {}, TEST_ENV, fakeExecutionContext());
    const body = (await res.json()) as { seats: { user_id: string; email: string | null }[] };
    expect(body.seats.find((s) => s.user_id === SEAT)?.email).toBe('dana@autodesk.test');
  });
});

// ─── PATCH /api/vendor/profile ───────────────────────────────────────────────

describe('PATCH /api/vendor/profile', () => {
  it('updates allow-listed fields and echoes the new state', async () => {
    const { status, body } = await patchJson('/api/vendor/profile', {
      description: 'We build design software.',
      website: 'https://autodesk.com',
      founded_year: 1982,
    });
    expect(status).toBe(200);
    expect(body.vendor).toMatchObject({
      description: 'We build design software.',
      website: 'https://autodesk.com',
      founded_year: 1982,
    });

    const [row] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR));
    expect(row?.description).toBe('We build design software.');
  });

  it('leaves absent fields alone and clears explicit nulls', async () => {
    await patchJson('/api/vendor/profile', { website: 'https://autodesk.com' });
    let [row] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR));
    expect(row?.description).toBe('Old blurb'); // untouched

    await patchJson('/api/vendor/profile', { description: null });
    [row] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR));
    expect(row?.description).toBeNull();
    expect(row?.website).toBe('https://autodesk.com'); // still untouched
  });

  it('strips AECi-owned fields instead of writing them', async () => {
    const { status } = await patchJson('/api/vendor/profile', {
      description: 'New blurb',
      verified: true,
      promotion_status: 'promoted',
      admin_notes: 'give us a discount',
      slug: 'autodesk-official',
      company_name: 'Autodesk Inc.',
      vqs_total: 99,
    });
    expect(status).toBe(200);

    const [row] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR));
    expect(row?.description).toBe('New blurb');
    expect(row?.verified).toBe(false);
    expect(row?.promotionStatus).toBe('pending');
    expect(row?.adminNotes).toBeNull();
    expect(row?.slug).toBe('autodesk');
    expect(row?.companyName).toBe('Autodesk');
    expect(row?.vqsTotal).toBeNull();
  });

  it('rejects an empty body with 400 VALIDATION_FAILED', async () => {
    const { status, body } = await patchJson('/api/vendor/profile', {});
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a body whose only keys are non-allow-listed', async () => {
    // Zod strips them, so the object is empty by the time superRefine runs —
    // the vendor gets a clear 400 rather than a silent no-op 200.
    const { status } = await patchJson('/api/vendor/profile', { verified: true });
    expect(status).toBe(400);
  });

  it('rejects a non-http URL (no javascript: in an href)', async () => {
    const { status, body } = await patchJson('/api/vendor/profile', {
      website: 'javascript:alert(1)',
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects malformed JSON with 400 MALFORMED_REQUEST', async () => {
    const { status, body } = await call('/api/vendor/profile', {
      method: 'PATCH',
      body: '{not json',
      headers: { 'content-type': 'application/json' },
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe('MALFORMED_REQUEST');
  });

  it('emits its audit row in the same batch, tagged vendor-portal', async () => {
    await patchJson('/api/vendor/profile', { description: 'New blurb' });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: SEAT,
      actorType: 'user',
      action: 'vendor.updated',
      entityType: 'vendor',
      entityId: VENDOR,
    });
    expect(rows[0]?.metadata).toMatchObject({ source: 'vendor-portal', vendorId: VENDOR });
    expect(rows[0]?.beforeState).toEqual({ description: 'Old blurb' });
    expect(rows[0]?.afterState).toEqual({ description: 'New blurb' });
  });

  it('enqueues a vendor:<slug> purge with source:vendor', async () => {
    const { send } = await patchJson('/api/vendor/profile', { description: 'New blurb' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0] as CachePurgeMessage).toEqual({
      tags: ['vendor:autodesk'],
      source: 'vendor',
    });
  });

  it('still 200s when the purge queue binding is absent', async () => {
    const execCtx = fakeExecutionContext();
    const res = await app().request(
      '/api/vendor/profile',
      {
        method: 'PATCH',
        body: JSON.stringify({ description: 'New blurb' }),
        headers: { 'content-type': 'application/json' },
      },
      TEST_ENV, // no CACHE_PURGE_QUEUE
      execCtx,
    );
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
    expect(res.status).toBe(200);
  });
});

// ─── PATCH /api/vendor/products/:id ──────────────────────────────────────────

describe('PATCH /api/vendor/products/:id', () => {
  it('updates an owned product and echoes the new state', async () => {
    const { status, body } = await patchJson(`/api/vendor/products/${PRODUCT}`, {
      description: 'Revit is a BIM authoring tool.',
      api_docs_url: 'https://aps.autodesk.com/revit',
    });
    expect(status).toBe(200);
    expect(body.product).toMatchObject({
      slug: 'revit',
      description: 'Revit is a BIM authoring tool.',
      api_docs_url: 'https://aps.autodesk.com/revit',
      is_primary: true,
    });
  });

  it('404s a product owned by another vendor without mutating it', async () => {
    const { status, body } = await patchJson(`/api/vendor/products/${OTHER_PRODUCT}`, {
      description: 'hijacked',
    });
    // 404, not 403 — a non-owner must not learn the product exists.
    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');

    const [row] = await t.db.select().from(products).where(eq(products.id, OTHER_PRODUCT));
    expect(row?.description).toBeNull();
    expect(await auditRows()).toHaveLength(0);
  });

  it('404s an unknown product id', async () => {
    expect(
      (await patchJson(`/api/vendor/products/${uuid(999)}`, { description: 'x' })).status,
    ).toBe(404);
  });

  it('strips AECi-owned product fields', async () => {
    await patchJson(`/api/vendor/products/${PRODUCT}`, {
      description: 'New blurb',
      name: 'Revit Pro',
      slug: 'revit-pro',
      promotion_status: 'promoted',
      research_status: 'done',
      priority_tier: 'tier_1',
      integration_count: 9999,
      admin_notes: 'bump us',
    });

    const [row] = await t.db.select().from(products).where(eq(products.id, PRODUCT));
    expect(row?.description).toBe('New blurb');
    expect(row?.name).toBe('Revit');
    expect(row?.slug).toBe('revit');
    expect(row?.promotionStatus).toBe('pending');
    expect(row?.researchStatus).toBe('pending');
    expect(row?.priorityTier).toBeNull();
    expect(row?.integrationCount).toBe(0);
    expect(row?.adminNotes).toBeNull();
  });

  it('replaces a taxonomy facet as a set', async () => {
    const { status, body } = await patchJson(`/api/vendor/products/${PRODUCT}`, {
      category_slugs: ['cost-management'],
      audience_slugs: ['architects'],
    });
    expect(status).toBe(200);
    expect(body.product.category_slugs).toEqual(['cost-management']);
    expect(body.product.audience_slugs).toEqual(['architects']);
    // The phases facet was not sent, so it stays untouched (empty here).
    expect(body.product.phase_slugs).toEqual([]);

    const cats = await t.db
      .select()
      .from(productCategories)
      .where(eq(productCategories.productId, PRODUCT));
    expect(cats.map((r) => r.categoryId)).toEqual([CAT_COST]);
  });

  it('clears a facet when sent an empty array', async () => {
    const { body } = await patchJson(`/api/vendor/products/${PRODUCT}`, { category_slugs: [] });
    expect(body.product.category_slugs).toEqual([]);
    expect(
      await t.db.select().from(productCategories).where(eq(productCategories.productId, PRODUCT)),
    ).toHaveLength(0);
  });

  it('rejects an unknown taxonomy slug and writes nothing', async () => {
    const { status, body } = await patchJson(`/api/vendor/products/${PRODUCT}`, {
      description: 'New blurb',
      category_slugs: ['bim', 'not-a-real-category'],
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.field).toBe('category_slugs');

    // Nothing partially applied — vendors assign taxonomy, they never mint it.
    const [row] = await t.db.select().from(products).where(eq(products.id, PRODUCT));
    expect(row?.description).toBe('Old product blurb');
    expect(await t.db.select().from(taxonomyCategories)).toHaveLength(2);
    expect(await auditRows()).toHaveLength(0);
  });

  it('rejects a slug that is not slug-shaped before it reaches the DB', async () => {
    const { status } = await patchJson(`/api/vendor/products/${PRODUCT}`, {
      category_slugs: ['Not A Slug'],
    });
    expect(status).toBe(400);
  });

  it('emits one audit row covering columns and taxonomy', async () => {
    await patchJson(`/api/vendor/products/${PRODUCT}`, {
      description: 'New blurb',
      category_slugs: ['cost-management'],
    });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: SEAT,
      actorType: 'user',
      action: 'product.updated',
      entityType: 'product',
      entityId: PRODUCT,
    });
    expect(rows[0]?.beforeState).toEqual({
      description: 'Old product blurb',
      category_slugs: ['bim'],
    });
    expect(rows[0]?.afterState).toEqual({
      description: 'New blurb',
      category_slugs: ['cost-management'],
    });
    expect(rows[0]?.metadata).toMatchObject({ source: 'vendor-portal', vendorId: VENDOR });
  });

  it('enqueues a product:<slug> purge with source:vendor', async () => {
    const { send } = await patchJson(`/api/vendor/products/${PRODUCT}`, { description: 'New' });
    expect(send.mock.calls[0][0] as CachePurgeMessage).toEqual({
      tags: ['product:revit'],
      source: 'vendor',
    });
  });

  it('rolls the whole edit back when the audit row cannot be written (§26.1)', async () => {
    // `audit_log.actor_id` FKs `profiles.id`, so a session whose seat has been
    // deleted mid-request makes `auditInsert` throw INSIDE the batch. The point
    // of putting the audit row in the same batch is that the content edit and
    // the taxonomy rewrite die with it — "failure to log is a transactional
    // failure". Without the batch this would silently commit an unaudited edit.
    const ghost: AuthzVariables['auth'] = { ...AUTH, userId: uuid(998) };

    const { status } = await patchJson(
      `/api/vendor/products/${PRODUCT}`,
      { description: 'should not persist', category_slugs: ['cost-management'] },
      ghost,
    );
    expect(status).toBe(500);

    const [row] = await t.db.select().from(products).where(eq(products.id, PRODUCT));
    expect(row?.description).toBe('Old product blurb');
    const cats = await t.db
      .select()
      .from(productCategories)
      .where(eq(productCategories.productId, PRODUCT));
    expect(cats.map((r) => r.categoryId)).toEqual([CAT_BIM]); // the original assignment
    expect(await auditRows()).toHaveLength(0);
  });

  it('rejects a body with no recognized field', async () => {
    expect((await patchJson(`/api/vendor/products/${PRODUCT}`, { name: 'Nope' })).status).toBe(400);
  });

  it('leaves the audience facet alone when only categories are sent', async () => {
    await t.db.insert(productAudiences).values({ productId: PRODUCT, audienceId: AUD_ARCH });
    const { body } = await patchJson(`/api/vendor/products/${PRODUCT}`, {
      category_slugs: ['bim'],
    });
    expect(body.product.audience_slugs).toEqual(['architects']);
  });
});
