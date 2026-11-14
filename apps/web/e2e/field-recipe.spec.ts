import { expect, test, type Page } from '@playwright/test';
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
  test('a valid field takes the field edge, an invalid one the error edge without moving', async ({
    page,
  }) => {
    await page.goto(PATH);
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
        mask: cs.maskImage !== 'none' ? cs.maskImage : cs.getPropertyValue('-webkit-mask-image'),
        colour: cs.backgroundColor,
      };
    });
    expect(icon.width).toBe('16px');
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
