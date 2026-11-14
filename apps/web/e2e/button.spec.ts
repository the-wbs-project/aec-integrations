/**
 * AECI-1758: the shared `aecButton`, rendered. jsdom runs no Tailwind and no
 * cascade layers, so the component spec cannot see a 44px height, a 12px radius
 * or an edge colour. This spec reads computed styles off the specimen on the
 * internal `/_demo/spartan` probe page, then runs axe over it.
 *
 * Paths are `baseURL`-relative: never hardcode a port.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator } from '@playwright/test';

import { untilHydrated } from './hydration';

const FOREST = 'rgb(30, 58, 47)';
const BONE = 'rgb(245, 242, 234)';
const WHITE = 'rgb(255, 255, 255)';
const BORDER_STRONG = 'rgb(212, 212, 216)';
const ERROR = 'rgb(179, 38, 30)';

/** Computed colours come back as `oklch(…)` in some engines, so read them via a canvas. */
async function style(loc: Locator) {
  return loc.evaluate((el) => {
    const toRgb = (c: string) => {
      const ctx = document.createElement('canvas').getContext('2d')!;
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return a === 0 ? 'transparent' : `rgb(${r}, ${g}, ${b})`;
    };
    const s = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return {
      height: box.height,
      width: box.width,
      radius: s.borderTopLeftRadius,
      borderWidth: s.borderTopWidth,
      borderColor: toRgb(s.borderTopColor),
      background: toRgb(s.backgroundColor),
      color: toRgb(s.color),
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
      boxShadow: s.boxShadow,
      outlineWidth: s.outlineWidth,
      outlineOffset: s.outlineOffset,
      outlineColor: toRgb(s.outlineColor),
      outlineStyle: s.outlineStyle,
      opacity: s.opacity,
      textDecoration: s.textDecorationLine,
    };
  });
}

test.describe('aecButton rendered (AECI-1758)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/_demo/spartan');
    await expect(page.getByTestId('button-specimen')).toBeVisible();
  });

  test('every variant is 44px high, 12px round, 14px at 600, with a 1px edge and no shadow', async ({
    page,
  }) => {
    for (const id of [
      'btn-primary',
      'btn-secondary',
      'btn-ghost',
      'btn-danger',
      'btn-link',
      'btn-compact',
      'btn-on-brand',
    ]) {
      const s = await style(page.getByTestId(id));
      expect(s.height, id).toBe(44);
      expect(s.radius, id).toBe('12px');
      expect(s.fontSize, id).toBe('14px');
      expect(s.fontWeight, id).toBe('600');
      expect(s.borderWidth, id).toBe('1px');
      expect(s.boxShadow, id).toBe('none');
    }
    const icon = await style(page.getByTestId('btn-icon'));
    expect([icon.width, icon.height]).toEqual([44, 44]);
  });

  test('fills and edges resolve to the tokens', async ({ page }) => {
    const primary = await style(page.getByTestId('btn-primary'));
    expect([primary.background, primary.color, primary.borderColor]).toEqual([
      FOREST,
      WHITE,
      'transparent',
    ]);
    // The unlayered `.aec-btn-secondary` rule must beat the `* { border-color }` rule.
    const secondary = await style(page.getByTestId('btn-secondary'));
    expect(secondary.borderColor).toBe(BORDER_STRONG);
    const link = await style(page.getByTestId('btn-link'));
    expect(link.borderColor).toBe(BORDER_STRONG);
    expect(link.textDecoration).toBe('none');
    const onBrand = await style(page.getByTestId('btn-on-brand'));
    expect([onBrand.background, onBrand.color]).toEqual([BONE, FOREST]);
    const danger = await style(page.getByTestId('btn-danger'));
    expect([danger.background, danger.color]).toEqual([ERROR, WHITE]);
    const ghost = await style(page.getByTestId('btn-ghost'));
    expect(ghost.background).toBe('transparent');
  });

  test('keyboard focus draws a 3px ring at 3px: Forest, and Bone on the on-brand button', async ({
    page,
  }) => {
    await page.getByTestId('btn-primary').focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const primary = await style(page.getByTestId('btn-primary'));
    expect([primary.outlineStyle, primary.outlineWidth, primary.outlineOffset]).toEqual([
      'solid',
      '3px',
      '3px',
    ]);
    // `transition` includes outline-color, so the ring settles over --duration-fast.
    await expect
      .poll(async () => (await style(page.getByTestId('btn-primary'))).outlineColor)
      .toBe(FOREST);

    await page.getByTestId('btn-on-brand').focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const onBrand = await style(page.getByTestId('btn-on-brand'));
    expect(onBrand.outlineWidth).toBe('3px');
    await expect
      .poll(async () => (await style(page.getByTestId('btn-on-brand'))).outlineColor)
      .toBe(BONE);
  });

  test('disabled is 60% opacity', async ({ page }) => {
    const s = await style(page.getByTestId('btn-primary-disabled'));
    expect(s.opacity).toBe('0.6');
  });

  test('a disabled link takes no pointer, no tab stop, no click and no Enter', async ({ page }) => {
    const link = page.getByTestId('btn-link-disabled');
    await expect(link).toHaveAttribute('aria-disabled', 'true');
    await expect(link).toHaveAttribute('tabindex', '-1');
    // The mutation "delete aria-disabled:pointer-events-none" fails here.
    expect(await link.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
    expect((await style(link)).opacity).toBe('0.6');
    // The click guard is attached in the browser, after hydration.
    await untilHydrated(link);
    const before = page.url();
    await link.dispatchEvent('click');
    await link.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    expect(page.url()).toBe(before);
  });

  test('the specimen passes axe', async ({ page }) => {
    const results = await new AxeBuilder({ page })
      .include('[data-testid="button-specimen"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
