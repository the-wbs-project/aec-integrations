/**
 * AECI-1673 — `/accessibility` end-to-end coverage (counsel Q40, ruling 22).
 *
 * A static, indexable, CACHEABLE content page on the /methodology pattern. This
 * pins the real HTTP 200, the static-page cache headers, the self-referential
 * canonical with no noindex, the SSR-rendered body, the footer Legal link in, and
 * the issue's done-when: zero axe violations at WCAG 2.1 AA on the page itself.
 *
 * **Hidden until AECI-1687.** `ACCESSIBILITY_STATEMENT_PUBLISHED` is `false`, so the
 * published-page block below is skipped and the hidden-state block runs instead.
 * AECI-1687's last step flips the flag, removes the `.skip`, and deletes the
 * hidden-state block.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import {
  attachConsoleCapture,
  expectConsoleClean,
  waitForHydrationSettle,
} from './console-capture';
import { untilHydrated } from './hydration';

/**
 * Presets a consent decision before any page script runs, so the analytics
 * consent banner never mounts over the footer (the `e2e/legal.spec.ts` rule).
 * The key mirrors `CONSENT_STORAGE_KEY` in `src/app/analytics/consent.ts`.
 */
async function presetConsent(page: Page): Promise<void> {
  await page.addInitScript(() => {
    globalThis.localStorage.setItem('aeci_analytics_consent', 'denied');
  });
}

// AECI-1687 — while the statement is hidden, nothing reaches it.
test.describe('/accessibility hidden until AECI-1687', () => {
  test('404s, is not in the footer, and is not in the sitemap', async ({ page, request }) => {
    const res = await request.get('/accessibility', { maxRedirects: 0 });
    expect(res.status()).toBe(404);

    await page.goto('/');
    await expect(page.locator('app-root')).toBeAttached();
    await expect(page.locator('footer a[href="/accessibility"]')).toHaveCount(0);

    const xml = await (await request.get('/sitemap.xml')).text();
    expect(xml).not.toMatch(/<loc>[^<]+\/accessibility<\/loc>/);
  });
});

// Skipped until AECI-1687 publishes the page.
test.describe.skip('/accessibility — AECI-1673', () => {
  test('GET /accessibility returns 200 with the static-page cache headers + route:index tag', async ({
    request,
  }) => {
    const res = await request.get('/accessibility', { maxRedirects: 0 });
    expect(res.status()).toBe(200);

    const cacheControl = res.headers()['cache-control'] ?? '';
    expect(cacheControl, `got: ${cacheControl}`).toContain('s-maxage=86400');
    expect(cacheControl, `got: ${cacheControl}`).toContain('max-age=3600');
    expect(res.headers()['cache-tag'] ?? '').toContain('route:index');
  });

  test('SSR-renders the statement body', async ({ request }) => {
    const html = await (await request.get('/accessibility')).text();
    expect(html).toContain('Accessibility statement');
    expect(html).toContain('aec-prose');
    expect(html).toContain('We aim to conform to the Web Content Accessibility Guidelines');
    expect(html).toContain('href="mailto:support@aecintegrations.com"');
    expect(html).toContain('We reply within 10 business days.');
  });

  test('is indexable — self-referential canonical, no noindex robots meta', async ({
    page,
    request,
  }) => {
    const html = await (await request.get('/accessibility')).text();
    expect(html).not.toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);

    await page.goto('/accessibility');
    await expect(page).toHaveTitle('Accessibility statement · AEC Integrations');
    const canonical = page.locator('head link[rel="canonical"]');
    await expect(canonical).toHaveCount(1);
    await expect(canonical).toHaveAttribute('href', /\/accessibility$/);
  });

  test('is reachable from the footer Legal nav', async ({ page }) => {
    await presetConsent(page);
    await page.goto('/');
    await expect(page.locator('app-root')).toBeAttached();

    const link = page
      .getByRole('navigation', { name: 'Legal' })
      .getByRole('link', { name: 'Accessibility', exact: true });
    await untilHydrated(link);
    await link.click();

    await expect(page).toHaveURL(/\/accessibility$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Accessibility statement');
  });

  test('has zero axe violations at WCAG 2.1 AA', async ({ page }) => {
    await page.goto('/accessibility');
    await expect(page.locator('app-root')).toBeAttached();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });

  test('renders with no console errors or page errors', async ({ page }) => {
    const capture = attachConsoleCapture(page);
    const res = await page.goto('/accessibility');
    expect(res?.status()).toBe(200);
    await expect(page.locator('app-root')).toBeAttached();
    await waitForHydrationSettle(page);
    expectConsoleClean(capture, 'GET /accessibility');
  });
});
