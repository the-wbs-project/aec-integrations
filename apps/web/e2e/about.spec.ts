/**
 * AECI-238 / Phase 7.3 — `/about` end-to-end coverage.
 *
 * `/about` is a static, indexable, CACHEABLE content page (§3.1: 24h edge). This
 * pins the real HTTP 200, the §4 static-page cache headers (`s-maxage=86400`,
 * `Cache-Tag: route:index`), the self-referential canonical, the absence of a
 * noindex robots meta, the trust-first copy, the reused commitments band, the
 * footer link in, and a clean axe pass.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import {
  attachConsoleCapture,
  expectConsoleClean,
  waitForHydrationSettle,
} from './console-capture';

test.describe('/about — Phase 7.3 (AECI-238)', () => {
  test('GET /about returns 200 with the 24h-edge static-page cache headers + route:index tag', async ({
    request,
  }) => {
    const res = await request.get('/about', { maxRedirects: 0 });
    expect(res.status()).toBe(200);

    const cacheControl = res.headers()['cache-control'] ?? '';
    expect(cacheControl, `got: ${cacheControl}`).toContain('s-maxage=86400');
    expect(cacheControl, `got: ${cacheControl}`).toContain('max-age=3600');

    expect(res.headers()['cache-tag'] ?? '').toContain('route:index');
  });

  test('SSR-renders the trust-first story and the reused commitments band', async ({ request }) => {
    const html = await (await request.get('/about')).text();
    expect(html).toContain('No pay-for-placement');
    expect(html).not.toContain('vendor marketing');
    expect(html).toContain('Why we exist');
    expect(html).toContain("How we're different");
    // The three commitments band (reused `<aec-home-trust-pillars>`).
    expect(html).toContain('aec-home-trust-pillars');
    expect(html).toContain('Trust is the product');
  });

  // One page load for three checks (AECI-2027). Console capture is attached
  // before the load, and the console check runs last, after hydration.
  test('is indexable, has one Bone band and a Forest card, and renders console-clean', async ({
    page,
    request,
  }) => {
    const capture = attachConsoleCapture(page);

    await test.step('is indexable — self-referential canonical, no noindex robots meta', async () => {
      const html = await (await request.get('/about')).text();
      expect(html).not.toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);

      const res = await page.goto('/about');
      expect(res?.status()).toBe(200);
      await expect(page).toHaveTitle('About · AEC Integrations');
      const canonical = page.locator('head link[rel="canonical"]');
      await expect(canonical).toHaveCount(1);
      await expect(canonical).toHaveAttribute('href', /\/about$/);
      await expect(page.locator('head meta[property="og:type"]')).toHaveAttribute(
        'content',
        'website',
      );
    });

    await test.step('one Bone band; the commitments are one Forest card on a white band (AECI-1800)', async () => {
      await expect(page.locator('aec-bone-band')).toHaveCount(1);
      await expect(page.locator('aec-bone-band h1')).toHaveCount(1);
      // Walk up from the commitments to the first painted ground.
      const ground = await page.locator('aec-home-trust-pillars').evaluate((el) => {
        let node: Element | null = el;
        while (node) {
          const bg = getComputedStyle(node).backgroundColor;
          if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
          node = node.parentElement;
        }
        return 'none';
      });
      // The page ground is white. Engines may report it as rgb() or oklch(), so
      // compare against the body's own computed ground rather than a literal.
      const body = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(ground).toBe(body);

      // The page's one Forest feature card (ruling 2026-11-17): a card with 24px
      // corners that holds all three points, never a full-bleed band.
      const card = page.getByTestId('about-trust-card');
      await expect(card).toHaveCount(1);
      await expect(card.locator('li')).toHaveCount(3);
      const box = await card.evaluate((el) => ({
        radius: getComputedStyle(el).borderTopLeftRadius,
        width: el.getBoundingClientRect().width,
        viewport: document.documentElement.clientWidth,
        bg: getComputedStyle(el).backgroundColor,
      }));
      expect(box.radius).toBe('24px');
      expect(box.width).toBeLessThan(box.viewport);
      expect(box.bg).not.toBe(body);
    });

    await test.step('renders with no console errors or page errors', async () => {
      await expect(page.locator('app-root')).toBeAttached();
      await waitForHydrationSettle(page);
      expectConsoleClean(capture, 'GET /about');
    });
  });

  test('is reachable from the footer Company nav', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('app-root')).toBeAttached();

    const company = page.getByRole('navigation', { name: 'Company' });
    await company.getByRole('link', { name: 'About' }).click();

    await expect(page).toHaveURL(/\/about$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText("couldn't find anywhere");
  });

  test('has zero axe violations at WCAG AA', async ({ page }) => {
    await page.goto('/about');
    await expect(page.locator('app-root')).toBeAttached();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });
});
