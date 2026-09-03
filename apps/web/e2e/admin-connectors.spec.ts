/**
 * AECI-722 — the connector admin surface at `/admin/connectors` and
 * `/admin/connectors/:id`.
 *
 * Coverage here is the SSR auth gate: a logged-out visitor (no `sb-…-auth-token`
 * cookie) is 303-redirected to `/auth/login?return=<path>` (`private, no-store`)
 * by the worker-level `isAdminPath` gate, before SSR. This needs no fixture — the
 * gate fires before the resolver. Mirrors `admin-catalog.spec.ts`.
 *
 * The *authenticated* render is deliberately NOT exercised here: the admin
 * surface authorizes server-side via `adminSummaryResolver` → `GET
 * /api/admin/summary` (`requireAdmin()`), which a dummy session cookie can't
 * satisfy and `page.route` can't stub (it's a service-binding call inside the SSR
 * Worker). `authed-console.spec.ts` mints a real session and covers hydrated
 * admin renders; these screens' logic + structural a11y are covered by
 * `connector-list.component.spec.ts` / `connector-detail.component.spec.ts`.
 *
 * The `private, no-store` assertion is not incidental. `ADMIN_PANEL_SPEC.md` §9.2
 * makes "`/admin/*` is absent from `ROUTE_CACHE_PATTERNS`" a standing
 * requirement, and this surface is the first admin screen whose data has no cache
 * tags at all — the reason the connector tables still need none
 * (`CACHE_STRATEGY.md` §4).
 */
import { expect, test } from '@playwright/test';

const LIST_PATH = '/admin/connectors';
const DETAIL_PATH = '/admin/connectors/fx-cat-mindcloud';

test.describe('/admin/connectors — SSR auth gate (AECI-722)', () => {
  for (const path of [LIST_PATH, DETAIL_PATH]) {
    test(`redirects a logged-out visitor from ${path} to /auth/login with the return path`, async ({
      request,
    }) => {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status()).toBe(303);
      expect(res.headers()['location']).toBe(`/auth/login?return=${encodeURIComponent(path)}`);
      expect(res.headers()['cache-control']).toBe('private, no-store');
    });
  }

  test('the API reads are admin-gated and carry no cache tag', async ({ request }) => {
    // A 401 rather than a 404 also proves the routes are registered at all —
    // an unregistered path would fall through to the API Worker's 404 handler.
    const res = await request.get('/api/admin/connector-catalogs', { maxRedirects: 0 });
    expect(res.status()).toBe(401);
    expect(res.headers()['cache-control']).toBe('private, no-store');
    expect(res.headers()['cache-tag']).toBeUndefined();
  });
});
