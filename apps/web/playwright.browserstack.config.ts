import { defineConfig, devices } from '@playwright/test';

// Phase 7.8 (AECI-154) — BrowserStack Automate cross-browser smoke config.
//
// Consumed ONLY by the BrowserStack Node SDK on the dedicated, NON-BLOCKING CI
// lane (`.github/workflows/browserstack.yml`), via:
//   pnpm run test:e2e:browserstack
//   → browserstack-node-sdk playwright test -- --config=playwright.browserstack.config.ts
//
// The SDK fans the device matrix declared in `browserstack.yml` over the specs
// this config selects (m specs × n platforms = m·n grid runs). Device selection
// therefore lives in `browserstack.yml`, NOT here — the `projects` entry below
// is a minimal placeholder the SDK overrides. This config owns three things:
// which specs run, the deployed target URL, and the CF-Access headers.
//
// The base/local chromium lane stays on `playwright.config.ts` and is untouched.

// Deployed target. Defaults to Access-gated staging; `demo.aecintegrations.com`
// is public (no headers needed) and can be supplied via the env override.
const TARGET_URL = process.env['BROWSERSTACK_TARGET_URL'] ?? 'https://staging.aecintegrations.com';

// CF Access service-token headers (docs/access.md §1). Playwright applies
// `extraHTTPHeaders` to top-level navigations AND sub-requests, so the real
// BrowserStack devices clear the Cloudflare Access edge gate over the public
// internet — no BrowserStackLocal tunnel (ADR 0012 §Decision-4). Omitted when
// the creds are absent (e.g. pointed at the public demo tier), which is a no-op.
const CF_ID = process.env['CF_ACCESS_CLIENT_ID'];
const CF_SECRET = process.env['CF_ACCESS_CLIENT_SECRET'];
const extraHTTPHeaders =
  CF_ID && CF_SECRET
    ? { 'CF-Access-Client-Id': CF_ID, 'CF-Access-Client-Secret': CF_SECRET }
    : undefined;

const IS_CI = !!process.env['CI'];

export default defineConfig({
  testDir: './e2e',
  // Curated cross-browser smoke subset — read-only critical-render journeys
  // only. The mutating journeys (auth-login, reviews-submission, account-delete,
  // product-reviews, admin-reviews) are intentionally EXCLUDED: they need the
  // TEST_MODE bypass and would write to shared staging; the chromium lane covers
  // them locally. Keep this list small — the parallel-session quota forbids the
  // full suite × N devices (ADR 0012 §Consequences).
  testMatch: [
    'smoke.spec.ts', // home shell + SSR boot
    'home.spec.ts', // "Browse by" faceted grids
    'products-detail.spec.ts', // product detail hero + tabs
    'search.spec.ts', // search (live InstantSearch — staging has Algolia)
    'facets.spec.ts', // facet filter → URL → grid → detail
  ],
  fullyParallel: true,
  forbidOnly: IS_CI,
  // Real-device cloud hops are flakier than local; one retry absorbs transient
  // network / device-allocation blips without masking real regressions.
  retries: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['junit', { outputFile: 'browserstack-results/junit.xml' }],
  ],
  use: {
    baseURL: TARGET_URL,
    extraHTTPHeaders,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // No Playwright `video`: unsupported on iOS real devices — BrowserStack
    // captures its own server-side session video instead.
  },
  // No `webServer`: the target is already deployed (mirrors the base config's
  // `PLAYWRIGHT_BASE_URL` branch).
  //
  // Minimal placeholder project; the real device fan-out comes from
  // `browserstack.yml`, which the SDK layers over this.
  projects: [{ name: 'browserstack', use: { ...devices['Desktop Chrome'] } }],
});
