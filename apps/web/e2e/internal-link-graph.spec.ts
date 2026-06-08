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
 * following only INTERNAL links. It then asserts:
 *   - no internal link 404s (every internal link resolves) — except a small,
 *     explicit allowlist of forward-reference placeholder routes whose pages
 *     aren't built yet (see EXPECTED_PENDING_PREFIXES);
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
 * (`/audiences/:slug`, kind="audience"). There are no audience/phase INDEX pages
 * (deferred — `app.routes.ts`), so discipline + phase browse are reachable only
 * at depth exactly 3, via the `TaxonomyBadge` links on a product detail page —
 * the tightest constraint and the most likely to regress.
 *
 * Every run writes `e2e/internal-link-graph-report.md` (a seed-stable,
 * type-level snapshot) in `beforeAll`, before the assertions, so it is produced
 * even when an assertion later fails (CI uploads it as an `if: always()`
 * artifact).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium, expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Mirrors `playwright.config.ts`'s BASE_URL default. `beforeAll` hooks don't
// receive the test-scoped fixtures, so we recompute it from the same env var
// the config reads and launch our own browser.
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:8788';

// "≤ 3 hops": `/` is depth 0, header-nav indexes depth 1, details depth 2,
// product-detail `TaxonomyBadge` links depth 3. We visit nodes up to depth 3
// (to 404-check + classify them) but only follow links out of nodes at depth
// < 3.
const MAX_DEPTH = 3;

// ---------------------------------------------------------------------------
// Page-type taxonomy (the 10 Phase 2 page types in the AC + non-required pages).
// ---------------------------------------------------------------------------

type PageType =
  | 'product-index'
  | 'product-detail'
  | 'vendor-index'
  | 'vendor-detail'
  | 'integration-index'
  | 'integration-detail'
  | 'categories'
  | 'category-browse'
  | 'discipline-browse' // = /audiences/:slug (audience browse)
  | 'phase-browse'
  | 'home'
  | 'other';

const PATTERN_OF: Record<PageType, string> = {
  'product-index': '/products',
  'product-detail': '/products/:slug',
  'vendor-index': '/vendors',
  'vendor-detail': '/vendors/:slug',
  'integration-index': '/integrations',
  'integration-detail': '/integrations/:id',
  categories: '/categories',
  'category-browse': '/categories/:slug',
  'discipline-browse': '/audiences/:slug',
  'phase-browse': '/phases/:slug',
  home: '/',
  other: '(other)',
};

const TYPE_LABEL: Record<PageType, string> = {
  'product-index': 'product index',
  'product-detail': 'product detail',
  'vendor-index': 'vendor index',
  'vendor-detail': 'vendor detail',
  'integration-index': 'integration index',
  'integration-detail': 'integration detail',
  categories: '/categories (flat list)',
  'category-browse': 'category browse',
  'discipline-browse': 'discipline browse (audience)',
  'phase-browse': 'phase browse',
  home: 'home',
  other: 'other',
};

// Always asserted. Index shells render `200` from the header nav regardless of
// data; `/categories` needs taxonomy seeded (CI seeds it).
const STRUCTURAL_TYPES: PageType[] = [
  'product-index',
  'vendor-index',
  'integration-index',
  'categories',
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
  'vendor-index': 'site-header primary nav → /vendors',
  'integration-index': 'site-header primary nav → /integrations',
  categories: 'site-header primary nav → /categories',
  'product-detail': 'a /products index row → /products/:slug',
  'vendor-detail': 'a /vendors index row → /vendors/:slug',
  'integration-detail': 'an /integrations index row → /integrations/:id',
  'category-browse':
    'a /categories list entry or a product-detail category TaxonomyBadge → /categories/:slug',
  'discipline-browse': 'a product-detail audience TaxonomyBadge → /audiences/:slug',
  'phase-browse': 'a product-detail phase TaxonomyBadge → /phases/:slug',
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
  if (/^\/vendors\/[^/]+\/?$/.test(p)) return 'vendor-detail';
  if (/^\/vendors\/?$/.test(p)) return 'vendor-index';
  if (/^\/integrations\/[^/]+\/?$/.test(p)) return 'integration-detail';
  if (/^\/integrations\/?$/.test(p)) return 'integration-index';
  if (/^\/categories\/[^/]+\/?$/.test(p)) return 'category-browse';
  if (/^\/categories\/?$/.test(p)) return 'categories';
  if (/^\/audiences\/[^/]+\/?$/.test(p)) return 'discipline-browse';
  if (/^\/phases\/[^/]+\/?$/.test(p)) return 'phase-browse';
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
    case 'vendor-index':
    case 'integration-index':
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

async function crawlSite(page: Page, seed: SeedInfo, baseUrl: string): Promise<CrawlResult> {
  const discovered = new Map<string, Discovered>();
  const reached = new Map<string, { status: number; type: PageType }>();
  const broken: LinkRef[] = [];
  const pending: LinkRef[] = [];
  const serverErrors: CrawlResult['serverErrors'] = [];
  const redirects: CrawlResult['redirects'] = [];
  const externalSeen = new Map<string, number>();

  const queue: { path: string; depth: number; parent: string | null }[] = [];
  const enqueue = (path: string, depth: number, parent: string | null) => {
    if (discovered.has(path)) return;
    discovered.set(path, { depth, parent });
    queue.push({ path, depth, parent });
  };
  enqueue('/', 0, null);

  while (queue.length > 0) {
    const { path, depth, parent } = queue.shift()!;
    const absUrl = new URL(path, baseUrl).toString();

    let status: number;
    try {
      // `waitUntil: 'commit'` resolves as soon as the response arrives — we read
      // status here and do the hydration wait separately only when harvesting.
      const res = await page.goto(absUrl, { waitUntil: 'commit' });
      status = res?.status() ?? 0;
    } catch {
      // Navigation failure (timeout / net error) — as bad as a 5xx for reach.
      serverErrors.push({ path, parent, status: 0 });
      continue;
    }

    if (status >= 500 || status === 0) {
      serverErrors.push({ path, parent, status });
      continue;
    }
    if (status === 404) {
      (isExpectedPending(path) ? pending : broken).push({ path, parent });
      continue;
    }
    if (status >= 300 && status < 400) {
      redirects.push({ path, parent, status, location: null });
      continue;
    }
    if (status !== 200) {
      broken.push({ path, parent }); // 401/403/… — surface it
      continue;
    }

    reached.set(path, { status, type: classifyPath(path) });
    if (depth >= MAX_DEPTH) continue; // reached, but don't follow its links

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
| Unexpected internal 404s | ${result.broken.length} |
| Internal 5xx / navigation failures | ${result.serverErrors.length} |
| Redirects (recorded, not followed) | ${result.redirects.length} |
| Distinct external links seen (recorded, never counted toward reach) | ${result.externalSeen.size} |

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
    // Browser crawl over dozens of URLs, each with a hydration settle.
    test.setTimeout(180_000);
    const browser = await chromium.launch();
    const context = await browser.newContext({ baseURL: BASE_URL });
    try {
      const seed = await probeSeed(context.request);
      const page = await context.newPage();
      result = await crawlSite(page, seed, BASE_URL);
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
