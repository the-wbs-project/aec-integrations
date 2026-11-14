/**
 * AECI-1766: the Forest hero band and the Bone band, rendered. jsdom runs no
 * Tailwind and no cascade, so the component specs cannot see a gutter, a ring or
 * a seam. This spec reads computed styles off the specimens on the internal
 * `/_demo/spartan` probe page, then runs axe over them.
 *
 * Paths are `baseURL`-relative: never hardcode a port.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { untilHydrated } from './hydration';

const FOREST = 'rgb(30, 58, 47)';
const BONE = 'rgb(245, 242, 234)';
const FIELD_EDGE = 'rgb(132, 132, 141)';

/** Computed colours come back as `oklch(…)`, so read them through a canvas. */
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
      top: box.top + scrollY,
      bottom: box.bottom + scrollY,
      left: box.left,
      width: box.width,
      height: box.height,
      background: toRgb(s.backgroundColor),
      backgroundImage: s.backgroundImage,
      color: toRgb(s.color),
      fontSize: parseFloat(s.fontSize),
      fontWeight: s.fontWeight,
      paddingTop: parseFloat(s.paddingTop),
      paddingBottom: parseFloat(s.paddingBottom),
      paddingLeft: parseFloat(s.paddingLeft),
      borderTop: parseFloat(s.borderTopWidth),
      borderBottom: parseFloat(s.borderBottomWidth),
      borderColor: toRgb(s.borderTopColor),
      outlineWidth: s.outlineWidth,
      outlineOffset: s.outlineOffset,
      outlineStyle: s.outlineStyle,
      outlineColor: toRgb(s.outlineColor),
      flexDirection: s.flexDirection,
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

async function open(page: Page) {
  await page.goto('/_demo/spartan');
  await expect(page.getByTestId('hero-band-specimen')).toBeVisible();
  await untilHydrated(page.locator('aec-spartan-demo'));
}

const withPanel = (page: Page) => page.getByTestId('hero-band-with-panel');
const bandOf = (loc: Locator) => loc.locator('.aec-hero-band');

test.describe('hero band rendered (AECI-1766)', () => {
  test('meets the header on one flat Forest ground, no hairline', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page);
    const header = await style(page.locator('header').first());
    const band = await style(bandOf(withPanel(page)));
    expect(band.background).toBe(FOREST);
    expect(header.background).toBe(band.background);
    expect(header.borderBottom).toBe(0);
    expect(band.borderTop).toBe(0);
    // The glow is two radial gradients and nothing else.
    expect(band.backgroundImage.match(/radial-gradient/g)).toHaveLength(2);
    expect(band.backgroundImage).not.toMatch(/linear-gradient|blur/);
  });

  test('puts Display on the inner span, 45.7px at 320 and 72px at 1440', async ({ page }) => {
    for (const [width, size] of [
      [320, 45.68],
      [1440, 72],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      const h1 = withPanel(page).locator('h1');
      const span = await style(h1.locator('span').first());
      expect(span.fontSize).toBeCloseTo(size, 0);
      expect(span.fontWeight).toBe('400');
      // The unlayered h1 rule keeps the heading size: Display is not on the h1.
      expect((await style(h1)).fontSize).toBeLessThan(span.fontSize);
    }
  });

  test('keeps the 1328px wrap, 48px gutters and 128px bottom padding at 1440', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    const wrap = await style(bandOf(withPanel(page)).locator('> div').first());
    expect(wrap.width).toBe(1328);
    expect(wrap.paddingLeft).toBe(48);
    expect(wrap.paddingBottom).toBe(128);
    expect(wrap.paddingTop).toBe(24);
  });

  test('stacks the panel under the text below lg and puts it right of it from lg', async ({
    page,
  }) => {
    const panel = withPanel(page).locator('.aec-hero-panel');
    const title = withPanel(page).locator('h1');
    await page.setViewportSize({ width: 1023, height: 900 });
    await open(page);
    const [pBelow, tBelow] = [await style(panel), await style(title)];
    expect(pBelow.top).toBeGreaterThanOrEqual(tBelow.bottom);
    expect(pBelow.left).toBeLessThanOrEqual(tBelow.left + 1);
    await page.setViewportSize({ width: 1024, height: 900 });
    await open(page);
    const [pWide, tWide] = [await style(panel), await style(title)];
    expect(pWide.left).toBeGreaterThanOrEqual(tWide.left + tWide.width);
    expect(pWide.width).toBe(540);
  });

  test('renders no panel and no gap when nothing is projected', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page);
    const panel = page.getByTestId('hero-band-plain').locator('.aec-hero-panel');
    await expect(panel).toBeHidden();
    const grid = await page
      .getByTestId('hero-band-plain')
      .getByTestId('hero-band-grid')
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    expect(grid).toBe(1);
  });

  test('draws a Bone focus ring, 3px at 3px, on a keyboard-focused link', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page);
    const link = withPanel(page).getByRole('link', { name: 'Visit website' });
    await link.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(link).toBeFocused();
    await expect.poll(async () => (await style(link)).outlineColor).toBe(BONE);
    const ring = await style(link);
    expect(ring.outlineWidth).toBe('3px');
    expect(ring.outlineOffset).toBe('3px');
    expect(ring.outlineStyle).toBe('solid');
    // The ring on the flat Forest ground. The glow lightest point is 7.75:1.
    expect(contrast(ring.outlineColor, FOREST)).toBeGreaterThan(11);
  });

  test('keeps Bone and secondary ink above 4.5:1 on the band ground', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page);
    const band = await style(bandOf(withPanel(page)));
    const title = await style(withPanel(page).locator('h1 span').first());
    const lede = await style(withPanel(page).getByText('One line about what'));
    const panelText = await style(withPanel(page).getByText('The hero panel sits'));
    const panel = await style(withPanel(page).locator('.aec-hero-panel'));
    expect(contrast(title.color, band.background)).toBeGreaterThan(11);
    expect(contrast(lede.color, band.background)).toBeGreaterThan(7);
    expect(contrast(panelText.color, panel.background)).toBeGreaterThan(6);
  });

  test('has no horizontal overflow at 320px and the actions stack', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await open(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const actions = withPanel(page).getByRole('link', { name: 'Visit website' }).locator('..');
    expect((await style(actions)).flexDirection).toBe('column');
  });

  test('is axe clean', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page);
    const results = await new AxeBuilder({ page })
      .include('[data-testid="hero-band-specimen"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe('200% zoom (AECI-1766)', () => {
  // A 1280px window at 200% zoom is a 640 CSS px viewport at device scale 2.
  test.use({ viewport: { width: 640, height: 450 }, deviceScaleFactor: 2 });

  test('the title wraps, the actions fit and nothing scrolls sideways', async ({ page }) => {
    await open(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const h1 = await style(withPanel(page).locator('h1'));
    const span = await style(withPanel(page).locator('h1 span').first());
    expect(h1.height).toBeGreaterThan(span.fontSize * 1.5);
    const button = await style(withPanel(page).getByRole('button', { name: 'Write a review' }));
    expect(button.height).toBeGreaterThanOrEqual(44);
    expect(button.left + button.width).toBeLessThanOrEqual(640);
  });
});

test.describe('forced colours (AECI-1766)', () => {
  test.use({ forcedColors: 'active', viewport: { width: 1280, height: 900 } });

  test('both bands keep a 1px system-colour edge and no gradient', async ({ page }) => {
    await open(page);
    const hero = await style(bandOf(withPanel(page)));
    expect(hero.backgroundImage).toBe('none');
    expect(hero.borderTop).toBe(1);
    expect(hero.borderBottom).toBe(1);
    expect(hero.color).not.toBe(hero.background);
    const panel = await style(withPanel(page).locator('.aec-hero-panel'));
    expect(panel.borderTop).toBe(1);
    const bone = await style(page.getByTestId('bone-band').locator('.aec-bone-band'));
    expect(bone.borderTop).toBe(1);
    expect(bone.borderBottom).toBe(1);
    expect(contrast(bone.color, bone.background)).toBeGreaterThan(7);
  });
});

test.describe('bone band rendered (AECI-1766)', () => {
  const bone = (page: Page) => page.getByTestId('bone-band').locator('.aec-bone-band');

  test('paints Bone with the ruled wrap and rhythm: 96px at 1440, 64px at 320', async ({
    page,
  }) => {
    for (const [width, pad, gutter] of [
      [1440, 96, 48],
      [320, 64, 24],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      const ground = await style(bone(page));
      expect(ground.background).toBe(BONE);
      expect(ground.borderTop).toBe(0);
      const wrap = await style(bone(page).locator('> div').first());
      expect(wrap.paddingTop).toBe(pad);
      expect(wrap.paddingBottom).toBe(pad);
      expect(wrap.paddingLeft).toBe(gutter);
      if (width === 1440) expect(wrap.width).toBe(1328);
    }
  });

  test('keeps text and controls legible on Bone', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page);
    const ground = (await style(bone(page))).background;
    const heading = await style(page.getByRole('heading', { name: 'The one Bone band' }));
    const body = await style(page.getByText('Secondary text on Bone'));
    expect(contrast(heading.color, ground)).toBeGreaterThan(17);
    expect(contrast(body.color, ground)).toBeGreaterThan(6.9);
    const input = await style(page.getByTestId('bone-input'));
    expect(input.borderColor).toBe(FIELD_EDGE);
    expect(contrast(input.borderColor, ground)).toBeGreaterThan(3.3);
    const primary = await style(page.getByTestId('bone-primary'));
    expect(contrast(primary.color, primary.background)).toBeGreaterThan(11);
    // A secondary button brings its own fill. Its text is readable on that fill
    // and on the hover fill. Its edge on Bone is 1.32:1, which DESIGN.md flags.
    const secondary = page.getByTestId('bone-secondary');
    const rest = await style(secondary);
    expect(contrast(rest.color, rest.background)).toBeGreaterThan(18);
    await secondary.hover();
    await expect
      .poll(async () => {
        const hover = await style(secondary);
        return contrast(hover.color, hover.background);
      })
      .toBeGreaterThan(11);
    const ghost = page.getByTestId('bone-ghost');
    await ghost.hover();
    await expect.poll(async () => contrast((await style(ghost)).color, ground)).toBeGreaterThan(11);
  });

  test('meets the Forest footer with a flat edge and no gap', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page);
    const band = await style(bone(page));
    const footer = await style(page.locator('footer').last());
    expect(Math.abs(footer.top - band.bottom)).toBeLessThanOrEqual(1);
    expect(footer.background).not.toBe(BONE);
    expect(contrast(footer.background, BONE)).toBeGreaterThan(13);
  });

  test('is axe clean and has no horizontal overflow at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await open(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const results = await new AxeBuilder({ page })
      .include('[data-testid="bone-band-specimen"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
