/**
 * AECI-859 / Phase 8.3 P5.2 — the subscriber roster at `/admin/subscribers`.
 *
 * Coverage here is the SSR auth gate, mirroring `admin-audience.spec.ts`: a
 * logged-out visitor is 303-redirected to `/auth/login?return=<path>` (`private,
 * no-store`) by the worker-level `isAdminPath` gate, before SSR — so it needs no
 * fixture.
 *
 * The *authenticated* render is not exercised here for the same reason as the
 * other sections: the admin surface authorizes server-side via
 * `adminSummaryResolver` → `GET /api/admin/summary` (`requireAdmin()`), which a
 * dummy session cookie cannot satisfy and `page.route` cannot stub (it is a
 * service-binding call inside the SSR Worker). The authed hydrate runs in
 * `authed-console.spec.ts`; the page's logic, its two distinct empty states and
 * its structural a11y are covered by `subscriber-list.component.spec.ts`.
 *
 * **The cache assertion is the load-bearing one on this route**, more so than on
 * any other admin screen. §9.2 requires `/admin/*` to stay absent from
 * `ROUTE_CACHE_PATTERNS`, and this page renders a table of nothing but email
 * addresses people gave to the operator. A cached response here would put the
 * whole mailing list in a shared cache.
 */
import { expect, test } from '@playwright/test';

const ADMIN_SUBSCRIBERS_PATH = '/admin/subscribers';

test.describe('/admin/subscribers — SSR auth gate (AECI-859)', () => {
  test('redirects a logged-out visitor to /auth/login with the return path', async ({
    request,
  }) => {
    const res = await request.get(ADMIN_SUBSCRIBERS_PATH, { maxRedirects: 0 });
    expect(res.status()).toBe(303);
    expect(res.headers()['location']).toBe(
      `/auth/login?return=${encodeURIComponent(ADMIN_SUBSCRIBERS_PATH)}`,
    );
  });

  test('is never edge-cacheable (§9.2)', async ({ request }) => {
    const res = await request.get(ADMIN_SUBSCRIBERS_PATH, { maxRedirects: 0 });
    expect(res.headers()['cache-control']).toBe('private, no-store');
    // A `Cache-Tag` here would mean the route had joined the cacheable branch.
    expect(res.headers()['cache-tag']).toBeUndefined();
  });
});
