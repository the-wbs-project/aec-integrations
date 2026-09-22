/**
 * The browser half of the expired-session bounce (AECI-954).
 *
 * A Supabase access token lives about an hour; the refresh token beside it in
 * the same cookie lives weeks. So the overwhelmingly common "my login timed out"
 * state is **recoverable** — the session is fine, the short-lived half of it just
 * went stale.
 *
 * On a full page load of `/admin*`, `/vendor*` or `/account` the SSR gate now
 * does that trade itself before rendering (`server/auth/session-refresh.ts`).
 * This probe covers what the server cannot: a client-side navigation, where no
 * SSR request happens, and a server refresh that failed. `@supabase/ssr`'s
 * browser client refreshes inside `getSession()` and writes the repaired session
 * back to the cookie.
 *
 * So this is the step an authenticated read takes after a 401, before deciding
 * whether the visitor needs the login page. `true` means "the cookie is good now
 * — try again"; `false` means "genuinely signed out — send them to login".
 *
 * ── IT IS ALSO THE LOOP BREAKER ─────────────────────────────────────────────
 * A verified JWT whose `profiles` row is missing ALSO 401s (`createAuthzMiddleware`
 * treats an unauthorizable identity as unauthenticated, deliberately). If a
 * caller redirected to login on every 401, that account would ride
 * login → session found → return → 401 → login forever, because signing in was
 * never the missing piece. Gating the redirect on "the probe says signed OUT"
 * bounds it: a signed-in caller retries once and then falls through to its own
 * not-found render, which is terminal.
 */
import type { AuthService } from './auth.service';

/**
 * Refresh the cookie-derived session and report whether one survives.
 *
 * Browser-only — `AuthService` reads `document.cookie` and `window`. Callers must
 * be on the client branch already. A thrown probe (the ~58 kB auth SDK chunk
 * failed to load, say) resolves to `false`: we are here because the API already
 * refused the session, so the login page is the actionable destination.
 */
export async function hasLiveSession(auth: AuthService): Promise<boolean> {
  try {
    return (await auth.sessionSnapshot()).signedIn;
  } catch {
    return false;
  }
}
