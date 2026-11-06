/**
 * AECI-1613: the reviewer-update queue at `/admin/review-updates`
 * (`ADMIN_PANEL_SPEC.md` §5.14).
 *
 * Two halves, as in `admin-review-responses.spec.ts`.
 *
 * 1. The SSR auth gate and the API gate. These need no session and always run.
 *    The PATCH is checked because it is the one write on the surface: reachable
 *    without a session, it would let anyone publish an update on a product page.
 *
 * 2. Approve the seeded pending update through the real queue and the real API,
 *    as a minted admin (`auth-session.ts`, the AECI-235 pattern). It SKIPS (never
 *    red) when a session cannot be minted, or when the e2e update (…1162, seeded
 *    by `apps/api/seed/review-update-fixtures.sql`) is no longer pending. That
 *    seed is INSERT OR IGNORE, so a second run needs a fresh local D1.
 *
 * Locally: `pnpm dev:agent`, then
 * `PLAYWRIGHT_BASE_URL=http://localhost:<web port> pnpm --filter web exec playwright test admin-review-updates`.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { mintSessionCookies } from './auth-session';

const LIST_PATH = '/admin/review-updates';

/** The pending e2e update in the local seed, on Dynamo for Revit. */
const PENDING_ID = 'd0000000-0000-4000-8000-000000001162';
const PENDING_BODY = 'The 3.2 release made large graphs much faster.';
/** The approved one, used to open (and cancel) the remove confirm. */
const APPROVED_BODY = 'Dynamo 3.2 fixed the upgrade breakage for us.';

test.describe('/admin/review-updates — SSR auth gate (AECI-1613)', () => {
  test('redirects a logged-out visitor to /auth/login with the return path', async ({
    request,
  }) => {
    const res = await request.get(LIST_PATH, { maxRedirects: 0 });
    expect(res.status()).toBe(303);
    expect(res.headers()['location']).toBe(`/auth/login?return=${encodeURIComponent(LIST_PATH)}`);
    expect(res.headers()['cache-control']).toBe('private, no-store');
  });

  test('the queue read is admin-gated and carries no cache tag', async ({ request }) => {
    const res = await request.get('/api/admin/review-updates', { maxRedirects: 0 });
    expect(res.status()).toBe(401);
    expect(res.headers()['cache-control']).toBe('private, no-store');
    expect(res.headers()['cache-tag']).toBeUndefined();
  });

  test('the decision endpoint is admin-gated', async ({ request }) => {
    const res = await request.patch(`/api/admin/review-updates/${PENDING_ID}`, {
      data: { action: 'approve' },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(401);
    expect(res.headers()['cache-control']).toBe('private, no-store');
  });
});

test.describe('/admin/review-updates — approve as an admin (AECI-1613)', () => {
  let cookies: Awaited<ReturnType<typeof mintSessionCookies>> = null;
  let fixturePending = false;

  test.beforeAll(async ({ playwright }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL;
    if (!baseURL) return;
    cookies = await mintSessionCookies(baseURL);
    if (!cookies) return;
    const ctx = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: {
        cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
      },
    });
    try {
      const res = await ctx.get('/api/admin/review-updates?status=pending&perPage=100');
      if (res.ok()) {
        const body = (await res.json()) as { data: Array<{ id: string }> };
        fixturePending = body.data.some((u) => u.id === PENDING_ID);
      }
    } finally {
      await ctx.dispose();
    }
  });

  test.beforeEach(async ({ context }) => {
    test.skip(
      !cookies,
      'No minted Supabase session (SUPABASE_TEST_USER_* / anon key unset, or sign-in failed). See docs/environments.md.',
    );
    test.skip(
      !fixturePending,
      'The e2e update is not pending. Recreate the local D1 and run `pnpm --filter api db:seed:local`.',
    );
    await context.addCookies(cookies!);
  });

  test('approves the pending update, with axe clean on the queue', async ({ page }) => {
    await page.goto(LIST_PATH);
    await expect(page.getByRole('heading', { name: 'Review updates', level: 2 })).toBeVisible();
    const queue = page.locator('section[aria-labelledby="admin-review-updates-heading"]');

    const card = page.locator('article', { hasText: PENDING_BODY });
    await expect(card).toBeVisible();
    await expect(card).toContainText('The original review');
    await expect(card).toContainText('Fine for small scripts');

    const axe = await new AxeBuilder({ page }).include('main').analyze();
    const blocking = axe.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);

    await card.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(queue.getByRole('status')).toContainText('Update approved');
    await expect(card).toHaveCount(0);

    // On the Approved tab, the remove form asks for a final confirm. Cancel it.
    await page.getByRole('button', { name: 'Approved', exact: true }).click();
    await expect(page.locator('article', { hasText: PENDING_BODY })).toBeVisible();
    const approved = page.locator('article', { hasText: APPROVED_BODY });
    await approved.getByRole('button', { name: 'Remove from the page' }).click();
    await approved.getByRole('textbox').fill('Checking the confirm step.');
    await approved.getByRole('button', { name: 'Continue to removal' }).click();
    const confirm = approved.getByRole('group', { name: 'Remove this update permanently?' });
    await expect(confirm).toBeFocused();
    await expect(confirm).toContainText('Removal is final.');
    const confirmAxe = await new AxeBuilder({ page }).include('main').analyze();
    expect(
      confirmAxe.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious'),
    ).toEqual([]);
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(approved).toBeVisible();
  });
});
