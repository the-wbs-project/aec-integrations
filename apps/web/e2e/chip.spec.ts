/**
 * AECI-1763: the one chip, rendered.
 *
 * A static chip sets no cursor of its own, so a chip on a product card shows the
 * pointer of the card's link. Since AECI-1765 that link sits on the title and is
 * stretched over the card, so the check reads the cursor of whatever is on top
 * at the chip's centre. A rendered check is the only way to prove it: the recipe
 * lives in the global stylesheet, which a component spec does not load.
 */
import { expect, test } from '@playwright/test';

test.describe('aec-chip (AECI-1763)', () => {
  test('a static chip on a product card shows the link pointer', async ({ page }) => {
    await page.goto('/products');
    const chip = page.locator('.aec-card span.aec-chip').first();
    await expect(chip).toBeVisible();
    await chip.scrollIntoViewIfNeeded();
    const probe = await chip.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        own: getComputedStyle(el).cursor,
        onTop: top ? getComputedStyle(top).cursor : null,
        onTopIsLink: !!top?.closest('a[href^="/products/"]'),
      };
    });
    // The chip never forces an arrow, and the stretched card link is what a
    // pointer meets there.
    expect(probe.own).not.toBe('default');
    expect(probe.onTopIsLink).toBe(true);
    expect(probe.onTop).toBe('pointer');
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
