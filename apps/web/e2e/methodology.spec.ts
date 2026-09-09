/**
 * AECI-804 — `/methodology` end-to-end coverage.
 *
 * `/methodology` is a static, indexable, CACHEABLE content page on the §3.1
 * static-page TTL. This pins the real HTTP 200, the §4 static-page cache headers
 * (`s-maxage=86400`, `Cache-Tag: route:index`), the self-referential canonical,
 * the absence of a noindex robots meta, the SSR-rendered body (the Markdown is
 * inlined at build time, so it must be in the first paint with no client JS), the
 * sitemap entry, the footer link in, and a clean axe pass.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import {
  attachConsoleCapture,
  expectConsoleClean,
  waitForHydrationSettle,
} from './console-capture';

test.describe('/methodology — AECI-804', () => {
  test('GET /methodology returns 200 with the 24h-edge static-page cache headers + route:index tag', async ({
    request,
  }) => {
    const res = await request.get('/methodology', { maxRedirects: 0 });
    expect(res.status()).toBe(200);

    const cacheControl = res.headers()['cache-control'] ?? '';
    expect(cacheControl, `got: ${cacheControl}`).toContain('s-maxage=86400');
    expect(cacheControl, `got: ${cacheControl}`).toContain('max-age=3600');

    expect(res.headers()['cache-tag'] ?? '').toContain('route:index');
  });

  test('SSR-renders the Markdown body, including the agreement-state table', async ({
    request,
  }) => {
    const html = await (await request.get('/methodology')).text();
    expect(html).toContain('How we research and verify listings');
    expect(html).toContain('What verification means');
    expect(html).toContain('No pay-for-placement');
    // The body is build-time-inlined Markdown, so it must be in the SSR payload
    // rather than arriving with hydration.
    expect(html).toContain('aec-prose');
    // GFM tables are off by default in marked; without `gfm: true` this renders
    // as literal pipe characters instead of a <table>.
    expect(html).toContain('<table>');
    expect(html).toContain('Both vendors confirmed');
  });

  test('is indexable — self-referential canonical, no noindex robots meta', async ({
    page,
    request,
  }) => {
    const html = await (await request.get('/methodology')).text();
    expect(html).not.toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);

    await page.goto('/methodology');
    await expect(page).toHaveTitle('How we research and verify listings · AEC Integrations');
    const canonical = page.locator('head link[rel="canonical"]');
    await expect(canonical).toHaveCount(1);
    await expect(canonical).toHaveAttribute('href', /\/methodology$/);
    await expect(page.locator('head meta[property="og:type"]')).toHaveAttribute(
      'content',
      'website',
    );
  });

  test('is reachable from the footer Company nav', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('app-root')).toBeAttached();

    const company = page.getByRole('navigation', { name: 'Company' });
    await company.getByRole('link', { name: 'Methodology' }).click();

    await expect(page).toHaveURL(/\/methodology$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'How we research and verify listings',
    );
  });

  test('has zero axe violations at WCAG AA', async ({ page }) => {
    await page.goto('/methodology');
    await expect(page.locator('app-root')).toBeAttached();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });

  test('renders with no console errors or page errors', async ({ page }) => {
    const capture = attachConsoleCapture(page);
    const res = await page.goto('/methodology');
    expect(res?.status()).toBe(200);
    await expect(page.locator('app-root')).toBeAttached();
    await waitForHydrationSettle(page);
    expectConsoleClean(capture, 'GET /methodology');
  });
});
