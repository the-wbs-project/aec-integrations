import { canonicalUrl } from '../core/canonical';
import type { MetaService } from '../core/meta.service';

/**
 * The three decisions the `/vendor` gate makes, shared by everything that guards
 * the portal (`vendor-me.resolver.ts`, `vendor-home-redirect.guard.ts`) so the
 * "don't reveal the surface" rule has exactly one definition — and, since
 * AECI-954, so does the line between "not this vendor" and "not signed in".
 */

/**
 * Treat a 403 (and a defensive 404) from `requireVendor()` as "render the
 * not-found page" — same UX whether the caller is a reviewer, a banned seat, a
 * half-granted seat with a null `vendor_id`, or a site admin. Anything else
 * (notably 5xx) is a real failure and must NOT be laundered into a 404: faking
 * not-found on an outage hides the outage.
 *
 * **401 is deliberately NOT in this set** (AECI-954). It used to be, and that is
 * what turned an hour-old vendor session into a dead "Page not found" with no
 * way forward. A 403 answers *"you are not this vendor"*, which is the answer the
 * don't-reveal-the-surface rule exists to blur. A 401 answers *"you are nobody"*,
 * about which the site is already loud: the worker-level gate 303s a cookie-less
 * visitor straight to `/auth/login`, so routing a 401 there discloses nothing the
 * anonymous path does not. See {@link isUnauthenticated}.
 */
export function isVendorGateRejection(status: number): boolean {
  return status === 403 || status === 404;
}

/**
 * A 401 from `requireVendor()` — the caller is not authenticated at all.
 *
 * Three things produce it, and the handling is the same for all three because
 * none of them is an authorization decision about the portal: no token on the
 * request, a token that fails verification (the expired-cookie case the worker's
 * presence-only gate cannot see), and a verified token whose `profiles` row is
 * missing. Callers bounce to `/auth/login?return=<path>` — on the client via
 * `hasLiveSession()` (`auth/session-recovery.ts`) first, which both repairs a
 * refreshable cookie and keeps the third case from looping.
 */
export function isUnauthenticated(status: number): boolean {
  return status === 401;
}

/**
 * Build the "render `<aec-not-found/>` here" marker for a portal path.
 *
 * Returns a closure, and the split is load-bearing: `canonicalUrl()` reaches for
 * `inject(REQUEST)` to find the serving origin, so it MUST run while the caller
 * is still in its injection context — which, in a resolver or a guard, means
 * before the first `await`. Everything that marks a not-found does so after an
 * HTTP round-trip has already resolved, by which point `inject()` throws NG0203.
 * Calling this once at the top and invoking the result later is what keeps both
 * halves legal.
 *
 * The returned function sets the noindex 404 head and yields `null` — the value
 * every caller hands back to mean not-found. The HTTP status is set separately
 * by whoever holds `RESPONSE_INIT`; this only owns the head.
 *
 * `kind: 'index'` with an empty slug because the portal is not an entity detail
 * page — there is no entity to name in the 404's canonical.
 */
export function vendorNotFoundMarker(meta: MetaService, path: string): () => null {
  const canonical = canonicalUrl(path);
  return () => {
    meta.setNotFoundMeta({ kind: 'index', slug: '', canonical });
    return null;
  };
}
