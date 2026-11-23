/**
 * The page-view constants and helpers the eager browser shell reads (AECI-1720).
 *
 * Plain values with no Zod import. `page-views.ts` declares Zod schemas at the top
 * level, and since zod 4.6 (AECI-1932) a bundler can no longer drop them, so a value
 * imported from that module pulls the whole of zod into the initial bundle.
 * `page-views.ts` re-exports everything here, so every existing import keeps working.
 */

/**
 * Route prefixes that are never recorded in `page_views` (AECI-575 /
 * `docs/ADMIN_PANEL_SPEC.md` §9.6 "No self-pollution").
 *
 * These are operator-only surfaces. Recording them means the console measures
 * its own navigation: every admin click writes a row into the same table the
 * daily digest reads, from the operator's own ISP. On the 2026-08-10 digest day
 * that was 67 of 92 "human" views (§14.2). Unlike an ASN allow/deny list, a path
 * exclusion has **zero false positives** — no genuine visitor browses `/admin`.
 *
 * The list is exported (not inlined at each call site) because it is enforced in
 * three places that must never drift: the two writers skip these routes
 * (`PageViewTracker.fire()` and the SSR Worker's `firePageView()`), and the read
 * side excludes them retroactively (the daily analytics digest), since rows
 * written before the write-side fix shipped are otherwise indistinguishable from
 * real traffic.
 *
 * This is an exclusion list, not a consent concept. `page_views` ingest needs no
 * consent banner (`ADMIN_PANEL_SPEC.md` §1), but it does honour a browser privacy
 * signal: see {@link hasPrivacySignal} (AECI-1386).
 */
export const UNTRACKED_ROUTE_PREFIXES = ['/admin', '/account'] as const;

/**
 * Whether a route is operator-only and must not produce a `page_views` row.
 *
 * Matches on the route **prefix**, not the concrete URL, so nested admin routes
 * (`/admin/reviews`, `/admin/requests`, …) are covered without enumeration and a
 * new child route inherits the exclusion for free. The boundary is exact —
 * `/admin` and `/admin/…` match, `/administrators` does not — so a future public
 * route that merely starts with the same letters keeps being tracked.
 *
 * Query string and hash are stripped first, mirroring what the tracker sends.
 */
export function isUntrackedRoute(route: string): boolean {
  const path = route.split(/[?#]/, 1)[0] || '/';
  return UNTRACKED_ROUTE_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/**
 * The two words `page_views.browser_evidence` stores (AECI-1713, epic AECI-1711).
 * `ran` means our page script ran for this page load. `interacted` means a person
 * then touched the page. Only `interacted` is the planned human floor. `ran` is not
 * human evidence: the AECI-1710 Phase 0 run found crawlers that run our bundle.
 * NULL on the column, never a third word, means no report arrived, or none was
 * collected (a privacy-signal row, a held region, a row written before the column).
 *
 * Plain constants, kept here rather than beside the body schema, so the eager
 * browser tracker can import them without pulling a Zod schema into the initial
 * bundle (the reason `page-view-turnstile.ts` and `page-view-browser-evidence.ts`
 * are separate modules).
 */
export const BROWSER_EVIDENCE_VALUES = ['ran', 'interacted'] as const;

export type BrowserEvidence = (typeof BROWSER_EVIDENCE_VALUES)[number];

/** Where the browser posts its report (`BrowserEvidencePostSchema`). Same-origin. */
export const BROWSER_EVIDENCE_URL = '/api/page-views/browser-evidence';

/**
 * The Ray ID pattern behind `TurnstileVerdictPostSchema.cf_ray`, and so behind
 * `BrowserEvidencePostSchema.cf_ray`. A plain `RegExp`, kept here rather than in a
 * schema module, so the eager browser tracker can test a ray read from
 * `Server-Timing` without pulling a Zod schema into the initial bundle (AECI-1714).
 */
export const CF_RAY_PATTERN = /^[0-9a-f]{16}(-[A-Z]{3,4})?$/i;
