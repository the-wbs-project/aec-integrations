import type { Analytics } from '../analytics/analytics';
import type { AuthService } from './auth.service';

/**
 * Shared sign-out action (AECI-259) — used by the desktop user menu
 * (`layout/user-menu.ts`), the mobile overlay (`layout/nav-menu.ts`) AND
 * `AccountPage.onSignOut()` (folded in by AECI-649), so the flow lives in one
 * place and can't drift.
 *
 * Clear the Supabase session, drop the PostHog identity, then leave for home.
 * The redirect is a **hard `location.assign('/')`, not a `Router.navigate`,
 * on purpose** — it forces a fresh SSR render so the now-signed-out header (and
 * the server auth-gate on `/account`) take effect, and there is no stale
 * client-side session state to reconcile.
 *
 * **The `resetIdentity()` call is why this helper is now the only sign-out
 * path.** A hard reload is exactly the case where forgetting it would be
 * invisible: the Tier 3 distinct id and `$user_id` live in localStorage, so
 * they survive the reload and the next anonymous session on that browser is
 * attributed to the person who just left — wrong, and on a shared machine a
 * privacy problem (`docs/ANALYTICS.md` §8). It is awaited because the
 * navigation is started on the very next line.
 *
 * Returns `true` on success (the browser is navigating away) and `false` if
 * `signOut()` threw, so the caller can surface a retryable notice and leave the
 * menu open.
 */
export async function signOutAndGoHome(auth: AuthService, analytics: Analytics): Promise<boolean> {
  try {
    await auth.signOut();
  } catch {
    return false;
  }
  await analytics.resetIdentity();
  globalThis.location.assign('/');
  return true;
}
