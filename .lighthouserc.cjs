/**
 * Lighthouse CI config — AECI-65 / Phase 2.19.
 *
 * Runs Lighthouse MOBILE against every live Phase 2 page type on the local
 * `dev:bound` SSR Worker (:8788), using the committed seed fixtures
 * (`supabase/fixtures/phase2-fixtures.sql`) so the detail/browse pages have real
 * content to measure. Replaces the Phase 1 single-`/`, desktop, parked config.
 *
 * ENFORCEMENT POSTURE — WARN-ONLY (deliberate, recorded).
 *   AECI-65 / Phase 2 Spec §12 call for these budgets to BLOCK merge. We land
 *   them WARN-only first (so the harness can never wedge `main` on day one) and
 *   flip to error-level in a follow-up once every page is confirmed green. This
 *   also reconciles the Phase 2 §12 "block" wording with `docs/CICD_PLAN.md` §8
 *   ("Lighthouse warn-only until enforcement"). See the AECI-65 PR + follow-up.
 *   To flip to blocking: change every `'warn'` below to `'error'`.
 *
 * BUDGETS (per §12, as targets):
 *   - Performance / Accessibility / Best-Practices / SEO ≥ 90 (mobile)
 *   - LCP ≤ 2.5s, CLS ≤ 0.1, TBT ≤ 200ms
 *   - Total JS transfer ≤ 200 KB on detail pages
 *
 * SEARCH ROUTE (AECI-145 / Phase 3.12): `/search` (browser-side Algolia
 * InstantSearch) is added with its OWN assertion class because it differs from
 * every Phase 2 page on two axes — it is `noindex` (so the SEO audit fails by
 * design, like the 404) and it is the only NO-CACHE route (`private, no-store`,
 * always an edge MISS). It is therefore SEO-exempt and carries a MISS-only TTFB
 * budget (`server-response-time`) instead of inheriting cached-page timing
 * assumptions. In CI there is no Algolia, so `/search` renders its
 * graceful-degradation shell — `?q=…` is intentionally NOT collected (it would
 * render the identical shell for zero added signal).
 *
 * gzipped-vs-transfer NOTE: `resource-summary:script:size` measures TRANSFER
 * bytes (compressed as served — Cloudflare brotli/gzip), not uncompressed. It is
 * the page-level transferred-script ceiling here; the per-bundle gzip hard-fail
 * (TESTING_STRATEGY §10.2) stays in the size-limit / run-extra-tests.sh T7 path.
 *
 * REPRODUCIBILITY: fixed mobile viewport, pinned simulated Slow-4G throttle.
 * Runs ONCE by default (this gate is warn-only — wall-clock matters more than
 * run-to-run median stability here). `LHCI_RUNS` overrides: set it to 3 to
 * restore the median when flipping the assertions to an error gate. Chrome comes
 * from the CI runner image (a CHROME_PATH env can pin it further); locking the
 * exact Chrome build is a follow-up alongside the warn→error flip.
 *
 * Fixture identities mirror supabase/fixtures/phase2-fixtures.sql and
 * apps/web/e2e/phase2-a11y.spec.ts. Taxonomy slugs are existing reference data.
 */

const baseUrl = process.env.LHCI_URL || 'http://localhost:8788';

// Detail / browse pages (single entity under a facet/collection segment). Used
// for the detail-only JS budget; excludes the flat indexes (/products, /vendors,
// /integrations, /categories, /audiences, /phases) which have no trailing segment.
const DETAIL_URL_PATTERN =
  '/(?:products|vendors|integrations|categories|audiences|phases)/[^/?#]+$';
// The 404 carries `noindex`, which makes Lighthouse's SEO audit fail by design —
// so the 404 is asserted on perf/a11y/CWV only, never SEO/best-practices.
const NOT_FOUND_SLUG = 'aeci-65-no-such-page';
// /search is ALSO noindex (AECI-145), so it gets the same SEO exemption: exclude
// it from the NON_404 class so that class's `categories:seo` assertion never
// fires on it. The `/search(?:[/?]|$)` boundary stays correct if `?q=` is ever
// added; no Phase 2 URL contains the literal "search", so class A is unaffected.
const SEARCH_URL_PATTERN = '/search(?:[/?]|$)';
const NON_404_URL_PATTERN = `^(?!.*${NOT_FOUND_SLUG})(?!.*${SEARCH_URL_PATTERN}).*$`;
const NOT_FOUND_URL_PATTERN = NOT_FOUND_SLUG;

module.exports = {
  ci: {
    collect: {
      url: [
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
        `${baseUrl}/search`, // search page (AECI-145) — noindex, no-cache; class D
        `${baseUrl}/${NOT_FOUND_SLUG}`, // 404
      ],
      // Collection dominates this job — 14 URLs × N runs × ~12s each. At the
      // former N=3 the run took ~7m50s; a SINGLE run lands it at ~2m40s. This
      // gate is warn-only/non-blocking, and its value is per-page-type coverage,
      // not run-to-run median smoothing, so default to one run. Restore the
      // median (LHCI_RUNS=3) when flipping the assertions below to 'error'.
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
        // ERRORED_DOCUMENT_REQUEST and aborts the whole run). Also makes the run
        // robust in the degraded state where fixtures aren't seeded and a detail
        // URL 404s — it audits what's served instead of failing the job.
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
        // (A) Every non-404 URL: category scores + Core Web Vitals.
        {
          matchingUrlPattern: NON_404_URL_PATTERN,
          aggregationMethod: 'median-run',
          assertions: {
            'categories:performance': ['warn', { minScore: 0.9 }],
            'categories:accessibility': ['warn', { minScore: 0.95 }],
            'categories:best-practices': ['warn', { minScore: 0.9 }],
            'categories:seo': ['warn', { minScore: 0.9 }],
            'largest-contentful-paint': ['warn', { maxNumericValue: 2500 }],
            'cumulative-layout-shift': ['warn', { maxNumericValue: 0.1 }],
            'total-blocking-time': ['warn', { maxNumericValue: 200 }],
          },
        },
        // (B) Detail / browse pages only: total JS transfer ≤ 200 KB.
        {
          matchingUrlPattern: DETAIL_URL_PATTERN,
          aggregationMethod: 'median-run',
          assertions: {
            'resource-summary:script:size': ['warn', { maxNumericValue: 204800 }],
          },
        },
        // (C) 404: perf / a11y / CWV only — NOT SEO/best-practices (noindex).
        {
          matchingUrlPattern: NOT_FOUND_URL_PATTERN,
          aggregationMethod: 'median-run',
          assertions: {
            'categories:performance': ['warn', { minScore: 0.9 }],
            'categories:accessibility': ['warn', { minScore: 0.95 }],
            'largest-contentful-paint': ['warn', { maxNumericValue: 2500 }],
            'cumulative-layout-shift': ['warn', { maxNumericValue: 0.1 }],
          },
        },
        // (D) /search (AECI-145): perf / a11y / best-practices / CWV, plus a
        // MISS-only TTFB budget — NOT SEO (noindex, same as the 404). `/search`
        // is the one route that is always an edge MISS (`private, no-store`), so
        // it's the only page where a `server-response-time` budget is meaningful;
        // every other route normally serves from an edge HIT. 600ms matches
        // Lighthouse's own native pass threshold for this audit and measures the
        // SSR-shell document fetch (a CI-only proxy on dev:bound, not production
        // search latency — TTFB is observed, not scaled by the simulate throttle).
        // /search does NOT match DETAIL_URL_PATTERN, so it skips the 200 KB JS
        // budget (class B) — correct, InstantSearch ships more than a detail page.
        {
          matchingUrlPattern: SEARCH_URL_PATTERN,
          aggregationMethod: 'median-run',
          assertions: {
            'categories:performance': ['warn', { minScore: 0.9 }],
            'categories:accessibility': ['warn', { minScore: 0.95 }],
            'categories:best-practices': ['warn', { minScore: 0.9 }],
            'largest-contentful-paint': ['warn', { maxNumericValue: 2500 }],
            'cumulative-layout-shift': ['warn', { maxNumericValue: 0.1 }],
            'total-blocking-time': ['warn', { maxNumericValue: 200 }],
            'server-response-time': ['warn', { maxNumericValue: 600 }],
          },
        },
      ],
    },
    upload: {
      // Keep reports as job artifacts (assertion output = metric + value). Wire
      // to an LHCI Server for trend tracking alongside the warn→error flip.
      target: 'temporary-public-storage',
    },
  },
};
