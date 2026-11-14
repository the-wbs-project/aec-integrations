/**
 * AECI-1770: the shared overlay surfaces, rendered. jsdom runs no Tailwind and no
 * cascade, so the component specs cannot see a 24px radius, a shadow or a backdrop
 * colour. This spec reads computed styles off a dialog (the claim dialog), a drawer
 * (the request drawer) and a popover (the listing sort listbox), checks the one
 * scrim, the forced-colours edge, focus return and Escape, then runs axe with each
 * open. Paths are `baseURL`-relative: never hardcode a port.
 */
import AxeBuilder from '@axe-core/playwright';
import { type Locator, type Page, expect, test } from '@playwright/test';

import { waitForHydrationSettle } from './console-capture';
import { untilHydrated } from './hydration';

const MODAL_SHADOW = 'rgba(0, 0, 0, 0.18) 0px 16px 48px -8px, rgba(0, 0, 0, 0.1) 0px 4px 16px -2px';
const MENU_SHADOW = 'rgba(0, 0, 0, 0.12) 0px 8px 24px -4px, rgba(0, 0, 0, 0.06) 0px 2px 8px -1px';
const WHITE = /^(rgb\(255, 255, 255\)|oklch\(1 0 0\))$/;

const surface = (el: Element) => {
  const c = getComputedStyle(el);
  return {
    radiusTL: c.borderTopLeftRadius,
    radiusBL: c.borderBottomLeftRadius,
    width: c.borderTopWidth,
    edge: c.borderTopColor,
    shadow: c.boxShadow,
    bg: c.backgroundColor,
  };
};

/** The backdrop's computed colour, from the overlay container. */
const backdropColor = (page: Page) =>
  page
    .locator('.cdk-overlay-backdrop-showing')
    .last()
    .evaluate((el) => getComputedStyle(el).backgroundColor);

async function openClaimDialog(page: Page): Promise<{ trigger: Locator; dialog: Locator }> {
  await page.goto('/vendor-program');
  await waitForHydrationSettle(page);
  const trigger = page
    .locator('aec-plan-cards section[aria-labelledby="plan-card-managed"]')
    .getByRole('link', { name: 'Claim your listing' });
  const dialog = page.getByRole('dialog');
  await expect(async () => {
    await trigger.click();
    await expect(dialog).toBeVisible({ timeout: 2000 });
  }).toPass();
  return { trigger, dialog };
}

async function openDrawer(page: Page): Promise<{ trigger: Locator; drawer: Locator }> {
  await page.goto('/products/dynamo-for-revit');
  await waitForHydrationSettle(page);
  const trigger = page.getByRole('link', { name: 'Suggest a correction' }).first();
  const drawer = page.locator('.aec-drawer');
  await expect(async () => {
    await trigger.click();
    await expect(drawer).toBeVisible({ timeout: 2000 });
  }).toPass();
  return { trigger, drawer };
}

async function openSort(page: Page): Promise<{ trigger: Locator; popover: Locator }> {
  await page.goto('/products');
  await waitForHydrationSettle(page);
  const trigger = page.locator('aec-listing-sort-select').getByRole('combobox');
  const popover = page.getByRole('listbox', { name: 'Sort' });
  await expect(async () => {
    await trigger.click();
    await expect(popover).toBeVisible({ timeout: 2000 });
  }).toPass();
  return { trigger, popover };
}

/** axe reads a colour mid-fade as a blend, so let every running animation finish. */
const axeOn = async (page: Page, selector: string) => {
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
  );
  return new AxeBuilder({ page })
    .include(selector)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
};

test.describe('overlay surfaces (AECI-1770)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('a dialog is 24px round, shadowed, white, on the 50% scrim', async ({ page }) => {
    const { dialog } = await openClaimDialog(page);
    const panel = dialog.locator('.aec-dialog').first();
    const s = await panel.evaluate(surface);
    expect(s.radiusTL).toBe('24px');
    expect(s.width).toBe('1px');
    expect(s.shadow.endsWith(MODAL_SHADOW)).toBe(true);
    expect(s.bg).toMatch(WHITE);
    expect(await backdropColor(page)).toBe('rgba(0, 0, 0, 0.5)');
  });

  test('a dialog traps focus, closes on Escape and returns focus; axe is clean', async ({
    page,
  }) => {
    const { trigger, dialog } = await openClaimDialog(page);
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    const results = await axeOn(page, '[role="dialog"]');
    expect(results.violations).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('the dialog keeps an edge in forced-colours mode, where the shadow is dropped', async ({
    page,
  }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    const { dialog } = await openClaimDialog(page);
    const s = await dialog.locator('.aec-dialog').first().evaluate(surface);
    expect(s.shadow).toBe('none');
    expect(s.width).toBe('1px');
    expect(s.edge).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  });

  test('below sm the claim dialog is a full-screen sheet with no corner or shadow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 700 });
    const { dialog } = await openClaimDialog(page);
    const s = await dialog.locator('.aec-dialog').first().evaluate(surface);
    expect(s.radiusTL).toBe('0px');
    // `shadow-none` leaves transparent ring layers, so assert no visible layer.
    expect(s.shadow).not.toMatch(/rgba\(0, 0, 0, 0\.\d/);
    expect(s.width).toBe('0px');
  });

  test('the drawer takes the modal recipe, keeps the page undimmed, and returns focus', async ({
    page,
  }) => {
    const { trigger, drawer } = await openDrawer(page);
    const s = await drawer.evaluate(surface);
    expect(s.radiusTL).toBe('24px');
    expect(s.radiusBL).toBe('24px');
    expect(s.shadow.endsWith(MODAL_SHADOW)).toBe(true);
    expect(s.bg).toMatch(WHITE);
    // The drawer keeps the page visible behind a transparent backdrop (AECI-128).
    expect(await backdropColor(page)).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      expect(await drawer.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    const results = await axeOn(page, '[role="dialog"]');
    expect(results.violations).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('the drawer is a bottom sheet below sm: top corners only', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 700 });
    const { drawer } = await openDrawer(page);
    const s = await drawer.evaluate(surface);
    expect(s.radiusTL).toBe('24px');
    expect(s.radiusBL).toBe('0px');
  });

  test('a popover is 12px round on the menu shadow, and axe is clean', async ({ page }) => {
    const { trigger, popover } = await openSort(page);
    const s = await popover.evaluate(surface);
    expect(s.radiusTL).toBe('12px');
    expect(s.width).toBe('1px');
    expect(s.shadow.endsWith(MENU_SHADOW)).toBe(true);
    expect(s.bg).toMatch(WHITE);
    const results = await axeOn(page, '[role="listbox"]');
    expect(results.violations).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('the popover keeps an edge in forced-colours mode', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    const { popover } = await openSort(page);
    const s = await popover.evaluate(surface);
    expect(s.shadow).toBe('none');
    expect(s.width).toBe('1px');
    expect(s.edge).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  });

  test('under reduced motion the scrim and the drawer change at once', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const { drawer } = await openDrawer(page);
    const d = await drawer.evaluate((el) => {
      const c = getComputedStyle(el);
      return { name: c.animationName, ms: parseFloat(c.animationDuration) * 1000 };
    });
    expect(d.ms).toBeLessThan(1);
    const b = await page
      .locator('.cdk-overlay-backdrop')
      .last()
      .evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration) * 1000);
    expect(b).toBeLessThan(1);
  });

  test('the open Browse menu dims the page at 40%, a dialog backdrop at 50%', async ({ page }) => {
    await page.goto('/preview/layouts/browse');
    const browse = page
      .locator('aec-site-header')
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Browse', exact: true });
    await untilHydrated(browse);
    await browse.focus();
    await page.keyboard.press('ArrowDown');
    await expect(browse).toHaveAttribute('aria-expanded', 'true');
    const dimmer = page.locator('[data-browse-dimmer]');
    await expect(dimmer).toBeVisible();
    expect(await dimmer.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      'rgba(0, 0, 0, 0.4)',
    );
    await openClaimDialog(page);
    expect(await backdropColor(page)).toBe('rgba(0, 0, 0, 0.5)');
  });

  test('the scrim fade takes the slow step', async ({ page }) => {
    await openClaimDialog(page);
    const ms = await page
      .locator('.cdk-overlay-backdrop-showing')
      .last()
      .evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration) * 1000);
    expect(ms).toBe(280);
  });
});
