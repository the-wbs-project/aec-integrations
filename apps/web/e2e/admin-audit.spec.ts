/**
 * AECI-653 — the global audit log at `/admin/audit` (`ADMIN_PANEL_SPEC.md` §5.18).
 *
 * Coverage here is the SSR auth gate: a logged-out visitor (no `sb-…-auth-token`
 * cookie) is 303-redirected to `/auth/login?return=<path>` (`private, no-store`)
 * by the worker-level `isAdminPath` gate, before SSR. Mirrors
 * `admin-reindex.spec.ts`.
 *
 * The authenticated render is NOT exercised here, for the reason that file
 * records: the admin surface authorizes server-side via `adminSummaryResolver`,
 * which a dummy session cookie cannot satisfy and `page.route` cannot stub. The
 * signed-in render and its axe pass live in `authed-console.spec.ts`, and the
 * screen's logic in `audit-log.component.spec.ts`.
 *
 * A logged-out deep link loses its filters at the bounce. `signInReturnPath`
 * keeps only the allowlisted arrival params (`arrivalQueryString`), so
 * `?entity_type=…&entity_id=…` returns to the bare page after sign-in. That is
 * the shared gate's rule, not this screen's, and is not asserted here.
 */
import { expect, test } from '@playwright/test';

const PAGE_PATH = '/admin/audit';

test.describe('/admin/audit — SSR auth gate (AECI-653)', () => {
  test('redirects a logged-out visitor to /auth/login with the return path', async ({
    request,
  }) => {
    const res = await request.get(PAGE_PATH, { maxRedirects: 0 });
    expect(res.status()).toBe(303);
    expect(res.headers()['location']).toBe(`/auth/login?return=${encodeURIComponent(PAGE_PATH)}`);
    expect(res.headers()['cache-control']).toBe('private, no-store');
    expect(res.headers()['cache-tag']).toBeUndefined();
  });

  test('the ledger read is admin-gated and carries no cache tag', async ({ request }) => {
    // A 401 rather than a 404 also proves the route is registered at all.
    const res = await request.get('/api/admin/audit', { maxRedirects: 0 });
    expect(res.status()).toBe(401);
    expect(res.headers()['cache-control']).toBe('private, no-store');
    expect(res.headers()['cache-tag']).toBeUndefined();
  });
});
