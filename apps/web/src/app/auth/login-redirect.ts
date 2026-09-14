/**
 * "Send this visitor to the login page, and bring them back here afterwards" —
 * the in-app counterpart of the SSR Worker's anon gate (`server-runtime.ts`,
 * AECI-203 / AECI-520), which 303s a cookie-less visitor to
 * `/auth/login?return=<path>` before Angular ever boots.
 *
 * That gate only stops visitors with NO session cookie. A cookie whose access
 * token has expired sails past it (`hasSessionCookie` is a presence check by
 * design — no crypto, no network), so the first thing that notices is the
 * authenticated read a guard or resolver makes, which comes back 401. This is
 * what those callers use to finish the bounce the worker could not start
 * (AECI-954).
 *
 * `RedirectCommand` rather than a bare `UrlTree` because a `ResolveFn` returning
 * a `UrlTree` would resolve it as DATA. Guards accept either; they use the
 * `UrlTree` form so their `CanActivateFn` return type stays honest.
 *
 * Under SSR this becomes a **real HTTP redirect**: `@angular/ssr` emits one
 * whenever the router's final URL differs from the requested one. Which is also
 * the trap — it passes `RESPONSE_INIT.status` straight into its redirect-response
 * builder, and that throws in dev mode on anything outside 301/302/303/307/308.
 * A caller that redirects must NOT also set `RESPONSE_INIT.status = 404`.
 */
import { RedirectCommand, Router, type UrlTree } from '@angular/router';

import { safeReturnPath } from './return-path';

/**
 * The login `UrlTree`, carrying `?return=<path>` unless the path is `/` (the
 * same "don't bother" rule the worker gate applies). `safeReturnPath` narrows
 * the value to a same-origin path, so a hostile URL threaded through the router
 * can never become an open redirect — defense in depth over the login page's own
 * validation of the same param.
 */
export function loginUrlTree(router: Router, returnUrl: string | null | undefined): UrlTree {
  const path = safeReturnPath(returnUrl);
  return router.createUrlTree(
    ['/auth/login'],
    path === '/' ? {} : { queryParams: { return: path } },
  );
}

/** {@link loginUrlTree} wrapped for a resolver. See the header. */
export function loginRedirect(
  router: Router,
  returnUrl: string | null | undefined,
): RedirectCommand {
  return new RedirectCommand(loginUrlTree(router, returnUrl));
}
