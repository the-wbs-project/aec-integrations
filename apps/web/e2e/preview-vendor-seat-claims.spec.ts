import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/**
 * AECI-1368 — "Wants to join" on the vendor Seats page, driven on the ungated dev
 * preview (`/preview/vendor-dashboard/seats`).
 *
 * The real `/vendor/:slug/seats` needs a vendor session CI does not have. The preview
 * mounts the same section route over a fixture-backed `VendorApi` whose seat read
 * carries one claim routed to the owners (`VENDOR_PENDING_SEAT_CLAIMS_FIXTURE`), and
 * whose accept echoes an invite.
 *
 * The roster loads in `afterNextRender`, so the claim being visible is also the
 * hydration signal.
 */
const PATH = '/preview/vendor-dashboard/seats';

test.describe('wants to join (preview)', () => {
  test('lists the routed claim with Accept and Decline, and the page passes axe', async ({
    page,
  }) => {
    await page.goto(PATH);

    const heading = page.getByRole('heading', { name: 'Wants to join' });
    await expect(heading).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('riley@summitbim.example.com')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Accept/ })).toBeEnabled();
    await expect(page.getByRole('button', { name: /^Decline/ })).toBeEnabled();

    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const serious = result.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(serious).toEqual([]);
  });

  test('announces an accept in the status region', async ({ page }) => {
    await page.goto(PATH);
    const accept = page.getByRole('button', { name: /^Accept/ });
    await expect(accept).toBeVisible({ timeout: 15_000 });

    await accept.click();
    await expect(
      page.getByRole('status').filter({ hasText: 'A seat invite was sent to' }),
    ).toBeVisible();
  });
});
