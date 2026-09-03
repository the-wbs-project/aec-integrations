import { canonicalUrl } from '../core/canonical';
import type { MetaService } from '../core/meta.service';

/**
 * The two decisions the `/vendor` gate makes, shared by everything that guards
 * the portal (`vendor-me.resolver.ts`, `vendor-home-redirect.guard.ts`) so the
 * "don't reveal the surface" rule has exactly one definition.
 */

/**
 * Treat a 401/403 (and a defensive 404) from `requireVendor()` as "render the
 * not-found page" — same UX whether the caller is anonymous, a reviewer, a
 * banned seat, a half-granted seat with a null `vendor_id`, or a site admin.
 * Anything else (notably 5xx) is a real failure and must NOT be laundered into a
 * 404: faking not-found on an outage hides the outage.
 */
export function isVendorGateRejection(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
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
