/**
 * The "Last used" badge on `/auth/login`. The browser remembers which sign-in
 * method this visitor started last, so the page can mark it on the next visit.
 *
 * The value is one of two fixed words. It holds no email, no identifier and is
 * never sent to us. The Privacy Policy discloses it under "Cookies and similar
 * technologies". It survives sign-out on purpose: the badge is for the next
 * sign-in.
 *
 * Browser-only. Read it after render, never during SSR, so the server HTML stays
 * the same for every visitor. Storage failures (private mode, a full quota, a
 * blocked `localStorage`) are swallowed: the badge is a hint, not state.
 */
export type SignInMethod = 'google' | 'email';

export const LAST_SIGN_IN_METHOD_KEY = 'aeci.auth.lastMethod';

export function readLastSignInMethod(): SignInMethod | null {
  try {
    const raw = globalThis.localStorage?.getItem(LAST_SIGN_IN_METHOD_KEY);
    return raw === 'google' || raw === 'email' ? raw : null;
  } catch {
    return null;
  }
}

export function writeLastSignInMethod(method: SignInMethod): void {
  try {
    globalThis.localStorage?.setItem(LAST_SIGN_IN_METHOD_KEY, method);
  } catch {
    // A hint only. Losing it costs the visitor nothing.
  }
}
