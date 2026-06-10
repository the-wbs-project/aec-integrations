/**
 * THROWAWAY(AECI-193) — remove when Phase 5.5 lands real auth surfaces.
 *
 * `GET /auth/whoami` smoke-tests the full AECI-193 auth chain end-to-end:
 *
 *   browser cookie → `@supabase/ssr` session on workerd (this Worker)
 *     → `Authorization: Bearer <access_token>` over the service binding
 *       → jose/JWKS verification on the API Worker (`/api/auth/whoami`).
 *
 * Responses:
 *   - 503 `{ error: 'auth_not_configured' }` — env unprovisioned. Distinct
 *     from 401 so the "401 without a session" smoke/e2e assertion stays
 *     honest (an unconfigured Worker can't masquerade as "no session").
 *   - 401 `{ error: 'unauthenticated' }` — no/invalid session cookie.
 *   - 200 `{ ssr: { userId, email }, api: { status, body } }` — SSR session
 *     verified locally AND the API Worker independently verified the bearer.
 *
 * All responses go through `c.json` with an explicit `private, no-store`:
 * `c.json` is REQUIRED (not just convention) because the cookie adapter's
 * `setAll` writes refresh-token `Set-Cookie` headers onto the context — a
 * bare `new Response()` would silently drop them. The explicit Cache-Control
 * keeps a credentialed response out of every cache even though `/auth/*` is
 * already non-cacheable in the route classifier.
 */

import type { Context } from 'hono';

import type { WebEnv } from '../../env';
import { createServerApiClient, isServerApiError } from '../../server-api-client';
import { createSupabaseServerClient } from '../auth/supabase-server-client';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

export function createAuthWhoamiHandler(): (c: Context<{ Bindings: WebEnv }>) => Promise<Response> {
  return async (c) => {
    const supabase = createSupabaseServerClient(c);
    if (!supabase) {
      return c.json({ error: 'auth_not_configured' }, 503, NO_STORE);
    }

    // `getClaims()` verifies the access token locally (WebCrypto against the
    // project JWKS for ES256 keys) — no Auth-server round-trip on the happy
    // path. No claims ⇒ no usable session.
    const { data: claimsData } = await supabase.auth.getClaims();
    const claims = claimsData?.claims;
    if (!claims) {
      return c.json({ error: 'unauthenticated' }, 401, NO_STORE);
    }

    // Full-chain proof: forward the access token as a bearer to the API
    // Worker's spike route so jose/JWKS verification is exercised over the
    // service binding. `getSession()` here just reads the cookie-derived
    // session `getClaims()` already validated.
    const {
      data: { session },
    } = await supabase.auth.getSession();
    let api: { status: number; body: unknown };
    if (!session) {
      api = { status: 0, body: { error: 'no_session_for_bearer' } };
    } else {
      try {
        const body = await createServerApiClient(c.env).request<unknown>('/api/auth/whoami', {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        api = { status: 200, body };
      } catch (error) {
        if (!isServerApiError(error)) throw error;
        api = { status: error.status, body: { code: error.code, message: error.message } };
      }
    }

    return c.json(
      {
        ssr: {
          userId: claims.sub,
          email: typeof claims['email'] === 'string' ? claims['email'] : undefined,
        },
        api,
      },
      200,
      NO_STORE,
    );
  };
}
