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
import { expectNoSidewaysScroll } from './no-sideways-scroll';

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
      opacity: s.opacity,
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

/** One row of screenshot pixels as [r, g, b] triples, decoded in the page. */
async function pixelRow(page: Page, y: number, width: number): Promise<number[][]> {
  const png = await page.screenshot({ clip: { x: 0, y, width, height: 1 } });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, 1).data;
    const out: number[][] = [];
    for (let x = 0; x < img.width; x++) out.push([data[x * 4], data[x * 4 + 1], data[x * 4 + 2]]);
    return out;
  }, png.toString('base64'));
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

  // AECI-1720 restore: below md the title steps to --t-statement, and below 360px to
  // --t-fig, so a long word fits beside the 68px mark.
  test('puts the title on the inner span: 28px at 320, 37px at 390, 72px at 1440', async ({
    page,
  }) => {
    for (const [width, size] of [
      [320, 28],
      [390, 37.02],
      [1440, 72],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      const h1 = withPanel(page).locator('h1');
      const span = await style(h1.locator('span').first());
      expect(span.fontSize).toBeCloseTo(size, 0);
      expect(span.fontWeight).toBe('400');
      // The unlayered h1 rule keeps the heading size: the title size is not on the h1.
      expect((await style(h1)).fontSize).toBeLessThanOrEqual(span.fontSize);
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
    // 400px at lg, so a long name keeps room beside the mark (AECI-1787); 540px from xl.
    expect(pWide.width).toBe(400);
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page);
    expect((await style(panel)).width).toBe(540);
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

  /** Focus an element with the keyboard, so `:focus-visible` matches. */
  async function keyboardFocus(page: Page, target: Locator) {
    await target.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(target).toBeFocused();
  }

  test('draws a Bone ring, 3px at 3px, on a plain link, an aecButton and a chip in the band', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page);
    const cases = {
      'plain link': withPanel(page).getByTestId('hero-plain-link'),
      'main aecButton': withPanel(page).getByTestId('hero-main-action'),
      'secondary aecButton': withPanel(page).getByTestId('hero-second-action'),
      chip: withPanel(page).getByTestId('hero-chip').locator('a.aec-chip'),
    };
    for (const [name, target] of Object.entries(cases)) {
      await keyboardFocus(page, target);
      await expect.poll(async () => (await style(target)).outlineColor, name).toBe(BONE);
      const ring = await style(target);
      expect(ring.outlineWidth, name).toBe('3px');
      expect(ring.outlineOffset, name).toBe('3px');
      expect(ring.outlineStyle, name).toBe('solid');
      // The ring on the flat Forest ground. The glow lightest point is 7.75:1.
      expect(contrast(ring.outlineColor, FOREST), name).toBeGreaterThan(11);
    }
  });

  test('a button on a white card inside the band keeps a Forest ring from its own utility', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page);
    const button = withPanel(page).getByTestId('hero-white-card-button');
    await keyboardFocus(page, button);
    await expect.poll(async () => (await style(button)).outlineColor).toBe(FOREST);
    const ring = await style(button);
    expect(ring.outlineWidth).toBe('3px');
    expect(ring.outlineOffset).toBe('3px');
    expect(contrast(ring.outlineColor, 'rgb(255, 255, 255)')).toBeGreaterThan(12);
  });

  test('a classless link in the band is Bone, and hover underlines it', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page);
    const link = withPanel(page).getByTestId('hero-plain-link');
    expect((await style(link)).color).toBe(BONE);
    expect(contrast((await style(link)).color, FOREST)).toBeGreaterThan(11);
    expect(await link.evaluate((el) => getComputedStyle(el).textDecorationLine)).not.toContain(
      'underline',
    );
    await link.hover();
    await expect
      .poll(() => link.evaluate((el) => getComputedStyle(el).textDecorationLine))
      .toContain('underline');
    expect((await style(link)).color).toBe(BONE);
  });

  test('sizes the mark 104px, 68px below md, and follows mock-up 6 spacing', async ({ page }) => {
    for (const [width, mark, gap, below] of [
      [1440, 104, 24, 16],
      [390, 68, 16, 12],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      const markBox = await style(withPanel(page).getByTestId('hero-mark'));
      expect(markBox.width).toBe(mark);
      expect(markBox.height).toBe(mark);
      const h1 = await style(withPanel(page).locator('h1'));
      const byline = await style(withPanel(page).getByTestId('hero-byline'));
      // The byline sits under the name, in the same row as the mark.
      expect(byline.top).toBeGreaterThanOrEqual(h1.bottom);
      expect(byline.left).toBeCloseTo(h1.left, 0);
      expect(markBox.left + markBox.width + gap).toBeCloseTo(h1.left, 0);
      const row = await withPanel(page)
        .getByTestId('hero-band-namerow')
        .evaluate((el) => {
          const s = getComputedStyle(el);
          return { mt: parseFloat(s.marginTop), mb: parseFloat(s.marginBottom) };
        });
      expect(row.mt).toBe(24);
      expect(row.mb).toBe(below);
    }
    const actions = withPanel(page).getByTestId('hero-main-action').locator('..');
    expect(
      await actions.evaluate((el) => {
        const s = getComputedStyle(el);
        return `${s.marginTop} ${s.rowGap} ${s.flexWrap} ${s.flexDirection}`;
      }),
    ).toBe('24px 12px wrap row');
  });

  test('draws the on-brand secondary button: wash fill, 3:1 edge, hover wash, Bone label', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page);
    const button = page.getByTestId('btn-on-brand-secondary');
    const rest = await style(button);
    expect(rest.height).toBe(44);
    expect(rest.color).toBe(BONE);
    expect(rest.borderColor).not.toBe('transparent');
    // Bone at 10% over Forest. `style()` drops alpha, so composite the wash here.
    const wash = await paintOver(button, 'backgroundColor', FOREST);
    expect(contrast(wash, FOREST)).toBeGreaterThan(1.1);
    expect(contrast(rest.color, wash)).toBeGreaterThan(8);
    // The edge is Bone at 50% over Forest: 4.01:1 against the ground (the 3:1 edge).
    const edge = await paintOver(button, 'borderTopColor', FOREST);
    expect(contrast(edge, FOREST)).toBeGreaterThan(3.9);
    await button.hover();
    await expect.poll(async () => paintOver(button, 'backgroundColor', FOREST)).not.toBe(wash);
    const hoverWash = await paintOver(button, 'backgroundColor', FOREST);
    // 6.94:1 exactly. The canvas read quantises a 16% alpha, so leave 0.1 of room.
    expect(contrast(rest.color, hoverWash)).toBeGreaterThan(6.8);
    const disabled = await style(page.getByTestId('btn-on-brand-secondary-disabled'));
    expect(disabled.opacity).toBe('0.6');
  });

  test('is flat against the real header: the band top row equals the header ground', async ({
    page,
  }) => {
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      // Test-only harness: move the band to sit directly under the real header, with
      // no spacing between them. No live page is changed.
      await page.evaluate(() => {
        const host = document.querySelector('[data-testid="hero-band-with-panel"]')!;
        document.querySelector('header')!.insertAdjacentElement('afterend', host);
        window.scrollTo(0, 0);
      });
      // Let the header settle first. The Browse trigger's Clay bar runs a short
      // scale transition on load and sits on the header's last row while it does.
      await expect
        .poll(() =>
          page.evaluate(
            () => document.getAnimations().filter((a) => a.playState === 'running').length,
          ),
        )
        .toBe(0);
      const { bottom: headerBottom, right: headerRight } = await page
        .locator('header')
        .first()
        .evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { bottom: Math.round(r.bottom), right: Math.floor(r.right) };
        });
      const ground = rgb(FOREST);
      // The header's last row and the band's first row, across the header's own
      // width. `html` reserves a stable scrollbar gutter, so where the browser draws
      // classic scrollbars the viewport's last ~15px are the page ground, not the
      // header (AECI-1854).
      for (const [label, y] of [
        ['header last row', headerBottom - 1],
        ['band top row', headerBottom],
      ] as const) {
        const row = await pixelRow(page, y, headerRight);
        expect(row).toHaveLength(headerRight);
        const worst = Math.max(
          ...row.map((px) => Math.max(...px.map((c, i) => Math.abs(c - ground[i])))),
        );
        console.log(`seam ${width}px ${label} y=${y}: worst channel delta ${worst}`);
        expect(worst, `${label} at ${width}px`).toBeLessThanOrEqual(1);
      }
    }
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

  test('has no horizontal overflow at 320px and the actions stack full width', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await open(page);
    await expectNoSidewaysScroll(page);
    // Below 480px the actions stack in one full-width column (AECI-1780), so a long label
    // such as "Sign in to review" stays on one line.
    const actions = withPanel(page).getByTestId('hero-main-action').locator('..');
    const look = await actions.evaluate((el) => {
      const s = getComputedStyle(el);
      const row = Math.round(el.getBoundingClientRect().width);
      const widths = [...el.children].map((c) => Math.round(c.getBoundingClientRect().width));
      return { display: s.display, flow: s.gridAutoFlow, row, widths };
    });
    expect(look.display).toBe('grid');
    expect(look.flow).toBe('row');
    for (const w of look.widths) expect(w, JSON.stringify(look)).toBe(look.row);
  });

  test('from 480px to md the actions are equal columns of one row', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await open(page);
    // AECI-1778: equal columns of one row, so one, two or three actions share the width.
    const actions = withPanel(page).getByTestId('hero-main-action').locator('..');
    const look = await actions.evaluate((el) => {
      const s = getComputedStyle(el);
      const tops = [...el.children].map((c) => Math.round(c.getBoundingClientRect().top));
      const widths = [...el.children].map((c) => Math.round(c.getBoundingClientRect().width));
      return { display: s.display, flow: s.gridAutoFlow, tops, widths };
    });
    expect(look.display).toBe('grid');
    expect(look.flow).toBe('column');
    expect(new Set(look.widths).size, JSON.stringify(look.widths)).toBe(1);
    expect(new Set(look.tops).size, JSON.stringify(look.tops)).toBe(1);
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
    await expectNoSidewaysScroll(page);
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
    await expectNoSidewaysScroll(page);
    const results = await new AxeBuilder({ page })
      .include('[data-testid="bone-band-specimen"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});

/**
 * AECI-1847, decision of 2026-11-22: no hero changes size. Display stays on the home
 * hero, the product name and the vendor name. The pair page takes Statement, and the
 * empty pair page the wide Statement. Every other page `h1`, About included, keeps the
 * global `h1` size (Headline, `--t-fig`). Each size is read off the rendered page and
 * compared with the token it should resolve to, at the four widths `DESIGN.md` §3
 * tabulates. The pixel table there is the second check.
 */
test.describe('hero title sizes, rendered (AECI-1847)', () => {
  const WIDTHS = [320, 768, 1280, 1920] as const;
  type Token = '--t-display' | '--t-statement' | '--t-statement-wide' | '--t-fig';
  /** DESIGN.md §3 "Settled values" at 320 / 768 / 1280 / 1920px. */
  const PX: Record<Token, readonly number[]> = {
    '--t-display': [45.7, 56.4, 68.7, 72],
    '--t-statement': [35.8, 43.8, 53, 56],
    '--t-statement-wide': [34, 35, 50.4, 51],
    '--t-fig': [28, 31.2, 40, 40],
  };
  /** The detail hero steps down below md, and to the Headline size below 360px. */
  const detailToken = (w: number): Token =>
    w < 360 ? '--t-fig' : w < 768 ? '--t-statement' : '--t-display';

  async function measure(page: Page, selector: string, token: Token) {
    return page.evaluate(
      ({ selector, token }) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const probe = document.createElement('span');
        probe.style.fontSize = `var(${token})`;
        document.body.appendChild(probe);
        const want = parseFloat(getComputedStyle(probe).fontSize);
        probe.remove();
        return { got: parseFloat(getComputedStyle(el).fontSize), want };
      },
      { selector, token },
    );
  }

  async function firstPair(page: Page, empty: boolean): Promise<string | null> {
    const res = await page.request.get('/api/products?perPage=24');
    if (!res.ok()) return null;
    const slugs = ((await res.json()) as { data?: { slug: string }[] }).data?.map((p) => p.slug);
    for (const a of slugs ?? []) {
      for (const b of slugs ?? []) {
        if (a >= b) continue;
        const pair = await page.request.get(`/api/products/${a}/integrations/${b}`);
        if (!pair.ok()) continue;
        const body = (await pair.json()) as { mechanisms: unknown[]; moved_to: unknown };
        if (body.moved_to !== null) continue;
        if ((body.mechanisms.length === 0) === empty) return `/products/${a}/integrations/${b}`;
      }
    }
    return null;
  }

  async function firstSlug(page: Page, kind: 'products' | 'vendors'): Promise<string> {
    const res = await page.request.get(`/api/${kind}?perPage=1`);
    expect(res.ok()).toBe(true);
    const slug = ((await res.json()) as { data: { slug: string }[] }).data[0]?.slug;
    expect(slug).toBeTruthy();
    return slug!;
  }

  async function check(page: Page, path: string, selector: string, token: (w: number) => Token) {
    for (const [i, w] of WIDTHS.entries()) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto(path);
      await expect(page.locator(selector).first()).toBeVisible();
      const t = token(w);
      const m = await measure(page, selector, t);
      expect(m, `${path} at ${w}px`).not.toBeNull();
      expect(m!.got, `${path} at ${w}px reads ${t}`).toBeCloseTo(m!.want, 1);
      expect(Math.abs(m!.got - PX[t][i]!), `${path} at ${w}px matches DESIGN.md`).toBeLessThan(0.6);
    }
  }

  test('the home hero renders Display at every width', async ({ page }) => {
    await check(page, '/', '[data-testid="home-hero-title"]', () => '--t-display');
  });

  test('the product name renders Display from md, Statement below, Headline below 360px', async ({
    page,
  }) => {
    const slug = await firstSlug(page, 'products');
    await check(page, `/products/${slug}`, 'aec-hero-band h1 > span', detailToken);
  });

  test('the vendor name renders the same steps as the product name', async ({ page }) => {
    const slug = await firstSlug(page, 'vendors');
    await check(page, `/vendors/${slug}`, 'aec-hero-band h1 > span', detailToken);
  });

  test('the pair page statement renders Statement', async ({ page }) => {
    const path = await firstPair(page, false);
    test.skip(path === null, 'no pair with an integration in this catalog');
    await check(page, path!, 'aec-hero-band h1 > span', () => '--t-statement');
  });

  test('the empty pair page statement renders the wide Statement', async ({ page }) => {
    const path = await firstPair(page, true);
    test.skip(path === null, 'no empty pair in this catalog');
    await check(page, path!, 'aec-hero-band h1 > span', () => '--t-statement-wide');
  });

  test('the About h1 keeps the global h1 size (Headline)', async ({ page }) => {
    await check(page, '/about', 'main h1', () => '--t-fig');
  });
});
