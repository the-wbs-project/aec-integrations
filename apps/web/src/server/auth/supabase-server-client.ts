/**
 * Supabase server client for the SSR Worker (AECI-193 / Phase 5.2).
 *
 * The permanent cookie-session factory every Phase 5 auth surface builds on:
 * `@supabase/ssr`'s `createServerClient` wired to Hono's cookie helpers, so a
 * request's `sb-…-auth-token*` cookies become a server-side Supabase session
 * and refreshed tokens flow back out as `Set-Cookie` headers on the response.
 *
 * Cookie names pass through this adapter VERBATIM — chunking
 * (`sb-<ref>-auth-token.0`, `.1`, …) and the `base64-` value encoding are
 * `@supabase/ssr`'s job, and round-tripping them unmodified is what keeps us
 * compatible with the library's own browser client (Phase 5.3 login UI).
 *
 * No `auth` option overrides: the library defaults (PKCE flow + cookie
 * storage) are exactly what the OAuth/magic-link callback (Phase 5.4) needs.
 *
 * Cache interaction (CLAUDE.md "visitor-state-neutral HTML"): the session
 * cookie must NOT join `VISITOR_STATE_COOKIES` — it is a session credential,
 * not render-affecting visitor state.
 *
 * **Correction (AECI-689).** This note used to add "so it never reaches a
 * cacheable SSR render", on the grounds that auth surfaces are non-cacheable.
 * That is not what keeps the cache safe. `VISITOR_STATE_COOKIES` is empty, so
 * `stripVisitorStateCookies` strips nothing and the session cookie DOES reach
 * the cacheable render — a signed-in operator browsing a public product page is
 * the ordinary case. What actually protects the cache is that the cacheable
 * branch builds a **cookie-free** API client (`createServerApiClient(env)` with
 * no inbound auth), so no visitor state can be baked into the stored HTML.
 *
 * The distinction matters to anyone proposing to write a cookie from SSR: a
 * `Set-Cookie` on the cacheable branch would be stored by the native Workers
 * Cache and served to other visitors. AECI-689 declined a server-side token
 * refresh for exactly this reason (§13 D22).
 */

import { createServerClient } from '@supabase/ssr';
import type { CookieOptions } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { CookieOptions as HonoCookieOptions } from 'hono/utils/cookie';

import type { WebEnv } from '../../env';

/**
 * Map `@supabase/ssr`'s cookie options (the `cookie` package's serialize
 * shape) onto Hono's `setCookie` options. Field-by-field and explicit — a
 * spread would silently pass incompatible fields (`sameSite` casing,
 * `encode`) into Hono.
 */
export function toHonoCookieOptions(options: CookieOptions = {}): HonoCookieOptions {
  const mapped: HonoCookieOptions = {};
  if (options.domain !== undefined) mapped.domain = options.domain;
  if (options.expires !== undefined) mapped.expires = options.expires;
  if (options.httpOnly !== undefined) mapped.httpOnly = options.httpOnly;
  if (options.maxAge !== undefined) mapped.maxAge = options.maxAge;
  if (options.path !== undefined) mapped.path = options.path;
  if (options.secure !== undefined) mapped.secure = options.secure;
  if (options.sameSite !== undefined) {
    // `cookie` allows boolean shorthand; `true` historically means `Strict`.
    if (options.sameSite === true) mapped.sameSite = 'Strict';
    else if (options.sameSite === 'lax') mapped.sameSite = 'Lax';
    else if (options.sameSite === 'strict') mapped.sameSite = 'Strict';
    else if (options.sameSite === 'none') mapped.sameSite = 'None';
    // `false` → omit the attribute entirely.
  }
  return mapped;
}

/**
 * `@supabase/ssr` cookie-methods adapter over a Hono context. `getAll` reads
 * the request's cookies; `setAll` appends `Set-Cookie` headers onto the
 * response Hono is building (so handlers MUST respond via `c.json`/`c.body` —
 * constructing a bare `new Response()` would drop the refresh cookies).
 */
export function honoCookieAdapter(c: Context<{ Bindings: WebEnv }>): {
  getAll: () => { name: string; value: string }[];
  setAll: (cookies: { name: string; value: string; options?: CookieOptions }[]) => void;
} {
  return {
    getAll: () => Object.entries(getCookie(c)).map(([name, value]) => ({ name, value })),
    setAll: (cookies) => {
      for (const { name, value, options } of cookies) {
        setCookie(c, name, value, toHonoCookieOptions(options));
      }
    },
  };
}

/**
 * Per-request Supabase server client bound to the request's cookies. Returns
 * `null` when the env is unprovisioned (`SUPABASE_URL` / `SUPABASE_ANON_KEY`
 * unset) so callers degrade explicitly instead of throwing at boot — local
 * dev without Supabase config still serves every non-auth surface.
 *
 * MUST be created per request (it captures the request's cookie state);
 * never cache the returned client across requests.
 */
export function createSupabaseServerClient(
  c: Context<{ Bindings: WebEnv }>,
): SupabaseClient | null {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = c.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;

  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: honoCookieAdapter(c),
  });
}
