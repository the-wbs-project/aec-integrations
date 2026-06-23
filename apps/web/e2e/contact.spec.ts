/**
 * AECI-238 / Phase 7.3 — `/contact` end-to-end coverage.
 *
 * `/contact` is a static, indexable, NON-cacheable content page (§3.1: "No
 * cache"). It is absent from `ROUTE_CACHE_PATTERNS`, so the SSR Worker emits the
 * fail-closed `private, no-store` default and no `Cache-Tag`. This pins the 200,
 * those headers, the indexable canonical, the absence of a noindex robots meta,
 * the Stage 1 `mailto:` contact path, the footer link in, and a clean axe pass.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import {
  attachConsoleCapture,
  expectConsoleClean,
  waitForHydrationSettle,
} from './console-capture';

test.describe('/contact — Phase 7.3 (AECI-238)', () => {
  test('GET /contact returns 200 and is non-cacheable (private, no-store, no Cache-Tag)', async ({
    request,
  }) => {
    const res = await request.get('/contact', { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toBe('private, no-store');
    expect(res.headers()['cache-tag']).toBeUndefined();
  });

  test('SSR-renders a mailto contact path to the Stage 1 address', async ({ request }) => {
    const html = await (await request.get('/contact')).text();
    expect(html).toContain('mailto:founders@thewbsproject.com');
    expect(html).toContain('Get in touch');
  });

  test('is indexable — self-referential canonical, no noindex robots meta', async ({
    page,
    request,
  }) => {
    const html = await (await request.get('/contact')).text();
    expect(html).not.toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);

    await page.goto('/contact');
    await expect(page).toHaveTitle('Contact · AEC Integrations');
    const canonical = page.locator('head link[rel="canonical"]');
    await expect(canonical).toHaveCount(1);
    await expect(canonical).toHaveAttribute('href', /\/contact$/);
  });

  test('the mailto link is clickable in the rendered page', async ({ page }) => {
    await page.goto('/contact');
    await expect(page.locator('app-root')).toBeAttached();
    // The email card carries two `mailto:` anchors with the same href: the
    // visible address line and the "Email us" primary button. Scope by
    // accessible name so each is asserted unambiguously.
    await expect(page.getByRole('link', { name: 'founders@thewbsproject.com' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Email us' })).toHaveAttribute(
      'href',
      'mailto:founders@thewbsproject.com',
    );
  });

  test('is reachable from the footer Company nav', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('app-root')).toBeAttached();

    const company = page.getByRole('navigation', { name: 'Company' });
    await company.getByRole('link', { name: 'Contact' }).click();

    await expect(page).toHaveURL(/\/contact$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Get in touch');
  });

  test('has zero axe violations at WCAG AA', async ({ page }) => {
    await page.goto('/contact');
    await expect(page.locator('app-root')).toBeAttached();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });

  test('renders with no console errors or page errors', async ({ page }) => {
    const capture = attachConsoleCapture(page);
    const res = await page.goto('/contact');
    expect(res?.status()).toBe(200);
    await expect(page.locator('app-root')).toBeAttached();
    await waitForHydrationSettle(page);
    expectConsoleClean(capture, 'GET /contact');
  });
});
