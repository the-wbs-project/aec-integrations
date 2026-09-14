/**
 * AECI-946 — the Google re-crawl worklist at `/admin/reindex`.
 *
 * Coverage here is the SSR auth gate: a logged-out visitor (no `sb-…-auth-token`
 * cookie) is 303-redirected to `/auth/login?return=<path>` (`private, no-store`)
 * by the worker-level `isAdminPath` gate, before SSR. This needs no fixture —
 * the gate fires before the resolver. Mirrors `admin-connectors.spec.ts`.
 *
 * The *authenticated* render is deliberately NOT exercised here, for the reason
 * that file records: the admin surface authorizes server-side via
 * `adminSummaryResolver` → `GET /api/admin/summary` (`requireAdmin()`), which a
 * dummy session cookie cannot satisfy and `page.route` cannot stub, because it
 * is a service-binding call inside the SSR Worker. The screen's logic and its
 * structural a11y live in `reindex-list.component.spec.ts`.
 *
 * The DELETE is checked here as well as the GET, and that is the point of this
 * file rather than a duplicate of it. It is the only *write* on the surface, and
 * a write reachable without a session would let anyone silently empty the
 * operator's worklist — a queue that reads empty because it was drained by a
 * stranger is indistinguishable from one that was worked.
 */
import { expect, test } from '@playwright/test';

const LIST_PATH = '/admin/reindex';

test.describe('/admin/reindex — SSR auth gate (AECI-946)', () => {
  test('redirects a logged-out visitor to /auth/login with the return path', async ({
    request,
  }) => {
    const res = await request.get(LIST_PATH, { maxRedirects: 0 });
    expect(res.status()).toBe(303);
    expect(res.headers()['location']).toBe(`/auth/login?return=${encodeURIComponent(LIST_PATH)}`);
    expect(res.headers()['cache-control']).toBe('private, no-store');
  });

  test('the worklist read is admin-gated and carries no cache tag', async ({ request }) => {
    // A 401 rather than a 404 also proves the route is registered at all — an
    // unregistered path would fall through to the API Worker's 404 handler.
    const res = await request.get('/api/admin/reindex', { maxRedirects: 0 });
    expect(res.status()).toBe(401);
    expect(res.headers()['cache-control']).toBe('private, no-store');
    expect(res.headers()['cache-tag']).toBeUndefined();
  });

  test('the Done button endpoint is admin-gated', async ({ request }) => {
    // The one write on this surface. Unauthenticated it must never reach the
    // handler, which would otherwise delete a row and audit it as an admin
    // action nobody performed.
    const res = await request.delete('/api/admin/reindex/1', { maxRedirects: 0 });
    expect(res.status()).toBe(401);
    expect(res.headers()['cache-control']).toBe('private, no-store');
  });
});
