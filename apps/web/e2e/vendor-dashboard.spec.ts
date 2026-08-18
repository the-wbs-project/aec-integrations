/**
 * AECI-522 — authed e2e for the Stage 2 vendor dashboard at `/vendor`, extending
 * the AECI-235 real-session mint with a `vendor_admin` persona (the only way to
 * e2e the authed portal — the `/vendor` gate authorizes server-side inside the
 * SSR Worker via `vendorMeResolver` -> `GET /api/vendor/me` -> `requireVendor()`,
 * which `page.route()` can't stub).
 *
 * Covers: (1) a hydrated `/vendor` render with zero console errors (the AECI-235
 * console-health gate), (2) a profile-edit round-trip through the real
 * `PATCH /api/vendor/profile` — proving the write path + the optimistic-save UX
 * against a live vendor session — and (3) AECI-606's Integrations tab: its live
 * axe pass and an attestation round-trip through `PUT`/`DELETE
 * /api/vendor/claims/:id/attestation`.
 *
 * The axe pass lives here rather than in a public spec for the same reason
 * `/admin/traffic`'s does (`authed-console.spec.ts`): the tab authorizes
 * server-side and renders nothing but a loading state until the authorized
 * `afterNextRender` reads land, so an unauthenticated run would only ever audit
 * the spinner.
 *
 * Skips-green when the vendor session can't be minted (no anon key / no
 * `SUPABASE_VENDOR_TEST_USER_*` creds / sign-in fails) — same posture as
 * `authed-console.spec.ts`. Authorizes only when the vendor account exists in the
 * shared Supabase project AND its `role='vendor_admin'` D1 profile (with a
 * non-null `vendor_id`) is seeded (`apps/api/seed/auth-fixtures.sql`, applied by
 * `dev:bound` -> `db:seed:local`).
 */
import AxeBuilder from '@axe-core/playwright';
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

  // ─── AECI-606 — the Integrations / attestations tab ───────────────────────

  test('the Integrations tab hydrates with no console errors and zero axe violations', async ({
    page,
  }) => {
    const capture = attachConsoleCapture(page);
    await page.goto('/vendor');
    await expect(page.locator('aec-vendor-dashboard-tabbed')).toBeAttached();

    await page.getByRole('button', { name: 'Integrations' }).click();
    await expect(page.locator('aec-vendor-integrations-section')).toBeAttached();
    // Wait for the list itself, not just the section: the a11y contract under
    // test (the cards' labelled regions, the lanes' controls, the live region)
    // does not exist until `GET /api/vendor/integrations` lands.
    await expect(
      page.locator('aec-vendor-integration-card').first().or(page.getByText('No integrations')),
    ).toBeVisible();
    await waitForHydrationSettle(page);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .exclude('aec-site-header')
      .analyze();
    expect(
      results.violations,
      results.violations
        .map((v) => `[${v.impact ?? '?'}] ${v.id}: ${v.help} (${v.nodes.length} node(s))`)
        .join('\n'),
    ).toEqual([]);

    expectConsoleClean(capture, 'GET /vendor (Integrations tab)');
  });

  test('affirming and clearing a claim round-trips through /api/vendor/claims', async ({
    page,
  }) => {
    await page.goto('/vendor');
    await page.getByRole('button', { name: 'Integrations' }).click();
    await expect(page.locator('aec-vendor-integrations-section')).toBeAttached();

    const lane = page.locator('[aec-vendor-claim-lane]').first();
    // Fixture-gated, like `phase2-a11y.spec.ts`: skip rather than fail when the
    // environment carries no claims. `phase2-fixtures.sql` seeds one on the
    // fixture integration, but a remote tier may have been reset.
    const laneCount = await page.locator('[aec-vendor-claim-lane]').count();
    test.skip(laneCount === 0, 'No claims on this vendor’s integrations in this environment.');

    // Seeded state is an AECi-only claim: `unverified`, because an AECi seed is
    // not a vendor voter.
    await expect(lane).toContainText('Unverified');

    await lane.getByRole('button', { name: 'Affirm' }).click();
    // One vendor's word is `single_source`, never `confirmed` — the §8.1(4)
    // invariant, asserted end to end through the real agreement engine.
    await expect(lane.getByText(/Confirmed by/)).toBeVisible();
    await expect(page.getByRole('status')).toContainText('position saved');

    // Clear restores the seeded state, so the spec is re-runnable.
    await lane.getByRole('button', { name: 'Clear' }).click();
    await expect(lane).toContainText('Unverified');
  });
});
