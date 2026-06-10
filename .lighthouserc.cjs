/**
 * Lighthouse CI config — AECI-65 / Phase 2.19.
 *
 * Runs Lighthouse MOBILE against every live Phase 2 page type — plus the Phase 3
 * `/search` page (AECI-146) — on the local `dev:bound` SSR Worker (:8788), using
 * the committed seed fixtures (`supabase/fixtures/phase2-fixtures.sql`) so the
 * detail/browse pages have real content to measure. Replaces the Phase 1
 * single-`/`, desktop, parked config.
 *
 * ENFORCEMENT POSTURE — PARTIAL ERROR GATE (AECI-188).
 *   AECI-65 / Phase 2 Spec §12 call for these budgets to BLOCK merge. They
 *   landed warn-only first (AECI-65, so the harness could never wedge `main`
 *   on day one); AECI-188 then flipped to `'error'` exactly the set every page
 *   measurably passes with wide margins (local N=3 + CI run 27262521501,
 *   2026-06-10): accessibility / best-practices / SEO / TBT, plus /search's
 *   TTFB. An error-level miss exits 1 and turns the post-merge lighthouse.yml
 *   run RED — that red means `main` already regressed; fix forward or revert.
 *   Performance / LCP / CLS and both JS-transfer budgets stay `'warn'` because
 *   multiple pages measurably miss them: AECI-221 owns fixing those misses and
 *   flipping the remainder (budgets are never lowered to pass, per the AECI-65
 *   rule recorded in TESTING_STRATEGY.md §10.4).
 *
 * BUDGETS (per §12, as targets):
 *   - Performance / Accessibility / Best-Practices / SEO ≥ 90 (mobile)
 *   - LCP ≤ 2.5s, CLS ≤ 0.1, TBT ≤ 200ms
 *   - Total JS transfer ≤ 200 KB on detail pages
 *   - /search server-response-time (TTFB) ≤ 600ms — MISS-only (AECI-145)
 *   - /search total JS transfer ≤ 500 KiB (AECI-188 — its own ceiling; the page
 *     lazy-loads the InstantSearch SDK, so the detail-page budget doesn't fit)
 *
 * SEARCH ROUTE: `/search` is collected (AECI-146) and held SEO-exempt as a
 * noindex page (class C). AECI-145 adds the MISS-only TTFB budget (class D)
 * because `/search` is the one always-edge-MISS route (`private, no-store`) — so
 * its server-response-time gets a realistic budget rather than inheriting the
 * cached-page timing the other routes enjoy. CI measures /search with the REAL
 * InstantSearch SDK: lighthouse.yml provisions ALGOLIA_SEARCH_KEY_PREVIEW into
 * apps/web/.dev.vars (AECI-188) — budgets measured against the degraded
 * "search unavailable" shell would be meaningless. `?q=…` is intentionally not
 * collected: the empty-query page already loads the full SDK + widgets, and a
 * pinned query would couple the budget to index contents.
 *
 * gzipped-vs-transfer NOTE: `resource-summary:script:size` measures TRANSFER
 * bytes (compressed as served — Cloudflare brotli/gzip), not uncompressed. It is
 * the page-level transferred-script ceiling here; the per-bundle gzip hard-fail
 * (TESTING_STRATEGY §10.2) stays in the size-limit / run-extra-tests.sh T7 path.
 *
 * REPRODUCIBILITY: fixed mobile viewport, pinned simulated Slow-4G throttle.
 * Runs ONCE by default (quick local passes); CI (lighthouse.yml) sets
 * `LHCI_RUNS=3` so the error gate asserts the median run, not a single noisy
 * one. Chrome comes from the CI runner image (a CHROME_PATH env can pin it
 * further); locking the exact Chrome build rides along with AECI-221.
 *
 * Fixture identities mirror supabase/fixtures/phase2-fixtures.sql and
 * apps/web/e2e/phase2-a11y.spec.ts. Taxonomy slugs are existing reference data.
 */

// AECI_LHCI_URL (NOT `LHCI_URL`): lhci parses every `LHCI_*` env var as a CLI
// flag (yargs env-prefix), so `LHCI_URL` used to become `--url=<base>` and
// silently REPLACED this whole 15-URL collection list with the bare base URL.
// The AECI_ prefix keeps the local-override mechanism out of lhci's namespace.
// (`LHCI_RUNS` below is intentionally NOT renamed: `runs` matches no lhci flag,
// so it passes through harmlessly — and the CI workflow already sets it.)
const baseUrl = process.env.AECI_LHCI_URL || 'http://localhost:8788';

// Detail / browse pages (single entity under a facet/collection segment). Used
// for the detail-only JS budget; excludes the flat indexes (/products, /vendors,
// /integrations, /categories, /audiences, /phases) which have no trailing segment.
const DETAIL_URL_PATTERN =
  '/(?:products|vendors|integrations|categories|audiences|phases)/[^/?#]+$';
// NOINDEX page class. Both the 404 and `/search` (Phase 3, §4.6 — search results
// aren't canonical content) carry `robots: noindex`, which makes Lighthouse's SEO
// audit fail BY DESIGN. So neither is held to the SEO/best-practices score — they
// are asserted on perf/a11y/CWV only. Keeping `/search` out of the SEO assertion
// is what lets the AECI-188 error gate hold the indexable class to SEO at error
// level without a permanent spurious red from these two pages.
const NOT_FOUND_SLUG = 'aeci-65-no-such-page';
const NOINDEX_URL_PATTERN = `(?:${NOT_FOUND_SLUG}|/search)`;
const INDEXABLE_URL_PATTERN = `^(?!.*${NOINDEX_URL_PATTERN}).*$`;
// `/search`-only matcher (AECI-145). Unlike the 404, `/search` is `private,
// no-store` — the one route that is ALWAYS an edge MISS — so it gets a MISS-only
// TTFB budget (class D below) on top of the noindex class's perf/a11y/CWV. The
// `(?:[/?]|$)` boundary keeps the match correct if `?q=` is ever collected.
const SEARCH_URL_PATTERN = '/search(?:[/?]|$)';

module.exports = {
  ci: {
    collect: {
      url: [
        `${baseUrl}/`, // home page (AECI-187) — indexable (class A): scores + CWV
        `${baseUrl}/products`, // product index
        `${baseUrl}/products/fixture-procore`, // product detail
        `${baseUrl}/vendors`, // vendor index
        `${baseUrl}/vendors/fixture-procore-technologies`, // vendor detail
        `${baseUrl}/integrations`, // integration index
        `${baseUrl}/integrations/00000000-0000-4000-8000-000000000065`, // integration detail
        `${baseUrl}/categories/project-management`, // category browse
        `${baseUrl}/audiences/general-contracting`, // audience browse
        `${baseUrl}/phases/construction`, // phase browse
        `${baseUrl}/categories`, // categories flat index
        `${baseUrl}/audiences`, // audiences flat index (AECI-157)
        `${baseUrl}/phases`, // phases flat index (AECI-157)
        `${baseUrl}/search`, // Phase 3 search page (AECI-146) — noindex, SEO-exempt
        `${baseUrl}/${NOT_FOUND_SLUG}`, // 404
      ],
      // Collection dominates this job — 15 URLs × N runs × ~12s each. N=3 takes
      // ~7m50s; a SINGLE run lands at ~2m40s. The DEFAULT stays 1 for quick
      // local passes; CI (lighthouse.yml) sets LHCI_RUNS=3 because the AECI-188
      // error gate asserts the median run — one noisy run must not redden main.
      // `aggregationMethod: 'median-run'` degrades cleanly to "the only run" at N=1.
      numberOfRuns: Number(process.env.LHCI_RUNS) || 1,
      settings: {
        // Mobile, pinned for reproducibility. No `preset` — the Lighthouse
        // default IS mobile; these explicit settings make it deterministic.
        formFactor: 'mobile',
        screenEmulation: {
          mobile: true,
          width: 412,
          height: 823,
          deviceScaleFactor: 1.75,
          disabled: false,
        },
        throttlingMethod: 'simulate',
        throttling: {
          // Lighthouse "Slow 4G" mobile preset — pinned numerics.
          rttMs: 150,
          throughputKbps: 1638.4,
          requestLatencyMs: 562.5,
          downloadThroughputKbps: 1474.56,
          uploadThroughputKbps: 675,
          cpuSlowdownMultiplier: 4,
        },
        // Don't abort on a non-2xx document. Required for the themed 404 (which
        // returns a real HTTP 404 by design — Lighthouse otherwise errors with
        // ERRORED_DOCUMENT_REQUEST and aborts the whole run). When fixtures
        // aren't seeded and a detail URL 404s, the run still audits what's
        // served — the 404 shell then fails the error-level SEO assertions
        // (class A), which is the deliberate unseeded-dev-DB alarm (AECI-188)
        // rather than an aborted collection.
        ignoreStatusCode: true,
        // `canonical` (SEO) + `uses-http2` are noise on a local dev origin.
        skipAudits: ['uses-http2', 'canonical'],
      },
    },
    assert: {
      // assertMatrix (not `assertions`) so per-URL-class budgets are possible:
      // the JS budget targets detail pages, and the noindex 404 is exempt from
      // the SEO/best-practices score.
      assertMatrix: [
        // (A) Every indexable URL (excludes the noindex 404 + /search): category
        // scores incl. SEO + Core Web Vitals. ERROR = a11y / best-practices /
        // SEO / TBT (measured margins are wide: a11y 1.00, BP ≥0.96, SEO 1.00,
        // TBT ≤45ms vs 200). WARN = perf / LCP / CLS — multiple pages miss them
        // today; AECI-221 owns the fixes + the remaining flip.
        {
          matchingUrlPattern: INDEXABLE_URL_PATTERN,
          aggregationMethod: 'median-run',
          assertions: {
            'categories:performance': ['warn', { minScore: 0.9 }],
            'categories:accessibility': ['error', { minScore: 0.95 }],
            'categories:best-practices': ['error', { minScore: 0.9 }],
            'categories:seo': ['error', { minScore: 0.9 }],
            'largest-contentful-paint': ['warn', { maxNumericValue: 2500 }],
            'cumulative-layout-shift': ['warn', { maxNumericValue: 0.1 }],
            'total-blocking-time': ['error', { maxNumericValue: 200 }],
          },
        },
        // (B) Detail / browse pages only: total JS transfer ≤ 200 KB. Stays
        // WARN — every detail/browse page measures ~300–317 KiB today (~100 KiB
        // over); AECI-221 owns the bundle work, and the budget is NOT raised to
        // pass (AECI-65 rule).
        {
          matchingUrlPattern: DETAIL_URL_PATTERN,
          aggregationMethod: 'median-run',
          assertions: {
            'resource-summary:script:size': ['warn', { maxNumericValue: 204800 }],
          },
        },
        // (C) Noindex pages (404 + /search): perf / a11y / CWV only — NOT
        // SEO/best-practices (both carry `robots: noindex` by design). a11y is
        // ERROR (404 measures 1.00; /search 0.98 with the real InstantSearch
        // SDK mounted); perf / LCP / CLS stay WARN (AECI-221 — /search CLS
        // 0.426 is the known worst miss).
        {
          matchingUrlPattern: NOINDEX_URL_PATTERN,
          aggregationMethod: 'median-run',
          assertions: {
            'categories:performance': ['warn', { minScore: 0.9 }],
            'categories:accessibility': ['error', { minScore: 0.95 }],
            'largest-contentful-paint': ['warn', { maxNumericValue: 2500 }],
            'cumulative-layout-shift': ['warn', { maxNumericValue: 0.1 }],
          },
        },
        // (D) /search only (AECI-145 + AECI-188). TTFB: `/search` is `private,
        // no-store`, so it never serves from an edge HIT — it's the one page
        // where a `server-response-time` budget is meaningful (every other
        // route normally HITs). 600ms is Lighthouse's own native pass threshold
        // and measures the SSR-shell document fetch on `dev:bound` (the
        // document itself involves no Algolia round-trip — InstantSearch loads
        // browser-side), not production search latency. TTFB is observed, not
        // scaled by the simulate throttle; measured ~44ms, so ERROR is safe.
        // JS budget (AECI-188): /search skips class (B)'s detail-page 200 KB —
        // it lazy-loads the InstantSearch SDK — and carries its own ceiling
        // instead: 500 KiB = measured 458.6 KiB with the real SDK (byte-
        // identical across N=3) ×1.1, rounded. WARN like every JS budget until
        // AECI-221 flips them together. perf/a11y/CWV are already covered by
        // class (C); SEO/best-practices stay out (noindex).
        {
          matchingUrlPattern: SEARCH_URL_PATTERN,
          aggregationMethod: 'median-run',
          assertions: {
            'server-response-time': ['error', { maxNumericValue: 600 }],
            'resource-summary:script:size': ['warn', { maxNumericValue: 512000 }],
          },
        },
      ],
    },
    upload: {
      // Keep reports as job artifacts (assertion output = metric + value). Wire
      // to an LHCI Server for trend tracking alongside the AECI-221 perf work.
      target: 'temporary-public-storage',
    },
  },
};
