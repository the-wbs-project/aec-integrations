import { defineConfig, devices } from '@playwright/test';

// Playwright config for the SSR Worker (apps/web).
//
// Local: launches `pnpm dev:bound` (parallel API + SSR Workers) via `webServer`
// so the service binding `env.API` resolves end-to-end.
// CI (preview-URL job): `PLAYWRIGHT_BASE_URL` is set; `webServer` is skipped.
//
// Phase 1.19: chromium-only smoke + axe. Cross-browser / mobile deferred to
// Phase 7 per `docs/TESTING_STRATEGY.md` §7 and the AECI-33 spec.

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:8788';
const IS_CI = !!process.env['CI'];

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: IS_CI,
  retries: IS_CI ? 1 : 0,
  workers: IS_CI ? 1 : undefined,
  reporter: IS_CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Only launch the local web server when targeting localhost. When a preview
  // URL is supplied via env, the Workers are already deployed.
  webServer: process.env['PLAYWRIGHT_BASE_URL']
    ? undefined
    : {
        // `pnpm dev:bound` boots both API (:8787) and SSR (:8788) Workers in
        // parallel so the SSR Worker's service binding (`env.API`) resolves.
        // `cwd: '../..'` is the monorepo root from this config's location.
        command: 'pnpm dev:bound',
        cwd: '../..',
        // Probe `/api/health`, NOT the SSR root `/`. The SSR Worker answers `/`
        // with 200 the instant it boots — before the API Worker has registered
        // its service binding — so gating on `/` lets the first API-dependent
        // test fire into a `Worker "aeci-api-preview" not found` failure that
        // the SSR layer renders as a 404 (the cold-start flake this guards
        // against). `/api/health` proxies through `env.API` and only returns 200
        // once the binding is connected AND `SELECT 1` succeeds; binding-down /
        // DB-down return 5xx, which Playwright (ready iff status in [200,404))
        // keeps polling past. So tests don't start until the API is serving.
        url: 'http://localhost:8788/api/health',
        reuseExistingServer: !IS_CI,
        timeout: 180_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
