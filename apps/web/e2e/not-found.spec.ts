/**
 * AECI-62 / Phase 2.16 — global 404 shell end-to-end coverage.
 *
 * Companion to `products-detail.spec.ts` (which covers the same shell rendered
 * via a detail resolver returning null). This file pins the *wildcard* path:
 * any URL that doesn't match a registered route must still return a real
 * HTTP 404, the branded shell, the AECI-56 sentinel tag, and a noindex
 * robots meta.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe('global 404 — wildcard path', () => {
  test('GET /never-a-real-route returns a real HTTP 404 with NOT_FOUND_TTL + route:404 tag', async ({
    request,
  }) => {
    const res = await request.get('/never-a-real-route', { maxRedirects: 0 });

    expect(res.status(), 'must be a real 404 — never the pinned-404 trap').toBe(404);
    expect(res.headers()['cache-control']).toBe('public, max-age=0, s-maxage=60');
    expect(res.headers()['cache-tag']).toBe('route:404');
  });

  test('renders the branded shell with all four AC-pinned recovery links', async ({ page }) => {
    const res = await page.goto('/never-a-real-route');
    expect(res?.status()).toBe(404);

    await expect(page.getByText('404: Not found', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: "We couldn't find that page." })).toBeVisible();

    // Recovery links live in the 404 shell's `Browse the directory` nav —
    // scope by that landmark so the site-header's primary nav (which has the
    // same hrefs) doesn't double-match.
    const directory = page.getByRole('navigation', { name: 'Browse the directory' });
    await expect(directory.getByRole('link', { name: /Products/ })).toHaveAttribute(
      'href',
      /\/products$/,
    );
    await expect(directory.getByRole('link', { name: /Vendors/ })).toHaveAttribute(
      'href',
      /\/vendors$/,
    );
    await expect(directory.getByRole('link', { name: /Integrations/ })).toHaveAttribute(
      'href',
      /\/integrations$/,
    );
    await expect(directory.getByRole('link', { name: /Categories/ })).toHaveAttribute(
      'href',
      /\/categories$/,
    );
    await expect(page.getByRole('link', { name: 'Go home' })).toHaveAttribute('href', '/');
  });

  test('carries noindex robots meta in the SSR HTML', async ({ request }) => {
    const html = await (await request.get('/never-a-real-route')).text();
    expect(html).toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);
  });

  test('title is set to "Not found · AEC Integrations"', async ({ page }) => {
    await page.goto('/never-a-real-route');
    await expect(page).toHaveTitle('Not found · AEC Integrations');
  });

  test('has zero axe violations at WCAG AA', async ({ page }) => {
    await page.goto('/never-a-real-route');
    await expect(page.locator('app-root')).toBeAttached();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });
});
