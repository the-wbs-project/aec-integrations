/**
 * Coverage for `GET /api/admin/summary` (AECI-203 / Phase 5.12).
 *
 * Two layers:
 *   1. Handler unit — `createAdminSummaryHandler` over a fake Prisma: the count
 *      query shape (`{ where: { status: 'pending' } }`) and the bare wire shape
 *      (`{ pending_reviews }`, no envelope) the SSR client reads verbatim.
 *   2. Integration — the handler behind the real `requireAdmin()` middleware
 *      (offline JWKS via the `getKey` seam + a fake profile client via
 *      `getClient`, mirroring `lib/authz.spec.ts`): the AC gate matrix —
 *      no token → 401, reviewer → 403, banned → 403, admin → 200.
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
import {
  requireAdmin,
  type AuthzOptions,
  type AuthzProfileClient,
  type AuthzVariables,
} from '../lib/authz';
import { createAdminSummaryHandler } from './admin-summary';

const SUPABASE_URL = 'https://test-project.supabase.co';
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const ENV = { SUPABASE_URL } as Env;

let privateKey: CryptoKey;
let getKey: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey as CryptoKey;
  const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'ES256' };
  getKey = createLocalJWKSet({ keys: [publicJwk] });
});

function mintToken(sub = 'user-123'): Promise<string> {
  return new SignJWT({ sub })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setExpirationTime('1h')
    .sign(privateKey);
}

type ProfileRow = { role: string; bannedAt: Date | null; banReason: string | null };

function fakeProfileClient(profiles: Record<string, ProfileRow>): AuthzProfileClient {
  return {
    profile: {
      findUnique: ({ where }) => Promise.resolve(profiles[where.id] ?? null),
    },
  };
}

/** Fake Prisma surface for the count, recording the `where` it was called with. */
function fakePrisma(count: number): {
  prisma: unknown;
  calls: { where: { status: string } }[];
} {
  const calls: { where: { status: string } }[] = [];
  const prisma = {
    review: {
      count: (args: { where: { status: string } }) => {
        calls.push(args);
        return Promise.resolve(count);
      },
    },
  };
  return { prisma, calls };
}

const ADMIN: ProfileRow = { role: 'admin', bannedAt: null, banReason: null };
const REVIEWER: ProfileRow = { role: 'reviewer', bannedAt: null, banReason: null };
const BANNED_ADMIN: ProfileRow = {
  role: 'admin',
  bannedAt: new Date('2026-06-01T00:00:00Z'),
  banReason: 'Suspended',
};

describe('createAdminSummaryHandler (unit)', () => {
  it('counts pending reviews and returns the bare { pending_reviews } shape', async () => {
    const { prisma, calls } = fakePrisma(7);
    const handler = createAdminSummaryHandler(() => prisma as never);
    const c = { env: ENV } as Parameters<ReturnType<typeof createAdminSummaryHandler>>[0];

    const res = await handler(c);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pending_reviews: 7 });
    expect(calls).toEqual([{ where: { status: 'pending' } }]);
  });
});

describe('GET /api/admin/summary (gated by requireAdmin)', () => {
  function makeApp(profiles: Record<string, ProfileRow>, count = 3) {
    const options: AuthzOptions = { getKey, getClient: () => fakeProfileClient(profiles) };
    const { prisma } = fakePrisma(count);
    const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    app.onError(errorHandler());
    app.get(
      '/api/admin/summary',
      requireAdmin(options),
      createAdminSummaryHandler(() => prisma as never),
    );
    return app;
  }

  async function get(app: ReturnType<typeof makeApp>, headers: Record<string, string> = {}) {
    const res = await app.request('/api/admin/summary', { method: 'GET', headers }, ENV);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('rejects an anonymous request with 401 UNAUTHENTICATED', async () => {
    const { status, body } = await get(makeApp({ 'user-123': ADMIN }));
    expect(status).toBe(401);
    expect((body.error as { code?: string })?.code).toBe(ApiErrorCode.UNAUTHENTICATED);
  });

  it('rejects a reviewer (non-admin) with 403 FORBIDDEN', async () => {
    const app = makeApp({ 'user-123': REVIEWER });
    const { status, body } = await get(app, { Authorization: `Bearer ${await mintToken()}` });
    expect(status).toBe(403);
    expect((body.error as { code?: string })?.code).toBe(ApiErrorCode.FORBIDDEN);
  });

  it('rejects a banned admin with 403 before the handler runs', async () => {
    const app = makeApp({ 'user-123': BANNED_ADMIN });
    const { status, body } = await get(app, { Authorization: `Bearer ${await mintToken()}` });
    expect(status).toBe(403);
    expect((body.error as { code?: string })?.code).toBe(ApiErrorCode.FORBIDDEN);
  });

  it('returns 200 with the pending count for an admin', async () => {
    const app = makeApp({ 'user-123': ADMIN }, 12);
    const { status, body } = await get(app, { Authorization: `Bearer ${await mintToken()}` });
    expect(status).toBe(200);
    expect(body).toEqual({ pending_reviews: 12 });
  });
});
