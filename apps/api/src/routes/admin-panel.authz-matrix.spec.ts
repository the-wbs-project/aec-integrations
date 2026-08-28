/**
 * Admin-panel deny-matrix (AECI-574, extended by AECI-577/579/580) — the AC's "a
 * non-admin receiving 403", exercised against the **real** `requireAdmin()` guard
 * rather than a handler mounted bare.
 *
 * The per-route specs (`admin-overview.spec.ts` etc.) mount the handler alone, so
 * they prove the queries and never touch authorization. This file is the other
 * half: it mounts every panel route behind the same guard `index.ts` uses, so the
 * gate is verified end-to-end and a future registration that forgets
 * `requireAdmin()` fails here.
 *
 * Extended by AECI-579 with `GET /api/admin/catalog/coverage`, by AECI-586 with
 * the Audience pair, and by AECI-652 with the three `/api/admin/vendors` reads.
 * Every read endpoint the epic adds belongs in {@link ROUTES} — that is the point
 * of the file.
 *
 * The matrix, per `AUTH_AND_RLS.md` / `ADMIN_PANEL_SPEC.md` §9.1:
 *   anon (no token)   → 401
 *   authed non-admin  → 403
 *   banned admin      → 403 (the ban precedes the role grant)
 *   admin             → 200
 *
 * Shape follows `profiles.authz-matrix.spec.ts` (AECI-234).
 */

import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { requireAdmin, type AuthzVariables } from '../lib/authz';
import { makeTestJwks, type TestJwks } from '../test/auth';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import { createAdminAudienceHandler } from './admin-audience';
import { createAdminCatalogCoverageHandler } from './admin-catalog';
import { createAdminFeedbackHandler } from './admin-feedback';
import { createAdminTimeseriesHandler } from './admin-metrics';
import { createAdminOverviewHandler } from './admin-overview';
import { createAdminPageViewsHandler } from './admin-page-views';
import { createAdminSystemHandler } from './admin-system';
import { createAdminTrafficBreakdownHandler } from './admin-traffic';
import {
  createAdminVendorAuditHandler,
  createAdminVendorDetailHandler,
  createAdminVendorsListHandler,
} from './admin-vendors';
import { createAdminUserDetailHandler, createAdminUsersListHandler } from './admin-users';

const SUPABASE_URL = 'https://test-project.supabase.co';
const ENV = { ENV: 'preview', SUPABASE_URL } as Env;

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const REVIEWER = u(900);
const ADMIN = u(901);
const ADMIN_BANNED = u(902);
/** A real vendor row, because the two `/api/admin/vendors/:id` routes 404 on an
 *  unknown id — and this file asserts **200** for an admin, so an empty `vendors`
 *  table would fail the matrix for a reason that has nothing to do with the gate. */
const VENDOR = u(950);

const NOW = new Date('2026-08-11T05:00:00.000Z');

/** Every admin-panel read route, with a query string that would succeed if the
 *  caller were an admin — so a 401/403 can only come from the gate. */
const ROUTES = [
  { name: 'GET /api/admin/overview', url: '/api/admin/overview' },
  {
    name: 'GET /api/admin/metrics/timeseries',
    url: '/api/admin/metrics/timeseries?metric=traffic.page_views_human&from=2026-08-10&to=2026-08-10',
  },
  {
    name: 'GET /api/admin/traffic/breakdown',
    url: '/api/admin/traffic/breakdown?dimension=source&from=2026-08-10&to=2026-08-10',
  },
  {
    name: 'GET /api/admin/page-views',
    url: '/api/admin/page-views?from=2026-08-10&to=2026-08-10',
  },
  { name: 'GET /api/admin/catalog/coverage', url: '/api/admin/catalog/coverage' },
  { name: 'GET /api/admin/system', url: '/api/admin/system' },
  {
    name: 'GET /api/admin/audience',
    url: '/api/admin/audience?from=2026-08-10&to=2026-08-10',
  },
  { name: 'GET /api/admin/feedback', url: '/api/admin/feedback' },
  // AECI-652 — the §5.6 vendor surface. The DELETE is covered by
  // `admin-vendors.spec.ts` instead: this file is `get()`-shaped, and a write
  // route belongs with the rest of its write semantics.
  { name: 'GET /api/admin/vendors', url: '/api/admin/vendors' },
  { name: 'GET /api/admin/vendors/:id', url: `/api/admin/vendors/${VENDOR}` },
  { name: 'GET /api/admin/vendors/:id/audit', url: `/api/admin/vendors/${VENDOR}/audit` },
  // AECI-692 — the §5.8 user surface. Two reads; ban/reinstate is not here at
  // all, it reuses `PATCH /api/admin/reviewers/:id` unchanged, so this file
  // stays `get()`-shaped. The detail 404s on an unknown id and this matrix
  // asserts 200 for an admin, so it addresses a SEEDED profile — REVIEWER, who
  // exists for the deny cases anyway.
  { name: 'GET /api/admin/users', url: '/api/admin/users' },
  { name: 'GET /api/admin/users/:id', url: `/api/admin/users/${REVIEWER}` },
] as const;

let jwks: TestJwks;
beforeAll(async () => {
  jwks = await makeTestJwks();
});
const tokenFor = (sub: string) => jwks.mintToken({ sub, supabaseUrl: SUPABASE_URL });

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db
    .insert(vendors)
    .values({ id: VENDOR, slug: 'authz-matrix-vendor', companyName: 'Authz Matrix Vendor' });
  await t.db.insert(profiles).values([
    { id: REVIEWER, role: 'reviewer' },
    { id: ADMIN, role: 'admin' },
    { id: ADMIN_BANNED, role: 'admin', bannedAt: '2026-06-02T00:00:00.000Z', banReason: 'x' },
  ]);
});
afterEach(() => t.dispose());

function makeApp() {
  const guard = { getKey: jwks.getKey, dbFor: t.factory };
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  const clock = { now: () => NOW };
  app.get('/api/admin/overview', requireAdmin(guard), createAdminOverviewHandler(t.factory, clock));
  app.get(
    '/api/admin/metrics/timeseries',
    requireAdmin(guard),
    createAdminTimeseriesHandler(t.factory, clock),
  );
  app.get(
    '/api/admin/traffic/breakdown',
    requireAdmin(guard),
    createAdminTrafficBreakdownHandler(t.factory, clock),
  );
  app.get(
    '/api/admin/page-views',
    requireAdmin(guard),
    createAdminPageViewsHandler(t.factory, clock),
  );
  app.get(
    '/api/admin/catalog/coverage',
    requireAdmin(guard),
    createAdminCatalogCoverageHandler(t.factory, clock),
  );
  app.get('/api/admin/system', requireAdmin(guard), createAdminSystemHandler(t.factory, clock));
  app.get('/api/admin/audience', requireAdmin(guard), createAdminAudienceHandler(t.factory, clock));
  app.get('/api/admin/feedback', requireAdmin(guard), createAdminFeedbackHandler(t.factory, clock));
  // The vendor reads take no clock; the detail/audit handlers take the email seam
  // second, and its default would reach GoTrue. Stub it — this file is about the
  // gate, not the seam.
  const noEmails = async () => ({
    available: true,
    emails: new Map<string, string>(),
    reason: 'ok' as const,
  });
  app.get('/api/admin/vendors', requireAdmin(guard), createAdminVendorsListHandler(t.factory));
  app.get(
    '/api/admin/vendors/:id',
    requireAdmin(guard),
    createAdminVendorDetailHandler(t.factory, noEmails),
  );
  app.get(
    '/api/admin/vendors/:id/audit',
    requireAdmin(guard),
    createAdminVendorAuditHandler(t.factory, noEmails),
  );
  // AECI-692. Same reasoning as `noEmails`: the record seam's default would
  // reach GoTrue, and `available: true` with an empty map is the "seam up, no
  // account" branch — the cheapest one that still 200s.
  const noRecords = async () => ({
    available: true,
    records: new Map<string, never>(),
    reason: 'ok' as const,
  });
  app.get(
    '/api/admin/users',
    requireAdmin(guard),
    createAdminUsersListHandler(t.factory, noRecords),
  );
  app.get(
    '/api/admin/users/:id',
    requireAdmin(guard),
    createAdminUserDetailHandler(t.factory, noRecords),
  );
  return app;
}

function get(url: string, token?: string) {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  return makeApp().request(url, { headers }, ENV, fakeExecutionContext());
}

describe.each(ROUTES)('admin-panel deny-matrix — $name', ({ url }) => {
  it('anon (no token) → 401', async () => {
    expect((await get(url)).status).toBe(401);
  });

  it('an authenticated non-admin → 403', async () => {
    expect((await get(url, await tokenFor(REVIEWER))).status).toBe(403);
  });

  it('a banned admin → 403 (the ban precedes the role grant)', async () => {
    expect((await get(url, await tokenFor(ADMIN_BANNED))).status).toBe(403);
  });

  it('an admin → 200', async () => {
    expect((await get(url, await tokenFor(ADMIN))).status).toBe(200);
  });
});
