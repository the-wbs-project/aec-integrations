import { defineConfig, type ReporterDescription } from '@playwright/test';
import { E2E_AXE_FLAG } from './e2e/axe-summary';
import base from './playwright.config';

// AECI-1876: the e2e suite with the axe sweep on, for the accessibility nightly.
//
// The same tests as the PR e2e job (`playwright.config.ts`, `testDir: './e2e'`).
// The only differences are the flag and the reporters. The flag turns on the
// `page` fixture's end-of-test axe scan (`e2e/fixtures.ts`). It is set here,
// before any worker starts, so every worker inherits it. A run of the default
// config never sets it, so the PR job is unchanged.
//
// Run with `pnpm test:e2e:axe`. CI runs it in four shards from
// `.github/workflows/a11y-nightly.yml`. `docs/TESTING_STRATEGY.md` §8.2 explains it.
process.env[E2E_AXE_FLAG] = '1';

const IS_CI = !!process.env['CI'];

const reporter: ReporterDescription[] = [
  IS_CI ? ['github'] : ['list'],
  ['html', { open: 'never', outputFolder: 'playwright-report-e2e-axe' }],
  // Writes `apps/web/a11y-e2e-axe-summary.json`. The nightly merges it with the
  // `e2e-a11y/` suite's summary (`scripts/a11y-nightly-merge-summary.mjs`).
  ['./e2e-a11y/summary-reporter.ts', { outputFile: 'a11y-e2e-axe-summary.json' }],
];

export default defineConfig({
  ...base,
  reporter,
});
