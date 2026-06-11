/**
 * Unit coverage for `GET` / `PATCH` / `DELETE /api/account` (AECI-202 / Phase
 * 5.11). The handlers are exercised in isolation (mirroring `reviews.spec.ts`):
 * a middleware injects the `auth` Variable that `requireAuth()` would, and a
 * fake Prisma surface stands in for the accelerated client.
 *
 * The DELETE cases pin the erasure contract: every inbound FK to `profiles` is
 * nulled (reviews ANONYMIZED, not deleted), the `account.deleted` audit row
 * carries NO PII and a null `actorId`, the profile is deleted, and `auth.users`
 * is deleted via raw SQL — all inside one transaction.
 *
 * One integration block wires the REAL `requireAuth()` (offline ES256 JWKS via
 * the `getKey` seam) to pin the 401 UNAUTHENTICATED path the sub-router uses.
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
import {
  createDeleteAccountHandler,
  createGetAccountHandler,
  createUpdateAccountHandler,
} from './account';

const USER_ID = '99999999-9999-4999-8999-999999999999';
const USER_EMAIL = 'reviewer@example.com';

type UpdateManyCall = { where: Record<string, unknown>; data: Record<string, unknown> };
type AuditCall = { data: Record<string, unknown> };
type RawCall = { sql: string; values: unknown[] };

/**
 * Fake Prisma surface covering all three handlers. Records every mutation so the
 * erasure ordering / completeness can be asserted. `displayName` seeds the GET /
 * PATCH `findUnique`.
 */
function makeFakePrisma(opts: { displayName?: string | null } = {}) {
  const updateManyByModel: Record<string, UpdateManyCall[]> = {
    review: [],
    vendorRequest: [],
    workflowInstance: [],
    workflowTransition: [],
    auditLog: [],
    pageView: [],
  };
  const auditCreateCalls: AuditCall[] = [];
  const profileDeleteCalls: { where: { id: string } }[] = [];
  const profileUpdateCalls: { where: { id: string }; data: { displayName: string | null } }[] = [];
  const rawCalls: RawCall[] = [];

  const seeded: { displayName: string | null } = { displayName: opts.displayName ?? null };

  const updateMany = (model: keyof typeof updateManyByModel) => async (args: UpdateManyCall) => {
    updateManyByModel[model].push(args);
    return { count: 0 };
  };

  const tx = {
    profile: {
      findUnique: async (_args: { where: { id: string }; select: { displayName: true } }) => ({
        displayName: seeded.displayName,
      }),
      update: async (args: {
        where: { id: string };
        data: { displayName: string | null };
        select: { displayName: true };
      }) => {
        profileUpdateCalls.push({ where: args.where, data: args.data });
        seeded.displayName = args.data.displayName;
        return { displayName: args.data.displayName };
      },
      delete: async (args: { where: { id: string } }) => {
        profileDeleteCalls.push(args);
        return {};
      },
    },
    review: { updateMany: updateMany('review') },
    vendorRequest: { updateMany: updateMany('vendorRequest') },
    workflowInstance: { updateMany: updateMany('workflowInstance') },
    workflowTransition: { updateMany: updateMany('workflowTransition') },
    auditLog: {
      updateMany: updateMany('auditLog'),
      create: async (args: AuditCall) => {
        auditCreateCalls.push(args);
        return {};
      },
    },
    pageView: { updateMany: updateMany('pageView') },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      rawCalls.push({ sql: strings.join('?'), values });
      return 1;
    },
  };

  const prisma = {
    profile: {
      findUnique: async (_args: { where: { id: string }; select: { displayName: true } }) => ({
        displayName: seeded.displayName,
      }),
    },
    $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
  };

  return {
    prisma,
    updateManyByModel,
    auditCreateCalls,
    profileDeleteCalls,
    profileUpdateCalls,
    rawCalls,
  };
}

function executionCtxStub(): ExecutionContext {
  return { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as ExecutionContext;
}

type Handler = (c: never) => Promise<Response>;

/** Mount a handler behind a middleware that injects a verified `auth`. */
function appWith(
  path: string,
  method: 'get' | 'patch' | 'delete',
  handler: Handler,
  auth: AuthzVariables['auth'] = { userId: USER_ID, email: USER_EMAIL, role: 'reviewer' },
) {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.use(path, async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  app[method](path, handler as never);
  return app;
}

function call(
  app: Hono<{ Bindings: Env; Variables: AuthzVariables }>,
  method: string,
  body?: unknown,
) {
  return app.request(
    '/api/account',
    {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    },
    { DD_API_KEY: undefined } as Env,
    executionCtxStub(),
  );
}

// ─── GET ───────────────────────────────────────────────────────────────────────

describe('createGetAccountHandler', () => {
  it('returns the session email (read-only) and the profile display name', async () => {
    const { prisma } = makeFakePrisma({ displayName: 'Dana Reviewer' });
    const app = appWith(
      '/api/account',
      'get',
      createGetAccountHandler(() => prisma as never),
    );
    const res = await call(app, 'GET');

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({
      user_id: USER_ID,
      email: USER_EMAIL,
      display_name: 'Dana Reviewer',
    });
  });

  it('returns display_name: null when the profile has none', async () => {
    const { prisma } = makeFakePrisma({ displayName: null });
    const app = appWith(
      '/api/account',
      'get',
      createGetAccountHandler(() => prisma as never),
    );
    const res = await call(app, 'GET');
    expect(((await res.json()) as { display_name: unknown }).display_name).toBeNull();
  });
});

// ─── PATCH ─────────────────────────────────────────────────────────────────────

describe('createUpdateAccountHandler', () => {
  it('updates display_name and audits profile.updated with before/after', async () => {
    const { prisma, profileUpdateCalls, auditCreateCalls } = makeFakePrisma({
      displayName: 'Old Name',
    });
    const app = appWith(
      '/api/account',
      'patch',
      createUpdateAccountHandler(() => prisma as never),
    );
    const res = await call(app, 'PATCH', { display_name: 'New Name' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user_id: USER_ID,
      email: USER_EMAIL,
      display_name: 'New Name',
    });
    expect(profileUpdateCalls).toHaveLength(1);
    expect(profileUpdateCalls[0]).toMatchObject({
      where: { id: USER_ID },
      data: { displayName: 'New Name' },
    });
    expect(auditCreateCalls).toHaveLength(1);
    expect(auditCreateCalls[0]?.data).toMatchObject({
      actorId: USER_ID,
      actorType: 'user',
      action: 'profile.updated',
      entityType: 'profile',
      entityId: USER_ID,
      beforeState: { display_name: 'Old Name' },
      afterState: { display_name: 'New Name' },
    });
  });

  it('accepts an explicit null to clear the display name', async () => {
    const { prisma, profileUpdateCalls } = makeFakePrisma({ displayName: 'Some Name' });
    const app = appWith(
      '/api/account',
      'patch',
      createUpdateAccountHandler(() => prisma as never),
    );
    const res = await call(app, 'PATCH', { display_name: null });

    expect(res.status).toBe(200);
    expect(profileUpdateCalls[0]?.data).toEqual({ displayName: null });
  });

  it('rejects an over-long display name with 400 VALIDATION_FAILED', async () => {
    const { prisma, profileUpdateCalls } = makeFakePrisma();
    const app = appWith(
      '/api/account',
      'patch',
      createUpdateAccountHandler(() => prisma as never),
    );
    const res = await call(app, 'PATCH', { display_name: 'x'.repeat(81) });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ApiErrorCode.VALIDATION_FAILED,
    );
    expect(profileUpdateCalls).toHaveLength(0);
  });

  it('returns 400 MALFORMED_REQUEST for a non-JSON body', async () => {
    const { prisma } = makeFakePrisma();
    const app = appWith(
      '/api/account',
      'patch',
      createUpdateAccountHandler(() => prisma as never),
    );
    const res = await call(app, 'PATCH', '{not json');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ApiErrorCode.MALFORMED_REQUEST,
    );
  });
});

// ─── DELETE (GDPR erasure) ─────────────────────────────────────────────────────

describe('createDeleteAccountHandler', () => {
  it('anonymizes/severs every inbound FK, deletes the profile, then deletes auth.users', async () => {
    const { prisma, updateManyByModel, profileDeleteCalls, rawCalls } = makeFakePrisma();
    const app = appWith(
      '/api/account',
      'delete',
      createDeleteAccountHandler(() => prisma as never),
    );
    const res = await call(app, 'DELETE');

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ message: expect.any(String) });

    // Reviews are ANONYMIZED (reviewer_id → null), never deleted. Two review
    // updateMany calls: reviewer_id and moderated_by.
    const reviewerUpdate = updateManyByModel.review.find((c) => 'reviewerId' in c.where);
    expect(reviewerUpdate).toMatchObject({
      where: { reviewerId: USER_ID },
      data: { reviewerId: null },
    });
    expect(updateManyByModel.review).toContainEqual({
      where: { moderatedBy: USER_ID },
      data: { moderatedBy: null },
    });

    // The other NO ACTION references are all nulled.
    expect(updateManyByModel.vendorRequest).toContainEqual({
      where: { resolvedById: USER_ID },
      data: { resolvedById: null },
    });
    expect(updateManyByModel.workflowInstance).toContainEqual({
      where: { initiatedBy: USER_ID },
      data: { initiatedBy: null },
    });
    expect(updateManyByModel.workflowTransition).toContainEqual({
      where: { actorId: USER_ID },
      data: { actorId: null },
    });
    expect(updateManyByModel.auditLog).toContainEqual({
      where: { actorId: USER_ID },
      data: { actorId: null },
    });
    expect(updateManyByModel.pageView).toContainEqual({
      where: { userId: USER_ID },
      data: { userId: null },
    });

    // Profile deleted.
    expect(profileDeleteCalls).toEqual([{ where: { id: USER_ID } }]);

    // auth.users deleted via raw SQL, exactly once, parameterized with the user id.
    expect(rawCalls).toHaveLength(1);
    expect(rawCalls[0]?.sql).toContain('DELETE FROM auth.users');
    expect(rawCalls[0]?.values).toEqual([USER_ID]);
  });

  it('writes an account.deleted audit row with a null actor and NO PII', async () => {
    const { prisma, auditCreateCalls } = makeFakePrisma();
    const app = appWith(
      '/api/account',
      'delete',
      createDeleteAccountHandler(() => prisma as never),
    );
    await call(app, 'DELETE');

    expect(auditCreateCalls).toHaveLength(1);
    const data = auditCreateCalls[0]?.data ?? {};
    expect(data).toMatchObject({
      actorId: null,
      actorType: 'user',
      action: 'account.deleted',
      entityType: 'profile',
      entityId: USER_ID,
    });
    // No PII anywhere in the persisted row: the email must never appear.
    expect(JSON.stringify(data)).not.toContain(USER_EMAIL);
  });

  it('records actorType "admin" when an admin deletes their own account', async () => {
    const { prisma, auditCreateCalls } = makeFakePrisma();
    const app = appWith(
      '/api/account',
      'delete',
      createDeleteAccountHandler(() => prisma as never),
      {
        userId: USER_ID,
        email: USER_EMAIL,
        role: 'admin',
      },
    );
    await call(app, 'DELETE');
    expect(auditCreateCalls[0]?.data).toMatchObject({ actorType: 'admin' });
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
    profile: { findUnique: ({ where }) => Promise.resolve(profiles[where.id] ?? null) },
  };
}

describe('DELETE /api/account (with requireAuth middleware)', () => {
  const ENV = { SUPABASE_URL, DD_API_KEY: undefined } as Env;

  it('rejects a missing token with 401 UNAUTHENTICATED before any write', async () => {
    const { prisma, profileDeleteCalls } = makeFakePrisma();
    const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    app.onError(errorHandler());
    app.delete(
      '/api/account',
      requireAuth({ getKey, getClient: () => authProfileClient({}) }),
      createDeleteAccountHandler(() => prisma as never),
    );
    const res = await app.request('/api/account', { method: 'DELETE' }, ENV);

    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ApiErrorCode.UNAUTHENTICATED,
    );
    expect(profileDeleteCalls).toHaveLength(0);
  });

  it('blocks a banned user at requireAuth (403) before any write (erasure-for-banned out of scope)', async () => {
    const { prisma, profileDeleteCalls, rawCalls } = makeFakePrisma();
    const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    app.onError(errorHandler());
    app.delete(
      '/api/account',
      requireAuth({
        getKey,
        getClient: () =>
          authProfileClient({
            'user-banned': { role: 'reviewer', bannedAt: new Date(), banReason: 'Spam' },
          }),
      }),
      createDeleteAccountHandler(() => prisma as never),
    );
    const token = await mintToken('user-banned');
    const res = await app.request(
      '/api/account',
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      ENV,
    );

    // `requireAuth()` 403s a banned user before the handler runs, so no erasure
    // happens. AECI-202 accepts this (AC scopes errors to UNAUTHENTICATED); a
    // ban-bypassing erasure path would need an `allowBanned` middleware seam.
    expect(res.status).toBe(403);
    expect(profileDeleteCalls).toHaveLength(0);
    expect(rawCalls).toHaveLength(0);
  });
});
