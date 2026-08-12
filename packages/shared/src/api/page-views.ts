import { z } from 'zod';

/**
 * Body schema for `POST /api/page-views`. Per Phase 2 Spec §7.1 the endpoint
 * is a fire-and-forget capture hook that returns 204 — a no-op in Phase 2,
 * wired to a real `page_views` insert in Phase 4 (AECI-177). The shape kept
 * intentionally lean: a route plus an optional entity reference is enough for
 * the server to populate the table without retrofitting the client.
 *
 * `entity_id`, when present, is the entity's own UUID (the SSR resolvers attach
 * `entity.id`); the API Worker maps `(entity_type, entity_id)` onto the
 * `product_id` / `vendor_id` foreign keys. The browser tracker omits the entity
 * fields entirely (it only knows the route).
 *
 * `ref_source` / `ref_token` are optional campaign-attribution fields (AECI-243 /
 * §11.2): the waitlist welcome banner sends `{ ref_source: 'waitlist', ref_token }`
 * once, on a tagged `?ref=waitlist&token=…` arrival, so the view can be attributed
 * back to a subscriber. Bounded lengths so an unbounded client string can't reach
 * the DB. Omitted by every ordinary page view.
 *
 * Supersedes the earlier `TrackPageviewSchema` sketch in docs/API_CONTRACTS.md
 * §6.9 (path + product_id + vendor_id + session_id + referrer), which the
 * Phase 2 Spec replaces.
 */
export const PageViewPayloadSchema = z.object({
  route: z.string().min(1),
  entity_type: z.string().optional(),
  entity_id: z.string().optional(),
  ref_source: z.string().max(64).optional(),
  ref_token: z.string().max(255).optional(),
});

export type PageViewPayload = z.infer<typeof PageViewPayloadSchema>;

/**
 * HTTP header names the SSR Worker uses to forward trusted Cloudflare request
 * context to the API Worker for `page_views` enrichment (AECI-177).
 *
 * `request.cf` (country / colo / asn / bot score) is populated on the inbound
 * eyeball request but does NOT survive the `env.API` service binding, so the
 * SSR Worker copies the needed fields onto these headers before proxying the
 * browser's `POST /api/page-views` (and on its own supplementary `firePageView`
 * call). The SSR Worker is the SOLE writer: on the proxy path it strips any
 * client-supplied copies first (anti-spoof), then sets them from `request.cf`.
 * The API Worker treats them as trusted because it has no public ingress
 * (service-binding only). See docs/API_CONTRACTS.md §6.9.
 */
export const PAGE_VIEW_CF_HEADERS = {
  country: 'x-aeci-cf-country',
  colo: 'x-aeci-cf-colo',
  asn: 'x-aeci-cf-asn',
  botScore: 'x-aeci-cf-bot-score',
} as const;

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
 * This is an exclusion list, not a consent concept — `page_views` ingest stays
 * consent-independent by design (`ADMIN_PANEL_SPEC.md` §1).
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
