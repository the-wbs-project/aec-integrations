import type { ApiErrorCode } from '@aeci/shared';

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

/** Type-checked against the shared code, with no runtime import of the barrel. */
const VENDOR_SUSPENDED: typeof ApiErrorCode.VENDOR_SUSPENDED = 'VENDOR_SUSPENDED';

/**
 * What the gate hands the page when the caller's vendor is suspended (AECI-1623): enough
 * for the notice screen, and nothing else. Every portal read answers 403, so this is the
 * whole payload.
 */
export interface VendorSuspendedGate {
  readonly suspended: true;
  readonly vendorSlug: string;
  readonly vendorName: string;
}

/** Tells the suspended marker from a `VendorMeResponse` on the route data. */
export function isVendorSuspendedGate(value: unknown): value is VendorSuspendedGate {
  return typeof value === 'object' && value !== null && 'suspended' in value;
}

/**
 * Read `403 VENDOR_SUSPENDED` off a failed call, or `null` for anything else. A banned
 * seat answers a plain 403 first, so it never reaches this and keeps the 404.
 *
 * Structural, because it reads both error shapes: `ServerApiError` on the SSR branch
 * (`code`, `details`) and `HttpErrorResponse` in the browser (`error.error.*`). A response
 * that names no vendor is `null`: the caller then takes the ordinary not-found path.
 */
export function readVendorSuspended(err: unknown): VendorSuspendedGate | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as {
    status?: unknown;
    code?: unknown;
    details?: unknown;
    error?: { error?: { code?: unknown; details?: unknown } } | null;
  };
  if (e.status !== 403) return null;
  const code = e.code ?? e.error?.error?.code;
  if (code !== VENDOR_SUSPENDED) return null;
  const details = (e.details ?? e.error?.error?.details) as
    | { vendor_slug?: unknown; vendor_name?: unknown }
    | null
    | undefined;
  const vendorSlug = details?.vendor_slug;
  const vendorName = details?.vendor_name;
  if (typeof vendorSlug !== 'string' || typeof vendorName !== 'string') return null;
  return { suspended: true, vendorSlug, vendorName };
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
