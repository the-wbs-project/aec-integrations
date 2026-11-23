import type { PlaywrightTestConfig } from '@playwright/test';
import { RESERVED_WEB_PORT } from './base-url';

type WebServerConfig = NonNullable<PlaywrightTestConfig['webServer']>;

/** The guard `webServer` command on an agent port (AECI-1955). Repo-root relative. */
export const NO_LOCAL_STACK_COMMAND = 'node apps/web/scripts/e2e-no-local-stack.mjs';

/**
 * Chooses Playwright's `webServer` block. Pure, so `web-server.unit.spec.ts`
 * can pin every branch without booting a stack.
 *
 * - `PLAYWRIGHT_BASE_URL` set: no webServer. The stack is already up (a
 *   deployed tier, or CI's own `dev:bound` step).
 * - Default port 8788: `pnpm dev:bound`, reused if it already answers locally.
 * - Any other `AECI_WEB_PORT`: the fail-fast guard. With `reuseExistingServer`
 *   it only runs when nothing answers, so a live `dev:agent` stack is reused.
 *   `dev:bound` is never booted there, because its API Worker would take the
 *   reserved 8787 (AECI-1955).
 */
export function resolveWebServer(
  env: Readonly<Record<string, string | undefined>>,
): WebServerConfig | undefined {
  if (env['PLAYWRIGHT_BASE_URL']) return undefined;
  const port = env['AECI_WEB_PORT'] ?? RESERVED_WEB_PORT;
  const isCi = !!env['CI'];
  return {
    // `pnpm dev:bound` boots both API (:8787) and SSR (:8788) Workers in
    // parallel so the SSR Worker's service binding (`env.API`) resolves.
    // `cwd: '../..'` is the monorepo root from the config's location.
    command: port === RESERVED_WEB_PORT ? 'pnpm dev:bound' : NO_LOCAL_STACK_COMMAND,
    cwd: '../..',
    // Probe `/api/health`, NOT the SSR root `/`. The SSR Worker answers `/`
    // with 200 the instant it boots — before the API Worker has registered
    // its service binding — so gating on `/` lets the first API-dependent
    // test fire into a `Worker "aeci-api" not found` failure that
    // the SSR layer renders as a 404 (the cold-start flake this guards
    // against). `/api/health` proxies through `env.API` and only returns 200
    // once the binding is connected AND `SELECT 1` succeeds; binding-down /
    // DB-down return 5xx, which Playwright (ready iff status in [200,404))
    // keeps polling past. So tests don't start until the API is serving.
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: !isCi,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  };
}
