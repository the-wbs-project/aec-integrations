/**
 * Shared test JWKS + token minting for specs that exercise the REAL
 * `requireAuth()` / `requireAdmin()` middleware (`lib/authz.ts`) end-to-end —
 * i.e. the no-leakage deny-matrix specs (AECI-234), not just the handler in
 * isolation.
 *
 * A locally-generated ES256 keypair stands in for the Supabase JWKS via the
 * guard's `getKey` seam, and `mintToken({ sub, supabaseUrl })` signs an
 * access token whose issuer (`<supabaseUrl>/auth/v1`), audience
 * (`authenticated`), algorithm (ES256) and `kid` (`test-key`) match exactly
 * what `verifySupabaseJwt()` requires — so the token verifies offline with no
 * network and no real Supabase project. Extracted from the inline pattern in
 * `lib/authz.spec.ts` so the matrix specs don't duplicate the crypto setup.
 */

import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey,
} from 'jose';

export type MintTokenOptions = {
  /** Token `sub` — the verified `auth.users` / `profiles` UUID. */
  sub: string;
  /** Supabase URL the guard is configured with; sets the issuer to
   *  `<supabaseUrl>/auth/v1` so verification matches. */
  supabaseUrl: string;
  email?: string;
  /** `jose` duration (default `'1h'`); pass `'-1h'` to mint an expired token. */
  expiresIn?: string;
};

export type TestJwks = {
  /** Pass as `requireAuth({ getKey })` / `requireAdmin({ getKey })`. */
  getKey: JWTVerifyGetKey;
  /** Mint a verifiable Supabase-style access token for `sub`. */
  mintToken(opts: MintTokenOptions): Promise<string>;
};

/** Generate a one-off ES256 keypair + local JWKS and a matching token minter.
 *  Call once per spec file in `beforeAll` (key generation is async). */
export async function makeTestJwks(): Promise<TestJwks> {
  const pair = await generateKeyPair('ES256');
  const privateKey = pair.privateKey as CryptoKey;
  const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'ES256' };
  const getKey = createLocalJWKSet({ keys: [publicJwk] });

  return {
    getKey,
    async mintToken({ sub, supabaseUrl, email, expiresIn = '1h' }) {
      const payload: Record<string, unknown> = { sub };
      if (email !== undefined) payload.email = email;
      return new SignJWT(payload)
        .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
        .setIssuedAt()
        .setIssuer(`${supabaseUrl}/auth/v1`)
        .setAudience('authenticated')
        .setExpirationTime(expiresIn)
        .sign(privateKey);
    },
  };
}
