/**
 * AECI-580 / Phase 8.3 P1.6 — the System status screen at `/admin/system`.
 *
 * Coverage here is the SSR auth gate and the caching invariant. The *authenticated*
 * render is exercised in `authed-console.spec.ts`, which mints a real admin
 * session — the same split `admin-reviews.spec.ts` documents: the admin surface
 * authorizes server-side via `adminSummaryResolver` → `GET /api/admin/summary`
 * (`requireAdmin()`), which a dummy cookie can't satisfy and `page.route` can't
 * stub (it's a service-binding call inside the SSR Worker).
 *
 * The endpoint's own deny matrix (anon → 401, non-admin → 403, banned admin →
 * 403) lives in `apps/api/src/routes/admin-panel.authz-matrix.spec.ts`, against
 * the real `requireAdmin()` guard.
 */
import { expect, test } from '@playwright/test';

const ADMIN_SYSTEM_PATH = '/admin/system';

test.describe('/admin/system — SSR auth gate (AECI-580)', () => {
  test('redirects a logged-out visitor to /auth/login with the return path', async ({
    request,
  }) => {
    const res = await request.get(ADMIN_SYSTEM_PATH, { maxRedirects: 0 });
    expect(res.status()).toBe(303);
    expect(res.headers()['location']).toBe(
      `/auth/login?return=${encodeURIComponent(ADMIN_SYSTEM_PATH)}`,
    );
    // §9.2: /admin/* is absent from ROUTE_CACHE_PATTERNS, so it takes the
    // fail-closed non-cacheable branch. A cached admin response is a
    // visitor-state leak.
    expect(res.headers()['cache-control']).toBe('private, no-store');
    expect(res.headers()['cache-tag']).toBeUndefined();
  });

  test('the API endpoint is admin-gated and never cached', async ({ request }) => {
    const res = await request.get('/api/admin/system', { maxRedirects: 0 });
    // No session → the API Worker's requireAdmin() rejects before any handler runs.
    expect(res.status()).toBe(401);
    expect(res.headers()['cache-control']).toBe('private, no-store');
    expect(res.headers()['cache-tag']).toBeUndefined();
  });
});
