import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { untilAppStable } from './hydration';

/**
 * AECI-1809: the portal form layout (`vendor/shared/portal-form.ts`) on its dev-only
 * demo form, `/preview/portal-form`. The save bar sticks to the foot of the form card,
 * so a field focused by Tab must never sit under it (WCAG 2.4.11, Focus Not Obscured).
 * `PORTAL_FORM_CLASS` gives each control a bottom scroll margin taller than the bar.
 *
 * Every request off the local stack is answered here: PostHog with an empty 200, the
 * rest aborted. The demo form saves nothing.
 */
const PATH = '/preview/portal-form';

test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === 'localhost' || host === '127.0.0.1') return route.continue();
    if (/posthog/.test(host)) return route.fulfill({ status: 200, body: '{}' });
    return route.abort();
  });
});

for (const width of [1440, 320]) {
  test(`no field focused by Tab sits under the sticky save bar at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 640 });
    await page.goto(PATH);
    await untilAppStable(page);
    const fields = page.locator('app-portal-form-preview form').locator('input, textarea');
    const count = await fields.count();
    expect(count).toBeGreaterThan(4);
    await fields.first().focus();

    for (let i = 0; i < count; i++) {
      if (i > 0) await page.keyboard.press('Tab');
      // Let the browser's focus scrolling settle.
      await page.waitForTimeout(50);
      const clear = await page.evaluate(() => {
        const field = document.activeElement as HTMLElement;
        const bar = document.querySelector('[data-testid="portal-save-bar"]') as HTMLElement;
        return {
          tag: field.tagName,
          bottom: Math.round(field.getBoundingClientRect().bottom),
          barTop: Math.round(bar.getBoundingClientRect().top),
        };
      });
      expect(['INPUT', 'TEXTAREA']).toContain(clear.tag);
      expect(clear.bottom, `field ${i + 1} of ${count} is above the bar`).toBeLessThanOrEqual(
        clear.barTop,
      );
    }
  });
}

test('the save result shows in the status line, which is not a live region', async ({ page }) => {
  await page.goto(PATH);
  await untilAppStable(page);
  await page.getByRole('button', { name: 'Save changes' }).click();
  const status = page.getByTestId('portal-save-status');
  await expect(status).toContainText('Profile updated.');
  await expect(status).not.toHaveAttribute('role', /.+/);
  await expect(status).not.toHaveAttribute('aria-live', /.+/);
});

test('the demo form is axe clean at 1440 and 320', async ({ page }) => {
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(PATH);
    await untilAppStable(page);
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      result.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious'),
    ).toEqual([]);
  }
});
