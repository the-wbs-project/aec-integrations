/**
 * AECI-578 / Phase 8.3 P1.4 — the Traffic section at `/admin/traffic`.
 *
 * Coverage here is the SSR auth gate, mirroring `admin-reviews.spec.ts`: a
 * logged-out visitor is 303-redirected to `/auth/login?return=<path>` (`private,
 * no-store`) by the worker-level `isAdminPath` gate, before SSR — so it needs no
 * fixture.
 *
 * The *authenticated* render is not exercised here for the same reason as the
 * reviews queue: the admin surface authorizes server-side via
 * `adminSummaryResolver` → `GET /api/admin/summary` (`requireAdmin()`), which a
 * dummy session cookie cannot satisfy and `page.route` cannot stub (it is a
 * service-binding call inside the SSR Worker). The authed hydrate + the live axe
 * pass run in `authed-console.spec.ts`, which mints a real session; the page's
 * logic and structural a11y are covered by `traffic.component.spec.ts`.
 *
 * The cache assertion is not incidental. §9.2 requires `/admin/*` to stay absent
 * from `ROUTE_CACHE_PATTERNS` — a cached admin response would be a visitor-state
 * leak, and this route is the first admin surface to render aggregate figures
 * that would be worth leaking.
 */
import { expect, test } from '@playwright/test';

const ADMIN_TRAFFIC_PATH = '/admin/traffic';

test.describe('/admin/traffic — SSR auth gate (AECI-578)', () => {
  test('redirects a logged-out visitor to /auth/login with the return path', async ({
    request,
  }) => {
    const res = await request.get(ADMIN_TRAFFIC_PATH, { maxRedirects: 0 });
    expect(res.status()).toBe(303);
    expect(res.headers()['location']).toBe(
      `/auth/login?return=${encodeURIComponent(ADMIN_TRAFFIC_PATH)}`,
    );
  });

  test('is never edge-cacheable (§9.2)', async ({ request }) => {
    const res = await request.get(ADMIN_TRAFFIC_PATH, { maxRedirects: 0 });
    expect(res.headers()['cache-control']).toBe('private, no-store');
    // A `Cache-Tag` here would mean the route had joined the cacheable branch.
    expect(res.headers()['cache-tag']).toBeUndefined();
  });
});
