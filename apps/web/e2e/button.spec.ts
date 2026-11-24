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

function rgb(c: string): number[] {
  return c.match(/\d+/g)!.slice(0, 3).map(Number);
}

function luminance([r, g, b]: number[]): number {
  const lin = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(rgb(a)), luminance(rgb(b))];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * A translucent paint (a wash or an alpha edge) composited over a ground, as the
 * browser does it in sRGB. `style()` drops alpha, so contrast needs this.
 */
async function paintOver(
  loc: Locator,
  prop: 'backgroundColor' | 'borderTopColor',
  ground: string,
): Promise<string> {
  const [r, g, b, a] = await loc.evaluate((el, p) => {
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.fillStyle = getComputedStyle(el)[p as 'backgroundColor'];
    ctx.fillRect(0, 0, 1, 1);
    return Array.from(ctx.getImageData(0, 0, 1, 1).data);
  }, prop);
  const base = rgb(ground);
  const alpha = a / 255;
  const out = [r, g, b].map((c, i) => Math.round(c * alpha + base[i] * (1 - alpha)));
  return `rgb(${out.join(', ')})`;
}

test.describe('aecButton rendered (AECI-1758)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/_demo/spartan');
    await expect(page.getByTestId('button-specimen')).toBeVisible();
  });

  // AECI-2027: the specimen reads share one load, one step per check. Each step
  // after the first starts with the pointer at (0, 0) and nothing focused. The
  // disabled-link step runs last because it presses Enter on the page.
  test('the button variants, rings and disabled states', async ({ page }) => {
    const reset = async () => {
      await page.mouse.move(0, 0);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    };

    await test.step('every variant is 44px high, 12px round, 14px at 600, with a 1px edge and no shadow', async () => {
      for (const id of [
        'btn-primary',
        'btn-secondary',
        'btn-ghost',
        'btn-danger',
        'btn-link',
        'btn-compact',
        'btn-on-brand',
        'btn-on-brand-secondary',
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

    await test.step('fills and edges resolve to the tokens', async () => {
      await reset();
      const primary = await style(page.getByTestId('btn-primary'));
      expect([primary.background, primary.color, primary.borderColor]).toEqual([
        FOREST,
        WHITE,
        'transparent',
      ]);
      // The unlayered `.aec-btn-secondary` rule must beat the `* { border-color }` default.
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

    await test.step('keyboard focus draws a 3px ring at 3px: Forest, and Bone on the on-brand button', async () => {
      await reset();
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

    // The wash, edge and hover-label contrast checks moved here from hero-band.spec.ts
    // (AECI-2027). The button sits in this specimen, not in the hero band.
    await test.step('the on-brand secondary button is a Bone wash with a Bone edge and a Bone ring (AECI-1766)', async () => {
      await reset();
      const button = page.getByTestId('btn-on-brand-secondary');
      const rest = await style(button);
      expect(rest.color).toBe(BONE);
      expect(rest.radius).toBe('12px');
      // The unlayered `.aec-btn-on-brand-secondary` rule must beat the `* { border-color }` default:
      // Bone at 50% over Forest, not the transparent base edge and not --border-default.
      expect(rest.borderColor).not.toBe('transparent');
      expect(rest.borderColor).not.toBe('rgb(228, 228, 231)');
      expect(rest.background).not.toBe('transparent');
      // Bone at 10% over Forest. `style()` drops alpha, so composite the wash here.
      const wash = await paintOver(button, 'backgroundColor', FOREST);
      expect(contrast(wash, FOREST)).toBeGreaterThan(1.1);
      expect(contrast(rest.color, wash)).toBeGreaterThan(8);
      // The edge is Bone at 50% over Forest: 4.01:1 against the ground (the 3:1 edge).
      const edge = await paintOver(button, 'borderTopColor', FOREST);
      expect(contrast(edge, FOREST)).toBeGreaterThan(3.9);
      await button.hover();
      await expect.poll(async () => (await style(button)).background).not.toBe(rest.background);
      await expect.poll(async () => paintOver(button, 'backgroundColor', FOREST)).not.toBe(wash);
      const hoverWash = await paintOver(button, 'backgroundColor', FOREST);
      // 6.94:1 exactly. The canvas read quantises a 16% alpha, so leave 0.1 of room.
      expect(contrast(rest.color, hoverWash)).toBeGreaterThan(6.8);
      await button.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect.poll(async () => (await style(button)).outlineColor).toBe(BONE);
      const ring = await style(button);
      expect([ring.outlineStyle, ring.outlineWidth, ring.outlineOffset]).toEqual([
        'solid',
        '3px',
        '3px',
      ]);
      // Every variant shares the base recipe's `disabled:opacity-60`, so this one read
      // stands for the disabled primary too.
      expect((await style(page.getByTestId('btn-on-brand-secondary-disabled'))).opacity).toBe(
        '0.6',
      );
    });

    await test.step('a disabled link takes no pointer, no tab stop, no click and no Enter', async () => {
      await reset();
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
      // A fixed wait on purpose. The test proves that the click and Enter do not
      // navigate, and no condition marks the end of "nothing happened".
      await page.waitForTimeout(300);
      expect(page.url()).toBe(before);
    });
  });

  test('the specimen passes axe', async ({ page }) => {
    const results = await new AxeBuilder({ page })
      .include('[data-testid="button-specimen"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
