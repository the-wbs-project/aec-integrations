/**
 * AECI-205 / Phase 5.14 — the admin moderation queue at `/admin/reviews`.
 *
 * Coverage here is the SSR auth gate: a logged-out visitor (no `sb-…-auth-token`
 * cookie) is 303-redirected to `/auth/login?return=<path>` (`private, no-store`)
 * by the worker-level `isAdminPath` gate, before SSR. This needs no fixture — the
 * gate fires before the resolver. Mirrors `account-delete.spec.ts`'s redirect
 * case.
 *
 * The *authenticated* render is deliberately NOT exercised here: unlike
 * `/account`, the admin surface authorizes server-side via `adminSummaryResolver`
 * → `GET /api/admin/summary` (`requireAdmin()`), which a dummy session cookie
 * can't satisfy and `page.route` can't stub (it's a service-binding call inside
 * the SSR Worker). The queue's logic + structural a11y are covered by
 * `review-queue.component.spec.ts`; the live axe pass is a dev-time check (see
 * the AECI-205 plan). This matches the AECI-203 precedent for the admin shell.
 */
import { expect, test } from '@playwright/test';

const ADMIN_REVIEWS_PATH = '/admin/reviews';

test.describe('/admin/reviews — SSR auth gate (AECI-205)', () => {
  test('redirects a logged-out visitor to /auth/login with the return path', async ({
    request,
  }) => {
    const res = await request.get(ADMIN_REVIEWS_PATH, { maxRedirects: 0 });
    expect(res.status()).toBe(303);
    expect(res.headers()['location']).toBe(
      `/auth/login?return=${encodeURIComponent(ADMIN_REVIEWS_PATH)}`,
    );
    expect(res.headers()['cache-control']).toBe('private, no-store');
  });
});
