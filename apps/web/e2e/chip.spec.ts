/**
 * AECI-1763: the one chip, rendered.
 *
 * A static chip sets no cursor of its own, so a chip inside a product card link
 * keeps the pointer of the link around it. A computed-style check is the only way
 * to prove that: the recipe lives in the global stylesheet, which a component
 * spec does not load.
 */
import { expect, test } from '@playwright/test';

test.describe('aec-chip (AECI-1763)', () => {
  test('a static chip inside a product card link keeps the link pointer', async ({ page }) => {
    await page.goto('/products');
    const chip = page.locator('a[href^="/products/"] span.aec-chip').first();
    await expect(chip).toBeVisible();
    expect(await chip.evaluate((el) => getComputedStyle(el).cursor)).toBe('pointer');
  });

  test('a chip is a pill with no shadow', async ({ page }) => {
    await page.goto('/products');
    const style = await page
      .locator('.aec-chip')
      .first()
      .evaluate((el) => {
        const cs = getComputedStyle(el);
        return { radius: cs.borderTopLeftRadius, shadow: cs.boxShadow };
      });
    expect(parseFloat(style.radius)).toBeGreaterThan(100);
    expect(style.shadow).toBe('none');
  });

  test('a taxonomy link chip shows a 3px focus ring at 3px offset', async ({ page }) => {
    await page.goto('/products/fixture-procore');
    const chip = page.locator('a.aec-chip').first();
    await chip.focus();
    const ring = await chip.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { width: cs.outlineWidth, offset: cs.outlineOffset, style: cs.outlineStyle };
    });
    expect(ring).toEqual({ width: '3px', offset: '3px', style: 'solid' });
  });
});
