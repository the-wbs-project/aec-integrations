/**
 * AECI-522 — authed e2e for the Stage 2 vendor dashboard at `/vendor`, extending
 * the AECI-235 real-session mint with a `vendor_admin` persona (the only way to
 * e2e the authed portal — the `/vendor` gate authorizes server-side inside the
 * SSR Worker via `vendorMeResolver` -> `GET /api/vendor/me` -> `requireVendor()`,
 * which `page.route()` can't stub).
 *
 * Covers: (1) a hydrated `/vendor` render with zero console errors (the AECI-235
 * console-health gate), and (2) a profile-edit round-trip through the real
 * `PATCH /api/vendor/profile` — proving the write path + the optimistic-save UX
 * against a live vendor session.
 *
 * Skips-green when the vendor session can't be minted (no anon key / no
 * `SUPABASE_VENDOR_TEST_USER_*` creds / sign-in fails) — same posture as
 * `authed-console.spec.ts`. Authorizes only when the vendor account exists in the
 * shared Supabase project AND its `role='vendor_admin'` D1 profile (with a
 * non-null `vendor_id`) is seeded (`apps/api/seed/auth-fixtures.sql`, applied by
 * `dev:bound` -> `db:seed:local`).
 */
import { expect, test } from '@playwright/test';
import {
  attachConsoleCapture,
  expectConsoleClean,
  waitForHydrationSettle,
} from './console-capture';
import { mintSessionCookies } from './auth-session';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:8788';

let sessionCookies: Awaited<ReturnType<typeof mintSessionCookies>> = null;

test.beforeAll(async () => {
  sessionCookies = await mintSessionCookies(BASE_URL, 'vendor');
});

test.describe('vendor dashboard — authed /vendor (AECI-522)', () => {
  test.beforeEach(async ({ context }) => {
    test.skip(
      !sessionCookies,
      'No minted vendor Supabase session (SUPABASE_VENDOR_TEST_USER_* / anon key unset, or sign-in failed) — see docs/environments.md.',
    );
    await context.addCookies(sessionCookies!);
  });

  test('/vendor hydrates the dashboard with no console errors', async ({ page }) => {
    const capture = attachConsoleCapture(page);
    const res = await page.goto('/vendor');
    expect(res?.status()).toBe(200);
    // `aec-vendor-dashboard-tabbed` renders only for an authorized vendor admin;
    // a non-vendor (401/403) 404s to the not-found shell, failing loudly if the
    // D1 vendor_admin profile is missing or its vendor_id is null.
    await expect(page.locator('aec-vendor-page')).toBeAttached();
    await expect(page.locator('aec-vendor-dashboard-tabbed')).toBeAttached();
    await waitForHydrationSettle(page);
    expectConsoleClean(capture, 'GET /vendor');
  });

  test('editing the vendor profile saves through /api/vendor/profile', async ({ page }) => {
    await page.goto('/vendor');
    await expect(page.locator('aec-vendor-dashboard-tabbed')).toBeAttached();

    // Switch to the Profile tab and edit the description with a value that differs
    // from the current one every run (so Save is enabled and the PATCH fires).
    await page.getByRole('button', { name: 'Profile' }).click();
    const description = page.locator('#vendor-profile-description');
    await expect(description).toBeVisible();
    await description.fill(`E2E vendor edit ${Date.now()}`);

    const save = page.getByRole('button', { name: 'Save changes' });
    await expect(save).toBeEnabled();
    await save.click();

    // Optimistic + server-confirmed: the status message appears and the button
    // settles back to disabled (no pending changes after the echo re-seeds).
    await expect(page.getByRole('status')).toContainText('Profile updated');
    await expect(save).toBeDisabled();
  });
});
