/**
 * AECI-1760: the content pages and flows render the shared `aecButton`, measured.
 * jsdom runs no Tailwind and no cascade layers, so a component spec cannot see a
 * 44px height, a 12px radius or a fill. Three representative migrated buttons:
 *
 * - the contact page's "Email us" (a primary link at the foot of a card),
 * - the sign-in page's "Continue with Google" (a secondary, full-width button),
 * - the mailing-list page's "Join the mailing list" (a primary submit).
 *
 * Paths are `baseURL`-relative: never hardcode a port.
 */
import { expect, test, type Locator } from '@playwright/test';

import { untilHydrated } from './hydration';

const FOREST = 'rgb(30, 58, 47)';
const WHITE = 'rgb(255, 255, 255)';
const BORDER_STRONG = 'rgb(212, 212, 216)';

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
      background: toRgb(s.backgroundColor),
      color: toRgb(s.color),
      borderColor: toRgb(s.borderTopColor),
      boxShadow: s.boxShadow,
    };
  });
}

test.describe('content-page buttons on aecButton (AECI-1760)', () => {
  test('contact "Email us": a 44px primary link', async ({ page }) => {
    await page.goto('/contact');
    const link = page.getByRole('link', { name: 'Email us', exact: true }).last();
    await expect(link).toBeVisible();
    const s = await style(link);
    expect(s.height).toBe(44);
    expect(s.radius).toBe('12px');
    expect(s.background).toBe(FOREST);
    expect(s.color).toBe(WHITE);
    expect(s.boxShadow).toBe('none');
  });

  test('sign-in "Continue with Google": a 44px secondary button, full width', async ({ page }) => {
    await page.goto('/auth/login');
    const button = page.getByRole('button', { name: /Continue with Google|Redirecting/ });
    await expect(button).toBeVisible();
    const form = await page
      .locator('#login-email')
      .locator('xpath=ancestor::form[1]')
      .boundingBox();
    const s = await style(button);
    expect(s.height).toBe(44);
    expect(s.radius).toBe('12px');
    expect(s.background).not.toBe(FOREST);
    expect(s.borderColor).toBe(BORDER_STRONG);
    expect(s.boxShadow).toBe('none');
    expect(Math.round(s.width)).toBe(Math.round(form!.width));
    await expect(button).toHaveAttribute('type', 'button');
  });

  test('updates "Join the mailing list": a 44px primary submit', async ({ page }) => {
    await page.goto('/updates');
    const form = page.locator('form[novalidate]').first();
    await untilHydrated(form);
    const button = form.getByRole('button', { name: 'Join the mailing list' });
    await expect(button).toBeVisible();
    const s = await style(button);
    expect(s.height).toBe(44);
    expect(s.radius).toBe('12px');
    expect(s.background).toBe(FOREST);
    expect(s.color).toBe(WHITE);
    await expect(button).toHaveAttribute('type', 'submit');
  });
});
