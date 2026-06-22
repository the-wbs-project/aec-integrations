import type { AuthService } from './auth.service';

/**
 * Shared sign-out action for the header menus (AECI-259) — used by both the
 * desktop user menu (`layout/user-menu.ts`) and the mobile overlay
 * (`layout/nav-menu.ts`), so the flow lives in one place and can't drift.
 *
 * Mirrors `AccountPage.onSignOut()`: clear the Supabase session, then leave for
 * home. The redirect is a **hard `location.assign('/')`, not a `Router.navigate`,
 * on purpose** — it forces a fresh SSR render so the now-signed-out header (and
 * the server auth-gate on `/account`) take effect, and there is no stale
 * client-side session state to reconcile.
 *
 * Returns `true` on success (the browser is navigating away) and `false` if
 * `signOut()` threw, so the caller can surface a retryable notice and leave the
 * menu open.
 */
export async function signOutAndGoHome(auth: AuthService): Promise<boolean> {
  try {
    await auth.signOut();
  } catch {
    return false;
  }
  globalThis.location.assign('/');
  return true;
}
