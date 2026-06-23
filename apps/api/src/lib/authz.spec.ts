/**
 * Unit coverage for the Phase 5.5 authz middleware (AECI-196), on the Drizzle/D1
 * path (ADR 0016 / AECI-254). A locally-generated ES256 keypair stands in for the
 * Supabase JWKS via the `getKey` seam, tokens are minted with `SignJWT`, and the
 * profile lookup runs against the in-memory D1 harness (seeded `profiles` rows),
 * injected via the `dbFor` seam. Covers the AC matrix: no token → 401, invalid →
 * 401, missing profile → 401, banned → 403 (FORBIDDEN / REVIEW_BANNED), non-admin
 * on an admin route → 403, uid+role threading, cookie-path extraction, and that
 * the DB is never touched before the JWT verifies (via a `dbFor` call counter).
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
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { profiles } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  auditActorType,
  extractSessionCookieToken,
  requireAdmin,
  requireAuth,
  type AuthzOptions,
  type AuthzVariables,
} from './authz';
import type { DbFactory } from './handler-utils';

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

type SignOptions = {
  sub?: string;
  email?: string;
  expiresIn?: string;
};

async function mintToken(opts: SignOptions = {}): Promise<string> {
  const payload: Record<string, unknown> = { sub: opts.sub ?? 'user-123' };
  if (opts.email !== undefined) payload.email = opts.email;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setExpirationTime(opts.expiresIn ?? '1h')
    .sign(privateKey);
}

/** Per-test in-memory D1 + a `dbFor` counter (proves the DB is untouched until
 *  the JWT verifies). Reset in `beforeEach`. */
let t: TestDb;
let dbCalls: number;
const dbFor: DbFactory = (env, bookmark) => {
  dbCalls++;
  return t.factory(env, bookmark);
};

beforeEach(async () => {
  t = await makeTestDb();
  dbCalls = 0;
});
afterEach(() => t.dispose());

type ProfileSeed = { role?: string; bannedAt?: string | null; banReason?: string | null };

/** Seed one `profiles` row keyed by `id` (the verified token `sub`). */
async function seedProfile(id: string, seed: ProfileSeed = {}): Promise<void> {
  await t.db.insert(profiles).values({ id, ...seed });
}

const REVIEWER: ProfileSeed = { role: 'reviewer' };
const ADMIN: ProfileSeed = { role: 'admin' };
const BANNED: ProfileSeed = {
  role: 'reviewer',
  bannedAt: '2026-06-01T00:00:00.000Z',
  banReason: 'Spam reviews',
};

/**
 * Tiny app mounting both guard variants the way the Phase 5.6+ routers will:
 * `POST /api/reviews` behind `requireAuth({ bannedCode: REVIEW_BANNED })`,
 * `DELETE /api/account` behind plain `requireAuth()`, and
 * `PATCH /api/admin/reviews/:id` behind `requireAdmin()`. Each handler echoes
 * `c.get('auth')` so threading is observable. The reviews handler also echoes
 * a client-supplied `reviewer_id` body field next to the server-set value to
 * pin the "client can never supply it" contract. The profile lookup runs against
 * the harness via the `dbFor` seam.
 */
function makeApp() {
  const options: AuthzOptions = { getKey, dbFor };
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.post(
    '/api/reviews',
    requireAuth({ ...options, bannedCode: ApiErrorCode.REVIEW_BANNED }),
    async (c) => {
      const auth = c.get('auth');
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      // The §4.5 contract: reviewer_id comes from the verified session,
      // regardless of what the client sent.
      return c.json({ auth, reviewerId: auth.userId, clientSent: body['reviewer_id'] ?? null });
    },
  );
  app.delete('/api/account', requireAuth(options), (c) => c.json({ auth: c.get('auth') }));
  app.patch('/api/admin/reviews/:id', requireAdmin(options), (c) =>
    c.json({ auth: c.get('auth') }),
  );
  return app;
}

const ENV = { SUPABASE_URL } as Env;

type CallResult = {
  status: number;
  body: {
    error?: { code: string; message?: string };
    auth?: { userId: string; email?: string; role: string };
    reviewerId?: string;
    clientSent?: unknown;
  };
};

async function call(
  app: Hono<{ Bindings: Env; Variables: AuthzVariables }>,
  path: string,
  method: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<CallResult> {
  const res = await app.request(path, { method, headers, body }, ENV);
  return { status: res.status, body: (await res.json()) as CallResult['body'] };
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** Encode a session object the way `@supabase/ssr` writes its cookie value. */
function encodeSessionCookie(session: Record<string, unknown>): string {
  const b64 = btoa(JSON.stringify(session))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `base64-${b64}`;
}

describe('requireAuth', () => {
  it('rejects a missing token with 401 UNAUTHENTICATED and never touches the DB', async () => {
    await seedProfile('user-123', REVIEWER);
    const { status, body } = await call(makeApp(), '/api/account', 'DELETE');
    expect(status).toBe(401);
    expect(body.error?.code).toBe(ApiErrorCode.UNAUTHENTICATED);
    expect(dbCalls).toBe(0);
  });

  it('rejects an invalid token with 401 and never touches the DB', async () => {
    await seedProfile('user-123', REVIEWER);
    const { status, body } = await call(makeApp(), '/api/account', 'DELETE', bearer('not-a-jwt'));
    expect(status).toBe(401);
    expect(body.error?.code).toBe(ApiErrorCode.UNAUTHENTICATED);
    expect(dbCalls).toBe(0);
  });

  it('rejects an expired token with 401', async () => {
    await seedProfile('user-123', REVIEWER);
    const token = await mintToken({ expiresIn: '-1h' });
    const { status } = await call(makeApp(), '/api/account', 'DELETE', bearer(token));
    expect(status).toBe(401);
  });

  it('rejects a verified token whose profile row is missing with 401', async () => {
    const token = await mintToken({ sub: 'user-ghost' });
    const { status, body } = await call(makeApp(), '/api/account', 'DELETE', bearer(token));
    expect(status).toBe(401);
    expect(body.error?.code).toBe(ApiErrorCode.UNAUTHENTICATED);
    expect(dbCalls).toBe(1); // the DB WAS queried (after verify) and returned no row
  });

  it('rejects a banned user with 403 FORBIDDEN (default) and surfaces the ban reason', async () => {
    await seedProfile('user-banned', BANNED);
    const token = await mintToken({ sub: 'user-banned' });
    const { status, body } = await call(makeApp(), '/api/account', 'DELETE', bearer(token));
    expect(status).toBe(403);
    expect(body.error?.code).toBe(ApiErrorCode.FORBIDDEN);
    expect(body.error?.message).toBe('Spam reviews');
  });

  it('rejects a banned user with 403 REVIEW_BANNED on a review write', async () => {
    await seedProfile('user-banned', BANNED);
    const token = await mintToken({ sub: 'user-banned' });
    const { status, body } = await call(makeApp(), '/api/reviews', 'POST', bearer(token));
    expect(status).toBe(403);
    expect(body.error?.code).toBe(ApiErrorCode.REVIEW_BANNED);
  });

  it('threads the verified uid, email, and DB role to the handler', async () => {
    await seedProfile('user-abc', REVIEWER);
    const token = await mintToken({ sub: 'user-abc', email: 'a@example.com' });
    const { status, body } = await call(makeApp(), '/api/account', 'DELETE', bearer(token));
    expect(status).toBe(200);
    expect(body.auth).toEqual({ userId: 'user-abc', email: 'a@example.com', role: 'reviewer' });
    expect(dbCalls).toBe(1);
  });

  it('server-sets reviewer_id from the verified uid, ignoring the client-supplied value', async () => {
    await seedProfile('user-abc', REVIEWER);
    const token = await mintToken({ sub: 'user-abc' });
    const { status, body } = await call(
      makeApp(),
      '/api/reviews',
      'POST',
      { ...bearer(token), 'Content-Type': 'application/json' },
      JSON.stringify({ reviewer_id: 'user-evil' }),
    );
    expect(status).toBe(200);
    expect(body.reviewerId).toBe('user-abc');
    expect(body.clientSent).toBe('user-evil');
  });

  it('accepts the session via an sb-*-auth-token cookie (verified, not trusted)', async () => {
    await seedProfile('user-abc', REVIEWER);
    const token = await mintToken({ sub: 'user-abc' });
    const cookie = `sb-test-project-auth-token=${encodeSessionCookie({ access_token: token })}`;
    const { status, body } = await call(makeApp(), '/api/account', 'DELETE', { Cookie: cookie });
    expect(status).toBe(200);
    expect(body.auth?.userId).toBe('user-abc');
  });

  it('reassembles a chunked session cookie', async () => {
    await seedProfile('user-abc', REVIEWER);
    const token = await mintToken({ sub: 'user-abc' });
    const encoded = encodeSessionCookie({ access_token: token, padding: 'x'.repeat(64) });
    const mid = Math.floor(encoded.length / 2);
    const cookie = [
      `sb-test-project-auth-token.0=${encoded.slice(0, mid)}`,
      `sb-test-project-auth-token.1=${encoded.slice(mid)}`,
    ].join('; ');
    const { status, body } = await call(makeApp(), '/api/account', 'DELETE', { Cookie: cookie });
    expect(status).toBe(200);
    expect(body.auth?.userId).toBe('user-abc');
  });

  it('rejects an invalid cookie session token with 401', async () => {
    await seedProfile('user-abc', REVIEWER);
    const cookie = `sb-test-project-auth-token=${encodeSessionCookie({ access_token: 'garbage' })}`;
    const { status } = await call(makeApp(), '/api/account', 'DELETE', { Cookie: cookie });
    expect(status).toBe(401);
  });

  it('does not fall back to the cookie when a bearer token is present but invalid', async () => {
    await seedProfile('user-abc', REVIEWER);
    const token = await mintToken({ sub: 'user-abc' });
    const cookie = `sb-test-project-auth-token=${encodeSessionCookie({ access_token: token })}`;
    const { status } = await call(makeApp(), '/api/account', 'DELETE', {
      ...bearer('not-a-jwt'),
      Cookie: cookie,
    });
    expect(status).toBe(401);
  });
});

describe('requireAdmin', () => {
  it('rejects a non-admin with 403 FORBIDDEN', async () => {
    await seedProfile('user-abc', REVIEWER);
    const token = await mintToken({ sub: 'user-abc' });
    const { status, body } = await call(makeApp(), '/api/admin/reviews/r1', 'PATCH', bearer(token));
    expect(status).toBe(403);
    expect(body.error?.code).toBe(ApiErrorCode.FORBIDDEN);
  });

  it('rejects a banned admin with 403 before the role grants access', async () => {
    await seedProfile('user-banned-admin', {
      ...ADMIN,
      bannedAt: '2026-06-01T00:00:00.000Z',
      banReason: null,
    });
    const token = await mintToken({ sub: 'user-banned-admin' });
    const { status } = await call(makeApp(), '/api/admin/reviews/r1', 'PATCH', bearer(token));
    expect(status).toBe(403);
  });

  it('rejects a missing token with 401', async () => {
    await seedProfile('user-admin', ADMIN);
    const { status } = await call(makeApp(), '/api/admin/reviews/r1', 'PATCH');
    expect(status).toBe(401);
  });

  it('accepts an admin and threads the session', async () => {
    await seedProfile('user-admin', ADMIN);
    const token = await mintToken({ sub: 'user-admin' });
    const { status, body } = await call(makeApp(), '/api/admin/reviews/r1', 'PATCH', bearer(token));
    expect(status).toBe(200);
    expect(body.auth).toEqual({ userId: 'user-admin', email: undefined, role: 'admin' });
  });
});

describe('extractSessionCookieToken', () => {
  it('returns null when no session cookie is present', () => {
    expect(extractSessionCookieToken({ theme: 'dark', other: 'x' })).toBeNull();
  });

  it('returns null for an unparseable cookie value', () => {
    expect(extractSessionCookieToken({ 'sb-ref-auth-token': 'base64-!!!notbase64' })).toBeNull();
    expect(extractSessionCookieToken({ 'sb-ref-auth-token': 'not-json' })).toBeNull();
  });

  it('returns null when the session JSON has no access_token', () => {
    const value = encodeSessionCookie({ refresh_token: 'r' });
    expect(extractSessionCookieToken({ 'sb-ref-auth-token': value })).toBeNull();
  });

  it('parses a raw-JSON (non-base64) cookie value', () => {
    const value = JSON.stringify({ access_token: 'tok' });
    expect(extractSessionCookieToken({ 'sb-ref-auth-token': value })).toBe('tok');
  });

  it('orders chunks numerically (10 after 2)', () => {
    const encoded = encodeSessionCookie({ access_token: 'tok', pad: 'y'.repeat(300) });
    const size = Math.ceil(encoded.length / 11);
    const cookies: Record<string, string> = {};
    for (let i = 0; i < 11; i++) {
      cookies[`sb-ref-auth-token.${i}`] = encoded.slice(i * size, (i + 1) * size);
    }
    expect(extractSessionCookieToken(cookies)).toBe('tok');
  });
});

describe('auditActorType', () => {
  it('maps admin → admin and everything else → user', () => {
    expect(auditActorType({ role: 'admin' })).toBe('admin');
    expect(auditActorType({ role: 'reviewer' })).toBe('user');
    expect(auditActorType({ role: 'vendor' })).toBe('user');
  });
});
