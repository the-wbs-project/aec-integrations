/**
 * AECI-1283 — `/vendor-program` end-to-end smoke (`docs/VENDOR_PROGRAM_PAGE_SPEC.md` §2).
 *
 * Pins the real HTTP 200, the /about static-page cache headers
 * (`s-maxage=86400`, `Cache-Tag: route:index`), indexable meta with the absolute
 * share card, the SSR-rendered hero, the sitemap entry, the footer link in, and
 * that `/vendors` still 301s to `/products` (§1.1 decision 6).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe('/vendor-program — AECI-1283', () => {
  test('GET /vendor-program returns 200 with the static-page cache headers + route:index tag', async ({
    request,
  }) => {
    const res = await request.get('/vendor-program', { maxRedirects: 0 });
    expect(res.status()).toBe(200);

    const cacheControl = res.headers()['cache-control'] ?? '';
    expect(cacheControl, `got: ${cacheControl}`).toContain('s-maxage=86400');
    expect(cacheControl, `got: ${cacheControl}`).toContain('max-age=3600');

    expect(res.headers()['cache-tag'] ?? '').toContain('route:index');
  });

  test('SSR-renders the hero and the find-your-product anchor, indexable with the share card', async ({
    request,
  }) => {
    const html = await (await request.get('/vendor-program')).text();
    expect(html).toContain('Contractors compare your integrations here');
    expect(html).toContain('id="find-your-product"');
    expect(html).not.toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);
    expect(html).toMatch(/<link[^>]+rel="canonical"[^>]+href="https?:\/\/[^"]+\/vendor-program"/);
    expect(html).toMatch(
      /<meta[^>]+property="og:image"[^>]+content="https?:\/\/[^"]+\/branding\/vendor-program-og\.png"/,
    );
    expect(html).toMatch(/<meta[^>]+property="og:image:alt"/);

    const card = await request.get('/branding/vendor-program-og.png');
    expect(card.status()).toBe(200);
    expect(card.headers()['content-type']).toContain('image/png');
  });

  test('is listed in sitemap.xml', async ({ request }) => {
    const xml = await (await request.get('/sitemap.xml')).text();
    expect(xml).toMatch(/<loc>https?:\/\/[^<]+\/vendor-program<\/loc>/);
  });

  test('is reachable from the footer Company nav', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('app-root')).toBeAttached();

    const company = page.getByRole('navigation', { name: 'Company' });
    await company.getByRole('link', { name: 'For vendors' }).click();

    await expect(page).toHaveURL(/\/vendor-program$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Contractors compare your integrations here',
    );
  });

  test('has zero axe violations at WCAG AA', async ({ page }) => {
    await page.goto('/vendor-program');
    await expect(page.locator('app-root')).toBeAttached();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });

  test('/vendors still 301s to /products', async ({ request }) => {
    const res = await request.get('/vendors', { maxRedirects: 0 });
    expect(res.status()).toBe(301);
    expect(res.headers()['location'] ?? '').toMatch(/\/products$/);
  });
});
