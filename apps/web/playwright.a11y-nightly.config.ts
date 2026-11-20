import { defineConfig, type ReporterDescription } from '@playwright/test';
import base from './playwright.config';

// AECI-1875: the accessibility nightly. A separate Playwright config so the PR
// e2e job (`playwright.config.ts`, `testDir: './e2e'`) never sees `e2e-a11y/`.
// Its test count and duration stay as they are.
//
// Everything except the test directory and the reporters comes from the default
// config: the base URL (`e2e/base-url.ts`), the `webServer` block, the
// `.dev.vars` auth hydration, retries and the single chromium project. Importing
// it runs that hydration once, as it does for the PR suite.
//
// Run with `pnpm test:a11y:nightly`. CI runs it from `.github/workflows/a11y-nightly.yml`.
// `docs/TESTING_STRATEGY.md` §8.4 explains the lane.
const IS_CI = !!process.env['CI'];

const reporter: ReporterDescription[] = [
  IS_CI ? ['github'] : ['list'],
  ['html', { open: 'never', outputFolder: 'playwright-report-a11y' }],
  // Writes `apps/web/a11y-nightly-summary.json`, the artifact the alert reads.
  ['./e2e-a11y/summary-reporter.ts'],
];

export default defineConfig({
  ...base,
  testDir: './e2e-a11y',
  reporter,
});
