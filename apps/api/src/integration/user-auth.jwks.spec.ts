/**
 * Live JWKS verification for `requireUserAuth()` (AECI-193). Unlike the offline
 * unit spec, this exercises the REAL remote-JWKS path: `createRemoteJWKSet`
 * fetches the Supabase project's published keys over the network and verifies a
 * real, freshly-minted access token. It is the standing regression guard that
 * issued tokens stay ES256 (a dashboard signing-key rotation back to HS256
 * would break the production JWKS-only contract).
 *
 * Env vars (see apps/api/.dev.vars.example):
 *   SUPABASE_URL            — the shared dev project URL
 *   SUPABASE_TEST_USER_JWT  — a fresh access token (mint via
 *                             apps/web/scripts/mint-dev-session.mjs; 1h expiry)
 *
 * describe.skipIf keeps the default unit lane silent; the integration CI job
 * sets the vars. A runtime `ctx.skip()` handles the case where the JWT is
 * present but already expired (the 1h window lapsed since it was minted).
 */

import { decodeJwt, decodeProtectedHeader } from 'jose';
import { describe, expect, it } from 'vitest';

import type { Env } from '../env';
import { requireUserAuth } from '../lib/user-auth';

const supabaseUrl = process.env.SUPABASE_URL;
const token = process.env.SUPABASE_TEST_USER_JWT;

const enabled = Boolean(supabaseUrl && token);

describe.skipIf(!enabled)('requireUserAuth — live JWKS verify', () => {
  it('verifies a real Supabase access token via remote JWKS', async (ctx) => {
    // Guard: a stale (>1h old) token can't verify — skip rather than fail, so a
    // forgotten re-mint doesn't red the suite.
    const { exp } = decodeJwt(token as string);
    if (!exp || exp * 1000 < Date.now() + 5_000) {
      ctx.skip();
      return;
    }

    // Standing regression guard: issued tokens MUST stay ES256 (JWKS-only).
    expect(decodeProtectedHeader(token as string).alg).toBe('ES256');

    const env = { SUPABASE_URL: supabaseUrl } as Env;
    let resolved: { userId: string; email?: string } | undefined;
    const middleware = requireUserAuth();
    const c = {
      env,
      req: { header: (name: string) => (name === 'Authorization' ? `Bearer ${token}` : undefined) },
      set: (key: string, value: unknown) => {
        if (key === 'user') resolved = value as { userId: string; email?: string };
      },
    } as never;

    await middleware(c, async () => undefined);

    expect(resolved).toBeDefined();
    expect(typeof resolved?.userId).toBe('string');
    expect(resolved?.userId.length).toBeGreaterThan(0);
  });
});
