/**
 * AECI-1928: Source Serif never renders below 20px on a public page (DESIGN.md
 * §3 "The Serif-Floor Rule"). `--t-12` to `--t-16` are sans. The global
 * `h1, h2, h3` rule makes small serif easy to leak: a `text-t-16` span inside an
 * `h2` inherits the serif. A source scan cannot see that, so this reads the
 * rendered page. Every visible text node whose element computes to Source Serif
 * must be 20px or more.
 *
 * The source half (a class string that pairs `font-display` with a small size)
 * is in `src/design-tokens.guard.spec.ts`. Paths are `baseURL`-relative: never
 * hardcode a port.
 */
import { expect, test, type Page } from '@playwright/test';

const PATHS = [
  '/',
  '/products',
  '/products/dynamo-for-revit',
  // The category hub's heading and the 32px initial tile (unclaimed).
  '/products/fixture-acme-connector',
  // Disclosure group cards: the count sits inside the card's h3.
  '/products/fx-procore',
  '/products/fx-mindcloud',
  '/products/revit/integrations/procore',
  '/vendors/autodesk',
  '/categories',
  '/about',
  '/methodology',
  '/vendor-program',
  '/docs',
  '/docs/getting-started/checking-before-you-buy',
  '/legal/terms',
  '/never-a-real-route',
];

/** Every visible serif text run below 20px: element, size and its first words. */
function smallSerif(page: Page) {
  return page.evaluate(() => {
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      const el = node.parentElement;
      if (!text || !el) continue;
      const style = getComputedStyle(el);
      if (!/Source Serif/.test(style.fontFamily)) continue;
      const size = parseFloat(style.fontSize);
      if (size >= 20) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0 || style.visibility === 'hidden') continue;
      if (el.closest('[aria-hidden="true"]') && el.closest('svg')) continue;
      out.push(
        `<${el.tagName.toLowerCase()} class="${el.className}"> ${size}px "${text.slice(0, 40)}"`,
      );
    }
    return out;
  });
}

test.describe('the Serif-Floor Rule, rendered (AECI-1928)', () => {
  for (const width of [1440, 390]) {
    test(`no serif text below 20px on the public pages at ${width}px`, async ({ page }) => {
      test.slow();
      await page.setViewportSize({ width, height: 900 });
      for (const path of PATHS) {
        await page.goto(path);
        await expect(page.locator('h1').first(), path).toBeAttached();
        expect(await smallSerif(page), `${path} at ${width}px`).toEqual([]);
      }
    });
  }
});
