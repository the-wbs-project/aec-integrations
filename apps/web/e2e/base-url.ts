/**
 * The one place the e2e suite derives the SSR origin (AECI-1449).
 *
 * `playwright.config.ts` feeds this into `use.baseURL`, and specs that need an
 * absolute origin outside a test (a `beforeAll` request context, a cookie
 * domain, a session mint) import it rather than rebuilding it. `beforeAll`
 * hooks don't receive the test-scoped `baseURL` fixture, which is why those
 * specs once carried their own `localhost:8788` literal and broke on every
 * `pnpm dev:agent` port pair.
 *
 * Resolution: `PLAYWRIGHT_BASE_URL` (a deployed tier, or an already-running
 * stack) wins; otherwise `AECI_WEB_PORT` on localhost; otherwise the reserved
 * conductor/CI port 8788. An agent workspace sets `AECI_WEB_PORT` to the web
 * port `dev:agent` printed and nothing else.
 */
export const E2E_WEB_PORT = process.env['AECI_WEB_PORT'] ?? '8788';
export const E2E_BASE_URL =
  process.env['PLAYWRIGHT_BASE_URL'] ?? `http://localhost:${E2E_WEB_PORT}`;
