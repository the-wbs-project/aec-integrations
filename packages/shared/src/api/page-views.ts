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
 * ─── AECI-585 (`ADMIN_PANEL_SPEC.md` §7.3) added two fields ──────────────────
 *
 * `path` is the CONCRETE URL path, stored alongside `route`. The two differ only
 * for a writer that knows a route *pattern*: an SSR resolver attaches
 * `route: '/products/:slug'`, which is what "top pages" wants to group on but
 * cannot name a taxonomy term with. `path` is therefore **optional**, and the API
 * falls back to `route` when it is absent — correct for every writer whose `route`
 * is already concrete (the browser tracker, an SSR cache HIT). Only a writer
 * sending a pattern owes an explicit `path`. Locale prefix stripped, no query or
 * hash: the privacy rule that keeps the full URL out of this table (§9.7) applies
 * to this column exactly as it does to `referrer`.
 *
 * `navigation` says how the visitor got here — `'arrival'` for a full-document
 * load, `'spa'` for an in-app navigation. It exists because the same-origin
 * `Referer` on an SPA hop classifies as `Direct`, making `Direct` (the largest
 * bucket in every digest) a mix of true arrivals and in-app clicks. Optional, and
 * the API never infers it: a row that does not say is stored as null rather than
 * guessed into the wrong bucket.
 *
 * Supersedes the earlier `TrackPageviewSchema` sketch in docs/API_CONTRACTS.md
 * §6.9 (path + product_id + vendor_id + session_id + referrer), which the
 * Phase 2 Spec replaces.
 */
export const PageViewPayloadSchema = z.object({
  route: z.string().min(1),
  path: z.string().min(1).max(2048).optional(),
  navigation: z.enum(['spa', 'arrival']).optional(),
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
 * `request.cf` (country / colo / asn / AS organization / bot score) is populated on
 * the inbound eyeball request but does NOT survive the `env.API` service binding,
 * so the SSR Worker copies the needed fields onto these headers before proxying the
 * browser's `POST /api/page-views` (and on its own supplementary `firePageView`
 * call). The SSR Worker is the SOLE writer: on the proxy path it strips any
 * client-supplied copies first (anti-spoof), then sets them from `request.cf`.
 * The API Worker treats them as trusted because it has no public ingress
 * (service-binding only). See docs/API_CONTRACTS.md §6.9.
 *
 * `asOrganization` (AECI-585 / §13 D10) is the AS holder *name* — an ASN cannot
 * label itself, so without it the panel's internal-traffic filter reads "excluding
 * AS23700" and the bot classifier's weekly audit is a list of bare numbers. It
 * reuses the header name `LANDING_CF_HEADERS` already carries it under,
 * deliberately: both proxies read the same `request.cf` field onto the same wire
 * name, so the two enrichment paths cannot drift apart on it.
 *
 * `tlsVersion` / `httpProtocol` (AECI-658) are the two connection facts `request.cf`
 * exposes on the **Pro** plan. They are deliberately LOW-entropy and are stored as
 * corroboration, never as a fingerprint: the negotiated cipher is largely the
 * server's choice and the version set is tiny, so this is nothing like JA3/JA4
 * (which needs Enterprise Bot Management). The discriminating signals in that issue
 * are the request HEADERS, which ride through on their own and need no entry here.
 */
export const PAGE_VIEW_CF_HEADERS = {
  country: 'x-aeci-cf-country',
  colo: 'x-aeci-cf-colo',
  asn: 'x-aeci-cf-asn',
  asOrganization: 'x-aeci-cf-as-organization',
  botScore: 'x-aeci-cf-bot-score',
  tlsVersion: 'x-aeci-cf-tls-version',
  httpProtocol: 'x-aeci-cf-http-protocol',
} as const;

/**
 * Request headers the SSR Worker copies from the eyeball onto its synthesized
 * `firePageView` subrequest so the API can judge how browser-shaped an arrival was
 * (AECI-658, `lib/client-signals.ts`).
 *
 * Unlike `PAGE_VIEW_CF_HEADERS` these are **not** renamed onto `x-aeci-*` wire
 * names and **not** stripped on the proxy path. They are the browser's own headers
 * and they mean the same thing wherever they came from: on the browser tracker's
 * `POST` the fetch already carries them natively, and on the SSR arrival path
 * `firePageView` copies them off the document request. Nothing is *trusted* on the
 * strength of them either, which is why no anti-spoof strip is needed: a scraper is
 * free to forge the whole set, and one that bothers has simply raised its own cost.
 * We are catching the lazy majority, and the resulting column never writes `is_bot`.
 */
export const PAGE_VIEW_CLIENT_SIGNAL_HEADERS = [
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'accept-language',
  'sec-ch-ua',
  'accept',
] as const;

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

/**
 * The width of the `page_views` de-duplication bucket, in milliseconds (AECI-743).
 *
 * A single arrival can reach the Worker twice — a double-clicked search result, a
 * HEAD-then-GET probe, a speculative load the browser then re-requests — and each
 * one is an independent SSR invocation that fires its own `POST /api/page-views`.
 * Production held two byte-identical `arrival` rows 83 ms apart for one visit, and
 * those two rows were the whole "Google — 2 views" traffic-source table in that
 * day's digest: the corroborated floor, the one figure a rotating-proxy pool
 * cannot inflate, inflated 2× by us.
 *
 * The API turns this into a deterministic `dedupe_key` (see `routes/page-views.ts`)
 * carrying a floor-divided time bucket, protected by a UNIQUE index. A bucket
 * rather than a "rows in the last N seconds" lookup because the duplicate writes
 * RACE: both land in `waitUntil` with unpredictable delay, so a read-then-write
 * check can miss. Ingest also probes the PREVIOUS bucket, so the effective window
 * is 10–20 s rather than a hard 10 — a pair that straddles a bucket boundary still
 * collapses. Ten seconds is well under any plausible genuine re-view of the same
 * path in one session, which the fix must not suppress.
 *
 * Exported from `@aeci/shared` rather than inlined so the ops duplicate-report
 * query, the ingest guard, and the docs quote one number.
 */
export const PAGE_VIEW_DEDUPE_WINDOW_MS = 10_000;

/**
 * Request headers that mark a **speculative** navigation — a prefetch or prerender
 * the browser performed on the visitor's behalf, for a page they may never see
 * (AECI-743).
 *
 * `Sec-Purpose` is the current standard (`prefetch`, or `prefetch;prerender` for a
 * full prerender, which also sends `Sec-Fetch-Dest: document` and is therefore
 * indistinguishable from a real arrival without this header). `Purpose: prefetch`
 * is the older Chromium spelling, `X-Moz: prefetch` Firefox's, and `X-Purpose:
 * preview` Safari's link-preview fetch — hence `preview` in the matched value set
 * alongside `prefetch`/`prerender`. All four headers are checked because the cost of
 * one extra header read is nil and a miss writes a phantom arrival.
 *
 * A speculative load is not an arrival, so the SSR Worker's `firePageView` skips it
 * outright rather than recording it under a new `navigation` value: recording it
 * would put the burden on every read surface (the digest, the four admin reads,
 * `metrics_daily`) to remember a new exclusion, which is exactly the drift
 * `UNTRACKED_ROUTE_PREFIXES` exists to prevent. The skip is counted
 * (`aeci.pageviews.speculative`) so the volume stays observable.
 */
export const SPECULATIVE_REQUEST_HEADERS = [
  'sec-purpose',
  'purpose',
  'x-moz',
  'x-purpose',
] as const;

const SPECULATIVE_VALUE_RE = /prefetch|prerender|preview/i;

/**
 * Whether a request is a browser prefetch/prerender rather than a real arrival.
 *
 * Substring-matched, not equality-compared: `Sec-Purpose` carries a token LIST
 * (`prefetch;prerender`), and an `=== 'prefetch'` check would wave every prerender
 * straight through.
 */
export function isSpeculativeRequest(headers: Headers): boolean {
  return SPECULATIVE_REQUEST_HEADERS.some((name) => {
    const value = headers.get(name);
    return value !== null && SPECULATIVE_VALUE_RE.test(value);
  });
}
