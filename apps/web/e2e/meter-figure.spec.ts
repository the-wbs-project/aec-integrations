/**
 * AECI-1767: `aec-meter` and `aec-figure`, rendered. jsdom runs no Tailwind and
 * no forced-colours media, so these checks read computed styles and the
 * accessibility tree off the specimen on the internal `/_demo/spartan` page,
 * then run axe over it. Paths are `baseURL`-relative: never hardcode a port.
 *
 * Accessibility-tree checks compare the whole snapshot string, never a partial
 * template, so a stray second text node would fail them.
 *
 * Checks that read only what one component renders from its inputs live in
 * `meter.component.spec.ts` and `figure.component.spec.ts` (AECI-2027): the fill
 * width at zero, max and out of range, the meter's ARIA and exposed text, the
 * decorative and `labelledBy` meters, and the figure's printed text.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from './fixtures';
import { expectNoSidewaysScroll } from './no-sideways-scroll';

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

  // AECI-2027: the colour, box and motion reads share one load, one step per
  // check. The reduced-motion step runs last because it changes the media.
  test('the meter and figure colours, boxes and motion', async ({ page }) => {
    await test.step('the bar is 6px high with a pill end, Forest on a sunken track', async () => {
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

    await test.step('only the onboarding series is Clay deep, and it shows a name', async () => {
      const m = byId(page, 'meter-onboarding');
      expect(await rgbOf(m.locator('.aec-meter-fill'), 'backgroundColor')).toBe(CLAY_DEEP);
      await expect(m).toContainText('Onboarding experience');
      expect(
        await rgbOf(byId(page, 'meter-mid').locator('.aec-meter-fill'), 'backgroundColor'),
      ).toBe(FOREST);
    });

    await test.step('the stacked load bar is at most 260px wide with its text below', async () => {
      const m = byId(page, 'meter-load').locator('aec-meter');
      const box = (await m.boundingBox())!;
      expect(box.width).toBeLessThanOrEqual(260);
      const track = (await m.locator('.aec-meter-track').boundingBox())!;
      const text = (await m.getByText('Showing 24 of 58').boundingBox())!;
      expect(text.y).toBeGreaterThan(track.y + track.height);
    });

    await test.step('on a Forest ground the numeral is Bone and the label is the secondary on-brand tone', async () => {
      const f = byId(page, 'figure-on-brand');
      expect(await rgbOf(f.locator('.aec-figure-value'), 'color')).toBe(BONE);
      expect(await rgbOf(f.locator('p'), 'color')).toBe(ON_BRAND_SECONDARY);
    });

    await test.step('nothing animates, with or without reduced motion', async () => {
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

  // AECI-2027: one load, one pass per width. 320px and 1440px are the two ends of
  // the fluid --t-fig size. The long-label wrap check runs in the 320px pass only.
  test('the meter and figures hold their size and wrap at 320px and 1440px', async ({ page }) => {
    const figSizes: Record<number, string> = { 320: '28px', 1440: '40px' };
    for (const w of [320, 1440]) {
      await page.setViewportSize({ width: w, height: 900 });

      if (w === 320) {
        await test.step('a long label wraps above the bar and the bar keeps its width', async () => {
          const long = byId(page, 'meter-long');
          expect((await long.locator('.aec-meter-track').boundingBox())!.width).toBeGreaterThan(
            100,
          );
          await expectNoSidewaysScroll(page);
        });
      }

      await test.step(`the figure is Source Serif 600 in Forest at --t-fig on every width (${w}px)`, async () => {
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
        expect(s.size).toBe(figSizes[w]);
        expect(s.clipped).toBe(false);
        expect(await rgbOf(n, 'color')).toBe(FOREST);
        await expect(n).toHaveText('12,345');
      });

      // The count figure's --t-fig size beside the scores is the step above.
      await test.step(`a score figure is a fixed 48px on every width (ruling A3) (${w}px)`, async () => {
        // Wait out any entrance transition before reading a computed size.
        await page.waitForFunction(() => document.getAnimations().length === 0);
        for (const id of ['score-quality', 'score-onboarding']) {
          const n = byId(page, id).locator('.aec-figure-value');
          const s = await n.evaluate((e) => {
            const c = getComputedStyle(e);
            return {
              size: c.fontSize,
              weight: c.fontWeight,
              clipped: e.scrollWidth > e.clientWidth,
            };
          });
          expect(s).toEqual({ size: '48px', weight: '600', clipped: false });
        }
      });
    }
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

  test('axe finds no violation on the specimen', async ({ page }) => {
    const res = await new AxeBuilder({ page })
      .include('[data-testid="meter-specimen"]')
      .include('[data-testid="figure-specimen"]')
      .analyze();
    expect(res.violations).toEqual([]);
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
    await expect.poll(() => track.evaluate((e) => getComputedStyle(e).outlineWidth)).toBe('1px');
    expect((await fill.boundingBox())!.width).toBeGreaterThan(50);
    expect(await fill.evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe(
      'rgba(0, 0, 0, 0)',
    );
  });
});
