import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';

/**
 * AECI-1368 — "Wants to join" on the vendor Seats page, driven on the ungated dev
 * preview (`/preview/vendor-dashboard/seats`).
 *
 * The real `/vendor/:slug/seats` needs a minted vendor session, and its path has a
 * `/vendor/` segment the zone WAF refuses. The preview mounts the same section route
 * over a fixture-backed `VendorApi` whose seat read carries one claim routed to the
 * owners (`VENDOR_PENDING_SEAT_CLAIMS_FIXTURE`).
 *
 * Accepting a claim and announcing the invite in the status region is covered by
 * `vendor-seat-roster.component.spec.ts` ("accepts, announces the invite in the
 * status region and re-reads the list"), so it has no E2E test here (AECI-2027).
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
    await expect(page.getByRole('button', { name: 'Accept Riley Chen' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Decline Riley Chen' })).toBeEnabled();

    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const serious = result.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(serious).toEqual([]);
  });
});
