/**
 * Reviews no-leakage deny-matrix (AECI-234) — the ADR-0016 §4 acceptance gate.
 *
 * Context: AECI-234 was filed (pre-ADR-0016) as a PostgREST **RLS** deny-matrix
 * for `reviews`/`profiles`. ADR 0016 (accepted 2026-06-22) moved those tables to
 * Cloudflare D1 (SQLite) — which has **no RLS and no PostgREST** — and made an
 * **app-layer no-leakage test matrix the acceptance gate** ("re-expressed as
 * app-layer ownership/visibility filters… there is no DB backstop"). This spec is
 * that gate for reviews: it composes the REAL `requireAuth()`/`requireAdmin()`
 * guard (`lib/authz.ts`) in front of the REAL read handlers over the in-memory D1
 * harness, and asserts every actor × surface cell end-to-end — unlike the
 * per-route specs, which inject `c.set('auth', …)` directly and so skip the guard.
 *
 * The matrix (▸ = the cells no prior spec covered end-to-end):
 *   public GET /api/products/:slug/reviews (no guard)
 *     anon                → 200, approved only (pending/rejected excluded)
 *   ▸ banned user         → 200, still sees approved (public path, no auth gate)
 *   GET /api/account/reviews (requireAuth, owner-scoped)
 *     anon                → 401
 *     active owner        → 200, own rows in EVERY status, never another user's
 *     authed non-owner    → 200, self-scoped (cannot see the owner's pending)
 *   ▸ banned owner        → 403 (cannot read ANY own review via the authed path)
 *   GET /api/admin/reviews (requireAdmin)
 *     authed non-admin    → 403
 *   ▸ banned admin        → 403 (ban precedes the role grant)
 *     admin               → 200, full pending queue across ALL reviewers
 *   ▸ WRITE paths — each mounted behind its REAL guard (the AECI-234 "no write
 *     grants to anon/authenticated" acceptance), deny cells reject before the
 *     handler runs (no body needed):
 *       POST /api/reviews            anon → 401 · banned → 403 REVIEW_BANNED
 *       PATCH /api/admin/reviews/:id non-admin → 403 · banned admin → 403
 *
 * Note the intentional divergence from the retired RLS semantics: under RLS a
 * banned user could still owner-read their approved rows; here the authed
 * `/account/reviews` 403s them entirely, while the unguarded public list still
 * serves approved reviews to anyone — stronger, not a regression.
 */

import {
  AccountReviewsResponseSchema,
  ApiErrorCode,
  ListPendingReviewsResponseSchema,
  ProductReviewsResponseSchema,
} from '@aeci/shared';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { products, profiles, reviews } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { requireAdmin, requireAuth, type AuthzVariables } from '../lib/authz';
import type { FetchReviewerEmails } from './admin-reviews';
import { makeTestDb, type TestDb } from '../test/d1';
import { makeTestJwks, type TestJwks } from '../test/auth';
import { fakeExecutionContext } from '../test/helpers';
import { createAdminReviewsListHandler, createModerateReviewHandler } from './admin-reviews';
import { createGetAccountReviewsHandler } from './account-reviews';
import { createProductReviewsListHandler } from './product-reviews';
import { createSubmitReviewHandler } from './reviews';

const SUPABASE_URL = 'https://test-project.supabase.co';
// `ENV: 'preview'` keeps `validateResponseInDev` on (mapper drift fails loudly);
// `SUPABASE_URL` is required by the guard before it will verify a token.
const ENV = { ENV: 'preview', SUPABASE_URL } as Env;

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Actors (each a `profiles` row keyed by the token `sub`).
const OWNER = u(900); // active reviewer, owns the reviews under test
const BANNED = u(901); // banned reviewer
const ADMIN = u(902); // active admin
const NONOWNER = u(903); // a different active reviewer
const ADMINBANNED = u(905); // an admin who is also banned

// Review ids.
const R_OWNER_APPROVED = u(11);
const R_OWNER_PENDING = u(12);
const R_OWNER_REJECTED = u(13);
const R_NONOWNER_PENDING = u(14);
const R_BANNED_APPROVED = u(15);
const R_BANNED_PENDING = u(16);

let jwks: TestJwks;
beforeAll(async () => {
  jwks = await makeTestJwks();
});
const tokenFor = (sub: string) => jwks.mintToken({ sub, supabaseUrl: SUPABASE_URL });

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();

  // products (the public list resolves by slug; one per reviewed product so the
  // partial unique index on (product_id, reviewer_id) is never tripped).
  await t.db.insert(products).values(
    [1, 2, 3, 4, 5].map((n) => ({
      id: u(n),
      slug: `p${n}`,
      name: `P${n}`,
      promotionStatus: 'promoted',
    })),
  );
  // products[0] is the public-list fixture under the slug `p1`.

  // profiles in each authorization state.
  await t.db.insert(profiles).values([
    { id: OWNER, role: 'reviewer' },
    { id: NONOWNER, role: 'reviewer' },
    { id: BANNED, role: 'reviewer', bannedAt: '2026-06-01T00:00:00.000Z', banReason: 'Spam' },
    { id: ADMIN, role: 'admin' },
    { id: ADMINBANNED, role: 'admin', bannedAt: '2026-06-01T00:00:00.000Z', banReason: 'x' },
  ]);

  // reviews: owner has one of every status; a non-owner pending on the SAME
  // public product (p1) to prove the public list filters it out; the banned user
  // owns an approved + a pending row.
  await seedReview(R_OWNER_APPROVED, u(1), OWNER, 'approved');
  await seedReview(R_OWNER_PENDING, u(2), OWNER, 'pending');
  await seedReview(R_OWNER_REJECTED, u(3), OWNER, 'rejected');
  await seedReview(R_NONOWNER_PENDING, u(1), NONOWNER, 'pending');
  await seedReview(R_BANNED_APPROVED, u(4), BANNED, 'approved');
  await seedReview(R_BANNED_PENDING, u(5), BANNED, 'pending');
});
afterEach(() => t.dispose());

async function seedReview(id: string, productId: string, reviewerId: string, status: string) {
  await t.db.insert(reviews).values({
    id,
    productId,
    reviewerId,
    ratingOverall: 5,
    ratingOnboarding: 4,
    title: 'T',
    body: 'B',
    status,
  });
}

// Reviewer-email seam (seam #2) stubbed: no GoTrue call, reviewer_email → null.
const noEmails: FetchReviewerEmails = async () => new Map<string, string>();

/** The wired app: REAL guards in front of REAL handlers, all over one D1. */
function makeApp() {
  const guard = { getKey: jwks.getKey, dbFor: t.factory };
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.get('/api/products/:slug/reviews', createProductReviewsListHandler(t.factory));
  app.get('/api/account/reviews', requireAuth(guard), createGetAccountReviewsHandler(t.factory));
  app.get(
    '/api/admin/reviews',
    requireAdmin(guard),
    createAdminReviewsListHandler(t.factory, noEmails),
  );
  // Write paths — mounted with the SAME real guards as `index.ts` so the write
  // deny-matrix is exercised end-to-end (the per-route specs inject the session
  // and so never run the guard). Deny cells reject before the handler, so no
  // request body is needed; `REVIEW_BANNED` mirrors the production `bannedCode`.
  app.post(
    '/api/reviews',
    requireAuth({ ...guard, bannedCode: ApiErrorCode.REVIEW_BANNED }),
    createSubmitReviewHandler(t.factory),
  );
  app.patch(
    '/api/admin/reviews/:id',
    requireAdmin(guard),
    createModerateReviewHandler(t.factory, noEmails),
  );
  return app;
}

function get(url: string, token?: string) {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  return makeApp().request(url, { headers }, ENV, fakeExecutionContext());
}

function send(method: 'POST' | 'PATCH', url: string, token?: string) {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  return makeApp().request(url, { method, headers }, ENV, fakeExecutionContext());
}

describe('reviews deny-matrix — public GET /api/products/:slug/reviews', () => {
  it('anon sees only approved reviews; pending/rejected are excluded', async () => {
    const res = await get('/api/products/p1/reviews');
    expect(res.status).toBe(200);
    const body = ProductReviewsResponseSchema.parse(await res.json());
    expect(body.total).toBe(1);
    expect(body.data.map((r) => r.id)).toEqual([R_OWNER_APPROVED]);
    // the non-owner's pending review on the same product never surfaces publicly
    expect(body.data.some((r) => r.id === R_NONOWNER_PENDING)).toBe(false);
  });

  it('a banned user is NOT blocked on the unguarded public list — still sees approved', async () => {
    const res = await get('/api/products/p4/reviews', await tokenFor(BANNED));
    expect(res.status).toBe(200);
    const body = ProductReviewsResponseSchema.parse(await res.json());
    expect(body.data.map((r) => r.id)).toEqual([R_BANNED_APPROVED]);
  });
});

describe('reviews deny-matrix — GET /api/account/reviews (requireAuth, owner-scoped)', () => {
  it('anon (no token) → 401', async () => {
    expect((await get('/api/account/reviews')).status).toBe(401);
  });

  it('an active owner reads their OWN reviews in every status, never another user’s', async () => {
    const res = await get('/api/account/reviews', await tokenFor(OWNER));
    expect(res.status).toBe(200);
    const body = AccountReviewsResponseSchema.parse(await res.json());
    expect(body.total).toBe(3);
    expect(body.data.map((r) => r.id).sort()).toEqual(
      [R_OWNER_APPROVED, R_OWNER_PENDING, R_OWNER_REJECTED].sort(),
    );
    expect(body.data.map((r) => r.status).sort()).toEqual(['approved', 'pending', 'rejected']);
    // no leak of the non-owner's / banned user's rows
    expect(body.data.some((r) => r.id === R_NONOWNER_PENDING)).toBe(false);
    expect(body.data.some((r) => r.id === R_BANNED_PENDING)).toBe(false);
  });

  it('an authenticated non-owner is self-scoped — cannot read the owner’s pending review', async () => {
    const res = await get('/api/account/reviews', await tokenFor(NONOWNER));
    expect(res.status).toBe(200);
    const body = AccountReviewsResponseSchema.parse(await res.json());
    expect(body.total).toBe(1);
    expect(body.data[0]?.id).toBe(R_NONOWNER_PENDING);
  });

  it('a banned owner → 403 (cannot read ANY own review via the authed endpoint)', async () => {
    expect((await get('/api/account/reviews', await tokenFor(BANNED))).status).toBe(403);
  });
});

describe('reviews deny-matrix — GET /api/admin/reviews (requireAdmin)', () => {
  it('an authenticated non-admin → 403', async () => {
    expect((await get('/api/admin/reviews?status=pending', await tokenFor(OWNER))).status).toBe(
      403,
    );
  });

  it('a banned admin → 403 (ban precedes the role grant)', async () => {
    expect(
      (await get('/api/admin/reviews?status=pending', await tokenFor(ADMINBANNED))).status,
    ).toBe(403);
  });

  it('an admin reads the full pending queue across ALL reviewers', async () => {
    const res = await get('/api/admin/reviews?status=pending', await tokenFor(ADMIN));
    expect(res.status).toBe(200);
    const body = ListPendingReviewsResponseSchema.parse(await res.json());
    // every pending row, regardless of owner (the cross-user read non-admins lack)
    expect(body.total).toBe(3);
    const ids = body.data.map((r) => r.id);
    expect(ids).toContain(R_OWNER_PENDING);
    expect(ids).toContain(R_NONOWNER_PENDING);
    expect(ids).toContain(R_BANNED_PENDING);
  });
});

describe('reviews deny-matrix — write paths reject at the guard, before the handler', () => {
  it('POST /api/reviews — anon (no token) → 401', async () => {
    expect((await send('POST', '/api/reviews')).status).toBe(401);
  });

  it('POST /api/reviews — a banned reviewer → 403 REVIEW_BANNED', async () => {
    const res = await send('POST', '/api/reviews', await tokenFor(BANNED));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('REVIEW_BANNED');
  });

  it('PATCH /api/admin/reviews/:id — an authenticated non-admin → 403', async () => {
    const res = await send('PATCH', `/api/admin/reviews/${R_OWNER_PENDING}`, await tokenFor(OWNER));
    expect(res.status).toBe(403);
  });

  it('PATCH /api/admin/reviews/:id — a banned admin → 403 (ban precedes the role grant)', async () => {
    const res = await send(
      'PATCH',
      `/api/admin/reviews/${R_OWNER_PENDING}`,
      await tokenFor(ADMINBANNED),
    );
    expect(res.status).toBe(403);
  });
});
