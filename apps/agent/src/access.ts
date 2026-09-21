/**
 * In-Worker authentication for the datatool API routes — defense in depth on top
 * of the edge Cloudflare Access gate (so a direct origin hit can't bypass it).
 * Two accepted credentials, fail-closed to 403 otherwise:
 *
 *   1. Cloudflare Access JWT in `Cf-Access-Jwt-Assertion` (the normal browser
 *      path — the edge injects it on every request to the gated host), verified
 *      against the team JWKS with the `AECi Non-Prod` app's AUD (mirrors the
 *      Supabase-JWT verification in apps/api `lib/user-auth.ts`).
 *   2. An optional `Authorization: Bearer <TOOL_TOKEN>` shared secret (constant-
 *      time), for curl/CI/local-dev where the Access assertion isn't present.
 *
 * The UI page itself isn't gated here (the edge Access gates it; it carries no
 * secrets) — only the mutating `/api/*` routes are.
 */
import { timingSafeEqual } from '@aeci/shared/timing-safe-equal';
import type { MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

import type { Env } from './env';

export type AccessVariables = {
  /** Who authenticated: the Access email, or `tool-token`. For op logging. */
  operator: string;
};

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

/** One remote JWKS per team domain, shared across requests in this isolate. */
const jwksByTeam = new Map<string, JWTVerifyGetKey>();
function teamJwks(teamDomain: string): JWTVerifyGetKey {
  let keySet = jwksByTeam.get(teamDomain);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksByTeam.set(teamDomain, keySet);
  }
  return keySet;
}

function teamConfigured(teamDomain: string | undefined): teamDomain is string {
  return !!teamDomain && !teamDomain.startsWith('REPLACE_WITH_');
}

/** Verify a Cloudflare Access JWT and return the user's email (or `access-user`).
 * Throws on any failure (signature, expiry, issuer, audience). */
export async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  aud: string,
  getKey?: JWTVerifyGetKey,
): Promise<string> {
  const { payload } = await jwtVerify(token, getKey ?? teamJwks(teamDomain), {
    issuer: `https://${teamDomain}`,
    audience: aud,
  });
  return typeof payload['email'] === 'string' ? payload['email'] : 'access-user';
}

/** Hono middleware gating the mutating routes. Sets `c.get('operator')`. */
export function requireAccess(): MiddlewareHandler<{
  Bindings: Env;
  Variables: AccessVariables;
}> {
  return async (c, next) => {
    const env = c.env;

    // 1. Shared-secret bearer (curl / CI / local dev).
    const bearer = extractBearer(c.req.header('Authorization'));
    if (env.TOOL_TOKEN && bearer && timingSafeEqual(bearer, env.TOOL_TOKEN)) {
      c.set('operator', 'tool-token');
      return next();
    }

    // 2. Cloudflare Access JWT (the normal browser path).
    const assertion = c.req.header('Cf-Access-Jwt-Assertion');
    if (assertion && teamConfigured(env.ACCESS_TEAM_DOMAIN) && env.ACCESS_AUD) {
      try {
        const email = await verifyAccessJwt(assertion, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
        c.set('operator', email);
        return next();
      } catch {
        // fall through to 403 — fail closed, leak nothing
      }
    }

    return c.json(
      {
        error: { code: 'FORBIDDEN', message: 'Cloudflare Access (or a valid tool token) required' },
      },
      403,
    );
  };
}
