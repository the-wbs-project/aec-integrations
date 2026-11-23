/**
 * AECI-1776: the footer's keyboard focus ring on the Forest ground.
 *
 * `styles.css` carries a global `:focus-visible` colour rule. This pins the
 * rendered result, which a class assertion in the component spec cannot: a
 * focused footer link draws a 3px Bone ring at a 3px offset.
 */
import { expect, test } from '@playwright/test';

import { waitForHydrationSettle } from './console-capture';

test.describe('site footer focus ring (AECI-1776)', () => {
  test('a focused footer link draws a 3px Bone outline at a 3px offset', async ({ page }) => {
    await page.goto('/legal/terms');
    await waitForHydrationSettle(page);
    const links = page.locator('footer nav[aria-label="Directory"] a');
    const link = links.first();
    await link.focus();
    // Move away and back with the keyboard so :focus-visible matches.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    const ring = await link.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        focused: el.matches(':focus-visible'),
        color: cs.outlineColor,
        width: cs.outlineWidth,
        style: cs.outlineStyle,
        offset: cs.outlineOffset,
      };
    });
    expect(ring.focused).toBe(true);
    expect(ring.width).toBe('3px');
    expect(ring.offset).toBe('3px');
    expect(ring.style).not.toBe('none');
    // --focus-ring-on-brand is Bone, #F5F2EA.
    expect(ring.color).toBe('oklch(0.9613 0.0111 89.72)');
  });
});
