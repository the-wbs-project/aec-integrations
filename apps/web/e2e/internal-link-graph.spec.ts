/**
 * AECI-64 / Phase 2.18 — internal-link graph audit (crawler test).
 *
 * Phase 2 Spec §10 requires that every detail page links to its related
 * entities (no dead ends) and, as a visitor-reachability rule, that **from any
 * page every other Phase 2 page type is reachable in ≤ 3 hops**. §15 gates Phase
 * 2 completion on a "crawler test [confirming] every entity reachable in ≤ 3
 * hops from `/`". This is that crawler.
 *
 * IT CRAWLS IN A REAL BROWSER, not over raw HTTP. The index and browse pages
 * render their row links **client-side** from a non-blocking `httpResource`
 * (AECI-126): the SSR HTML ships a loading/empty/error shell, and the
 * `<a href="/products/:slug">` row links only materialise after hydration
 * fetches `/api/*`. §10 is a *visitor* reachability rule and §15 names a
 * "Playwright crawler" — visitors run JS — so the crawl hydrates each page and
 * harvests links from the live DOM (the same way `products-index.spec.ts` reads
 * row links via `page`, never from SSR HTML).
 *
 * Algorithm: breadth-first from `/` to depth 3, keyed by pathname (query/hash
 * stripped, so pagination/sort permutations collapse to one page-type node),
 * following only INTERNAL links. To keep cost independent of catalog size
 * (AECI-64 — a full catalog otherwise pushed the all-pages serial crawl from ~83
 * to ~334 hydrated pages and blew the hook timeout), the hydrated browser crawl
 * visits only a bounded sample per page type (BROWSER_SAMPLE_PER_TYPE) — enough
 * to prove reachability (BFS reaches each type's min-depth instance first) and
 * console health, both per-TYPE contracts — and every other discovered internal
 * link is status-checked by a parallel HTTP sweep (`sweepStatuses`), which needs
 * no hydration to read a status code. It then asserts:
 *   - no internal link 404s (every discovered internal link resolves) — except a
 *     small, explicit allowlist of forward-reference placeholder routes whose
 *     pages aren't built yet (see EXPECTED_PENDING_PREFIXES);
 *   - no internal 5xx / navigation failures;
 *   - the four structural index page types are reachable ≤ 3;
 *   - each entity/browse page type is reachable ≤ 3 — **gated per type on that
 *     type having data** (probed from the API). A type with zero data (e.g. no
 *     integrations seeded yet) has nothing to reach, so its assertion is skipped
 *     and reported as "no data"; a type WITH data that goes unreachable fails,
 *     naming the type and its candidate start URL. This mirrors
 *     `taxonomy-browse.spec.ts`'s per-kind skipping and keeps the gate green on
 *     a partially-seeded DB while still enforcing §10 once data exists.
 *
 * The AC's "discipline browse" is this codebase's AUDIENCE browse
 * (`/audiences/:slug`, kind="audience"). Since AECI-157 the `/audiences` and
 * `/phases` indexes exist and are linked from the primary nav + footer, so
 * discipline + phase browse are now reachable at depth 2 (index → card), not
 * only at depth 3 via a product-detail `TaxonomyBadge`.
 *
 * AECI-160 re-pointed the primary nav at the taxonomy and pulled Vendors /
 * Integrations out of the nav AND footer (PO decision); AECI-165 then removed
 * the `/vendors` and `/integrations` INDEX pages entirely (they now 301-redirect
 * to `/products`). Only the vendor / integration DETAIL pages remain — reachable
 * ≤ 3 via a product detail's vendor / integration links — so this crawler tracks
 * `vendor-detail` / `integration-detail` reachability and no longer carries any
 * index page type for them.
 *
 * Every run writes `e2e/internal-link-graph-report.md` (a seed-stable,
 * type-level snapshot) in `beforeAll`, before the assertions, so it is produced
 * even when an assertion later fails (CI uploads it as an `if: always()`
 * artifact).
 *
 * AECI-162 — because this crawl already navigates a real browser to every page
 * type reachable from `/`, it doubles as the console-health gate for those types
 * (Phase 2 Spec §15.15, "No new console warnings or errors on any page type").
 * One `console`/`pageerror` listener is attached to the crawl page; each message
 * is attributed (via `page.url()`) to the page current when it fired, and gated
 * ONLY for pages that rendered 2xx — a non-2xx document (the intentional 404
 * placeholders, redirects) makes the browser log a "Failed to load resource:
 * ...404" for the navigation itself, which is the document status (already gated
 * by the no-404 / no-5xx assertions), not an app defect. Console ERRORS +
 * uncaught page errors FAIL; WARNINGS are reported, not gated (matching
 * `smoke.spec.ts`'s posture — see `console-capture.ts` for the rationale and the
 * shared `isIgnorableConsole` allowlist). The one page type this crawl can't
 * reach — the `not-found` shell, only linked via the temporary pending-prefix
 * placeholders — is console-checked by its own spec (`not-found.spec.ts`).
 * (AECI-165 removed the `/vendors` and `/integrations` indexes, which this
 * paragraph previously routed to their own specs; those pages now 301-redirect.)
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium, expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { isIgnorableConsole, waitForHydrationSettle } from './console-capture';

// Mirrors `playwright.config.ts`'s BASE_URL default. `beforeAll` hooks don't
// receive the test-scoped fixtures, so we recompute it from the same env var
// the config reads and launch our own browser.
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:8788';

// "≤ 3 hops": `/` is depth 0, header-nav indexes depth 1, details depth 2,
// product-detail `TaxonomyBadge` links depth 3. We visit nodes up to depth 3
// (to 404-check + classify them) but only follow links out of nodes at depth
// < 3.
const MAX_DEPTH = 3;

// AECI-64 cost control — bounded hydrated sample per page type.
//
// The hydrated browser crawl's cost is O(pages visited), and "pages" scales
// LINEARLY with the seeded catalog: a near-empty dev DB crawled ~83 pages, but
// once the full catalog landed (45 products / 33 vendors / 90 integrations) the
// same crawl ballooned to ~334 pages and blew the `beforeAll` cap — pure data
// growth, NOT a runner slowdown or DB latency (the Asia→Virginia move shaves
// per-query ms, not page count). Reachability (§15) and console health (§15.15)
// are both *per page TYPE* contracts — they're fully satisfied by a small
// representative sample of each type, since same-type pages render from the same
// component/template. So the browser hydrates at most this many pages per type
// (proving reachability at the true min depth — BFS visits each type's first
// instance first — plus a few more for console margin); every OTHER discovered
// link is status-verified by the cheap, fully-parallel HTTP sweep below
// (`sweepStatuses`) instead. Net: browser cost is O(types), the no-404/no-5xx
// gates still cover every discovered link, and the suite no longer scales with
// catalog size. Bump this only if a type's reachability/console coverage needs
// more samples — NOT to "crawl everything" (that's what the HTTP sweep is for).
const BROWSER_SAMPLE_PER_TYPE = 5;

// ---------------------------------------------------------------------------
// Page-type taxonomy (the Phase 2 page types in the AC + non-required pages).
// AECI-165 removed the `vendor-index` / `integration-index` types — those index
// pages no longer exist; only the vendor / integration DETAIL types remain.
// ---------------------------------------------------------------------------

type PageType =
  | 'product-index'
  | 'product-detail'
  | 'vendor-detail'
  | 'integration-detail'
  | 'categories'
  | 'category-browse'
  | 'audience-index'
  | 'phase-index'
  | 'discipline-browse' // = /audiences/:slug (audience browse)
  | 'phase-browse'
  | 'home'
  | 'other';

const PATTERN_OF: Record<PageType, string> = {
  'product-index': '/products',
  'product-detail': '/products/:slug',
  'vendor-detail': '/vendors/:slug',
  'integration-detail': '/integrations/:id',
  categories: '/categories',
  'category-browse': '/categories/:slug',
  'audience-index': '/audiences',
  'phase-index': '/phases',
  'discipline-browse': '/audiences/:slug',
  'phase-browse': '/phases/:slug',
  home: '/',
  other: '(other)',
};

const TYPE_LABEL: Record<PageType, string> = {
  'product-index': 'product index',
  'product-detail': 'product detail',
  'vendor-detail': 'vendor detail',
  'integration-detail': 'integration detail',
  categories: '/categories (flat list)',
  'category-browse': 'category browse',
  'audience-index': '/audiences (flat list)',
  'phase-index': '/phases (flat list)',
  'discipline-browse': 'discipline browse (audience)',
  'phase-browse': 'phase browse',
  home: 'home',
  other: 'other',
};

// Always asserted reachable ≤ 3. Index shells render `200` from the header nav /
// footer regardless of data; the taxonomy indexes need taxonomy seeded (CI seeds
// it). There are no longer vendor / integration index types — AECI-165 removed
// those pages (they 301-redirect to `/products`); only their DETAIL pages remain
// (asserted via `ENTITY_BROWSE_TYPES`).
const STRUCTURAL_TYPES: PageType[] = [
  'product-index',
  'categories',
  'audience-index',
  'phase-index',
];

const ENTITY_BROWSE_TYPES: PageType[] = [
  'product-detail',
  'vendor-detail',
  'integration-detail',
  'category-browse',
  'discipline-browse',
  'phase-browse',
];

// Where each required type SHOULD be linked from — surfaced in failure messages
// so an unreachable type names its candidate start/parent URLs (AC requirement).
const CANDIDATE_SOURCE: Partial<Record<PageType, string>> = {
  'product-index': 'site-header primary nav → /products',
  categories: 'site-header primary nav → /categories',
  'audience-index': 'site-header primary nav / footer → /audiences',
  'phase-index': 'site-header primary nav / footer → /phases',
  'product-detail': 'a /products index row → /products/:slug',
  'vendor-detail': 'a product-detail vendor link → /vendors/:slug',
  'integration-detail': 'a product-detail integration link → /integrations/:id',
  'category-browse':
    'a /categories list entry or a product-detail category TaxonomyBadge → /categories/:slug',
  'discipline-browse':
    'an /audiences list entry or a product-detail audience badge → /audiences/:slug',
  'phase-browse': 'a /phases list entry or a product-detail phase badge → /phases/:slug',
};

// ---------------------------------------------------------------------------
// Expected-pending allowlist.
//
// Internal routes that intentionally 404 today because their page isn't built
// yet — forward-reference links shipped ahead of the page. These are NOT broken
// links; they are deliberate placeholders rendered on every page. The crawler
// records them under "Known-pending links" in the report but does NOT fail the
// no-404 assertion on them. WHEN the owning phase lands a page, DELETE its entry
// here so the link becomes enforced (a regression that re-breaks it then fails
// the gate).
//
//   /auth/*   — Phase 5 (Auth & reviews): site-header "Sign in" CTA
//   /legal/*  — Phase 7 (legal): site-footer Terms / Privacy / Review guidelines /
//               Listing accuracy
//   /contact  — Phase 7: site-footer Contact
//   /about    — Phase 7: about page (no current link; kept for when it lands)
// ---------------------------------------------------------------------------
const EXPECTED_PENDING_PREFIXES = ['/auth', '/legal', '/contact', '/about'] as const;

function isExpectedPending(pathname: string): boolean {
  const p = stripLocale(pathname);
  return EXPECTED_PENDING_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

// ---------------------------------------------------------------------------
// Classification helpers.
// ---------------------------------------------------------------------------

// Defensive: strip a leading `/{lang}` or `/{lang}-{REGION}` locale segment
// before classifying (local dev is unprefixed; future-proofs URL-prefix i18n).
const LOCALE_PREFIX = /^\/[a-z]{2}(?:-[A-Z]{2})?(?=\/|$)/;

function stripLocale(pathname: string): string {
  return pathname.replace(LOCALE_PREFIX, '') || '/';
}

function classifyPath(pathname: string): PageType {
  const p = stripLocale(pathname);
  if (p === '/') return 'home';
  // Claim/correction request forms exist (AECI-128) but are not a required
  // Phase 2 page type — classify as `other` BEFORE the detail patterns so a
  // `/products/:slug/claim` URL never masquerades as a product detail.
  if (/^\/(?:products|vendors)\/[^/]+\/(?:claim|correction)\/?$/.test(p)) return 'other';
  if (/^\/products\/[^/]+\/?$/.test(p)) return 'product-detail';
  if (/^\/products\/?$/.test(p)) return 'product-index';
  // AECI-165 — `/vendors` and `/integrations` (bare index) no longer exist as
  // pages (they 301-redirect to `/products`); only their `:slug` / `:id` detail
  // routes are real page types, so there is no bare-index branch here.
  if (/^\/vendors\/[^/]+\/?$/.test(p)) return 'vendor-detail';
  if (/^\/integrations\/[^/]+\/?$/.test(p)) return 'integration-detail';
  if (/^\/categories\/[^/]+\/?$/.test(p)) return 'category-browse';
  if (/^\/categories\/?$/.test(p)) return 'categories';
  if (/^\/audiences\/[^/]+\/?$/.test(p)) return 'discipline-browse';
  if (/^\/audiences\/?$/.test(p)) return 'audience-index';
  if (/^\/phases\/[^/]+\/?$/.test(p)) return 'phase-browse';
  if (/^\/phases\/?$/.test(p)) return 'phase-index';
  return 'other';
}

type HrefClass = { kind: 'internal'; pathname: string } | { kind: 'external'; reason: string };

/**
 * Internal = rooted (`/…`, not `//`) or a same-origin absolute URL, resolved
 * against `base` (the current page's absolute URL). Everything else — other
 * origins, protocol-relative `//`, `mailto:`/`tel:`/`javascript:`/`data:`,
 * hash-only, unparseable — is external and never counted toward reach. This is
 * how the AC's "`<a href="https://...">` doesn't satisfy internal reach" is
 * enforced by construction.
 */
function classifyHref(href: string, base: string): HrefClass {
  const raw = href.trim();
  if (raw === '') return { kind: 'external', reason: 'empty' };
  if (raw.startsWith('#')) return { kind: 'external', reason: 'hash-only' };
  if (/^(?:mailto:|tel:|javascript:|data:)/i.test(raw)) {
    return { kind: 'external', reason: 'non-http scheme' };
  }
  if (raw.startsWith('//')) return { kind: 'external', reason: 'protocol-relative' };
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return { kind: 'external', reason: 'unparseable' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { kind: 'external', reason: `scheme ${url.protocol}` };
  }
  if (url.origin !== new URL(base).origin) return { kind: 'external', reason: 'cross-origin' };
  return { kind: 'internal', pathname: url.pathname };
}

// ---------------------------------------------------------------------------
// Seed probe — per-type data presence, so reachability is asserted only for
// types that actually have something to reach.
// ---------------------------------------------------------------------------

interface SeedInfo {
  products: number;
  vendors: number;
  integrations: number;
  categoriesTotal: number;
  audiencesWithProducts: number; // audience terms a product actually links
  phasesWithProducts: number;
}

async function probeSeed(req: APIRequestContext): Promise<SeedInfo> {
  const total = async (path: string): Promise<number> => {
    try {
      const r = await req.get(path, { maxRedirects: 0 });
      if (!r.ok()) return 0;
      const j = (await r.json()) as { total?: number; data?: unknown[] };
      return typeof j.total === 'number' ? j.total : Array.isArray(j.data) ? j.data.length : 0;
    } catch {
      return 0;
    }
  };

  const products = await total('/api/products');
  const vendors = await total('/api/vendors');
  const integrations = await total('/api/integrations');

  let categoriesTotal = 0;
  let audiencesWithProducts = 0;
  let phasesWithProducts = 0;
  try {
    const r = await req.get('/api/taxonomy', { maxRedirects: 0 });
    if (r.ok()) {
      const tax = (await r.json()) as Record<string, { product_count?: number }[] | undefined>;
      const withProducts = (arr: { product_count?: number }[] | undefined): number =>
        Array.isArray(arr) ? arr.filter((t) => (t.product_count ?? 0) > 0).length : 0;
      categoriesTotal = Array.isArray(tax['categories']) ? tax['categories'].length : 0;
      audiencesWithProducts = withProducts(tax['audiences']);
      phasesWithProducts = withProducts(tax['phases']);
    }
  } catch {
    /* leave zeros — treated as "no data" */
  }

  return {
    products,
    vendors,
    integrations,
    categoriesTotal,
    audiencesWithProducts,
    phasesWithProducts,
  };
}

/**
 * Whether a type has data to reach. Structural index types are always expected
 * (they render `200` from the header nav regardless of data — `/categories`
 * needs taxonomy, which CI seeds). Entity/browse types depend on real rows:
 * discipline/phase browse have no index page, so they're only reachable when a
 * product actually links an audience/phase term.
 */
function hasData(seed: SeedInfo, type: PageType): boolean {
  switch (type) {
    case 'product-index':
    case 'categories':
      return true;
    case 'product-detail':
      return seed.products > 0;
    case 'vendor-detail':
      return seed.vendors > 0;
    case 'integration-detail':
      return seed.integrations > 0;
    case 'category-browse':
      return seed.categoriesTotal > 0;
    case 'discipline-browse':
      return seed.products > 0 && seed.audiencesWithProducts > 0;
    case 'phase-browse':
      return seed.products > 0 && seed.phasesWithProducts > 0;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// The crawl (in a real, hydrated browser).
// ---------------------------------------------------------------------------

interface Discovered {
  depth: number;
  parent: string | null;
}

interface LinkRef {
  path: string;
  parent: string | null;
}

interface CrawlResult {
  baseUrl: string;
  seed: SeedInfo;
  // pathname -> first-discovery info (min depth + parent), for ALL enqueued
  // nodes. BFS marks `discovered` at enqueue time, so first-reach == min depth.
  discovered: Map<string, Discovered>;
  // pathname -> {status, type} for nodes that returned 2xx.
  reached: Map<string, { status: number; type: PageType }>;
  broken: LinkRef[]; // unexpected internal 404s (not on the pending allowlist)
  pending: LinkRef[]; // allowlisted, intentional 404 placeholders
  serverErrors: (LinkRef & { status: number })[]; // 5xx or status 0 = nav failure
  redirects: (LinkRef & { status: number; location: string | null })[];
  externalSeen: Map<string, number>; // href -> times seen
  // AECI-162 — console health, keyed by the page that emitted each message.
  consoleErrors: { path: string; text: string }[]; // gated (fail)
  consoleWarnings: { path: string; text: string }[]; // reported, not gated
  pageErrors: { path: string; message: string }[]; // uncaught exceptions, gated
  // AECI-64 cost control — how the link graph was covered (see report prose).
  browserVisited: number; // pages hydrated in the real browser (bounded sample)
  httpSwept: number; // remaining discovered links status-checked over HTTP
}

// The status-bucket subset every visited/swept link is sorted into. Shared by
// the browser crawl and the HTTP sweep so BOTH classify a status identically
// (no drift between "hydrated" and "swept" links).
type StatusBuckets = Pick<
  CrawlResult,
  'reached' | 'broken' | 'pending' | 'serverErrors' | 'redirects'
>;

type StatusOutcome = 'reached' | 'broken' | 'pending' | 'server' | 'redirect';

/**
 * Sort one (path, status) into the result buckets exactly as the original
 * inline crawl branch did: 5xx / 0 → serverErrors; 404 → pending (allowlisted)
 * or broken; 3xx → redirects (recorded, not followed); other non-200 (401/403…)
 * → broken; 200 → reached. Returns the bucket so the browser caller knows
 * whether to harvest (only `reached` pages have links to follow).
 */
function recordStatus(
  path: string,
  parent: string | null,
  status: number,
  type: PageType,
  b: StatusBuckets,
): StatusOutcome {
  if (status >= 500 || status === 0) {
    b.serverErrors.push({ path, parent, status });
    return 'server';
  }
  if (status === 404) {
    (isExpectedPending(path) ? b.pending : b.broken).push({ path, parent });
    return 'pending';
  }
  if (status >= 300 && status < 400) {
    b.redirects.push({ path, parent, status, location: null });
    return 'redirect';
  }
  if (status !== 200) {
    b.broken.push({ path, parent }); // 401/403/… — surface it
    return 'broken';
  }
  b.reached.set(path, { status, type });
  return 'reached';
}

/**
 * Browser navigation with one retry. The browser now visits only a bounded
 * sample, so a single transient nav hiccup on a slow runner shouldn't fail the
 * suite — retry once before recording status 0 (treated as a server error).
 * `waitUntil: 'commit'` resolves as soon as the response status arrives; the
 * hydration wait happens separately, only when harvesting.
 */
async function gotoStatus(page: Page, url: string): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await page.goto(url, { waitUntil: 'commit' });
      return res?.status() ?? 0;
    } catch {
      if (attempt >= 1) return 0;
      await page.waitForTimeout(500);
    }
  }
}

/**
 * Status-verify a batch of internal paths over raw HTTP, concurrently. This is
 * the exhaustive no-404 / no-5xx coverage for every discovered link the browser
 * didn't hydrate (the bounded-sample overflow) — status doesn't need a hydrated
 * DOM, so it's a plain request with no browser/settle cost and runs N-wide.
 * `maxRedirects: 0` makes same-origin 3xx (e.g. the AECI-165 `/vendors` →
 * `/products` redirects) surface as redirects, not as followed-through 200s.
 * One retry on a 0/5xx softens transient slow renders without masking a route
 * that's genuinely down (a real failure fails both attempts).
 */
async function sweepStatuses(
  req: APIRequestContext,
  paths: string[],
  parentOf: (path: string) => string | null,
  b: StatusBuckets,
): Promise<void> {
  const CONCURRENCY = 10;
  const getStatus = async (path: string): Promise<number> => {
    for (let attempt = 0; ; attempt++) {
      let status: number;
      try {
        const r = await req.get(path, { maxRedirects: 0, timeout: 20_000 });
        status = r.status();
      } catch {
        status = 0;
      }
      if ((status === 0 || status >= 500) && attempt < 1) continue;
      return status;
    }
  };
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const path = paths[next++]!;
      const status = await getStatus(path);
      recordStatus(path, parentOf(path), status, classifyPath(path), b);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, paths.length) }, () => worker()));
}

/**
 * Harvest hrefs from the HYDRATED DOM. Index/browse pages render row links
 * client-side from a non-blocking `httpResource` (AECI-126): the SSR shell shows
 * a loading row (`aria-busy="true"`) that's replaced by the real rows ~1s after
 * hydration fetches `/api/*`. So we can't just wait for the anchor set to "stop
 * growing" — the loading and error/empty states have the SAME link count, and a
 * naïve poll breaks during loading, before the rows paint. Instead we break only
 * once **no loading indicator remains AND the link set is stable** for two
 * consecutive polls. SSR-complete pages (home, detail, browse-via-resolver,
 * `/categories`) have no `aria-busy`, so they settle in ~2 polls; the leading
 * 400 ms lets hydration set `aria-busy` on client-list pages before we poll
 * (caps at ~9.5 s for a page whose data never arrives).
 */
async function harvestHydratedHrefs(page: Page): Promise<string[]> {
  await page.waitForLoadState('load').catch(() => undefined);
  await page.waitForTimeout(400);
  let prev = -1;
  let stable = 0;
  let hrefs: string[] = [];
  for (let i = 0; i < 30; i++) {
    const busy = await page.locator('[aria-busy="true"]').count();
    hrefs = await page
      .locator('a[href]')
      .evaluateAll((els) => els.map((a) => a.getAttribute('href') ?? '').filter((h) => h !== ''));
    if (busy === 0 && hrefs.length === prev) {
      if (++stable >= 2) break;
    } else {
      stable = 0;
    }
    prev = hrefs.length;
    await page.waitForTimeout(300);
  }
  return hrefs;
}

async function crawlSite(
  page: Page,
  req: APIRequestContext,
  seed: SeedInfo,
  baseUrl: string,
): Promise<CrawlResult> {
  const discovered = new Map<string, Discovered>();
  const reached = new Map<string, { status: number; type: PageType }>();
  const broken: LinkRef[] = [];
  const pending: LinkRef[] = [];
  const serverErrors: CrawlResult['serverErrors'] = [];
  const redirects: CrawlResult['redirects'] = [];
  const externalSeen = new Map<string, number>();
  const consoleErrors: CrawlResult['consoleErrors'] = [];
  const consoleWarnings: CrawlResult['consoleWarnings'] = [];
  const pageErrors: CrawlResult['pageErrors'] = [];
  const buckets: StatusBuckets = { reached, broken, pending, serverErrors, redirects };

  // AECI-162 — console health. Attach ONCE on the reused crawl page; listeners
  // persist across navigations and fire per message exactly once. Attribute via
  // `page.url()` read INSIDE the handler (the committed URL when the message
  // fired) rather than a mutable "current path" variable — non-racy by
  // construction. Each reached (2xx) page is settled before the next `goto` (the
  // harvest for depth < MAX_DEPTH, an explicit settle at MAX_DEPTH), so a page's
  // async tail fires while it's still current. A message in the microtask gap
  // right after the next commit can mis-attribute to the next page — rare,
  // acceptable for a gate (still a real visited page; the text names the source).
  //
  // We gate ONLY pages that rendered 2xx (`reached.has(path)`). A non-2xx
  // document (the intentional 404 placeholders, redirects) makes the browser log
  // "Failed to load resource: ...404" for the navigation itself — that's the
  // document status, not an app defect, and it's already gated by the no-404 /
  // no-5xx link assertions. The not-found SHELL's own console health is covered
  // by `not-found.spec.ts`.
  const here = (): string => {
    try {
      return stripLocale(new URL(page.url()).pathname);
    } catch {
      return page.url();
    }
  };
  page.on('console', (msg) => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    const path = here();
    if (!reached.has(path)) return;
    const text = msg.text();
    if (isIgnorableConsole(text)) return;
    (type === 'error' ? consoleErrors : consoleWarnings).push({ path, text });
  });
  page.on('pageerror', (err) => {
    const path = here();
    if (!reached.has(path)) return;
    if (isIgnorableConsole(err.message)) return;
    pageErrors.push({ path, message: err.message });
  });

  const queue: { path: string; depth: number; parent: string | null }[] = [];
  const enqueue = (path: string, depth: number, parent: string | null) => {
    if (discovered.has(path)) return;
    discovered.set(path, { depth, parent });
    queue.push({ path, depth, parent });
  };
  enqueue('/', 0, null);

  // Bounded hydrated BFS. Each page TYPE is hydrated at most BROWSER_SAMPLE_PER_TYPE
  // times (BFS visits a type's min-depth instance first, so reachability is exact);
  // overflow instances stay in `discovered` and are status-verified by the HTTP
  // sweep afterwards. Only sampled pages expand their children — same-type pages
  // surface the same link patterns, so the sampled set discovers every link type.
  const browserVisitsByType = new Map<PageType, number>();
  let browserVisited = 0;

  while (queue.length > 0) {
    const { path, depth, parent } = queue.shift()!;
    const type = classifyPath(path);
    const visits = browserVisitsByType.get(type) ?? 0;
    if (visits >= BROWSER_SAMPLE_PER_TYPE) {
      // Over this type's hydration budget. Leave it in `discovered`; the HTTP
      // sweep below status-checks it (no-404 / no-5xx coverage) without paying
      // for a browser nav + hydration settle, and we don't expand its children.
      continue;
    }
    browserVisitsByType.set(type, visits + 1);
    browserVisited++;

    const absUrl = new URL(path, baseUrl).toString();
    const status = await gotoStatus(page, absUrl);
    if (recordStatus(path, parent, status, type, buckets) !== 'reached') continue;

    if (depth >= MAX_DEPTH) {
      // Reached but we don't follow its links. `harvestHydratedHrefs` (the
      // per-page hydration settle) only runs on the depth < MAX_DEPTH branch
      // below, so settle here too — otherwise console output on depth-3 pages
      // wouldn't get a beat to fire before the next navigation.
      await waitForHydrationSettle(page).catch(() => undefined);
      continue;
    }

    const hrefs = await harvestHydratedHrefs(page);
    for (const href of hrefs) {
      const cls = classifyHref(href, absUrl);
      if (cls.kind === 'external') {
        externalSeen.set(href, (externalSeen.get(href) ?? 0) + 1);
        continue;
      }
      enqueue(cls.pathname, depth + 1, path);
    }
  }

  // Exhaustive, parallel HTTP status sweep over every discovered link the
  // browser didn't already resolve (the per-type overflow). This is the full
  // no-404 / no-5xx coverage — the browser proved reachability + console health
  // on a sample; status verification needs no hydration, so it runs N-wide here.
  const resolved = new Set<string>([
    ...reached.keys(),
    ...broken.map((r) => r.path),
    ...pending.map((r) => r.path),
    ...serverErrors.map((r) => r.path),
    ...redirects.map((r) => r.path),
  ]);
  const toSweep = [...discovered.keys()].filter((p) => !resolved.has(p));
  await sweepStatuses(req, toSweep, (p) => discovered.get(p)?.parent ?? null, buckets);

  return {
    baseUrl,
    seed,
    discovered,
    reached,
    broken,
    pending,
    serverErrors,
    redirects,
    externalSeen,
    consoleErrors,
    consoleWarnings,
    pageErrors,
    browserVisited,
    httpSwept: toSweep.length,
  };
}

/** Min-depth reached node of a given type, or null if the type wasn't reached. */
function bestReach(result: CrawlResult, type: PageType): { path: string; depth: number } | null {
  let best: { path: string; depth: number } | null = null;
  for (const [path, info] of result.reached) {
    if (info.type !== type) continue;
    const depth = result.discovered.get(path)?.depth ?? Number.POSITIVE_INFINITY;
    if (best === null || depth < best.depth) best = { path, depth };
  }
  return best;
}

/** Walk the BFS parent chain back to `/`, rendering each hop as its pattern. */
function shortestPathPatterns(result: CrawlResult, pathname: string): string {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = pathname;
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const type = classifyPath(cur);
    chain.unshift(type === 'other' ? stripLocale(cur) : PATTERN_OF[type]);
    cur = result.discovered.get(cur)?.parent ?? null;
  }
  return chain.join(' → ');
}

// ---------------------------------------------------------------------------
// Report (snapshot).
// ---------------------------------------------------------------------------

// Playwright runs with cwd = `apps/web` for both the `test:e2e` script and a
// direct `playwright test` invocation (both are filtered to @aeci/web), so the
// report resolves beside this spec under `e2e/`. Avoids `import.meta.url`, which
// Playwright's loader can't transform in this ESM package.
const REPORT_PATH = join(process.cwd(), 'e2e', 'internal-link-graph-report.md');

function structuralRow(result: CrawlResult, type: PageType): string {
  const best = bestReach(result, type);
  if (best === null) {
    return `| ${TYPE_LABEL[type]} | \`${PATTERN_OF[type]}\` | ✗ unreachable | — | (not reached within ${MAX_DEPTH} hops) |`;
  }
  return `| ${TYPE_LABEL[type]} | \`${PATTERN_OF[type]}\` | ✓ | ${best.depth} | ${shortestPathPatterns(result, best.path)} |`;
}

function entityRow(result: CrawlResult, type: PageType): string {
  const present = hasData(result.seed, type);
  const best = bestReach(result, type);
  const reachable = best ? '✓' : present ? '✗ unreachable' : 'n/a (no data)';
  const depth = best ? String(best.depth) : '—';
  const path = best
    ? shortestPathPatterns(result, best.path)
    : present
      ? `(not reached within ${MAX_DEPTH} hops)`
      : '(no seeded data for this type)';
  return `| ${TYPE_LABEL[type]} | \`${PATTERN_OF[type]}\` | ${present ? 'yes' : 'no'} | ${reachable} | ${depth} | ${path} |`;
}

function writeReport(result: CrawlResult): void {
  const s = result.seed;
  const structuralRows = STRUCTURAL_TYPES.map((t) => structuralRow(result, t)).join('\n');
  const entityRows = ENTITY_BROWSE_TYPES.map((t) => entityRow(result, t)).join('\n');
  const pendingLines = result.pending.length
    ? result.pending
        .map((p) => `- \`${p.path}\` ← linked from \`${p.parent ?? '/'}\``)
        .sort()
        .join('\n')
    : '_none_';

  const md = `<!-- GENERATED by apps/web/e2e/internal-link-graph.spec.ts (AECI-64). Do not edit by hand; regenerate by running the spec. -->
# Internal-link graph reachability — snapshot

Phase 2 Spec §10 requires that from any page **every other Phase 2 page type is
reachable in ≤ ${MAX_DEPTH} hops**, and §15 gates Phase 2 completion on a
"crawler test [confirming] every entity reachable in ≤ ${MAX_DEPTH} hops from
\`/\`". This file is the snapshot written by that crawler
(\`internal-link-graph.spec.ts\`): a breadth-first crawl from \`/\` to depth
${MAX_DEPTH} **in a real (hydrated) browser** — index/browse row links render
client-side (non-blocking httpResource, AECI-126), so they only exist post-
hydration — keyed by pathname (query/hash stripped), following only **internal**
links. Paths are shown as **patterns**, not concrete slugs, so the snapshot
stays seed-stable and PR diffs stay meaningful.

To keep cost independent of catalog size (AECI-64), the hydrated browser crawl
visits at most **${BROWSER_SAMPLE_PER_TYPE} pages per type** — enough to prove
reachability (BFS reaches each type's min-depth instance first) and console
health, both of which are *per-type* contracts. Every other discovered internal
link is then status-checked by a **parallel HTTP sweep** (no hydration needed to
read a status code), so the no-404 / no-5xx gates still cover every discovered
link while the browser work stays O(page types), not O(catalog).

- **Environment crawled:** \`${result.baseUrl}\`
- **Seed totals (API):** products ${s.products}, vendors ${s.vendors}, integrations ${s.integrations}; taxonomy — categories ${s.categoriesTotal}, audiences-with-products ${s.audiencesWithProducts}, phases-with-products ${s.phasesWithProducts}

## Structural index page types

Always asserted reachable ≤ ${MAX_DEPTH}.

| Page type | URL pattern | Reachable | Min depth | Shortest path (patterns) |
|---|---|---|---|---|
${structuralRows}

## Entity & browse page types

Reachability is asserted **only for types that have data** ("Data" = yes). A
type with no data has nothing to reach and is skipped (not a failure).
\`discipline browse\` (audience) and \`phase browse\` are reachable **only at
depth ${MAX_DEPTH}**, via the \`TaxonomyBadge\` links on a product detail page —
the tightest constraint.

| Page type | URL pattern | Data | Reachable | Min depth | Shortest path (patterns) |
|---|---|---|---|---|---|
${entityRows}

## Known-pending links (intentional 404 placeholders)

Forward-reference links shipped ahead of their page (allowlisted in the spec;
they do **not** fail the no-404 gate). Remove the allowlist entry in
\`internal-link-graph.spec.ts\` when the page lands so the link becomes enforced.

${pendingLines}

## Crawl totals

| Metric | Count |
|---|---|
| Distinct internal pages reached (2xx) | ${result.reached.size} |
| Distinct internal pages discovered (incl. 404 / 5xx / redirect) | ${result.discovered.size} |
| — hydrated in browser (bounded ≤ ${BROWSER_SAMPLE_PER_TYPE}/type: reachability + console) | ${result.browserVisited} |
| — status-verified via parallel HTTP sweep (no-404 / no-5xx) | ${result.httpSwept} |
| Unexpected internal 404s | ${result.broken.length} |
| Internal 5xx / navigation failures | ${result.serverErrors.length} |
| Redirects (recorded, not followed) | ${result.redirects.length} |
| Distinct external links seen (recorded, never counted toward reach) | ${result.externalSeen.size} |

## Console health (AECI-162)

Captured across every visited page (§15.15). **Errors + uncaught page errors fail
the suite; warnings are reported, not gated** (matches the homepage smoke posture —
see \`console-capture.ts\`). Counts only — per-message detail is in the test output,
not this committed snapshot.

| Metric | Count |
|---|---|
| Console errors (gated) | ${result.consoleErrors.length} |
| Console warnings (reported, not gated) | ${result.consoleWarnings.length} |
| Uncaught page errors (gated) | ${result.pageErrors.length} |

_Counts are environment-dependent; the reachability tables above are the
seed-stable contract._
`;

  writeFileSync(REPORT_PATH, md);
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

test.describe('internal-link graph — href classification contract (AECI-64)', () => {
  test('external links never satisfy internal reach', () => {
    // Documents the AC: `<a href="https://...">` does NOT count as internal.
    expect(classifyHref('https://example.com/products/x', BASE_URL).kind).toBe('external');
    expect(classifyHref('//cdn.example.com/products/x', BASE_URL).kind).toBe('external');
    expect(classifyHref('mailto:hello@aecintegrations.com', BASE_URL).kind).toBe('external');
    expect(classifyHref('tel:+15551234567', BASE_URL).kind).toBe('external');
    expect(classifyHref('#main', BASE_URL).kind).toBe('external');

    const internal = classifyHref('/products/some-slug', BASE_URL);
    expect(internal.kind).toBe('internal');
    expect(internal.kind === 'internal' ? internal.pathname : null).toBe('/products/some-slug');
  });
});

test.describe('internal-link graph — ≤3-hop reachability (AECI-64)', () => {
  // One BFS crawl shared across the assertions, so run them serially in a single
  // worker (overrides the global `fullyParallel`).
  test.describe.configure({ mode: 'serial' });

  let result: CrawlResult;

  test.beforeAll(async () => {
    // Cost is now bounded by page TYPE, not catalog size: the browser hydrates
    // only BROWSER_SAMPLE_PER_TYPE pages per type (reachability + console health
    // are per-type contracts), and every other discovered link is status-checked
    // by the parallel HTTP sweep. So a full catalog (which previously pushed the
    // serial all-pages crawl from ~83 to ~334 hydrated pages and blew a 360s cap)
    // no longer scales the browser work. 240s leaves generous headroom for a slow
    // runner — the bounded sample (~dozens of hydrated pages) plus an N-wide HTTP
    // sweep — and the job's `timeout-minutes: 20` (deploy.yml) is the real
    // backstop against a genuine hang. Do NOT shrink the per-page settle waits in
    // `harvestHydratedHrefs` to "speed this up" — those let client-rendered links
    // materialise on the sampled pages; the lever for catalog growth is the
    // sample budget + HTTP sweep, not flakier settles.
    test.setTimeout(240_000);
    const browser = await chromium.launch();
    const context = await browser.newContext({ baseURL: BASE_URL });
    try {
      const seed = await probeSeed(context.request);
      const page = await context.newPage();
      result = await crawlSite(page, context.request, seed, BASE_URL);
    } finally {
      await context.close();
      await browser.close();
    }
    // Written before the assertions so the snapshot exists even if one fails.
    writeReport(result);
  });

  test('every internal link resolves (no unexpected 404s)', () => {
    const lines = result.broken.map((b) => `  ${b.path}  ← linked from ${b.parent ?? '(root)'}`);
    expect(
      result.broken,
      `Internal links that returned 404 (broken):\n${lines.join('\n')}\n` +
        `(Intentional placeholder routes are allowlisted: ${EXPECTED_PENDING_PREFIXES.join(', ')})`,
    ).toEqual([]);
  });

  test('no internal link returns 5xx (or fails to load)', () => {
    const lines = result.serverErrors.map(
      (s) =>
        `  ${s.path} → ${s.status === 0 ? 'navigation failed' : s.status}  ← linked from ${s.parent ?? '(root)'}`,
    );
    expect(
      result.serverErrors,
      `Internal links that 5xx'd / failed to load:\n${lines.join('\n')}`,
    ).toEqual([]);
  });

  test('no console errors or uncaught page errors on any visited page (§15.15)', () => {
    // The crawl attached console/pageerror listeners for its whole run and
    // settled every page it HYDRATED before navigating on, so this gate covers
    // every page type the browser reached (the bounded per-type sample — the
    // HTTP-swept overflow has no DOM to emit console output). Coverage narrows
    // naturally on a sparse DB (fewer pages visited) and stays green — no
    // `test.skip` needed (AC#4). Warnings are reported here, not gated (see file
    // header). `browserVisited`, not `reached.size`, is the honest console-checked
    // count: `reached` now also holds HTTP-swept 200s, which were never in a
    // browser and so were never console-listened.
    const checked = result.browserVisited;
    console.log(
      `[internal-link-graph] console-checked ${checked} hydrated page(s): ` +
        `${result.consoleErrors.length} error(s), ${result.consoleWarnings.length} warning(s), ` +
        `${result.pageErrors.length} uncaught page error(s)`,
    );
    if (result.consoleWarnings.length > 0) {
      console.log(
        '[internal-link-graph] console warnings (reported, not gated):\n' +
          result.consoleWarnings.map((w) => `  ${w.path}  ${w.text}`).join('\n'),
      );
    }

    const errorLines = result.consoleErrors.map((e) => `  ${e.path}  ${e.text}`);
    const pageErrorLines = result.pageErrors.map((e) => `  ${e.path}  ${e.message}`);
    expect(
      result.pageErrors,
      `Uncaught page errors on visited pages:\n${pageErrorLines.join('\n')}`,
    ).toEqual([]);
    expect(
      result.consoleErrors,
      `Console errors on visited pages:\n${errorLines.join('\n')}`,
    ).toEqual([]);
  });

  test('structural index page types are reachable in ≤ 3 hops', () => {
    const unreachable = STRUCTURAL_TYPES.filter((t) => bestReach(result, t) === null).map(
      (t) => `  ${TYPE_LABEL[t]} — expected via ${CANDIDATE_SOURCE[t]}`,
    );
    expect(
      unreachable,
      `Unreachable structural page types (≤ ${MAX_DEPTH} hops from /):\n${unreachable.join('\n')}`,
    ).toEqual([]);
  });

  test('entity & browse page types with data are reachable in ≤ 3 hops', () => {
    const expected = ENTITY_BROWSE_TYPES.filter((t) => hasData(result.seed, t));
    test.skip(
      expected.length === 0,
      'No entity/browse data seeded — nothing to assert. Structural, no-404, and no-5xx assertions still ran.',
    );
    const skipped = ENTITY_BROWSE_TYPES.filter((t) => !hasData(result.seed, t)).map(
      (t) => TYPE_LABEL[t],
    );
    if (skipped.length > 0) {
      console.log(`[internal-link-graph] no data — not asserted: ${skipped.join(', ')}`);
    }
    const unreachable = expected
      .filter((t) => bestReach(result, t) === null)
      .map((t) => `  ${TYPE_LABEL[t]} — expected via ${CANDIDATE_SOURCE[t]}`);
    expect(
      unreachable,
      `Seeded entity/browse page types that are unreachable (≤ ${MAX_DEPTH} hops from /):\n${unreachable.join('\n')}`,
    ).toEqual([]);
  });
});
