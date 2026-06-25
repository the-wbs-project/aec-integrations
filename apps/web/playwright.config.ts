import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// AECI-235: the Playwright runner process doesn't inherit the Workers' `.dev.vars`,
// but `authed-console.spec.ts` mints a real Supabase session from `process.env`. For
// LOCAL runs, hydrate the four `SUPABASE_*` keys from `apps/web/.dev.vars` (cwd is
// `apps/web` under `pnpm --filter @aeci/web`). Never overwrites an already-set var, so
// CI's step `env:` wins. Absent file / keys → the spec skips. No new dependency.
function loadDevVarsAuthEnv(): void {
  const wanted = new Set([
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_TEST_USER_EMAIL',
    'SUPABASE_TEST_USER_PASSWORD',
  ]);
  let text: string;
  try {
    text = readFileSync(resolve(process.cwd(), '.dev.vars'), 'utf8');
  } catch {
    return; // no local .dev.vars — rely on process.env (CI) or skip
  }
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!wanted.has(key) || process.env[key]) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, '');
  }
}
loadDevVarsAuthEnv();

// Playwright config for the SSR Worker (apps/web).
//
// Local: launches `pnpm dev:bound` (parallel API + SSR Workers) via `webServer`
// so the service binding `env.API` resolves end-to-end.
// CI (preview-URL job): `PLAYWRIGHT_BASE_URL` is set; `webServer` is skipped.
//
// Phase 1.19: chromium-only smoke + axe. Cross-browser / mobile deferred to
// Phase 7 per `docs/TESTING_STRATEGY.md` §7 and the AECI-33 spec.

// Mirror the `AECI_WEB_PORT` override honored by `apps/web`'s `dev:preview`
// script (defaults to 8788). Lets a Conductor workspace run dev + e2e on its
// own port pair without colliding with sibling workspaces. A `PLAYWRIGHT_BASE_URL`
// (CI preview-URL job) still takes precedence and skips the local webServer.
const WEB_PORT = process.env['AECI_WEB_PORT'] ?? '8788';
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? `http://localhost:${WEB_PORT}`;
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
        url: `http://localhost:${WEB_PORT}/api/health`,
        reuseExistingServer: !IS_CI,
        timeout: 180_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
