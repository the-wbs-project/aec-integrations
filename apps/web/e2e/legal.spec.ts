/**
 * AECI-237 / Phase 7.2 — `/legal/*` end-to-end coverage.
 *
 * The four legal pages are static, indexable, CACHEABLE content pages (§3.1: 24h
 * edge), SSR-rendered from Markdown. Per page this pins the real HTTP 200, the §4
 * static-page cache headers (`s-maxage=86400`, `max-age=3600`, `Cache-Tag:
 * route:index`), that the body actually SSR-renders (no empty hydration shell),
 * the self-referential canonical with no noindex, the footer Legal link in, a
 * clean axe pass, and clean hydration. A final test pins that an unknown
 * `/legal/*` 404s with NOT_FOUND_TTL + `Cache-Tag: route:404`.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import {
  attachConsoleCapture,
  expectConsoleClean,
  waitForHydrationSettle,
} from './console-capture';

const PAGES = [
  {
    path: '/legal/terms',
    title: 'Terms of Service · AEC Integrations',
    heading: 'Terms of Service',
    footerLink: 'Terms',
    bodyMarker: 'How listings are sourced',
  },
  {
    path: '/legal/privacy',
    title: 'Privacy Policy · AEC Integrations',
    heading: 'Privacy Policy',
    footerLink: 'Privacy',
    bodyMarker: 'Lawful basis',
  },
  {
    path: '/legal/review-guidelines',
    title: 'Review Guidelines · AEC Integrations',
    heading: 'Review Guidelines',
    footerLink: 'Review guidelines',
    bodyMarker: 'Moderation process',
  },
  {
    path: '/legal/listing-accuracy',
    title: 'Listing Accuracy Policy · AEC Integrations',
    heading: 'Listing Accuracy Policy',
    footerLink: 'Listing accuracy',
    bodyMarker: 'Requesting a correction',
  },
] as const;

for (const pageDef of PAGES) {
  test.describe(`${pageDef.path} — Phase 7.2 (AECI-237)`, () => {
    test('returns 200 with the 24h-edge static-page cache headers + route:index tag', async ({
      request,
    }) => {
      const res = await request.get(pageDef.path, { maxRedirects: 0 });
      expect(res.status()).toBe(200);

      const cacheControl = res.headers()['cache-control'] ?? '';
      expect(cacheControl, `got: ${cacheControl}`).toContain('s-maxage=86400');
      expect(cacheControl, `got: ${cacheControl}`).toContain('max-age=3600');

      expect(res.headers()['cache-tag'] ?? '').toContain('route:index');
    });

    test('SSR-renders the document body (no empty hydration shell)', async ({ request }) => {
      const html = await (await request.get(pageDef.path)).text();
      // The page title (h1) and a section marker both appear in the raw SSR HTML.
      expect(html).toContain(pageDef.heading);
      expect(html).toContain(pageDef.bodyMarker);
      // The pre-launch draft notice ships visibly until counsel approval.
      expect(html).toContain('pending legal review');
    });

    test('is indexable — self-referential canonical, no noindex robots meta', async ({
      page,
      request,
    }) => {
      const html = await (await request.get(pageDef.path)).text();
      expect(html).not.toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);

      await page.goto(pageDef.path);
      await expect(page).toHaveTitle(pageDef.title);
      const canonical = page.locator('head link[rel="canonical"]');
      await expect(canonical).toHaveCount(1);
      await expect(canonical).toHaveAttribute('href', new RegExp(`${pageDef.path}$`));
      await expect(page.locator('head meta[property="og:type"]')).toHaveAttribute(
        'content',
        'website',
      );
    });

    test('is reachable from the footer Legal nav', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('app-root')).toBeAttached();

      const legal = page.getByRole('navigation', { name: 'Legal' });
      await legal.getByRole('link', { name: pageDef.footerLink, exact: true }).click();

      await expect(page).toHaveURL(new RegExp(`${pageDef.path}$`));
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(pageDef.heading);
    });

    test('has zero axe violations at WCAG AA', async ({ page }) => {
      await page.goto(pageDef.path);
      await expect(page.locator('app-root')).toBeAttached();

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();

      expect(results.violations).toEqual([]);
    });

    test('renders with no console errors or page errors', async ({ page }) => {
      const capture = attachConsoleCapture(page);
      const res = await page.goto(pageDef.path);
      expect(res?.status()).toBe(200);
      await expect(page.locator('app-root')).toBeAttached();
      await waitForHydrationSettle(page);
      expectConsoleClean(capture, `GET ${pageDef.path}`);
    });
  });
}

test.describe('/legal/* — unknown slug', () => {
  test('an unknown /legal/* path 404s with NOT_FOUND_TTL + route:404 (no stale 24h cache)', async ({
    request,
  }) => {
    const res = await request.get('/legal/does-not-exist', { maxRedirects: 0 });
    expect(res.status()).toBe(404);

    const cacheControl = res.headers()['cache-control'] ?? '';
    expect(cacheControl, `got: ${cacheControl}`).toContain('s-maxage=60');
    expect(cacheControl, `got: ${cacheControl}`).not.toContain('s-maxage=86400');

    expect(res.headers()['cache-tag'] ?? '').toContain('route:404');
  });
});
