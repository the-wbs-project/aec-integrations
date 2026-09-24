import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The connector catalogue seat's Catalogue tab (AECI-1083), on the ungated dev
 * preview. `?fixture=` picks the preset on first paint:
 *
 *   - `connector-seat` — a vendor-managed catalogue, every match editable;
 *   - `connector-seat-review` — the same seat on a catalogue the AECi team still
 *     maintains, so the tab is read-only.
 *
 * Why the preview and not `/vendor/:slug`: see `preview-vendor-portal-nav.spec.ts`.
 */
const PATH = '/preview/vendor-dashboard/products/agave/catalogue';
const FORM = 'form[aria-label^="Edit the match"]';

/** Keep acting until the effect is observable: a pre-hydration click is dropped. */
async function until(act: () => Promise<unknown>, settled: () => Promise<unknown>): Promise<void> {
  await expect(async () => {
    await act();
    await settled();
  }).toPass({ timeout: 15_000 });
}

async function axeSerious(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return result.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
}

const listing = (page: Page, name: string): Locator =>
  page.locator('[data-listing]').filter({ has: page.getByRole('heading', { name, exact: true }) });

test.describe('vendor catalogue tab (preview)', () => {
  test('lists the vendor-managed catalogue with an Edit on every match', async ({ page }) => {
    const res = await page.goto(`${PATH}?fixture=connector-seat`);
    expect(res?.status()).toBe(200);

    const nav = page.getByRole('navigation', { name: 'Agave sections' });
    await expect(nav.getByRole('link', { name: 'Catalogue' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.locator('[data-catalogue-summary]')).toContainText('30 listings');
    await expect(page.locator('[data-listing]')).toHaveCount(25);
    await expect(
      listing(page, 'Procore').getByRole('button', { name: 'Edit the match for Procore' }),
    ).toBeVisible();
    expect(await axeSerious(page)).toEqual([]);
  });

  test('is read-only on an AECi-managed catalogue', async ({ page }) => {
    await page.goto(`${PATH}?fixture=connector-seat-review`);
    await expect(page.locator('[data-catalogue-review-managed]')).toContainText(
      'The AECi team maintains this catalogue for now',
    );
    await expect(page.locator('[data-listing]').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Edit the match/ })).toHaveCount(0);
    expect(await axeSerious(page)).toEqual([]);
  });

  test('edits and saves a match with the keyboard alone', async ({ page }) => {
    await page.goto(`${PATH}?fixture=connector-seat`);
    const edit = listing(page, 'Procore').getByRole('button', {
      name: 'Edit the match for Procore',
    });

    await until(
      async () => {
        await edit.focus();
        await page.keyboard.press('Enter');
      },
      () => expect(page.locator(FORM)).toBeVisible({ timeout: 1_000 }),
    );
    // Focus moves into the form, onto its first control.
    await expect(page.locator(`${FORM} [role="combobox"]`).first()).toBeFocused();
    expect(await axeSerious(page)).toEqual([]);

    // Tab to the evidence link and replace it, then Tab to Save and press it.
    const tabTo = async (target: Locator) => {
      for (let i = 0; i < 12; i += 1) {
        if (await target.evaluate((el) => el === document.activeElement)) break;
        await page.keyboard.press('Tab');
      }
      await expect(target).toBeFocused();
    };
    const evidence = page.locator(`${FORM} input[type="url"]`);
    await tabTo(evidence);
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('https://agave.example.com/apps/procore');
    const save = page.locator(`${FORM} button[type="submit"]`);
    await tabTo(save);
    await page.keyboard.press('Enter');

    await expect(page.locator(FORM)).toHaveCount(0);
    await expect(page.locator('p[role="status"]')).toContainText('Procore');
    // Focus returns to the row's Edit button.
    await expect(edit).toBeFocused();
    await expect(listing(page, 'Procore')).toContainText('Confirmed by your company');
  });

  test('refuses an evidence link that is not https, beside the field', async ({ page }) => {
    await page.goto(`${PATH}?fixture=connector-seat`);
    const edit = listing(page, 'Procore').getByRole('button', {
      name: 'Edit the match for Procore',
    });
    await until(
      () => edit.click(),
      () => expect(page.locator(FORM)).toBeVisible({ timeout: 1_000 }),
    );
    const evidence = page.locator(`${FORM} input[type="url"]`);
    await evidence.fill('http://agave.example.com');
    await page.locator(`${FORM} button[type="submit"]`).click();
    await expect(evidence).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator(FORM)).toContainText('Use a full link that starts with https://.');
  });

  test('has no serious axe violations at 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`${PATH}?fixture=connector-seat`);
    await expect(page.locator('[data-listing]').first()).toBeVisible();
    expect(await axeSerious(page)).toEqual([]);
  });
});
