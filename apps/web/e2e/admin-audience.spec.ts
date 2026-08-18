/**
 * AECI-586 / Phase 8.3 P5.1 — the Audience section at `/admin/audience`.
 *
 * Coverage here is the SSR auth gate, mirroring `admin-traffic.spec.ts`: a
 * logged-out visitor is 303-redirected to `/auth/login?return=<path>` (`private,
 * no-store`) by the worker-level `isAdminPath` gate, before SSR — so it needs no
 * fixture.
 *
 * The *authenticated* render is not exercised here for the same reason as the
 * other sections: the admin surface authorizes server-side via
 * `adminSummaryResolver` → `GET /api/admin/summary` (`requireAdmin()`), which a
 * dummy session cookie cannot satisfy and `page.route` cannot stub (it is a
 * service-binding call inside the SSR Worker). The authed hydrate runs in
 * `authed-console.spec.ts`, which mints a real session; the page's logic, its
 * empty states and its structural a11y are covered by `audience.component.spec.ts`.
 *
 * The cache assertion is not incidental. §9.2 requires `/admin/*` to stay absent
 * from `ROUTE_CACHE_PATTERNS`, and this route carries more than aggregates: the
 * feedback inbox renders submitter email addresses, so a cached response here
 * would leak contact information a person gave to the operator, not to the web.
 */
import { expect, test } from '@playwright/test';

const ADMIN_AUDIENCE_PATH = '/admin/audience';

test.describe('/admin/audience — SSR auth gate (AECI-586)', () => {
  test('redirects a logged-out visitor to /auth/login with the return path', async ({
    request,
  }) => {
    const res = await request.get(ADMIN_AUDIENCE_PATH, { maxRedirects: 0 });
    expect(res.status()).toBe(303);
    expect(res.headers()['location']).toBe(
      `/auth/login?return=${encodeURIComponent(ADMIN_AUDIENCE_PATH)}`,
    );
  });

  test('is never edge-cacheable (§9.2)', async ({ request }) => {
    const res = await request.get(ADMIN_AUDIENCE_PATH, { maxRedirects: 0 });
    expect(res.headers()['cache-control']).toBe('private, no-store');
    // A `Cache-Tag` here would mean the route had joined the cacheable branch.
    expect(res.headers()['cache-tag']).toBeUndefined();
  });
});
