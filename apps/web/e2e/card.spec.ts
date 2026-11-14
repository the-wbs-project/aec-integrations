/**
 * AECI-1765: the shared `aecCard`, rendered. jsdom runs no Tailwind and no cascade
 * layers, so the component specs cannot see a 24px radius, the shadow, the
 * forced-colours edge or the hover lift. This spec reads computed styles off the
 * `/products` card grid, then runs axe over it.
 *
 * Paths are `baseURL`-relative: never hardcode a port.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { untilHydrated } from './hydration';

const CARD_SHADOW = 'rgba(0, 0, 0, 0.06) 0px 1px 3px 0px, rgba(0, 0, 0, 0.24) 0px 16px 36px -16px';

test.describe('aecCard rendered (AECI-1765)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/products');
    await expect(page.locator('aec-product-card-grid li > a').first()).toBeVisible();
  });

  test('a card is 24px round, shadowed, with a 1px transparent edge', async ({ page }) => {
    const card = page.locator('aec-product-card-grid li > a').nth(1);
    const s = await card.evaluate((el) => {
      const c = getComputedStyle(el);
      return {
        radius: c.borderTopLeftRadius,
        width: c.borderTopWidth,
        edgeAlpha: c.borderTopColor,
        shadow: c.boxShadow,
        bg: c.backgroundColor,
      };
    });
    expect(s.radius).toBe('24px');
    expect(s.width).toBe('1px');
    expect(s.edgeAlpha).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    // Tailwind prepends four empty ring and inset layers. The recipe is the last two.
    expect(s.shadow.endsWith(CARD_SHADOW)).toBe(true);
    expect(s.bg).toMatch(/^(rgb\(255, 255, 255\)|oklch\(1 0 0\))$/);
  });

  test('the card title is 20px on a 25px line', async ({ page }) => {
    const title = page.locator('aec-product-card-grid li > a').nth(1).locator('p').first();
    const s = await title.evaluate((el) => {
      const c = getComputedStyle(el);
      return { size: c.fontSize, line: c.lineHeight };
    });
    expect(s.size).toBe('20px');
    expect(s.line).toBe('25px');
  });

  test('the grid never has more than three columns', async ({ page }) => {
    for (const [width, cols] of [
      [390, 1],
      [768, 2],
      [1024, 3],
      [1440, 3],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await expect
        .poll(
          () =>
            page
              .locator('aec-product-card-grid ul')
              .evaluate((ul) => getComputedStyle(ul).gridTemplateColumns.split(' ').length),
          { message: `${width}px` },
        )
        .toBe(cols);
    }
  });

  test('hover lifts an interactive card 4px, and not under reduced motion', async ({ page }) => {
    const card = page.locator('aec-product-card-grid li > a').nth(1);
    await untilHydrated(page.locator('aec-product-card-grid'));
    await card.scrollIntoViewIfNeeded();
    const top = async () => (await card.boundingBox())!.y;
    const before = await top();
    await card.hover();
    await expect.poll(top).toBeCloseTo(before - 4, 0);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.mouse.move(0, 0);
    await expect.poll(top).toBeCloseTo(before, 0);
    await card.hover();
    await page.waitForTimeout(300);
    expect(await top()).toBeCloseTo(before, 0);
  });

  test('forced colours: the dropped shadow leaves a visible system-colour edge', async ({
    page,
  }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    const card = page.locator('aec-product-card-grid li > a').nth(1);
    const read = () =>
      card.evaluate((el) => {
        const c = getComputedStyle(el);
        return { shadow: c.boxShadow, color: c.borderTopColor, width: c.borderTopWidth };
      });
    // The emulation lands a frame after the call, so wait for it.
    await expect.poll(async () => (await read()).shadow).toBe('none');
    const s = await read();
    expect(s.width).toBe('1px');
    // A transparent border is repainted in a system colour, so it is no longer clear.
    expect(s.color).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  });

  test('axe finds nothing on the card grid', async ({ page }) => {
    const results = await new AxeBuilder({ page })
      .include('aec-product-card-grid')
      .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
