/**
 * Unit coverage for `POST /api/reviews` (AECI-197 / Phase 5.6).
 *
 * The handler is exercised in isolation (mirroring `auth-profile.spec.ts`): a
 * middleware sets the `auth` Variable that `requireAuth()` would, and a fake
 * Prisma surface stands in for the accelerated client. Covers the AC matrix:
 * happy path + locale resolution, duplicate (pre-check and the unique-index
 * race), bad product, validation, audit write, and the "no denorm counter
 * recompute on submit" guarantee.
 *
 * One integration test wires the REAL `requireAuth()` (offline ES256 JWKS via
 * the `getKey` seam, same as `authz.spec.ts`) in front of the real handler, to
 * pin the banned → 403 `REVIEW_BANNED` path and the end-to-end happy path the
 * `index.ts` sub-router uses. The exhaustive 401/cookie/threading middleware
 * matrix already lives in `lib/authz.spec.ts`.
 */

import { ApiErrorCode } from '@aeci/shared';
import { Hono } from 'hono';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey,
} from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import type { Env } from '../env';
import { errorHandler } from '../errors';
import { requireAuth, type AuthzProfileClient, type AuthzVariables } from '../lib/authz';
import { createSubmitReviewHandler } from './reviews';

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'user-uuid-1';

/** A valid wire body; individual tests override fields. */
function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    product_id: PRODUCT_ID,
    rating_overall: 4,
    rating_onboarding: 5,
    title: 'Solid Revit add-in',
    body: 'We rolled this out across two studios and onboarding took about a day. Stable since.',
    role_at_company: 'practitioner',
    years_using: 3,
    would_recommend: 'yes',
    ...overrides,
  };
}

type Row = { id: string };
type CreateArgs = { data: Record<string, unknown>; select: { id: true } };
type FindFirstArgs = { where: Record<string, unknown>; select: { id: true } };
type FindUniqueArgs = { where: { id: string }; select: { id: true } };

/**
 * Fake Prisma surface. By default the product exists, no prior review, and the
 * create succeeds. `product: null` → 404; `existingReview` → pre-check dup;
 * `createError` → thrown from `review.create` (the race path). A `product.update`
 * spy is present but must never be called — submit does not touch counters.
 */
function makeFakePrisma(
  opts: { product?: Row | null; existingReview?: Row | null; createError?: unknown } = {},
) {
  const createCalls: CreateArgs[] = [];
  const auditCalls: { data: Record<string, unknown> }[] = [];
  const findFirstCalls: FindFirstArgs[] = [];
  const productFindCalls: FindUniqueArgs[] = [];
  const productUpdateCalls: unknown[] = [];

  const tx = {
    review: {
      create: async (args: CreateArgs): Promise<Row> => {
        createCalls.push(args);
        if (opts.createError) throw opts.createError;
        return { id: 'review-1' };
      },
    },
    auditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        auditCalls.push(args);
        return {};
      },
    },
  };

  const prisma = {
    product: {
      findUnique: async (args: FindUniqueArgs): Promise<Row | null> => {
        productFindCalls.push(args);
        return opts.product === undefined ? { id: args.where.id } : opts.product;
      },
      // Spy: if the handler ever recomputed counters on submit it would land here.
      update: async (args: unknown) => {
        productUpdateCalls.push(args);
        return {};
      },
    },
    review: {
      findFirst: async (args: FindFirstArgs): Promise<Row | null> => {
        findFirstCalls.push(args);
        return opts.existingReview ?? null;
      },
    },
    $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
  };

  return { prisma, createCalls, auditCalls, findFirstCalls, productFindCalls, productUpdateCalls };
}

/** Duck-typed Prisma `P2002` for the per-user-per-product unique index — the
 *  shape the DB raises when a row races past the app-level pre-check. */
function uniqueConstraintError(target: string[]) {
  const e = new Error(
    `Unique constraint failed on the fields: (${target.map((t) => `\`${t}\``).join(',')})`,
  ) as Error & { code: string; meta?: { target: string[] } };
  e.name = 'PrismaClientKnownRequestError';
  e.code = 'P2002';
  e.meta = { target };
  return e;
}

/** Mount the handler behind a middleware that injects a verified `auth`.
 *  `score` stands in for the Perspective call (default: a no-op → `null`, as a
 *  missing key would behave) so unit tests stay offline and deterministic. */
function appWith(
  prisma: unknown,
  auth: AuthzVariables['auth'] = { userId: USER_ID, role: 'reviewer' },
  score: (c: unknown, body: string) => Promise<number | null> = async () => null,
) {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.use('/api/reviews', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  app.post(
    '/api/reviews',
    createSubmitReviewHandler(() => prisma as never, score as never),
  );
  return app;
}

function post(
  app: Hono<{ Bindings: Env; Variables: AuthzVariables }>,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(
    '/api/reviews',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    { DD_API_KEY: undefined } as Env,
    // The 500 path runs `errorHandler()`, which reads `c.executionCtx`; provide a
    // stub so that branch doesn't throw "no ExecutionContext" in tests.
    executionCtxStub(),
  );
}

function executionCtxStub(): ExecutionContext {
  return { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as ExecutionContext;
}

describe('createSubmitReviewHandler', () => {
  it('inserts a pending review with the server-set reviewer_id and audit-logs it', async () => {
    const { prisma, createCalls, auditCalls, productUpdateCalls } = makeFakePrisma();
    const res = await post(appWith(prisma), validBody(), { 'x-aeci-locale': 'en-US' });

    expect(res.status).toBe(201);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({
      id: 'review-1',
      status: 'pending',
      message: expect.any(String),
    });

    expect(createCalls).toHaveLength(1);
    // status defaults to 'pending' (not set here); reviewer_id is the token sub.
    expect(createCalls[0]?.data).toMatchObject({
      productId: PRODUCT_ID,
      reviewerId: USER_ID,
      ratingOverall: 4,
      ratingOnboarding: 5,
      title: 'Solid Revit add-in',
      roleAtCompany: 'practitioner',
      yearsUsing: 3,
      wouldRecommend: 'yes',
      locale: 'en-US',
    });
    expect(createCalls[0]?.data).not.toHaveProperty('status');
    expect(createCalls[0]?.data).not.toHaveProperty('reviewer_id');

    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]?.data).toMatchObject({
      actorId: USER_ID,
      actorType: 'user',
      action: 'review.submitted',
      entityType: 'review',
      entityId: 'review-1',
      metadata: { source: 'review-form', product_id: PRODUCT_ID },
    });

    // Submit must NOT recompute the product's denormalized counters (5.13).
    expect(productUpdateCalls).toHaveLength(0);
  });

  it('falls back to en-US when the x-aeci-locale header is absent', async () => {
    const { prisma, createCalls } = makeFakePrisma();
    const res = await post(appWith(prisma), validBody());

    expect(res.status).toBe(201);
    expect(createCalls[0]?.data).toMatchObject({ locale: 'en-US' });
  });

  it('falls back to en-US for an unrecognized locale header', async () => {
    const { prisma, createCalls } = makeFakePrisma();
    const res = await post(appWith(prisma), validBody(), { 'x-aeci-locale': 'zz-ZZ' });

    expect(res.status).toBe(201);
    expect(createCalls[0]?.data).toMatchObject({ locale: 'en-US' });
  });

  it('omits optional fields the client left out (→ column NULL default)', async () => {
    const { prisma, createCalls } = makeFakePrisma();
    const body = validBody();
    delete body.role_at_company;
    delete body.years_using;
    delete body.would_recommend;
    const res = await post(appWith(prisma), body);

    expect(res.status).toBe(201);
    expect(createCalls[0]?.data).not.toHaveProperty('roleAtCompany');
    expect(createCalls[0]?.data).not.toHaveProperty('yearsUsing');
    expect(createCalls[0]?.data).not.toHaveProperty('wouldRecommend');
  });

  it('rejects a duplicate via the app-level pre-check with 409 REVIEW_DUPLICATE', async () => {
    const { prisma, createCalls, findFirstCalls } = makeFakePrisma({
      existingReview: { id: 'existing-1' },
    });
    const res = await post(appWith(prisma), validBody());

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ApiErrorCode.REVIEW_DUPLICATE,
    );
    // Pre-check excludes archived rows and never reaches the insert.
    expect(findFirstCalls[0]?.where).toMatchObject({
      productId: PRODUCT_ID,
      reviewerId: USER_ID,
      status: { not: 'archived' },
    });
    expect(createCalls).toHaveLength(0);
  });

  it('maps a unique-index race (P2002) to 409 REVIEW_DUPLICATE, not 500', async () => {
    const { prisma } = makeFakePrisma({
      createError: uniqueConstraintError(['product_id', 'reviewer_id']),
    });
    const res = await post(appWith(prisma), validBody());

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ApiErrorCode.REVIEW_DUPLICATE,
    );
  });

  it('rethrows an unrelated P2002 as a 500 (never mislabeled REVIEW_DUPLICATE)', async () => {
    const { prisma } = makeFakePrisma({
      createError: uniqueConstraintError(['some_other_column']),
    });
    const res = await post(appWith(prisma), validBody());

    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ApiErrorCode.INTERNAL_ERROR,
    );
  });

  it('returns 404 NOT_FOUND when the product does not exist', async () => {
    const { prisma, createCalls } = makeFakePrisma({ product: null });
    const res = await post(appWith(prisma), validBody());

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; details?: { resource?: string } } };
    expect(body.error.code).toBe(ApiErrorCode.NOT_FOUND);
    expect(body.error.details?.resource).toBe('product');
    expect(createCalls).toHaveLength(0);
  });

  it('returns 400 VALIDATION_FAILED for an out-of-range rating', async () => {
    const { prisma, createCalls } = makeFakePrisma();
    const res = await post(appWith(prisma), validBody({ rating_overall: 0 }));

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ApiErrorCode.VALIDATION_FAILED,
    );
    expect(createCalls).toHaveLength(0);
  });

  it('returns 400 VALIDATION_FAILED for a too-short title and too-short body', async () => {
    const { prisma } = makeFakePrisma();
    const res = await post(appWith(prisma), validBody({ title: 'no', body: 'too short' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 MALFORMED_REQUEST for non-JSON bodies', async () => {
    const { prisma } = makeFakePrisma();
    const res = await post(appWith(prisma), '{not json');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ApiErrorCode.MALFORMED_REQUEST,
    );
  });

  // ─── Toxicity scoring (AECI-198 / Phase 5.7) ────────────────────────────────

  it('persists the Perspective toxicity_score and records it in the audit metadata', async () => {
    const { prisma, createCalls, auditCalls } = makeFakePrisma();
    const score = async () => 92;
    const res = await post(appWith(prisma, undefined, score), validBody());

    expect(res.status).toBe(201);
    expect(createCalls[0]?.data).toMatchObject({ toxicityScore: 92 });
    expect(auditCalls[0]?.data).toMatchObject({
      metadata: { source: 'review-form', product_id: PRODUCT_ID, toxicity_score: 92 },
    });
  });

  it('stores toxicity_score=null and still saves the review when Perspective fails (outage)', async () => {
    const { prisma, createCalls } = makeFakePrisma();
    // Default `score` already resolves to null; assert the review is saved anyway.
    const res = await post(appWith(prisma), validBody());

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ status: 'pending' });
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.data).toMatchObject({ toxicityScore: null });
  });

  it('never auto-rejects: a max-toxicity score still yields a pending review with no score in the response', async () => {
    const { prisma } = makeFakePrisma();
    const score = async () => 100;
    const res = await post(appWith(prisma, undefined, score), validBody());

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('pending');
    // Admin-only: the score is never echoed in the public submit response.
    expect(body).not.toHaveProperty('toxicity_score');
    expect(body).not.toHaveProperty('toxicityScore');
  });
});

// ─── Integration: real requireAuth() in front of the real handler ─────────────

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

function integrationApp(profiles: Record<string, ProfileRow>, prisma: unknown) {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.post(
    '/api/reviews',
    requireAuth({
      getKey,
      getClient: () => authProfileClient(profiles),
      bannedCode: ApiErrorCode.REVIEW_BANNED,
    }),
    createSubmitReviewHandler(() => prisma as never),
  );
  return app;
}

describe('POST /api/reviews (with requireAuth middleware)', () => {
  const ENV = { SUPABASE_URL, DD_API_KEY: undefined } as Env;

  it('rejects a banned reviewer with 403 REVIEW_BANNED before any insert', async () => {
    const { prisma, createCalls } = makeFakePrisma();
    const app = integrationApp(
      { 'user-banned': { role: 'reviewer', bannedAt: new Date(), banReason: 'Spam reviews' } },
      prisma,
    );
    const token = await mintToken('user-banned');
    const res = await app.request(
      '/api/reviews',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody()),
      },
      ENV,
    );

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ApiErrorCode.REVIEW_BANNED,
    );
    expect(createCalls).toHaveLength(0);
  });

  it('accepts a verified reviewer end-to-end and sets reviewer_id from the token sub', async () => {
    const { prisma, createCalls } = makeFakePrisma();
    const app = integrationApp(
      { 'user-ok': { role: 'reviewer', bannedAt: null, banReason: null } },
      prisma,
    );
    const token = await mintToken('user-ok');
    const res = await app.request(
      '/api/reviews',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody()),
      },
      ENV,
    );

    expect(res.status).toBe(201);
    expect(createCalls[0]?.data).toMatchObject({ reviewerId: 'user-ok' });
  });

  it('rejects a missing token with 401 UNAUTHENTICATED', async () => {
    const { prisma } = makeFakePrisma();
    const app = integrationApp(
      { 'user-ok': { role: 'reviewer', bannedAt: null, banReason: null } },
      prisma,
    );
    const res = await app.request(
      '/api/reviews',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody()),
      },
      ENV,
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ApiErrorCode.UNAUTHENTICATED,
    );
  });
});
