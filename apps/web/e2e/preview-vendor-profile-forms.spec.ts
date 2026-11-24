import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { untilAppStable } from './hydration';

/**
 * AECI-1810 part 2: the company Profile, the product Profile and the four facet
 * editors on the portal form card (`vendor/shared/portal-form.ts`), driven on the
 * ungated dev preview, so no vendor session is needed.
 *
 * What has to hold after the restyle:
 *
 * - A control focused by Tab never sits under the sticky save bar (WCAG 2.4.11).
 * - The plan and lock gates are unchanged: a Free product's Managed-only fields stay
 *   read-only with their reason, and a Free product's trades are not tickable.
 * - The save result is plain text in the bar, and the shell's one live region reads it.
 * - The facet editor shows the ticked terms as chips and holds its 10-term limit.
 *
 * Every request off the local stack is answered here: PostHog with an empty 200, the
 * rest aborted. The preview saves to an in-memory fake, never to an API.
 */
const PATH = '/preview/vendor-dashboard';
const PRODUCT = `${PATH}/products/summit-model-coordination`;

test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === 'localhost' || host === '127.0.0.1') return route.continue();
    if (/posthog/.test(host)) return route.fulfill({ status: 200, body: '{}' });
    return route.abort();
  });
});

async function axeSerious(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .exclude('[aria-label="Concept switcher (dev only)"]')
    .analyze();
  return result.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
}

/**
 * Tab from the form's first control to its save button. Every control focused on
 * the way must end above the bar's top edge. Controls inside the bar are exempt.
 */
async function walkClearOfBar(page: Page, form: string): Promise<number> {
  const first = page.locator(`${form} :is(input, textarea, [role="option"][tabindex="0"])`).first();
  await first.focus();
  let checked = 0;
  for (let i = 0; i < 80; i++) {
    if (i > 0) await page.keyboard.press('Tab');
    await page.waitForTimeout(50);
    const state = await page.evaluate((formSelector) => {
      const el = document.activeElement as HTMLElement | null;
      const formEl = document.querySelector(formSelector);
      const bar = formEl?.querySelector('.aec-portal-save-bar') as HTMLElement | null;
      if (!el || !formEl || !bar || !formEl.contains(el)) return { done: true };
      if (bar.contains(el)) return { done: true };
      return {
        done: false,
        name: `${el.tagName} ${el.id || el.textContent?.trim().slice(0, 30) || ''}`,
        bottom: Math.round(el.getBoundingClientRect().bottom),
        barTop: Math.round(bar.getBoundingClientRect().top),
      };
    }, form);
    if (state.done) break;
    checked++;
    expect(state.bottom!, `${state.name} is above the bar`).toBeLessThanOrEqual(state.barTop!);
  }
  return checked;
}

for (const width of [1440, 320]) {
  test(`company Profile: no control focused by Tab sits under the save bar at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 640 });
    await page.goto(`${PATH}/profile?fixture=verified`);
    await untilAppStable(page);
    expect(await walkClearOfBar(page, 'aec-vendor-profile-form form')).toBeGreaterThan(10);
  });

  test(`product Profile: no control focused by Tab sits under the save bar at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 640 });
    await page.goto(`${PRODUCT}/profile?fixture=verified`);
    await untilAppStable(page);
    expect(await walkClearOfBar(page, 'aec-vendor-product-form form')).toBeGreaterThan(2);
  });

  test(`Audiences: no control focused by Tab sits under the save bar at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 640 });
    await page.goto(`${PRODUCT}/audiences?fixture=verified`);
    await untilAppStable(page);
    expect(await walkClearOfBar(page, 'aec-vendor-product-facet-editor form')).toBeGreaterThan(4);
  });
}

test('company Profile: two columns from 768px, the order unchanged, axe clean', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${PATH}/profile?fixture=verified`);
  await untilAppStable(page);
  const website = await page.locator('#vendor-profile-website').boundingBox();
  const headquarters = await page.locator('#vendor-profile-headquarters').boundingBox();
  // Website and Headquarters share a row, Website first.
  expect(Math.abs(website!.y - headquarters!.y)).toBeLessThan(2);
  expect(website!.x).toBeLessThan(headquarters!.x);
  await expect(page.getByText('Profile details', { exact: true })).toBeVisible();
  expect(await axeSerious(page)).toEqual([]);

  await page.setViewportSize({ width: 390, height: 900 });
  const narrowWebsite = await page.locator('#vendor-profile-website').boundingBox();
  const narrowHq = await page.locator('#vendor-profile-headquarters').boundingBox();
  expect(narrowHq!.y).toBeGreaterThan(narrowWebsite!.y);
});

test('company Profile: an AECi lock is read-only with its glyph and reason', async ({ page }) => {
  await page.goto(`${PATH}/profile?fixture=verified&locked=1`);
  await untilAppStable(page);
  const phone = page.locator('#vendor-profile-phone-number');
  await expect(phone).toHaveAttribute('readonly', '');
  await expect(phone).toHaveAccessibleDescription(/Set by AEC Integrations/);
  const note = page.locator('#vendor-profile-phone-number-locked');
  await expect(note.locator('xpath=ancestor::div[1]').locator('svg')).toHaveCount(1);
  expect(await axeSerious(page)).toEqual([]);
});

test('company Profile: the save result shows in the bar and the shell region reads it', async ({
  page,
}) => {
  await page.goto(`${PATH}/profile?fixture=verified`);
  await untilAppStable(page);
  const hq = page.locator('#vendor-profile-headquarters');
  const save = page.locator('aec-vendor-profile-form').getByRole('button', {
    name: 'Save changes',
  });
  await expect(async () => {
    await hq.fill(`Denver, Colorado ${Date.now()}`);
    await expect(save).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await save.click();
  const bar = page.locator('aec-vendor-profile-form .aec-portal-save-bar');
  await expect(bar).toContainText('Profile updated');
  await expect(bar.locator('[role="status"], [aria-live]')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Profile updated' })).toHaveCount(1);
});

test('Free product: Managed-only fields stay read-only, the Free ones stay editable', async ({
  page,
}) => {
  await page.goto(`${PRODUCT}/profile?fixture=free`);
  await untilAppStable(page);
  for (const name of ['Description', 'Website']) {
    await expect(page.getByLabel(name, { exact: true })).not.toHaveAttribute('readonly', '');
  }
  for (const name of ['Integrations page URL', 'API documentation URL']) {
    const field = page.getByLabel(name, { exact: true });
    await expect(field).toHaveAttribute('readonly', '');
    await expect(field).toHaveAccessibleDescription(/Part of Managed for this product/);
  }
  await expect(page.getByTestId('logo-edit')).toBeVisible();
  expect(await axeSerious(page)).toEqual([]);
});

test('Free product: trades are read-only with the reason, and there is no Save', async ({
  page,
}) => {
  await page.goto(`${PRODUCT}/trades?fixture=free`);
  await untilAppStable(page);
  const editor = page.locator('aec-vendor-product-facet-editor');
  await expect(editor.getByTestId('locked-reason')).toBeVisible();
  const boxes = editor.locator('fieldset input[type="checkbox"]');
  expect(await boxes.count()).toBeGreaterThan(0);
  for (const box of await boxes.all()) await expect(box).toBeDisabled();
  await expect(editor.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
  expect(await axeSerious(page)).toEqual([]);
});

test('Categories: the ticked terms are chips, and the 10-term limit holds', async ({ page }) => {
  await page.goto(`${PRODUCT}/categories?fixture=verified`);
  await untilAppStable(page);
  const editor = page.locator('aec-vendor-product-facet-editor');
  const chips = editor.getByTestId('facet-chosen').locator('aec-chip');
  const boxes = editor.locator('fieldset input[type="checkbox"]');
  const ticked = async () =>
    await boxes.evaluateAll((els) => els.filter((e) => (e as HTMLInputElement).checked).length);
  await expect(chips).toHaveCount(await ticked());

  const total = await boxes.count();
  for (let i = 0; i < total; i++) {
    const box = boxes.nth(i);
    if ((await box.isChecked()) || (await box.isDisabled())) continue;
    await box.check();
  }
  const count = await ticked();
  expect(count).toBe(Math.min(10, total));
  await expect(chips).toHaveCount(count);
  await expect(editor.getByText(`${count} of 10 selected`)).toBeVisible();
  // At the limit, every unticked term is disabled until one is unticked.
  for (const box of await boxes.all()) {
    if (!(await box.isChecked())) await expect(box).toBeDisabled();
  }
  expect(await axeSerious(page)).toEqual([]);
});
