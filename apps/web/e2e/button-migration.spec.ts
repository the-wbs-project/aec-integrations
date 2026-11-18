/**
 * AECI-1759: the public pages render the shared `aecButton`, measured. jsdom
 * runs no Tailwind and no cascade layers, so a component spec cannot see a 44px
 * height, a 12px radius or a fill. Three representative migrated buttons:
 *
 * - the home hero's submit (primary, full width),
 * - the 404 page's "Go home" link (a primary link),
 * - a product page's "Suggest a correction" link (a secondary link, with an icon).
 *
 * Paths are `baseURL`-relative: never hardcode a port.
 */
import { expect, test, type Locator } from '@playwright/test';

import { untilHydrated } from './hydration';

const FOREST = 'rgb(30, 58, 47)';
const WHITE = 'rgb(255, 255, 255)';
const BORDER_STRONG = 'rgb(212, 212, 216)';

/**
 * Computed colours come back as `oklch(…)` in some engines, so read them via a canvas.
 *
 * Read the settled value only (AECI-1922). Hydration rewrites the button's class
 * attribute in two steps: it first writes the template's static class (`mt-12`),
 * which drops the fill, and the host binding adds the recipe back in the update
 * pass. No frame paints between the two (AECI-1937), but a style read from a
 * script in that gap, such as this test polling the element, resolves the button
 * with no fill. The recipe's `background-color` transition then fades Forest back
 * in over `--duration-fast`. A read during the fade gets a part-transparent Forest,
 * and the canvas readback rounds a channel one step off: CI saw rgb(31, 58, 47),
 * a local run 2 failures in 50. The token itself is exact: oklch(32.24% 0.0397
 * 166.73) is rgb(30.03, 58.00, 47.01). So wait for hydration, move the pointer
 * off the page (a hover is a different fill), and let every transition finish.
 */
async function style(loc: Locator) {
  await loc.page().mouse.move(0, 0);
  await untilHydrated(loc);
  await loc.evaluate((el) =>
    Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined))),
  );
  return loc.evaluate((el) => {
    const toRgb = (c: string) => {
      const ctx = document.createElement('canvas').getContext('2d')!;
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return a === 0 ? 'transparent' : `rgb(${r}, ${g}, ${b})`;
    };
    const s = getComputedStyle(el);
    return {
      height: el.getBoundingClientRect().height,
      radius: s.borderTopLeftRadius,
      background: toRgb(s.backgroundColor),
      color: toRgb(s.color),
      borderColor: toRgb(s.borderTopColor),
      opacity: s.opacity,
      boxShadow: s.boxShadow,
    };
  });
}

test.describe('public buttons on aecButton (AECI-1759)', () => {
  test('home hero submit: 44px, 12px, Forest fill', async ({ page }) => {
    await page.goto('/');
    const button = page
      .locator('form[aria-labelledby="hero-pair-title"]')
      .getByRole('button', { name: 'Show integrations' });
    await expect(button).toBeVisible();
    await untilHydrated(page.locator('form[aria-labelledby="hero-pair-title"]'));
    const rest = await style(button);
    expect(rest.height).toBe(44);
    expect(rest.radius).toBe('12px');
    expect(rest.background).toBe(FOREST);
    expect(rest.color).toBe(WHITE);
    expect(rest.boxShadow).toBe('none');
    await expect(button).toHaveAttribute('type', 'submit');
  });

  test('404 "Go home" is a 44px primary link', async ({ page }) => {
    await page.goto('/never-a-real-route');
    const link = page.getByRole('link', { name: 'Go home' });
    await expect(link).toBeVisible();
    const s = await style(link);
    expect(s.height).toBe(44);
    expect(s.radius).toBe('12px');
    expect(s.background).toBe(FOREST);
    expect(s.color).toBe(WHITE);
  });

  test('product page "Suggest a correction" is a 44px secondary link with a visible edge', async ({
    page,
  }) => {
    await page.goto('/products/dynamo-for-revit');
    const link = page.getByRole('link', { name: 'Suggest a correction' }).first();
    await expect(link).toBeVisible();
    const s = await style(link);
    expect(s.height).toBe(44);
    expect(s.radius).toBe('12px');
    expect(s.background).not.toBe(FOREST);
    expect(s.borderColor).toBe(BORDER_STRONG);
    expect(s.boxShadow).toBe('none');
  });
});
