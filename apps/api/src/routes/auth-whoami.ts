/**
 * THROWAWAY(AECI-193) — remove when Phase 5.5 lands the real authz middleware
 * on production endpoints.
 *
 * `GET /api/auth/whoami` exists only to smoke-test the AECI-193 auth spike:
 * `requireUserAuth()` (jose + remote JWKS) runs first, so reaching this
 * handler proves the bearer token verified. Returns the claims the middleware
 * resolved. 401-without-token / 200-with-token is the acceptance check; the
 * SSR Worker's `/auth/whoami` calls this over the service binding to prove
 * the full cookie → session → bearer → JWKS chain.
 */

import type { Context } from 'hono';

import type { Env } from '../env';
import { json } from '../http';
import type { UserAuthVariables } from '../lib/user-auth';

export function createAuthWhoamiHandler(): (
  c: Context<{ Bindings: Env; Variables: UserAuthVariables }>,
) => Response {
  return (c) => {
    const user = c.get('user');
    return json({ userId: user.userId, email: user.email });
  };
}
