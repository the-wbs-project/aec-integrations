/**
 * Server-side session refresh for the authenticated SSR surfaces (`/admin*`,
 * `/vendor*`, `/account`).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * A Supabase access token lives about an hour; the refresh token beside it in
 * the same cookie lives weeks. An operator who types an `/admin` URL after an
 * hour away arrives with an expired access token and a perfectly good refresh
 * token. Before this module the SSR render forwarded that stale cookie to the
 * API, the resolver's `GET /api/admin/summary` 401'd, and the visitor rode a 302
 * to `/auth/login`, a "Restoring your session" panel, a browser-side refresh,
 * and a client navigation back. Four hops and two full page boots to repair a
 * token the server could have repaired in one round trip.
 *
 * So the gate does the trade here instead: `@supabase/ssr`'s server client reads
 * the request's `sb-…-auth-token*` cookies, and `getSession()` refreshes against
 * GoTrue **only** when the access token is expired or within the SDK's expiry
 * margin. A fresh token costs a cookie parse and no network. The refreshed
 * cookies are then used twice:
 *
 *   1. **Inbound.** The request handed to SSR carries the new cookie values, so
 *      the resolver's forwarded `Cookie` (`createServerApiClient`'s
 *      `forwardCookieFrom`) authenticates on the first try and the page renders.
 *   2. **Outbound.** The same values go back to the browser as `Set-Cookie`, so
 *      the browser holds the rotated refresh token.
 *
 * ── WHY THIS DOES NOT CONTRADICT ADMIN_PANEL_SPEC.md §13 D22 ─────────────────
 * AECI-689 declined a server-side refresh for two reasons, and both were about
 * the **cacheable** branch. (i) A `Set-Cookie` on a cacheable render would be
 * stored by the native Workers Cache and served to other visitors. (ii) Supabase
 * rotates refresh tokens, so spending the browser's token without handing the
 * replacement back strands the session. Here, (i) cannot occur: every path this
 * runs on is non-cacheable under the fail-closed route classifier, and
 * {@link withRefreshedCookies} additionally forces `private, no-store` on any
 * response that carries a cookie. And (ii) is exactly what the outbound half
 * does: the replacement always goes back to the browser.
 *
 * ── FAILURE MODES ───────────────────────────────────────────────────────────
 * Every failure degrades to "the request proceeds with the cookies it came in
 * with", within {@link REFRESH_DEADLINE_MS} at most, which is the pre-existing behavior: the resolver 401s and the browser
 * recovers through the login page's silent resume. A dead refresh token makes
 * the SDK clear the session cookies; forwarding that removal is correct, and
 * the login page then shows the form directly instead of a doomed restore.
 *
 * This is a convenience, never an authorization decision: the API Worker still
 * verifies whatever token it is given (`lib/authz.ts`).
 */
import { createServerClient } from '@supabase/ssr';
import type { CookieOptions } from '@supabase/ssr';
import { parse, serialize } from 'hono/utils/cookie';

import { toHonoCookieOptions } from './supabase-server-client';

/** The only env fields this module reads. */
export interface SessionRefreshEnv {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
}

export interface SessionRefreshResult {
  /** The request SSR should render. Identical to the input when nothing changed. */
  readonly request: Request;
  /** Serialized `Set-Cookie` values for the response. Empty when nothing changed. */
  readonly setCookies: readonly string[];
}

export interface SessionRefreshDeps {
  /** Test seam for the GoTrue round trip. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Test seam for {@link REFRESH_DEADLINE_MS}. */
  readonly deadlineMs?: number;
}

/**
 * How long the render waits for a refresh before giving up. The SDK retries a
 * 5xx or a network failure with backoff for up to 30 s (auth-js
 * `AUTO_REFRESH_TICK_DURATION_MS`), so without a bound a GoTrue outage would
 * stall every authenticated page load by ~25 s before falling back. A healthy
 * refresh is one round trip.
 */
export const REFRESH_DEADLINE_MS = 3000;

interface CookieWrite {
  readonly name: string;
  readonly value: string;
  readonly options?: CookieOptions;
}

/** Supabase clears a cookie by writing an empty value with `maxAge: 0`. */
function isRemoval(write: CookieWrite): boolean {
  return write.value === '' || write.options?.maxAge === 0;
}

/**
 * Rebuild a `Cookie` header with `writes` applied. Untouched pairs are kept
 * byte-for-byte, because re-encoding a value we did not write (a PostHog cookie
 * holding URL-encoded JSON, say) could change it.
 */
function applyToCookieHeader(raw: string, writes: readonly CookieWrite[]): string {
  const touched = new Set(writes.map((w) => w.name));
  const kept = raw
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => {
      if (pair === '') return false;
      const eq = pair.indexOf('=');
      const name = (eq === -1 ? pair : pair.slice(0, eq)).trim();
      return !touched.has(name);
    });
  const added = writes
    .filter((w) => !isRemoval(w))
    .map((w) => `${w.name}=${encodeURIComponent(w.value)}`);
  return [...kept, ...added].join('; ');
}

/**
 * Refresh the request's Supabase session when its access token has expired.
 * See the module header. Never throws.
 */
export async function refreshSessionCookies(
  request: Request,
  env: SessionRefreshEnv,
  deps: SessionRefreshDeps = {},
): Promise<SessionRefreshResult> {
  const unchanged: SessionRefreshResult = { request, setCookies: [] };
  const raw = request.headers.get('cookie');
  if (!raw || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return unchanged;

  const writes: CookieWrite[] = [];
  // Once the deadline fires, a late refresh must not leak writes into a
  // request that has already moved on.
  let abandoned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const supabase = createServerClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      cookies: {
        getAll: () => Object.entries(parse(raw)).map(([name, value]) => ({ name, value })),
        setAll: (cookies) => {
          if (!abandoned) writes.push(...cookies);
        },
      },
      ...(deps.fetch ? { global: { fetch: deps.fetch } } : {}),
    });
    // `getSession()` refreshes only inside the SDK's expiry margin; a fresh
    // token resolves from the cookie alone. The refresh's `setAll` is awaited
    // inside the SDK's auth-state callback, so `writes` is complete here.
    const refresh = supabase.auth.getSession().then(() => 'done' as const);
    refresh.catch(() => undefined);
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), deps.deadlineMs ?? REFRESH_DEADLINE_MS);
    });
    if ((await Promise.race([refresh, deadline])) === 'timeout') {
      abandoned = true;
      console.warn('[session-refresh] refresh timed out; rendering with the inbound cookie');
      return unchanged;
    }
  } catch (err) {
    console.warn('[session-refresh] refresh failed; rendering with the inbound cookie', err);
    return unchanged;
  } finally {
    clearTimeout(timer);
  }
  if (writes.length === 0) return unchanged;

  const headers = new Headers(request.headers);
  const cookieHeader = applyToCookieHeader(raw, writes);
  if (cookieHeader === '') headers.delete('cookie');
  else headers.set('cookie', cookieHeader);

  return {
    request: new Request(request, { headers }),
    setCookies: writes.map((w) => serialize(w.name, w.value, toHonoCookieOptions(w.options))),
  };
}

/**
 * Attach refreshed-session `Set-Cookie` headers to a response, and force it out
 * of every cache: a response carrying a credential must never be stored, even a
 * 404 that would otherwise take `NOT_FOUND_TTL`. Returns the input untouched
 * when there is nothing to set.
 */
export function withRefreshedCookies(response: Response, setCookies: readonly string[]): Response {
  if (setCookies.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const cookie of setCookies) headers.append('set-cookie', cookie);
  headers.set('Cache-Control', 'private, no-store');
  headers.delete('Cache-Tag');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
