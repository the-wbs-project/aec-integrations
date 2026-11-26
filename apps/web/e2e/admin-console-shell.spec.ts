/**
 * AECI-1813: the admin console shell and its shared pieces, rendered.
 *
 * - The console chip tones are a stylesheet only admin loads. A `critical` chip
 *   computes the error colour on a `/preview/admin-*` route (no shell) and under
 *   the real shell.
 * - The two-column Operations panel stays inside the window at 768px and up to
 *   820px, where it hangs from a trigger about 250px in.
 * - The overview's 30-day chart is no wider than its panel: its hidden data table
 *   is clipped inside the chart.
 *
 * The shell checks need a real admin session (`auth-session.ts`), and skip without
 * one, like `authed-console.spec.ts`.
 */
import { type Page, expect, test } from '@playwright/test';

import { mintSessionCookies } from './auth-session';
import { E2E_BASE_URL as BASE_URL } from './base-url';

/** The computed `--status-error`, in whatever colour space the browser reports. */
function errorColour(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--status-error)';
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
}

let cookies: Awaited<ReturnType<typeof mintSessionCookies>> = null;
test.beforeAll(async () => {
  cookies = await mintSessionCookies(BASE_URL);
});

async function criticalColour(page: Page): Promise<string | null> {
  const chip = page.locator('.aec-chip[data-tone="critical"]').first();
  await expect(chip).toBeVisible();
  return chip.evaluate((el) => getComputedStyle(el).color);
}

test('a critical chip takes the error colour on a preview route, without the shell', async ({
  page,
}) => {
  await page.goto('/preview/admin-console-legend');
  expect(await criticalColour(page)).toBe(await errorColour(page));
});

test('a public page carries no console tone stylesheet', async ({ page }) => {
  await page.goto('/products');
  await expect(page.locator('main')).toBeAttached();
  await expect(page.locator('style#aec-admin-chip-tones')).toHaveCount(0);
});

test.describe('under the real shell', () => {
  test.beforeEach(async ({ context }) => {
    test.skip(!cookies, 'No minted admin session (SUPABASE_TEST_USER_* unset or sign-in failed).');
    await context.addCookies(cookies!);
  });

  test('a critical chip takes the error colour', async ({ page }) => {
    await page.goto('/admin/system');
    await expect(page.locator('aec-admin-shell')).toBeAttached();
    // The tone stylesheet is in the document whether or not a critical chip shows.
    await expect(page.locator('style#aec-admin-chip-tones')).toBeAttached();
    const colour = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.className = 'aec-chip';
      probe.dataset['tone'] = 'critical';
      document.body.appendChild(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    });
    expect(colour).toBe(await errorColour(page));
  });

  for (const width of [768, 780, 800, 820]) {
    test(`the Operations panel stays inside a ${width}px window`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/admin/overview');
      await expect(page.locator('aec-admin-shell')).toBeAttached();
      const trigger = page.getByRole('button', { name: /^Operations/ });
      await trigger.focus();
      await page.keyboard.press('Enter');
      const panel = page.locator('#admin-nav-operations-panel');
      await expect(panel).toBeVisible();
      const box = await panel.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    });
  }

  test('the 30-day chart is no wider than its panel', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/admin/overview');
    const chart = page.locator('aec-stacked-bar-chart');
    await expect(chart).toBeAttached();
    const widths = await chart.evaluate((el) => ({
      chart: el.scrollWidth,
      panel: (el.closest('section') as HTMLElement).clientWidth,
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    expect(widths.chart).toBeLessThanOrEqual(widths.panel);
    expect(widths.page).toBeLessThanOrEqual(0);
  });
});
