/**
 * Unit coverage for the Phase 5.13 admin moderation API (AECI-204):
 *
 *   GET   /api/admin/reviews
 *   PATCH /api/admin/reviews/:id
 *
 * The handlers are exercised in isolation (mirroring `reviews.spec.ts`): a
 * middleware sets the `auth` Variable that `requireAdmin()` would, a hand-rolled
 * fake Prisma surface stands in for the accelerated client, and the
 * email-lookup + recompute side effects are injected so each can be asserted
 * without a DB. The AC matrix: list filters / sort / pagination / email
 * hydration; approve recomputes + purges + audits; reject requires a reason and
 * does neither; non-pending → 422; not-found → 404.
 *
 * One integration block wires the REAL `requireAdmin()` (offline ES256 JWKS via
 * the `getKey` seam, same as `authz.spec.ts`) to pin the non-admin → 403 path
 * the `index.ts` sub-router uses.
 */

import { ApiErrorCode, ListPendingReviewsResponseSchema } from '@aeci/shared';
import { Hono } from 'hono';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey,
} from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Env } from '../env';
import { errorHandler } from '../errors';
import { requireAdmin, type AuthzProfileClient, type AuthzVariables } from '../lib/authz';
import {
  createAdminReviewsListHandler,
  createModerateReviewHandler,
  type FetchReviewerEmails,
} from './admin-reviews';

const ADMIN_ID = 'admin-uuid-1';
const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const REVIEWER_ID = '22222222-2222-4222-8222-222222222222';
const REVIEW_ID = '33333333-3333-4333-8333-333333333333';

const ADMIN_AUTH: AuthzVariables['auth'] = {
  userId: ADMIN_ID,
  email: 'admin@aeci.test',
  role: 'admin',
};

const ENV = { DD_API_KEY: undefined } as Env;

/** ExecutionContext stub whose `waitUntil` is a spy, so the post-commit purge
 *  trigger can be asserted (and the 500 / telemetry branches don't throw). */
function executionCtxStub() {
  const waitUntil = vi.fn((_p: Promise<unknown>) => {});
  const ctx = {
    waitUntil,
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, waitUntil };
}

/** A full admin row as `adminReviewSelect` would return it (camelCase, Date). */
function adminRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REVIEW_ID,
    reviewerId: REVIEWER_ID,
    ratingOverall: 4,
    ratingOnboarding: 5,
    title: 'Solid Revit add-in',
    body: 'We rolled this out across two studios and onboarding took about a day. Stable since.',
    roleAtCompany: 'practitioner',
    yearsUsing: 3,
    wouldRecommend: 'yes',
    verifiedWorkEmail: true,
    locale: 'en-US',
    status: 'pending',
    toxicityScore: 12,
    rejectionReason: null,
    moderatedAt: null,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    product: { id: PRODUCT_ID, name: 'Procore', slug: 'procore' },
    ...overrides,
  };
}

/** Email lookup fake: every requested id maps to `<id>@example.test`. */
const fakeFetchEmails: FetchReviewerEmails = async (_prisma, ids) =>
  new Map(ids.map((id) => [id, `${id}@example.test`]));

// ─── GET /api/admin/reviews ──────────────────────────────────────────────────

function listPrisma(rows: unknown[], total = rows.length) {
  const findMany = vi.fn(async (_args: unknown) => rows);
  const count = vi.fn(async (_args: unknown) => total);
  return { prisma: { review: { findMany, count } }, findMany, count };
}

function listApp(
  prisma: unknown,
  fetchEmails: FetchReviewerEmails = fakeFetchEmails,
  auth: AuthzVariables['auth'] = ADMIN_AUTH,
) {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.use('/api/admin/reviews', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  app.get(
    '/api/admin/reviews',
    createAdminReviewsListHandler(() => prisma as never, fetchEmails),
  );
  return app;
}

function getList(app: Hono<{ Bindings: Env; Variables: AuthzVariables }>, qs = '') {
  return app.request(`/api/admin/reviews${qs}`, {}, ENV, executionCtxStub().ctx);
}

describe('GET /api/admin/reviews', () => {
  it('defaults to pending + queue_age (oldest-first) and hydrates reviewer_email + toxicity_score', async () => {
    const { prisma, findMany, count } = listPrisma([adminRow()]);
    const res = await getList(listApp(prisma));

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const parsed = ListPendingReviewsResponseSchema.parse(await res.json());
    expect(parsed.page).toBe(1);
    expect(parsed.perPage).toBe(24);
    expect(parsed.total).toBe(1);
    expect(parsed.data[0]?.reviewer_email).toBe(`${REVIEWER_ID}@example.test`);
    expect(parsed.data[0]?.toxicity_score).toBe(12);
    expect(parsed.data[0]?.product).toEqual({ id: PRODUCT_ID, name: 'Procore', slug: 'procore' });

    const call = findMany.mock.calls[0][0] as {
      where: { status: string };
      orderBy: unknown;
      skip: number;
      take: number;
    };
    expect(call.where).toEqual({ status: 'pending' });
    expect(call.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    expect(call.skip).toBe(0);
    expect(call.take).toBe(24);
    expect((count.mock.calls[0][0] as { where: unknown }).where).toEqual({ status: 'pending' });
  });

  it('filters by status=approved', async () => {
    const { prisma, findMany, count } = listPrisma([adminRow({ status: 'approved' })]);
    await getList(listApp(prisma), '?status=approved');
    expect((findMany.mock.calls[0][0] as { where: unknown }).where).toEqual({ status: 'approved' });
    expect((count.mock.calls[0][0] as { where: unknown }).where).toEqual({ status: 'approved' });
  });

  it('filters by status=rejected', async () => {
    const { prisma, findMany } = listPrisma([adminRow({ status: 'rejected' })]);
    await getList(listApp(prisma), '?status=rejected');
    expect((findMany.mock.calls[0][0] as { where: unknown }).where).toEqual({ status: 'rejected' });
  });

  it('sort=created_at orders newest-first', async () => {
    const { prisma, findMany } = listPrisma([adminRow()]);
    await getList(listApp(prisma), '?sort=created_at');
    expect((findMany.mock.calls[0][0] as { orderBy: unknown }).orderBy).toEqual([
      { createdAt: 'desc' },
      { id: 'asc' },
    ]);
  });

  it('honors page/perPage with the correct skip/take', async () => {
    const { prisma, findMany } = listPrisma([], 40);
    await getList(listApp(prisma), '?page=3&perPage=10');
    const call = findMany.mock.calls[0][0] as { skip: number; take: number };
    expect(call.skip).toBe(20);
    expect(call.take).toBe(10);
  });

  it('returns reviewer_email: null for an anonymized review (reviewer_id null)', async () => {
    const fetchEmails = vi.fn(fakeFetchEmails);
    const { prisma } = listPrisma([adminRow({ reviewerId: null })]);
    const res = await getList(listApp(prisma, fetchEmails));
    const parsed = ListPendingReviewsResponseSchema.parse(await res.json());
    expect(parsed.data[0]?.reviewer_email).toBeNull();
    // No reviewer ids on the page → the lookup is skipped entirely.
    expect(fetchEmails).not.toHaveBeenCalled();
  });

  it('degrades to reviewer_email: null when the auth.users lookup throws (no 500)', async () => {
    const throwingFetch: FetchReviewerEmails = async () => {
      throw new Error('permission denied for relation users');
    };
    const { prisma } = listPrisma([adminRow()]);
    const res = await getList(listApp(prisma, throwingFetch));
    expect(res.status).toBe(200);
    const parsed = ListPendingReviewsResponseSchema.parse(await res.json());
    expect(parsed.data[0]?.reviewer_email).toBeNull();
  });

  it('returns an empty page when no reviews match', async () => {
    const { prisma } = listPrisma([], 0);
    const res = await getList(listApp(prisma));
    expect(res.status).toBe(200);
    const parsed = ListPendingReviewsResponseSchema.parse(await res.json());
    expect(parsed.data).toEqual([]);
    expect(parsed.total).toBe(0);
  });
});

// ─── PATCH /api/admin/reviews/:id ────────────────────────────────────────────

function moderatePrisma(opts: { existing?: unknown; updateCount?: number } = {}) {
  const findUnique = vi.fn(async (_args: unknown) =>
    opts.existing === undefined ? adminRow() : opts.existing,
  );
  const updateMany = vi.fn(async (_args: unknown) => ({ count: opts.updateCount ?? 1 }));
  const auditCreate = vi.fn(async (_args: unknown) => ({}));
  const tx = { review: { updateMany }, auditLog: { create: auditCreate } };
  const prisma = {
    review: { findUnique },
    $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
  };
  return { prisma, findUnique, updateMany, auditCreate };
}

function moderateApp(
  prisma: unknown,
  opts: {
    fetchEmails?: FetchReviewerEmails;
    recompute?: (db: unknown, ids: Iterable<string>) => Promise<void>;
    auth?: AuthzVariables['auth'];
    env?: Env;
  } = {},
) {
  const recompute = opts.recompute ?? vi.fn(async () => {});
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.use('/api/admin/reviews/:id', async (c, next) => {
    c.set('auth', opts.auth ?? ADMIN_AUTH);
    await next();
  });
  app.patch(
    '/api/admin/reviews/:id',
    createModerateReviewHandler(
      () => prisma as never,
      opts.fetchEmails ?? fakeFetchEmails,
      recompute as never,
    ),
  );
  return { app, recompute, env: opts.env ?? ENV };
}

function patchReq(
  app: Hono<{ Bindings: Env; Variables: AuthzVariables }>,
  body: unknown,
  env: Env = ENV,
  id = REVIEW_ID,
) {
  const { ctx, waitUntil } = executionCtxStub();
  const res = app.request(
    `/api/admin/reviews/${id}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    env,
    ctx,
  );
  return { res, waitUntil };
}

describe('PATCH /api/admin/reviews/:id', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('approves a pending review: status, moderator, recompute, audit', async () => {
    const { prisma, updateMany, auditCreate } = moderatePrisma();
    const { app, recompute } = moderateApp(prisma);
    const { res } = patchReq(app, { action: 'approve' });
    const response = await res;

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe('approved');
    expect(body.moderated_at).toEqual(expect.any(String));
    expect(body.reviewer_email).toBe(`${REVIEWER_ID}@example.test`);

    const updateArgs = updateMany.mock.calls[0][0] as {
      where: { id: string; status: string };
      data: Record<string, unknown>;
    };
    expect(updateArgs.where).toEqual({ id: REVIEW_ID, status: 'pending' });
    expect(updateArgs.data).toMatchObject({ status: 'approved', moderatedBy: ADMIN_ID });
    expect(updateArgs.data.moderatedAt).toBeInstanceOf(Date);
    expect(updateArgs.data).not.toHaveProperty('rejectionReason');

    // Recompute fires once, for this review's product, inside the tx.
    expect(recompute).toHaveBeenCalledTimes(1);
    expect((recompute as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual([PRODUCT_ID]);

    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect((auditCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data).toMatchObject({
      actorId: ADMIN_ID,
      actorType: 'admin',
      action: 'review.approved',
      entityType: 'review',
      entityId: REVIEW_ID,
      metadata: { source: 'admin-moderation', product_id: PRODUCT_ID },
    });
  });

  it('purges the product Cache-Tag on approve (creds present)', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        ({ ok: true, status: 200 }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchMock);
    const { prisma } = moderatePrisma();
    const env = { DD_API_KEY: undefined, CF_PURGE_API_TOKEN: 'tok', CF_ZONE_ID: 'zone-1' } as Env;
    const { app } = moderateApp(prisma, { env });
    const { res, waitUntil } = patchReq(app, { action: 'approve' }, env);
    await res;

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/zones/zone-1/purge_cache');
    expect(JSON.parse(init?.body as string)).toEqual({ tags: ['product:procore'] });
  });

  it('rejects a pending review: required reason stored, no recompute, no purge', async () => {
    const { prisma, updateMany, auditCreate } = moderatePrisma();
    const env = { DD_API_KEY: undefined, CF_PURGE_API_TOKEN: 'tok', CF_ZONE_ID: 'zone-1' } as Env;
    const { app, recompute } = moderateApp(prisma, { env });
    const { res, waitUntil } = patchReq(app, { action: 'reject', rejection_reason: 'Spam' }, env);
    const response = await res;

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe('rejected');
    expect(body.rejection_reason).toBe('Spam');

    expect((updateMany.mock.calls[0][0] as { data: Record<string, unknown> }).data).toMatchObject({
      status: 'rejected',
      moderatedBy: ADMIN_ID,
      rejectionReason: 'Spam',
    });
    // Reject never touches public aggregates or the edge cache.
    expect(recompute).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
    expect((auditCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data).toMatchObject({
      action: 'review.rejected',
      metadata: { source: 'admin-moderation', product_id: PRODUCT_ID, rejection_reason: 'Spam' },
    });
  });

  it('rejects with 400 VALIDATION_FAILED when rejection_reason is missing', async () => {
    const { prisma, findUnique, updateMany } = moderatePrisma();
    const { app } = moderateApp(prisma);
    const { res } = patchReq(app, { action: 'reject' });
    const response = await res;

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; field?: string } };
    expect(body.error.code).toBe(ApiErrorCode.VALIDATION_FAILED);
    expect(body.error.field).toBe('rejection_reason');
    // Validation fails before any DB work.
    expect(findUnique).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('rejects with 400 when rejection_reason is whitespace-only', async () => {
    const { prisma } = moderatePrisma();
    const { app } = moderateApp(prisma);
    const { res } = patchReq(app, { action: 'reject', rejection_reason: '   ' });
    const response = await res;
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { field?: string } }).error.field).toBe(
      'rejection_reason',
    );
  });

  it('returns 422 INVALID_STATE_TRANSITION for a non-pending review', async () => {
    const { prisma, updateMany } = moderatePrisma({ existing: adminRow({ status: 'approved' }) });
    const { app } = moderateApp(prisma);
    const { res } = patchReq(app, { action: 'approve' });
    const response = await res;

    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      ApiErrorCode.INVALID_STATE_TRANSITION,
    );
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('returns the canonical 404 envelope for an unknown review id', async () => {
    const { prisma, updateMany } = moderatePrisma({ existing: null });
    const { app } = moderateApp(prisma);
    const { res } = patchReq(app, { action: 'approve' });
    const response = await res;

    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      error: { code: string; details?: { resource?: string; id?: string } };
    };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.details).toEqual({ resource: 'review', id: REVIEW_ID });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('returns 422 when the row is no longer pending at update time (concurrent race)', async () => {
    // Preload sees pending, but the guarded updateMany matches 0 rows.
    const { prisma, auditCreate } = moderatePrisma({ updateCount: 0 });
    const { app, recompute } = moderateApp(prisma);
    const { res } = patchReq(app, { action: 'approve' });
    const response = await res;

    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      ApiErrorCode.INVALID_STATE_TRANSITION,
    );
    // The transition rolled back before recompute / audit.
    expect(recompute).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });
});

// ─── Integration: real requireAdmin() in front of the real list handler ───────

const SUPABASE_URL = 'https://test-project.supabase.co';
const ISSUER = `${SUPABASE_URL}/auth/v1`;

let privateKey: CryptoKey;
let getKey: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey as CryptoKey;
  const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'ES256' };
  getKey = createLocalJWKSet({ keys: [publicJwk] });
});

async function mintToken(sub: string): Promise<string> {
  return new SignJWT({ sub })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setExpirationTime('1h')
    .sign(privateKey);
}

type ProfileRow = { role: string; bannedAt: Date | null; banReason: string | null };

function authProfileClient(profiles: Record<string, ProfileRow>): AuthzProfileClient {
  return {
    profile: {
      findUnique: ({ where }) => Promise.resolve(profiles[where.id] ?? null),
    },
  };
}

function adminGuardedApp(profiles: Record<string, ProfileRow>, prisma: unknown) {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.get(
    '/api/admin/reviews',
    requireAdmin({ getKey, getClient: () => authProfileClient(profiles) }),
    createAdminReviewsListHandler(() => prisma as never, fakeFetchEmails),
  );
  return app;
}

describe('GET /api/admin/reviews (with requireAdmin middleware)', () => {
  const GUARD_ENV = { SUPABASE_URL, DD_API_KEY: undefined } as Env;

  it('rejects a non-admin (reviewer) with 403 FORBIDDEN before the handler runs', async () => {
    const { prisma, findMany } = listPrisma([adminRow()]);
    const app = adminGuardedApp(
      { 'user-reviewer': { role: 'reviewer', bannedAt: null, banReason: null } },
      prisma,
    );
    const token = await mintToken('user-reviewer');
    const res = await app.request(
      '/api/admin/reviews',
      { headers: { Authorization: `Bearer ${token}` } },
      GUARD_ENV,
    );

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ApiErrorCode.FORBIDDEN,
    );
    expect(findMany).not.toHaveBeenCalled();
  });

  it('admits an admin end-to-end (200)', async () => {
    const { prisma } = listPrisma([adminRow()]);
    const app = adminGuardedApp(
      { 'user-admin': { role: 'admin', bannedAt: null, banReason: null } },
      prisma,
    );
    const token = await mintToken('user-admin');
    const res = await app.request(
      '/api/admin/reviews',
      { headers: { Authorization: `Bearer ${token}` } },
      GUARD_ENV,
    );
    expect(res.status).toBe(200);
  });

  it('rejects a missing token with 401 UNAUTHENTICATED', async () => {
    const { prisma } = listPrisma([adminRow()]);
    const app = adminGuardedApp(
      { 'user-admin': { role: 'admin', bannedAt: null, banReason: null } },
      prisma,
    );
    const res = await app.request('/api/admin/reviews', {}, GUARD_ENV);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ApiErrorCode.UNAUTHENTICATED,
    );
  });
});
