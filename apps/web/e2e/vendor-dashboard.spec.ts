/**
 * AECI-522 — authed e2e for the Stage 2 vendor dashboard at
 * `/vendor/:vendorSlug/...`, extending
 * the AECI-235 real-session mint with a `vendor_admin` persona (the only way to
 * e2e the authed portal — the `/vendor` gate authorizes server-side inside the
 * SSR Worker via `vendorMeResolver` -> `GET /api/vendor/me` -> `requireVendor()`,
 * which `page.route()` can't stub).
 *
 * Covers: (1) bare `/vendor` redirecting to the slugged dashboard and hydrating
 * with zero console errors (the AECI-235 console-health gate), (2) a profile-edit
 * round-trip through the real
 * `PATCH /api/vendor/profile` — proving the write path + the optimistic-save UX
 * against a live vendor session — (3) AECI-606's Integrations tab: its live
 * axe pass and an attestation round-trip through `PUT`/`DELETE
 * /api/vendor/claims/:id/attestation` — and (4) AECI-632's live-surface contract:
 * the ONE polite announcement region the AECI-631 hoist put in the dashboard
 * shell (`STAGE_2_REALTIME_SPEC.md` §6.3 / §6.6).
 *
 * The axe pass lives here rather than in a public spec for the same reason
 * `/admin/traffic`'s does (`authed-console.spec.ts`): the tab authorizes
 * server-side and renders nothing but a loading state until the authorized
 * `afterNextRender` reads land, so an unauthenticated run would only ever audit
 * the spinner.
 *
 * ── WHY `getByRole('status')` IS NEVER USED BARE HERE ────────────────────────
 * The announcement region is `role="status"` and is in the DOM from first paint,
 * so a bare `getByRole('status')` matches it *plus* whichever transient status
 * paragraph the assertion actually meant, and trips Playwright's strict mode.
 * That is not hypothetical: it broke the two pre-existing assertions below the
 * moment the region was hoisted, and only stayed green because this whole file
 * skips without `SUPABASE_VENDOR_TEST_USER_*`. Every status assertion here is
 * therefore scoped — to the owning component for a transient one, and to
 * {@link ANNOUNCER} for the shell's channel.
 *
 * Skips-green when the vendor session can't be minted (no anon key / no
 * `SUPABASE_VENDOR_TEST_USER_*` creds / sign-in fails) — same posture as
 * `authed-console.spec.ts`. Authorizes only when the vendor account exists in the
 * shared Supabase project AND its `role='vendor_admin'` D1 profile (with a
 * non-null `vendor_id`) is seeded (`apps/api/seed/auth-fixtures.sql`, applied by
 * `dev:bound` -> `db:seed:local`).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  attachConsoleCapture,
  expectConsoleClean,
  waitForHydrationSettle,
} from './console-capture';
import { mintSessionCookies } from './auth-session';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:8788';

/**
 * The portal's single polite announcement region (AECI-631 /
 * `STAGE_2_REALTIME_SPEC.md` §6.3): an `sr-only` `<p role="status">` in the
 * dashboard shell, fed by `VendorPortalAnnouncer`.
 *
 * `.sr-only` is what distinguishes it from the four CONDITIONAL `role="status"`
 * paragraphs elsewhere in the vendor tree (the two "Saved" confirmations, the
 * attestation control's divergent-slots notice, the add-claim form's
 * duplicate-lane notice — §6.5's open finding). Those are visible copy; the
 * channel is not. Counting `[role="status"]` bare would therefore assert
 * something the shipped tree cannot honour, and counting the `sr-only` one
 * asserts exactly the invariant §6.3 states.
 */
/**
 * A dashboard side-nav entry. They are `routerLink` anchors since the portal
 * moved onto child routes (`/vendor/:vendorSlug/<section>`), so a `role: 'button'`
 * lookup silently matches nothing — which is why this helper exists rather than
 * an inline `getByRole` at each call site.
 */
function section(page: Page, name: string) {
  return page.getByRole('navigation', { name: 'Dashboard sections' }).getByRole('link', { name });
}

const ANNOUNCER = '[role="status"].sr-only';

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

  test('/vendor redirects to the slugged dashboard and hydrates with no console errors', async ({
    page,
  }) => {
    const capture = attachConsoleCapture(page);
    const res = await page.goto('/vendor');
    expect(res?.status()).toBe(200);
    // Bare `/vendor` resolves the caller's own vendor and redirects, so the
    // address that ends up in the bar names the vendor and the section. Under
    // SSR that is a real 302 (Angular emits one when the router's final URL
    // differs from the requested one), which `page.goto` follows.
    await expect(page).toHaveURL(/\/vendor\/[a-z0-9-]+\/overview$/);
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
    await section(page, 'Profile').click();
    const description = page.locator('#vendor-profile-description');
    await expect(description).toBeVisible();
    await description.fill(`E2E vendor edit ${Date.now()}`);

    const save = page.getByRole('button', { name: 'Save changes' });
    await expect(save).toBeEnabled();
    await save.click();

    // Optimistic + server-confirmed: the status message appears and the button
    // settles back to disabled (no pending changes after the echo re-seeds).
    // Scoped to the form: the shell's announcement region is also `role="status"`
    // and always present, so a bare `getByRole('status')` matches two elements.
    await expect(page.locator('aec-vendor-profile-form [role="status"]')).toContainText(
      'Profile updated',
    );
    await expect(save).toBeDisabled();
  });

  // ─── AECI-606 — the Integrations / attestations tab ───────────────────────

  test('the Integrations tab hydrates with no console errors and zero axe violations', async ({
    page,
  }) => {
    const capture = attachConsoleCapture(page);
    await page.goto('/vendor');
    await expect(page.locator('aec-vendor-dashboard-tabbed')).toBeAttached();

    await section(page, 'Integrations').click();
    await expect(page.locator('aec-vendor-integrations-section')).toBeAttached();
    // Wait for the list itself, not just the section: the a11y contract under
    // test (the cards' labelled regions, the lanes' controls, the live region)
    // does not exist until `GET /api/vendor/integrations` lands.
    await expect(
      page.locator('aec-vendor-integration-card').first().or(page.getByText('No integrations')),
    ).toBeVisible();
    await waitForHydrationSettle(page);

    // §6.4 asks for the axe pass to run WITH the live region present, because a
    // region moving is exactly the kind of change that invalidates a prior pass.
    // Assert it is here (and singular) before analyzing, so a run that silently
    // lost the region cannot report a clean pass over a surface without one.
    await expect(page.locator(ANNOUNCER)).toHaveCount(1);

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

    expectConsoleClean(capture, 'GET /vendor (Integrations section)');
  });

  test('affirming and clearing a claim round-trips through /api/vendor/claims', async ({
    page,
  }) => {
    await page.goto('/vendor');
    await section(page, 'Integrations').click();
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
    // The write announces through the SHELL's channel, not through anything the
    // lane renders — that is the whole point of the AECI-631 hoist, so asserting
    // on the announcer is also what proves the channel is wired end to end.
    await expect(page.locator(ANNOUNCER)).toContainText('position saved');

    // Clear restores the seeded state, so the spec is re-runnable.
    await lane.getByRole('button', { name: 'Clear' }).click();
    await expect(lane).toContainText('Unverified');
    await expect(page.locator(ANNOUNCER)).toContainText('Position withdrawn');
  });

  // ─── AECI-632 — the live surface's a11y contract (§6.3 / §6.6) ────────────

  test('the dashboard shell carries exactly one polite, sr-only live region', async ({ page }) => {
    await page.goto('/vendor');
    await expect(page.locator('aec-vendor-dashboard-tabbed')).toBeAttached();

    // Present from FIRST PAINT, on the default Vendor Overview section — before any
    // section fetch has landed. That is what the hoist bought: the region used
    // to live inside the Integrations tab and only existed once
    // `GET /api/vendor/integrations` had resolved, so a message fired before
    // then had nowhere to land.
    const region = page.locator(ANNOUNCER);
    await expect(region).toHaveCount(1);
    await expect(region).toBeAttached();

    // Polite, never assertive: a background revalidation is not an interruption
    // (§6.3). `role="status"` implies `aria-live="polite"`, so the assertion
    // that matters is that nothing has overridden it upward.
    await expect(region).not.toHaveAttribute('aria-live', 'assertive');

    // sr-only is what satisfies the no-layout-shift rule — an announcement
    // occupies no space, so it can never move a control out from under a
    // pointer already travelling toward it. Playwright counts the `sr-only`
    // clip technique (a 1px, clipped, but rendered box) as "visible", so assert
    // the property that actually matters here: the region collapses to no usable
    // layout area, and therefore cannot shift anything around it.
    const box = await region.boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(1);
    expect(box?.height ?? 0).toBeLessThanOrEqual(1);

    // At rest on Vendor Overview, the channel is the ONLY live region on the page:
    // none of the four conditional `role="status"` paragraphs (§6.5) render
    // until a save succeeds or a form finds a conflict. A second one here means
    // someone added a region rather than announcing through the channel.
    await expect(page.locator('[role="status"]')).toHaveCount(1);

    // The region is in the shell, so it survives every section navigation. A
    // region that lived in a section would be destroyed mid-announcement when
    // the outlet swapped — and a duplicate would appear if a section declared
    // its own.
    for (const name of ['Profile', 'Products', 'Integrations', 'Seats', 'Vendor Overview']) {
      await section(page, name).click();
      await expect(page.locator(ANNOUNCER)).toHaveCount(1);
    }
  });
});
