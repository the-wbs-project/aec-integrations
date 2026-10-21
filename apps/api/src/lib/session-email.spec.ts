/**
 * `verifiedSessionEmail` (AECI-1435): the strict check that lets a signed-in claimant
 * skip the emailed confirm link. Offline: a local ES256 keypair stands in for the
 * Supabase JWKS through the `getKey` seam. Every failure must read as "no session",
 * so the submit falls to the confirm path.
 */

import { Hono, type Context } from 'hono';
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
import {
  normalizeRequestEmail,
  sessionMatchesTypedEmail,
  verifiedSessionEmail,
} from './session-email';

const SUPABASE_URL = 'https://test-project.supabase.co';
const ISSUER = `${SUPABASE_URL}/auth/v1`;

let privateKey: CryptoKey;
let getKey: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey as CryptoKey;
  const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k', alg: 'ES256' };
  getKey = createLocalJWKSet({ keys: [publicJwk] });
});

async function mint(opts: { email?: string; exp?: number | string } = {}): Promise<string> {
  const payload: Record<string, unknown> = { sub: 'user-1' };
  if (opts.email !== undefined) payload.email = opts.email;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', kid: 'k' })
    .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setExpirationTime(opts.exp ?? '1h')
    .sign(privateKey);
}

/** The `@supabase/ssr` cookie form: `base64-` + base64url JSON with `access_token`. */
function sessionCookie(token: string): string {
  const json = JSON.stringify({ access_token: token });
  const b64 = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `sb-test-auth-token=base64-${b64}`;
}

async function resolve(headers: Record<string, string>, env: Partial<Env> = {}) {
  let seen: string | null | undefined;
  const app = new Hono<{ Bindings: Env }>();
  app.get('/', async (c: Context<{ Bindings: Env }>) => {
    seen = await verifiedSessionEmail(c, getKey);
    return c.text('ok');
  });
  await app.request('/', { headers }, { SUPABASE_URL, ...env } as Env);
  return seen;
}

describe('verifiedSessionEmail', () => {
  it('returns the lowercased email of a valid bearer token', async () => {
    const token = await mint({ email: '  Pat@Acme.COM ' });
    expect(await resolve({ Authorization: `Bearer ${token}` })).toBe('pat@acme.com');
  });

  it('reads the sb-* session cookie when there is no bearer', async () => {
    const token = await mint({ email: 'pat@acme.com' });
    expect(await resolve({ Cookie: sessionCookie(token) })).toBe('pat@acme.com');
  });

  it('is null with no token at all', async () => {
    expect(await resolve({})).toBeNull();
  });

  it('is null without SUPABASE_URL', async () => {
    const token = await mint({ email: 'pat@acme.com' });
    expect(await resolve({ Authorization: `Bearer ${token}` }, { SUPABASE_URL: '' })).toBeNull();
  });

  it('is null for a malformed or forged token', async () => {
    expect(await resolve({ Authorization: 'Bearer not-a-jwt' })).toBeNull();
    const other = await generateKeyPair('ES256');
    const forged = await new SignJWT({ sub: 'x', email: 'pat@acme.com' })
      .setProtectedHeader({ alg: 'ES256', kid: 'k' })
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setExpirationTime('1h')
      .sign(other.privateKey);
    expect(await resolve({ Authorization: `Bearer ${forged}` })).toBeNull();
  });

  it('rejects a token that only the grace-window verifier would accept', async () => {
    // Expired 30 seconds ago: inside any analytics grace window, but not valid.
    const token = await mint({ email: 'pat@acme.com', exp: Math.floor(Date.now() / 1000) - 30 });
    expect(await resolve({ Authorization: `Bearer ${token}` })).toBeNull();
  });

  it('does not fall back to the cookie when a bad bearer is present', async () => {
    const good = await mint({ email: 'pat@acme.com' });
    expect(
      await resolve({ Authorization: 'Bearer broken', Cookie: sessionCookie(good) }),
    ).toBeNull();
  });

  it('is null for a valid token with no email claim', async () => {
    const token = await mint();
    expect(await resolve({ Authorization: `Bearer ${token}` })).toBeNull();
  });
});

describe('sessionMatchesTypedEmail', () => {
  it('matches case- and space-insensitively', () => {
    expect(sessionMatchesTypedEmail('pat@acme.com', ' Pat@ACME.com ')).toBe(true);
  });

  it('fails closed on a missing session and on a different address', () => {
    expect(sessionMatchesTypedEmail(null, 'pat@acme.com')).toBe(false);
    expect(sessionMatchesTypedEmail('', 'pat@acme.com')).toBe(false);
    expect(sessionMatchesTypedEmail('sam@acme.com', 'pat@acme.com')).toBe(false);
  });

  it('normalizes with trim and lowercase only', () => {
    expect(normalizeRequestEmail('  A.B+c@Example.COM ')).toBe('a.b+c@example.com');
  });
});
