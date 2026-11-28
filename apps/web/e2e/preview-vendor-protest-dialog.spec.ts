import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { untilAppStable } from './hydration';

/**
 * AECI-2110: the review request to AEC Integrations opens in a dialog
 * (`protest-form-dialog.ts`, `DESIGN.md` "The Detached-Form Rule"). In a real browser:
 * focus lands on the dialog's title (the Title-First Dialog Rule), Escape discards the
 * draft and closes it, focus returns to the button that opened it, the next open starts
 * empty, and axe finds nothing serious with the dialog open, at 1440 and at 320.
 *
 * Driven on the ungated dev preview, so no vendor session is needed. Every request off
 * the local stack is answered here: PostHog with an empty 200, the rest aborted.
 * Nothing is submitted.
 */
const PROCORE =
  '/preview/vendor-dashboard/products/summit-model-coordination/integrations/00000000-0000-4000-8000-000000005310';
const DECLINED = '00000000-0000-4000-8000-000000005c14';
const OPENER = `#vendor-protest-start-${DECLINED}`;
const TITLE = 'Ask AEC Integrations to review this request';

test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === 'localhost' || host === '127.0.0.1') return route.continue();
    if (/posthog/.test(host)) return route.fulfill({ status: 200, body: '{}' });
    return route.abort();
  });
});

/** Click until the target shows: a click between SSR paint and hydration is dropped. */
async function open(page: Page, trigger: string, shows: string): Promise<void> {
  await expect(async () => {
    await page.locator(trigger).first().click();
    await expect(page.locator(shows).first()).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

/**
 * The dev-only fixture switcher is sticky and, at 320px, tall: it covers the page's
 * buttons. Un-stick it so only the page is driven. It is not part of the portal.
 */
async function unstickSwitcher(page: Page): Promise<void> {
  await page
    .locator('[aria-label="Concept switcher (dev only)"]')
    .evaluate((el) => el.closest<HTMLElement>('.sticky')?.style.setProperty('position', 'static'));
}

async function openDialog(page: Page): Promise<void> {
  await page.goto(PROCORE);
  await untilAppStable(page);
  await unstickSwitcher(page);
  await open(page, `[data-testid="closed-toggle-${DECLINED}"]`, OPENER);
  await open(page, OPENER, '[role="alertdialog"]');
}

for (const width of [1440, 320]) {
  test(`the review request opens in a dialog on its title, and axe is clean at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await openDialog(page);
    const dialog = page.getByRole('alertdialog', { name: TITLE });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: TITLE })).toBeFocused();
    // No form is left in the page itself.
    await expect(page.locator(`[data-protest="${DECLINED}"] form`)).toHaveCount(0);
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .include('[role="alertdialog"]')
      .analyze();
    const serious = result.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(serious.map((v) => v.id)).toEqual([]);
  });
}

test('Escape discards the draft, closes the dialog and returns focus to the opener', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDialog(page);
  const dialog = page.getByRole('alertdialog', { name: TITLE });
  await dialog.locator('textarea').fill('A draft the vendor typed.');
  await page.keyboard.press('Escape');
  await expect(page.locator('[role="alertdialog"]')).toHaveCount(0);
  await expect(page.locator(OPENER)).toBeFocused();
  await page.locator(OPENER).click();
  await expect(page.getByRole('alertdialog', { name: TITLE }).locator('textarea')).toHaveValue('');
});
