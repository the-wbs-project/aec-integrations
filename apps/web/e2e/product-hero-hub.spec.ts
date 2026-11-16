/**
 * AECI-1787: the product hero's category hub with the pair finder under it (ruling R3
 * decision 1, DESIGN.md §5 "The hero diagram").
 *
 * Local seed data: `revit` has partners in three categories. `autocad` has no
 * integrations. The order and membership of the hub are pinned behaviourally in
 * `src/app/products/on-page-ordering-firewall.spec.ts`; this spec pins what only a
 * browser shows: the server HTML, the breakpoints, the motion and the layout shift.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { untilHydrated } from './hydration';

const WITH_HUB = 'revit';
const ZERO = 'autocad';

test.describe('product hero category hub (AECI-1787)', () => {
  test('the hub and the finder are in the server HTML, the hub A to Z', async ({ request }) => {
    const res = await request.get(`/products/${WITH_HUB}`);
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="product-category-hub"');
    expect(html).toContain('data-testid="product-pair-finder"');
    expect(html).toContain('action="/search"');
    // The server renders no tab stop on the row.
    expect(html).not.toMatch(/data-testid="product-category-hub"[^>]*tabindex/);
  });

  test('reads A to Z with a worded count for each category', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/products/${WITH_HUB}`);
    const list = page.getByRole('list', { name: 'Integrations by partner category' });
    const names = await list
      .getByRole('listitem')
      .evaluateAll((items) =>
        items.map((li) => li.lastElementChild!.firstChild!.textContent!.trim()),
      );
    expect(names.length).toBeGreaterThan(0);
    expect(names).toEqual(
      [...names].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })),
    );
    await expect(list.getByRole('listitem').first()).toContainText(/, \d+ integrations?$/);
  });

  test('from lg the finder sits under the hub; below lg the panel holds the hub alone', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/products/${WITH_HUB}`);
    const hub = page.getByTestId('product-category-hub');
    const finder = page.getByTestId('product-pair-finder');
    await expect(finder).toBeVisible();
    const [h, f] = [await hub.boundingBox(), await finder.boundingBox()];
    expect(f!.y).toBeGreaterThan(h!.y + h!.height);

    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`/products/${WITH_HUB}`);
    await expect(page.getByTestId('product-category-hub')).toBeVisible();
    await expect(page.getByTestId('product-pair-finder')).toBeHidden();
  });

  test('with no integrations the panel holds the finder from lg and is gone below lg', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/products/${ZERO}`);
    await expect(page.getByTestId('product-category-hub')).toHaveCount(0);
    await expect(page.getByTestId('product-pair-finder')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`/products/${ZERO}`);
    await expect(page.locator('.aec-hero-panel')).toBeHidden();
  });

  test('the finder searches the typed text with no pick, after hydration', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/products/${WITH_HUB}`);
    const finder = page.getByTestId('product-pair-finder');
    await untilHydrated(finder);
    await finder.getByLabel('Connects to').fill('zzz typed');
    await finder.getByRole('button', { name: 'Show integrations' }).click();
    await expect(page).toHaveURL(/\/search\?q=zzz(\+|%20)typed/);
  });

  test('one entrance at the slow step, and none under reduced motion', async ({ browser }) => {
    for (const reducedMotion of ['no-preference', 'reduce'] as const) {
      const ctx = await browser.newContext({
        reducedMotion,
        viewport: { width: 1280, height: 900 },
      });
      const page = await ctx.newPage();
      await page.goto(`/products/${WITH_HUB}`);
      const anim = await page
        .getByTestId('product-category-hub')
        .evaluate((el) => [
          getComputedStyle(el).animationName,
          getComputedStyle(el).animationDuration,
        ]);
      // Under reduce the name is none. The global rule's 0.01ms floor is moot then.
      if (reducedMotion === 'reduce') expect(anim[0]).toBe('none');
      else expect(anim).toEqual(['aec-category-hub-in', '0.28s']);
      await ctx.close();
    }
  });

  // Review finding: the worded counts are `sr-only`, so absolutely positioned. Without
  // the entrance transform (reduced motion) they escaped the scrolling row, and the
  // whole page scrolled sideways at 390px. The row is now their containing block.
  test('the page never scrolls sideways at 390px, with or without motion', async ({ browser }) => {
    for (const reducedMotion of ['no-preference', 'reduce'] as const) {
      const ctx = await browser.newContext({
        reducedMotion,
        viewport: { width: 390, height: 900 },
      });
      const page = await ctx.newPage();
      await page.goto(`/products/${WITH_HUB}`, { waitUntil: 'networkidle' });
      await expect(page.getByTestId('product-category-hub')).toBeVisible();
      const [scroll, client] = await page.evaluate(() => [
        document.documentElement.scrollWidth,
        document.documentElement.clientWidth,
      ]);
      expect(scroll, reducedMotion).toBe(client);
      await ctx.close();
    }
  });

  for (const width of [1280, 390]) {
    test(`no layout shift from the hub at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(() => {
        (window as unknown as { __hubShift: number }).__hubShift = 0;
        new PerformanceObserver((list) => {
          for (const e of list.getEntries() as unknown as {
            value: number;
            hadRecentInput: boolean;
            sources?: { node?: Node | null }[];
          }[]) {
            if (e.hadRecentInput) continue;
            const inHub = (e.sources ?? []).some((s) =>
              s.node instanceof Element ? !!s.node.closest('.aec-hero-panel') : false,
            );
            if (inHub) (window as unknown as { __hubShift: number }).__hubShift += e.value;
          }
        }).observe({ type: 'layout-shift', buffered: true });
      });
      await page.goto(`/products/${WITH_HUB}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(600);
      const shift = await page.evaluate(
        () => (window as unknown as { __hubShift: number }).__hubShift,
      );
      expect(shift).toBeLessThan(0.001);
    });
  }

  for (const width of [1440, 390]) {
    test(`the hero has no axe violations at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      for (const slug of [WITH_HUB, ZERO]) {
        await page.goto(`/products/${slug}`);
        await untilHydrated(page.locator('aec-hero-band'));
        const results = await new AxeBuilder({ page }).include('aec-hero-band').analyze();
        expect(results.violations, slug).toEqual([]);
      }
    });
  }
});
