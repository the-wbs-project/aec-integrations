/**
 * Offline unit coverage for `requireUserAuth()` (AECI-193). No network: a
 * locally-generated ES256 keypair stands in for the Supabase JWKS, injected
 * via the `getKey` seam (`createLocalJWKSet`), and tokens are minted with
 * `SignJWT`. Asserts the fail-closed 401 envelope for every rejection path and
 * the resolved `{ userId, email }` on success.
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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../env';
import { errorHandler } from '../errors';
import { logToPosthog } from '../posthog';
import { createAuthWhoamiHandler } from '../routes/auth-whoami';
import { requireUserAuth, type UserAuthVariables } from './user-auth';

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
  sub?: string | null;
  email?: string;
  issuer?: string;
  audience?: string;
  expiresIn?: string;
  alg?: string;
};

async function mintToken(opts: SignOptions = {}): Promise<string> {
  const { sub = 'user-123', email, issuer = ISSUER, audience = 'authenticated' } = opts;
  const payload: Record<string, unknown> = {};
  if (sub !== null) payload.sub = sub;
  if (email !== undefined) payload.email = email;
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: opts.alg ?? 'ES256', kid: 'test-key' })
    .setIssuedAt()
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime(opts.expiresIn ?? '1h');
  return jwt.sign(privateKey);
}

/** Build a tiny app mirroring the production auth-spike sub-router. */
function makeApp(env: Partial<Env> = {}): { app: Hono; env: Env } {
  const app = new Hono<{ Bindings: Env; Variables: UserAuthVariables }>();
  app.onError(errorHandler());
  app.get('/api/auth/whoami', requireUserAuth({ getKey }), createAuthWhoamiHandler());
  const fullEnv = { SUPABASE_URL, ...env } as Env;
  return { app: app as unknown as Hono, env: fullEnv };
}

async function call(
  env: Partial<Env>,
  headers: Record<string, string>,
): Promise<{
  status: number;
  body: { error?: { code: string }; userId?: string; email?: string };
}> {
  const { app, env: fullEnv } = makeApp(env);
  const res = await app.request('/api/auth/whoami', { headers }, fullEnv);
  return { status: res.status, body: await res.json() };
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe('requireUserAuth', () => {
  it('rejects a missing Authorization header with the 401 envelope', async () => {
    const { status, body } = await call({}, {});
    expect(status).toBe(401);
    expect(body.error?.code).toBe(ApiErrorCode.UNAUTHENTICATED);
  });

  it('rejects a non-Bearer scheme', async () => {
    const token = await mintToken();
    const { status, body } = await call({}, { Authorization: `Basic ${token}` });
    expect(status).toBe(401);
    expect(body.error?.code).toBe(ApiErrorCode.UNAUTHENTICATED);
  });

  it('rejects a garbage token', async () => {
    const { status } = await call({}, bearer('not-a-jwt'));
    expect(status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const token = await mintToken({ expiresIn: '-1h' });
    const { status } = await call({}, bearer(token));
    expect(status).toBe(401);
  });

  it('rejects a wrong issuer', async () => {
    const token = await mintToken({ issuer: 'https://evil.example.com/auth/v1' });
    const { status } = await call({}, bearer(token));
    expect(status).toBe(401);
  });

  it('rejects a wrong audience', async () => {
    const token = await mintToken({ audience: 'anon' });
    const { status } = await call({}, bearer(token));
    expect(status).toBe(401);
  });

  it('rejects a token with no sub claim', async () => {
    const token = await mintToken({ sub: null });
    const { status } = await call({}, bearer(token));
    expect(status).toBe(401);
  });

  it('rejects when SUPABASE_URL is unset (fail closed)', async () => {
    const token = await mintToken();
    const { app } = makeApp();
    const res = await app.request('/api/auth/whoami', { headers: bearer(token) }, {
      // SUPABASE_URL deliberately omitted
    } as Env);
    expect(res.status).toBe(401);
  });

  it('accepts a valid token and resolves { userId, email }', async () => {
    const token = await mintToken({ sub: 'user-abc', email: 'a@example.com' });
    const { status, body } = await call({}, bearer(token));
    expect(status).toBe(200);
    expect(body.userId).toBe('user-abc');
    expect(body.email).toBe('a@example.com');
  });

  it('accepts a valid token with no email (email undefined)', async () => {
    const token = await mintToken({ sub: 'user-def' });
    const { status, body } = await call({}, bearer(token));
    expect(status).toBe(200);
    expect(body.userId).toBe('user-def');
    expect(body.email).toBeUndefined();
  });
});
/**
 * AECI-644 / §AW3 — `requireUserAuth()` is the second (and only other) place in
 * this Worker where a genuine Supabase user id exists, so it registers the id
 * for `posthogDistinctId` exactly like `lib/authz.ts` does. Real transport,
 * stubbed fetch: the point is that the attribute reaches the wire.
 */
describe('requireUserAuth — posthogDistinctId threading', () => {
  const TELEMETRY_ENV = {
    SUPABASE_URL,
    POSTHOG_PROJECT_KEY: 'phc_test_token',
    POSTHOG_HOST: 'https://us.i.posthog.com',
    ENV: 'preview',
  } as Env;

  let fetchSpy: ReturnType<typeof vi.fn>;
  let waited: Promise<unknown>[];

  beforeEach(() => {
    waited = [];
    fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function execCtx(): ExecutionContext {
    return {
      waitUntil: (p: Promise<unknown>) => {
        waited.push(p);
      },
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext;
  }

  async function logAttributes(): Promise<Record<string, unknown>> {
    await Promise.all(waited);
    const call = fetchSpy.mock.calls.find((c) => c[0] === 'https://us.i.posthog.com/i/v1/logs') as [
      string,
      { body: string },
    ];
    const body = JSON.parse(call[1].body) as {
      resourceLogs: {
        scopeLogs: {
          logRecords: { attributes: { key: string; value: { stringValue?: string } }[] }[];
        }[];
      }[];
    };
    return Object.fromEntries(
      body.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.attributes.map((a) => [
        a.key,
        a.value.stringValue,
      ]),
    );
  }

  it('stamps the verified token sub on a log emitted behind the guard', async () => {
    const app = new Hono<{ Bindings: Env; Variables: UserAuthVariables }>();
    app.onError(errorHandler());
    app.post('/api/auth/profile/ensure', requireUserAuth({ getKey }), (c) => {
      logToPosthog(c.executionCtx, c.env, c.req.raw, { message: 'profile ensured' });
      return c.json({ created: true });
    });

    const token = await mintToken({ sub: 'user-xyz' });
    const res = await app.request(
      '/api/auth/profile/ensure',
      { method: 'POST', headers: bearer(token) },
      TELEMETRY_ENV,
      execCtx(),
    );
    expect(res.status).toBe(200);
    expect(await logAttributes()).toHaveProperty('posthogDistinctId', 'user-xyz');
  });
});
