/**
 * `GET /auth/callback` (AECI-195 / Phase 5.4) — the magic-link / OAuth landing
 * leg of `STAGE_1_PHASE_5_SPEC.md` §4.2: exchange the PKCE code for a session,
 * let `@supabase/ssr` set the session cookies, defensively ensure the
 * `profiles` row exists, and redirect to the validated `return` path.
 *
 * Cookies: `exchangeCodeForSession` writes the `sb-…-auth-token*` session
 * cookies through the Hono cookie adapter (HTTP-only, `Secure`,
 * `SameSite=Lax` — Supabase defaults). Every response here MUST go through
 * the Hono context (`c.redirect`) — a bare `new Response()` would drop those
 * `Set-Cookie` headers. The session cookie stays OUT of
 * `VISITOR_STATE_COOKIES` (§4.3): `/auth/*` is non-cacheable via the
 * fail-closed route classifier, so the cookie survives by design and never
 * reaches a cacheable render.
 *
 * Profile-ensure: the `handle_new_user` DB trigger already creates the row;
 * the callback calls the API Worker's `POST /api/auth/profile/ensure`
 * (bearer = the fresh access token) as the defensive/idempotent backstop.
 * A failure there is logged but non-fatal — the trigger is the primary
 * creator, and the Phase 5.5 write-path middleware re-checks the profile on
 * every authenticated write anyway.
 *
 * Error contract for the Phase 5.3 login UI: failures land on
 * `/auth/login?error=<code>[&return=<path>]` with codes
 * `link_invalid` (provider error / failed code exchange — expired or reused
 * link), `missing_code`, `auth_not_configured`.
 */

import type { Context } from 'hono';

import type { WebEnv } from '../../env';
import { createServerApiClient } from '../../server-api-client';
import { createSupabaseServerClient } from '../auth/supabase-server-client';

/**
 * Validate a `return` query value down to a same-origin path (no open
 * redirect). Anything that isn't a plain absolute-path reference — empty,
 * scheme-relative (`//evil.com`), backslash-disguised (`/\evil.com`, which
 * browsers normalize to `//`), or a full URL — collapses to `/`.
 */
export function sanitizeReturnPath(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/')) return '/';
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return raw;
}

const NO_STORE = 'private, no-store';

function loginRedirect(
  c: Context<{ Bindings: WebEnv }>,
  errorCode: string,
  returnPath: string,
): Response {
  const params = new URLSearchParams({ error: errorCode });
  if (returnPath !== '/') params.set('return', returnPath);
  c.header('Cache-Control', NO_STORE);
  return c.redirect(`/auth/login?${params.toString()}`, 303);
}

export type AuthCallbackDeps = {
  /** Test seam — defaults to the real `@supabase/ssr` cookie-bound factory. */
  createClient?: typeof createSupabaseServerClient;
  /** Test seam — defaults to the real service-binding API client factory. */
  apiFor?: typeof createServerApiClient;
};

export function createAuthCallbackHandler(
  deps: AuthCallbackDeps = {},
): (c: Context<{ Bindings: WebEnv }>) => Promise<Response> {
  const createClient = deps.createClient ?? createSupabaseServerClient;
  const apiFor = deps.apiFor ?? createServerApiClient;

  return async (c) => {
    const url = new URL(c.req.url);
    const returnPath = sanitizeReturnPath(url.searchParams.get('return'));

    // Supabase reports link failures (expired, already used, user-denied
    // OAuth) as `error` / `error_description` params instead of a `code`.
    if (url.searchParams.get('error')) {
      return loginRedirect(c, 'link_invalid', returnPath);
    }

    const code = url.searchParams.get('code');
    if (!code) {
      return loginRedirect(c, 'missing_code', returnPath);
    }

    const supabase = createClient(c);
    if (!supabase) {
      return loginRedirect(c, 'auth_not_configured', returnPath);
    }

    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error || !data.session) {
      return loginRedirect(c, 'link_invalid', returnPath);
    }

    try {
      await apiFor(c.env).request<{ created: boolean }>('/api/auth/profile/ensure', {
        method: 'POST',
        headers: { Authorization: `Bearer ${data.session.access_token}` },
      });
    } catch (ensureError) {
      console.warn('auth-callback: profile-ensure failed (non-fatal)', ensureError);
    }

    c.header('Cache-Control', NO_STORE);
    return c.redirect(returnPath, 303);
  };
}
