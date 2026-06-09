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
 * gzipped-vs-transfer NOTE: `resource-summary:script:size` measures TRANSFER
 * bytes (compressed as served — Cloudflare brotli/gzip), not uncompressed. It is
 * the page-level transferred-script ceiling here; the per-bundle gzip hard-fail
 * (TESTING_STRATEGY §10.2) stays in the size-limit / run-extra-tests.sh T7 path.
 *
 * REPRODUCIBILITY: fixed mobile viewport, pinned simulated Slow-4G throttle,
 * median-of-3 runs. Chrome comes from the CI runner image (a CHROME_PATH env can
 * pin it further); locking the exact Chrome build is a follow-up alongside the
 * warn→error flip.
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
const NON_404_URL_PATTERN = `^(?!.*${NOT_FOUND_SLUG}).*$`;
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
        `${baseUrl}/${NOT_FOUND_SLUG}`, // 404
      ],
      numberOfRuns: 3,
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
      ],
    },
    upload: {
      // Keep reports as job artifacts (assertion output = metric + value). Wire
      // to an LHCI Server for trend tracking alongside the warn→error flip.
      target: 'temporary-public-storage',
    },
  },
};
