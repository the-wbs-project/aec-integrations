/**
 * AECI-1765: the shared `aecCard`, rendered. jsdom runs no Tailwind and no cascade
 * layers, so the component specs cannot see a 24px radius, the shadow, the
 * forced-colours edge, the hover lift or the stretched link. This spec reads
 * computed styles off the `/products` card grid, then runs axe over it.
 *
 * Paths are `baseURL`-relative: never hardcode a port.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { untilHydrated } from './hydration';

const CARD_SHADOW = 'rgba(0, 0, 0, 0.06) 0px 1px 3px 0px, rgba(0, 0, 0, 0.24) 0px 16px 36px -16px';

const CARD = 'aec-product-card-grid li > div';

test.describe('aecCard rendered (AECI-1765)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/products');
    await expect(page.locator(CARD).first()).toBeVisible();
  });

  test('a card is 24px round, shadowed, with a 1px transparent edge', async ({ page }) => {
    const s = await page
      .locator(CARD)
      .nth(1)
      .evaluate((el) => {
        const c = getComputedStyle(el);
        return {
          radius: c.borderTopLeftRadius,
          width: c.borderTopWidth,
          edge: c.borderTopColor,
          shadow: c.boxShadow,
          bg: c.backgroundColor,
        };
      });
    expect(s.radius).toBe('24px');
    expect(s.width).toBe('1px');
    expect(s.edge).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    // Tailwind prepends four empty ring and inset layers. The recipe is the last two.
    expect(s.shadow.endsWith(CARD_SHADOW)).toBe(true);
    expect(s.bg).toMatch(/^(rgb\(255, 255, 255\)|oklch\(1 0 0\))$/);
  });

  test('the card title is 20px on a 25px line', async ({ page }) => {
    const title = page.locator(CARD).nth(1).locator('p').first();
    const s = await title.evaluate((el) => {
      const c = getComputedStyle(el);
      return { size: c.fontSize, line: c.lineHeight };
    });
    expect(s.size).toBe('20px');
    expect(s.line).toBe('25px');
  });

  test('the grid never has more than three columns, and the columns are equal', async ({
    page,
  }) => {
    for (const [width, cols] of [
      [390, 1],
      [640, 1],
      [700, 1],
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
          { message: `${width}px column count` },
        )
        .toBe(cols);
      // Equal widths: the featured lead must never create an uneven extra column.
      const widths = await page
        .locator('aec-product-card-grid ul')
        .evaluate((ul) => getComputedStyle(ul).gridTemplateColumns.split(' ').map(parseFloat));
      expect(Math.max(...widths) - Math.min(...widths), `${width}px`).toBeLessThan(1);
    }
  });

  test('the link is the title, stretched over the whole card, and the facts stay outside it', async ({
    page,
  }) => {
    const card = page.locator(CARD).nth(1);
    const link = card.getByRole('link');
    await expect(link).toHaveCount(1);
    const name = ((await link.textContent()) ?? '').trim();
    expect(name.length).toBeGreaterThan(0);
    await expect(link).toHaveAccessibleName(name);
    // The stretched link covers the card, so a click anywhere on it navigates.
    const [cardBox, afterBox] = await Promise.all([
      card.boundingBox(),
      link.evaluate((a) => {
        const r = getComputedStyle(a, '::after');
        return { pos: r.position, w: parseFloat(r.width), h: parseFloat(r.height) };
      }),
    ]);
    expect(afterBox.pos).toBe('absolute');
    // The pseudo-element fills the padding box, inside the 1px transparent edge.
    expect(afterBox.w).toBeCloseTo(cardBox!.width - 2, 0);
    expect(afterBox.h).toBeCloseTo(cardBox!.height - 2, 0);
    // The other facts read as plain text inside the card, not inside the link name.
    const text = ((await card.textContent()) ?? '').trim();
    expect(text.length).toBeGreaterThan(name.length);
  });

  test('the whole card is clickable', async ({ page }) => {
    const card = page.locator(CARD).nth(1);
    const href = await card.getByRole('link').getAttribute('href');
    const box = (await card.boundingBox())!;
    await untilHydrated(page.locator('aec-product-card-grid'));
    await page.mouse.click(box.x + box.width - 12, box.y + box.height - 12);
    await expect(page).toHaveURL(new RegExp(`${href}$`));
  });

  test('keyboard focus draws a 3px ring at 3px around the whole card, unclipped', async ({
    page,
  }) => {
    const card = page.locator(CARD).nth(1);
    await card.getByRole('link').focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const s = await card.evaluate((el) => {
      const c = getComputedStyle(el);
      const a = el.querySelector('a')!;
      return {
        width: c.outlineWidth,
        offset: c.outlineOffset,
        style: c.outlineStyle,
        linkOutline: getComputedStyle(a).outlineWidth,
        clip: (el.parentElement && getComputedStyle(el.parentElement).overflow) ?? '',
      };
    });
    expect(s.width).toBe('3px');
    expect(s.offset).toBe('3px');
    expect(s.style).toBe('solid');
    // The title link draws no ring of its own.
    expect(s.linkOutline).toBe('0px');
    expect(s.clip).toBe('visible');
  });

  test('hover lifts the card 4px from a static wrapper, and not under reduced motion', async ({
    page,
  }) => {
    const card = page.locator(CARD).nth(1);
    const li = page.locator('aec-product-card-grid li').nth(1);
    await untilHydrated(page.locator('aec-product-card-grid'));
    await card.scrollIntoViewIfNeeded();
    const top = async () => (await card.boundingBox())!.y;
    const wrapperTop = async () => (await li.boundingBox())!.y;
    const before = await top();
    const wrapperBefore = await wrapperTop();
    await card.hover();
    await expect.poll(top).toBeCloseTo(before - 4, 0);
    // The wrapper that holds the hover does not move.
    expect(await wrapperTop()).toBeCloseTo(wrapperBefore, 0);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.mouse.move(0, 0);
    await expect.poll(top).toBeCloseTo(before, 0);
    await card.hover();
    await page.waitForTimeout(300);
    expect(await top()).toBeCloseTo(before, 0);
  });

  test('the hover is stable with the pointer 2px above the card bottom edge', async ({ page }) => {
    const card = page.locator(CARD).nth(1);
    await untilHydrated(page.locator('aec-product-card-grid'));
    await card.scrollIntoViewIfNeeded();
    const box = (await card.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height - 2;
    await page.mouse.move(x, y);
    await page.waitForTimeout(400);
    // Sample the card position for a while: a flicker would swing it between 0 and -4px.
    const samples: number[] = [];
    for (let i = 0; i < 12; i++) {
      samples.push((await card.boundingBox())!.y);
      await page.waitForTimeout(60);
    }
    expect(Math.max(...samples) - Math.min(...samples)).toBeLessThan(0.5);
    // Lifted 4px and held there, even though the pointer is now below the card's own box.
    expect(samples[0]).toBeCloseTo(box.y - 4, 0);
  });

  test('forced colours: the dropped shadow leaves a visible system-colour edge', async ({
    page,
  }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    const card = page.locator(CARD).nth(1);
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
