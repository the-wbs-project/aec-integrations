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
 * Read the settled value only. Wait for hydration, move the pointer off the page
 * (a hover is a different fill), and let every transition finish. AECI-1922 added
 * these waits for a fade that hydration caused. Hydration wrote the template's
 * static class (`mt-12`) alone until the next update pass. A style read in that
 * gap resolved the link with no fill, and the `background-color` transition then
 * faded Forest back in. A read mid-fade got rgb(31, 58, 47). AECI-1937 removed
 * the gap at its source
 * (`shared/host-recipe.ts`). The waits stay because they are sound on their own.
 * `watchRecipe` below fails the test if the fade's cause comes back, so the waits
 * cannot hide it.
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

/**
 * AECI-1937: records every observer state in which an `aecButton` lacks its
 * recipe. A MutationObserver callback runs between scripts, which is where a
 * style read or a frame can land. So a class list there that lacks `aec-btn` is
 * one the browser could style. `e2e/hydration-class-recipe.spec.ts` is the full
 * guard. This keeps the three buttons here honest on their own.
 */
function watchRecipe(): void {
  const lost: string[] = [];
  (window as unknown as { __aecBtnLost: string[] }).__aecBtnLost = lost;
  new MutationObserver((records) => {
    for (const el of new Set(records.map((r) => r.target as Element))) {
      if (el.hasAttribute('aecbutton') && !el.classList.contains('aec-btn')) {
        lost.push(`${(el.textContent ?? '').trim()}: "${el.getAttribute('class') ?? ''}"`);
      }
    }
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['class'] });
}

async function expectRecipeNeverLost(loc: Locator): Promise<void> {
  const lost = await loc
    .page()
    .evaluate(() => (window as unknown as { __aecBtnLost: string[] }).__aecBtnLost);
  expect(lost, 'an aecButton was paintable without its recipe').toEqual([]);
}

test.describe('public buttons on aecButton (AECI-1759)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(watchRecipe);
  });

  test('home hero submit: 44px, 12px, Forest fill', async ({ page }) => {
    await page.goto('/');
    const button = page
      .locator('form[aria-labelledby="hero-pair-title"]')
      .getByRole('button', { name: 'Show integrations' });
    await expect(button).toBeVisible();
    await untilHydrated(page.locator('form[aria-labelledby="hero-pair-title"]'));
    const rest = await style(button);
    await expectRecipeNeverLost(button);
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
    await expectRecipeNeverLost(link);
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
    await expectRecipeNeverLost(link);
    expect(s.height).toBe(44);
    expect(s.radius).toBe('12px');
    expect(s.background).not.toBe(FOREST);
    expect(s.borderColor).toBe(BORDER_STRONG);
    expect(s.boxShadow).toBe('none');
  });
});
