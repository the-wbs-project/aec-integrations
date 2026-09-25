/**
 * `PATCH /api/admin/connector-stub-mappings/:id` — AECi-side mapping authoring
 * (AECI-724), against the in-memory D1 harness.
 *
 * Invariants pinned here, none to be deleted without reopening the decision:
 *
 *   1. **The gate.** A mapping on a `review`-managed catalogue is 409
 *      `CATALOG_REVIEW_MANAGED` and writes nothing. The companion no-overlap test, which
 *      drives the promote planner and this handler over the same database, is
 *      `lib/connector-mapping-lanes.spec.ts`.
 *   2. **The audit row rides the SAME batch**, filed under the catalogue so the
 *      catalogue's audit tab shows it.
 *   3. **Only the pointer and depth fields are writable.** `decided_by` is stamped, never
 *      accepted; `notes` is refused by the strict schema.
 *   4. **An edited `mapped` row is publishable**, and the edit purges the reach line.
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  connectorCatalogs,
  connectorStubMappings,
  connectorStubs,
  products,
  profiles,
  vendors,
  workflowInstances,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import worker from '../index';
import { requireAdmin, type AuthzVariables } from '../lib/authz';
import { makeTestJwks, type TestJwks } from '../test/auth';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createAdminUpdateConnectorStubMappingHandler } from './admin-connector-stub-mappings';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = u(900);
const CONNECTOR_ID = u(1);
const PROCORE_ID = u(2);
const AUTODESK_ID = u(3);
const UNPROMOTED_ID = u(4);
const CATALOG_ID = 'fx-cat-agave';
const STUB_ID = 'fx-stub-ag-procore';
const MAPPING_ID = 'fx-map-ag-1';
const OLD_TS = '2020-01-01T00:00:00.000Z';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(profiles).values({ id: ADMIN, role: 'admin' });
});
afterEach(() => t.dispose());

// ─── Seeding ─────────────────────────────────────────────────────────────────

async function seed(opts: { managedBy?: 'review' | 'vendor' } = {}) {
  await t.db.insert(products).values([
    {
      id: CONNECTOR_ID,
      slug: 'agave',
      name: 'Agave',
      productRole: 'connector',
      promotionStatus: 'promoted',
    },
    { id: PROCORE_ID, slug: 'procore', name: 'Procore', promotionStatus: 'promoted' },
    {
      id: AUTODESK_ID,
      slug: 'autodesk-build',
      name: 'Autodesk Build',
      promotionStatus: 'promoted',
    },
    { id: UNPROMOTED_ID, slug: 'on-hold', name: 'On Hold', promotionStatus: 'pending' },
  ]);
  await t.db.insert(connectorCatalogs).values({
    id: CATALOG_ID,
    connectorProductId: CONNECTOR_ID,
    managedBy: opts.managedBy ?? 'vendor',
  });
  await t.db.insert(connectorStubs).values({
    id: STUB_ID,
    catalogId: CATALOG_ID,
    slug: 'procore',
    firstSeenAt: OLD_TS,
    lastSeenAt: OLD_TS,
  });
  // An auto proposal at HIGH confidence: not publishable until somebody stands behind it.
  await t.db.insert(connectorStubMappings).values({
    id: MAPPING_ID,
    stubId: STUB_ID,
    catalogId: CATALOG_ID,
    productId: PROCORE_ID,
    status: 'mapped',
    confidence: 'high',
    decidedBy: 'auto-name-match',
    decidedAt: OLD_TS,
    notes: 'kept',
    createdAt: OLD_TS,
    updatedAt: OLD_TS,
  });
}

const readMapping = async (id = MAPPING_ID) =>
  (await t.db.select().from(connectorStubMappings).where(eq(connectorStubMappings.id, id)))[0];

// ─── App under test ──────────────────────────────────────────────────────────

function app() {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', {
      userId: ADMIN,
      email: undefined,
      role: 'admin',
      vendorId: null,
      entitlementTier: 'unclaimed',
      entitlement: null,
    });
    await next();
  });
  a.patch(
    '/api/admin/connector-stub-mappings/:id',
    createAdminUpdateConnectorStubMappingHandler(t.factory),
  );
  return a;
}

function purgeEnv() {
  const send = vi.fn().mockResolvedValue(undefined);
  const env = { ...TEST_ENV, CACHE_PURGE_QUEUE: { send } } as unknown as Env;
  return { env, send };
}

async function patch(id: string, body: unknown, env: Env = TEST_ENV) {
  const ctx = fakeExecutionContext();
  const res = await app().request(
    `/api/admin/connector-stub-mappings/${id}`,
    {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    },
    env,
    ctx,
  );
  // Settle the post-commit tail so purge assertions see it.
  await Promise.all(vi.mocked(ctx.waitUntil).mock.calls.map((call) => call[0]));
  return res;
}

// ─── The edit ────────────────────────────────────────────────────────────────

describe('PATCH …/connector-stub-mappings/:id — on a vendor-managed catalogue', () => {
  it('re-points the mapping, stamps the decider, and audits in the same batch', async () => {
    await seed();
    const res = await patch(MAPPING_ID, { productId: AUTODESK_ID, confidence: 'medium' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      changed: boolean;
      catalog_id: string;
      mapping: { product: { slug: string }; decided_by: string; publishable: boolean };
    };
    expect(body.changed).toBe(true);
    expect(body.catalog_id).toBe(CATALOG_ID);
    expect(body.mapping.product.slug).toBe('autodesk-build');
    expect(body.mapping.decided_by).toBe('aeci-operator');
    // The admin echo keeps the triage row's own shape, curation note included. Only the
    // seat's route narrows it (AECI-1127).
    expect(body.mapping).toHaveProperty('notes', 'kept');
    // Provenance, not confidence: an operator standing behind it is what publishes it.
    expect(body.mapping.publishable).toBe(true);

    const row = await readMapping();
    expect(row?.productId).toBe(AUTODESK_ID);
    expect(row?.confidence).toBe('medium');
    expect(row?.decidedBy).toBe('aeci-operator');
    expect(row?.decidedAt).not.toBe(OLD_TS);
    expect(row?.checkedAt).toBe(row?.decidedAt);
    // Not an editable column, and untouched by the edit.
    expect(row?.notes).toBe('kept');

    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'connector_mapping.updated',
      actorId: ADMIN,
      actorType: 'admin',
      entityType: 'connector_catalog',
      entityId: CATALOG_ID,
    });
    expect(audits[0]?.beforeState).toMatchObject({
      product_id: PROCORE_ID,
      decided_by: 'auto-name-match',
    });
    expect(audits[0]?.afterState).toMatchObject({
      product_id: AUTODESK_ID,
      decided_by: 'aeci-operator',
    });
    expect(audits[0]?.metadata).toMatchObject({
      source: 'admin-connector-mapping',
      mapping_id: MAPPING_ID,
      publishable_before: false,
      publishable_after: true,
    });
    // Audit-only ledger: that CHECK is closed.
    expect(await t.db.select().from(workflowInstances)).toHaveLength(0);
  });

  it('purges the reach line: both endpoints and the connector', async () => {
    await seed();
    const { env, send } = purgeEnv();
    await patch(MAPPING_ID, { productId: AUTODESK_ID }, env);

    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0]?.[0] as { tags: string[]; source: string };
    expect(message.source).toBe('moderation');
    expect([...message.tags].sort()).toEqual(
      ['product:agave', 'product:autodesk-build', 'product:procore'].sort(),
    );
  });

  it('purges nothing when the row is neither publishable before nor after', async () => {
    await seed();
    const { env, send } = purgeEnv();
    const res = await patch(MAPPING_ID, { status: 'ruled_out' }, env);
    expect(res.status).toBe(200);
    expect(send).not.toHaveBeenCalled();
    expect((await readMapping())?.status).toBe('ruled_out');
  });

  it('moves a mapping to a listing-level decision when the product is cleared too', async () => {
    await seed();
    const res = await patch(MAPPING_ID, { status: 'no_record', productId: null });
    expect(res.status).toBe(200);
    const row = await readMapping();
    expect(row?.status).toBe('no_record');
    expect(row?.productId).toBeNull();
  });

  it('is a 200 no-op that writes nothing when the body matches the row', async () => {
    await seed();
    const { env, send } = purgeEnv();
    const res = await patch(MAPPING_ID, { productId: PROCORE_ID, confidence: 'high' }, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { changed: boolean }).changed).toBe(false);
    expect((await readMapping())?.decidedBy).toBe('auto-name-match');
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });
});

// ─── Rejections ──────────────────────────────────────────────────────────────

describe('PATCH …/connector-stub-mappings/:id — rejections', () => {
  it('409s CATALOG_REVIEW_MANAGED on a review-managed catalogue and writes nothing', async () => {
    await seed({ managedBy: 'review' });
    const res = await patch(MAPPING_ID, { productId: AUTODESK_ID });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'CATALOG_REVIEW_MANAGED',
    );
    expect((await readMapping())?.productId).toBe(PROCORE_ID);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('404s an unknown mapping id', async () => {
    await seed();
    const res = await patch('recNope', { confidence: 'low' });
    expect(res.status).toBe(404);
  });

  it('refuses a server-stamped or non-editable column (strict body)', async () => {
    await seed();
    for (const body of [{ decidedBy: 'someone' }, { notes: 'x' }, {}]) {
      const res = await patch(MAPPING_ID, body);
      expect(res.status).toBe(400);
    }
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('422s a mapped status with no product, and a decision status that names one', async () => {
    await seed();
    expect((await patch(MAPPING_ID, { productId: null })).status).toBe(422);
    expect((await patch(MAPPING_ID, { status: 'out_of_scope' })).status).toBe(422);
    expect((await readMapping())?.status).toBe('mapped');
  });

  it('422s a pointer to an unpromoted product', async () => {
    await seed();
    const res = await patch(MAPPING_ID, { productId: UNPROMOTED_ID });
    expect(res.status).toBe(422);
    expect((await readMapping())?.productId).toBe(PROCORE_ID);
  });

  it('409s MAPPING_CONFLICT on a product the stub already maps to', async () => {
    await seed();
    await t.db.insert(connectorStubMappings).values({
      id: 'fx-map-ag-2',
      stubId: STUB_ID,
      catalogId: CATALOG_ID,
      productId: AUTODESK_ID,
      status: 'mapped',
      decidedBy: 'agave-vendor',
    });
    const res = await patch(MAPPING_ID, { productId: AUTODESK_ID });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('MAPPING_CONFLICT');
  });

  it('409s MAPPING_CONFLICT on a second listing-level decision', async () => {
    await seed();
    await t.db.insert(connectorStubMappings).values({
      id: 'fx-map-ag-2',
      stubId: STUB_ID,
      catalogId: CATALOG_ID,
      productId: null,
      status: 'ambiguous_parked',
      decidedBy: 'agave-vendor',
    });
    const res = await patch(MAPPING_ID, { status: 'no_record', productId: null });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('MAPPING_CONFLICT');
  });
});

// ─── Authorization, against the REAL guard ───────────────────────────────────

describe('authorization', () => {
  const SUPABASE_URL = 'https://test-project.supabase.co';
  const AUTHZ_ENV = { ENV: 'preview', SUPABASE_URL } as Env;
  const SEAT = u(500);
  const VENDOR = u(10);

  let jwks: TestJwks;
  beforeAll(async () => {
    jwks = await makeTestJwks();
  });

  function guardedApp() {
    const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    a.onError(errorHandler());
    a.patch(
      '/api/admin/connector-stub-mappings/:id',
      requireAdmin({ getKey: jwks.getKey, dbFor: t.factory }),
      createAdminUpdateConnectorStubMappingHandler(t.factory),
    );
    return a;
  }

  const call = (token?: string) =>
    guardedApp().request(
      `/api/admin/connector-stub-mappings/${MAPPING_ID}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ confidence: 'low' }),
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      AUTHZ_ENV,
      fakeExecutionContext(),
    );

  beforeEach(async () => {
    await seed();
  });

  it('401s with no token', async () => {
    expect((await call()).status).toBe(401);
  });

  it('403s a vendor_admin — the seat has its own route under /api/vendor/*', async () => {
    await t.db.insert(vendors).values({ id: VENDOR, slug: 'agave', companyName: 'Agave' });
    await t.db.insert(profiles).values({ id: SEAT, role: 'vendor_admin', vendorId: VENDOR });
    const token = await jwks.mintToken({ sub: SEAT, supabaseUrl: SUPABASE_URL });
    expect((await call(token)).status).toBe(403);
    expect((await readMapping())?.confidence).toBe('high');
  });

  it('200s an admin', async () => {
    const token = await jwks.mintToken({ sub: ADMIN, supabaseUrl: SUPABASE_URL });
    expect((await call(token)).status).toBe(200);
    expect((await readMapping())?.confidence).toBe('low');
  });
});

describe('route registration', () => {
  it('is mounted on the admin sub-router and guarded — 401, not 404', async () => {
    const res = await worker.fetch(
      new Request(`https://api/api/admin/connector-stub-mappings/${MAPPING_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ confidence: 'low' }),
        headers: { 'content-type': 'application/json' },
      }),
      { ENV: 'preview', SUPABASE_URL: 'https://test-project.supabase.co' } as Env,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(401);
  });
});
