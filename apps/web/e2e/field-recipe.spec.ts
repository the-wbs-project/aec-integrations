import { expect, test, type Page } from './fixtures';
import { untilHydrated } from './hydration';

// AECI-1764: the shared form-control recipe, asserted through computed style on a
// real page. `/products/:slug/correction` carries FIELD_INPUT_CLASS-style
// controls, an optional URL field and its inline error.

const PATH = '/products/summit-model-coordination/correction';

/** The computed colour a custom property resolves to, serialised the way the
 *  browser serialises a border colour. */
async function resolveToken(page: Page, token: string): Promise<string> {
  return page.evaluate((t) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${t})`;
    document.body.appendChild(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, token);
}

test.describe('the shared field recipe (AECI-1764)', () => {
  // AECI-2027: the label read and the field-edge checks share one load of the
  // correction page, one step each. The label step runs first, before any typing
  // and before the forced-colours switch at the end of the field step.
  test('the correction page field label and field edges', async ({ page }) => {
    await page.goto(PATH);

    await test.step('a field label renders the Label role, in sentence case', async () => {
      // AECI-1850: a field label is the Label role, 13px at 600 on a 1.4 line with
      // +0.01em tracking, in sentence case. Uppercase belongs to the overline alone.
      const label = page.locator('label[for="correction-source"]');
      await expect(label).toBeVisible();
      const got = await label.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          size: cs.fontSize,
          weight: cs.fontWeight,
          lineHeight: cs.lineHeight,
          tracking: cs.letterSpacing,
          transform: cs.textTransform,
        };
      });
      expect(got).toEqual({
        size: '13px',
        weight: '600',
        lineHeight: '18.2px',
        tracking: '0.13px',
        transform: 'none',
      });
    });

    await test.step('a valid field takes the field edge, an invalid one the error edge without moving', async () => {
      const source = page.locator('#correction-source');
      await expect(source).toBeVisible();
      await untilHydrated(source);

      const measure = () =>
        source.evaluate((el) => {
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          const text =
            el.getBoundingClientRect().left +
            parseFloat(cs.borderLeftWidth) +
            parseFloat(cs.paddingLeft);
          return {
            colour: cs.borderTopColor,
            width: cs.borderTopWidth,
            height: r.height,
            boxWidth: r.width,
            textStart: text,
            radius: cs.borderTopLeftRadius,
            shadow: cs.boxShadow,
          };
        });

      // Valid, untouched.
      await source.fill('https://example.com/source');
      await source.blur();
      const valid = await measure();
      expect(valid.colour).toBe(await resolveToken(page, '--border-field'));
      expect(valid.width).toBe('1px');
      expect(valid.radius).toBe('12px');
      expect(valid.shadow).toBe('none');
      expect(valid.height).toBeGreaterThanOrEqual(44);

      // Invalid, blurred.
      await source.fill('not a url');
      await source.blur();
      const message = page.locator('#correction-source-error');
      await expect(message).toBeVisible();
      await expect(source).toHaveAttribute('aria-invalid', 'true');
      const invalid = await measure();
      expect(invalid.colour).toBe(await resolveToken(page, '--status-error'));
      expect(invalid.width).toBe('2px');
      // The box and the text did not move.
      expect(invalid.height).toBeCloseTo(valid.height, 1);
      expect(invalid.boxWidth).toBeCloseTo(valid.boxWidth, 1);
      expect(invalid.textStart).toBeCloseTo(valid.textStart, 1);

      // The error icon is a 16px mask.
      const icon = await message.evaluate((el) => {
        const cs = getComputedStyle(el, '::before');
        return {
          width: cs.width,
          lineDisplay: getComputedStyle(el).display,
          boxWidth: (() => {
            // A pseudo-element with no box still reports a computed width, so
            // measure the room the glyph takes: the text must start 24px in.
            const range = document.createRange();
            range.selectNodeContents(el);
            return range.getBoundingClientRect().left - el.getBoundingClientRect().left;
          })(),
          mask: cs.maskImage !== 'none' ? cs.maskImage : cs.getPropertyValue('-webkit-mask-image'),
          colour: cs.backgroundColor,
        };
      });
      expect(icon.width).toBe('16px');
      expect(icon.lineDisplay).toBe('flex');
      expect(icon.boxWidth).toBeGreaterThanOrEqual(23);
      expect(icon.mask).toContain('url(');

      // Forced colours: the glyph must not paint the canvas colour.
      await page.emulateMedia({ forcedColors: 'active' });
      const forced = await message.evaluate((el) => {
        const cs = getComputedStyle(el, '::before');
        const probe = document.createElement('span');
        probe.style.color = 'Canvas';
        document.body.appendChild(probe);
        const canvas = getComputedStyle(probe).color;
        probe.remove();
        return { background: cs.backgroundColor, canvas };
      });
      expect(forced.background).not.toBe(forced.canvas);
      expect(forced.background).not.toBe('rgba(0, 0, 0, 0)');
    });
  });

  // AECI-1850 / AECI-1796: the /search query box was a 1.22:1 edge. It is
  // server-rendered with or without the search config, so this holds in CI too.
  test('the /search query box takes the field edge, 44px, with room for its glyph', async ({
    page,
  }) => {
    await page.goto('/search');
    const box = page.locator('#search-input');
    await expect(box).toBeVisible();
    const got = await box.evaluate((el) => {
      const cs = getComputedStyle(el);
      const glyph = el.parentElement!.querySelector('svg')!.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return {
        colour: cs.borderTopColor,
        width: cs.borderTopWidth,
        radius: cs.borderTopLeftRadius,
        shadow: cs.boxShadow,
        height: r.height,
        textStart: r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft),
        glyphEnd: glyph.right,
      };
    });
    expect(got.colour).toBe(await resolveToken(page, '--border-field'));
    expect(got.width).toBe('1px');
    expect(got.radius).toBe('12px');
    expect(got.shadow).toBe('none');
    expect(got.height).toBeGreaterThanOrEqual(44);
    // Typed text starts clear of the glyph.
    expect(got.textStart).toBeGreaterThan(got.glyphEnd);
  });
});
