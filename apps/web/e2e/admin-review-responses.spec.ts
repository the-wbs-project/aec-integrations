/**
 * AECI-1177 — the vendor review-reply queue at `/admin/review-responses`
 * (`ADMIN_PANEL_SPEC.md` §5.13).
 *
 * Two halves.
 *
 * 1. The SSR auth gate and the API gate. These need no session and always run,
 *    like `admin-contests.spec.ts`. The PATCH is checked because it is the one
 *    write on the surface: reachable without a session, it would let anyone
 *    publish a vendor's words on a product page.
 *
 * 2. Approve one reply and reject another, through the real queue and the real
 *    API, as a minted admin (`auth-session.ts`, the AECI-235 pattern). The
 *    `/admin` gate authorizes inside the SSR Worker, which `page.route` cannot
 *    stub, so this half needs a real Supabase session and SKIPS (never red) when
 *    one cannot be minted: no `SUPABASE_TEST_USER_*` / anon key, or sign-in
 *    fails. It also skips when the two e2e replies are not pending. They are
 *    seeded by `apps/api/seed/review-response-fixtures.sql` (…1158 and …1159),
 *    which `db:seed:local` resets to `pending`, so re-seed before a second run.
 *
 * Locally: `pnpm dev:agent`, then
 * `PLAYWRIGHT_BASE_URL=http://localhost:<web port> pnpm --filter web exec playwright test admin-review-responses`
 * with `apps/web/.dev.vars` carrying the test-user credentials. The session mint
 * and the probe follow the project's `baseURL` (so `AECI_WEB_PORT` /
 * `PLAYWRIGHT_BASE_URL`), never a hardcoded 8788.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { mintSessionCookies } from './auth-session';

const LIST_PATH = '/admin/review-responses';

/** The two e2e replies in the local seed, both on Dynamo for Revit. */
const APPROVE_ID = 'd0000000-0000-4000-8000-000000001158';
const REJECT_ID = 'd0000000-0000-4000-8000-000000001159';
const APPROVE_BODY = 'The 3.2 templates cut setup to a day';
const REJECT_BODY = 'Call our sales line on 555 0100';

test.describe('/admin/review-responses — SSR auth gate (AECI-1177)', () => {
  test('redirects a logged-out visitor to /auth/login with the return path', async ({
    request,
  }) => {
    const res = await request.get(LIST_PATH, { maxRedirects: 0 });
    expect(res.status()).toBe(303);
    expect(res.headers()['location']).toBe(`/auth/login?return=${encodeURIComponent(LIST_PATH)}`);
    expect(res.headers()['cache-control']).toBe('private, no-store');
  });

  test('the queue read is admin-gated and carries no cache tag', async ({ request }) => {
    const res = await request.get('/api/admin/review-responses', { maxRedirects: 0 });
    expect(res.status()).toBe(401);
    expect(res.headers()['cache-control']).toBe('private, no-store');
    expect(res.headers()['cache-tag']).toBeUndefined();
  });

  test('the decision endpoint is admin-gated', async ({ request }) => {
    const res = await request.patch(`/api/admin/review-responses/${APPROVE_ID}`, {
      data: { decision: 'approve', expected_updated_at: '2026-09-01T00:00:00.000Z' },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(401);
    expect(res.headers()['cache-control']).toBe('private, no-store');
  });
});

test.describe('/admin/review-responses — approve and reject as an admin (AECI-1177)', () => {
  let cookies: Awaited<ReturnType<typeof mintSessionCookies>> = null;
  let fixturesPending = false;

  test.beforeAll(async ({ playwright }, testInfo) => {
    // The project's baseURL already honours `AECI_WEB_PORT` / `PLAYWRIGHT_BASE_URL`.
    const baseURL = testInfo.project.use.baseURL;
    if (!baseURL) return;
    cookies = await mintSessionCookies(baseURL);
    if (!cookies) return;
    // Probe the queue with the minted session: both e2e replies must be pending.
    const ctx = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: {
        cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
      },
    });
    try {
      const res = await ctx.get('/api/admin/review-responses?status=pending&perPage=100');
      if (res.ok()) {
        const body = (await res.json()) as { data: Array<{ id: string }> };
        const ids = new Set(body.data.map((r) => r.id));
        fixturesPending = ids.has(APPROVE_ID) && ids.has(REJECT_ID);
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
      !fixturesPending,
      'The e2e replies are not pending. Run `pnpm --filter api db:seed:review-responses:local` to reset them.',
    );
    await context.addCookies(cookies!);
  });

  test('approves one reply and rejects another, with axe clean on the queue', async ({ page }) => {
    await page.goto(LIST_PATH);
    const heading = page.getByRole('heading', { name: 'Review replies', level: 2 });
    // The queue's own live region. The shell may carry others.
    const queue = page.locator('section[aria-labelledby="admin-replies-heading"]');
    await expect(heading).toBeVisible();

    const approveCard = page.locator('article', { hasText: APPROVE_BODY });
    const rejectCard = page.locator('article', { hasText: REJECT_BODY });
    await expect(approveCard).toBeVisible();
    await expect(rejectCard).toBeVisible();

    // axe on the loaded queue: no error or serious violation (AECI-1177 AC).
    const axe = await new AxeBuilder({ page }).include('main').analyze();
    const blocking = axe.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);

    // Approve: one click, the row leaves, the outcome is announced.
    await approveCard.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(queue.getByRole('status')).toContainText('Reply approved');
    await expect(approveCard).toHaveCount(0);

    // Reject: the reason is required, then the row leaves.
    await rejectCard.getByRole('button', { name: 'Reject', exact: true }).click();
    await rejectCard.getByRole('button', { name: 'Confirm rejection' }).click();
    await expect(rejectCard.getByRole('alert')).toContainText('Write a reason');
    await rejectCard
      .getByRole('textbox')
      .fill('A reply may not be a sales pitch or carry contact details.');
    // axe with the reason form open and its error shown.
    const formAxe = await new AxeBuilder({ page }).include('main').analyze();
    expect(
      formAxe.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious'),
    ).toEqual([]);
    await rejectCard.getByRole('button', { name: 'Confirm rejection' }).click();
    await expect(queue.getByRole('status')).toContainText('Reply rejected');
    await expect(rejectCard).toHaveCount(0);

    // The decisions landed: each reply is on its new tab.
    await page.getByRole('button', { name: 'Published', exact: true }).click();
    await expect(page.locator('article', { hasText: APPROVE_BODY })).toBeVisible();
    await page.getByRole('button', { name: 'Rejected', exact: true }).click();
    const rejected = page.locator('article', { hasText: REJECT_BODY });
    await expect(rejected).toContainText('A reply may not be a sales pitch');
  });
});
