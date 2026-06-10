/**
 * Lighthouse CI config — AECI-65 / Phase 2.19.
 *
 * Runs Lighthouse MOBILE against every live Phase 2 page type — plus the Phase 3
 * `/search` page (AECI-146) — on the local `dev:bound` SSR Worker (:8788), using
 * the committed seed fixtures (`supabase/fixtures/phase2-fixtures.sql`) so the
 * detail/browse pages have real content to measure. Replaces the Phase 1
 * single-`/`, desktop, parked config.
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
 *   - /search server-response-time (TTFB) ≤ 600ms — MISS-only (AECI-145)
 *
 * SEARCH ROUTE: `/search` is collected (AECI-146) and held SEO-exempt as a
 * noindex page (class C). AECI-145 adds the MISS-only TTFB budget (class D)
 * because `/search` is the one always-edge-MISS route (`private, no-store`) — so
 * its server-response-time gets a realistic budget rather than inheriting the
 * cached-page timing the other routes enjoy. `?q=…` is intentionally not
 * collected: in CI (no Algolia) it renders the identical degradation shell.
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
// NOINDEX page class. Both the 404 and `/search` (Phase 3, §4.6 — search results
// aren't canonical content) carry `robots: noindex`, which makes Lighthouse's SEO
// audit fail BY DESIGN. So neither is held to the SEO/best-practices score — they
// are asserted on perf/a11y/CWV only. Keeping `/search` out of the SEO assertion
// also means it won't emit a permanent spurious SEO warning here, and won't have
// to be special-cased when the warn→error flip lands (that flip is F1 / AECI-65's
// scope).
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
      // Collection dominates this job — 15 URLs × N runs × ~12s each. At the
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
        // (A) Every indexable URL (excludes the noindex 404 + /search): category
        // scores incl. SEO + Core Web Vitals.
        {
          matchingUrlPattern: INDEXABLE_URL_PATTERN,
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
        // (C) Noindex pages (404 + /search): perf / a11y / CWV only — NOT
        // SEO/best-practices (both carry `robots: noindex` by design).
        {
          matchingUrlPattern: NOINDEX_URL_PATTERN,
          aggregationMethod: 'median-run',
          assertions: {
            'categories:performance': ['warn', { minScore: 0.9 }],
            'categories:accessibility': ['warn', { minScore: 0.95 }],
            'largest-contentful-paint': ['warn', { maxNumericValue: 2500 }],
            'cumulative-layout-shift': ['warn', { maxNumericValue: 0.1 }],
          },
        },
        // (D) /search only (AECI-145): a MISS-only TTFB budget. `/search` is
        // `private, no-store`, so it never serves from an edge HIT — it's the one
        // page where a `server-response-time` budget is meaningful (every other
        // route normally HITs). 600ms is Lighthouse's own native pass threshold
        // and measures the SSR-shell document fetch — a CI proxy on `dev:bound`
        // (graceful-degradation shell, no Algolia round-trip), not production
        // search latency. TTFB is observed, not scaled by the simulate throttle.
        // perf/a11y/CWV are already covered by class (C); SEO/best-practices stay
        // out (noindex). This is the only assertion class that targets /search
        // exclusively, so it layers cleanly on the shared noindex class.
        {
          matchingUrlPattern: SEARCH_URL_PATTERN,
          aggregationMethod: 'median-run',
          assertions: {
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
