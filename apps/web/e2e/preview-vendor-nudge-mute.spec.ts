import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/**
 * AECI-1204 — the daily reminder email switch on the vendor Messages page, driven
 * on the ungated dev preview (`/preview/vendor-dashboard/messages`).
 *
 * The real `/vendor/:slug/messages` needs a vendor session CI does not have. The
 * preview mounts the same section route over a fixture-backed `VendorApi`, whose
 * preference fake keeps state in memory, so the toggle round-trips here.
 *
 * The switch is not rendered until its preference has loaded, which happens in
 * `afterNextRender`, so "visible" is also the hydration signal. A toggle cannot use
 * the click-until-it-took retry other preview specs use, because a second click
 * that lands would flip it back.
 */
const PATH = '/preview/vendor-dashboard/messages';

test.describe('daily reminder email switch (preview)', () => {
  test('mutes and unmutes the seat, and the page passes axe', async ({ page }) => {
    await page.goto(PATH);

    const toggle = page.getByRole('switch', { name: 'Daily reminder email' });
    await expect(toggle).toBeVisible({ timeout: 15_000 });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('nudge-mute-status')).toContainText('Off since');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('nudge-mute-status')).toHaveText('On');

    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const serious = result.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(serious).toEqual([]);
  });

  test('is keyboard-operable with Space', async ({ page }) => {
    await page.goto(PATH);
    const toggle = page.getByRole('switch', { name: 'Daily reminder email' });
    await expect(toggle).toBeVisible({ timeout: 15_000 });

    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
  });
});
