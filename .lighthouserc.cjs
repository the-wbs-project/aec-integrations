/**
 * Lighthouse CI config for AECI-33 / Phase 1.19.
 *
 * Phase 1: warn-only. Assertions surface in the CI summary but never block
 * a merge — per `docs/CICD_PLAN.md` §8 and the AECI-33 spec. Enforcement
 * flips to "error" in Phase 7 once the home / product / vendor / search
 * pages are real surfaces with stable performance characteristics.
 *
 * Thresholds mirror `docs/TESTING_STRATEGY.md` §10. Bundle-size budgets
 * are tracked separately by `apps/web/scripts/run-extra-tests.sh` (T7
 * pattern from stack-test); not duplicated here.
 *
 * Target URL: when LHCI_URL is set (CI preview job), uses that; otherwise
 * defaults to the local SSR Worker on :8788.
 */

const baseUrl = process.env.LHCI_URL || 'http://localhost:8788';

/**
 * @type {import('@lhci/cli').LhciConfig}
 */
module.exports = {
  ci: {
    collect: {
      url: [
        `${baseUrl}/`,
        // Phase 2+ surfaces — uncomment as they ship.
        // `${baseUrl}/products/procore`,
        // `${baseUrl}/vendors/procore-technologies`,
        // `${baseUrl}/search?q=Procore`,
      ],
      numberOfRuns: 1,
      settings: {
        // Run on desktop in Phase 1. Mobile profile added in Phase 7 alongside
        // cross-device QA.
        preset: 'desktop',
        // Skip Chromium-specific checks that don't apply in CI sandboxes.
        skipAudits: ['uses-http2', 'canonical'],
      },
    },
    assert: {
      assertions: {
        // Core Web Vitals — warn in Phase 1, errors in Phase 7.
        'largest-contentful-paint': ['warn', { maxNumericValue: 2500 }],
        'cumulative-layout-shift': ['warn', { maxNumericValue: 0.1 }],
        'total-blocking-time': ['warn', { maxNumericValue: 200 }],
        // Category-level scores. Accessibility flips to error in Phase 7.
        'categories:performance': ['warn', { minScore: 0.8 }],
        'categories:accessibility': ['warn', { minScore: 0.95 }],
        'categories:best-practices': ['warn', { minScore: 0.9 }],
        'categories:seo': ['warn', { minScore: 0.9 }],
      },
    },
    upload: {
      // Phase 1: keep reports as job artifacts only. Wire to LHCI Server
      // (`temporary-public-storage` or self-hosted) in Phase 7 for trend
      // tracking.
      target: 'temporary-public-storage',
    },
  },
};
