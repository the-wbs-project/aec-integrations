/**
 * AECI-202 / Phase 5.11 — the authenticated `/account` page + the GDPR
 * delete-account flow. Runs against the bound dev stack (`pnpm dev:agent` / CI
 * preview).
 *
 * Coverage:
 *   - SSR auth gate: a logged-out visitor (no `sb-…-auth-token` cookie) is
 *     303-redirected to `/auth/login?return=/account` (`private, no-store`).
 *     Needs no fixture — the gate fires before SSR.
 *   - Authenticated render + a11y: with a session cookie present and a stubbed
 *     `GET /api/account`, the page renders identity; axe (WCAG-AA) is clean.
 *   - Delete flow: opening the confirmation dialog and confirming calls the
 *     stubbed `DELETE /api/account` and redirects home.
 *
 * Auth model (mirrors `reviews-submission.spec.ts`): the SSR gate is a cheap
 * cookie *presence* check, so a dummy `sb-…-auth-token` satisfies it. `/account`
 * has no SSR resolver — identity is fetched client-side — so the authenticated
 * cases need NO DB fixture; the `GET`/`DELETE /api/account` calls are stubbed via
 * `page.route` (the API Worker auth-enforces them for real).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:8788';
const WCAG_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const ACCOUNT_PATH = '/account';

const PROFILE = { user_id: 'e2e-user-1', email: 'e2e@example.com', display_name: 'E2E Reviewer' };

/** Add a dummy Supabase session cookie so the SSR presence-gate passes. */
async function addAuthCookie(context: BrowserContext): Promise<void> {
  const url = new URL(BASE_URL);
  await context.addCookies([
    {
      name: 'sb-localdev-auth-token',
      value: 'base64-e2e-account-fixture',
      domain: url.hostname,
      path: '/',
      secure: url.protocol === 'https:',
      sameSite: 'Lax',
    },
  ]);
}

/** Stub the auth-enforced account endpoints (GET identity + DELETE erasure). */
async function stubAccountApi(page: Page, onDelete?: () => void): Promise<void> {
  await page.route('**/api/account', async (route) => {
    if (route.request().method() === 'DELETE') {
      onDelete?.();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'gone' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(PROFILE),
    });
  });
}

async function aaViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_AA_TAGS).analyze();
  return results.violations;
}

test.describe('/account — SSR auth gate (AECI-202)', () => {
  test('redirects a logged-out visitor to /auth/login with the return path', async ({
    request,
  }) => {
    const res = await request.get(ACCOUNT_PATH, { maxRedirects: 0 });
    expect(res.status()).toBe(303);
    expect(res.headers()['location']).toBe(
      `/auth/login?return=${encodeURIComponent(ACCOUNT_PATH)}`,
    );
    expect(res.headers()['cache-control']).toBe('private, no-store');
  });
});

test.describe('/account — authenticated (AECI-202)', () => {
  test('renders the read-only email and the editable display name', async ({ page, context }) => {
    await addAuthCookie(context);
    await stubAccountApi(page);
    await page.goto(ACCOUNT_PATH);

    await expect(page.getByText(PROFILE.email)).toBeVisible();
    await expect(page.locator('#account-display-name')).toHaveValue(PROFILE.display_name);
    await expect(page.getByRole('button', { name: 'Delete account' })).toBeVisible();
  });

  test('has zero axe (WCAG-AA) violations', async ({ page, context }) => {
    await addAuthCookie(context);
    await stubAccountApi(page);
    await page.goto(ACCOUNT_PATH);
    await expect(page.locator('#account-display-name')).toBeVisible();
    const violations = await aaViolations(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  test('confirming the delete dialog calls DELETE /api/account and redirects home', async ({
    page,
    context,
  }) => {
    await addAuthCookie(context);
    let deleteCalled = false;
    await stubAccountApi(page, () => {
      deleteCalled = true;
    });
    await page.goto(ACCOUNT_PATH);
    await expect(page.locator('#account-display-name')).toBeVisible();

    // Open the confirmation dialog (CDK overlay) and confirm.
    await page.getByRole('button', { name: 'Delete account' }).click();
    await page.getByRole('button', { name: 'Delete my account' }).click();

    // The erasure was requested and the user is bounced home.
    await page.waitForURL(`${BASE_URL}/`);
    expect(deleteCalled).toBe(true);
  });
});
