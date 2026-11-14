/**
 * AECI-1767: `aec-meter` and `aec-figure`, rendered. jsdom runs no Tailwind and
 * no forced-colours media, so these checks read computed styles and the
 * accessibility tree off the specimen on the internal `/_demo/spartan` page,
 * then run axe over it. Paths are `baseURL`-relative: never hardcode a port.
 *
 * Accessibility-tree checks compare the whole snapshot string, never a partial
 * template, so a stray second text node would fail them.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

const FOREST = 'rgb(30, 58, 47)';
const CLAY_DEEP = 'rgb(161, 77, 34)';
const SUNKEN = 'rgb(244, 244, 245)';
const BONE = 'rgb(245, 242, 234)';
const ON_BRAND_SECONDARY = 'rgb(197, 211, 202)';

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

const byId = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`);

test.describe('aec-meter and aec-figure rendered (AECI-1767)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/_demo/spartan');
    await expect(page.getByTestId('meter-specimen')).toBeVisible();
  });

  test('the bar is 6px high with a pill end, Forest on a sunken track', async ({ page }) => {
    const m = byId(page, 'meter-mid');
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

  test('only the onboarding series is Clay deep, and it shows a name', async ({ page }) => {
    const m = byId(page, 'meter-onboarding');
    expect(await rgbOf(m.locator('.aec-meter-fill'), 'backgroundColor')).toBe(CLAY_DEEP);
    await expect(m).toContainText('Onboarding experience');
    expect(await rgbOf(byId(page, 'meter-mid').locator('.aec-meter-fill'), 'backgroundColor')).toBe(
      FOREST,
    );
  });

  test('zero, max and out of range clamp to 0%, 100% and 100%', async ({ page }) => {
    for (const [id, pct] of [
      ['meter-zero', 0],
      ['meter-max', 1],
      ['meter-over', 1],
    ] as const) {
      const m = byId(page, id);
      const t = (await m.locator('.aec-meter-track').boundingBox())!.width;
      const f = (await m.locator('.aec-meter-fill').boundingBox())!.width;
      expect(f / t).toBeCloseTo(pct, 2);
    }
    await expect(byId(page, 'meter-over')).toContainText('9');
  });

  test('a meter exposes its label and its number once each, as text, with no meter role', async ({
    page,
  }) => {
    const m = byId(page, 'meter-mid');
    await expect(m).not.toHaveAttribute('role', /.*/);
    expect(
      await m.evaluate((e) => e.getAttributeNames().filter((n) => n.startsWith('aria-'))),
    ).toEqual([]);
    expect(await m.ariaSnapshot()).toBe('- text: Mid value 4.3');
    // The load bar keeps its own wording.
    expect(await byId(page, 'meter-load').ariaSnapshot()).toBe(
      '- text: Products shown Showing 24 of 58',
    );
  });

  test('a decorative meter leaves the tree whole, a labelledBy meter is a group the heading names', async ({
    page,
  }) => {
    const deco = byId(page, 'meter-decorative');
    await expect(deco).toHaveAttribute('aria-hidden', 'true');
    expect((await deco.ariaSnapshot()).trim()).toBe('');
    await expect(deco).toContainText('4.3');
    const g = byId(page, 'meter-labelled-by');
    expect(await g.ariaSnapshot()).toBe(
      '- heading "Onboarding experience" [level=3]\n- group "Onboarding experience": "3.8"',
    );
  });

  test('a long label wraps above the bar and the bar keeps its width', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    const long = byId(page, 'meter-long');
    expect((await long.locator('.aec-meter-track').boundingBox())!.width).toBeGreaterThan(100);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });

  test('the stacked load bar is at most 260px wide with its text below', async ({ page }) => {
    const m = byId(page, 'meter-load').locator('aec-meter');
    const box = (await m.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(260);
    const track = (await m.locator('.aec-meter-track').boundingBox())!;
    const text = (await m.getByText('Showing 24 of 58').boundingBox())!;
    expect(text.y).toBeGreaterThan(track.y + track.height);
  });

  test('the figure is Source Serif 600 in Forest at --t-fig on every width', async ({ page }) => {
    const sizes: Record<number, string> = { 320: '28px', 1440: '40px' };
    for (const [w, size] of Object.entries(sizes)) {
      await page.setViewportSize({ width: Number(w), height: 900 });
      const n = byId(page, 'figure-large').locator('.aec-figure-value');
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
      await expect(n).toHaveText('12,345');
    }
  });

  test('the figure prints the caller text and suffix as given', async ({ page }) => {
    const f = byId(page, 'figure-decimal');
    await expect(f.locator('.aec-figure-value')).toHaveText('4.0');
    await expect(f.locator('.aec-figure-suffix')).toHaveText('/5');
  });

  test('a zero reads as the fixed legal sentence once, with the numeral hidden from the tree', async ({
    page,
  }) => {
    const z = byId(page, 'figure-zero');
    await expect(z.locator('.aec-figure-value')).toHaveAttribute('aria-hidden', 'true');
    await expect(z.locator('.aec-figure-value')).toHaveText('0');
    expect(await z.ariaSnapshot()).toBe(
      [
        '- paragraph: We have no integrations for Bluebeam Revu on record',
        '- paragraph: Not on record means we have not found one. It is not proof that none exists.',
        '- link "Know of one?":',
        '  - /url: "#know"',
      ].join('\n'),
    );
  });

  test('a zero with no zero mode renders the label with the caller text, never nothing', async ({
    page,
  }) => {
    const z = byId(page, 'figure-zero-no-mode');
    await expect(z.locator('.aec-figure-value')).toHaveText('0');
    await expect(z).toContainText('integrations');
  });

  test('on a Forest ground the numeral is Bone and the label is the secondary on-brand tone', async ({
    page,
  }) => {
    const f = byId(page, 'figure-on-brand');
    expect(await rgbOf(f.locator('.aec-figure-value'), 'color')).toBe(BONE);
    expect(await rgbOf(f.locator('p'), 'color')).toBe(ON_BRAND_SECONDARY);
  });

  test('the reviews band shows two figures and two decorative meters, kept apart', async ({
    page,
  }) => {
    const band = byId(page, 'reviews-band');
    await expect(band.locator('.aec-figure-value')).toHaveText(['4.3', '3.8']);
    await expect(band.locator('aec-meter[aria-hidden="true"]')).toHaveCount(2);
  });

  test('axe finds no violation on the specimen', async ({ page }) => {
    const res = await new AxeBuilder({ page })
      .include('[data-testid="meter-specimen"]')
      .include('[data-testid="figure-specimen"]')
      .analyze();
    expect(res.violations).toEqual([]);
  });

  test('nothing animates, with or without reduced motion', async ({ page }) => {
    for (const reducedMotion of ['no-preference', 'reduce'] as const) {
      await page.emulateMedia({ reducedMotion });
      const d = await byId(page, 'meter-mid')
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

test.describe('aec-meter in forced colours (AECI-1767)', () => {
  test('keeps the bar: a text-colour edge and a Highlight fill', async ({ page }) => {
    // Set the media before the page loads, so nothing is read mid-switch.
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    await page.goto('/_demo/spartan');
    const m = byId(page, 'meter-mid');
    await expect(m).toBeVisible();
    const track = m.locator('.aec-meter-track');
    const fill = m.locator('.aec-meter-fill');
    await expect.poll(() => track.evaluate((e) => getComputedStyle(e).outlineStyle)).toBe('solid');
    expect(await track.evaluate((e) => getComputedStyle(e).outlineWidth)).toBe('1px');
    expect((await fill.boundingBox())!.width).toBeGreaterThan(50);
    expect(await fill.evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe(
      'rgba(0, 0, 0, 0)',
    );
  });
});
