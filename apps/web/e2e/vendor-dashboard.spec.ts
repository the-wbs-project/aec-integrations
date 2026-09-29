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
 * axe pass, and (AECI-1149) an answer round-trip on an integration's own page
 * through `PUT`/`DELETE /api/vendor/claims/:id/attestation` — and (4) AECI-632's live-surface contract:
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
 * `.sr-only` is what distinguishes it from the CONDITIONAL `role="status"`
 * paragraphs elsewhere in the vendor tree (the two "Saved" confirmations; the
 * attestation control's divergent-slots notice and the add-claim form's
 * duplicate-lane notice went with the inline panel in AECI-1156). Those are visible copy; the
 * channel is not. Counting `[role="status"]` bare would therefore assert
 * something the shipped tree cannot honour, and counting the `sr-only` one
 * asserts exactly the invariant §6.3 states.
 */
/**
 * A portal nav entry. Every entry is a `routerLink` anchor since §6.11 retired
 * the Products dropdown.
 *
 * `exact`: without it Playwright substring-matches, and a nav that ever gains
 * "Products settings" would start resolving two elements.
 */
function section(page: Page, name: string) {
  return page
    .getByRole('navigation', { name: 'Portal sections' })
    .getByRole('link', { name, exact: true });
}

/**
 * Navigate to a product's Integrations section (AECI-666). Integrations lives
 * under `…/products/:productSlug/integrations`. Since §6.11 bare `…/products` is
 * the product list, and opening a product swaps the tab row to that product's
 * sections, so `Integrations` is a link that exists ONLY in that row.
 */
async function gotoIntegrations(page: Page) {
  await page.goto('/vendor');
  await expect(page).toHaveURL(/\/vendor\/[a-z0-9-]+\/overview$/);
  await page.goto(`${page.url().replace(/\/overview.*$/, '')}/products`);
  await page.locator('aec-vendor-product-list-page a').first().click();
  // `…/products/:slug` redirects to its default section.
  await expect(page).toHaveURL(/\/products\/[a-z0-9-]+\/profile$/);
  await page.getByRole('link', { name: 'Integrations', exact: true }).click();
  await expect(page).toHaveURL(/\/products\/[a-z0-9-]+\/integrations$/);
  await expect(page.locator('aec-vendor-integrations-section')).toBeAttached();
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

  // ─── AECI-606 / AECI-1149 — the Integrations list and the integration page ──

  test('the Integrations tab hydrates with no console errors and zero axe violations', async ({
    page,
  }) => {
    const capture = attachConsoleCapture(page);
    await gotoIntegrations(page);
    // Wait for the list itself, not just the section: the rows do not exist until
    // `GET /api/vendor/integrations` lands.
    await expect(
      page
        .locator('[data-testid^="integration-row-"]')
        .first()
        .or(page.getByText('No integrations')),
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

  test('a row of data answered Yes and cleared round-trips on the integration page (AECI-1149)', async ({
    page,
  }) => {
    await gotoIntegrations(page);

    const rows = page.locator('[data-testid^="integration-row-"]');
    // Fixture-gated, like `phase2-a11y.spec.ts`: skip rather than fail when the
    // environment carries no integrations with rows of data.
    const rowCount = await rows.count();
    test.skip(rowCount === 0, 'No integrations on this vendor in this environment.');

    // An answerable Yes: enabled (a live row and a seat with `attestation.author`),
    // not yet pressed, and not one that opens a note form because the other
    // company said No. Environment data decides which integration has one, so
    // look through the first few rather than fail on the first.
    const answerable =
      '[data-testid^="yes-"][aria-pressed="false"]:not([disabled]):not([aria-expanded])';
    let found = false;
    for (let n = 0; n < Math.min(rowCount, 5) && !found; n++) {
      if (n > 0) await gotoIntegrations(page);
      await rows.nth(n).click();
      await expect(page).toHaveURL(/\/integrations\/[0-9a-f-]{36}$/);
      await expect(page.getByTestId('integration-title')).toBeVisible();
      found = (await page.locator(answerable).count()) > 0;
    }
    test.skip(!found, 'No answerable row of data on the first integrations.');

    const slug = (await page.locator(answerable).first().getAttribute('data-testid'))!;
    const yes = page.getByTestId(slug);
    await yes.click();
    await expect(yes).toHaveAttribute('aria-pressed', 'true');
    // The write announces through the SHELL's channel (AECI-631).
    await expect(page.locator(ANNOUNCER)).toContainText('you said this is right');

    // Pressing the pressed button clears the answer, so the spec is re-runnable.
    await yes.click();
    await expect(yes).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator(ANNOUNCER)).toContainText('your answer is cleared');
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
    // its own. Integrations moved under a product (AECI-666), so it is no longer a
    // portal section; Messages took its slot. The shell-level invariant this test
    // guards is unchanged by that move.
    for (const name of ['Profile', 'Products', 'Messages', 'Seats', 'Vendor Overview']) {
      await section(page, name).click();
      await expect(page.locator(ANNOUNCER)).toHaveCount(1);
    }
  });
});
