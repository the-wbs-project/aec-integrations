// ---------------------------------------------------------------------------
// Supabase JWT auth middleware. Verifies asymmetric (ES256/RS256) access
// tokens against the project's JWKS at /auth/v1/.well-known/jwks.json. The
// JWKS is cached per isolate; cold isolates pay one fetch (~50ms). Tokens
// that have been revoked but not yet expired remain valid until expiry
// (default 1h), which is acceptable for an internal admin tool.
// ---------------------------------------------------------------------------
import type { MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Env } from '../env';

export interface AuthUser {
  id: string;
  email?: string;
}

export type AuthVariables = { user: AuthUser };

type JWKS = ReturnType<typeof createRemoteJWKSet>;
const jwksByUrl = new Map<string, JWKS>();

function getJwks(supabaseUrl: string): JWKS {
  const url = `${supabaseUrl.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`;
  let jwks = jwksByUrl.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url));
    jwksByUrl.set(url, jwks);
  }
  return jwks;
}

/**
 * Verify a Supabase access token. Returns the user payload, or null when the
 * token is missing/invalid/expired. Used by the WS handler which can't return
 * a 401 response in the same way.
 */
export async function verifyAccessToken(
  token: string | null | undefined,
  env: Pick<Env, 'SUPABASE_URL'>
): Promise<AuthUser | null> {
  if (!token) return null;
  if (!env.SUPABASE_URL) return null;
  try {
    const { payload } = await jwtVerify(token, getJwks(env.SUPABASE_URL), {
      algorithms: ['ES256', 'RS256'],
      issuer: `${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1`,
      audience: 'authenticated',
    });
    return payloadToUser(payload);
  } catch {
    return null;
  }
}

function payloadToUser(payload: JWTPayload): AuthUser | null {
  if (!payload.sub) return null;
  const email = typeof payload['email'] === 'string' ? (payload['email'] as string) : undefined;
  return { id: payload.sub, email };
}

/**
 * Hono middleware: requires a valid `Authorization: Bearer <token>` header.
 * On success, sets `c.var.user`. On failure, returns 401 immediately.
 */
export function requireAuth(): MiddlewareHandler<{
  Bindings: Env;
  Variables: AuthVariables;
}> {
  return async (c, next) => {
    const header = c.req.header('Authorization') ?? c.req.header('authorization');
    const token = header?.toLowerCase().startsWith('bearer ')
      ? header.slice(7).trim()
      : null;
    const user = await verifyAccessToken(token, c.env);
    if (!user) {
      return c.json({ error: 'unauthenticated' }, 401);
    }
    c.set('user', user);
    await next();
  };
}
