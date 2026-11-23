/**
 * AECI-1801: `/roadmap` in the new language. The placeholder is noindex and cached on
 * the static-page TTL. Since AECI-1801 it has one Bone band, the hero: the mailing list
 * signup takes its white ground, as on the product and vendor pages.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { expectNoSidewaysScroll } from './no-sideways-scroll';

const PATH = '/roadmap';

test.describe(`${PATH} (AECI-1801)`, () => {
  test('is noindex with a self-referential canonical', async ({ page }) => {
    const res = await page.goto(PATH);
    expect(res?.status()).toBe(200);
    await expect(page.locator('head meta[name="robots"]')).toHaveAttribute('content', 'noindex');
    await expect(page.locator('head link[rel="canonical"]')).toHaveAttribute(
      'href',
      new RegExp(`${PATH}$`),
    );
  });

  for (const width of [1440, 390]) {
    test(`has one Bone band and the signup on white, axe clean, at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(PATH);
      await expect(page.locator('.aec-bone-band')).toHaveCount(1);
      await expect(page.locator('aec-bone-band h1')).toHaveText("What we're building next");
      const signup = page.locator('aec-mailing-list-signup section');
      const [ground, base] = await signup.evaluate((el) => {
        const probe = document.createElement('div');
        probe.style.backgroundColor = 'var(--surface-base)';
        document.body.appendChild(probe);
        const white = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return [getComputedStyle(el).backgroundColor, white];
      });
      expect(ground).toBe(base);
      await expectNoSidewaysScroll(page);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});

// AECI-1720 layout pass: "In the meantime" sits over its two lines, one block.
test('the "In the meantime" heading sits directly over its text at 1440px', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(PATH);
  const heading = page.getByRole('heading', { level: 2, name: 'In the meantime' });
  const text = heading.locator('xpath=following-sibling::p[1]');
  const [h, t] = [(await heading.boundingBox())!, (await text.boundingBox())!];
  expect(Math.abs(h.x - t.x)).toBeLessThan(2);
  expect(t.y - (h.y + h.height)).toBeGreaterThanOrEqual(0);
  expect(t.y - (h.y + h.height)).toBeLessThan(40);
});
