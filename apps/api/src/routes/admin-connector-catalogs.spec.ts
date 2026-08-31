/**
 * `PATCH /api/admin/connector-catalogs/:id` — the per-iPaaS management cutoff
 * (AECI-720), against the in-memory D1 harness.
 *
 * Three INVARIANT tests here, and none should be deleted without reopening the decision:
 *
 *   1. **The audit row rides the SAME batch as the flip.** ADR 0022 and
 *      `STAGE_1_SPEC.md` §26.1 name this write by name as the decision-bearing one that
 *      audits per row, explicitly distinguishing it from the run-granularity carve-out
 *      that governs the connector-catalogue sync on the very same tables.
 *   2. **No `workflow_instances` row, ever.** `workflow_instances_type_check` is a closed
 *      CHECK; opening it on SQLite is a full table rebuild.
 *   3. **The flag moves BOTH ways.** "One-way forever" governs the data direction, which
 *      the promote refusal delivers. `STAGE_2_SPEC.md` §8.9(4) makes this cutoff the
 *      "is the feed still arriving?" mechanism for a seat with no entitlement row and so
 *      no expiry cron — which is only actionable if a lane can be reclaimed.
 *
 * Authorization runs against the REAL `requireAdmin()` guard in the last describe,
 * including a `vendor_admin` seat: the flip is operator-executed, never vendor-self-serve
 * (`STAGE_2_VENDOR_PORTAL_SPEC.md` §5.2(9)).
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  connectorCatalogs,
  products,
  profiles,
  vendors,
  workflowInstances,
} from '../db/schema';
import { submitCount } from '../posthog';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import worker from '../index';
import { requireAdmin, type AuthzVariables } from '../lib/authz';
import { makeTestJwks, type TestJwks } from '../test/auth';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createSetConnectorCatalogManagementHandler } from './admin-connector-catalogs';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

function managementActions(): string[][] {
  return vi
    .mocked(submitCount)
    .mock.calls.filter((call) => call[3] === 'aeci.connector_catalog.management')
    .map((call) => call[5] as string[]);
}

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = u(900);
const SEAT = u(500);
const CONNECTOR_ID = u(1);
const VENDOR = u(10);
const CATALOG_ID = 'rec76C362381D6CDF';
/** Deliberately stale, so any `updated_at` assertion is unambiguous. */
const OLD_TS = '2020-01-01T00:00:00.000Z';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(profiles).values({ id: ADMIN, role: 'admin' });
  vi.mocked(submitCount).mockClear();
});
afterEach(() => t.dispose());

// ─── Seeding ─────────────────────────────────────────────────────────────────

const seedCatalog = async (over: Partial<typeof connectorCatalogs.$inferInsert> = {}) => {
  await t.db
    .insert(products)
    .values({ id: CONNECTOR_ID, slug: 'mindcloud', name: 'MindCloud', productRole: 'connector' });
  await t.db.insert(connectorCatalogs).values({
    id: CATALOG_ID,
    connectorProductId: CONNECTOR_ID,
    createdAt: OLD_TS,
    updatedAt: OLD_TS,
    ...over,
  });
};

const seedVendor = () =>
  t.db.insert(vendors).values({ id: VENDOR, slug: 'mindcloud', companyName: 'MindCloud LLC' });

const readCatalog = async () =>
  (await t.db.select().from(connectorCatalogs).where(eq(connectorCatalogs.id, CATALOG_ID)))[0];

// ─── App under test (handler mounted bare; authz has its own describe) ───────

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
    '/api/admin/connector-catalogs/:id',
    createSetConnectorCatalogManagementHandler(t.factory),
  );
  return a;
}

const patch = (id: string, body: unknown, env: Env = TEST_ENV) =>
  app().request(
    `/api/admin/connector-catalogs/${id}`,
    {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    },
    env,
    fakeExecutionContext(),
  );

// ─── review → vendor (the freeze) ────────────────────────────────────────────

describe('PATCH …/connector-catalogs/:id — freezing the review lane', () => {
  it('flips the flag and writes the audit row in the same batch', async () => {
    await seedCatalog();
    const res = await patch(CATALOG_ID, { managedBy: 'vendor' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: CATALOG_ID,
      connector_product_id: CONNECTOR_ID,
      managed_by: 'vendor',
      managed_by_vendor_id: null,
    });

    const row = await readCatalog();
    expect(row?.managedBy).toBe('vendor');
    expect(row?.updatedAt).not.toBe(OLD_TS);

    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'connector_catalog.managed_by_vendor',
      actorType: 'admin',
      actorId: ADMIN,
      entityType: 'connector_catalog',
      entityId: CATALOG_ID,
    });
    expect(audits[0]?.beforeState).toEqual({ managed_by: 'review' });
    expect(audits[0]?.afterState).toEqual({ managed_by: 'vendor' });
  });

  it('records the receiving vendor and the reason in the audit metadata', async () => {
    // §8.9(2)/(3): the connector seat is NOT a `vendor_entitlements` row and no route
    // grants `vendor_admin` today, so the audit row is the ONLY record of who the
    // catalogue was handed to. AECI-722's screen reads it back through
    // `audit_log_entity_idx (entity_type, entity_id, created_at)`.
    await seedCatalog();
    await seedVendor();
    const res = await patch(CATALOG_ID, {
      managedBy: 'vendor',
      vendorId: VENDOR,
      reason: 'Feed-for-listing partnership signed 2026-08-31.',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ managed_by_vendor_id: VENDOR });
    expect((await t.db.select().from(auditLog))[0]?.metadata).toEqual({
      source: 'admin-connector-catalog',
      connector_product_id: CONNECTOR_ID,
      vendor_id: VENDOR,
      reason: 'Feed-for-listing partnership signed 2026-08-31.',
      review_lane_frozen: true,
      seat_not_granted: true,
    });
  });

  it('grants nothing — no entitlement row, no seat, no vendor write', async () => {
    await seedCatalog();
    await seedVendor();
    await patch(CATALOG_ID, { managedBy: 'vendor', vendorId: VENDOR });

    // The whole point of §8.9(2): handing over catalogue authorship must not light the
    // Verified badge, and `vendors.verified` mirrors off ANY active entitlement row.
    const vendorRow = (await t.db.select().from(vendors).where(eq(vendors.id, VENDOR)))[0];
    expect(vendorRow?.verified).toBe(false);
    expect(await t.db.select().from(profiles).where(eq(profiles.vendorId, VENDOR))).toHaveLength(0);
  });

  it('writes NO workflow_instances row — that CHECK is closed', async () => {
    await seedCatalog();
    await patch(CATALOG_ID, { managedBy: 'vendor' });
    expect(await t.db.select().from(workflowInstances)).toHaveLength(0);
  });

  it('emits the metric tagged by destination and outcome', async () => {
    await seedCatalog();
    await patch(CATALOG_ID, { managedBy: 'vendor' });
    expect(managementActions()).toEqual([['to:vendor', 'outcome:ok']]);
  });
});

// ─── vendor → review (reclaiming the lane) ───────────────────────────────────

describe('PATCH …/connector-catalogs/:id — reclaiming the lane', () => {
  it('flips back and audits under its own action', async () => {
    await seedCatalog({ managedBy: 'vendor' });
    const res = await patch(CATALOG_ID, { managedBy: 'review', reason: 'Feed stopped arriving.' });

    expect(res.status).toBe(200);
    expect((await readCatalog())?.managedBy).toBe('review');

    const audit = (await t.db.select().from(auditLog))[0];
    expect(audit?.action).toBe('connector_catalog.managed_by_review');
    expect(audit?.beforeState).toEqual({ managed_by: 'vendor' });
    expect(audit?.metadata).toMatchObject({ review_lane_frozen: false });
  });
});

// ─── Rejections ──────────────────────────────────────────────────────────────

describe('PATCH …/connector-catalogs/:id — rejections', () => {
  it('422s a request naming the state the catalogue is already in', async () => {
    await seedCatalog({ managedBy: 'vendor' });
    const res = await patch(CATALOG_ID, { managedBy: 'vendor' });

    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_STATE_TRANSITION',
    );
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect(managementActions()).toEqual([['to:vendor', 'outcome:invalid_state']]);
  });

  it('404s an unknown catalogue', async () => {
    const res = await patch('recDoesNotExist01', { managedBy: 'vendor' });
    expect(res.status).toBe(404);
    expect(managementActions()).toEqual([['to:vendor', 'outcome:not_found']]);
  });

  it('404s an unknown vendorId rather than parking a dangling id in the audit row', async () => {
    // The audit metadata is the only record of who took the catalogue over, so a typo
    // has to fail loudly here instead of surfacing later on AECI-722's screen.
    await seedCatalog();
    const res = await patch(CATALOG_ID, { managedBy: 'vendor', vendorId: u(999) });

    expect(res.status).toBe(404);
    expect((await readCatalog())?.managedBy).toBe('review');
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('400s an unknown managedBy value', async () => {
    await seedCatalog();
    const res = await patch(CATALOG_ID, { managedBy: 'partner' });
    expect(res.status).toBe(400);
    expect((await readCatalog())?.managedBy).toBe('review');
  });

  it('400s a malformed body', async () => {
    await seedCatalog();
    const res = await app().request(
      `/api/admin/connector-catalogs/${CATALOG_ID}`,
      { method: 'PATCH', body: '{', headers: { 'content-type': 'application/json' } },
      TEST_ENV,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'MALFORMED_REQUEST',
    );
  });
});

// ─── Authorization, against the REAL requireAdmin() guard ────────────────────

describe('authorization', () => {
  const SUPABASE_URL = 'https://test-project.supabase.co';
  const AUTHZ_ENV = { ENV: 'preview', SUPABASE_URL } as Env;

  let jwks: TestJwks;
  beforeAll(async () => {
    jwks = await makeTestJwks();
  });

  function guardedApp() {
    const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    a.onError(errorHandler());
    a.patch(
      '/api/admin/connector-catalogs/:id',
      requireAdmin({ getKey: jwks.getKey, dbFor: t.factory }),
      createSetConnectorCatalogManagementHandler(t.factory),
    );
    return a;
  }

  const call = async (token?: string) =>
    guardedApp().request(
      `/api/admin/connector-catalogs/${CATALOG_ID}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ managedBy: 'vendor' }),
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      AUTHZ_ENV,
      fakeExecutionContext(),
    );

  beforeEach(async () => {
    await seedCatalog();
  });

  it('401s with no token', async () => {
    expect((await call()).status).toBe(401);
    expect((await readCatalog())?.managedBy).toBe('review');
  });

  it('403s a plain reviewer', async () => {
    await t.db.insert(profiles).values({ id: u(910), role: 'reviewer' });
    const token = await jwks.mintToken({ sub: u(910), supabaseUrl: SUPABASE_URL });
    expect((await call(token)).status).toBe(403);
    expect((await readCatalog())?.managedBy).toBe('review');
  });

  it('403s a vendor_admin — the flip is operator-executed, never vendor-self-serve', async () => {
    await seedVendor();
    await t.db.insert(profiles).values({ id: SEAT, role: 'vendor_admin', vendorId: VENDOR });
    const token = await jwks.mintToken({ sub: SEAT, supabaseUrl: SUPABASE_URL });
    expect((await call(token)).status).toBe(403);
    expect((await readCatalog())?.managedBy).toBe('review');
  });

  it('200s an admin', async () => {
    const token = await jwks.mintToken({ sub: ADMIN, supabaseUrl: SUPABASE_URL });
    expect((await call(token)).status).toBe(200);
    expect((await readCatalog())?.managedBy).toBe('vendor');
  });
});

// ─── Registration, against the REAL app from index.ts ────────────────────────

describe('route registration', () => {
  it('is mounted on the admin sub-router and guarded — 401, not 404', async () => {
    // The handler specs above mount the handler on their own Hono app, so nothing else
    // proves `index.ts` actually registers this path behind `requireAdmin()`. A missing
    // registration would surface as a 404 here; a missing guard as a 500 or a 200.
    const res = await worker.fetch(
      new Request(`https://api/api/admin/connector-catalogs/${CATALOG_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ managedBy: 'vendor' }),
        headers: { 'content-type': 'application/json' },
      }),
      { ENV: 'preview', SUPABASE_URL: 'https://test-project.supabase.co' } as Env,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');
  });
});
