#!/usr/bin/env node
/**
 * Playwright `webServer` stand-in for an agent port (AECI-1955).
 *
 * `playwright.config.ts` runs this instead of `pnpm dev:bound` when
 * `AECI_WEB_PORT` names a non-default port and nothing answers on it.
 * `dev:bound` would put the SSR Worker on that port but the API Worker on the
 * reserved 8787, which belongs to the human's primary workspace. So the e2e
 * run stops here with a message instead of booting a stack nobody asked for.
 */
const port = process.env['AECI_WEB_PORT'] ?? '(unset)';

console.error(
  [
    `e2e: nothing answered on http://localhost:${port}/api/health.`,
    'The e2e runner does not boot dev:bound on a non-default AECI_WEB_PORT,',
    'because its API Worker would take the reserved port 8787.',
    'Boot the stack with `pnpm dev:agent`, then set AECI_WEB_PORT to the web port it printed.',
    'See docs/local-dev.md section 3.1.',
  ].join('\n'),
);
process.exit(1);
