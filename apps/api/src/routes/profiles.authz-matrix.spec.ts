/**
 * Profiles no-leakage deny-matrix (AECI-234) — the ADR-0016 §4 acceptance gate
 * for `profiles`. See `reviews.authz-matrix.spec.ts` for the full context (RLS →
 * D1/app-layer). This spec composes the REAL `requireAuth()`/`requireAdmin()`
 * guard with the REAL profile-read handlers over the in-memory D1 harness.
 *
 * The matrix (▸ = the cells no prior spec covered end-to-end):
 *   GET /api/account (requireAuth, self-scoped)
 *     anon                → 401
 *     active owner        → 200, OWN identity only (user_id == sub)
 *   ▸ banned owner        → 403
 *     any caller          → self-scoped by construction (no param selects another)
 *   GET /api/admin/reviewers (requireAdmin — reads OTHER users' identities)
 *     authed non-admin    → 403
 *   ▸ banned admin        → 403 (ban precedes the role grant)
 *     admin               → 200, reads other profiles (the banned-reviewers list)
 *   ▸ WRITE paths — each mounted behind its REAL guard (the AECI-234 "no write
 *     grants to anon/authenticated" acceptance), deny cells reject before the
 *     handler runs (no body needed):
 *       PATCH  /api/account             anon → 401 · banned → 403
 *       DELETE /api/account             anon → 401 · banned → 403
 *       PATCH  /api/admin/reviewers/:id non-admin → 403 · banned admin → 403
 *
 * There is NO app surface that returns an arbitrary other user's profile — the
 * "anon/authenticated can't read any profile but their own" rule holds *by
 * construction* (the only self-read is `/account`, the only cross-user read is
 * admin-gated). Writes are likewise guarded: self-only `PATCH`/`DELETE /account`
 * (requireAuth) and admin ban/unban (requireAdmin); no anon/non-owner write path
 * exists. The write deny-cells above mount each write route behind its REAL guard
 * and assert anon/banned/non-admin are rejected before the handler runs — the
 * per-route specs (`account.spec.ts` / `admin-reviewers.spec.ts`) inject
 * `c.set('auth', …)` and so exercise the handlers, not the guard.
 */

import { ListBannedReviewersResponseSchema } from '@aeci/shared';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { profiles } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { requireAdmin, requireAuth, type AuthzVariables } from '../lib/authz';
import type { FetchReviewerEmails } from './admin-reviews';
import { makeTestDb, type TestDb } from '../test/d1';
import { makeTestJwks, type TestJwks } from '../test/auth';
import { fakeExecutionContext } from '../test/helpers';
import {
  createDeleteAccountHandler,
  createGetAccountHandler,
  createUpdateAccountHandler,
} from './account';
import { createBanReviewerHandler, createBannedReviewersListHandler } from './admin-reviewers';

const SUPABASE_URL = 'https://test-project.supabase.co';
const ENV = { DATABASE_URL: 'prisma://test', ENV: 'preview', SUPABASE_URL } as Env;

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const OWNER = u(900); // active reviewer
const BANNED = u(901); // banned reviewer
const ADMIN = u(902); // active admin
const NONOWNER = u(903); // a different active reviewer
const ADMINBANNED = u(905); // an admin who is also banned

type AccountBody = {
  user_id: string;
  email: string | null;
  display_name: string | null;
  role: string;
};

let jwks: TestJwks;
beforeAll(async () => {
  jwks = await makeTestJwks();
});
const tokenFor = (sub: string, email?: string) =>
  jwks.mintToken({ sub, email, supabaseUrl: SUPABASE_URL });

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(profiles).values([
    { id: OWNER, role: 'reviewer', displayName: 'Owner Name' },
    { id: NONOWNER, role: 'reviewer', displayName: 'Other Name' },
    { id: BANNED, role: 'reviewer', bannedAt: '2026-06-01T00:00:00.000Z', banReason: 'Spam' },
    { id: ADMIN, role: 'admin' },
    { id: ADMINBANNED, role: 'admin', bannedAt: '2026-06-02T00:00:00.000Z', banReason: 'x' },
  ]);
});
afterEach(() => t.dispose());

const noEmails: FetchReviewerEmails = async () => new Map<string, string>();

function makeApp() {
  const guard = { getKey: jwks.getKey, dbFor: t.factory };
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.get('/api/account', requireAuth(guard), createGetAccountHandler(t.factory));
  app.get(
    '/api/admin/reviewers',
    requireAdmin(guard),
    createBannedReviewersListHandler(t.factory, noEmails),
  );
  // Write paths — mounted with the SAME real guards as `index.ts` so the write
  // deny-matrix is exercised end-to-end. Deny cells reject before the handler, so
  // no request body is needed.
  app.patch('/api/account', requireAuth(guard), createUpdateAccountHandler(t.factory));
  app.delete('/api/account', requireAuth(guard), createDeleteAccountHandler(t.factory));
  app.patch('/api/admin/reviewers/:id', requireAdmin(guard), createBanReviewerHandler(t.factory));
  return app;
}

function get(url: string, token?: string) {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  return makeApp().request(url, { headers }, ENV, fakeExecutionContext());
}

function send(method: 'PATCH' | 'DELETE', url: string, token?: string) {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  return makeApp().request(url, { method, headers }, ENV, fakeExecutionContext());
}

describe('profiles deny-matrix — GET /api/account (requireAuth, self-scoped)', () => {
  it('anon (no token) → 401', async () => {
    expect((await get('/api/account')).status).toBe(401);
  });

  it('an active owner reads only their OWN profile identity', async () => {
    const res = await get('/api/account', await tokenFor(OWNER, 'owner@example.com'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as AccountBody;
    expect(body.user_id).toBe(OWNER);
    expect(body.role).toBe('reviewer');
    expect(body.display_name).toBe('Owner Name');
    expect(body.email).toBe('owner@example.com');
  });

  it('is self-scoped by construction — a different caller gets their OWN identity, never another’s', async () => {
    const res = await get('/api/account', await tokenFor(NONOWNER));
    expect(res.status).toBe(200);
    const body = (await res.json()) as AccountBody;
    expect(body.user_id).toBe(NONOWNER);
    expect(body.display_name).toBe('Other Name');
    // no way to request OWNER's row through this endpoint
    expect(body.user_id).not.toBe(OWNER);
  });

  it('a banned owner → 403', async () => {
    expect((await get('/api/account', await tokenFor(BANNED))).status).toBe(403);
  });
});

describe('profiles deny-matrix — GET /api/admin/reviewers (requireAdmin)', () => {
  it('an authenticated non-admin → 403', async () => {
    expect((await get('/api/admin/reviewers', await tokenFor(OWNER))).status).toBe(403);
  });

  it('a banned admin → 403 (ban precedes the role grant)', async () => {
    expect((await get('/api/admin/reviewers', await tokenFor(ADMINBANNED))).status).toBe(403);
  });

  it('an admin reads OTHER users’ profile identities (the banned-reviewers list)', async () => {
    const res = await get('/api/admin/reviewers', await tokenFor(ADMIN));
    expect(res.status).toBe(200);
    const body = ListBannedReviewersResponseSchema.parse(await res.json());
    const ids = body.data.map((r) => r.reviewer_id);
    // every banned profile, regardless of role (the cross-user read non-admins lack)
    expect(body.total).toBe(2);
    expect(ids).toContain(BANNED);
    expect(ids).toContain(ADMINBANNED);
    // active profiles never appear
    expect(ids).not.toContain(OWNER);
    expect(ids).not.toContain(NONOWNER);
    expect(ids).not.toContain(ADMIN);
  });
});

describe('profiles deny-matrix — write paths reject at the guard, before the handler', () => {
  it('PATCH /api/account — anon (no token) → 401', async () => {
    expect((await send('PATCH', '/api/account')).status).toBe(401);
  });

  it('PATCH /api/account — a banned owner → 403', async () => {
    expect((await send('PATCH', '/api/account', await tokenFor(BANNED))).status).toBe(403);
  });

  it('DELETE /api/account — anon (no token) → 401', async () => {
    expect((await send('DELETE', '/api/account')).status).toBe(401);
  });

  it('DELETE /api/account — a banned owner → 403', async () => {
    expect((await send('DELETE', '/api/account', await tokenFor(BANNED))).status).toBe(403);
  });

  it('PATCH /api/admin/reviewers/:id — an authenticated non-admin → 403', async () => {
    const res = await send('PATCH', `/api/admin/reviewers/${BANNED}`, await tokenFor(OWNER));
    expect(res.status).toBe(403);
  });

  it('PATCH /api/admin/reviewers/:id — a banned admin → 403 (ban precedes the role grant)', async () => {
    const res = await send('PATCH', `/api/admin/reviewers/${BANNED}`, await tokenFor(ADMINBANNED));
    expect(res.status).toBe(403);
  });
});
