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
 * Profile-ensure: under ADR 0016 the authoritative `profiles` row lives in D1
 * and there is NO `handle_new_user` trigger, so the API Worker's
 * `POST /api/auth/profile/ensure` (bearer = the fresh access token) that this
 * callback calls is the PRIMARY creator — split-identity seam #1
 * (`docs/AUTH_AND_RLS.md` §3.1). It is idempotent (`INSERT … ON CONFLICT DO
 * NOTHING`) and never clobbers an existing row, which is what lets a vendor-claim
 * grant precede the claimant's first sign-in
 * (`docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §2).
 *
 * The ensure is FATAL (AECI-770). A session with no `profiles` row is unusable:
 * `requireAuth()` 401s it on every authed call. So the callback retries a
 * transient failure (a 5xx or an unreachable service binding) up to
 * {@link PROFILE_ENSURE_ATTEMPTS} times. If it still fails, the callback signs the
 * user out locally, which clears the cookies it just set, counts
 * `aeci.auth.profile_ensure{outcome:failed}`, and redirects to
 * `/auth/login?error=profile_unavailable`. A 4xx is not retried: the answer would
 * not change. `GET /api/account` self-heals any user who got past this anyway.
 *
 * Error contract for the Phase 5.3 login UI: failures land on
 * `/auth/login?error=<code>[&return=<path>]` with codes
 * `link_invalid` (provider error / failed code exchange — expired or reused
 * link), `missing_code`, `auth_not_configured`, `profile_unavailable` (the
 * session was created but its profile could not be, AECI-770).
 */

import type { Context } from 'hono';

import type { WebEnv } from '../../env';
import { createServerApiClient, ServerApiError } from '../../server-api-client';
import { submitCount } from '../../server-posthog';
import { createSupabaseServerClient } from '../auth/supabase-server-client';

/**
 * The sign-in `method` for the `aeci.auth.signin` metric (AECI-206 / Phase 5.15).
 * Plumbed as a `method` query param on the callback URL by the browser auth
 * service (`app/auth/auth.service.ts`); an absent/unknown value (e.g. a
 * `missing_code` hit with no method hint) tags `unknown`.
 */
export type AuthMethod = 'google' | 'magic_link' | 'unknown';

export function normalizeAuthMethod(raw: string | null | undefined): AuthMethod {
  return raw === 'google' || raw === 'magic_link' ? raw : 'unknown';
}

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

/** Profile-ensure attempts before the callback gives up and signs out (AECI-770). */
export const PROFILE_ENSURE_ATTEMPTS = 3;

/** Backoff before attempt 2 and attempt 3, in ms. Short: the user is waiting on a redirect. */
const PROFILE_ENSURE_BACKOFF_MS = [200, 600] as const;

/**
 * Whether a failed ensure is worth another try. A 5xx and anything that is not an
 * API response at all (an unreachable service binding, a network error) may pass
 * on the next attempt. A 4xx — an invalid token, a rate limit — will not.
 */
export function isTransientEnsureError(err: unknown): boolean {
  return !(err instanceof ServerApiError) || err.status >= 500;
}

/**
 * Emit the `aeci.auth.signin` count (AECI-206 / Phase 5.15) — one per sign-in
 * *completion* reaching the callback. `attempts = sum over outcomes`; the
 * `failed` slice's `reason` reuses the user-facing error-code vocabulary
 * (`link_invalid` / `missing_code` / `auth_not_configured` /
 * `profile_unavailable`). `success` fires only once the profile exists (AECI-770). Browser-side
 * *initiation* attempts (magic-link send, OAuth redirect-out) are direct
 * browser→Supabase and are a deferred RUM concern (see docs/OBSERVABILITY.md).
 * Fire-and-forget via the shared transport — each vendor leg no-ops without its own key.
 */
function emitSignin(
  c: Context<{ Bindings: WebEnv }>,
  method: AuthMethod,
  outcome: 'success' | 'failed',
  reason?: string,
): void {
  const tags = [`method:${method}`, `outcome:${outcome}`];
  if (reason) tags.push(`reason:${reason}`);
  submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.auth.signin', 1, tags);
}

/** Emit the failure metric, then redirect to the login page with the error code
 *  (which doubles as the metric `reason`). */
function failSignin(
  c: Context<{ Bindings: WebEnv }>,
  errorCode: string,
  returnPath: string,
  method: AuthMethod,
): Response {
  emitSignin(c, method, 'failed', errorCode);
  return loginRedirect(c, errorCode, returnPath);
}

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
  /** Test seam — the profile-ensure backoff wait. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createAuthCallbackHandler(
  deps: AuthCallbackDeps = {},
): (c: Context<{ Bindings: WebEnv }>) => Promise<Response> {
  const createClient = deps.createClient ?? createSupabaseServerClient;
  const apiFor = deps.apiFor ?? createServerApiClient;
  const sleep = deps.sleep ?? realSleep;

  return async (c) => {
    const url = new URL(c.req.url);
    const returnPath = sanitizeReturnPath(url.searchParams.get('return'));
    // `method` rides the callback URL (set by the browser auth service); it
    // survives Supabase's error redirect, so it's available on every branch.
    const method = normalizeAuthMethod(url.searchParams.get('method'));

    // Supabase reports link failures (expired, already used, user-denied
    // OAuth) as `error` / `error_description` params instead of a `code`.
    if (url.searchParams.get('error')) {
      return failSignin(c, 'link_invalid', returnPath, method);
    }

    const code = url.searchParams.get('code');
    if (!code) {
      return failSignin(c, 'missing_code', returnPath, method);
    }

    const supabase = createClient(c);
    if (!supabase) {
      return failSignin(c, 'auth_not_configured', returnPath, method);
    }

    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error || !data.session) {
      return failSignin(c, 'link_invalid', returnPath, method);
    }

    // The session exists, but it is only usable once its `profiles` row does
    // (AECI-770). Ensure it, retrying transient failures, before calling the
    // sign-in a success.
    const api = apiFor(c.env);
    let attempts = 0;
    let lastError: unknown = null;
    while (attempts < PROFILE_ENSURE_ATTEMPTS) {
      if (attempts > 0) await sleep(PROFILE_ENSURE_BACKOFF_MS[attempts - 1] ?? 0);
      attempts += 1;
      try {
        await api.request<{ created: boolean }>('/api/auth/profile/ensure', {
          method: 'POST',
          headers: { Authorization: `Bearer ${data.session.access_token}` },
        });
        lastError = null;
        break;
      } catch (ensureError) {
        lastError = ensureError;
        if (!isTransientEnsureError(ensureError)) break;
      }
    }

    submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.auth.profile_ensure', 1, [
      'source:auth-callback',
      `outcome:${lastError ? 'failed' : 'ok'}`,
      `attempts:${attempts}`,
    ]);

    if (lastError) {
      console.error(
        `auth-callback: profile-ensure failed after ${attempts} attempt(s); signing out`,
        lastError,
      );
      // Hand back no session rather than an unusable one. `scope: 'local'` clears
      // this browser's cookies through the same Hono adapter that set them. A
      // sign-out that throws still redirects: `GET /api/account` self-heals a
      // session that survives.
      try {
        await supabase.auth.signOut({ scope: 'local' });
      } catch (signOutError) {
        console.error('auth-callback: local sign-out after a failed ensure threw', signOutError);
      }
      return failSignin(c, 'profile_unavailable', returnPath, method);
    }

    emitSignin(c, method, 'success');

    c.header('Cache-Control', NO_STORE);
    return c.redirect(returnPath, 303);
  };
}
