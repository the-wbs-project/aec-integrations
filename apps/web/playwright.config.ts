import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { E2E_BASE_URL } from './e2e/base-url';
import { resolveWebServer } from './e2e/web-server';

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
    // AECI-522 — the vendor persona for `vendor-dashboard.spec.ts`.
    'SUPABASE_VENDOR_TEST_USER_EMAIL',
    'SUPABASE_VENDOR_TEST_USER_PASSWORD',
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
// so the service binding `env.API` resolves end-to-end. On a non-default
// `AECI_WEB_PORT` (an agent's `dev:agent` pair) it only reuses a running stack
// and fails fast when none answers (AECI-1955).
// CI boots `dev:bound` in its own step and sets `PLAYWRIGHT_BASE_URL`, so `webServer` is skipped.
//
// Phase 1.19: chromium-only smoke + axe. There is no cross-browser / mobile
// lane (removed by AECI-1269); see `docs/TESTING_STRATEGY.md` §7.7.

// Mirror the `AECI_WEB_PORT` override honored by `apps/web`'s `dev:preview`
// script (defaults to 8788). Lets a Conductor workspace run dev + e2e on its
// own port pair without colliding with sibling workspaces. A `PLAYWRIGHT_BASE_URL`
// (a deployed tier such as staging) still takes precedence and skips the local webServer.
// The derivation lives in `e2e/base-url.ts` so specs that need the origin
// outside a test share it (AECI-1449).
const BASE_URL = E2E_BASE_URL;
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
  // Only launch the local web server when targeting localhost. When a deployed
  // URL is supplied via env, the Workers are already deployed. The branch logic
  // (default port, agent port, override) lives in `e2e/web-server.ts` so a unit
  // spec pins it (AECI-1955).
  webServer: resolveWebServer(process.env),
  // `*.unit.spec.ts` under `e2e/` are Vitest specs for the e2e helpers.
  testIgnore: '**/*.unit.spec.ts',
});
