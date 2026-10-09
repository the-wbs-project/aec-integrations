/**
 * AECI-1181 — the `/docs/vendors/replying-to-reviews` vendor guide page.
 *
 * The page is build-time-inlined Markdown (`apps/web/src/app/docs/docs-content.ts`),
 * so its body must be in the SSR payload. It stays noindex with the rest of
 * `/docs/vendors/*` until AECI-1105. Content rules are pinned in
 * `docs-page.component.spec.ts`; this proves the real route renders and is
 * accessible.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import {
  attachConsoleCapture,
  expectConsoleClean,
  waitForHydrationSettle,
} from './console-capture';

const PATH = '/docs/vendors/replying-to-reviews';

test.describe('/docs/vendors/replying-to-reviews — AECI-1181', () => {
  test('SSR-renders the guide body with a 200 and a noindex header', async ({ request }) => {
    const res = await request.get(PATH, { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(res.headers()['x-robots-tag'] ?? '').toContain('noindex');

    const html = await res.text();
    expect(html).toContain('Replying to reviews');
    expect(html).toContain('What readers see');
    expect(html).toContain('A removed reply is final.');
  });

  test('renders one h1 and marks the page current in the sidebar', async ({ page }) => {
    await page.goto(PATH);
    await expect(page.locator('app-root')).toBeAttached();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Replying to reviews');
    // AECI-1265: a vendor guide page shows the vendor guide's own tree.
    await expect(
      page.getByRole('navigation', { name: 'Vendor guide' }).locator('a[aria-current="page"]'),
    ).toHaveText(/Replying to reviews/);
  });

  test('has zero axe violations at WCAG AA', async ({ page }) => {
    await page.goto(PATH);
    await expect(page.locator('app-root')).toBeAttached();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });

  test('renders with no console errors or page errors', async ({ page }) => {
    const capture = attachConsoleCapture(page);
    const res = await page.goto(PATH);
    expect(res?.status()).toBe(200);
    await expect(page.locator('app-root')).toBeAttached();
    await waitForHydrationSettle(page);
    expectConsoleClean(capture, `GET ${PATH}`);
  });
});
