/**
 * AECI-1008 — the integration field contest queue at `/admin/contests`.
 *
 * Coverage here is the SSR auth gate, for the reason `admin-reindex.spec.ts`
 * records: the authenticated render needs a real admin session, which a dummy
 * cookie cannot satisfy and `page.route` cannot stub (the summary call is a
 * service-binding call inside the SSR Worker). The screen's logic and structural
 * a11y live in `contest-queue.component.spec.ts`.
 *
 * The PATCH is checked as well as the GET because it is the one write on the
 * surface. Reachable without a session, it would let anyone decide a vendor's
 * contest and file a review issue in AECi's name.
 */
import { expect, test } from '@playwright/test';

const LIST_PATH = '/admin/contests';

test.describe('/admin/contests — SSR auth gate (AECI-1008)', () => {
  test('redirects a logged-out visitor to /auth/login with the return path', async ({
    request,
  }) => {
    const res = await request.get(LIST_PATH, { maxRedirects: 0 });
    expect(res.status()).toBe(303);
    expect(res.headers()['location']).toBe(`/auth/login?return=${encodeURIComponent(LIST_PATH)}`);
    expect(res.headers()['cache-control']).toBe('private, no-store');
  });

  test('the queue read is admin-gated and carries no cache tag', async ({ request }) => {
    const res = await request.get('/api/admin/contests', { maxRedirects: 0 });
    expect(res.status()).toBe(401);
    expect(res.headers()['cache-control']).toBe('private, no-store');
    expect(res.headers()['cache-tag']).toBeUndefined();
  });

  test('the decision endpoint is admin-gated', async ({ request }) => {
    const res = await request.patch('/api/admin/contests/00000000-0000-4000-8000-000000000001', {
      data: { decision: 'accept' },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(401);
    expect(res.headers()['cache-control']).toBe('private, no-store');
  });
});
