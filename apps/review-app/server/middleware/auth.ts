// ---------------------------------------------------------------------------
// Supabase JWT auth middleware. Verifies HS256 access tokens locally with
// the project's JWT secret — no network hop per request. Tokens that have
// been revoked but not yet expired remain valid until expiry (default 1h),
// which is acceptable for an internal admin tool.
// ---------------------------------------------------------------------------
import type { MiddlewareHandler } from 'hono';
import { jwtVerify } from 'jose';
import type { Env } from '../env';

export interface AuthUser {
  id: string;
  email?: string;
}

export type AuthVariables = { user: AuthUser };

let cachedSecret: { raw: string; key: Uint8Array } | null = null;

function getSecretKey(raw: string): Uint8Array {
  if (cachedSecret && cachedSecret.raw === raw) return cachedSecret.key;
  const key = new TextEncoder().encode(raw);
  cachedSecret = { raw, key };
  return key;
}

/**
 * Verify a Supabase access token. Returns the user payload, or null when the
 * token is missing/invalid/expired. Used by the WS handler which can't return
 * a 401 response in the same way.
 */
export async function verifyAccessToken(
  token: string | null | undefined,
  env: Pick<Env, 'SUPABASE_JWT_SECRET'>
): Promise<AuthUser | null> {
  if (!token) return null;
  if (!env.SUPABASE_JWT_SECRET) return null;
  try {
    const { payload } = await jwtVerify(token, getSecretKey(env.SUPABASE_JWT_SECRET), {
      algorithms: ['HS256'],
    });
    if (!payload.sub) return null;
    const email = typeof payload['email'] === 'string' ? (payload['email'] as string) : undefined;
    return { id: payload.sub, email };
  } catch {
    return null;
  }
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
