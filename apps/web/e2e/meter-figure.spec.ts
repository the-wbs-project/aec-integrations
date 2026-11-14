/**
 * AECI-1767: `aec-meter` and `aec-figure`, rendered. jsdom runs no Tailwind and
 * no forced-colours media, so these checks read computed styles and the
 * accessibility tree off the specimen on the internal `/_demo/spartan` page,
 * then run axe over it. Paths are `baseURL`-relative: never hardcode a port.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

const FOREST = 'rgb(30, 58, 47)';
const CLAY_DEEP = 'rgb(161, 77, 34)';
const SUNKEN = 'rgb(244, 244, 245)';
const HEADING = 'We have no integrations for Bluebeam Revu on record';
const CAVEAT = 'Not on record means we have not found one. It is not proof that none exists.';

/** Computed colours come back as `oklch(…)` in some engines, so read them via a canvas. */
function rgbOf(loc: Locator, prop: 'backgroundColor' | 'color') {
  return loc.evaluate((el, p) => {
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.fillStyle = getComputedStyle(el)[p];
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  }, prop);
}

const meter = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`);

test.describe('aec-meter and aec-figure rendered (AECI-1767)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/_demo/spartan');
    await expect(page.getByTestId('meter-specimen')).toBeVisible();
  });

  test('the bar is 6px high with a pill end, Forest on a sunken track', async ({ page }) => {
    const m = meter(page, 'meter-mid');
    const track = m.locator('.aec-meter-track');
    const fill = m.locator('.aec-meter-fill');
    expect((await track.boundingBox())!.height).toBe(6);
    expect(await track.evaluate((e) => getComputedStyle(e).borderTopLeftRadius)).toBe('9999px');
    expect(await rgbOf(track, 'backgroundColor')).toBe(SUNKEN);
    expect(await rgbOf(fill, 'backgroundColor')).toBe(FOREST);
    const t = (await track.boundingBox())!.width;
    const f = (await fill.boundingBox())!.width;
    expect(f / t).toBeCloseTo(4.3 / 5, 2);
  });

  test('only the onboarding series is Clay deep, and it shows its label', async ({ page }) => {
    const m = meter(page, 'meter-onboarding');
    expect(await rgbOf(m.locator('.aec-meter-fill'), 'backgroundColor')).toBe(CLAY_DEEP);
    await expect(m).toContainText('Onboarding experience');
    expect(
      await rgbOf(meter(page, 'meter-forest').locator('.aec-meter-fill'), 'backgroundColor'),
    ).toBe(FOREST);
  });

  test('zero, max and out of range clamp to 0%, 100% and 100%', async ({ page }) => {
    for (const [id, pct] of [
      ['meter-zero', 0],
      ['meter-max', 1],
      ['meter-over', 1],
    ] as const) {
      const m = meter(page, id);
      const t = (await m.locator('.aec-meter-track').boundingBox())!.width;
      const f = (await m.locator('.aec-meter-fill').boundingBox())!.width;
      expect(f / t).toBeCloseTo(pct, 2);
    }
    await expect(meter(page, 'meter-over')).toHaveAttribute('aria-valuenow', '5');
    await expect(meter(page, 'meter-over')).toContainText('9');
  });

  test('a meter exposes one node with its name and value text, and no second text node', async ({
    page,
  }) => {
    const m = meter(page, 'meter-mid');
    await expect(m).toHaveAttribute('role', 'meter');
    await expect(m).toHaveAttribute('aria-valuetext', '4.3');
    await expect(m).toHaveAttribute('aria-valuemin', '0');
    await expect(m).toHaveAttribute('aria-valuemax', '5');
    // The tree holds the meter and nothing under it, so the number is read once.
    await expect(m).toMatchAriaSnapshot('- meter "Mid value"');
    await expect(meter(page, 'meter-load').locator('aec-meter')).toHaveAttribute(
      'aria-valuetext',
      'Showing 24 of 58',
    );
  });

  test('a long label wraps above the bar and the bar keeps its width', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    const long = meter(page, 'meter-long');
    expect((await long.locator('.aec-meter-track').boundingBox())!.width).toBeGreaterThan(100);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });

  test('the figure is Source Serif 600 in Forest at --t-fig on every width', async ({ page }) => {
    const sizes: Record<number, string> = { 320: '28px', 1440: '40px' };
    for (const [w, size] of Object.entries(sizes)) {
      await page.setViewportSize({ width: Number(w), height: 900 });
      const n = page.getByTestId('figure-large').locator('.aec-figure-value');
      const s = await n.evaluate((e) => {
        const c = getComputedStyle(e);
        return {
          family: c.fontFamily,
          weight: c.fontWeight,
          size: c.fontSize,
          clipped: e.scrollWidth > e.clientWidth,
        };
      });
      expect(s.family).toContain('Source Serif 4');
      expect(s.weight).toBe('600');
      expect(s.size).toBe(size);
      expect(s.clipped).toBe(false);
      expect(await rgbOf(n, 'color')).toBe(FOREST);
      await expect(n).toHaveText('12345');
    }
  });

  test('a zero reads as the honest sentence once, with the numeral hidden from the tree', async ({
    page,
  }) => {
    const z = page.getByTestId('figure-zero');
    await expect(z.locator('.aec-figure-value')).toHaveAttribute('aria-hidden', 'true');
    await expect(z.locator('.aec-figure-value')).toHaveText('0');
    await expect(z).toMatchAriaSnapshot(`
      - paragraph: ${HEADING}
      - paragraph: ${CAVEAT}
      - link "Know of one?":
        - /url: "#know"
    `);
  });

  test('a zero with no support text renders nothing', async ({ page }) => {
    await expect(page.getByTestId('figure-zero-bare').locator('.aec-figure-value')).toHaveCount(0);
    await expect(page.getByTestId('figure-zero-bare')).toHaveText('');
  });

  test('the reviews band shows two figures, one per score, kept apart', async ({ page }) => {
    const band = page.getByTestId('reviews-band');
    await expect(band.locator('.aec-figure-value')).toHaveText(['4.3', '3.8']);
    await expect(band.getByRole('meter')).toHaveCount(2);
  });

  test('axe finds no violation on the specimen', async ({ page }) => {
    const res = await new AxeBuilder({ page })
      .include('[data-testid="meter-specimen"]')
      .include('[data-testid="figure-specimen"]')
      .analyze();
    expect(res.violations).toEqual([]);
  });

  test('forced colours keeps the bar: a text-colour edge and a Highlight fill', async ({
    page,
  }) => {
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    const m = meter(page, 'meter-mid');
    const edge = await m.locator('.aec-meter-track').evaluate((e) => {
      const s = getComputedStyle(e);
      return { w: s.outlineWidth, style: s.outlineStyle };
    });
    expect(edge).toEqual({ w: '1px', style: 'solid' });
    const fill = m.locator('.aec-meter-fill');
    expect((await fill.boundingBox())!.width).toBeGreaterThan(50);
    expect(await fill.evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe(
      'rgba(0, 0, 0, 0)',
    );
  });

  test('nothing animates, with or without reduced motion', async ({ page }) => {
    for (const reducedMotion of ['no-preference', 'reduce'] as const) {
      await page.emulateMedia({ reducedMotion });
      const d = await meter(page, 'meter-mid')
        .locator('.aec-meter-fill')
        .evaluate((e) => {
          const s = getComputedStyle(e);
          return { animation: s.animationName, transition: parseFloat(s.transitionDuration) };
        });
      expect(d.animation).toBe('none');
      expect(d.transition).toBeLessThan(0.001);
    }
  });
});
