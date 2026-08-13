/**
 * AECI-576 / Phase 8.3 P1.2 — the operator console at `/admin/overview`.
 *
 * Coverage here is the SSR auth gate, the half that needs no fixture: a
 * logged-out visitor (no `sb-…-auth-token` cookie) is 303-redirected to
 * `/auth/login?return=<path>` (`private, no-store`) by the worker-level
 * `isAdminPath` gate, before SSR — for the new route and for `/admin` itself.
 * Mirrors `admin-reviews.spec.ts`.
 *
 * The two authorized cases live elsewhere, deliberately:
 *
 *   - **An admin loading the page** (and `/admin` → `/admin/overview`) is in
 *     `authed-console.spec.ts`, which mints a real Supabase session. It has to
 *     be there: `/admin/*` authorizes server-side inside the SSR Worker
 *     (`adminSummaryResolver` → `GET /api/admin/summary`, `requireAdmin()`),
 *     which a dummy cookie can't satisfy and `page.route()` can't stub — it is a
 *     service-binding call. That spec skips when `SUPABASE_TEST_USER_*` is unset.
 *
 *   - **A signed-in NON-admin getting the global 404** has no e2e home at all:
 *     there is exactly one seeded test user and it is an admin, so the scenario
 *     is unreachable from Playwright without provisioning a second Supabase
 *     account. It is covered instead by `admin-shell.component.spec.ts` (a null
 *     summary renders `<aec-not-found/>` with zero admin chrome) and
 *     `admin-summary.resolver.component.spec.ts` (401/403 → 404 + noindex head).
 *     Same posture the AECI-203 / AECI-205 admin specs already document.
 */
import { expect, test } from '@playwright/test';

const OVERVIEW_PATH = '/admin/overview';
const ADMIN_ROOT = '/admin';

test.describe('/admin/overview — SSR auth gate (AECI-576)', () => {
  for (const path of [OVERVIEW_PATH, ADMIN_ROOT]) {
    test(`redirects a logged-out visitor from ${path} to /auth/login with the return path`, async ({
      request,
    }) => {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status()).toBe(303);
      expect(res.headers()['location']).toBe(`/auth/login?return=${encodeURIComponent(path)}`);
      // §9.2: the console is never cacheable, not even its redirect away.
      expect(res.headers()['cache-control']).toBe('private, no-store');
    });
  }
});
