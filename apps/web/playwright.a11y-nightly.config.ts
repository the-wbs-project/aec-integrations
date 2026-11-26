import { defineConfig, devices, type ReporterDescription } from '@playwright/test';
import base from './playwright.config';
import { notInProject } from './e2e-a11y/support/browser-expectations';

// AECI-1875: the accessibility nightly. A separate Playwright config so the PR
// e2e job (`playwright.config.ts`, `testDir: './e2e'`) never sees `e2e-a11y/`.
// Its test count and duration stay as they are.
//
// Everything except the test directory, the reporters and the projects comes from
// the default config: the base URL (`e2e/base-url.ts`), the `webServer` block, the
// `.dev.vars` auth hydration and retries. Importing it runs that hydration once,
// as it does for the PR suite.
//
// Projects. `chromium` is the default config's own project and runs every suite.
// AECI-1885 (ADR 0060) adds `firefox` and `webkit`, here only, so the PR job stays
// Chromium only. They run the keyboard, focus ring and announcement suites and
// nothing else (`CROSS_BROWSER_SUITES`).
//
// Run with `pnpm test:a11y:nightly`, which takes every project. CI runs Chromium in
// `SUITE_SHARDS` shards (`--project=chromium --shard=N/8`) and each other browser in
// `CROSS_BROWSER_SHARDS` shards (`--project=<browser> --shard=N/3`), from
// `.github/workflows/a11y-nightly.yml`. `docs/TESTING_STRATEGY.md` §8.4 and §8.4.10
// explain the lane.
const IS_CI = !!process.env['CI'];

const reporter: ReporterDescription[] = [
  IS_CI ? ['github'] : ['list'],
  ['html', { open: 'never', outputFolder: 'playwright-report-a11y' }],
  // Writes `apps/web/a11y-nightly-summary.json`, the artifact the alert reads.
  ['./e2e-a11y/summary-reporter.ts'],
];

/**
 * The suites the Firefox and WebKit projects run (ADR 0060 "Scope"): the
 * keyboard walkthroughs (§8.4.1), the announcements (§8.4.4) and the focus ring
 * (§8.4.5). Nothing else, so the interaction, magnification and other suites
 * stay Chromium only.
 */
export const CROSS_BROWSER_SUITES = [
  /keyboard-[a-z]+\.spec\.ts$/,
  /announcements-[a-z-]+\.spec\.ts$/,
  /focus-ring\.spec\.ts$/,
];

export default defineConfig({
  ...base,
  testDir: './e2e-a11y',
  reporter,
  // Each project drops the tests tagged `@not-<its browser>`: a known barrier
  // found in another engine only (`notInTags` in browser-expectations.ts).
  projects: [
    ...(base.projects ?? []).map((p) => ({ ...p, grepInvert: notInProject('chromium') })),
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      testMatch: CROSS_BROWSER_SUITES,
      grepInvert: notInProject('firefox'),
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      testMatch: CROSS_BROWSER_SUITES,
      grepInvert: notInProject('webkit'),
    },
  ],
  // AECI-1877: committed text snapshots (the keyboard tab orders). Keyed by the
  // browser project, never by the OS, so a snapshot written on a Mac is the one
  // the Linux runner compares against. Update with `--update-snapshots`, and
  // review the diff: a changed tab order is a behaviour change. Playwright's
  // WebKit on macOS and on Linux are different ports, so a WebKit snapshot may
  // have to be written on the runner (AECI-1885, TESTING_STRATEGY.md §8.4.10).
  snapshotPathTemplate: '{testDir}/__snapshots__/{projectName}/{arg}{ext}',
});
